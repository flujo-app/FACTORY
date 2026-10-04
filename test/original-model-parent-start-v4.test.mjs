import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginalModelStepJournal, initializeOriginalModelParentStartSchema4 } from '../src/original-model-step-journal.mjs';
import { guardedModelStepMutation, modelParentStartWitness } from '../src/model-step-contract.mjs';
import { fixture } from './fixtures/original-model-parent-start-v4-fixture.mjs';

const denied=(fn,code)=>assert.throws(fn,error=>error.code===code);
const rejected=(fn,code)=>assert.rejects(fn,error=>error.code===code);
const starts=f=>f.control.db.prepare('SELECT * FROM model_parent_starts').all();
const children=f=>f.control.db.prepare("SELECT * FROM effects WHERE kind='model_step'").all();
const childKey=f=>'model.'+f.records[0].call.requestId;
const start=f=>f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{});
const releaseGate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};};

test('schema3 retains its existing registration and claim API without parent entry mode',async t=>{
  const f=await fixture(t,{schema4:false,parentRunning:true,register:true});
  assert.equal(f.control.db.prepare('PRAGMA user_version').get().user_version,3);
  assert.equal(f.journal.claim(f.lease,f.capabilities[0]).fresh,true);
  assert.equal(f.journal.claim(f.lease,f.capabilities[0]).observationOnly,true);
  await rejected(()=>start(f),'MODEL_PARENT_SCHEMA4_REQUIRED');
});

test('schema4 initialization is explicit and never migrates a schema3 database',async t=>{
  const f=await fixture(t,{schema4:false});
  denied(()=>initializeOriginalModelParentStartSchema4(f.control,{mode:'trusted-fixture-only'}),'MODEL_PARENT_SCHEMA4_INITIALIZATION_REQUIRED');
  denied(()=>initializeOriginalModelParentStartSchema4(f.control,{mode:'production'}),'MODEL_PARENT_FIXTURE_MODE_REQUIRED');
  assert.equal(f.control.db.prepare('PRAGMA user_version').get().user_version,3);
});

test('schema4 reopened exact schema and initializer observation preserve native HOLD',async t=>{
  const f=await fixture(t);
  f.reopen();
  assert.equal(initializeOriginalModelParentStartSchema4(f.control,{mode:'trusted-fixture-only'}).fresh,false);
  denied(()=>f.control.startNativeMissionEffect(f.lease,f.parentKey,()=>{throw new Error('must not enter');}),'ORIGINAL_MODEL_STEP_RUNTIME_HOLD');
  assert.equal(f.journal.observeParent(f.capabilities[0]).state,'accepted');
});

test('committed witness and running state precede entry and every fresh child issue',async t=>{
  const f=await fixture(t);let entries=0;
  const outcome=await f.journal.withParentStart(f.lease,f.capabilities[0],async parentStart=>{
    entries++;
    assert.equal(f.control.effect(f.parentKey).state,'running');assert.equal(starts(f).length,1);assert.equal(children(f).length,0);
    const s=starts(f)[0];assert.equal(JSON.parse(s.witness_json).mode,'trusted-fixture-only');
    assert.equal(f.control.db.prepare('SELECT factory_model_parent_start_guard(?,?,?) AS allowed').get(f.parentKey,s.witness_json,'insert').allowed,0);
    assert.equal(f.journal.register(f.lease,f.capabilities[0],{parentStart}).fresh,true);
    assert.equal(f.journal.claim(f.lease,f.capabilities[0],{parentStart}).fresh,true);
    return {status:'completed'}; // An unqualified callback return is not delivery.
  });
  assert.equal(outcome.kind,'fresh');assert.equal(entries,1);
  assert.equal(outcome.parent.state,'unknown');assert.equal(outcome.parent.runtimeAdmission,'HOLD');
  assert.equal(f.control.effect(childKey(f)).state,'running');assert.equal(starts(f).length,1);
});

