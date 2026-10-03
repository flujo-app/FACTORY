import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { PeerStore, createPairConfigurations, requestHeaders, verifyRequest } from '../src/peer-messaging.mjs';
import { createManagedCloudAdapter } from '../src/adapters/managed-cloud.mjs';
import { issueCapacityGrant, enqueueCapacityRequest, interpretCapacityRequest, capacityMessageId, validateCapacityGrant } from '../src/capacity-bridge.mjs';

const image='ghcr.io/fixture/native@sha256:'+'a'.repeat(64);
const nativeProof={workspace:'fixture',archiveSha256:'b'.repeat(64),compatibility:{applicationVersion:'3.46.2',snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1}};
function fixture(t,{issue=true,policy={},paidLimit=10000,specification,native=false}={}) {
  const directory=mkdtempSync(join(tmpdir(),'factory-capacity-')),clock={now:Date.now()},now=()=>clock.now,connections=[];
  const controlPath=join(directory,'control.sqlite'),paidPath=join(directory,'paid.sqlite'),senderPath=join(directory,'sender.sqlite'),receiverPath=join(directory,'receiver.sqlite');
  const keep=value=>{connections.push(value);return value;};
  const control=keep(new FactoryControl(controlPath,{clock:now}));
  control.initialize({mission:'Fixture capacity dispatch',budgetCents:10000,maxCells:10,maxDepth:2});
  control.createTask({taskId:'capacity-task',projectId:'fixture',branch:'codex/capacity',specification:specification??{problem:'Capacity for admitted native work',acceptance:'Owned provision receipt',baseline:'fixture-only'}});
  const lease=control.claimTask('capacity-task','root',600000),paid=keep(new SpendingLedger(paidPath,{clock:now}));paid.initialize({limitCents:paidLimit,currency:'USD'});
  const pair=createPairConfigurations({a:{identity:{factoryId:'fixture-factory',cellId:'root'},endpoint:'http://127.0.0.1:46101/v1/peer/messages'},
    b:{identity:{factoryId:'fixture-factory',cellId:'broker'},endpoint:'http://127.0.0.1:46102/v1/peer/messages'},credentialExpiresAt:clock.now+3600000});
  const sender=keep(new PeerStore(senderPath,{config:pair.a,clock:now})),receiver=keep(new PeerStore(receiverPath,{config:pair.b,clock:now}));
  const grant={schemaVersion:1,grantId:'capacity-grant',generation:1,lease,expiresAt:lease.expires,maxChildren:4,maxBudgetCents:2000,
    allowedRoles:['developer','verifier'],template:{source:'http://127.0.0.1:46103',workspace:'fixture',image,org:'fixture-org',region:'iad',appPrefix:'fixture-capacity',flowIds:['fixture-flow']},
    paid:{provider:'fly',ceilingCents:1000},...(native?{native:nativeProof}:{}),...policy};
  const binding=issue?issueCapacityGrant({control,store:receiver,grant}):null;
  t.after(()=>{for (const c of connections) {try{c.close();}catch{}}rmSync(directory,{recursive:true,force:true});});
  return {directory,clock,now,control,paid,sender,receiver,pair,grant,binding,lease,keep,controlPath,paidPath,senderPath,receiverPath};
}
function request(requestId,overrides={}) {return {requestId,role:'developer',budgetCents:500,purpose:'Develop the admitted fixture branch',...overrides};}
function receive(f,requestId,overrides={},options={}) {
  const outbox=enqueueCapacityRequest({store:options.sender??f.sender,grant:options.grant??f.grant,request:request(requestId,overrides),nativeProof:options.nativeProof??null});
  const receiver=options.receiver??f.receiver;
  const envelope=verifyRequest(receiver.config,outbox.body,requestHeaders((options.sender??f.sender).config,outbox.body,f.now()),f.now());
  receiver.receiveEnvelope(envelope);return outbox;
}
async function adapter(up) {
  return createManagedCloudAdapter({service:{env:{FIXTURE_SECRET:'never-log-fixture-secret'},sources:async()=>[],preflight:async()=>{throw new Error('A preflight must not run');},
    up,call:async()=>{throw new Error('A Flow must not run');},list:async()=>[],down:async()=>{throw new Error('Cleanup must not run');}}});
}
const ready=input=>({app:input.app,worker:input.app,state:'ready',workspace:input.workspace,org:input.org,region:input.region});
const revision=f=>f.control.db.prepare('SELECT max(seq) AS revision FROM events').get().revision;
function interpret(f,outbox,a,extra={}) {return interpretCapacityRequest({control:f.control,store:f.receiver,grant:f.grant,messageId:outbox.messageId,adapter:a,paidAdmission:f.paid,...extra});}
const errorCode=code=>error=>error?.code===code;
const admitted=f=>f.control.db.prepare("SELECT details FROM events WHERE type='capacity_admitted'").all().map(row=>JSON.parse(row.details));

