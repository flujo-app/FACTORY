import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FactoryControl, digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import * as privateFiles from '../deploy/private-files.mjs';

const CLI=fileURLToPath(new URL('../bin/native-cell.mjs',import.meta.url));
const HELPER=fileURLToPath(new URL('../deploy/private-files.mjs',import.meta.url));
const HELPER_SHA='7ae5ba87ec1cd387ee1b914105894d29254e07c0a3644c86f65810f461dcd54d';
const sha=b=>createHash('sha256').update(b).digest('hex');
const compatibility={applicationVersion:'3.46.0',snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1};
const privateProblem='private service fixture instruction';
const privateBody='private service fixture completion';
const flow={id:'service-flow',name:'FactoryServiceFixture',nodes:[],edges:[],updatedAt:123};
const missionId='6'.repeat(32);

async function eventually(probe,label,timeoutMs=45000,diagnostic=()=> ''){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){const result=await probe();if(result)return result;await delay(25);}
  assert.fail('Timed out waiting for '+label+diagnostic());
}
function launch(profilePath){
  const child=spawn(process.execPath,[CLI,'run','--private-module',HELPER,'--profile',profilePath],
    {windowsHide:true,stdio:['ignore','pipe','pipe']});
  const state={child,pid:child.pid,stdout:'',stderr:'',statuses:[],closed:false,code:null,signal:null,spawnError:false};
  let pending='';
  child.stdout.on('data',chunk=>{
    state.stdout+=chunk;pending+=chunk;
    assert.ok(state.stdout.length<65536,'bounded service status');
    const lines=pending.split('\n');pending=lines.pop();
    for(const line of lines)if(line.trim())state.statuses.push(JSON.parse(line));
  });
  child.stderr.on('data',chunk=>{state.stderr+=chunk;});
  child.once('error',()=>{state.spawnError=true;});
  state.closing=new Promise(resolve=>child.once('close',(code,signal)=>{Object.assign(state,{closed:true,code,signal});resolve(state);}));
  state.wait=predicate=>eventually(()=>{
    assert.equal(state.spawnError,false,'service child spawned');
    const value=state.statuses.find(predicate);
    assert.ok(value||!state.closed,'service remained alive before expected status');
    return value;
  },'service status',45000,()=>{
    const safe=value=>typeof value==='string'&&/^[a-z_]{1,64}$/.test(value)?value:null;
    return '; recent states='+JSON.stringify(state.statuses.slice(-8).map(value=>({state:safe(value.state),
      reason:safe(value.reason),effectState:safe(value.effectState)})))+'; closed='+state.closed;
  });
  state.stop=async()=>{
    if(!state.closed)child.kill('SIGTERM');
    await Promise.race([state.closing,delay(15000,undefined,{ref:false}).then(()=>assert.fail('Service did not close after SIGTERM'))]);
    assert.ok((state.code===0&&state.signal===null)||(process.platform==='win32'&&state.code===null&&state.signal==='SIGTERM'),
      'actual close receipt is graceful or Windows SIGTERM');
    return state;
  };
  return state;
}
function safeOutput(child,token){
  const text=child.stdout+child.stderr;
  assert.ok(![token,privateProblem,privateBody].some(secret=>text.includes(secret)),'private values stay out of service output');
  for(const status of child.statuses)assert.ok(Object.keys(status).every(key=>['state','taskId','key','effectState','reason','observations','unallocatedCents'].includes(key)),
    'closed status DTO');
}
async function privateDirectory(prefix){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  await privateFiles.ensurePrivateDirectory(dir);
  return dir;
}
async function fixture(t){
  const dir=await privateDirectory('factory-service-');
  const control=new FactoryControl(path.join(dir,'control.sqlite'));
  const paid=new SpendingLedger(path.join(dir,'paid.sqlite'));
  const children=[];
  t.after(async()=>{for(const child of children)if(!child.closed){child.child.kill('SIGTERM');await child.closing;}paid.close();control.close();});
  // Only fresh, private fixture databases are initialized; no ambient authority is opened.
  control.initialize({mission:'Service lifecycle fixture',budgetCents:1000,maxCells:3,maxDepth:2});
  paid.initialize({limitCents:1000,currency:'USD'});
  control.reserveCell({cellId:'child',role:'developer',budgetCents:300,purpose:'Isolated service lifecycle fixture'});
  control.createTask({taskId:'launch',projectId:'fixture',branch:'codex/service-launch',
    specification:{problem:'Fixture provision',acceptance:['ready fixture'],baseline:'fixture'}});
  const launcher=control.claimTask('launch','root',600000);
  control.admitEffect(launcher,{key:'service-provision',kind:'provision',request:{cellId:'child',app:'service-child'}});
  control.startEffect(launcher,'service-provision');
  control.settleEffect('service-provision','succeeded',{worker:'service-child',app:'service-child',state:'ready'});
  if(process.platform!=='win32')for(const name of ['control.sqlite','paid.sqlite'])for(const suffix of ['','-wal','-shm']){
    await fs.chmod(path.join(dir,name+suffix),0o600).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  const worker={workspace:'service-fixture',archiveSha256:'a'.repeat(64),compatibility};
  const token=randomBytes(40).toString('hex');
  const state={posts:0,gets:0,dangerousGets:0,authFailures:0,conversation:null,holdReadiness:false,heldReadiness:false};
  const json=(response,code,value)=>{response.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value));};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://127.0.0.1');
      if(request.headers.authorization!=='Bearer '+token||url.searchParams.get('workspace')!==worker.workspace||request.headers['x-flujo-workspace']!==worker.workspace){state.authFailures++;return json(response,401,{});}
      if(request.method==='GET'&&url.pathname==='/v1/chat/completions'){state.dangerousGets++;return json(response,500,{});}
      if(request.method==='GET'&&url.pathname==='/api/worker/status'){
        if(state.holdReadiness){state.heldReadiness=true;return;}
        return json(response,200,{mode:'worker',state:'ready',workspace:worker.workspace,archiveSha256:worker.archiveSha256});
      }
      if(request.method==='GET'&&url.pathname==='/api/snapshot/info')return json(response,200,{workerCompatibility:compatibility});
      if(request.method==='GET'&&url.pathname==='/api/flow/'+flow.id)return json(response,200,flow);
      if(request.method==='GET'&&url.pathname==='/api/flow')return json(response,200,[flow]);
      if(request.method==='GET'&&url.pathname.startsWith('/v1/chat/conversations/')){
        state.gets++;
        return state.conversation&&url.pathname.endsWith('/'+state.conversation.id)?json(response,200,state.conversation):json(response,404,{});
      }
      if(request.method==='POST'&&url.pathname==='/v1/chat/completions'){
        const parts=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>1048576)throw new Error('fixture request limit');parts.push(chunk);}
        const body=JSON.parse(Buffer.concat(parts).toString());state.posts++;
        state.conversation={id:body.metadata.conversationId,flowId:flow.id,status:'completed',parentConversationId:null,rootConversationId:null,
          messages:[{id:'original-user',role:'user',content:body.messages[0].content},{id:'original-answer',role:'assistant',content:privateBody}],
          transcriptWindow:{truncated:false,loadedCount:2,totalCount:2,source:'durable-log'}};
        // Persisted native outcome with a lost response, not a repeat execution opportunity.
        response.destroy();return;
      }
      json(response,404,{});
    }catch{response.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const profilePath=path.join(dir,'profile.private.json'),tokenFile=path.join(dir,'token.private.json');
  await privateFiles.writePrivateJson(tokenFile,{token},{exclusive:true});
  const outputDirectory=path.join(dir,'outputs');
  const profile={controlDatabase:path.join(dir,'control.sqlite'),spendingDatabase:path.join(dir,'paid.sqlite'),
    client:{origin:'http://127.0.0.1:'+server.address().port,tokenFile,worker,timeoutMs:10000},
    cell:{cellId:'child',app:'service-child',provisionKey:'service-provision',worker,outputDirectory,ttlMs:60000,pollMs:100}};
  await privateFiles.writePrivateJson(profilePath,profile,{exclusive:true});
  function addTask(){return control.createTask({taskId:'service-mission',projectId:'fixture',branch:'codex/service-mission',
    specification:{problem:privateProblem,acceptance:['independent software review'],baseline:'fixture',nativeMission:{schemaVersion:1,
      missionId,cellId:'child',app:'service-child',provisionKey:'service-provision',worker,flowId:flow.id,flowSha256:digest(flow),paid:{provider:'fly',ceilingCents:200}}}});}
  function start(){const child=launch(profilePath);children.push(child);return child;}
  return {dir,control,paid,worker,token,state,profilePath,outputDirectory,addTask,start};
}

