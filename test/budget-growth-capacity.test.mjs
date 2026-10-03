import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FactoryControl, digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { PeerStore, createPairConfigurations, requestHeaders, verifyRequest } from '../src/peer-messaging.mjs';
import { validateCapacityGrant, issueCapacityGrant, enqueueCapacityRequest, interpretCapacityRequest } from '../src/capacity-bridge.mjs';

const image='ghcr.io/fixture/native@sha256:'+'a'.repeat(64);
const code=expected=>error=>error?.code===expected;
function fixture(t,{budgetCents=20,paidLimit=20,legacy=false,controller={},policy={},issue=true}={}) {
  const directory=mkdtempSync(join(tmpdir(),'factory-budget-capacity-'));
  const connections=[],clock={now:Date.now()},now=()=>clock.now;
  const keep=value=>{connections.push(value);return value;};
  const control=keep(new FactoryControl(join(directory,'control.sqlite'),{clock:now}));
  control.initialize(legacy?{mission:'Finite fixture growth',budgetCents,maxCells:20,maxDepth:2,...controller}
    :{schemaVersion:2,mission:'Budget-only fixture growth',budgetCents,growthMode:'budget-only',maxCells:null,maxDepth:null,...controller});
  control.createTask({taskId:'capacity-task',projectId:'fixture',branch:'codex/budget-growth',
    specification:{problem:'Develop admitted fixture branches',acceptance:'Owned fixture provision receipt',baseline:'fixture-only'}});
  const lease=control.claimTask('capacity-task','root',600000);
  const paid=keep(new SpendingLedger(join(directory,'paid.sqlite'),{clock:now}));paid.initialize({limitCents:paidLimit,currency:'USD'});
  const pair=createPairConfigurations({a:{identity:{factoryId:'fixture-factory',cellId:'root'},endpoint:'http://127.0.0.1:46101/v1/peer/messages'},
    b:{identity:{factoryId:'fixture-factory',cellId:'broker'},endpoint:'http://127.0.0.1:46102/v1/peer/messages'},credentialExpiresAt:clock.now+3600000});
  const senderPath=join(directory,'sender.sqlite'),receiverPath=join(directory,'receiver.sqlite');
  const sender=keep(new PeerStore(senderPath,{config:pair.a,clock:now})),receiver=keep(new PeerStore(receiverPath,{config:pair.b,clock:now}));
  const grant={schemaVersion:2,growthMode:'budget-only',grantId:'budget-grant',generation:1,lease,expiresAt:lease.expires,
    maxChildren:null,maxBudgetCents:10,allowedRoles:['developer'],
    template:{source:'http://127.0.0.1:46103',workspace:'fixture',image,org:'fixture-org',region:'iad',appPrefix:'fixture-budget',flowIds:['fixture-flow']},
    paid:{provider:'fly',ceilingCents:2},...policy};
  const binding=issue?issueCapacityGrant({control,store:receiver,grant}):null;
  t.after(()=>{
    for (const connection of connections.reverse()) { try { connection.close(); } catch {} }
    const target=resolve(directory),temporary=resolve(tmpdir());
    assert.ok(target.startsWith(temporary+sep) && target!==temporary);
    rmSync(target,{recursive:true,force:true});
  });
  return {directory,clock,now,keep,control,paid,pair,sender,receiver,senderPath,receiverPath,lease,grant,binding};
}
function legacyGrant(grant,overrides={}) {const {growthMode,...rest}=grant;return {...rest,schemaVersion:1,maxChildren:4,...overrides};}
function receive(f,requestId,budgetCents=1,{grant=f.grant,sender=f.sender,receiver=f.receiver}={}) {
  const outbox=enqueueCapacityRequest({store:sender,grant,request:{requestId,role:'developer',budgetCents,purpose:'Develop the admitted fixture branch'}});
  const envelope=verifyRequest(receiver.config,outbox.body,requestHeaders(sender.config,outbox.body,f.now()),f.now());
  receiver.receiveEnvelope(envelope);return outbox;
}
function interpret(f,outbox,adapter,{grant=f.grant,store=f.receiver,paidAdmission=f.paid}={}) {
  return interpretCapacityRequest({control:f.control,store,grant,messageId:outbox.messageId,adapter,paidAdmission});
}
function countingAdapter() {
  const calls=[];
  return {calls,async provision(input){calls.push(input);return {app:input.app,worker:input.app,state:'ready',workspace:input.workspace,org:input.org,region:input.region};}};
}
function admitted(f) {
  return f.control.db.prepare("SELECT details FROM events WHERE type='capacity_admitted' AND subject=?").all(f.grant.grantId).map(row=>JSON.parse(row.details));
}
function counts(f) {
  return {cells:f.control.db.prepare('SELECT count(*) AS n FROM cells').get().n,
    effects:f.control.db.prepare('SELECT count(*) AS n FROM effects').get().n,admissions:admitted(f).length,
    reservations:f.paid.snapshot().reservations.length};
}
function rotate(f,generation=2) {
  const key=randomBytes(32).toString('base64url');
  const sender=f.keep(new PeerStore(f.senderPath,{config:{...f.pair.a,generation,key},clock:f.now,rotateFromGeneration:generation-1}));
  const receiver=f.keep(new PeerStore(f.receiverPath,{config:{...f.pair.b,generation,key},clock:f.now,rotateFromGeneration:generation-1}));
  return {sender,receiver,grant:{...f.grant,generation}};
}