test('trusted grant drives actual ManagedCloud adapter dispatch; sender intent, atomic child/effect and conservative paid hold remain durable',async t=>{
  const f=fixture(t,{native:true}),outbox=receive(f,'native-request',{}, {nativeProof}),calls=[];
  const a=await adapter(async input=>{calls.push(input);return {...ready(input),body:'never-log-fixture-secret'};});
  const result=await interpret(f,outbox,a);
  assert.equal(result.dispatched,true);assert.equal(result.effect.state,'succeeded');assert.equal(calls.length,1);
  assert.deepEqual(calls[0],admitted(f)[0].provisionRequest);assert.equal(calls[0].image,image);assert.equal(calls[0].org,'fixture-org');assert.equal(calls[0].workspace,'fixture');
  assert.deepEqual(calls[0].flowIds,['fixture-flow']);assert.equal(calls[0].app,result.app);
  assert.equal(f.sender.outbox(outbox.messageId).state,'pending');assert.equal(f.receiver.inbox().length,1);
  const child=f.control.status().cells.find(cell=>cell.id===result.cellId);
  assert.equal(child.status,'reserved');assert.equal(child.parent_id,'root');assert.equal(child.allocation,500);
  assert.equal(f.paid.snapshot().committedCents,1000);assert.equal(f.paid.row(result.paid.reservationId).state,'started');
  assert.equal(result.nativePeerAutonomy,false);assert.equal(result.workerQuiescence,'unverified');
  assert.equal(JSON.stringify(result).includes('never-log-fixture-secret'),false);assert.equal(JSON.stringify(f.binding).includes(f.lease.token),false);
  const replay=await interpret(f,outbox,a);assert.equal(replay.dispatched,false);assert.equal(replay.effect.state,'succeeded');assert.equal(calls.length,1);assert.equal(admitted(f).length,1);
});

test('issue-after inbox floor is durable and same-generation restart does not recapture it',async t=>{
  const f=fixture(t,{issue:false}),old=receive(f,'before-issuance');
  const first=issueCapacityGrant({control:f.control,store:f.receiver,grant:f.grant});assert.equal(first.inboxFloor,1);
  const a=await adapter(async()=>assert.fail('An old request must not dispatch'));
  await assert.rejects(interpret(f,old,a),errorCode('CAPACITY_INBOX_FLOOR'));assert.equal(admitted(f).length,0);assert.equal(f.control.status().cells.length,1);
  const fresh=receive(f,'after-issuance');const again=issueCapacityGrant({control:f.control,store:f.receiver,grant:f.grant});assert.deepEqual(again,first);
  const reopened=f.keep(new PeerStore(f.receiverPath,{config:f.pair.b,clock:f.now}));
  const result=await interpret(f,fresh,await adapter(async input=>ready(input)),{store:reopened});assert.equal(result.effect.state,'succeeded');
});

test('closed model arguments and grant profile reject option injection, nonpositive money, mutable image and false native identity',t=>{
  const f=fixture(t,{native:true});
  for (const malformed of [{...request('bad'),image:'attacker'},request('bad',{budgetCents:0}),request('bad',{budgetCents:-1}),request('bad',{role:'coordinator'}),request('bad',{purpose:'x'.repeat(513)})])
    assert.throws(()=>enqueueCapacityRequest({store:f.sender,grant:f.grant,request:malformed,nativeProof}));
  assert.throws(()=>enqueueCapacityRequest({store:f.sender,grant:f.grant,request:request('bad'),nativeProof:{...nativeProof,archiveSha256:'c'.repeat(64)}}),errorCode('CAPACITY_NATIVE'));
  assert.throws(()=>validateCapacityGrant({...f.grant,template:{...f.grant.template,image:'ghcr.io/fixture/native:latest'}}));
  assert.throws(()=>issueCapacityGrant({control:f.control,store:f.receiver,grant:{...f.grant,generation:2}}),errorCode('CAPACITY_GRANT_GENERATION'));
  assert.equal(f.sender.counts().peer_outbox,0);assert.equal(f.control.status().effects.length,0);
});

