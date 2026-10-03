import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FactoryControl, digest } from '../src/control.mjs';
import { executeGitDelivery } from '../src/git-effect.mjs';

const acceptance = { scope:'recorded-controller-operation-receipts-only' };
function fixture(t, { clock = Date.now } = {}) {
  const parent=realpathSync(tmpdir()), dir=mkdtempSync(path.join(parent,'factory-operation-'));
  const filename=path.join(dir,'control.sqlite'), control=new FactoryControl(filename,{clock}), connections=[control];
  control.initialize({mission:'Operational closure fixture',budgetCents:10000,maxCells:12,maxDepth:3});
  t.after(()=>{for(const connection of connections)try{connection.close();}catch{}
    assert.equal(path.dirname(dir),parent);assert.ok(path.basename(dir).startsWith('factory-operation-'));
    rmSync(dir,{recursive:true,force:true,maxRetries:3});});
  function task(taskId='work',specification={}) {
    return control.createTask({taskId,projectId:'project',branch:'codex/'+taskId,
      specification:{problem:'Work',acceptance:'Independent software acceptance',baseline:'pinned',...specification}});
  }
  function cell(cellId='cloud',ready=false) {
    control.reserveCell({cellId,budgetCents:1000,purpose:cellId}); if(ready)control.enrollCell(cellId);
  }
  function operation(taskId='launch',kind='provision',cellId='cloud',app='factory-operation') {
    return task(taskId,{taskType:'operation',operation:{kind,cellId,app},acceptance});
  }
  function provision({taskId='launch',key='up',cellId='cloud',app='factory-operation',typed=true,receipt=null}={}) {
    cell(cellId); if(typed)operation(taskId,'provision',cellId,app);else task(taskId);
    const lease=control.claimTask(taskId,'root');
    control.admitEffect(lease,{key,kind:'provision',request:{cellId,app}});control.startEffect(lease,key);
    control.settleEffect(key,'succeeded',receipt??{app,state:'ready'});return lease;
  }
  return {control,dir,filename,task,cell,operation,provision,
    open(){const reopened=new FactoryControl(filename,{clock});connections.push(reopened);return reopened;}};
}
function identity(control,taskId,closureId='close-'+taskId) {
  const task=control.task(taskId);return {closureId,expectedAttempt:task.epoch,expectedOwner:task.owner,
    expectedStatus:task.status,expectedTaskControlEpoch:task.control_epoch,expectedFactoryEpoch:control.control().epoch};
}
function completeInput(control,taskId='launch',key='up',closureId='complete-'+taskId) {
  return {...identity(control,taskId,closureId),completionEffectKeys:[key]};
}
function cancelInput(control,taskId='work',closureId='cancel-'+taskId) {
  return {...identity(control,taskId,closureId),reason:'acceptance-unmet'};
}
function count(control,type){return control.db.prepare('SELECT count(*) AS n FROM events WHERE type=?').get(type).n;}
function rawTask(control,taskId){return {...control.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)};}
function retained(task){return {specification:task.specification,spec_digest:task.spec_digest,branch:task.branch,project_id:task.project_id,
  candidate:task.candidate,review:task.review,epoch:task.epoch};}
function child(filename,code) {
  const moduleUrl=new URL('../src/control.mjs',import.meta.url).href;
  return new Promise((resolve,reject)=>{
    const process=spawn(globalThis.process.execPath,['--input-type=module','-e',
      `import {FactoryControl} from ${JSON.stringify(moduleUrl)};const c=new FactoryControl(${JSON.stringify(filename)});try{${code}}catch(e){console.log(JSON.stringify({code:e.code}));}finally{c.close();}`],
      {stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';process.stdout.on('data',value=>stdout+=value);process.stderr.on('data',value=>stderr+=value);
    process.on('error',reject);process.on('close',(code,signal)=>code===0&&signal===null?resolve(JSON.parse(stdout.trim())):reject(new Error(stderr)));
  });
}
const runGit=promisify(execFile);
async function git(repository,...args) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_/i.test(key)));
  return (await runGit('git',['-c',`core.hooksPath=${devNull}`,'-C',repository,...args],
    {env,shell:false,windowsHide:true,timeout:30000})).stdout.trim();
}