test('packaged private helper is the exact reviewed source and enforces private storage',async()=>{
  assert.equal(sha(await fs.readFile(HELPER)),HELPER_SHA);
  const dir=await privateDirectory('factory-service-helper-'),filename=path.join(dir,'fixture.private.json');
  await privateFiles.writePrivateJson(filename,{fixture:true},{exclusive:true});
  assert.deepEqual(await privateFiles.readPrivateJson(filename),{fixture:true});
  await assert.rejects(privateFiles.writePrivateJson(filename,{fixture:false},{exclusive:true}),{code:'EEXIST'});
});

test('service refuses missing authority without creating either database or policy',{timeout:60000},async()=>{
  const dir=await privateDirectory('factory-service-missing-');
  const worker={workspace:'missing-fixture',archiveSha256:'b'.repeat(64),compatibility},token=randomBytes(40).toString('hex');
  const tokenFile=path.join(dir,'token.private.json'),profilePath=path.join(dir,'profile.private.json');
  await privateFiles.writePrivateJson(tokenFile,{token},{exclusive:true});
  const profile={controlDatabase:path.join(dir,'missing-control.sqlite'),spendingDatabase:path.join(dir,'missing-paid.sqlite'),
    client:{origin:'http://127.0.0.1:1',tokenFile,worker,timeoutMs:1000},
    cell:{cellId:'child',app:'missing-child',provisionKey:'missing-provision',worker,outputDirectory:path.join(dir,'outputs'),ttlMs:1000,pollMs:100}};
  await privateFiles.writePrivateJson(profilePath,profile,{exclusive:true});
  const before=(await fs.readdir(dir)).sort(),child=launch(profilePath);
  await Promise.race([child.closing,delay(30000,undefined,{ref:false}).then(()=>{child.child.kill('SIGTERM');assert.fail('Missing authority startup did not fail');})]);
  assert.equal(child.code,1);assert.equal(child.signal,null);assert.equal(child.stdout,'');
  assert.ok(child.stderr.includes('"error":"NATIVE_CELL_FAILED"'));
  assert.deepEqual((await fs.readdir(dir)).sort(),before);
  safeOutput(child,token);
});

