import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalMissionPacket, nativeMissionEffectKey, nativeMissionRequest } from '../src/native-mission-contract.mjs';
import { createOriginalInferenceBootstrap } from '../src/original-inference-contract.mjs';
import { createOriginalReceiverV3HeldContract, originalReceiverV3Digest } from '../src/original-receiver-v3-contract.mjs';

const wireFixture = JSON.parse(readFileSync(new URL('./fixtures/real-flow-sdk-wire-299.json', import.meta.url), 'utf8'));
// Fixed from the PR35 Pydantic/Factory ASGI capture. JSON.stringify would
// rewrite Python's float 1.0 as 1 and change this authenticated commitment.
const receiverNormalizedUtf8 =
  '{"max_tokens":8,"messages":[{"content":"offline bridge fixture","role":"user"},{"content":"","role":"system"}],'
  + '"model":"sha256:1111111111111111111111111111111111111111111111111111111111111111",'
  + '"n":1,"prompt_cache_key":"flujo-c1c5k0kx","stream":true,"stream_options":{"include_usage":true},"temperature":1.0}';
const receiverNormalizedSha256 = 'ab288a143d34de92156f01d0d4c4f5d05bbdc51eda4a335e16c8816205cd08b7';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(canonicalMissionPacket(value), 'utf8');
const clone = value => structuredClone(value);
const denied = operation => assert.throws(operation, error => error.code === 'ORIGINAL_RECEIVER_V3_DENIED');
const proof = Buffer.from('fixture-original-signature-only');

