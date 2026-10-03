import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { FactoryControl, digest } from '../src/control.mjs';
import { validateGrowthPolicy } from '../src/growth-policy.mjs';

const errorCode=code=>error=>error?.code===code;
const legacy={mission:'Improve FLUJO',budgetCents:10000,maxCells:4,maxDepth:2};
const unlimited=budgetCents=>({schemaVersion:2,mission:legacy.mission,budgetCents,growthMode:'budget-only',maxCells:null,maxDepth:null});
function fixture(t,policy=legacy) {
  const directory=mkdtempSync(join(tmpdir(),'factory-growth-control-')),filename=join(directory,'control.sqlite'),connections=[];
  const open=()=>{const value=new FactoryControl(filename);connections.push(value);return value;};
  const control=open();if(policy)control.initialize(policy);
  t.after(()=>{for(const value of connections)try{value.close();}catch{}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'factory-growth-control-'));rmSync(directory,{recursive:true,force:true});});
  return {control,filename,open};
}
const events=c=>c.db.prepare('SELECT * FROM events ORDER BY seq').all();
const tables=c=>Object.fromEntries(['cells','tasks','integrations','effects','effect_bindings','messages'].map(name=>[name,c.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
const cas=(c,transitionId)=>({transitionId,expectedFactoryEpoch:c.control().epoch,expectedPolicyDigest:digest(c.control().policy)});
function createWork(c,taskId='work') {
  c.createTask({taskId,projectId:'fixture',branch:'codex/growth-fixture',specification:{problem:'Preserve original work',acceptance:'Independent evidence',baseline:'fixture'}});
  return c.claimTask(taskId,'root',600000);
}
function grant(c,lease,{schemaVersion=1,grantId='original-grant',generation=1,...overrides}={}) {
  const policy={schemaVersion,grantId,generation,expiresAt:lease.expires,maxChildren:schemaVersion===2?null:2,maxBudgetCents:1000,
    allowedRoles:['developer'],template:{source:'http://127.0.0.1:4200',workspace:'fixture',image:'ghcr.io/fixture/native@sha256:'+'a'.repeat(64),org:'fixture',region:'iad',appPrefix:'fixture-growth',flowIds:['fixture-flow']},
    paid:{provider:'fly',ceilingCents:1000},native:null,...(schemaVersion===2?{growthMode:'budget-only'}:{}),...overrides};
  const binding={format:'factory-capacity-grant',schemaVersion,policy,authority:{taskId:lease.scopeId,parentId:lease.cellId,attempt:lease.epoch,controlEpoch:lease.controlEpoch,specDigest:c.task(lease.scopeId).spec_digest},
    transport:{local:{factoryId:'fixture',cellId:'broker'},peer:{factoryId:'fixture',cellId:'root'},generation,keyDigest:'b'.repeat(64),credentialExpiresAt:lease.expires+1000,endpoint:'http://127.0.0.1:46001/v1/peer/messages'},inboxFloor:0};
  return {...binding,grantDigest:digest(binding)};
}
async function child(filename,source) {
  const moduleUrl=new URL('../src/control.mjs',import.meta.url).href;
  const p=spawn(process.execPath,['--input-type=module','-e',`import {FactoryControl} from ${JSON.stringify(moduleUrl)};const c=new FactoryControl(${JSON.stringify(filename)});try{${source}}catch(e){console.log(JSON.stringify({code:e.code??null}));}finally{c.close();}`],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='',overflow=false,timedOut=false,spawnError=null;
  const timer=setTimeout(()=>{timedOut=true;p.kill('SIGTERM');},15000);
  for(const [stream,key] of [[p.stdout,'stdout'],[p.stderr,'stderr']])stream.on('data',bytes=>{if(key==='stdout')stdout+=bytes;else stderr+=bytes;if(stdout.length+stderr.length>32768){overflow=true;p.kill('SIGTERM');}});
  p.on('error',error=>{spawnError=error;});
  try {
    const close=await new Promise(resolve=>p.once('close',(code,signal)=>resolve({code,signal,pid:p.pid})));
    assert.equal(spawnError,null);assert.equal(timedOut,false);assert.equal(overflow,false);assert.equal(close.code,0,stderr);assert.equal(close.signal,null);assert.ok(close.pid>0);
    return {result:JSON.parse(stdout.trim()),close};
  } finally {clearTimeout(timer);}
}

test('legacy initialization remains exact and budget-only initialization is explicit, closed and idempotent',t=>{
  const a=fixture(t);assert.deepEqual(a.control.control().policy,legacy);assert.deepEqual(JSON.parse(a.control.db.prepare('SELECT policy FROM control').get().policy),legacy);
  assert.deepEqual(a.control.initialize({mission:legacy.mission,budgetCents:10000}).policy,legacy);
  const b=fixture(t,null),input={mission:legacy.mission,budgetCents:10000,growthMode:'budget-only'};
  assert.deepEqual(b.control.initialize(input).policy,unlimited(10000));assert.deepEqual(b.control.initialize({...input,maxCells:null,maxDepth:null}).policy,unlimited(10000));assert.equal(events(b.control).length,1);
  for(const bad of [{...input,maxCells:5},{...input,maxDepth:0},{...input,growthMode:'unlimited'},null])assert.throws(()=>b.control.initialize(bad),errorCode('INVALID'));
  assert.deepEqual(b.control.control().policy,unlimited(10000));
  const checked=validateGrowthPolicy(unlimited(10000));checked.mission='Mutated clone';assert.equal(b.control.control().policy.mission,legacy.mission);
});

test('missing, unknown and malformed durable growth policy never bypasses admission ceilings',t=>{
  const {control:c}=fixture(t),original=c.db.prepare('SELECT policy FROM control').get().policy;
  const bad=[{mission:legacy.mission,budgetCents:10000}, {...legacy,maxCells:null},{...legacy,maxDepth:null},{...legacy,extra:true},{...legacy,schemaVersion:1},
    {...unlimited(10000),schemaVersion:3},{...unlimited(10000),growthMode:'unlimited'},{...unlimited(10000),maxCells:5},{...unlimited(10000),maxDepth:0},
    {...unlimited(10000),budgetCents:true},{...unlimited(10000),mission:' '},null,[],{...legacy,maxCells:Number.MAX_SAFE_INTEGER+1}];
  const before=events(c);
  for(const policy of bad){assert.throws(()=>validateGrowthPolicy(policy),errorCode('GROWTH_POLICY_INVALID'));c.db.prepare('UPDATE control SET policy=?').run(JSON.stringify(policy));
    assert.throws(()=>c.control(),errorCode('POLICY'));assert.throws(()=>c.status(),errorCode('POLICY'));assert.throws(()=>c.reserveCell({cellId:'forbidden',budgetCents:1,purpose:'Must fail'}),errorCode('POLICY'));
    assert.equal(c.db.prepare('SELECT count(*) AS n FROM cells').get().n,1);assert.deepEqual(events(c),before);}
  c.db.prepare('UPDATE control SET policy=?').run(original);assert.deepEqual(c.control().policy,legacy);
});

test('explicit budget-only policy admits beyond old count and depth while conserving each parent allocation',t=>{
  const {control:c}=fixture(t,{mission:legacy.mission,budgetCents:10000,growthMode:'budget-only'});
  for(let i=0;i<6;i++)c.reserveCell({cellId:'sibling-'+i,budgetCents:100,purpose:'Parallel admitted work'});
  let parentId='root';for(let depth=1;depth<=6;depth++){const cell=c.reserveCell({cellId:'depth-'+depth,parentId,budgetCents:9000,purpose:'Nested admitted work'});assert.equal(cell.depth,depth);parentId=cell.id;}
  assert.equal(c.status().cells.length,13);assert.equal(c.reserveCell({cellId:'remaining',budgetCents:400,purpose:'Exact remaining allocation'}).allocation,400);
  assert.throws(()=>c.reserveCell({cellId:'over-root',budgetCents:1,purpose:'Over allocation'}),errorCode('BUDGET'));
  assert.throws(()=>c.reserveCell({cellId:'over-child',parentId:'depth-1',budgetCents:1,purpose:'Over delegated allocation'}),errorCode('BUDGET'));
  assert.throws(()=>c.reserveCell({cellId:'unknown-parent',parentId:'absent',budgetCents:0,purpose:'No parent'}),errorCode('PARENT'));
  assert.throws(()=>c.reserveCell({cellId:'bad-role',role:'administrator',budgetCents:0,purpose:'Invalid role'}),errorCode('INVALID'));
  assert.throws(()=>c.reserveCell({cellId:'negative',budgetCents:-1,purpose:'Invalid budget'}),errorCode('INVALID'));
});

test('budget-only allocation uses exact integer sums and rejects depth and historical aggregate overflow before insertion',t=>{
  const max=Number.MAX_SAFE_INTEGER,{control:c}=fixture(t,{mission:legacy.mission,budgetCents:max,growthMode:'budget-only'});
  c.db.prepare('UPDATE cells SET spent=1 WHERE id=?').run('root');c.reserveCell({cellId:'large',budgetCents:max-2,purpose:'Large exact allocation'});
  c.reserveCell({cellId:'last',budgetCents:1,purpose:'Last safe cent'});assert.throws(()=>c.reserveCell({cellId:'extra',budgetCents:1,purpose:'Cannot round an extra cent'}),errorCode('BUDGET'));
  c.db.prepare('UPDATE cells SET depth=? WHERE id=?').run(max,'large');const before=events(c);
  assert.throws(()=>c.reserveCell({cellId:'overflow-depth',parentId:'large',budgetCents:0,purpose:'Unsafe depth'}),errorCode('INVALID'));assert.deepEqual(events(c),before);
  // A corrupt historical sum exceeds the safe Number range; every individual value is valid.
  for(const cellId of ['corrupt-a','corrupt-b'])c.db.prepare('INSERT INTO cells(id,parent_id,depth,role,allocation,status,purpose,heartbeat) VALUES(?,?,?,?,?,?,?,?)').run(cellId,'root',1,'developer',max,'reserved','Corrupt fixture history',Date.now());
  assert.throws(()=>c.reserveCell({cellId:'corrupt-extra',budgetCents:0,purpose:'Reject overcommitted history'}),errorCode('BUDGET'));assert.deepEqual(events(c),before);
});

test('two real processes cannot consume the same budget twice, including duplicate reservation retry',async t=>{
  const {control:c,filename}=fixture(t,{mission:legacy.mission,budgetCents:1000,growthMode:'budget-only'});
  const results=await Promise.all(['race-a','race-b'].map(cellId=>child(filename,`console.log(JSON.stringify(c.reserveCell({cellId:${JSON.stringify(cellId)},budgetCents:600,purpose:'Concurrent budget'})))`)));
  assert.equal(results.filter(x=>x.result.id).length,1);assert.equal(results.filter(x=>x.result.code==='BUDGET').length,1);assert.equal(c.status().cells.filter(x=>x.parent_id==='root').reduce((n,x)=>n+x.allocation,0),600);
  const code="console.log(JSON.stringify(c.reserveCell({cellId:'duplicate',budgetCents:400,purpose:'Exact retry'})))";
  const duplicates=await Promise.all([child(filename,code),child(filename,code)]);assert.equal(duplicates[0].result.id,'duplicate');assert.equal(duplicates[1].result.id,'duplicate');
  assert.equal(c.db.prepare("SELECT count(*) AS n FROM events WHERE type='cell_reserved' AND subject='duplicate'").get().n,1);
  assert.equal(new Set([...results,...duplicates].map(x=>x.close.pid)).size,4);assert.throws(()=>c.reserveCell({cellId:'overspend',budgetCents:1,purpose:'No room'}),errorCode('BUDGET'));
});

test('paused digest-CAS transition preserves tasks, uncertain effects, grants, all authority rows and original event history',t=>{
  const f=fixture(t),c=f.control,lease=createWork(c);const originalGrant=grant(c,lease);c.issueCapacityGrant(lease,originalGrant);
  c.admitEffect(lease,{key:'uncertain',kind:'flow_call',request:{conversationId:'original-conversation'}});c.startEffect(lease,'uncertain');c.settleEffect('uncertain','unknown',{state:'unknown'});
  c.sendMessage({sender:'root',recipient:'root',messageId:'original-message',taskId:'work',attempt:lease.epoch,payload:{state:'working'}});
  assert.throws(()=>c.useBudgetOnlyGrowth(cas(c,'active-refused')),errorCode('PAUSED'));c.pause();const request=cas(c,'transition'),before=tables(c),history=events(c),old=c.control();
  for(const stale of [{...request,expectedFactoryEpoch:request.expectedFactoryEpoch-1},{...request,expectedPolicyDigest:'0'.repeat(64)}])assert.throws(()=>c.useBudgetOnlyGrowth(stale),errorCode('STALE'));
  const result=c.useBudgetOnlyGrowth(request);assert.equal(result.replayed,false);assert.equal(result.control.status,'paused');assert.equal(result.control.epoch,old.epoch+1);assert.deepEqual(result.control.policy,unlimited(10000));
  assert.deepEqual(tables(c),before);assert.deepEqual(events(c).slice(0,history.length),history);assert.equal(events(c).length,history.length+1);
  const {transitionDigest,...binding}=result.transition;assert.equal(digest(binding),transitionDigest);assert.equal(result.transition.beforePolicyDigest,request.expectedPolicyDigest);assert.equal(result.transition.afterPolicyDigest,digest(unlimited(10000)));
  const reopened=f.open();assert.deepEqual(reopened.useBudgetOnlyGrowth(request),{...result,replayed:true});assert.equal(events(c).length,history.length+1);assert.deepEqual(reopened.capacityGrant('original-grant'),originalGrant);
  assert.throws(()=>reopened.useBudgetOnlyGrowth({...request,expectedFactoryEpoch:result.control.epoch}),errorCode('CONFLICT'));assert.throws(()=>reopened.useBudgetOnlyGrowth(cas(reopened,'already-budget-only')),errorCode('STATE'));
  reopened.resume();assert.throws(()=>reopened.renew(lease),errorCode('STALE'));assert.throws(()=>reopened.issueCapacityGrant(lease,originalGrant),errorCode('STALE'));
  assert.throws(()=>reopened.claimTask('work','root'),errorCode('UNRECONCILED'));assert.equal(reopened.effect('uncertain').state,'unknown');assert.deepEqual(tables(c),before);
});

test('real process transition replay admits one immutable epoch change and rejects competing stale CAS',async t=>{
  const {control:c,filename}=fixture(t);c.pause();const request=cas(c,'shared-transition');
  const results=await Promise.all([child(filename,`console.log(JSON.stringify(c.useBudgetOnlyGrowth(${JSON.stringify(request)})))`),child(filename,`console.log(JSON.stringify(c.useBudgetOnlyGrowth(${JSON.stringify(request)})))`)]);
  assert.equal(results.filter(x=>x.result.replayed===false).length,1);assert.equal(results.filter(x=>x.result.replayed===true).length,1);assert.equal(c.control().epoch,request.expectedFactoryEpoch+1);
  assert.equal(c.db.prepare("SELECT count(*) AS n FROM events WHERE type='growth_policy_changed'").get().n,1);
  const stale=await child(filename,`console.log(JSON.stringify(c.useBudgetOnlyGrowth(${JSON.stringify({...request,transitionId:'competing-transition'})})))`);assert.equal(stale.result.code,'STALE');
});

test('transition replay rejects modified or nonclosed historical record without changing the durable policy',t=>{
  const {control:c}=fixture(t);c.pause();const request=cas(c,'tamper'),original=c.useBudgetOnlyGrowth(request),before=c.control();
  for(const bad of [{...original.transition,extra:true},{...original.transition,factoryEpoch:original.transition.factoryEpoch+1},{...original.transition,transitionDigest:'0'.repeat(64)}]){
    c.db.prepare("UPDATE events SET details=? WHERE type='growth_policy_changed'").run(JSON.stringify(bad));assert.throws(()=>c.useBudgetOnlyGrowth(request),errorCode('POLICY_HISTORY'));assert.deepEqual(c.control(),before);
  }
  c.db.prepare("UPDATE events SET details=? WHERE type='growth_policy_changed'").run(JSON.stringify(original.transition));assert.equal(c.useBudgetOnlyGrowth(request).replayed,true);
});

test('safe factory epoch boundary rejects transition, pause and resume atomically',t=>{
  const {control:c}=fixture(t);c.pause();c.db.prepare('UPDATE control SET epoch=?').run(Number.MAX_SAFE_INTEGER);const before=c.control(),history=events(c);
  assert.throws(()=>c.useBudgetOnlyGrowth(cas(c,'overflow')),errorCode('INVALID'));assert.throws(()=>c.resume(),errorCode('INVALID'));assert.deepEqual(c.control(),before);assert.deepEqual(events(c),history);
  c.db.prepare("UPDATE control SET status='active'").run();const active=c.control();assert.throws(()=>c.pause(),errorCode('INVALID'));assert.deepEqual(c.control(),active);assert.deepEqual(events(c),history);
});

test('controller independently rejects grant schema confusion and same-identity growth-mode changes across generations',t=>{
  const {control:c}=fixture(t),lease=createWork(c),v2=grant(c,lease,{schemaVersion:2});const before=events(c);
  assert.throws(()=>c.issueCapacityGrant(lease,v2),errorCode('CAPACITY_GRANT'));assert.deepEqual(events(c),before);
  const v1=grant(c,lease);c.issueCapacityGrant(lease,v1);
  const wrongOuter={...v1,schemaVersion:2};delete wrongOuter.grantDigest;wrongOuter.grantDigest=digest(wrongOuter);assert.throws(()=>c.issueCapacityGrant(lease,wrongOuter),errorCode('CAPACITY_GRANT'));
  c.pause();c.useBudgetOnlyGrowth(cas(c,'enable-grant2'));c.resume();const fresh=c.claimTask('work','root',600000),flipped=grant(c,fresh,{schemaVersion:2,generation:2});
  assert.throws(()=>c.issueCapacityGrant(fresh,flipped),errorCode('CONFLICT'));
  const separate=grant(c,fresh,{schemaVersion:2,grantId:'new-budget-only-grant'});assert.deepEqual(c.issueCapacityGrant(fresh,separate),separate);
  const inconsistent={...separate,schemaVersion:1};delete inconsistent.grantDigest;inconsistent.grantDigest=digest(inconsistent);c.db.prepare("UPDATE events SET details=? WHERE type='capacity_grant_issued' AND subject=?").run(JSON.stringify(inconsistent),'new-budget-only-grant');
  assert.throws(()=>c.capacityGrant('new-budget-only-grant'),errorCode('CAPACITY_GRANT'));
});