test('stable request identity binds original input; changed sender input and changed grant policy cannot consume another allocation',async t=>{
  const f=fixture(t),o=receive(f,'permanent');const a=await adapter(async input=>ready(input));
  const original=await interpret(f,o,a);
  assert.throws(()=>enqueueCapacityRequest({store:f.sender,grant:f.grant,request:request('permanent',{budgetCents:400})}),errorCode('CONFLICT'));
  assert.throws(()=>issueCapacityGrant({control:f.control,store:f.receiver,grant:{...f.grant,maxChildren:5}}),errorCode('CONFLICT'));
  assert.equal((await interpret(f,o,a)).effect.key,original.effect.key);assert.equal(admitted(f).length,1);assert.equal(f.paid.snapshot().reservations.length,1);
});

test('operation binding failure rolls back child, bindings, quota and all admission events together',async t=>{
  const specification={taskType:'operation',problem:'A different provision',acceptance:{scope:'recorded-controller-operation-receipts-only'},baseline:'fixture-only',operation:{kind:'provision',cellId:'exact-different-cell',app:'fixture-different-app'}};
  const f=fixture(t,{specification}),o=receive(f,'wrong-operation'),sequence=revision(f);
  await assert.rejects(interpret(f,o,await adapter(async()=>assert.fail('Invalid operation must not dispatch'))),errorCode('OPERATION_BINDING'));
  assert.equal(f.control.status().cells.length,1);assert.equal(f.control.status().effects.length,0);assert.equal(admitted(f).length,0);
  assert.equal(f.control.db.prepare('SELECT count(*) AS n FROM effect_bindings').get().n,0);assert.equal(revision(f),sequence);assert.equal(f.paid.snapshot().reservations.length,0);
});

test('another unresolved task effect rolls back the new reservation without an orphan',async t=>{
  const f=fixture(t),o=receive(f,'blocked');f.control.admitEffect(f.lease,{key:'existing-uncertain',kind:'flow_call',request:{fixture:true}});f.control.startEffect(f.lease,'existing-uncertain');f.control.settleEffect('existing-uncertain','unknown');
  const before=revision(f);
  await assert.rejects(interpret(f,o,await adapter(async()=>assert.fail('Open effect must block'))),errorCode('UNRECONCILED'));
  assert.equal(f.control.status().cells.length,1);assert.equal(admitted(f).length,0);assert.equal(revision(f),before);assert.equal(f.paid.snapshot().reservations.length,0);
});

test('paid refusal is definitely pre-dispatch and keeps logical admission bound without pretending monetary release',async t=>{
  const f=fixture(t,{paidLimit:0}),o=receive(f,'no-paid-room');let calls=0;
  const result=await interpret(f,o,await adapter(async()=>{calls++;throw new Error('Should not be called');}));
  assert.equal(result.dispatched,false);assert.equal(result.effect.state,'not_applied');assert.deepEqual(result.failure,{stage:'pre-dispatch',code:'BUDGET'});assert.equal(calls,0);
  assert.equal(admitted(f).length,1);assert.equal(f.control.status().cells.length,2);assert.equal(f.paid.snapshot().reservations.length,0);
  f.paid.pauseAdmission();const replay=await interpret(f,o,await adapter(async()=>{calls++;}));assert.equal(replay.dispatched,false);assert.equal(replay.effect.state,'not_applied');assert.equal(calls,0);
});

test('pause after paid admission is fenced immediately before provision and retains the started paid hold',async t=>{
  const f=fixture(t),o=receive(f,'pause-boundary');const start=f.paid.start.bind(f.paid);f.paid.start=id=>{const row=start(id);f.control.pause();return row;};let calls=0;
  const result=await interpret(f,o,await adapter(async()=>{calls++;}));
  assert.equal(result.dispatched,false);assert.equal(result.effect.state,'not_applied');assert.equal(result.failure.code,'PAUSED');assert.equal(calls,0);
  assert.equal(f.paid.snapshot().committedCents,1000);assert.equal(f.paid.row(result.paid.reservationId).state,'started');
});

