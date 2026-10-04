import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { FactoryControl, digest } from '../src/control.mjs';
import { OriginalModelStepJournal, initializeOriginalModelStepSchema } from '../src/original-model-step-journal.mjs';
import { MODEL_STEP_SCHEMA_SQL, MODEL_STEP_DATABASE_VERSION, modelStepClaimWitness, guardedModelStepMutation } from '../src/model-step-contract.mjs';
import { nativeMissionRequest,nativeMissionEffectKey } from '../src/native-mission-contract.mjs';
import { createNativeCell } from '../src/native-cell.mjs';
import { runNativeMission, claimNativeMission, observeNativeMission } from '../src/native-mission.mjs';
import { fixture, makeSyntheticHost, encoded, proof, privateFiles, sha } from './fixtures/original-model-step-fixture.mjs';

const denied = (operation, code) => assert.throws(operation, error => error.code === code);
const childKey = f => 'model.' + f.records[0].call.requestId;
function closure(f, extra = {}) {
  const t = f.control.task('develop'); return { closureId: 'owned-close', expectedAttempt: t.epoch, expectedOwner: t.owner,
    expectedStatus: t.status, expectedTaskControlEpoch: t.control_epoch, expectedFactoryEpoch: f.control.control().epoch, ...extra };
}
const reopenJournal = (f, compareReceiver) => new OriginalModelStepJournal({ control: f.control, paidAdmission: f.paid, bootstrap: f.host.bootstrap, compareReceiver });
const claimRows = f => f.control.db.prepare('SELECT * FROM model_step_claims ORDER BY effect_key').all();
const claimedEvents = f => f.control.db.prepare("SELECT * FROM events WHERE type='original_model_step_claimed' ORDER BY rowid").all();
const missingGuardFunction = error => ['factory_model_step_write_guard','factory_model_step_claim_guard','factory_model_step_claim_matches']
  .some(name => error.message === 'no such function: ' + name);
function ownedCorruption(control, triggerName, operation) {
  // Deliberate owned-fixture DDL bypass; this does not prove confinement of arbitrary writable DB handles.
  assert.ok(['model_child_state_guard','model_claim_no_update','model_claim_no_delete','model_claim_insert_guard'].includes(triggerName));
  const sql=control.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName).sql;
  control.db.exec('DROP TRIGGER ' + triggerName);
  try { operation(); } finally { control.db.exec(sql); }
}
function fixtureWitness(f, index=0) {
  const record=f.records[index];
  return modelStepClaimWitness(record,digest(f.host.compareReceiver(record)),
    {chargedCents:null,overCommittedCents:0,admittedAt:f.control.clock()});
}
function insertFixtureWitness(control, witness) {
  return control.db.prepare('INSERT INTO model_step_claims(effect_key,parent_key,envelope_sha256,receiver_sha256,witness_json,witness_sha256,admitted_at) VALUES(?,?,?,?,?,?,?)')
    .run(witness.effect_key,witness.parent_key,witness.envelope_sha256,witness.receiver_sha256,witness.witness_json,witness.witness_sha256,witness.admitted_at);
}

test('v2 fixed manifests materialize with the exact native parent; all claims stay runtime HOLD', async t => {
  const f = await fixture(t, { register: false });
  const manifest = f.control.db.prepare('SELECT * FROM model_step_manifests').all();
  const slots = f.control.db.prepare('SELECT * FROM model_step_slots').all();
  assert.equal(manifest.length, 1); assert.equal(slots.length, 2); assert.equal(manifest[0].plan_sha256, digest(f.records[0].plan));
  assert.equal(f.control.modelStepCompletion(f.parentKey).complete, false);
  denied(() => f.control.settleEffect(f.parentKey, 'succeeded'), 'MODEL_STEP_UNRESOLVED');
  f.journal.register(f.lease, f.capabilities[0]); const r = f.journal.claim(f.lease, f.capabilities[0]);
  assert.equal(r.fresh, true); assert.equal(r.runtimeAdmission, 'HOLD'); assert.equal(r.scope, 'source-only-logical-journal');
});

test('identical body bytes retain two independent original identities and expected slots', async t => {
  const f = await fixture(t); assert.equal(f.records[0].body.sha256, f.records[1].body.sha256);
  assert.notEqual(f.records[0].call.requestId, f.records[1].call.requestId);
  for (const c of f.capabilities) assert.equal(f.journal.claim(f.lease, c).fresh, true);
  assert.equal(f.control.db.prepare("SELECT count(*) n FROM effects WHERE kind='model_step' AND state='running'").get().n, 2);
  assert.equal(f.paid.rows().length, 1); assert.equal(f.paid.snapshot().committedCents, 500);
  assert.equal(claimRows(f).length,2);
});

test('preclaim unknown and success cannot bridge missing paid admission, expired lease or OFF',async t=>{
  for(const context of ['paid-not-started','lease-expired','control-OFF']){
    const f=await fixture(t,{paidReady:context!=='paid-not-started'}),before=f.control.effect(childKey(f));
    if(context==='lease-expired')f.advance(600001);
    if(context==='control-OFF')f.control.pause();
    f.control.event('original_model_step_claimed',childKey(f),{logicalOnly:true,syntheticForgedEvent:true});
    for(const state of ['unknown','succeeded'])denied(()=>f.journal.settle(f.capabilities[0],state),'MODEL_STEP_STATE');
    assert.throws(()=>f.journal.claim(f.lease,f.capabilities[0]));
    assert.deepEqual(f.control.effect(childKey(f)),before);assert.deepEqual(claimRows(f),[]);
    assert.equal(f.journal.observe(f.capabilities[0]).state,'accepted');
    assert.equal(f.control.modelStepCompletion(f.parentKey).requiredSuccessful,false);
    assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(f.parentKey),/required model steps unresolved/);
  }
});

test('generic guarded writes cannot mint a claim, start an unclaimed child or regress terminals',async t=>{
  const f=await fixture(t),before=f.control.effect(childKey(f)),witness=fixtureWitness(f);
  assert.throws(()=>guardedModelStepMutation(f.control,()=>insertFixtureWitness(f.control,witness)),/dedicated exact model claim required/);
  for(const state of ['running','unknown','succeeded'])assert.throws(()=>guardedModelStepMutation(f.control,
    ()=>f.control.db.prepare('UPDATE effects SET state=? WHERE key=?').run(state,childKey(f))),
    state==='running'?/exact model claim witness required/:/invalid model child transition/);
  assert.deepEqual(f.control.effect(childKey(f)),before);assert.deepEqual(claimRows(f),[]);
  assert.equal(f.journal.claim(f.lease,f.capabilities[0]).fresh,true);f.journal.settle(f.capabilities[0],'succeeded');
  const terminal=f.control.effect(childKey(f)),claim=claimRows(f)[0];
  assert.throws(()=>f.control.db.prepare('UPDATE model_step_claims SET admitted_at=admitted_at+1 WHERE effect_key=?').run(childKey(f)),/immutable model claim/);
  assert.throws(()=>f.control.db.prepare('DELETE FROM model_step_claims WHERE effect_key=?').run(childKey(f)),/immutable model claim/);
  for(const state of ['running','unknown','accepted','not_applied'])assert.throws(()=>guardedModelStepMutation(f.control,
    ()=>f.control.db.prepare('UPDATE effects SET state=? WHERE key=?').run(state,childKey(f))),/invalid model child transition/);
  assert.deepEqual(f.control.effect(childKey(f)),terminal);assert.deepEqual(claimRows(f),[claim]);
});