function record() {
  const classification = { confidentialityClass: 'ordinary', classVersion: 1 };
  const call = { requestId: 'a'.repeat(32), nonce: 'b'.repeat(32), slot: { nodeId: 'model-node', ordinal: 0 },
    principalId: 'developer-fixture', role: 'developer', recipientId: 'community-fixture' };
  const model = { manifestDigest: 'sha256:' + '1'.repeat(64), revision: '3'.repeat(40), numBlocks: 64, policyVersion: 1 };
  const recipient = { id: 'community-fixture', principalId: call.principalId, role: call.role,
    kind: 'communityai-coordinator', origin: 'https://communityai.invalid',
    identitySha256: '4'.repeat(64), buildSha256: '5'.repeat(64), generationSha256: '6'.repeat(64), classification };
  const sender = { principalId: 'factory-original-fixture', role: 'physical-owner' };
  const credential = { ownerId: sender.principalId, credentialId: 'communityai-fixture', generationSha256: '7'.repeat(64) };
  const receiver = { profile: { format: 'factory-communityai-receiver-profile', schemaVersion: 2,
    recipientId: recipient.id, recipientOrigin: recipient.origin,
    recipientIdentitySha256: recipient.identitySha256, recipientBuildSha256: recipient.buildSha256,
    recipientGenerationSha256: recipient.generationSha256, endpoint: '/v1/chat/completions',
    ingressSchemaSha256: '8'.repeat(64), normalizerSha256: '9'.repeat(64), runtimeSha256: 'a'.repeat(64),
    bodyPolicy: 'strict-stream-usage-cache-key-v1' },
    normalizedBody: { canonicalUtf8: receiverNormalizedUtf8, byteLength: Buffer.byteLength(receiverNormalizedUtf8),
      sha256: receiverNormalizedSha256 } };
  const nativeMission = { schemaVersion: 1, missionId: 'c'.repeat(32), cellId: 'child', app: 'factory-child',
    provisionKey: 'provision', worker: { workspace: 'mission', archiveSha256: 'd'.repeat(64),
      compatibility: { applicationVersion: '3.46.0', snapshotFormatVersion: 2, layoutVersion: 2,
        workerProtocolVersion: 1, revision: 'e'.repeat(40) } },
    flowId: 'flow', flowSha256: 'f'.repeat(64), paid: { provider: 'modal', ceilingCents: 500 } };
  const plan = { format: 'factory-original-call-plan', schemaVersion: 3, slots: [{ requestId: call.requestId,
    nonce: call.nonce, slot: call.slot, bindingSha256: '0'.repeat(64),
    receiverProfileSha256: '0'.repeat(64), requiredOutcome: 'succeeded' }] };
  const specification = { problem: 'synthetic receiver contract', acceptance: ['held comparison only'], baseline: 'fixture',
    nativeMission, taskType: 'software', originalInference: { schemaVersion: 3, classification,
      issuerId: 'fixture-issuer', keyId: 'fixture-key', factoryId: 'fixture-factory', originId: 'fixture-original',
      completeOriginalSha256: '2'.repeat(64), planSha256: '0'.repeat(64), plan } };
  const lease = { scope: 'task', scopeId: 'develop', cellId: 'child', epoch: 1, controlEpoch: 1,
    expires: 1791078600000, tokenSha256: '3'.repeat(64) };
  const result = { format: 'factory-original-inference', schemaVersion: 3,
    canonicalization: 'factory-json-safe-integer-v1', issuer: { id: 'fixture-issuer', keyId: 'fixture-key' },
    authority: { factoryId: 'fixture-factory', originId: 'fixture-original', contractVersion: 3 },
    classification, task: { id: 'develop', projectId: 'fixture', branch: 'codex/develop',
      specification, specDigest: '0'.repeat(64) }, parent: null, lease, reservation: null, call, model,
    recipient, sender, credential, wire: clone(wireFixture), receiver, plan };
  rebind(result);
  return result;
}
function rebind(r) {
  r.plan.slots[0].bindingSha256 = originalReceiverV3Digest({ call: r.call, model: r.model, recipient: r.recipient,
    sender: r.sender, credential: r.credential, wire: r.wire, receiver: r.receiver });
  r.plan.slots[0].receiverProfileSha256 = originalReceiverV3Digest(r.receiver.profile);
  r.task.specification.originalInference.planSha256 = originalReceiverV3Digest(r.plan);
  r.task.specDigest = originalReceiverV3Digest(r.task.specification);
  const request = nativeMissionRequest({ id: r.task.id, project_id: r.task.projectId, branch: r.task.branch,
    specification: r.task.specification, spec_digest: r.task.specDigest }, r.lease, resolve(tmpdir(), 'factory-v3-held.private.json'));
  r.parent = { request, requestSha256: originalReceiverV3Digest(request), effectKey: nativeMissionEffectKey(request) };
  r.reservation = { reservationId: 'paid.' + r.parent.effectKey, provider: 'modal', ceilingCents: 500 };
}
function observation(r) {
  return { format: 'factory-original-receiver-held-projection', schemaVersion: 1,
    taskId: r.task.id, specDigest: r.task.specDigest, requestId: r.call.requestId, nonce: r.call.nonce,
    recipientId: r.recipient.id, authenticatedSenderPrincipalId: r.sender.principalId,
    credential: clone(r.credential), method: r.wire.method, url: r.wire.url,
    headers: clone(r.wire.headers), headersSha256: r.wire.headersSha256,
    bodyUtf8: r.wire.bodyUtf8, bodyByteLength: r.wire.bodyByteLength, bodySha256: r.wire.bodySha256,
    receiverProfile: clone(r.receiver.profile), normalizedBody: clone(r.receiver.normalizedBody), state: 'HELD_BEFORE_POST' };
}
function host(r, observed = observation(r)) {
  const bytes = encode(r), envelopeSha256 = sha(bytes);
  let selected = 0;
  const contract = createOriginalReceiverV3HeldContract({ issuerId: 'fixture-issuer', keyId: 'fixture-key',
    verifyOriginal(input) {
      assert.equal(input.envelopeSha256, envelopeSha256);
      assert.deepEqual(input.proofBytes, proof);
      return { format: 'factory-original-inference-authentication', schemaVersion: 3,
        issuerId: 'fixture-issuer', keyId: 'fixture-key', envelopeSha256,
        principalId: r.call.principalId, requestId: r.call.requestId, nonce: r.call.nonce,
        specDigest: r.task.specDigest, planSha256: r.task.specification.originalInference.planSha256 };
    },
    observeHeldProjection(selector) {
      selected++;
      assert.equal(Object.isFrozen(selector), true);
      assert.deepEqual(Object.keys(selector).sort(), ['nonce', 'recipientId', 'requestId', 'specDigest', 'taskId']);
      return observed;
    } });
  return { contract, bytes, get selected() { return selected; } };
}

test('captured real Flow SDK wire is exactly 299 UTF-8 bytes with ten ordered non-auth headers', () => {
  assert.equal(Buffer.byteLength(wireFixture.bodyUtf8), 299);
  assert.equal(sha(Buffer.from(wireFixture.bodyUtf8)), 'b86e125b6a031a226acc03147b5d865402ad149a621626fcdbf7629f5541fd03');
  assert.equal(sha(Buffer.from(JSON.stringify(wireFixture.headers))), '5c668061cec85492e188b639ee64c642ebbe255a2de197b738d4d05d69188389');
  assert.equal(wireFixture.method, 'POST');
  assert.equal(wireFixture.url, 'https://communityai.invalid/v1/chat/completions');
  assert.equal(wireFixture.headers.length, 10);
  assert.equal(Buffer.byteLength(receiverNormalizedUtf8), 307);
  assert.equal(sha(Buffer.from(receiverNormalizedUtf8)), receiverNormalizedSha256);
  assert.notEqual(receiverNormalizedSha256, wireFixture.bodySha256);
});