test('current persisted credential rotation fences a live old store and generation-bound grant at the dispatch boundary',async t=>{
  const f=fixture(t),o=receive(f,'rotated-boundary'),start=f.paid.start.bind(f.paid);let calls=0;
  const key=randomBytes(32).toString('base64url'),receiver2={...f.pair.b,generation:2,key},sender2={...f.pair.a,generation:2,key};
  f.paid.start=id=>{const value=start(id);f.keep(new PeerStore(f.receiverPath,{config:receiver2,clock:f.now,rotateFromGeneration:1}));return value;};
  const result=await interpret(f,o,await adapter(async()=>{calls++;}));assert.equal(result.dispatched,false);assert.equal(result.effect.state,'not_applied');assert.equal(result.failure.code,'CREDENTIAL_GENERATION');assert.equal(calls,0);
  const newSender=f.keep(new PeerStore(f.senderPath,{config:sender2,clock:f.now,rotateFromGeneration:1}));
  assert.throws(()=>enqueueCapacityRequest({store:newSender,grant:f.grant,request:request('new-with-old-grant')}),errorCode('CAPACITY_GRANT_GENERATION'));
});

test('new grant generation binds current rotated pair and new inbox floor; prior policy cannot authorize historical inbox data',async t=>{
  const f=fixture(t),old=receive(f,'generation-one'),key=randomBytes(32).toString('base64url');
  const receiver=f.keep(new PeerStore(f.receiverPath,{config:{...f.pair.b,generation:2,key},clock:f.now,rotateFromGeneration:1}));
  const sender=f.keep(new PeerStore(f.senderPath,{config:{...f.pair.a,generation:2,key},clock:f.now,rotateFromGeneration:1}));
  const grant={...f.grant,generation:2},issued=issueCapacityGrant({control:f.control,store:receiver,grant});assert.equal(issued.inboxFloor,1);
  const a=await adapter(async input=>ready(input));
  await assert.rejects(interpret(f,old,a,{store:receiver,grant}),errorCode('CAPACITY_INBOX_FLOOR'));
  await assert.rejects(interpret(f,old,a),errorCode('CREDENTIAL_GENERATION'));
  const fresh=receive(f,'generation-two',{}, {sender,receiver,grant});assert.equal((await interpret(f,fresh,a,{store:receiver,grant})).effect.state,'succeeded');
});

test('expired lease/grant and changed immutable task specification reject before reserving or spending',async t=>{
  const f=fixture(t),o=receive(f,'stale-task'),a=await adapter(async()=>assert.fail('Stale authority must not dispatch'));
  const original=f.control.task('capacity-task').specification;
  f.control.db.prepare('UPDATE tasks SET specification=? WHERE id=?').run(JSON.stringify({...original,baseline:'changed'}),'capacity-task');
  await assert.rejects(interpret(f,o,a),errorCode('CAPACITY_AUTHORITY'));assert.equal(admitted(f).length,0);
  f.control.db.prepare('UPDATE tasks SET specification=? WHERE id=?').run(JSON.stringify(original),'capacity-task');
  f.clock.now=f.lease.expires+1;
  await assert.rejects(interpret(f,o,a),errorCode('CAPACITY_REQUEST_EXPIRED'));assert.equal(f.control.status().cells.length,1);assert.equal(f.paid.snapshot().reservations.length,0);
});

test('accepted, running and unknown records survive reopen and are never dispatched on replay',async t=>{
  const f=fixture(t),o=receive(f,'no-relaunch');let calls=0;
  const input={grantId:f.grant.grantId,generation:1,grantDigest:f.binding.grantDigest,request:request('no-relaunch'),nativeProof:null,messageId:o.messageId,messageDigest:o.digest,inboxSequence:1};
  const accepted=f.control.admitCapacityProvision(f.lease,input);assert.equal(accepted.fresh,true);
  const control=f.keep(new FactoryControl(f.controlPath,{clock:f.now})),receiver=f.keep(new PeerStore(f.receiverPath,{config:f.pair.b,clock:f.now})),a=await adapter(async()=>{calls++;});
  for (const state of ['accepted','running','unknown']) {
    if (state==='running') control.startCapacityProvision(f.lease,{grantId:f.grant.grantId,generation:1,grantDigest:f.binding.grantDigest,key:accepted.effect.key});
    if (state==='unknown') control.settleEffect(accepted.effect.key,'unknown');
    const replay=await interpret(f,o,a,{control,store:receiver});assert.equal(replay.dispatched,false);assert.equal(replay.effect.state,state);
  }
  assert.equal(calls,0);assert.equal(f.paid.snapshot().reservations.length,0);assert.equal(admitted(f).length,1);
});