test('missing or mismatched saved claims reject completion and idempotent success after owned corruption',async t=>{
  for(const corruption of ['missing','mismatched']){
    const f=await fixture(t);f.closeParent();const parentBefore=f.control.effect(f.parentKey),childBefore=f.control.effect(childKey(f));
    if(corruption==='missing')ownedCorruption(f.control,'model_claim_no_delete',()=>f.control.db.prepare('DELETE FROM model_step_claims WHERE effect_key=?').run(childKey(f)));
    else{
      const claim=claimRows(f).find(row=>row.effect_key===childKey(f)),forged=JSON.parse(claim.witness_json);
      forged.call.nonce='9'.repeat(32);
      ownedCorruption(f.control,'model_claim_no_update',()=>f.control.db.prepare('UPDATE model_step_claims SET witness_json=?,witness_sha256=? WHERE effect_key=?')
        .run(encoded(forged).toString('utf8'),digest(forged),childKey(f)));
    }
    for(const operation of [()=>f.journal.observe(f.capabilities[0]),()=>f.journal.claim(f.lease,f.capabilities[0]),
      ()=>f.journal.settle(f.capabilities[0],'succeeded'),()=>f.control.modelStepCompletion(f.parentKey)])denied(operation,'MODEL_STEP_CLAIM_REQUIRED');
    assert.throws(()=>guardedModelStepMutation(f.control,()=>f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(childKey(f))),/exact model claim witness required/);
    assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(f.parentKey),/required model steps unresolved/);
    assert.deepEqual(f.control.effect(f.parentKey),parentBefore);assert.deepEqual(f.control.effect(childKey(f)),childBefore);
  }
});

test('a retained witness on an accepted child refuses observation, claim and never-dispatched abort',async t=>{
  const f=await fixture(t),witness=fixtureWitness(f),before=f.control.effect(childKey(f));
  ownedCorruption(f.control,'model_claim_insert_guard',()=>insertFixtureWitness(f.control,witness));
  denied(()=>f.journal.observe(f.capabilities[0]),'MODEL_STEP_CLAIM_INCONSISTENT');
  denied(()=>f.journal.claim(f.lease,f.capabilities[0]),'MODEL_STEP_CLAIM_INCONSISTENT');
  denied(()=>f.journal.abortNeverDispatched(f.capabilities[0]),'MODEL_STEP_ABORT_STARTED');
  assert.deepEqual(f.control.effect(childKey(f)),before);assert.equal(claimRows(f).length,1);
  assert.deepEqual({...claimRows(f)[0]},witness);
});

test('claim insert, accepted CAS and event roll back together before the control commit',async t=>{
  const f=await fixture(t),before=f.control.effect(childKey(f)),event=f.control.event;
  f.control.event=function(type,...args){if(type==='original_model_step_claimed')throw new Error('owned event persistence failure');return event.call(this,type,...args);};
  try{assert.throws(()=>f.journal.claim(f.lease,f.capabilities[0]),/owned event persistence failure/);}finally{f.control.event=event;}
  assert.deepEqual(f.control.effect(childKey(f)),before);assert.deepEqual(claimRows(f),[]);assert.deepEqual(claimedEvents(f),[]);
  // The failed private window must be closed and usable only by a subsequent genuine claim.
  assert.throws(()=>guardedModelStepMutation(f.control,()=>insertFixtureWitness(f.control,fixtureWitness(f))),/dedicated exact model claim required/);
  assert.equal(f.journal.claim(f.lease,f.capabilities[0]).fresh,true);assert.equal(claimRows(f).length,1);assert.equal(claimedEvents(f).length,1);
});

test('post-control-commit paid acknowledgement failure preserves one claim and retry observes it',async t=>{
  const f=await fixture(t),transaction=f.paid.transaction;
  f.paid.transaction=function(operation){transaction.call(this,operation);throw new Error('owned paid acknowledgement lost after control commit');};
  try{assert.throws(()=>f.journal.claim(f.lease,f.capabilities[0]),/owned paid acknowledgement lost after control commit/);}finally{f.paid.transaction=transaction;}
  const saved=claimRows(f);assert.equal(saved.length,1);assert.equal(claimedEvents(f).length,1);assert.equal(f.control.effect(childKey(f)).state,'running');
  f.reopen();f.control.pause();f.paid.pauseAdmission();f.advance(600001);
  const retry=f.journal.claim({...f.lease,token:'revoked-owned-token'},f.capabilities[0]);
  assert.equal(retry.fresh,false);assert.equal(retry.observationOnly,true);assert.equal(retry.state,'running');
  f.journal.settle(f.capabilities[0],'unknown',{reason:'lost response'});f.journal.settle(f.capabilities[0],'succeeded',{state:'synthetic observed after OFF'});
  assert.equal(f.journal.settle(f.capabilities[0],'succeeded').observationOnly,true);
  assert.deepEqual(claimRows(f),saved);assert.equal(claimedEvents(f).length,1);
});

test('FactoryControl-only schema3 readers validate saved claims but receive no insert/start authority',async t=>{
  const f=await fixture(t);f.journal.claim(f.lease,f.capabilities[0]);f.journal.settle(f.capabilities[0],'succeeded');
  const reader=new FactoryControl(path.join(f.dir,'control.sqlite'));t.after(()=>reader.close());
  assert.equal(reader.modelStepCompletion(f.parentKey).requiredSuccessful,false);
  const witness=fixtureWitness(f,1),before=claimRows(f);
  assert.equal(reader.db.prepare('SELECT factory_model_step_claim_guard(?,?,?) allowed').get(witness.effect_key,witness.witness_json,'insert').allowed,0);
  assert.throws(()=>guardedModelStepMutation(reader,()=>insertFixtureWitness(reader,witness)),/dedicated exact model claim required/);
  assert.throws(()=>guardedModelStepMutation(reader,()=>reader.db.prepare("UPDATE effects SET state='running' WHERE key=?").run(witness.effect_key)),/exact model claim witness required/);
  f.journal.claim(f.lease,f.capabilities[1]);f.journal.settle(f.capabilities[1],'succeeded');f.control.settleEffect(f.parentKey,'succeeded');
  assert.equal(reader.modelStepCompletion(f.parentKey).complete,true);assert.equal(claimRows(f).length,before.length+1);
  f.control.pause();f.paid.pauseAdmission();f.advance(600001);
  assert.equal(f.journal.settle(f.capabilities[0],'succeeded').observationOnly,true);
  assert.equal(f.journal.claim(f.lease,f.capabilities[0]).state,'succeeded');
});

