import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { claimNativeMission,runNativeMission,observeNativeMission } from '../src/native-mission.mjs';
import { nativeMissionRequest,nativeMissionEffectKey } from '../src/native-mission-contract.mjs';
import { DatabaseSync } from 'node:sqlite';

const compatibility={applicationVersion:'3.46.0',snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1};
const privateFiles=process.env.FACTORY_PRIVATE_MODULE?await import(pathToFileURL(process.env.FACTORY_PRIVATE_MODULE).href):{
  ensurePrivateDirectory:async p=>fs.mkdir(p,{recursive:true}),readPrivateJson:async p=>JSON.parse(await fs.readFile(p,'utf8')),
  writePrivateJson:async(p,v)=>fs.writeFile(p,JSON.stringify(v),{flag:'wx',mode:0o600})};
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'factory-native-mission-'));await privateFiles.ensurePrivateDirectory(dir);
  let control=new FactoryControl(path.join(dir,'control.sqlite'));const paid=new SpendingLedger(path.join(dir,'paid.sqlite'));
  t.after(()=>{control.close();paid.close();}); // Retain owned test evidence; no recursive deletion through private overlays.
  control.initialize({mission:'fixture',budgetCents:10000,maxCells:4,maxDepth:2});paid.initialize({limitCents:10000,currency:'USD'});
  control.reserveCell({cellId:'child',role:'developer',budgetCents:1000,purpose:'Fresh assigned Flow'});
  control.createTask({taskId:'launch',projectId:'factory',branch:'codex/launch',specification:{problem:'provision',acceptance:['ready'],baseline:'fixture'}});
  const launcher=control.claimTask('launch','root',600000);control.admitEffect(launcher,{key:'provision',kind:'provision',request:{cellId:'child',app:'factory-child'}});
  control.startEffect(launcher,'provision');control.settleEffect('provision','succeeded',{worker:'factory-child',app:'factory-child',state:'ready'});
  const worker={workspace:'mission',archiveSha256:'a'.repeat(64),compatibility};
  const mission={schemaVersion:1,missionId:'b'.repeat(32),cellId:'child',app:'factory-child',provisionKey:'provision',worker,flowId:'flow',flowSha256:'c'.repeat(64),paid:{provider:'fly',ceilingCents:500}};
  control.createTask({taskId:'develop',projectId:'factory',branch:'codex/develop',specification:{problem:'Improve FLUJO',acceptance:['independent review'],baseline:'fixture',nativeMission:mission}});
  let posts=0,observation=null,lose=false,hook=null;
  const client={binding:worker,async prepare(){},async dispatch(input,{admitPost}){hook?.();await admitPost(()=>{posts++;observation={state:'completed',body:JSON.stringify({id:input.conversationId,flowId:input.flowId,status:'completed',messages:[{role:'user',content:input.packet},{role:'assistant',content:'candidate'}]})};return Promise.resolve();});if(lose)throw new Error('lost response');return observation;},async observe(){return observation??{state:'absent',body:null};}};
  const outputFile=path.join(dir,'output.private.json');const lease=await claimNativeMission({control,taskId:'develop',client,outputFile,ttlMs:600000});
  return {dir,paid,client,outputFile,lease,get control(){return control;},get posts(){return posts;},lose:()=>{lose=true;},hook:f=>{hook=f;},pending:()=>{observation={state:'pending',body:null};},
    reopen:()=>{control.close();control=new FactoryControl(path.join(dir,'control.sqlite'));},run:()=>runNativeMission({control,lease,client,paidAdmission:paid,privateFiles,outputFile})};
}
test('fresh provision-bound child is assigned once; completion is private and does not accept software',async t=>{
  const f=await fixture(t);assert.equal(f.control.task('develop').owner,'child');
  const r=await f.run();assert.equal(r.effect.state,'succeeded');assert.equal(f.posts,1);
  assert.equal(f.control.task('develop').status,'running');assert.equal(f.control.task('develop').candidate,null);
  assert.ok(r.effect.receipt.outputSha256);assert.equal(JSON.stringify(r).includes('candidate'),false);
  assert.equal((await f.run()).dispatched,false);assert.equal(f.posts,1);
});
test('lost response survives controller restart and pause; observation recovers without another POST',async t=>{
  const f=await fixture(t);f.lose();const r=await f.run();assert.equal(r.effect.state,'unknown');assert.equal(f.posts,1);
  f.reopen();f.control.pause();const repaired=await observeNativeMission({control:f.control,key:r.effect.key,client:f.client,privateFiles});
  assert.equal(repaired.effect.state,'succeeded');assert.equal(repaired.dispatched,false);assert.equal(f.posts,1);assert.equal(f.paid.rows().length,1);
});
test('absent or pending native observation retains unknown and cannot repeat POST',async t=>{
  const f=await fixture(t);f.lose();const r=await f.run();f.pending();f.reopen();
  assert.equal((await observeNativeMission({control:f.control,key:r.effect.key,client:f.client,privateFiles})).effect.state,'unknown');
  assert.equal((await f.run()).dispatched,false);assert.equal(f.posts,1);
});
test('paid exhaustion refuses execution; no new task/output key can release the lifetime intent',async t=>{
  const f=await fixture(t);f.paid.reserve({reservationId:'held',provider:'modal',ceilingCents:10000});
  assert.equal((await f.run()).effect.state,'not_applied');assert.equal(f.posts,0);
  await assert.rejects(runNativeMission({control:f.control,lease:f.lease,client:f.client,paidAdmission:f.paid,privateFiles,outputFile:path.join(f.dir,'other.json')}),{code:'CONFLICT'});
  assert.equal(f.posts,0);assert.equal(f.paid.snapshot().committedCents,10000);
});
test('pause after async preparation fences POST admission under actual ledger and controller locks',async t=>{
  const f=await fixture(t);f.hook(()=>f.control.pause());const r=await f.run();assert.equal(r.dispatched,false);assert.equal(r.effect.state,'not_applied');assert.equal(f.posts,0);
  assert.equal(f.paid.snapshot().committedCents,500);
});
test('ordinary flow gateway cannot start a native mission or replace its recorded request',async t=>{
  const f=await fixture(t),request=nativeMissionRequest(f.control.task('develop'),f.lease,f.outputFile),key=nativeMissionEffectKey(request);
  f.control.admitNativeMissionEffect(f.lease,request);assert.throws(()=>f.control.startEffect(f.lease,key),{code:'NATIVE_MISSION_DISPATCH_REQUIRED'});
  assert.throws(()=>f.control.admitNativeMissionEffect(f.lease,{...request,flowId:'other'}),{code:'NATIVE_MISSION_BINDING'});assert.equal(f.posts,0);
});
test('running is durable before POST; final commit failure retains an observable original intent',async t=>{
  const f=await fixture(t),request=nativeMissionRequest(f.control.task('develop'),f.lease,f.outputFile),key=nativeMissionEffectKey(request);
  const original=f.client.dispatch;f.client.dispatch=async(input,options)=>original(input,{admitPost(operation){return options.admitPost(()=>{
    const other=new DatabaseSync(path.join(f.dir,'control.sqlite'),{readOnly:true});try{assert.equal(other.prepare('SELECT state FROM effects WHERE key=?').get(key).state,'running');}finally{other.close();}
    return operation();
  });}});
  const exec=f.control.db.exec.bind(f.control.db);let commits=0;f.hook(()=>{f.control.db.exec=sql=>{if(sql==='COMMIT'&&++commits===2)throw new Error('fixture final commit failure');return exec(sql);};});
  const r=await f.run();f.control.db.exec=exec;assert.equal(r.effect.state,'unknown');assert.equal(f.posts,1);
  f.reopen();assert.equal((await observeNativeMission({control:f.control,key,client:f.client,privateFiles})).effect.state,'succeeded');assert.equal(f.posts,1);
});
test('mission identity cannot be reassigned to another immutable task',async t=>{
  const f=await fixture(t);assert.throws(()=>f.control.createTask({taskId:'other',projectId:'factory',branch:'codex/other',specification:f.control.task('develop').specification}),{code:'NATIVE_MISSION_ID'});assert.equal(f.posts,0);
});
test('operation-task retirement fences the same app before mission dispatch',async t=>{
  const f=await fixture(t);f.control.createTask({taskId:'teardown',projectId:'factory',branch:'codex/teardown',specification:{problem:'retire',acceptance:{scope:'recorded-controller-operation-receipts-only'},baseline:'fixture',taskType:'operation',operation:{kind:'retire',cellId:'child',app:'factory-child'}}});
  const lease=f.control.claimTask('teardown','root',600000);f.control.admitEffect(lease,{key:'teardown',kind:'retire',request:{cellId:'child',app:'factory-child',provisionKey:'provision'}});
  await assert.rejects(f.run(),{code:'NATIVE_MISSION_TARGET'});assert.equal(f.posts,0);assert.equal(f.paid.rows().length,0);
});