test('pre-model failure with zero children retains start and refuses never-dispatched abort',async t=>{
  const f=await fixture(t);const error=new Error('owned pre-model failure');
  await assert.rejects(()=>f.journal.withParentStart(f.lease,f.capabilities[0],()=>{throw error;}),e=>e===error);
  assert.equal(children(f).length,0);assert.equal(starts(f).length,1);assert.equal(f.control.effect(f.parentKey).state,'unknown');
  denied(()=>f.journal.abortNeverDispatched(f.capabilities[0]),'MODEL_PARENT_ALREADY_STARTED');
  let entries=0;const observed=await f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;});
  assert.equal(observed.kind,'observation');assert.equal(entries,0);
});

test('unqualified callback return closes lifetime and preserves unknown with zero children',async t=>{
  const f=await fixture(t);let escaped;
  await f.journal.withParentStart(f.lease,f.capabilities[0],async parentStart=>{escaped=parentStart;return 'not an execution receipt';});
  assert.equal(f.journal.observeParent(f.capabilities[0]).state,'unknown');assert.equal(children(f).length,0);
  denied(()=>f.journal.register(f.lease,f.capabilities[0],{parentStart:escaped}),'MODEL_PARENT_LIFETIME_REQUIRED');
  denied(()=>f.journal.abortNeverDispatched(f.capabilities[0]),'MODEL_PARENT_ALREADY_STARTED');
});

test('two independent SQLite connections allow one entry and an observation-only competing starter',async t=>{
  const f=await fixture(t);const sibling=f.openSibling();const gate=releaseGate();let entries=0;let freshHandle;
  const first=f.journal.withParentStart(f.lease,f.capabilities[0],async handle=>{entries++;freshHandle=handle;await gate.promise;});
  assert.equal(entries,1);
  const other=await sibling.journal.withParentStart(f.lease,sibling.capabilities[0],async()=>{entries++;});
  assert.equal(other.kind,'observation');assert.equal(entries,1);
  denied(()=>sibling.journal.register(f.lease,sibling.capabilities[0],{parentStart:freshHandle}),'MODEL_PARENT_LIFETIME_REQUIRED');
  gate.release();await first;assert.equal(starts(f).length,1);
});

test('reopened starter observes after OFF expiry paid pause and generation change without entry',async t=>{
  const f=await fixture(t);await start(f);
  const witness=starts(f)[0].witness_json;
  f.control.pause();f.paid.pauseAdmission();f.advance(600001);f.setGeneration('fixture-generation-2');f.reopen();
  let entries=0;const before=f.generationReads;
  const result=await f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;});
  assert.equal(result.kind,'observation');assert.equal(result.parent.state,'unknown');assert.equal(entries,0);
  assert.equal(f.generationReads,before);assert.equal(starts(f)[0].witness_json,witness);
});

test('fresh register and claim reject missing forged and escaped lifetime handles',async t=>{
  const f=await fixture(t);let escaped;
  denied(()=>f.journal.register(f.lease,f.capabilities[0]),'MODEL_PARENT_LIFETIME_REQUIRED');
  await f.journal.withParentStart(f.lease,f.capabilities[0],async parentStart=>{
    escaped=parentStart;
    denied(()=>f.journal.register(f.lease,f.capabilities[0],{parentStart:{}}),'MODEL_PARENT_LIFETIME_REQUIRED');
    f.journal.register(f.lease,f.capabilities[0],{parentStart});
    denied(()=>f.journal.claim(f.lease,f.capabilities[0]),'MODEL_PARENT_LIFETIME_REQUIRED');
    denied(()=>f.journal.claim(f.lease,f.capabilities[0],{parentStart:{}}),'MODEL_PARENT_LIFETIME_REQUIRED');
  });
  denied(()=>f.journal.claim(f.lease,f.capabilities[0],{parentStart:escaped}),'MODEL_PARENT_LIFETIME_REQUIRED');
  assert.equal(f.control.effect(childKey(f)).state,'accepted');
});