test('operation creation requires explicit immutable bounded type, descriptor and receipt acceptance',t=>{
  const f=fixture(t);f.cell();
  for(const specification of [
    {taskType:'operation'}, {taskType:'unknown'}, {operation:{kind:'provision',cellId:'cloud',app:'factory-operation'}},
    {taskType:'operation',operation:{kind:'flow_call',cellId:'cloud',app:'factory-operation'},acceptance},
    {taskType:'operation',operation:{kind:'provision',cellId:'cloud',app:'factory-operation',trusted:true},acceptance},
    {taskType:'operation',operation:{kind:'provision',cellId:'cloud',app:'factory-operation'},acceptance:'normalizeCheckpoint software acceptance'},
    {taskType:'operation',operation:{kind:'provision',cellId:'cloud',app:'factory-operation'},acceptance:{...acceptance,software:true}},
    {taskType:'operation',operation:{kind:'provision',cellId:'cloud',app:'factory-operation'},acceptance,deliveryTarget:{ref:'refs/heads/main'}},
  ]) assert.throws(()=>f.task('bad',specification),{code:'INVALID'});
  f.task('software',{taskType:'software'});f.operation();
  assert.throws(()=>f.operation('launch','retire'),{code:'CONFLICT'});
});

test('exact provisioning completion while paused preserves immutable history and revokes authority',t=>{
  const f=fixture(t),lease=f.provision();f.control.pause();const input=completeInput(f.control),before=rawTask(f.control,'launch');
  const effects=f.control.status().effects,events=count(f.control,'effect_settled');
  const result=f.control.completeOperationalTask('launch',input),after=rawTask(f.control,'launch');
  assert.equal(result.status,'completed');assert.equal(result.completionScope,acceptance.scope);assert.equal(result.reviewedSoftwareDelivered,false);
  assert.equal(result.workerQuiescence,'unverified');assert.deepEqual(result.supportingEffectKeys,['up']);
  assert.deepEqual(retained(after),retained(before));for(const key of ['owner','token_hash','expires','control_epoch'])assert.equal(after[key],null);
  assert.deepEqual(f.control.status().effects,effects);assert.equal(count(f.control,'effect_settled'),events);
  assert.equal(count(f.control,'task_completed'),1);f.control.resume();assert.throws(()=>f.control.renew(lease),{code:'STALE'});
  assert.throws(()=>f.control.claimTask('launch','root'),{code:'TASK'});
  assert.throws(()=>f.control.startEffect(lease,'up'),{code:'STALE'});
});

test('genuine worker-only, app-only and matching dual identities complete without rewriting receipts',t=>{
  for(const receipt of [{worker:'factory-operation',state:'ready'},{app:'factory-operation',state:'ready'},
    {app:'factory-operation',worker:'factory-operation',state:'ready'}]) {
    const f=fixture(t);f.provision({receipt});const before=f.control.effect('up');
    assert.equal(f.control.completeOperationalTask('launch',completeInput(f.control)).status,'completed');
    assert.deepEqual(f.control.effect('up'),before);assert.deepEqual(f.control.effect('up').receipt,receipt);
  }
  for(const receipt of [{app:'factory-operation',worker:'factory-other',state:'ready'},
    {app:'factory-other',worker:'factory-operation',state:'ready'},{state:'ready'}]) {
    const f=fixture(t);f.provision({receipt});const before=f.control.effect('up');
    assert.throws(()=>f.control.completeOperationalTask('launch',completeInput(f.control)),{code:'OPERATION_EVIDENCE'});
    assert.deepEqual(f.control.effect('up'),before);assert.equal(f.control.task('launch').status,'running');
  }
});

