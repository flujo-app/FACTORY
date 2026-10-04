import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFixtureOwnerWire} from '../src/fixture-owner-wire.mjs';
import {fixedWireCommitment,fixedWireProjection} from './fixtures/owner-wire-input.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'factory-wire-'));
  const databasePath = path.join(dir,'fixture.sqlite'), commitment = fixedWireCommitment();
  let time = 10000;
  const options = {databasePath,commitment,now:()=>time};
  let owner = createFixtureOwnerWire(options);
  t.after(()=>owner.close()); t.diagnostic('Owned offline fixture: '+dir);
  return {commitment,options,get owner(){return owner;},advance(ms){time+=ms;},reopen(){owner.close();owner=createFixtureOwnerWire(options);},
    start(enter){return owner.startFixtureFlow({taskId:commitment.taskId,startNonce:commitment.startNonce},enter);},
    child(parent){return owner.issueFixedSlot({parent,slotId:commitment.slotId});}};
}
const code = value => ({code:value});

test('commits the fixture start before pre-model work and suppresses duplicate entry',async t=>{
  const f=await fixture(t); let entries=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const first=f.start(async()=>{entries++;assert.equal(f.owner.observe().parent.state,'running');assert.ok(f.owner.observe().parent.witness);await gate;});
  const second=await f.start(()=>{entries++;});
  assert.equal(second.kind,'observation');assert.equal(entries,1);release();await first;
  assert.throws(()=>f.owner.abort(),code('FIXTURE_PARENT_ALREADY_STARTED'));
  assert.throws(()=>f.owner.authorizeNativePost(),code('FIXTURE_PRODUCTION_HOLD'));
});

test('an interrupted pre-model parent survives restart without entry or fresh child authority',async t=>{
  const f=await fixture(t);let effects=0;
  await assert.rejects(f.start(()=>{effects++;throw new Error('pre-model interruption');}),/pre-model interruption/);
  assert.equal(f.owner.observe().parent.state,'unknown');assert.equal(f.owner.observe().child,null);
  f.reopen();const observed=await f.start(()=>{effects++;});assert.equal(observed.kind,'observation');assert.equal(effects,1);
  assert.throws(()=>f.child(observed.parent),code('FIXTURE_RESUME_HOLD'));
  assert.throws(()=>f.owner.abort(),code('FIXTURE_PARENT_ALREADY_STARTED'));
});

test('rejects untrusted start and child handles before entry',async t=>{
  const f=await fixture(t);let entered=0;
  await assert.rejects(f.owner.startFixtureFlow({taskId:f.commitment.taskId,startNonce:'wrong'},()=>{entered++;}),code('FIXTURE_PARENT_START_DENIED'));
  assert.equal(entered,0);assert.equal(f.owner.observe().parent,null);
  assert.throws(()=>f.child({}),code('FIXTURE_CHILD_REQUIRED'));
  assert.throws(()=>f.owner.dispatch({},fixedWireProjection()),code('FIXTURE_CHILD_REQUIRED'));
  assert.throws(()=>f.owner.abort(),code('FIXTURE_ABORT_UNSUPPORTED'));
});

test('claims exact bytes once, preserves unknown and observes the same claim after OFF and restart',async t=>{
  const f=await fixture(t);let capability;
  await assert.rejects(f.start(parent=>{capability=f.child(parent);f.owner.dispatch(capability,fixedWireProjection());}),code('PHYSICAL_SEND_HOLD'));
  const original=f.owner.observe();assert.equal(original.parent.state,'unknown');assert.equal(original.child.state,'unknown');
  assert.equal(original.physicalSend,'HOLD');assert.equal(original.receiverQualification,'HOLD');
  f.owner.setOff(true);f.advance(50000);
  assert.throws(()=>f.owner.dispatch(capability,fixedWireProjection()),code('FIXTURE_ALREADY_CLAIMED'));
  f.reopen();let reentries=0;const observed=await f.start(()=>{reentries++;});assert.equal(reentries,0);
  assert.throws(()=>f.owner.dispatch(f.child(observed.parent),fixedWireProjection()),code('FIXTURE_ALREADY_CLAIMED'));
  assert.deepEqual(f.owner.observe().child,original.child);
});