test('legacy task class, development taskType, non-codex branch and omitted plan cannot self-upgrade', async t => {
  const f = await fixture(t);
  for (const mutate of [r => delete r.task.specification.originalInference, r => r.task.specification.taskType = 'development', r => r.task.branch = 'main',
    r => delete r.plan, r => r.task.specification.originalInference.classification.confidentialityClass = 'confidential']) {
    const r = structuredClone(f.records[0]); mutate(r); const host = makeSyntheticHost([r]);
    denied(() => host.capability(r), 'ORIGINAL_INFERENCE_DENIED'); assert.equal(host.verificationCalls, 0);
  }
});

test('empty, duplicate, extra and mismatched expected calls fail authenticated v2 validation', async t => {
  const f = await fixture(t);
  for (const mutate of [r => r.plan.slots.length = 0, r => r.plan.slots.push(structuredClone(r.plan.slots[0])), r => r.plan.slots[0].nonce = '9'.repeat(32), r => r.plan.slots[0].bindingSha256 = '9'.repeat(64)]) {
    const r = structuredClone(f.records[0]); mutate(r); const host = makeSyntheticHost([r]);
    denied(() => host.capability(r), 'ORIGINAL_INFERENCE_DENIED'); assert.equal(host.verificationCalls, 0);
  }
});

test('altered whole envelope, body/model/recipient bindings and fake bootstrap are denied', async t => {
  const f = await fixture(t);
  for (const mutate of [r => r.model.revision = '9'.repeat(40), r => r.call.principalId = 'other', r => r.recipients[0].generationSha256 = '9'.repeat(64), r => r.body.sha256 = '9'.repeat(64)]) {
    const r = structuredClone(f.records[0]); mutate(r); denied(() => f.host.bootstrap.authenticate(encoded(r), proof), 'ORIGINAL_INFERENCE_DENIED');
  }
  const fake = { authenticate() {}, withVerified() { return f.records[0]; } };
  const journal = new OriginalModelStepJournal({ control: f.control, paidAdmission: f.paid, bootstrap: fake, compareReceiver: f.host.compareReceiver });
  denied(() => journal.register(f.lease, {}), 'ORIGINAL_INFERENCE_DENIED');
});

test('receiver comparison is mandatory at registration and fresh claim, with generic safe failures', async t => {
  const f = await fixture(t, { register: false });
  for (const compare of [null, () => true, async () => f.host.compareReceiver(f.records[0]), () => { throw new Error('private receiver secret'); }]) {
    denied(() => reopenJournal(f, compare).register(f.lease, f.capabilities[0]), 'MODEL_STEP_RECEIVER_REQUIRED');
  }
  f.journal.register(f.lease, f.capabilities[0]); denied(() => reopenJournal(f, null).claim(f.lease, f.capabilities[0]), 'MODEL_STEP_RECEIVER_REQUIRED');
  assert.equal(f.journal.observe(f.capabilities[0]).state, 'accepted');
});

test('every immutable manifest, expected slot and admitted binding refuses update/delete', async t => {
  const f = await fixture(t);
  for (const table of ['model_step_manifests', 'model_step_slots', 'model_step_bindings']) {
    assert.throws(() => f.control.db.exec('DELETE FROM ' + table), /immutable/);
  }
  assert.throws(() => f.control.db.exec("UPDATE model_step_slots SET nonce='collision'"), /immutable/);
  assert.throws(() => f.control.db.exec("UPDATE effects SET request_digest='changed' WHERE kind='model_step'"), /immutable/);
});

test('duplicate registration preserves original evidence and creates no second child/reservation', async t => {
  const f = await fixture(t), before = f.control.db.prepare('SELECT * FROM model_step_bindings ORDER BY effect_key').all();
  assert.equal(f.journal.register(f.lease, f.capabilities[0]).fresh, false);
  assert.deepEqual(f.control.db.prepare('SELECT * FROM model_step_bindings ORDER BY effect_key').all(), before);
  assert.equal(f.paid.rows().length, 1);
});

test('unique expected request IDs and nonces reject a second parent collision atomically', async t => {
  const f = await fixture(t), before = f.control.db.prepare('SELECT count(*) n FROM model_step_slots').get().n;
  assert.throws(() => f.control.db.prepare('INSERT INTO model_step_slots VALUES(?,?,?,?,?,?,?)').run(f.parentKey, 'different-node', 3,
    f.records[0].call.requestId, f.records[0].call.nonce, '9'.repeat(64),'succeeded'), /UNIQUE/);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM model_step_slots').get().n, before);
});

test('missing and unresolved required children block every terminal parent outcome', async t => {
  const f = await fixture(t, { register: false });
  for (const state of ['succeeded', 'not_applied']) denied(() => f.control.settleEffect(f.parentKey, state), 'MODEL_STEP_UNRESOLVED');
  f.journal.register(f.lease, f.capabilities[0]); f.journal.claim(f.lease, f.capabilities[0]); f.journal.settle(f.capabilities[0], 'succeeded', { state: 'synthetic_observed' });
  denied(() => f.control.settleEffect(f.parentKey, 'succeeded'), 'MODEL_STEP_UNRESOLVED');
  f.journal.register(f.lease, f.capabilities[1]); f.journal.claim(f.lease,f.capabilities[1]);f.journal.settle(f.capabilities[1], 'succeeded',{state:'synthetic_observed'});
  assert.equal(f.control.modelStepCompletion(f.parentKey).complete, true);
  f.control.settleEffect(f.parentKey, 'succeeded', { state: 'synthetic_completed' });
});

test('a required not-applied child is drained but never satisfies parent success', async t => {
  const f=await fixture(t);
  for(const cap of f.capabilities)f.journal.settle(cap,'not_applied',{reason:'synthetic not dispatched'});
  const completion=f.control.modelStepCompletion(f.parentKey);
  assert.equal(completion.drained,true);assert.equal(completion.requiredSuccessful,false);assert.equal(completion.complete,false);
  denied(()=>f.control.settleEffect(f.parentKey,'succeeded'),'MODEL_STEP_UNRESOLVED');
  assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(f.parentKey),/required model steps/);
});