test('completion requires exact CAS fields and closed bounded request without caller supplied trust',t=>{
  const f=fixture(t);f.provision();const input=completeInput(f.control);
  for(const changed of [{expectedAttempt:2},{expectedOwner:'other'},{expectedStatus:'ready'},{expectedTaskControlEpoch:2},{expectedFactoryEpoch:2}])
    assert.throws(()=>f.control.completeOperationalTask('launch',{...input,...changed}),{code:'STALE'});
  for(const changed of [{completionEffectKeys:[]},{completionEffectKeys:['up','up']},{completionEffectKeys:'up'},
    {expectedAttempt:true},{expectedOwner:null},{trusted:true},{retirementEvidence:{state:'destroyed'}}])
    assert.throws(()=>f.control.completeOperationalTask('launch',{...input,...changed}),{code:'INVALID'});
  assert.equal(f.control.task('launch').status,'running');assert.equal(count(f.control,'task_completed'),0);
});

test('exact closed replay across reopen and later factory epochs is one event and detects retained-task tampering',t=>{
  const f=fixture(t);f.provision();const input=completeInput(f.control),result=f.control.completeOperationalTask('launch',input);
  f.control.pause();f.control.resume();assert.deepEqual(f.open().completeOperationalTask('launch',input),result);
  assert.equal(count(f.control,'task_completed'),1);
  assert.throws(()=>f.control.completeOperationalTask('launch',{...input,completionEffectKeys:['different']}),{code:'CONFLICT'});
  const original=rawTask(f.control,'launch');
  for(const [column,value] of [['specification','{}'],['spec_digest','0'.repeat(64)],['branch','codex/changed'],['candidate','{}'],['epoch',2]]){
    f.control.db.prepare(`UPDATE tasks SET ${column}=? WHERE id='launch'`).run(value);
    assert.throws(()=>f.control.completeOperationalTask('launch',input),{code:'STALE'});
    f.control.db.prepare(`UPDATE tasks SET ${column}=? WHERE id='launch'`).run(original[column]);
  }
  f.control.db.prepare("UPDATE effects SET receipt='{}' WHERE key='up'").run();
  assert.throws(()=>f.control.completeOperationalTask('launch',input),{code:'STALE'});
});

test('successful released attempt can complete ready with exact historical owner and task epoch',t=>{
  const f=fixture(t);f.provision();const release=identity(f.control,'launch','release-launch');
  f.control.releaseTask('launch',release);f.control.pause();const input=completeInput(f.control);
  assert.equal(input.expectedOwner,null);assert.equal(input.expectedTaskControlEpoch,null);assert.equal(input.expectedAttempt,1);
  assert.equal(f.control.completeOperationalTask('launch',input).status,'completed');
});

test('ready completion rejects missing release provenance and earlier claimant successes',t=>{
  const f=fixture(t);f.provision();f.control.releaseTask('launch',identity(f.control,'launch','release-launch'));
  const released=f.control.db.prepare("SELECT details FROM events WHERE type='task_released'").get().details;
  f.control.db.prepare("UPDATE events SET details='{}' WHERE type='task_released'").run();
  assert.throws(()=>f.control.completeOperationalTask('launch',completeInput(f.control)),{code:'OPERATION_EVIDENCE'});
  f.control.db.prepare("UPDATE events SET details=? WHERE type='task_released'").run(released);
  f.control.claimTask('launch','root');assert.throws(()=>f.control.completeOperationalTask('launch',completeInput(f.control)),{code:'OPERATION_EVIDENCE'});
});

test('untyped software-acceptance launch is cancelled truthfully despite successful provision and cleanup',t=>{
  const f=fixture(t);f.provision({typed:false});
  f.control.admitOwnedRetirement({key:'down',app:'factory-operation'});f.control.startOwnedRetirement('down');
  f.control.settleEffect('down','succeeded',{app:'factory-operation',state:'destroyed'});f.control.pause();
  const before=rawTask(f.control,'launch'),effects=f.control.status().effects;
  assert.throws(()=>f.control.completeOperationalTask('launch',completeInput(f.control)),{code:'TASK'});
  const result=f.control.cancelTask('launch',cancelInput(f.control,'launch'));
  assert.equal(result.status,'cancelled');assert.equal(result.reason,'acceptance-unmet');assert.equal(result.reviewedSoftwareDelivered,false);
  assert.equal(result.specificationAcceptance,'not-established-by-cancellation');
  assert.deepEqual(retained(rawTask(f.control,'launch')),retained(before));assert.deepEqual(f.control.status().effects,effects);
  assert.equal(Object.hasOwn(f.control.task('launch').specification,'taskType'),false);
});