test('budget-only grants are exact, normalized and require explicit controller authority',t=>{
  const f=fixture(t,{issue:false});
  const normalized=validateCapacityGrant(f.grant);
  assert.equal(normalized.native,null);assert.equal(normalized.growthMode,'budget-only');assert.equal(normalized.maxChildren,null);
  const malformed=[{...f.grant,maxChildren:1001},{...f.grant,maxChildren:1},{...f.grant,growthMode:'unlimited'},
    {...f.grant,extra:true},Object.fromEntries(Object.entries(f.grant).filter(([key])=>key!=='growthMode'))];
  for (const grant of malformed) assert.throws(()=>validateCapacityGrant(grant),code('CAPACITY_INVALID'));
  const finite=legacyGrant(f.grant,{maxChildren:1000});assert.equal(validateCapacityGrant(finite).maxChildren,1000);
  for (const grant of [{...finite,maxChildren:1001},{...finite,maxChildren:null},{...finite,growthMode:'budget-only'}])
    assert.throws(()=>validateCapacityGrant(grant),code('CAPACITY_INVALID'));
  const legacy=fixture(t,{legacy:true,issue:false}),before=counts(legacy);
  assert.throws(()=>issueCapacityGrant({control:legacy.control,store:legacy.receiver,grant:legacy.grant}),code('CAPACITY_AUTHORITY'));
  assert.equal(legacy.control.capacityGrant(legacy.grant.grantId),null);assert.deepEqual(counts(legacy),before);
});

test('1001 authenticated budget-only admissions preserve logical allocation and real shared paid holds',{timeout:240000},async t=>{
  const f=fixture(t,{budgetCents:1400,paidLimit:1400,policy:{maxBudgetCents:1200,paid:{provider:'fly',ceilingCents:1}}}),adapter=countingAdapter();
  assert.equal(f.binding.schemaVersion,2);assert.equal(f.binding.policy.schemaVersion,2);
  assert.equal(f.binding.policy.maxChildren,null);assert.equal(f.binding.policy.growthMode,'budget-only');
  for (let index=0;index<1001;index++) {
    const outbox=receive(f,'branch-'+index),result=await interpret(f,outbox,adapter);
    assert.equal(outbox.envelope.payload.schemaVersion,1);assert.equal(result.effect.state,'succeeded');assert.equal(result.dispatched,true);
  }
  assert.equal(adapter.calls.length,1001);assert.equal(new Set(adapter.calls.map(input=>input.cellId)).size,1001);
  assert.deepEqual(counts(f),{cells:1002,effects:1001,admissions:1001,reservations:1001});
  const allocation=f.control.db.prepare("SELECT sum(allocation) AS cents FROM cells WHERE parent_id='root'").get().cents;
  const quota=admitted(f).reduce((sum,item)=>sum+item.request.budgetCents,0),paid=f.paid.snapshot();
  assert.equal(allocation,1001);assert.equal(quota,1001);assert.equal(paid.committedCents,1001);assert.equal(paid.unallocatedCents,399);
  assert.ok(paid.reservations.every(row=>row.state==='started'));assert.equal(f.control.control().policy.maxCells,null);
});