test('pure witness construction and generic mutation cannot manufacture a parent start',async t=>{
  const f=await fixture(t);
  const w=modelParentStartWitness(f.records[0],{generation:'fixture-generation-1',startNonce:'a'.repeat(64),chargedCents:null,overCommittedCents:0,admittedAt:f.control.clock()});
  const insert=()=>f.control.db.prepare('INSERT INTO model_parent_starts(parent_key,enrollment_envelope_sha256,envelope_json,start_nonce,generation,witness_json,witness_sha256,admitted_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(w.parent_key,w.enrollment_envelope_sha256,w.envelope_json,w.start_nonce,w.generation,w.witness_json,w.witness_sha256,w.admitted_at);
  assert.throws(insert,/dedicated parent start required/);
  assert.throws(()=>guardedModelStepMutation(f.control,insert),/dedicated parent start required/);
  assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='running' WHERE key=?").run(f.parentKey),/coherent parent start required/);
  assert.throws(()=>guardedModelStepMutation(f.control,()=>f.control.db.prepare("UPDATE effects SET state='running' WHERE key=?").run(f.parentKey)),/coherent parent start required/);
  assert.equal(starts(f).length,0);assert.equal(f.control.effect(f.parentKey).state,'accepted');
});

test('started witness is immutable and raw SQL cannot restore accepted or not_applied',async t=>{
  const f=await fixture(t);await start(f);const original=starts(f)[0];
  assert.throws(()=>f.control.db.prepare('DELETE FROM model_parent_starts').run(),/immutable parent start/);
  assert.throws(()=>f.control.db.prepare("UPDATE model_parent_starts SET generation='forged'").run(),/immutable parent start/);
  for(const state of ['accepted','not_applied'])assert.throws(()=>f.control.db.prepare('UPDATE effects SET state=? WHERE key=?').run(state,f.parentKey),/invalid started parent transition|required model steps unresolved/);
  assert.throws(()=>f.control.db.prepare('INSERT INTO model_step_aborts VALUES(?,?,?,?,?,?)').run(f.parentKey,f.records[0].task.specDigest,'1'.repeat(64),'2'.repeat(64),'{}',f.control.clock()),/started parent cannot be aborted/);
  assert.deepEqual(starts(f)[0],original);assert.equal(f.control.effect(f.parentKey).state,'unknown');
});

test('final factory OFF after committed start prevents callback and retains unknown',async t=>{
  const f=await fixture(t);let entries=0;
  f.setGenerationReader(count=>{if(count===2)f.control.pause();return 'fixture-generation-1';});
  await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;}),'PAUSED');
  assert.equal(entries,0);assert.equal(starts(f).length,1);assert.equal(f.control.effect(f.parentKey).state,'unknown');
  assert.equal(f.control.control().status,'paused');assert.equal(f.journal.observeParent(f.capabilities[0]).state,'unknown');
});

test('final lease loss after committed start prevents callback and retains unknown',async t=>{
  const f=await fixture(t);let entries=0;
  f.setGenerationReader(count=>{if(count===2)f.advance(600001);return 'fixture-generation-1';});
  await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;}),'STALE');
  assert.equal(entries,0);assert.equal(starts(f).length,1);assert.equal(f.control.effect(f.parentKey).state,'unknown');
});

test('final generation loss after committed start prevents callback and retains unknown',async t=>{
  const f=await fixture(t);let entries=0;
  f.setGenerationReader(count=>count===1?'fixture-generation-1':'fixture-generation-2');
  await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;}),'MODEL_PARENT_GENERATION_CHANGED');
  assert.equal(entries,0);assert.equal(starts(f).length,1);assert.equal(f.control.effect(f.parentKey).state,'unknown');
});

test('final paid pause after committed start prevents callback and retains unknown',async t=>{
  const f=await fixture(t);let entries=0;
  f.setGenerationReader(count=>{if(count===2)f.paid.pauseAdmission();return 'fixture-generation-1';});
  await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;}),'PAUSED');
  assert.equal(entries,0);assert.equal(starts(f).length,1);assert.equal(f.control.effect(f.parentKey).state,'unknown');
});

test('initial OFF lease or generation failure creates no start witness or callback',async t=>{
  for(const [scenario,code]of[['off','PAUSED'],['lease','STALE'],['generation','MODEL_PARENT_GENERATION_CHANGED']]){
    const f=await fixture(t);let entries=0;
    if(scenario==='off')f.control.pause();else if(scenario==='lease')f.advance(600001);else f.setGeneration('fixture-generation-2');
    await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;}),code);
    assert.equal(entries,0);assert.equal(starts(f).length,0);assert.equal(f.control.effect(f.parentKey).state,'accepted');
  }
});

