import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/control.mjs';
import {OriginalModelStepJournal} from '../src/original-model-step-journal.mjs';
import {modelStepClaimWitness, originalModelStepReceiverComparison} from '../src/model-step-contract.mjs';
import {fixture} from './fixtures/original-model-step-fixture.mjs';

const denied=(operation,code='MODEL_STEP_RECEIVER_REQUIRED')=>assert.throws(operation,error=>error.code===code);
const childKey=record=>'model.'+record.call.requestId;
const claims=f=>f.control.db.prepare('SELECT * FROM model_step_claims').all();

test('v3 requires a selector-only actual observation and binds profile/body/slot into the durable claim',async t=>{
  const f=await fixture(t,{slots:1,receiverV3:true});
  const record=f.records[0];let selectors=0;
  const journal=new OriginalModelStepJournal({control:f.control,paidAdmission:f.paid,bootstrap:f.host.bootstrap,
    observeReceiver:selector=>{selectors++;
      assert.deepEqual(Object.keys(selector).sort(),['nonce','recipientId','requestId','specDigest','taskId']);
      assert.equal(Object.isFrozen(selector),true);
      return f.observations.get(selector.requestId);
    }});
  const result=journal.claim(f.lease,f.capabilities[0]);
  assert.equal(result.fresh,true);assert.equal(result.runtimeAdmission,'HOLD');assert.equal(selectors,1);
  assert.equal(f.control.effect(childKey(record)).state,'running');
  const claim=claims(f)[0],witness=JSON.parse(claim.witness_json);
  assert.equal(witness.schemaVersion,2);
  assert.equal(witness.receiverProfileSha256,digest(record.receiverProfile));
  assert.equal(witness.normalizedBodySha256,record.body.sha256);
  assert.equal(witness.call.requestId,record.call.requestId);
  assert.deepEqual(witness.call.slot,record.call.slot);
  assert.equal(claim.receiver_sha256,digest(originalModelStepReceiverComparison(record)));
  assert.equal(f.control.db.prepare('SELECT binding_sha256 FROM model_step_slots WHERE parent_key=?').get(f.parentKey).binding_sha256,
    digest({call:record.call,model:record.model,recipients:record.recipients,body:record.body,receiverProfile:record.receiverProfile}));
  let physicalEntries=0;
  denied(()=>f.control.startNativeMissionEffect(f.lease,f.parentKey,()=>{physicalEntries++;}),
    'ORIGINAL_MODEL_STEP_RUNTIME_HOLD');
  assert.equal(physicalEntries,0);
  assert.equal(journal.claim(f.lease,f.capabilities[0]).observationOnly,true);
  f.reopen();
  assert.equal(f.journal.observe(f.capabilities[0]).state,'running');
  assert.equal(f.journal.claim(f.lease,f.capabilities[0]).observationOnly,true);
});

test('missing or changed actual receiver observation prevents a fresh v3 claim',async t=>{
  const f=await fixture(t,{slots:1,receiverV3:true});const record=f.records[0],original=f.observations.get(record.call.requestId);
  const variants=[
    null,
    {...original,normalizedBodyUtf8:original.normalizedBodyUtf8+' '},
    {...original,normalizedBodySha256:'f'.repeat(64)},
    {...original,profile:{...original.profile,normalizerSha256:'f'.repeat(64)}},
    {...original,profile:{...original.profile,generationSha256:'f'.repeat(64)}},
    {...original,profile:{...original.profile,runtimeSha256:'f'.repeat(64)}},
    {...original,profile:{...original.profile,ingressSchemaSha256:'f'.repeat(64)}},
    {...original,profile:{...original.profile,recipientOrigin:'http://127.0.0.1:9000'}},
    {...original,profile:{...original.profile,unexpected:true}},
    {...original,recipientId:'different'},
    {...original,taskId:'different'},
    {...original,specDigest:'f'.repeat(64)},
  ];
  for(const actual of variants){
    if(actual===null)f.observations.delete(record.call.requestId);else f.observations.set(record.call.requestId,actual);
    denied(()=>f.journal.claim(f.lease,f.capabilities[0]));
    assert.equal(f.control.effect(childKey(record)).state,'accepted');assert.equal(claims(f).length,0);
  }
  f.observations.set(record.call.requestId,original);
  assert.equal(f.journal.claim(f.lease,f.capabilities[0]).fresh,true);
});

test('v3 cannot fall back to v2 envelope echo or forge a claim witness',async t=>{
  const f=await fixture(t,{slots:1,receiverV3:true,register:false});const record=f.records[0];
  const noObserver=new OriginalModelStepJournal({control:f.control,paidAdmission:f.paid,bootstrap:f.host.bootstrap,
    compareReceiver:f.host.compareReceiver});
  denied(()=>noObserver.register(f.lease,f.capabilities[0]));
  assert.equal(f.control.db.prepare('SELECT COUNT(*) AS n FROM model_step_bindings').get().n,0);
  f.journal.register(f.lease,f.capabilities[0]);
  const v2Digest=digest({format:'factory-original-model-step-receiver-comparison',schemaVersion:1,
    renderer:record.body.renderer,bodySha256:record.body.sha256,
    modelManifestDigest:record.model.manifestDigest,recipientId:record.call.recipientId});
  denied(()=>modelStepClaimWitness(record,v2Digest,{chargedCents:null,overCommittedCents:0,admittedAt:f.control.clock()}),'MODEL_STEP_CLAIM_REQUIRED');
  assert.equal(claims(f).length,0);
});

test('historical v2 receiver comparison and claim witness retain their exact shape',async t=>{
  const f=await fixture(t,{slots:1});const record=f.records[0];
  const expected={format:'factory-original-model-step-receiver-comparison',schemaVersion:1,
    renderer:record.body.renderer,bodySha256:record.body.sha256,
    modelManifestDigest:record.model.manifestDigest,recipientId:record.call.recipientId};
  assert.deepEqual(originalModelStepReceiverComparison(record),expected);
  f.journal.claim(f.lease,f.capabilities[0]);
  const witness=JSON.parse(claims(f)[0].witness_json);
  assert.equal(witness.schemaVersion,1);
  assert.equal(Object.hasOwn(witness,'receiverProfileSha256'),false);
  assert.equal(Object.hasOwn(witness,'normalizedBodySha256'),false);
  assert.equal(claims(f)[0].receiver_sha256,digest(expected));
});