test('authenticated never-dispatched whole-plan abort preserves slots and allowance without fake child results',async t=>{
  const f=await fixture(t,{register:false,parentRunning:false}),slots=f.control.db.prepare('SELECT * FROM model_step_slots').all(),paid=f.paid.rows();
  const result=f.journal.abortNeverDispatched(f.capabilities[0],{reason:'source profile closed'});
  assert.equal(result.state,'not_applied');assert.equal(result.runtimeAdmission,'HOLD');
  assert.equal(f.control.effect(f.parentKey).state,'not_applied');assert.deepEqual(f.control.db.prepare('SELECT * FROM model_step_slots').all(),slots);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM model_step_bindings').get().n,0);assert.deepEqual(f.paid.rows(),paid);
  const completion=f.control.modelStepCompletion(f.parentKey);assert.equal(completion.aborted,true);assert.equal(completion.requiredSuccessful,false);
  assert.equal(f.journal.abortNeverDispatched(f.capabilities[0]).observationOnly,true);
  assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(f.parentKey),/required model steps/);
});

test('duplicate never-dispatched abort revalidates stored children after OFF and owned corruption',async t=>{
  const f=await fixture(t,{register:false,parentRunning:false});
  f.control.db.prepare("UPDATE effects SET state='running' WHERE key=?").run(f.parentKey);f.journal.register(f.lease,f.capabilities[0]);
  f.control.db.prepare("UPDATE effects SET state='accepted' WHERE key=?").run(f.parentKey); // Owned setup of an accepted logical parent; no dispatcher exists.
  f.journal.abortNeverDispatched(f.capabilities[0]);const before=f.control.effect(f.parentKey);
  f.control.pause();f.paid.pauseAdmission();f.advance(600001);
  assert.equal(f.journal.abortNeverDispatched(f.capabilities[0]).observationOnly,true);
  ownedCorruption(f.control,'model_child_state_guard',()=>f.control.db.prepare("UPDATE effects SET state='running' WHERE key=?").run(childKey(f)));
  denied(()=>f.journal.abortNeverDispatched(f.capabilities[0]),'MODEL_STEP_CLAIM_REQUIRED');
  assert.deepEqual(f.control.effect(f.parentKey),before);assert.equal(f.control.db.prepare('SELECT count(*) n FROM model_step_aborts').get().n,1);
});

test('whole-plan abort requires the exact authenticated enrollment and an accepted unstarted parent',async t=>{
  const f=await fixture(t,{register:false,parentRunning:false});
  denied(()=>f.journal.abortNeverDispatched({}),'ORIGINAL_INFERENCE_DENIED');
  denied(()=>f.journal.abortNeverDispatched(f.capabilities[1]),'MODEL_STEP_ABORT_BINDING');
  assert.equal(f.control.effect(f.parentKey).state,'accepted');
  f.control.db.prepare("UPDATE effects SET state='running' WHERE key=?").run(f.parentKey); // Synthetic corruption/transition only.
  denied(()=>f.journal.abortNeverDispatched(f.capabilities[0]),'MODEL_STEP_PARENT_CLOSED');
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM model_step_aborts').get().n,0);
});

test('SQL abort completion matches JS refusal after owned parent state corruption',async t=>{
  const f=await fixture(t,{register:false,parentRunning:false});f.journal.abortNeverDispatched(f.capabilities[0]);
  for(const state of ['running','unknown']){
    // Deliberate raw corruption of an owned fixture only; no known controller method makes this transition.
    f.control.db.prepare('UPDATE effects SET state=? WHERE key=?').run(state,f.parentKey);
    denied(()=>f.control.modelStepCompletion(f.parentKey),'MODEL_STEP_MANIFEST_INCONSISTENT');
    assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='not_applied' WHERE key=?").run(f.parentKey),/required model steps/);
    assert.equal(f.control.effect(f.parentKey).state,state);
  }
});

test('a SQL connection opened before migration cannot remove enrolled task metadata or digest',async t=>{
  const f=await fixture(t,{preMigrationWriter:true}),spec=structuredClone(f.control.task('develop').specification);delete spec.originalInference;
  assert.throws(()=>f.oldTaskUpdate.run(JSON.stringify(spec),digest(spec),'develop'),/immutable enrolled original task/);
  assert.equal(f.control.requiresOriginalModelStep('develop'),true);
});

test('historical metadata omission remains fenced by durable enrollment before preparation or paid work',async t=>{
  const f=await fixture(t,{paidReady:false});let calls=0;
  const spec=structuredClone(f.control.task('develop').specification);delete spec.originalInference;
  // Deliberate owned DDL corruption to model a historical bypass; arbitrary DDL is not contained.
  f.control.db.exec('DROP TRIGGER model_enrolled_task_identity_guard');
  f.control.db.prepare('UPDATE tasks SET specification=?,spec_digest=? WHERE id=?').run(JSON.stringify(spec),digest(spec),'develop');
  const trigger=MODEL_STEP_SCHEMA_SQL.match(/CREATE TRIGGER model_enrolled_task_identity_guard[\s\S]*?END;/)[0];f.control.db.exec(trigger);
  assert.equal(f.control.requiresOriginalModelStep('develop'),true);
  const client={binding:f.worker,async prepare(){calls++;},async dispatch(){calls++;},async observe(){calls++;}};
  await assert.rejects(runNativeMission({control:f.control,lease:f.lease,client,paidAdmission:f.paid,privateFiles,outputFile:f.outputFile}),{code:'ORIGINAL_MODEL_STEP_RUNTIME_HOLD'});
  denied(()=>f.control.startNativeMissionEffect(f.lease,f.parentKey,()=>{calls++;}),'ORIGINAL_MODEL_STEP_RUNTIME_HOLD');
  assert.throws(()=>f.control.modelStepCompletion(f.parentKey));assert.equal(calls,0);assert.equal(f.paid.rows().length,0);
});