test('provider absence strings, wrong receipts, changed bindings and changed history cannot complete',t=>{
  for(const mutation of [
    c=>c.db.prepare("UPDATE effects SET receipt=? WHERE key='up'").run(JSON.stringify({app:'factory-operation',state:'destroyed'})),
    c=>c.db.prepare("UPDATE effects SET owner_epoch=2 WHERE key='up'").run(),
    c=>c.db.prepare("UPDATE effects SET task_id=NULL WHERE key='up'").run(),
    c=>c.db.prepare("UPDATE effects SET request_digest=? WHERE key='up'").run('0'.repeat(64)),
    c=>c.db.prepare("DELETE FROM events WHERE type='effect_settled' AND subject='up'").run(),
    c=>c.db.prepare("DELETE FROM effect_bindings WHERE target='cell:cloud'").run(),
  ]) {
    const f=fixture(t);f.provision();mutation(f.control);
    assert.throws(()=>f.control.completeOperationalTask('launch',completeInput(f.control)),error=>['OPERATION_EVIDENCE','PROVISION_BINDING'].includes(error.code));
    assert.equal(f.control.task('launch').status,'running');assert.equal(count(f.control,'task_completed'),0);
  }
});

test('operation admission binds kind, cell, app and task identity before any intent',t=>{
  const f=fixture(t);f.cell();f.operation();const lease=f.control.claimTask('launch','root');
  for(const command of [{kind:'flow_call',request:{}},{kind:'provision',request:{cellId:'other',app:'factory-operation'}},
    {kind:'provision',request:{cellId:'cloud',app:'factory-other'}},{kind:'provision',request:{cellId:'cloud',app:'factory-operation'},taskId:'other'}])
    assert.throws(()=>f.control.admitEffect(lease,{key:'bad',...command}),{code:'OPERATION_BINDING'});
  assert.equal(f.control.status().effects.length,0);
});

test('typed retirement completes only exact task-bound cleanup with immutable original provisioning identity',t=>{
  const f=fixture(t);f.provision({receipt:{worker:'factory-operation',state:'ready'}});f.control.completeOperationalTask('launch',completeInput(f.control));
  f.operation('cleanup','retire');const lease=f.control.claimTask('cleanup','root');
  for(const request of [{cellId:'cloud',app:'factory-operation',provisionKey:'other'},
    {cellId:'cloud',app:'factory-operation',provisionKey:'up',trusted:true}])
    assert.throws(()=>f.control.admitEffect(lease,{key:'bad',kind:'retire',request}),error=>['OPERATION_BINDING','INVALID'].includes(error.code));
  f.control.admitEffect(lease,{key:'cleanup',kind:'retire',request:{cellId:'cloud',app:'factory-operation',provisionKey:'up'}});
  f.control.startEffect(lease,'cleanup');f.control.settleEffect('cleanup','succeeded',{worker:'factory-operation',state:'destroyed'});
  f.control.pause();const result=f.control.completeOperationalTask('cleanup',completeInput(f.control,'cleanup','cleanup'));
  assert.deepEqual(result.supportingEffectKeys,['up','cleanup']);assert.equal(result.operation.kind,'retire');
  assert.equal(result.workerQuiescence,'unverified');assert.equal(f.control.status().cells.find(row=>row.id==='cloud').status,'reserved');
});