test('lost adapter response and invalid receipt are unknown; no exception credential escapes and no retry dispatch occurs',async t=>{
  for (const up of [async()=>{throw new Error('never-log-fixture-secret');},async input=>({app:input.app,worker:'foreign-worker',state:'ready'}),
    async input=>({...ready(input),org:'foreign-org'}),async input=>({app:input.app,worker:input.app,state:'ready'})]) {
    const f=fixture(t),o=receive(f,'ambiguous');let calls=0;const a=await adapter(async input=>{calls++;return up(input);});
    const first=await interpret(f,o,a);assert.equal(first.dispatched,true);assert.equal(first.effect.state,'unknown');assert.equal(first.failure.stage,'post-dispatch');
    assert.equal(JSON.stringify(first).includes('never-log-fixture-secret'),false);const replay=await interpret(f,o,a);assert.equal(replay.dispatched,false);assert.equal(replay.effect.state,'unknown');assert.equal(calls,1);
    assert.equal(f.paid.snapshot().committedCents,1000);
  }
});

test('post-dispatch local commit failure observes a later adapter rejection and remains unknown without relaunch',async t=>{
  const f=fixture(t),o=receive(f,'commit-failed');let reject,called=false,calls=0;
  const pending=new Promise((_,r)=>{reject=r;}),transaction=f.paid.transaction.bind(f.paid);
  f.paid.transaction=operation=>{const result=transaction(operation);if (called) throw new Error('Simulated local commit acknowledgement loss');return result;};
  const unhandled=[];const listener=reason=>unhandled.push(reason);process.on('unhandledRejection',listener);t.after(()=>process.off('unhandledRejection',listener));
  const a=await adapter(async()=>{calls++;called=true;return pending;});
  const result=await interpret(f,o,a);assert.equal(result.dispatched,true);assert.equal(result.effect.state,'unknown');
  reject(new Error('never-log-fixture-secret'));await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(unhandled,[]);
  assert.equal((await interpret(f,o,a)).dispatched,false);assert.equal(calls,1);
});

function child(input) {
  const urls=Object.fromEntries(['control','spending','peer-messaging','capacity-bridge','adapters/managed-cloud'].map(name=>[name,new URL('../src/'+name+'.mjs',import.meta.url).href]));
  const code=`import fs from 'node:fs';import {FactoryControl} from ${JSON.stringify(urls.control)};import {SpendingLedger} from ${JSON.stringify(urls.spending)};import {PeerStore} from ${JSON.stringify(urls['peer-messaging'])};import {interpretCapacityRequest} from ${JSON.stringify(urls['capacity-bridge'])};import {createManagedCloudAdapter} from ${JSON.stringify(urls['adapters/managed-cloud'])};
const x=JSON.parse(fs.readFileSync(0,'utf8')),cs=[];let result;
try{const control=new FactoryControl(x.controlPath),paid=new SpendingLedger(x.paidPath),store=new PeerStore(x.receiverPath,{config:x.config});cs.push(control,paid,store);
const adapter=await createManagedCloudAdapter({service:{sources:async()=>[],preflight:async()=>{throw Error('forbidden')},up:async input=>{fs.appendFileSync(x.callsPath,input.app+'\\n');await new Promise(r=>setTimeout(r,80));return{app:input.app,worker:input.app,state:'ready',workspace:input.workspace,org:input.org,region:input.region}},call:async()=>{},list:async()=>[],down:async()=>{}}});result=await interpretCapacityRequest({control,store,grant:x.grant,messageId:x.messageId,adapter,paidAdmission:paid});}catch(error){result={error:error.code??'UNEXPECTED'};}finally{for(const c of cs)c.close();}console.log(JSON.stringify(result));`;
  return new Promise((resolve,reject)=>{
    const processHandle=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='',overflow=false,spawnError=null;
    const timer=setTimeout(()=>{spawnError=new Error('Fixture process exceeded bounded deadline');processHandle.kill();},15000);
    for (const [stream,key] of [[processHandle.stdout,'stdout'],[processHandle.stderr,'stderr']]) stream.on('data',chunk=>{if(key==='stdout')stdout+=chunk;else stderr+=chunk;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>16384){overflow=true;processHandle.kill();}});
    processHandle.on('error',error=>{spawnError=error;});processHandle.on('close',(exit,signal)=>{clearTimeout(timer);if(spawnError||overflow||exit!==0||signal!==null)reject(spawnError??new Error('Fixture child did not close successfully'));else resolve({pid:processHandle.pid,exit,signal,closed:true,result:JSON.parse(stdout.trim())});});
    processHandle.stdin.end(JSON.stringify(input));
  });
}
function childInput(f,o,callsPath) {return {controlPath:f.controlPath,paidPath:f.paidPath,receiverPath:f.receiverPath,config:f.pair.b,grant:f.grant,messageId:o.messageId,callsPath};}

