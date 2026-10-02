import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { FactoryControl } from '../src/control.mjs';
import { executeEffect } from '../src/gateway.mjs';

function fixture(t,{clock}={}) {
  const dir=mkdtempSync(join(tmpdir(),'factory-control-')),path=join(dir,'control.sqlite');
  const control=new FactoryControl(path,{clock});
  const connections=[control];
  control.initialize({mission:'Improve FLUJO development speed',budgetCents:10000,maxCells:8,maxDepth:2});
  for(const [cellId,role] of [['dev','developer'],['verify','verifier'],['watch','watcher']]) {control.reserveCell({cellId,role,budgetCents:1000,purpose:role});control.enrollCell(cellId);}
  control.createTask({taskId:'fix',projectId:'flujo',branch:'codex/approach-a',specification:{problem:'Known defect',acceptance:'Independent regression result',baseline:'pinned-baseline'}});
  t.after(()=>{for(const connection of connections){try{connection.close();}catch{}}rmSync(dir,{recursive:true,force:true});});
  return {control,dir,path,open(options){const connection=new FactoryControl(path,options);connections.push(connection);return connection;}};
}
function child(path,code) {
  const moduleUrl=new URL('../src/control.mjs',import.meta.url).href;
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['--input-type=module','-e',`import {FactoryControl} from ${JSON.stringify(moduleUrl)}; const c=new FactoryControl(${JSON.stringify(path)}); try { ${code} } catch(e) { console.log(JSON.stringify({code:e.code})); } finally { c.close(); }`],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('error',reject);p.on('exit',exit=>{if(exit!==0)reject(new Error(stderr));else resolve(JSON.parse(stdout.trim()));});
  });
}
test('cross-process task claims admit exactly one owner',async t=>{
  const {control,path}=fixture(t);
  const attempts=await Promise.all([child(path,'console.log(JSON.stringify(c.claimTask("fix","dev")))'),child(path,'console.log(JSON.stringify(c.claimTask("fix","root")))')]);
  assert.equal(attempts.filter(x=>x.token).length,1);assert.equal(attempts.filter(x=>x.code==='BUSY').length,1);assert.equal(control.task('fix').epoch,1);
});
test('concurrent duplicate reservations consume capacity and budget once',async t=>{
  const {control,path}=fixture(t);
  const code='console.log(JSON.stringify(c.reserveCell({cellId:"cloud",parentId:"root",role:"developer",budgetCents:5000,purpose:"cloud pilot"})))';
  const results=await Promise.all([child(path,code),child(path,code)]);
  assert.equal(results[0].id,results[1].id);assert.equal(control.status().cells.filter(x=>x.id==='cloud').length,1);
  assert.throws(()=>control.reserveCell({cellId:'extra',budgetCents:3000,purpose:'over cap'}),e=>e.code==='BUDGET');
});
test('child allocations cannot spend the same reserved parent budget',t=>{
  const {control}=fixture(t);control.reserveCell({cellId:'child',parentId:'dev',budgetCents:800,purpose:'subtask'});
  assert.throws(()=>control.reserveCell({cellId:'child2',parentId:'dev',budgetCents:800,purpose:'another subtask'}),e=>e.code==='BUDGET');
  assert.throws(()=>control.reserveCell({cellId:'depth3',parentId:'child',budgetCents:1,purpose:'too deep'}),e=>e.code==='CAPACITY');
});
test('lease takeover fences old owner across an actual database reopen',t=>{
  let now=1000;const {control,open}=fixture(t,{clock:()=>now});const old=control.claimTask('fix','dev',10);now=1011;
  const reopened=open({clock:()=>now});const fresh=reopened.claimTask('fix','root');
  assert.equal(fresh.epoch,2);assert.throws(()=>control.admitEffect(old,{key:'stale',kind:'flow_call',request:{}}),e=>e.code==='STALE');assert.equal(reopened.status().effects.length,0);
});
test('unknown external effects survive restart and prevent takeover or blind replay',async t=>{
  let now=1000;const {control,open}=fixture(t,{clock:()=>now});const lease=control.claimTask('fix','dev',10);let calls=0;
  const intent={key:'uncertain',kind:'flow_call',request:{conversationId:'accepted-conversation'}};
  const result=await executeEffect(control,lease,intent,async()=>{calls++;throw new Error('Lost acknowledgement');});
  assert.equal(result.effect.state,'unknown');
  const duplicate=await executeEffect(control,lease,intent,async()=>{calls++;return {};});assert.equal(duplicate.dispatched,false);assert.equal(calls,1);
  now=1011;const reopened=open({clock:()=>now});
  assert.throws(()=>reopened.claimTask('fix','root'),e=>e.code==='UNRECONCILED');assert.equal(reopened.effect('uncertain').state,'unknown');
});
test('effect key conflicts preserve the original request',t=>{
  const {control}=fixture(t);const lease=control.claimTask('fix','dev');control.admitEffect(lease,{key:'request',kind:'flow_call',request:{selected:1}});
  assert.throws(()=>control.admitEffect(lease,{key:'request',kind:'flow_call',request:{selected:2}}),e=>e.code==='CONFLICT');assert.equal(control.effect('request').state,'accepted');
});
test('provisioning requires allocation and binds one durable app identity',t=>{
  const {control}=fixture(t);const lease=control.claimTask('fix','root');
  assert.throws(()=>control.admitEffect(lease,{key:'missing',kind:'provision',request:{cellId:'absent',app:'factory-pilot'}}),e=>e.code==='RESERVATION');
  control.reserveCell({cellId:'cloud',budgetCents:2000,purpose:'cloud pilot'});
  control.admitEffect(lease,{key:'up',kind:'provision',request:{cellId:'cloud',app:'factory-pilot'}});
  control.settleEffect('up','succeeded',{worker:'factory-pilot'});
  assert.throws(()=>control.admitEffect(lease,{key:'duplicate-up',kind:'provision',request:{cellId:'cloud',app:'different-app'}}),e=>e.code==='CONFLICT');
});
test('pause revokes admission without pretending unknown effects or workers are stopped',t=>{
  const {control}=fixture(t);const lease=control.claimTask('fix','dev');control.admitEffect(lease,{key:'pending',kind:'flow_call',request:{}});control.startEffect(lease,'pending');
  const paused=control.pause();assert.equal(paused.control.status,'paused');assert.equal(paused.effectsDrained,false);assert.equal(paused.workerQuiescence,'unverified');
  assert.throws(()=>control.admitEffect(lease,{key:'new',kind:'flow_call',request:{}}),e=>e.code==='PAUSED');
  control.settleEffect('pending','succeeded',{acceptedBeforePause:true});assert.equal(control.status().effectsDrained,true);
  control.resume();assert.throws(()=>control.renew(lease),e=>e.code==='STALE');assert.equal(control.claimTask('fix','root').epoch,2);
});
test('independent candidate review and exact unchanged evidence are required for delivery',t=>{
  const {control,dir}=fixture(t);const lease=control.claimTask('fix','dev');const artifact=join(dir,'candidate.json'),proof=join(dir,'review.json');writeFileSync(artifact,'candidate');writeFileSync(proof,'regression passed');
  control.submit(lease,{artifactPath:artifact});assert.throws(()=>control.reviewTask('fix','dev',{accepted:true,evidencePath:proof}),e=>e.code==='REVIEWER');
  control.reviewTask('fix','verify',{accepted:true,evidencePath:proof});const integration=control.claimIntegration('flujo');
  assert.throws(()=>control.claimIntegration('flujo'),e=>e.code==='BUSY');writeFileSync(artifact,'modified after review');
  assert.throws(()=>control.admitEffect(integration,{key:'deliver',kind:'delivery',taskId:'fix',request:{}}),e=>e.code==='EVIDENCE');
});
test('message replay after restart does not create a second event or upgrade stale evidence',async t=>{
  const {control,open}=fixture(t);const lease=control.claimTask('fix','dev');const message={sender:'dev',recipient:'watch',messageId:'checkpoint',taskId:'fix',attempt:lease.epoch,payload:{state:'working'}};
  assert.equal(control.sendMessage(message).duplicate,false);const reopened=open();assert.equal(reopened.sendMessage(message).duplicate,true);assert.equal(reopened.inbox('watch').length,1);
  assert.throws(()=>reopened.sendMessage({...message,payload:{state:'delivered'}}),e=>e.code==='CONFLICT');assert.throws(()=>reopened.sendMessage({...message,messageId:'old',attempt:0}),e=>e.code==='STALE');
});