test('service processes post-startup backlog and recovers its one lost POST after paused restart',{timeout:120000},async t=>{
  const f=await fixture(t),first=f.start();
  await first.wait(status=>status.state==='idle');
  f.addTask();
  const status=await first.wait(status=>status.state==='dispatched'&&status.effectState==='unknown');
  assert.equal(f.state.posts,1);assert.equal(f.control.effect(status.key).state,'unknown');
  const paidBefore=f.paid.snapshot(),paidEventsBefore=f.paid.db.prepare('SELECT * FROM spending_events ORDER BY seq').all();
  assert.equal(paidBefore.unsettledReservations.length,1);assert.equal(paidBefore.unsettledReservations[0].state,'started');
  assert.equal(paidBefore.unallocatedCents,800);
  await first.stop();safeOutput(first,f.token);
  f.control.pause('Fixture restart while admission is paused');
  const second=f.start();
  await second.wait(value=>value.state==='recovered'&&value.observations?.some(row=>row.key===status.key&&row.effectState==='succeeded'));
  await second.stop();safeOutput(second,f.token);
  assert.notEqual(first.pid,second.pid);assert.equal(f.state.posts,1);assert.equal(f.state.dangerousGets,0);assert.equal(f.state.authFailures,0);
  assert.equal(f.control.effect(status.key).state,'succeeded');
  assert.equal(f.control.task('service-mission').status,'running');
  assert.equal(f.control.task('service-mission').candidate,null);assert.equal(f.control.task('service-mission').review,null);
  const output=await privateFiles.readPrivateJson(path.join(f.outputDirectory,missionId+'.private.json'),{maxBytes:2*1048576});
  assert.equal(output.key,status.key);assert.equal(output.body.messages[1].content,privateBody);
  assert.ok(output.body.messages[0].content===f.state.conversation.messages[0].content,'original packet recovered');
  assert.deepEqual(f.paid.snapshot(),paidBefore);assert.deepEqual(f.paid.db.prepare('SELECT * FROM spending_events ORDER BY seq').all(),paidEventsBefore);
});

test('SIGTERM closes an asynchronous preflight before any POST or paid reservation',{timeout:90000},async t=>{
  const f=await fixture(t),child=f.start();await child.wait(status=>status.state==='idle');
  f.state.holdReadiness=true;f.addTask();
  await eventually(()=>f.state.heldReadiness,'held authenticated readiness');
  await child.stop();safeOutput(child,f.token);
  assert.equal(f.state.posts,0);assert.equal(f.control.task('service-mission').status,'ready');
  assert.equal(f.paid.snapshot().unsettledReservations.length,0);assert.equal(f.paid.snapshot().unallocatedCents,1000);
  if(process.platform!=='win32')assert.ok(child.statuses.some(status=>status.state==='stopped'),'POSIX handler emitted stopped');
});