test('grant lifetime money survives credential generations and rejects an over-budget request atomically',async t=>{
  const f=fixture(t,{policy:{maxBudgetCents:3}}),adapter=countingAdapter();
  const original=await interpret(f,receive(f,'generation-one',2),adapter);assert.equal(original.effect.state,'succeeded');
  const next=rotate(f);issueCapacityGrant({control:f.control,store:next.receiver,grant:next.grant});
  const before=counts(f),refused=receive(f,'generation-two-too-large',2,next);
  await assert.rejects(interpret(f,refused,adapter,{grant:next.grant,store:next.receiver}),code('CAPACITY_GRANT_QUOTA'));
  assert.deepEqual(counts(f),before);assert.equal(adapter.calls.length,1);
  const allowed=await interpret(f,receive(f,'generation-two-remainder',1,next),adapter,{grant:next.grant,store:next.receiver});
  assert.equal(allowed.effect.state,'succeeded');assert.equal(adapter.calls.length,2);
  await assert.rejects(interpret(f,receive(f,'generation-two-exhausted',1,next),adapter,{grant:next.grant,store:next.receiver}),code('CAPACITY_GRANT_QUOTA'));
  assert.deepEqual(admitted(f).map(row=>row.generation),[1,2]);
  assert.equal(admitted(f).reduce((sum,row)=>sum+row.request.budgetCents,0),3);assert.equal(f.paid.snapshot().committedCents,4);
});

test('budget-only grant size cannot exceed its parent allocation',async t=>{
  const f=fixture(t,{budgetCents:3,policy:{maxBudgetCents:10}}),adapter=countingAdapter();
  assert.equal((await interpret(f,receive(f,'parent-allocated',2),adapter)).effect.state,'succeeded');
  const before=counts(f);
  await assert.rejects(interpret(f,receive(f,'parent-overdraft',2),adapter),code('BUDGET'));
  assert.deepEqual(counts(f),before);assert.equal(adapter.calls.length,1);
  assert.equal(f.control.db.prepare("SELECT sum(allocation) AS n FROM cells WHERE parent_id='root'").get().n,2);
});

test('schema1 grant count and legacy factory count/depth stay finite',async t=>{
  const bounded=fixture(t,{issue:false});bounded.grant=legacyGrant(bounded.grant,{maxChildren:1});
  issueCapacityGrant({control:bounded.control,store:bounded.receiver,grant:bounded.grant});const adapter=countingAdapter();
  await interpret(bounded,receive(bounded,'finite-first'),adapter);
  await assert.rejects(interpret(bounded,receive(bounded,'finite-second'),adapter),code('CAPACITY_GRANT_QUOTA'));
  assert.equal(adapter.calls.length,1);assert.equal(bounded.control.control().policy.schemaVersion,2);
  const legacy=fixture(t,{legacy:true,controller:{maxCells:2},issue:false});legacy.grant=legacyGrant(legacy.grant,{maxChildren:1000});
  issueCapacityGrant({control:legacy.control,store:legacy.receiver,grant:legacy.grant});const legacyAdapter=countingAdapter();
  await interpret(legacy,receive(legacy,'last-count-slot'),legacyAdapter);
  await assert.rejects(interpret(legacy,receive(legacy,'no-count-slot'),legacyAdapter),code('CAPACITY'));
  assert.equal(legacyAdapter.calls.length,1);assert.equal(counts(legacy).cells,2);
  const depth=fixture(t,{legacy:true,controller:{maxDepth:1},issue:false});
  depth.control.reserveCell({cellId:'first-depth',parentId:'root',role:'developer',budgetCents:5,purpose:'Finite depth fixture'});
  assert.throws(()=>depth.control.reserveCell({cellId:'second-depth',parentId:'first-depth',role:'developer',budgetCents:1,purpose:'Would exceed finite depth'}),code('CAPACITY'));
  assert.equal(counts(depth).cells,2);
});