test('SQL parent terminal-state rewrite rejects an orphan binding with a missing child effect after owned FK bypass',async t=>{
  const f=await fixture(t);f.closeParent();
  const parentBefore=f.control.effect(f.parentKey),bindingBefore=f.control.db.prepare('SELECT * FROM model_step_bindings WHERE effect_key=?').get(childKey(f));
  assert.equal(parentBefore.state,'succeeded');assert.ok(bindingBefore);
  assert.equal(f.control.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  const raw=new DatabaseSync(path.join(f.dir,'control.sqlite'));t.after(()=>raw.close());raw.exec('PRAGMA foreign_keys=OFF;');
  assert.equal(raw.prepare('PRAGMA foreign_keys').get().foreign_keys,0);
  raw.prepare('DELETE FROM effects WHERE key=?').run(childKey(f)); // Deliberate owned corruption only.
  // The registered fixture connection reaches membership validation; the raw writer has no guard UDF.
  assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(f.parentKey),/required model steps unresolved/);
  denied(()=>f.control.modelStepCompletion(f.parentKey),'MODEL_STEP_MANIFEST_INCONSISTENT');
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM effects WHERE key=?').get(childKey(f)).n,0);
  assert.deepEqual(f.control.db.prepare('SELECT * FROM model_step_bindings WHERE effect_key=?').get(childKey(f)),bindingBefore);
  assert.deepEqual(f.control.effect(f.parentKey),parentBefore);
});

test('SQL and JS completion reject an extra unbound model child',async t=>{
  const f=await fixture(t);f.closeParent();
  f.control.db.prepare("INSERT INTO effects SELECT 'extra-model',scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,receipt,created,updated FROM effects WHERE key=?").run(childKey(f));
  denied(()=>f.control.modelStepCompletion(f.parentKey),'MODEL_STEP_MANIFEST_INCONSISTENT');
  assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(f.parentKey),/required model steps/);
});

test('colliding global original slots roll back parent intent, manifest and events in the same transaction',async t=>{
  const f=await fixture(t),record=structuredClone(f.records[0]);record.task.id='develop2';record.task.branch='codex/develop2';record.task.specification.nativeMission.missionId='8'.repeat(32);
  f.control.createTask({taskId:record.task.id,projectId:record.task.projectId,branch:record.task.branch,specification:record.task.specification});
  const lease=f.control.claimTask(record.task.id,'child',600000),task=f.control.task(record.task.id);
  record.task.specDigest=task.spec_digest;record.lease={scope:lease.scope,scopeId:lease.scopeId,cellId:lease.cellId,epoch:lease.epoch,controlEpoch:lease.controlEpoch,expires:lease.expires,tokenSha256:sha(lease.token)};
  const request=nativeMissionRequest(task,lease,path.join(f.dir,'other-output.private.json'));record.parent={request,requestSha256:digest(request),effectKey:nativeMissionEffectKey(request)};
  record.reservation.reservationId='paid.'+record.parent.effectKey;
  const host=makeSyntheticHost([record]),journal=new OriginalModelStepJournal({control:f.control,paidAdmission:f.paid,bootstrap:host.bootstrap,compareReceiver:host.compareReceiver});
  assert.throws(()=>journal.admitParent(lease,host.capability(record)),/UNIQUE/);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM effects WHERE key=?').get(record.parent.effectKey).n,0);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM model_step_manifests WHERE parent_key=?').get(record.parent.effectKey).n,0);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM events WHERE subject=?').get(record.parent.effectKey).n,0);
});

test('generic child admit/start/settle/reconcile and raw state updates cannot bypass dedicated paths', async t => {
  const f = await fixture(t);
  denied(() => f.control.admitEffect(f.lease, { key: 'fake-child', kind: 'model_step', request: {} }), 'INVALID');
  denied(() => f.control.startEffect(f.lease, childKey(f)), 'MODEL_STEP_METHOD_REQUIRED');
  denied(() => f.control.settleEffect(childKey(f), 'succeeded'), 'MODEL_STEP_METHOD_REQUIRED');
  denied(() => f.control.reconcileEffect(childKey(f), { applied: true, evidencePath: 'must-not-read' }), 'MODEL_STEP_METHOD_REQUIRED');
  assert.throws(() => f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(childKey(f)), /dedicated model child/);
});

test('a SQL writer opened on v1 before migration cannot clear children or incomplete parent', async t => {
  const f = await fixture(t, { preMigrationWriter: true });
  // Actual connection and statement predate schema installation. This does not qualify old physical sender quiescence.
  const childBefore=f.control.effect(childKey(f)),parentBefore=f.control.effect(f.parentKey);
  assert.equal(childBefore.state,'accepted');assert.equal(parentBefore.state,'running');
  assert.throws(() => f.oldUpdate.run('succeeded', childKey(f)), missingGuardFunction);
  assert.deepEqual(f.control.effect(childKey(f)),childBefore);assert.deepEqual(f.control.effect(f.parentKey),parentBefore);
  assert.throws(() => f.oldUpdate.run('succeeded', f.parentKey), missingGuardFunction);
  assert.deepEqual(f.control.effect(childKey(f)),childBefore);assert.deepEqual(f.control.effect(f.parentKey),parentBefore);
  // A registered host connection resolves the UDF and separately reaches the incomplete-plan guard.
  assert.throws(()=>f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(f.parentKey),/required model steps unresolved/);
  assert.deepEqual(f.control.effect(childKey(f)),childBefore);assert.deepEqual(f.control.effect(f.parentKey),parentBefore);
});

test('source-only native claim and run refuse before preparation and any paid reservation', async t => {
  const f = await fixture(t, { paidReady: false }), paidBefore = f.paid.rows(); let calls = 0;
  const client = { binding: f.worker, async prepare() { calls++; }, async dispatch() { calls++; }, async observe() { calls++; } };
  await assert.rejects(claimNativeMission({ control: f.control, taskId: 'develop', client, outputFile: f.outputFile }), { code: 'ORIGINAL_MODEL_STEP_RUNTIME_HOLD' });
  await assert.rejects(runNativeMission({ control: f.control, lease: f.lease, client, paidAdmission: f.paid, privateFiles, outputFile: f.outputFile }), { code: 'ORIGINAL_MODEL_STEP_RUNTIME_HOLD' });
  denied(() => f.control.startNativeMissionEffect(f.lease, f.parentKey, () => { calls++; }), 'ORIGINAL_MODEL_STEP_RUNTIME_HOLD');
  assert.equal(calls, 0); assert.deepEqual(f.paid.rows(), paidBefore);
});

test('lost acknowledgement/restart preserves running CAS; a repeated capability never grants a second attempt', async t => {
  const f = await fixture(t); assert.equal(f.journal.claim(f.lease, f.capabilities[0]).fresh, true); // Deliberately discard acknowledgement.
  f.reopen(); const view = f.journal.claim(f.lease, f.capabilities[0]);
  assert.equal(view.fresh, false); assert.equal(view.state, 'running'); assert.equal(view.observationOnly, true);
  assert.equal(f.control.db.prepare("SELECT count(*) n FROM events WHERE type='original_model_step_claimed'").get().n, 1);
});