test('fresh child mutation rechecks generation within the active callback lifetime',async t=>{
  const f=await fixture(t);
  await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],async parentStart=>{
    f.setGeneration('fixture-generation-2');f.journal.register(f.lease,f.capabilities[0],{parentStart});
  }),'MODEL_PARENT_GENERATION_CHANGED');
  assert.equal(children(f).length,0);assert.equal(f.control.effect(f.parentKey).state,'unknown');
});

test('already claimed child and parent remain observation-only after OFF and expiry',async t=>{
  const f=await fixture(t);
  await f.journal.withParentStart(f.lease,f.capabilities[0],async parentStart=>{
    f.journal.register(f.lease,f.capabilities[0],{parentStart});f.journal.claim(f.lease,f.capabilities[0],{parentStart});
    f.control.pause();f.advance(600001);f.setGeneration('fixture-generation-2');
    assert.equal(f.journal.claim(f.lease,f.capabilities[0]).observationOnly,true);
    assert.equal(f.journal.observe(f.capabilities[0]).state,'running');
    f.journal.settle(f.capabilities[0],'unknown',{state:'synthetic observation'});
  });
  assert.equal(f.journal.observeParent(f.capabilities[0]).state,'unknown');assert.equal(starts(f).length,1);
  let entries=0;assert.equal((await f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;})).kind,'observation');assert.equal(entries,0);
});

test('pre-entry whole-plan abort remains supported and later start only observes',async t=>{
  const f=await fixture(t);
  assert.equal(f.journal.abortNeverDispatched(f.capabilities[0]).state,'not_applied');
  assert.equal(starts(f).length,0);let entries=0;
  assert.equal((await f.journal.withParentStart(f.lease,f.capabilities[0],async()=>{entries++;})).kind,'observation');
  assert.equal(entries,0);assert.equal(f.journal.observeParent(f.capabilities[0]).state,'not_applied');
});

test('explicit parent completion requires coherent start and all successful child slots',async t=>{
  const f=await fixture(t,{slots:2});
  await f.journal.withParentStart(f.lease,f.capabilities[0],async parentStart=>{
    denied(()=>f.control.settleEffect(f.parentKey,'succeeded',{state:'premature'}),'MODEL_STEP_UNRESOLVED');
    for(const capability of f.capabilities){f.journal.register(f.lease,capability,{parentStart});f.journal.claim(f.lease,capability,{parentStart});f.journal.settle(capability,'succeeded',{state:'synthetic observed'});}
    f.control.settleEffect(f.parentKey,'succeeded',{state:'synthetic explicit completion'});
  });
  assert.equal(f.journal.observeParent(f.capabilities[0]).state,'succeeded');assert.equal(starts(f).length,1);
});

test('schema4 without configured fixture entry mode can observe but cannot enter',async t=>{
  const f=await fixture(t);
  const observer=new OriginalModelStepJournal({control:f.control,paidAdmission:f.paid,bootstrap:f.host.bootstrap,compareReceiver:f.host.compareReceiver});
  assert.equal(observer.observeParent(f.capabilities[0]).state,'accepted');
  await rejected(()=>observer.withParentStart(f.lease,f.capabilities[0],async()=>{}),'MODEL_PARENT_FIXTURE_MODE_REQUIRED');
  assert.equal(starts(f).length,0);
});

test('synchronous callback return revokes before queued fresh register and claim',async t=>{
  const f=await fixture(t,{slots:2});let microtaskRan=false;const failures=[];
  const pending=f.journal.withParentStart(f.lease,f.capabilities[0],parentStart=>{
    f.journal.register(f.lease,f.capabilities[1],{parentStart});
    queueMicrotask(()=>{
      microtaskRan=true;
      assert.equal(f.control.effect(f.parentKey).state,'unknown');
      for(const action of [()=>f.journal.register(f.lease,f.capabilities[0],{parentStart}),()=>f.journal.claim(f.lease,f.capabilities[1],{parentStart})]){
        try{action();failures.push('unexpected success');}catch(error){failures.push(error.code);}
      }
    });
    return 'ordinary synchronous result';
  });
  // The async method returns its Promise only after synchronous retirement.
  assert.equal(f.control.effect(f.parentKey).state,'unknown');assert.equal(microtaskRan,false);
  await pending;
  assert.equal(microtaskRan,true);assert.deepEqual(failures,['MODEL_PARENT_LIFETIME_REQUIRED','MODEL_PARENT_LIFETIME_REQUIRED']);
  assert.equal(children(f).length,1);assert.equal(f.control.effect('model.'+f.records[1].call.requestId).state,'accepted');
  assert.equal(f.control.db.prepare('SELECT COUNT(*) AS total FROM model_step_claims').get().total,0);
});