test('one fully held paid ledger fences two budget-only controllers and exact replays never dispatch',async t=>{
  const a=fixture(t,{paidLimit:7}),b=fixture(t),adapter=countingAdapter();
  a.paid.reserve({reservationId:'shared-held',provider:'fly',ceilingCents:7});a.paid.start('shared-held');
  const paidBefore=a.paid.snapshot(),paidEvents=a.paid.db.prepare('SELECT count(*) AS n FROM spending_events').get().n;
  for (const f of [a,b]) {
    const outbox=receive(f,'no-shared-paid-room'),first=await interpret(f,outbox,adapter,{paidAdmission:a.paid});
    assert.equal(first.dispatched,false);assert.equal(first.effect.state,'not_applied');assert.deepEqual(first.failure,{stage:'pre-dispatch',code:'BUDGET'});
    const replay=await interpret(f,outbox,adapter,{paidAdmission:a.paid});
    assert.equal(replay.effect.key,first.effect.key);assert.equal(replay.effect.state,'not_applied');assert.equal(replay.dispatched,false);
    assert.equal(admitted(f).length,1);assert.equal(counts(f).cells,2);
  }
  assert.equal(adapter.calls.length,0);assert.deepEqual(a.paid.snapshot(),paidBefore);
  assert.equal(a.paid.db.prepare('SELECT count(*) AS n FROM spending_events').get().n,paidEvents);
  assert.equal(a.paid.snapshot().unallocatedCents,0);assert.equal(b.paid.snapshot().committedCents,0);
});

test('unknown dispatch retains its paid hold and lifetime grant debit through replay and rotation',async t=>{
  const f=fixture(t,{paidLimit:1,policy:{maxBudgetCents:1,paid:{provider:'fly',ceilingCents:1}}});let calls=0;
  const adapter={async provision(){calls++;throw new Error('Fixture response lost');}},outbox=receive(f,'uncertain');
  const original=await interpret(f,outbox,adapter);assert.equal(original.effect.state,'unknown');assert.equal(original.dispatched,true);
  assert.equal((await interpret(f,outbox,adapter)).dispatched,false);assert.equal(calls,1);
  const before=f.paid.snapshot(),paidEvents=f.paid.db.prepare('SELECT count(*) AS n FROM spending_events').get().n;
  assert.throws(()=>f.paid.cancel(original.paid.reservationId),code('STATE'));
  assert.throws(()=>f.paid.settle(original.paid.reservationId,{finalCents:0,evidenceDigest:'f'.repeat(64)}),code('STATE'));
  assert.deepEqual(f.paid.snapshot(),before);assert.equal(before.committedCents,1);assert.equal(before.unallocatedCents,0);
  const next=rotate(f);issueCapacityGrant({control:f.control,store:next.receiver,grant:next.grant});
  await assert.rejects(interpret(f,receive(f,'uncertainty-not-a-refund',1,next),adapter,{grant:next.grant,store:next.receiver}),code('CAPACITY_GRANT_QUOTA'));
  assert.equal(calls,1);assert.equal(admitted(f).length,1);assert.deepEqual(f.paid.snapshot(),before);
  assert.equal(f.paid.db.prepare('SELECT count(*) AS n FROM spending_events').get().n,paidEvents);
});

test('outer schema, caller downgrade and generation mode flips cannot relax durable grant authority',async t=>{
  const f=fixture(t),adapter=countingAdapter(),outbox=receive(f,'schema-bound');
  const {grantDigest,...binding}=f.binding,wrong={...binding,schemaVersion:1};
  assert.throws(()=>f.control.issueCapacityGrant(f.lease,{...wrong,grantDigest:digest(wrong)}),code('CAPACITY_GRANT'));
  await assert.rejects(interpret(f,outbox,adapter,{grant:legacyGrant(f.grant)}),code('CAPACITY_GRANT_GENERATION'));
  assert.equal(adapter.calls.length,0);assert.equal(admitted(f).length,0);
  const next=rotate(f);
  assert.throws(()=>issueCapacityGrant({control:f.control,store:next.receiver,grant:legacyGrant(next.grant)}),code('CONFLICT'));
  const retained=f.control.capacityGrant(f.grant.grantId);
  assert.equal(retained.schemaVersion,2);assert.equal(retained.policy.generation,1);assert.equal(retained.grantDigest,grantDigest);
});