test('unknown child survives restart/OFF and can be observed without new lease, reservation or claim', async t => {
  const f = await fixture(t); f.journal.claim(f.lease, f.capabilities[0]); f.journal.settle(f.capabilities[0], 'unknown', { reason: 'lost response' });
  f.reopen(); f.control.pause(); f.paid.pauseAdmission();
  assert.equal(f.journal.claim(f.lease, f.capabilities[0]).observationOnly, true);
  assert.equal(f.journal.observe(f.capabilities[0]).state, 'unknown');
  denied(() => f.journal.settle(f.capabilities[0], 'not_applied'), 'MODEL_STEP_NEGATIVE_UNSUPPORTED');
  assert.equal(f.paid.rows().length, 1);
});

for (const reason of ['control-paused', 'lease-expired', 'token-mismatch', 'paid-paused', 'paid-exhausted', 'paid-provider-mismatch']) {
  test('fresh logical claim refuses ' + reason + ' without consuming accepted intent', async t => {
    const f = await fixture(t); let lease = f.lease;
    if (reason === 'control-paused') f.control.pause();
    if (reason === 'lease-expired') f.advance(600001);
    if (reason === 'token-mismatch') lease = { ...lease, token: 'wrong-owned-token' };
    if (reason === 'paid-paused') f.paid.pauseAdmission();
    if (reason === 'paid-exhausted') f.paid.observe('paid.' + f.parentKey, { chargedCents: 500, observedAt: 1, evidenceDigest: '9'.repeat(64) });
    if (reason === 'paid-provider-mismatch') f.paid.db.prepare('UPDATE spending_reservations SET provider=? WHERE id=?').run('fly', 'paid.' + f.parentKey);
    assert.throws(() => f.journal.claim(lease, f.capabilities[0]));
    assert.equal(f.journal.observe(f.capabilities[0]).state, 'accepted');
    assert.equal(f.control.db.prepare("SELECT count(*) n FROM events WHERE type='original_model_step_claimed'").get().n, 0);
    assert.deepEqual(claimRows(f),[]);
  });
}

test('zero free funds in unrelated held reservation cannot mint another reservation or original call claim', async t => {
  const f = await fixture(t, { paidReady: false }); f.paid.reserveFresh({ reservationId: 'other-held', provider: 'modal', ceilingCents: 1000 });
  assert.equal(f.paid.snapshot().unallocatedCents, 0); assert.throws(() => f.journal.claim(f.lease, f.capabilities[0]));
  assert.equal(f.paid.rows().length, 1); assert.equal(f.journal.observe(f.capabilities[0]).state, 'accepted');
});

test('closed parent denies late child registration and new claims; duplicate terminal child remains observation only', async t => {
  const f = await fixture(t); f.closeParent();
  const view = f.journal.claim(f.lease, f.capabilities[0]); assert.equal(view.fresh, false); assert.equal(view.state, 'succeeded');
  denied(() => f.control.settleEffect(f.parentKey, 'succeeded'), 'EFFECT');
  assert.equal(f.control.modelStepCompletion(f.parentKey).complete, true);
});

test('submission, release, cancellation, takeover and cell retirement retain child blockers', async t => {
  const f = await fixture(t), artifact = path.join(f.dir, 'candidate.json'); await fs.writeFile(artifact, '{"fixture":true}');
  denied(() => f.control.submit(f.lease, { artifactPath: artifact }), 'UNRECONCILED');
  denied(() => f.control.releaseTask('develop', closure(f)), 'UNRECONCILED');
  denied(() => f.control.cancelTask('develop', closure(f, { reason: 'abandoned' })), 'UNRECONCILED');
  f.advance(600001); denied(() => f.control.claimTask('develop', 'child'), 'UNRECONCILED');
  denied(() => f.control.retireCell('child', { closureId: 'retire', expectedParent: 'root', expectedStatus: 'ready', expectedAllocation: 1000,
    expectedSpent: 0, expectedFactoryEpoch: f.control.control().epoch }), 'TASK');
  assert.equal(f.control.status().effectsDrained, false); assert.equal(f.control.openTaskEffects('develop').length, 3);
});

test('NativeCell reports child reconciliation before parent observer and paid switches', async t => {
  const f = await fixture(t); let observations = 0,preparations=0;
  const client = { binding: f.worker, async prepare() { throw new Error('not expected'); }, async dispatch() { throw new Error('not expected'); }, async observe() { observations++; } };
  const cell = createNativeCell({ control: f.control, paidAdmission: f.paid, client, privateFiles:{...privateFiles,async ensurePrivateDirectory(){preparations++;}},
    profile: { cellId: 'child', app: 'factory-child', provisionKey: 'provision', worker: f.worker, outputDirectory: f.outputDirectory, ttlMs: 600000, pollMs: 100 } });
  const result = await cell.tick(); assert.equal(result.reason, 'model_step_reconciliation_required'); assert.equal(observations, 0);
  assert.equal(result.runtimeAdmission, 'HOLD');assert.equal(preparations,0);
});

test('parent observation cannot write completion output while a required child is missing', async t => {
  const f = await fixture(t, { register: false }); let writes = 0;
  const result = await observeNativeMission({ control: f.control, key: f.parentKey,
    client: { binding: f.worker, async prepare() {}, async dispatch() {}, async observe() { return { state: 'completed', body: '{}' }; } },
    privateFiles: { ...privateFiles, async writePrivateJson() { writes++; } } });
  assert.equal(result.effect.state, 'unknown'); assert.equal(writes, 0);
});

test('already-succeeded but inconsistent parent is rejected before observer early-return', async t => {
  const f = await fixture(t, { register: false }); let observations = 0;
  // Deliberate corruption of owned fixture only, to simulate historical completion bypass.
  f.control.db.exec('DROP TRIGGER model_parent_completion_guard');
  f.control.db.prepare("UPDATE effects SET state='succeeded' WHERE key=?").run(f.parentKey);
  await assert.rejects(observeNativeMission({ control: f.control, key: f.parentKey, privateFiles,
    client: { binding: f.worker, async prepare() {}, async dispatch() {}, async observe() { observations++; } } }), { code: 'MODEL_STEP_SCHEMA_REQUIRED' });
  assert.equal(observations, 0);
});