test('retained thenable result is a synchronous value and cannot reactivate issuance',async t=>{
  const f=await fixture(t);let invoked=0,escaped;
  const thenable={then(resolve){invoked++;denied(()=>f.journal.register(f.lease,f.capabilities[0],{parentStart:escaped}),'MODEL_PARENT_LIFETIME_REQUIRED');resolve('manual thenable result');}};
  const outcome=await f.journal.withParentStart(f.lease,f.capabilities[0],parentStart=>{escaped=parentStart;return thenable;});
  assert.equal(outcome.value,thenable);assert.equal(invoked,0);assert.equal(f.control.effect(f.parentKey).state,'unknown');
  outcome.value.then(value=>assert.equal(value,'manual thenable result'));
  assert.equal(invoked,1);assert.equal(children(f).length,0);assert.equal(f.control.db.prepare('SELECT COUNT(*) AS total FROM model_step_claims').get().total,0);
});

async function assertRetainedStartNoReentry(f,ownNonce){
  assert.match(ownNonce,/^[a-f0-9]{64}$/);assert.equal(starts(f).length,1);assert.equal(starts(f)[0].start_nonce,ownNonce);
  assert.equal(f.control.effect(f.parentKey).state,'unknown');assert.equal(children(f).length,0);
  let entries=0;
  assert.equal((await f.journal.withParentStart(f.lease,f.capabilities[0],()=>{entries++;})).kind,'observation');
  f.reopen();assert.equal((await f.journal.withParentStart(f.lease,f.capabilities[0],()=>{entries++;})).kind,'observation');
  assert.equal(entries,0);assert.equal(starts(f)[0].start_nonce,ownNonce);assert.equal(f.control.effect(f.parentKey).state,'unknown');
}

test('successful control COMMIT followed by acknowledgment failure preserves causality and own start',async t=>{
  const f=await fixture(t);const acknowledgment=new Error('synthetic post-control-COMMIT acknowledgment loss');let armed=true,ownNonce,entries=0,rollbackFailures=0;
  const actualExec=f.control.db.exec.bind(f.control.db);
  f.control.db.exec=sql=>{
    try{actualExec(sql);}catch(error){if(sql==='ROLLBACK')rollbackFailures++;throw error;}
    if(sql==='COMMIT'&&armed){armed=false;ownNonce=starts(f)[0].start_nonce;assert.equal(f.control.effect(f.parentKey).state,'running');throw acknowledgment;}
  };
  await assert.rejects(()=>f.journal.withParentStart(f.lease,f.capabilities[0],()=>{entries++;}),error=>error===acknowledgment);
  assert.equal(entries,0);assert.equal(rollbackFailures,1);
  await assertRetainedStartNoReentry(f,ownNonce);
});

test('read-only paid start-transaction acknowledgment failure is not a paid mutation claim',async t=>{
  const f=await fixture(t);const acknowledgment=new Error('synthetic post-read-only-paid-COMMIT acknowledgment loss');let armed=true,ownNonce,entries=0;
  const before=f.paid.row(f.records[0].reservation.reservationId),actualTransaction=f.paid.transaction.bind(f.paid);
  f.paid.transaction=operation=>{const value=actualTransaction(operation);if(armed){armed=false;ownNonce=starts(f)[0].start_nonce;throw acknowledgment;}return value;};
  await assert.rejects(()=>f.journal.withParentStart(f.lease,f.capabilities[0],()=>{entries++;}),error=>error===acknowledgment);
  assert.equal(entries,0);assert.deepEqual(f.paid.row(f.records[0].reservation.reservationId),before);
  await assertRetainedStartNoReentry(f,ownNonce);
});