for(const [label,mutate] of [
  ['body',p=>{p.body[0]=32;}],['URL',p=>{p.url+='?other';}],['model',p=>{p.model.name='sha256:'+'2'.repeat(64);}],
  ['owner',p=>{p.model.ownerCredentialBinding.ownerId='other';}],['headers',p=>{p.headers[0][1]='text/plain';}],
  ['routing',p=>{p.routingHeaderSha256.openaiProject='0'.repeat(64);}],['extra key',p=>{p.uncommitted=true;}]
]) test('refuses changed '+label+' before claiming while retaining parent start',async t=>{
  const f=await fixture(t),projection=fixedWireProjection();mutate(projection);
  await assert.rejects(f.start(parent=>f.owner.dispatch(f.child(parent),projection)),code('FIXTURE_WIRE_MISMATCH'));
  assert.equal(f.owner.observe().child,null);assert.equal(f.owner.observe().parent.state,'unknown');
});

for(const [label,change,expected] of [
  ['OFF',f=>f.owner.setOff(true),'FIXTURE_OFF'],
  ['expiry',f=>f.advance(10000),'FIXTURE_LEASE_EXPIRED'],
  ['credential generation',f=>f.owner.setCredentialGeneration('fixture-generation-2'),'FIXTURE_CREDENTIAL_GENERATION']
]) test('final '+label+' refusal retains the started parent with zero claims',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.start(parent=>{const child=f.child(parent);change(f);f.owner.dispatch(child,fixedWireProjection());}),code(expected));
  assert.equal(f.owner.observe().parent.state,'unknown');assert.equal(f.owner.observe().child,null);
});

test('two owner connections retain one durable claim',async t=>{
  const f=await fixture(t),other=createFixtureOwnerWire(f.options);t.after(()=>other.close());
  await assert.rejects(f.start(parent=>f.owner.dispatch(f.child(parent),fixedWireProjection())),code('PHYSICAL_SEND_HOLD'));
  const seen=await other.startFixtureFlow({taskId:f.commitment.taskId,startNonce:f.commitment.startNonce},()=>{throw new Error('must not enter');});
  const child=other.issueFixedSlot({parent:seen.parent,slotId:f.commitment.slotId});
  assert.throws(()=>other.dispatch(child,fixedWireProjection()),code('FIXTURE_ALREADY_CLAIMED'));
  assert.deepEqual(other.observe().child,f.owner.observe().child);
});

test('a failed first child cannot be retried through retained handles',async t=>{
  const f=await fixture(t);let parent,child;
  await assert.rejects(f.start(p=>{parent=p;child=f.child(p);const changed=fixedWireProjection();changed.url+='?changed';f.owner.dispatch(child,changed);}),code('FIXTURE_WIRE_MISMATCH'));
  assert.throws(()=>f.child(parent),code('FIXTURE_RESUME_HOLD'));
  assert.throws(()=>f.owner.dispatch(child,fixedWireProjection()),code('FIXTURE_RESUME_HOLD'));
  assert.equal(f.owner.observe().child,null);
});

test('rejects a sparse array with a supplied map without executing it',async t=>{
  const f=await fixture(t),projection=fixedWireProjection();let methodCalls=0;
  const expected=projection.headers;const changed=expected.slice();delete changed[0];
  changed.map=()=>{methodCalls++;return expected;};projection.headers=changed;
  await assert.rejects(f.start(parent=>f.owner.dispatch(f.child(parent),projection)),code('FIXTURE_COMMITMENT_INVALID'));
  assert.equal(methodCalls,0);assert.equal(f.owner.observe().child,null);
});

test('a returned parent handle cannot start a deferred model call',async t=>{
  const f=await fixture(t);let parent,child;
  await f.start(p=>{parent=p;child=f.child(p);});
  assert.throws(()=>f.child(parent),code('FIXTURE_RESUME_HOLD'));
  assert.throws(()=>f.owner.dispatch(child,fixedWireProjection()),code('FIXTURE_RESUME_HOLD'));
  assert.equal(f.owner.observe().child,null);
});

test('an aborted request signal refuses before claiming',async t=>{
  const f=await fixture(t),abort=new AbortController();abort.abort();
  await assert.rejects(f.start(parent=>f.owner.dispatch(f.child(parent),{...fixedWireProjection(),signal:abort.signal})),code('FIXTURE_REQUEST_ABORTED'));
  assert.equal(f.owner.observe().child,null);assert.equal(f.owner.observe().parent.state,'unknown');
});

test('a changed commitment cannot reopen the fixture database',async t=>{
  const f=await fixture(t),changed=structuredClone(f.commitment);changed.nonce='changed';
  assert.throws(()=>createFixtureOwnerWire({...f.options,commitment:changed}),code('FIXTURE_COMMITMENT_CHANGED'));
});