test('explicit schema3 initializer refuses active/non-drained state and constructor leaves v1 unchanged', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fms-schema-')); await privateFiles.ensurePrivateDirectory(dir);
  let control = new FactoryControl(path.join(dir, 'control.sqlite')); t.after(() => control.close());
  control.initialize({ mission: 'fixture', budgetCents: 1000, maxCells: 2, maxDepth: 1 });
  denied(() => initializeOriginalModelStepSchema(control), 'MODEL_STEP_MIGRATION_HOLD');
  control.close(); control = new FactoryControl(path.join(dir, 'control.sqlite'));
  assert.equal(control.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(control.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'model_step_%'").get().n, 0);
  control.pause(); assert.equal(initializeOriginalModelStepSchema(control).fresh, true); control.close();
  control = new FactoryControl(path.join(dir, 'control.sqlite')); assert.equal(control.db.prepare('PRAGMA user_version').get().user_version, MODEL_STEP_DATABASE_VERSION);
  assert.equal(initializeOriginalModelStepSchema(control).fresh, false);
});

test('old schema marker reset is refused before constructor journal mode or extension repair', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fms-marker-')); await privateFiles.ensurePrivateDirectory(dir);
  const filename = path.join(dir, 'control.sqlite');
  const control = new FactoryControl(filename); control.initialize({ mission: 'fixture', budgetCents: 1000, maxCells: 2, maxDepth: 1 });
  control.pause(); initializeOriginalModelStepSchema(control); control.close();
  const old = new DatabaseSync(filename); old.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=1;'); old.close();
  denied(() => new FactoryControl(filename), 'MODEL_STEP_SCHEMA_INCONSISTENT');
  const observer = new DatabaseSync(filename, { readOnly: true });
  try { assert.equal(observer.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(observer.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(observer.prepare("SELECT count(*) n FROM sqlite_master WHERE name='model_step_manifests'").get().n, 1); }
  finally { observer.close(); }
});

test('schema3 marker with weakened extension trigger is refused before journal-mode changes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fms-ddl-')); await privateFiles.ensurePrivateDirectory(dir);
  const filename = path.join(dir, 'control.sqlite'), control = new FactoryControl(filename);
  control.initialize({ mission: 'fixture', budgetCents: 1000, maxCells: 2, maxDepth: 1 }); control.pause(); initializeOriginalModelStepSchema(control); control.close();
  const raw = new DatabaseSync(filename); raw.exec("PRAGMA journal_mode=DELETE; DROP TRIGGER model_child_state_guard; CREATE TRIGGER model_child_state_guard BEFORE UPDATE OF state ON effects BEGIN SELECT 1; END;"); raw.close();
  denied(() => new FactoryControl(filename), 'MODEL_STEP_SCHEMA_REQUIRED');
  const observer = new DatabaseSync(filename, { readOnly: true });
  try { assert.equal(observer.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); } finally { observer.close(); }
});