test('real paid observation commit with lost acknowledgment before entry retains both durable histories',async t=>{
  const f=await fixture(t);const acknowledgment=new Error('synthetic post-paid-observation-COMMIT acknowledgment loss');let armed=false,observedError,ownNonce,entries=0;
  const reservationId=f.records[0].reservation.reservationId,actualTransaction=f.paid.transaction.bind(f.paid);
  f.paid.transaction=operation=>{const value=actualTransaction(operation);if(armed){armed=false;throw acknowledgment;}return value;};
  f.setGenerationReader(count=>{
    if(count===2){
      ownNonce=starts(f)[0].start_nonce;armed=true;
      try{f.paid.observe(reservationId,{chargedCents:7,observedAt:f.control.clock(),evidenceDigest:'8'.repeat(64)});}catch(error){observedError=error;throw error;}
    }
    return 'fixture-generation-1';
  });
  // The fixture generation reader failed; its gate maps that failure to denial.
  await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],()=>{entries++;}),'MODEL_PARENT_GENERATION_CHANGED');
  assert.equal(observedError,acknowledgment);assert.equal(entries,0);assert.equal(f.paid.row(reservationId).charged_cents,7);
  assert.equal(f.paid.db.prepare("SELECT COUNT(*) AS total FROM spending_events WHERE type='observed'").get().total,1);
  await assertRetainedStartNoReentry(f,ownNonce);assert.equal(f.paid.row(reservationId).charged_cents,7);
});

test('committed paid ceiling observation between start and final fence prevents entry',async t=>{
  const f=await fixture(t);const reservationId=f.records[0].reservation.reservationId;let ownNonce,entries=0;
  f.setGenerationReader(count=>{if(count===2){ownNonce=starts(f)[0].start_nonce;f.paid.observe(reservationId,{chargedCents:500,observedAt:f.control.clock(),evidenceDigest:'9'.repeat(64)});}return 'fixture-generation-1';});
  await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],()=>{entries++;}),'MODEL_STEP_PAID_FENCE');
  assert.equal(entries,0);assert.equal(f.paid.row(reservationId).charged_cents,500);
  await assertRetainedStartNoReentry(f,ownNonce);assert.equal(f.paid.row(reservationId).charged_cents,500);
});

test('accepted parent corrupted to retain an abort is refused by entry and SQL start guard',async t=>{
  const f=await fixture(t);f.journal.abortNeverDispatched(f.capabilities[0]);
  // Deliberately corrupt this owned synthetic database, then restore exact DDL.
  const trigger=f.control.db.prepare("SELECT sql FROM sqlite_master WHERE name='model_parent_state_guard'").get().sql;
  f.control.db.exec('DROP TRIGGER model_parent_state_guard');
  f.control.db.prepare("UPDATE effects SET state='accepted' WHERE key=?").run(f.parentKey);
  f.control.db.exec(trigger);
  let entries=0;
  await rejected(()=>f.journal.withParentStart(f.lease,f.capabilities[0],()=>{entries++;}),'MODEL_PARENT_ABORT_INCONSISTENT');
  assert.equal(entries,0);assert.equal(starts(f).length,0);assert.equal(f.control.effect(f.parentKey).state,'accepted');
  const witness=modelParentStartWitness(f.records[0],{generation:'fixture-generation-1',startNonce:'b'.repeat(64),chargedCents:null,overCommittedCents:0,admittedAt:f.control.clock()});
  // Fault-inject only the private-window function to independently test the
  // SQL abort predicate. Hostile UDF replacement is outside the owner model.
  f.control.db.function('factory_model_parent_start_guard',()=>1);
  assert.throws(()=>f.control.db.prepare('INSERT INTO model_parent_starts(parent_key,enrollment_envelope_sha256,envelope_json,start_nonce,generation,witness_json,witness_sha256,admitted_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(witness.parent_key,witness.enrollment_envelope_sha256,witness.envelope_json,witness.start_nonce,witness.generation,witness.witness_json,witness.witness_sha256,witness.admitted_at),/dedicated parent start required/);
  assert.equal(starts(f).length,0);assert.equal(children(f).length,0);
});