test('synthetic trusted pre-POST projection yields only a held comparison and v2 witness candidate', () => {
  const r = record(), f = host(r), capability = f.contract.authenticate(f.bytes, proof);
  const result = f.contract.compareHeld(capability);
  assert.equal(f.selected, 1);
  assert.equal(result.comparison.schemaVersion, 2);
  assert.equal(result.comparison.wireBodySha256, wireFixture.bodySha256);
  assert.equal(result.comparison.wireBodyByteLength, 299);
  assert.equal(result.comparison.headersSha256, wireFixture.headersSha256);
  assert.equal(result.comparison.credentialGenerationSha256, r.credential.generationSha256);
  assert.equal(result.comparison.senderPrincipalId, r.sender.principalId);
  assert.equal(result.claimWitness.schemaVersion, 2);
  assert.equal(result.claimWitness.task.planSha256, r.task.specification.originalInference.planSha256);
  assert.equal(result.claimWitness.envelopeSha256, sha(f.bytes));
  assert.equal(result.claimWitness.receiverSha256, result.comparisonSha256);
  assert.equal(result.claimWitness.runtimeAdmission, 'HOLD');
  assert.equal(result.claimWitness.physicalAttempt, 'NONE');
  assert.equal(Object.isFrozen(result.claimWitness), true);
  assert.equal(f.contract.inspect(capability).runtimeAdmission, 'HOLD');
});

test('wire, profile, plan and specification edits require fresh matching Original authentication', () => {
  const r = record(), f = host(r);
  for (const mutate of [
    x => { x.wire.bodyUtf8 += ' '; },
    x => { x.wire.headers[0][1] = 'text/plain'; },
    x => { x.credential.generationSha256 = 'f'.repeat(64); rebind(x); },
    x => { x.receiver.profile.runtimeSha256 = 'f'.repeat(64); rebind(x); },
    x => { x.receiver.normalizedBody.canonicalUtf8 += ' '; rebind(x); },
    x => { x.call.slot.ordinal = 1; rebind(x); },
  ]) {
    const changed = clone(r); mutate(changed);
    denied(() => f.contract.authenticate(encode(changed), proof));
  }
});

test('a newly signed binding still refuses changed observed sender, credential, wire or receiver', () => {
  const r = record();
  for (const mutate of [
    x => { x.authenticatedSenderPrincipalId = 'other-owner'; },
    x => { x.credential.generationSha256 = 'f'.repeat(64); },
    x => { x.method = 'GET'; },
    x => { x.url = 'https://communityai.invalid/v1/completions'; },
    x => { x.headers.reverse(); },
    x => { x.bodyUtf8 += ' '; },
    x => { x.bodyByteLength = 298; },
    x => { x.receiverProfile.ingressSchemaSha256 = 'f'.repeat(64); },
    x => { x.receiverProfile.normalizerSha256 = 'f'.repeat(64); },
    x => { x.receiverProfile.runtimeSha256 = 'f'.repeat(64); },
    x => { x.normalizedBody.sha256 = 'f'.repeat(64); },
    x => { x.state = 'POSTED'; },
    x => { x.extra = true; },
  ]) {
    const changed = observation(r); mutate(changed);
    const f = host(r, changed), cap = f.contract.authenticate(f.bytes, proof);
    denied(() => f.contract.compareHeld(cap));
  }
});

test('freshly rebound signed wire and credential cannot borrow an older held observation', () => {
  const original = record(), retained = observation(original);
  const changed = clone(original);
  changed.wire.bodyUtf8 = changed.wire.bodyUtf8.replace('flujo-c1c5k0kx', 'flujo-c1c5k0ky');
  changed.wire.bodySha256 = sha(Buffer.from(changed.wire.bodyUtf8));
  changed.credential.generationSha256 = 'f'.repeat(64);
  rebind(changed);
  const f = host(changed, retained), cap = f.contract.authenticate(f.bytes, proof);
  denied(() => f.contract.compareHeld(cap));
});

test('version collision, missing observer and caller-made capability cannot enter the held contract', () => {
  const r = record();
  for (const mutate of [
    x => { x.schemaVersion = 2; },
    x => { x.authority.contractVersion = 2; },
    x => { x.plan.schemaVersion = 2; rebind(x); },
    x => { x.task.specification.originalInference.schemaVersion = 2; rebind(x); },
    x => { x.receiver.profile.schemaVersion = 1; rebind(x); },
  ]) {
    const changed = clone(r); mutate(changed);
    const f = host(changed);
    denied(() => f.contract.authenticate(f.bytes, proof));
  }
  const f = host(r), cap = f.contract.authenticate(f.bytes, proof);
  denied(() => f.contract.compareHeld(Object.freeze({ ...cap })));
  const absent = host(r, null), absentCap = absent.contract.authenticate(absent.bytes, proof);
  denied(() => absent.contract.compareHeld(absentCap));
  assert.equal(f.contract.compareHeld(cap).runtimeAdmission, 'HOLD');
  const old = createOriginalInferenceBootstrap({ issuerId: 'fixture-issuer', keyId: 'fixture-key', verifyOriginal() { throw new Error('not reached'); } });
  assert.throws(() => old.authenticate(f.bytes, proof), error => error.code === 'ORIGINAL_INFERENCE_DENIED');
});