test('two real OS processes replay one original inbox tuple: exactly one provision call, one child, one quota debit and one paid reservation',async t=>{
  const f=fixture(t),o=receive(f,'parallel-duplicate'),callsPath=join(f.directory,'calls.txt');
  const results=await Promise.all([child(childInput(f,o,callsPath)),child(childInput(f,o,callsPath))]);
  assert.notEqual(results[0].pid,results[1].pid);assert.equal(results.every(row=>row.closed&&row.exit===0&&row.signal===null),true);
  assert.equal(results.filter(row=>row.result.dispatched===true).length,1);assert.equal(results.filter(row=>row.result.dispatched===false).length,1);
  assert.equal(readFileSync(callsPath,'utf8').trim().split('\n').length,1);assert.equal(admitted(f).length,1);assert.equal(f.control.status().cells.length,2);assert.equal(f.paid.snapshot().reservations.length,1);
  assert.equal(f.control.effect(capacityMessageId(f.grant.grantId,'parallel-duplicate')).state,'succeeded');
});

test('concurrent distinct requests cannot race through one-child grant or its logical budget quota',async t=>{
  const f=fixture(t,{policy:{maxChildren:1,maxBudgetCents:500}}),one=receive(f,'quota-one'),two=receive(f,'quota-two'),callsPath=join(f.directory,'calls.txt');
  const results=await Promise.all([child(childInput(f,one,callsPath)),child(childInput(f,two,callsPath))]);
  assert.equal(results.filter(row=>row.result.dispatched===true).length,1);assert.equal(results.filter(row=>row.result.error==='CAPACITY_GRANT_QUOTA').length,1);
  assert.equal(admitted(f).length,1);assert.equal(f.control.status().cells.length,2);assert.equal(f.paid.snapshot().reservations.length,1);assert.equal(readFileSync(callsPath,'utf8').trim().split('\n').length,1);
});

test('total grant budgets remain consumed across successful requests and grant generation rotation',async t=>{
  const f=fixture(t,{policy:{maxChildren:3,maxBudgetCents:700}}),first=receive(f,'budget-one'),a=await adapter(async input=>ready(input));
  await interpret(f,first,a);const next=receive(f,'budget-two',{budgetCents:300});
  await assert.rejects(interpret(f,next,a),errorCode('CAPACITY_GRANT_QUOTA'));assert.equal(admitted(f).length,1);
  const key=randomBytes(32).toString('base64url'),receiver=f.keep(new PeerStore(f.receiverPath,{config:{...f.pair.b,generation:2,key},clock:f.now,rotateFromGeneration:1})),sender=f.keep(new PeerStore(f.senderPath,{config:{...f.pair.a,generation:2,key},clock:f.now,rotateFromGeneration:1}));
  const grant={...f.grant,generation:2};issueCapacityGrant({control:f.control,store:receiver,grant});
  const afterRotation=receive(f,'budget-three',{budgetCents:300},{receiver,sender,grant});
  await assert.rejects(interpret(f,afterRotation,a,{store:receiver,grant}),errorCode('CAPACITY_GRANT_QUOTA'));assert.equal(admitted(f).length,1);assert.equal(f.control.status().cells.length,2);
});

test('independent controllers with the same local labels cannot share one paid hold for different admitted apps',async t=>{
  const one=fixture(t),two=fixture(t,{issue:false});
  two.grant.template={...two.grant.template,appPrefix:'other-fixture',org:'other-org'};
  issueCapacityGrant({control:two.control,store:two.receiver,grant:two.grant});
  const first=receive(one,'same-local-request'),second=receive(two,'same-local-request'),calls=[];
  const a=await adapter(async input=>{calls.push(input);return ready(input);});
  const resultOne=await interpret(one,first,a),resultTwo=await interpret(two,second,a,{paidAdmission:one.paid});
  assert.equal(resultOne.dispatched,true);assert.equal(resultTwo.dispatched,true);assert.notEqual(resultOne.app,resultTwo.app);
  assert.equal(resultOne.effect.key,resultTwo.effect.key);assert.notEqual(resultOne.paid.reservationId,resultTwo.paid.reservationId);
  assert.equal(one.paid.snapshot().reservations.length,2);assert.equal(one.paid.snapshot().committedCents,2000);assert.equal(calls.length,2);
  assert.equal((await interpret(two,second,a,{paidAdmission:one.paid})).dispatched,false);assert.equal(calls.length,2);
});