test('all causal accepted/running/unknown task and project effects block completion and cancellation',t=>{
  for(const state of ['accepted','running','unknown'])for(const scope of ['task','project']) {
    const f=fixture(t);f.provision();
    f.control.db.prepare('INSERT INTO effects(key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('open',scope,scope==='task'?'launch':'project','launch','root',1,1,scope==='task'?'flow_call':'delivery','a'.repeat(64),state,1,1);
    assert.throws(()=>f.control.completeOperationalTask('launch',completeInput(f.control)),{code:'UNRECONCILED'});
    assert.throws(()=>f.control.cancelTask('launch',cancelInput(f.control,'launch')),{code:'UNRECONCILED'});
    assert.equal(f.control.effect('open').state,state);assert.equal(f.control.task('launch').status,'running');
  }
});

test('same-app root cleanup blocks both typed retirement transitions, unrelated unknown cleanup does not',t=>{
  for(const state of ['accepted','running','unknown']) {
    const f=fixture(t);f.provision();f.control.completeOperationalTask('launch',completeInput(f.control));
    f.operation('cleanup','retire');const lease=f.control.claimTask('cleanup','root');
    f.control.admitEffect(lease,{key:'cleanup',kind:'retire',request:{cellId:'cloud',app:'factory-operation',provisionKey:'up'}});
    f.control.startEffect(lease,'cleanup');f.control.settleEffect('cleanup','succeeded',{app:'factory-operation',state:'destroyed'});
    f.control.admitOwnedRetirement({key:'root-cleanup',app:'factory-operation'});
    if(state!=='accepted')f.control.startOwnedRetirement('root-cleanup');if(state==='unknown')f.control.settleEffect('root-cleanup','unknown',{});
    assert.throws(()=>f.control.completeOperationalTask('cleanup',completeInput(f.control,'cleanup','cleanup')),{code:'UNRECONCILED'});
    assert.throws(()=>f.control.cancelTask('cleanup',cancelInput(f.control,'cleanup')),{code:'UNRECONCILED'});
    assert.equal(f.control.effect('root-cleanup').state,state);
  }
  const f=fixture(t);f.provision();f.control.completeOperationalTask('launch',completeInput(f.control));
  f.operation('cleanup','retire');const lease=f.control.claimTask('cleanup','root');
  f.control.admitEffect(lease,{key:'cleanup',kind:'retire',request:{cellId:'cloud',app:'factory-operation',provisionKey:'up'}});
  f.control.startEffect(lease,'cleanup');f.control.settleEffect('cleanup','succeeded',{app:'factory-operation',state:'destroyed'});
  f.provision({taskId:'unrelated',key:'unrelated-up',cellId:'other',app:'factory-unrelated'});
  f.control.admitOwnedRetirement({key:'unrelated-cleanup',app:'factory-unrelated'});f.control.startOwnedRetirement('unrelated-cleanup');
  f.control.settleEffect('unrelated-cleanup','unknown',{});
  assert.equal(f.control.completeOperationalTask('cleanup',completeInput(f.control,'cleanup','cleanup')).status,'completed');
  assert.equal(f.control.effect('unrelated-cleanup').state,'unknown');
});

test('ready attempt zero cancellation clears no invented owner, frees branch and replays exactly',t=>{
  const f=fixture(t);f.task();const input=cancelInput(f.control);assert.equal(input.expectedAttempt,0);assert.equal(input.expectedOwner,null);
  const before=rawTask(f.control,'work'),result=f.control.cancelTask('work',input);assert.deepEqual(retained(rawTask(f.control,'work')),retained(before));
  f.control.createTask({taskId:'successor',projectId:'project',branch:'codex/work',specification:{problem:'New work',acceptance:'New acceptance',baseline:'pinned'}});
  f.control.pause();f.control.resume();assert.deepEqual(f.open().cancelTask('work',input),result);assert.equal(count(f.control,'task_cancelled'),1);
  assert.throws(()=>f.control.cancelTask('work',{...input,reason:'abandoned'}),{code:'CONFLICT'});
});

test('running cancellation fences every identity and stale token after pause/resume',t=>{
  const f=fixture(t);f.task();const lease=f.control.claimTask('work','root'),input=cancelInput(f.control);
  for(const changed of [{expectedAttempt:2},{expectedOwner:'other'},{expectedStatus:'ready'},{expectedTaskControlEpoch:2},{expectedFactoryEpoch:2}])
    assert.throws(()=>f.control.cancelTask('work',{...input,...changed}),{code:'STALE'});
  for(const changed of [{reason:'done'},{expectedOwner:null},{expectedTaskControlEpoch:null},{trusted:true},{expectedAttempt:true}])
    assert.throws(()=>f.control.cancelTask('work',{...input,...changed}),{code:'INVALID'});
  f.control.pause();assert.throws(()=>f.control.cancelTask('work',input),{code:'STALE'});
  f.control.cancelTask('work',cancelInput(f.control));f.control.resume();
  assert.throws(()=>f.control.renew(lease),{code:'STALE'});
  assert.throws(()=>f.control.admitEffect(lease,{key:'late',kind:'flow_call',request:{}}),{code:'STALE'});
});

test('review and verified cancellation preserve exact artifact/review bytes, digests and original attempt',t=>{
  for(const verified of [false,true]) {
    const f=fixture(t);f.cell('dev',true);f.control.reserveCell({cellId:'verifier',role:'verifier',budgetCents:0,purpose:'Independent reviewer'});f.control.enrollCell('verifier');f.task();
    const artifact=path.join(f.dir,'artifact.txt'),proof=path.join(f.dir,'proof.txt');writeFileSync(artifact,'Original candidate bytes');writeFileSync(proof,'Original independent review');
    const lease=f.control.claimTask('work','dev');f.control.submit(lease,{artifactPath:artifact});if(verified)f.control.reviewTask('work','verifier',{accepted:true,evidencePath:proof});
    const before=rawTask(f.control,'work'),artifactHash=digest(readFileSync(artifact).toString()),proofHash=digest(readFileSync(proof).toString());
    f.control.pause();f.control.cancelTask('work',cancelInput(f.control));assert.deepEqual(retained(rawTask(f.control,'work')),retained(before));
    assert.equal(digest(readFileSync(artifact).toString()),artifactHash);assert.equal(digest(readFileSync(proof).toString()),proofHash);
    const event=JSON.parse(f.control.db.prepare("SELECT details FROM events WHERE type='task_cancelled'").get().details);
    assert.equal(event.result.previousOwner,'dev');assert.equal(event.retainedTask.candidate,before.candidate);assert.equal(event.retainedTask.review,before.review);
  }
});

test('successful real Git delivery blocks abandonment across epochs and remains finalizable while paused',async t=>{
  const f=fixture(t),repository=path.join(f.dir,'repository');mkdirSync(repository);await git(repository,'init','--initial-branch=integration');
  await git(repository,'config','user.name','Operation fixture');await git(repository,'config','user.email','fixture@example.invalid');
  await git(repository,'config','core.autocrlf','false');writeFileSync(path.join(repository,'result.txt'),'baseline\n');
  await git(repository,'add','result.txt');await git(repository,'commit','-m','baseline');const baseline=await git(repository,'rev-parse','HEAD');
  await git(repository,'checkout','-b','codex/work');writeFileSync(path.join(repository,'result.txt'),'reviewed candidate\n');
  await git(repository,'commit','-am','candidate');const candidateHead=await git(repository,'rev-parse','HEAD'),ref='refs/heads/integration';
  f.cell('dev',true);f.control.reserveCell({cellId:'verifier',role:'verifier',budgetCents:0,purpose:'Independent review'});f.control.enrollCell('verifier');
  f.task('work',{baseline,deliveryTarget:{repository,ref}});const artifact=path.join(f.dir,'candidate.json'),proof=path.join(f.dir,'review.txt');
  writeFileSync(artifact,JSON.stringify({repository,ref,baseline,candidateHead,branch:'codex/work'}));writeFileSync(proof,'Independent exact review');
  const lease=f.control.claimTask('work','dev');f.control.submit(lease,{artifactPath:artifact});f.control.reviewTask('work','verifier',{accepted:true,evidencePath:proof});
  const integration=f.control.claimIntegration('project');
  const receipt=await executeGitDelivery(f.control,integration,{key:'delivered',kind:'delivery',taskId:'work',request:{repository,ref,expectedHead:baseline,candidateHead}});
  assert.equal(receipt.dispatched,true);assert.equal(f.control.effect('delivered').state,'succeeded');assert.equal(await git(repository,'rev-parse',ref),candidateHead);
  f.control.pause();assert.throws(()=>f.control.cancelTask('work',cancelInput(f.control)),{code:'DELIVERY'});
  assert.equal(f.control.deliverTask('work','delivered').status,'delivered');assert.equal(count(f.control,'task_cancelled'),0);
});

test('closure identities conflict globally across release, retirement, cancellation and completion',t=>{
  const f=fixture(t);f.task();f.control.claimTask('work','root');const shared='shared-closure';
  f.control.releaseTask('work',identity(f.control,'work',shared));
  assert.throws(()=>f.control.cancelTask('work',cancelInput(f.control,'work',shared)),{code:'CONFLICT'});
  f.provision();assert.throws(()=>f.control.completeOperationalTask('launch',completeInput(f.control,'launch','up',shared)),{code:'CONFLICT'});
  f.cell('unused');const cell=f.control.status().cells.find(row=>row.id==='unused');
  assert.throws(()=>f.control.retireCell('unused',{closureId:shared,expectedParent:'root',expectedStatus:'reserved',expectedAllocation:cell.allocation,expectedSpent:0,expectedFactoryEpoch:1}),{code:'CONFLICT'});
});

test('two independent SQLite processes complete exactly once, reopen observes identical closed receipt',async t=>{
  const f=fixture(t);f.provision();const input=completeInput(f.control),code=`console.log(JSON.stringify(c.completeOperationalTask('launch',${JSON.stringify(input)})))`;
  const [a,b]=await Promise.all([child(f.filename,code),child(f.filename,code)]);assert.deepEqual(a,b);assert.equal(a.status,'completed');
  assert.equal(count(f.control,'task_completed'),1);assert.deepEqual(f.open().completeOperationalTask('launch',input),a);
});

test('two independent SQLite processes cancel exactly once, conflicting terminal race has one winner',async t=>{
  const f=fixture(t);f.task();const input=cancelInput(f.control),code=`console.log(JSON.stringify(c.cancelTask('work',${JSON.stringify(input)})))`;
  const [a,b]=await Promise.all([child(f.filename,code),child(f.filename,code)]);assert.deepEqual(a,b);assert.equal(a.status,'cancelled');assert.equal(count(f.control,'task_cancelled'),1);
  f.provision();const complete=completeInput(f.control),cancel={...cancelInput(f.control,'launch'),closureId:complete.closureId};
  const results=await Promise.all([child(f.filename,`console.log(JSON.stringify(c.completeOperationalTask('launch',${JSON.stringify(complete)})))`),
    child(f.filename,`console.log(JSON.stringify(c.cancelTask('launch',${JSON.stringify(cancel)})))`)]);
  assert.equal(results.filter(value=>['completed','cancelled'].includes(value.status)).length,1);assert.equal(results.filter(value=>value.code==='CONFLICT').length,1);
});

test('effect admission versus cancellation serializes without losing admitted work or granting stale dispatch',async t=>{
  const f=fixture(t);f.task();const lease=f.control.claimTask('work','root'),input=cancelInput(f.control);
  const [cancel,admission]=await Promise.all([child(f.filename,`console.log(JSON.stringify(c.cancelTask('work',${JSON.stringify(input)})))`),
    child(f.filename,`console.log(JSON.stringify(c.admitEffect(${JSON.stringify(lease)},{key:'race',kind:'flow_call',request:{}})))`)]);
  if(cancel.status==='cancelled'){assert.equal(admission.code,'STALE');assert.equal(f.control.status().effects.length,0);}
  else{assert.equal(cancel.code,'UNRECONCILED');assert.equal(admission.fresh,true);assert.equal(f.control.effect('race').state,'accepted');assert.equal(f.control.task('work').status,'running');}
});