test('previous schema2 marker is refused without inferring witnesses or changing journal mode',async t=>{
  for(const extension of [false,true]){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fms-old2-'));await privateFiles.ensurePrivateDirectory(dir);
    const filename=path.join(dir,'control.sqlite'),control=new FactoryControl(filename);
    control.initialize({mission:'owned schema marker fixture',budgetCents:1000,maxCells:2,maxDepth:1});
    if(extension){control.pause();initializeOriginalModelStepSchema(control);}control.close();
    const raw=new DatabaseSync(filename);raw.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=2;');raw.close();
    // These are owned marker fixtures, not an execution of the historical schema2 prototype.
    denied(()=>new FactoryControl(filename),'MODEL_STEP_SCHEMA_REQUIRED');
    const observer=new DatabaseSync(filename,{readOnly:true});
    try{assert.equal(observer.prepare('PRAGMA user_version').get().user_version,2);assert.equal(observer.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
      assert.equal(observer.prepare("SELECT count(*) n FROM sqlite_master WHERE name='model_step_claims'").get().n,extension?1:0);}finally{observer.close();}
  }
});

let unresolvedRaceChildObserved=false;
const raceSpawnRegistry=new Map();
async function ownedRaceFilePin(filename){
  const fields=['dev','ino','size','mtimeNs','ctimeNs','birthtimeNs','mode','nlink','uid','gid'];
  const before=await fs.lstat(filename,{bigint:true});assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=131072n);
  const bytes=await fs.readFile(filename),after=await fs.lstat(filename,{bigint:true});
  assert.equal(bytes.length,Number(before.size));assert.ok(fields.every(k=>before[k]===after[k]));
  return {filename,bytes:bytes.length,sha256:sha(bytes),generation:Object.fromEntries(fields.map(k=>[k,String(after[k])]))};
}
async function capturedRaceChild(dir, label, statePath) {
  assert.equal(unresolvedRaceChildObserved,false,'No later race child may launch after unknown closure.');
  const script = fileURLToPath(new URL('./fixtures/original-model-step-racer.mjs', import.meta.url));
  const rawDir = path.join(dir, label + '-raw'), sealDir = path.join(dir, label + '-seal');
  await privateFiles.ensurePrivateDirectory(rawDir); await privateFiles.ensurePrivateDirectory(sealDir);
  const intent = { executable: process.execPath, args: [script, statePath], cwd: dir, maxMs: 10000, closeGraceMs:5000, rawByteLimit:131072, synthetic: true,
    deadlineScope:'Child observation plus grace only; filesystem/persistence has no hard whole-pipeline deadline.',
    unknownPolicy:'Freeze raw/metadata, remove captured listeners, destroy parent pipe handles, unref child and preserve UNKNOWN; no stopped-grandchild claim.' };
  await privateFiles.writePrivateJson(path.join(sealDir, 'intent.private.json'), intent, { exclusive: true });
  assert.equal(unresolvedRaceChildObserved,false,'No later race child may launch after unknown closure.');
  const attemptId=sha(path.resolve(dir)+'|'+label);assert.equal(raceSpawnRegistry.has(attemptId),false);
  const witness={format:'factory-known-journal-race-child',schemaVersion:1,attemptId,knownSpawn:false,pid:null,label,
    intent:path.join(sealDir,'intent.private.json'),outcomeObserved:false,closed:false,code:null,signal:null,error:null,
    timedOut:false,overflow:false,unknownDetached:false,terminationRequested:false,rawSnapshot:null,launch:null,stdout:null,stderr:null,closePin:null,
    persistence:{launch:'pending',stdout:'not_attempted',stderr:'not_attempted',closedRecord:'not_attempted'}};
  raceSpawnRegistry.set(attemptId,witness);
  const child = spawn(process.execPath, [script, statePath], { cwd: dir, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, FACTORY_PRIVATE_MODULE: process.env.FACTORY_PRIVATE_MODULE, TMP: dir, TEMP: dir, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  witness.knownSpawn=true;witness.pid=child.pid??null;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timedOut = false, overflow = false, error = null, closed = false,terminationRequested=false,sealed=false;
  let closeDeadline,timer,resolveClose;
  const terminate=()=>{if(terminationRequested||sealed||closed)return;terminationRequested=true;try{child.kill();}catch{error='TERMINATION_ERROR';}
    closeDeadline=setTimeout(()=>{clearTimeout(timer);resolveClose?.({code:null,signal:null});},5000);};
  const accumulate=(old,b)=>{const room=131072-old.length;if(b.length>room){overflow=true;terminate();return Buffer.concat([old,b.subarray(0,Math.max(0,room))]);}return Buffer.concat([old,b]);};
  const onStdout=b=>{if(!sealed)stdout=accumulate(stdout,b);},onStderr=b=>{if(!sealed)stderr=accumulate(stderr,b);};
  const onError=e=>{if(!sealed)error=e.code||'CHILD_ERROR';};
  child.stdout.on('data',onStdout);child.stderr.on('data',onStderr);child.on('error',onError);
  const launch=(async()=>{witness.persistence.launch='writing';const filename=path.join(sealDir,'launch.private.json');
    await privateFiles.writePrivateJson(filename,{pid:child.pid??null,launchedAt:new Date().toISOString()},{exclusive:true});witness.persistence.launch='saved';
    const pin=await ownedRaceFilePin(filename);witness.persistence.launch='verified';return pin;
  })().catch(()=>{witness.persistence.launch=witness.persistence.launch==='saved'?'saved_verification_failed':'write_failed';error='LAUNCH_RECORD_FAILED';terminate();return null;});
  let onClose;
  const outcome = await new Promise(resolve => {
    resolveClose=resolve;timer = setTimeout(() => { timedOut = true;terminate(); }, 10000);
    onClose=(code,signal)=>{if(sealed)return;closed=true;clearTimeout(timer);clearTimeout(closeDeadline);resolve({code,signal});};child.once('close',onClose);
  });
  sealed=true;clearTimeout(timer);clearTimeout(closeDeadline);
  const snapshot={stdout:Buffer.from(stdout),stderr:Buffer.from(stderr),closed,timedOut,overflow,error,terminationRequested,...outcome};
  Object.assign(witness,{outcomeObserved:true,closed:snapshot.closed,code:snapshot.code,signal:snapshot.signal,error:snapshot.error,
    timedOut:snapshot.timedOut,overflow:snapshot.overflow,terminationRequested:snapshot.terminationRequested,unknownDetached:!snapshot.closed,
    observedOutcome:Object.freeze({closed:snapshot.closed,code:snapshot.code,signal:snapshot.signal,error:snapshot.error,timedOut:snapshot.timedOut,overflow:snapshot.overflow}),
    rawSnapshot:Object.freeze({stdout:Object.freeze({bytes:snapshot.stdout.length,sha256:sha(snapshot.stdout)}),stderr:Object.freeze({bytes:snapshot.stderr.length,sha256:sha(snapshot.stderr)})})});
  child.stdout.removeListener('data',onStdout);child.stderr.removeListener('data',onStderr);child.removeListener('close',onClose);
  if(!snapshot.closed){unresolvedRaceChildObserved=true;child.stdout.destroy();child.stderr.destroy();child.unref();}
  witness.expectedFiles={stdout:path.join(rawDir,'stdout.raw'),stderr:path.join(rawDir,'stderr.raw'),closedRecord:path.join(sealDir,'closed.private.json')};
  const complete=()=>({...witness,persistence:{...witness.persistence}});let stage='launch';
  try{
    witness.launch=await launch;if(!witness.launch)witness.error='LAUNCH_RECORD_FAILED';
    for(const name of ['stdout','stderr']){stage=name;witness.persistence[name]='writing';await fs.writeFile(witness.expectedFiles[name],snapshot[name],{flag:'wx'});
      witness.persistence[name]='saved';const pin=await ownedRaceFilePin(witness.expectedFiles[name]);
      assert.equal(pin.bytes,witness.rawSnapshot[name].bytes);assert.equal(pin.sha256,witness.rawSnapshot[name].sha256);witness[name]=pin;witness.persistence[name]='verified';}
    stage='closedRecord';witness.persistence.closedRecord='writing';await privateFiles.writePrivateJson(witness.expectedFiles.closedRecord,complete(),{exclusive:true});
    witness.persistence.closedRecord='saved';witness.closePin=await ownedRaceFilePin(witness.expectedFiles.closedRecord);witness.persistence.closedRecord='verified';
  }catch(error){witness.persistence[stage]=witness.persistence[stage]==='saved'?'saved_verification_failed':'write_failed';
    witness.persistenceFailure={stage,code:typeof error.code==='string'?error.code:'PERSISTENCE_REJECTED'};
    const failure=new Error('RACE_CAPTURE_PERSISTENCE_FAILED');failure.child=complete();throw failure;}
  const receipt=complete();
  if(!(receipt.closed&&receipt.code===0&&receipt.signal===null&&!receipt.timedOut&&!receipt.overflow&&!receipt.error)){
    const failure=new Error('RACE_CHILD_UNQUALIFIED');failure.child=receipt;throw failure;}
  return { view: JSON.parse(snapshot.stdout.toString('utf8')), receiptPath:witness.expectedFiles.closedRecord,witness:receipt };
}

test('two actual fixture processes racing the same SQLite call claim produce exactly one fresh logical CAS', async t => {
  const f = await fixture(t), statePath = path.join(f.dir, 'race-state.private.json');
  await privateFiles.writePrivateJson(statePath, { format: 'owned-original-model-step-race', synthetic: true, directory: f.dir,
    clockMs: f.lease.expires - 600000, lease: f.lease, records: f.records }, { exclusive: true });
  const outcomes = await Promise.allSettled([capturedRaceChild(f.dir, 'race-a', statePath), capturedRaceChild(f.dir, 'race-b', statePath)]);
  const attempts=[...raceSpawnRegistry.values()].map(w=>({...w,persistence:{...w.persistence}}));
  const census={format:'factory-journal-race-census',schemaVersion:1,expectedAttempts:2,complete:attempts.length===2&&attempts.every(w=>w.knownSpawn&&w.outcomeObserved),
    attempts,settledResults:outcomes.map(r=>({status:r.status,attemptId:r.status==='fulfilled'?r.value.witness.attemptId:r.reason.child?.attemptId??null})),
    scope:'Only these two fixture race attempts; no baseline/global descendant census.'};
  console.log('Owned journal race census: '+JSON.stringify(census));
  assert.ok(outcomes.every(r=>r.status==='fulfilled'),'Both actual race children must have qualified closure records.');
  const results=outcomes.map(r=>r.value);
  assert.equal(results.filter(r => r.view.fresh).length, 1); assert.equal(results.filter(r => r.view.observationOnly).length, 1);
  assert.ok(results.every(r => r.view.runtimeAdmission === 'HOLD'));
  assert.equal(f.control.db.prepare("SELECT count(*) n FROM events WHERE type='original_model_step_claimed' AND subject=?").get(childKey(f)).n, 1);
  t.diagnostic('Owned race closures: ' + JSON.stringify(results.map(r => r.receiptPath)));
});
