import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createOriginalInferenceBootstrap } from '../src/original-inference-contract.mjs';
import { nativeMissionRequest, nativeMissionEffectKey } from '../src/native-mission-contract.mjs';

const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
const sha = v => createHash('sha256').update(v).digest('hex');
const encoded = v => Buffer.from(canonical(v));
const proof = Buffer.from('owned-synthetic-proof');
const denied = operation => assert.throws(operation, e => e.code === 'ORIGINAL_INFERENCE_DENIED' && e.message === 'Original inference provenance denied.' && !Object.hasOwn(e, 'cause'));
function fixture({ callId = 'd'.repeat(32), taskId = 'develop', problem = 'Improve FLUJO' } = {}) {
  const nativeMission = { schemaVersion: 1, missionId: 'b'.repeat(32), cellId: 'child', app: 'factory-child', provisionKey: 'provision', worker: { workspace: 'mission', archiveSha256: 'a'.repeat(64), compatibility: { applicationVersion: '3.46.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1, revision: 'c'.repeat(40) } }, flowId: 'flow', flowSha256: 'f'.repeat(64), paid: { provider: 'modal', ceilingCents: 500 } };
  const model = { manifestDigest: 'sha256:' + '1'.repeat(64), revision: '3'.repeat(40), numBlocks: 24, policyVersion: 1 };
  const call = { requestId: callId, nonce: '2'.repeat(32), slot: { nodeId: 'model-node', ordinal: 0 }, principalId: 'developer-agent', role: 'developer', recipientId: 'community-local' };
  const recipients = [{ id: 'community-local', principalId: 'developer-agent', role: 'developer', kind: 'communityai-coordinator', origin: 'http://127.0.0.1:8000', identitySha256: '4'.repeat(64), buildSha256: '5'.repeat(64), generationSha256: '6'.repeat(64), classification: { confidentialityClass: 'ordinary', classVersion: 1 } }];
  const canonicalUtf8 = '{"messages":[{"content":"Hello 世界","role":"user"}],"model":"' + model.manifestDigest + '","n":1,"stream":false,"temperature":1.0,"top_p":1e-07}';
  const body = { kind: 'chat', renderer: 'communityai-python-json-v1', canonicalUtf8, sha256: sha(Buffer.from(canonicalUtf8)) };
  const plan = { format: 'factory-original-call-plan', schemaVersion: 1, slots: [{ requestId: call.requestId, nonce: call.nonce, slot: call.slot,
    bindingSha256: sha(encoded({ call, model, recipients, body })), requiredOutcome: 'succeeded' }] };
  const originalInference = { schemaVersion: 1, classification: { confidentialityClass: 'ordinary', classVersion: 1 }, issuerId: 'owned-issuer', keyId: 'key-v1',
    factoryId: 'factory-original', originId: 'trusted-ingress', completeOriginalSha256: '7'.repeat(64), planSha256: sha(encoded(plan)), plan };
  const specification = { taskType: 'software', problem, acceptance: ['independent review'], baseline: 'fixture', nativeMission, originalInference };
  const task = { id: taskId, projectId: 'factory', branch: 'codex/develop', specification, specDigest: sha(encoded(specification)) };
  const lease = { scope: 'task', scopeId: taskId, cellId: 'child', epoch: 1, controlEpoch: 2, expires: 1791066000000, tokenSha256: 'e'.repeat(64) };
  const request = nativeMissionRequest({ id: task.id, project_id: task.projectId, branch: task.branch, specification, spec_digest: task.specDigest }, lease, resolve('owned-output.private.json'));
  const effectKey = nativeMissionEffectKey(request);
  return { format: 'factory-original-inference', schemaVersion: 2, canonicalization: 'factory-json-safe-integer-v1',
    issuer: { id: 'owned-issuer', keyId: 'key-v1' }, authority: { factoryId: 'factory-original', originId: 'trusted-ingress', contractVersion: 2 },
    classification: { confidentialityClass: 'ordinary', classVersion: 1 }, task, parent: { request, requestSha256: sha(encoded(request)), effectKey }, lease,
    reservation: { reservationId: 'paid.' + effectKey, provider: 'modal', ceilingCents: 500 }, call, model, recipients, body, plan };
}
function rebindProjection(record) {
  const slot = record.plan.slots.find(s => s.requestId === record.call.requestId);
  slot.bindingSha256 = sha(encoded({ call: record.call, model: record.model, recipients: record.recipients, body: record.body }));
  const spec = record.task.specification; spec.originalInference.planSha256 = sha(encoded(record.plan));
  record.task.specDigest = sha(encoded(spec));
  const request = nativeMissionRequest({ id: record.task.id, project_id: record.task.projectId, branch: record.task.branch, specification: spec, spec_digest: record.task.specDigest }, record.lease, record.parent.request.outputFile);
  record.parent = { request, requestSha256: sha(encoded(request)), effectKey: nativeMissionEffectKey(request) };
  record.reservation.reservationId = 'paid.' + record.parent.effectKey; return record;
}
function host(records = [fixture()], override) {
  const originals = new Map(records.map(r => [sha(encoded(r)), structuredClone(r)]));
  const counters = { verifier: 0, credential: 0, database: 0 };
  const bootstrap = createOriginalInferenceBootstrap({ issuerId: 'owned-issuer', keyId: 'key-v1', verifyOriginal: input => {
    counters.verifier++;
    if (override) return override(input);
    assert.deepEqual(input.proofBytes, proof); const record = originals.get(input.envelopeSha256);
    if (!record) throw new Error('Untrusted envelope');
    return { format: 'factory-original-inference-authentication', schemaVersion: 1, issuerId: 'owned-issuer', keyId: 'key-v1', envelopeSha256: input.envelopeSha256, principalId: record.call.principalId, requestId: record.call.requestId, nonce: record.call.nonce };
  } });
  const run = (input, p = proof) => bootstrap.withVerified(bootstrap.authenticate(input, p), record => { counters.credential++; counters.database++; return record; });
  return { bootstrap, counters, run };
}
function rebody(record, source) { record.body.canonicalUtf8 = source; record.body.sha256 = sha(Buffer.from(source)); return rebindProjection(record); }
function leaves(v, prefix = []) { return v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => leaves(x, [...prefix, k])) : [[prefix, v]]; }
function set(root, path, value) { let at = root; for (const key of path.slice(0, -1)) at = at[key]; at[path.at(-1)] = value; }

test('verified complete original lineage yields only a local frozen provenance capability', () => {
  const r = fixture(), h = host([r]), capability = h.bootstrap.authenticate(encoded(r), proof);
  const view = h.bootstrap.inspect(capability);
  assert.equal(view.scope, 'provenance-only'); assert.equal(view.runtimeAdmission, 'HOLD'); assert.equal(view.requestId, r.call.requestId);
  assert.equal(Object.isFrozen(capability), true); assert.equal(Object.isFrozen(view), true);
  h.bootstrap.withVerified(capability, value => { assert.deepEqual(value, r); assert.equal(Object.isFrozen(value.task.specification.nativeMission.worker), true); });
  assert.deepEqual(h.counters, { verifier: 1, credential: 0, database: 0 });
});
test('identical body bytes remain distinct authenticated calls and full original specifications', () => {
  const a = fixture(), b = fixture({ callId: '7'.repeat(32), taskId: 'review', problem: 'Review FLUJO' });
  assert.equal(a.body.sha256, b.body.sha256); const h = host([a, b]);
  const av = h.bootstrap.inspect(h.bootstrap.authenticate(encoded(a), proof)), bv = h.bootstrap.inspect(h.bootstrap.authenticate(encoded(b), proof));
  assert.notEqual(av.requestId, bv.requestId); assert.notEqual(av.specDigest, bv.specDigest); assert.notEqual(av.envelopeSha256, bv.envelopeSha256);
});
test('altering every bound scalar rejects the request before simulated operational factories', t => {
  const r = fixture(), h = host([r]); let changed = 0;
  for (const [path, value] of leaves(r)) {
    const mutation = structuredClone(r); set(mutation, path, typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : value + 'x');
    denied(() => h.run(encoded(mutation))); changed++;
  }
  t.diagnostic('Mutated and refused ' + changed + ' authenticated scalar bindings.');
  assert.ok(changed > 0); assert.equal(h.counters.credential, 0); assert.equal(h.counters.database, 0);
});
for (const mutation of ['missing-class', 'confidential', 'unknown-class', 'version', 'recipient-confidential', 'unknown-field', 'incomplete-spec', 'unknown-spec-field']) {
  test('unsupported ' + mutation + ' refuses before the configured verifier and factories', () => {
    const r = fixture(), h = host([r]);
    if (mutation === 'missing-class') delete r.classification;
    if (mutation === 'confidential') r.classification.confidentialityClass = 'confidential';
    if (mutation === 'unknown-class') r.classification.confidentialityClass = 'future';
    if (mutation === 'version') r.classification.classVersion = 2;
    if (mutation === 'recipient-confidential') r.recipients[0].classification.confidentialityClass = 'confidential';
    if (mutation === 'unknown-field') r.call.extra = true;
    if (mutation === 'incomplete-spec') delete r.task.specification.acceptance;
    if (mutation === 'unknown-spec-field') r.task.specification.unclassifiedContext = 'not silently omitted';
    denied(() => h.run(encoded(r))); assert.deepEqual(h.counters, { verifier: 0, credential: 0, database: 0 });
  });
}
test('recomputed outer digest cannot hide native full-spec, parent lease, body or recipient inconsistency', () => {
  const variants = [r => r.task.specification.problem = 'changed', r => r.parent.request.packet.problem = 'changed', r => r.lease.epoch++, r => r.body.sha256 = '0'.repeat(64), r => r.call.recipientId = 'absent', r => r.recipients.push(structuredClone(r.recipients[0])), r => delete r.task.specification.nativeMission.worker.compatibility.revision, r => r.model.manifestDigest = 'sha256:' + '9'.repeat(64), r => r.reservation.provider = 'fly'];
  for (const change of variants) { const r = fixture(); change(r); const h = host([r]); denied(() => h.run(encoded(r))); assert.equal(h.counters.verifier, 0); assert.equal(h.counters.credential, 0); }
});
test('exact Python floating lexemes and Unicode are hashed without JS reserialization', () => {
  const r = fixture(), h = host([r]); assert.notEqual(sha(encoded(JSON.parse(r.body.canonicalUtf8))), r.body.sha256);
  assert.equal(h.run(encoded(r)).body.canonicalUtf8, r.body.canonicalUtf8);
  const changed = structuredClone(r); changed.body.canonicalUtf8 = canonical(JSON.parse(r.body.canonicalUtf8));
  denied(() => h.run(encoded(changed)));
});
test('completion projection has a separate closed shape', () => {
  const r = fixture(); r.body.kind = 'completion'; rebody(r, '{"model":"' + r.model.manifestDigest + '","n":1,"prompt":["a","b"],"stream":true}'); const h = host([r]); assert.equal(h.run(encoded(r)).body.kind, 'completion');
});
test('closed chat projection accepts typed text content and declared defaults', () => {
  const r = fixture(); rebody(r, '{"enable_thinking":false,"messages":[{"content":[{"text":"hello","type":"text"}],"role":"developer"}],"model":"' + r.model.manifestDigest + '","n":1,"stream":false}'); const h = host([r]); assert.equal(h.run(encoded(r)).body.sha256, r.body.sha256);
});
test('invalid projection structure, duplicate keys, nonfinite values and tool roles fail before verification', () => {
  const valid = fixture().body.canonicalUtf8;
  const invalid = [valid.replace('"n":1', '"n":1,"n":1'), valid.replace('"n":1', '"n":1.0'), valid.replace('"n":1', '"n":1,"request_id":"caller"'), valid.replace('"role":"user"', '"role":"tool"'), valid.replace('1.0', '1e999'), valid.replace('1.0', '1e-999'), valid.replace('1.0', 'null'), valid.replace('"n":1', '"n":2'), valid.replace('"stream":false', '"stream":null'), valid.replace('Hello 世界', '\\ud800'), valid.replace('Hello 世界', '\\u4e16'), valid.replace('"messages":', ' "messages":'), valid + ' ', valid.replace('"model":', '"zmodel":')];
  for (const source of invalid) { const r = rebody(fixture(), source), h = host([r]); denied(() => h.run(encoded(r))); assert.equal(h.counters.verifier, 0); }
});
test('strict UTF8, BOM, lone surrogates and noncanonical envelopes fail without external calls', () => {
  const r = fixture(), h = host([r]), good = encoded(r);
  const invalid = [Buffer.from([0xc0, 0xaf]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]), Buffer.from(good.toString().replace('Improve FLUJO', '\\ud800')), Buffer.from(good.toString().replace('"schemaVersion":1', '"schemaVersion":1.0')), Buffer.from(good.toString().replace('"format":', '"format":"x","format":')), Buffer.from(' ' + good), Buffer.from(good.toString().replace('"ordinal":0', '"ordinal":-0'))];
  for (const b of invalid) denied(() => h.run(b)); assert.deepEqual(h.counters, { verifier: 0, credential: 0, database: 0 });
});
test('byte and recursion bounds reject before verification', () => {
  const r = fixture(), h = host([r]); denied(() => h.run(Buffer.alloc(262145, 32))); denied(() => h.run(encoded(r), Buffer.alloc(4097)));
  r.body.canonicalUtf8 = '['.repeat(34) + '0' + ']'.repeat(34); r.body.sha256 = sha(Buffer.from(r.body.canonicalUtf8)); denied(() => h.run(encoded(r)));
  const deep = fixture(); deep.task.specification.problem = 'x'.repeat(262145); denied(() => h.run(encoded(deep)));
  assert.equal(h.counters.verifier, 0);
});
test('claimant objects, proxy bytes and shared memory execute no accessors or proxy traps', () => {
  let calls = 0; const h = host();
  const accessor = Object.defineProperty({}, 'classification', { get() { calls++; throw new Error('secret'); } });
  const proxy = new Proxy(encoded(fixture()), { get() { calls++; throw new Error('secret'); }, getPrototypeOf() { calls++; throw new Error('secret'); } });
  denied(() => h.run(accessor)); denied(() => h.run(proxy)); denied(() => h.run(new Uint8Array(new SharedArrayBuffer(128))));
  const bytes = encoded(fixture()); Object.defineProperty(bytes, 'byteLength', { get() { calls++; throw new Error('secret'); } }); assert.equal(h.run(bytes).call.requestId, fixture().call.requestId);
  assert.equal(calls, 0);
});
test('wrong proof is refused by the configured out-of-band verifier with generic errors', () => {
  const h = host(); denied(() => h.run(encoded(fixture()), Buffer.from('wrong proof'))); assert.equal(h.counters.credential, 0);
});
for (const result of [true, null, {}, { then() { throw new Error('must not invoke'); } }, function* () { yield true; }]) {
  test('truthy, malformed, thenable and generator verifier returns do not authenticate', () => { const h = host([fixture()], () => typeof result === 'function' ? result() : result); denied(() => h.run(encoded(fixture()))); assert.equal(h.counters.credential, 0); });
}
test('resolved and rejected async verifier results are denied without leaking rejection text', async () => {
  for (const verify of [() => Promise.resolve(true), () => Promise.reject(new Error('synthetic-secret'))]) { const h = host([fixture()], verify); denied(() => h.run(encoded(fixture()))); assert.equal(h.counters.credential, 0); }
  await new Promise(resolve => setImmediate(resolve));
});
test('verifier exceptions and accessor/proxy receipt errors have no secret cause or excerpt', () => {
  let traps = 0;
  for (const verify of [() => { throw new Error('synthetic-secret'); }, () => new Proxy({}, { ownKeys() { traps++; throw new Error('synthetic-secret'); } }), () => Object.defineProperty({}, 'format', { get() { traps++; throw new Error('synthetic-secret'); } })]) { const h = host([fixture()], verify); denied(() => h.run(encoded(fixture()))); assert.equal(h.counters.database, 0); }
  assert.equal(traps, 0);
});
test('each verifier receipt binding is required, even when callback says success', () => {
  const r = fixture(), fields = ['format', 'schemaVersion', 'issuerId', 'keyId', 'envelopeSha256', 'principalId', 'requestId', 'nonce'];
  for (const field of fields) {
    const h = host([r], input => { const receipt = { format: 'factory-original-inference-authentication', schemaVersion: 1, issuerId: 'owned-issuer', keyId: 'key-v1', envelopeSha256: input.envelopeSha256, principalId: r.call.principalId, requestId: r.call.requestId, nonce: r.call.nonce }; receipt[field] = field === 'schemaVersion' ? 2 : 'wrong'; return receipt; });
    denied(() => h.run(encoded(r))); assert.equal(h.counters.credential, 0);
  }
});
test('caller and verifier byte mutation cannot change the admitted copied record', () => {
  const r = fixture(), envelope = encoded(r), originalSha = sha(envelope), p = Buffer.from(proof);
  const h = host([r], input => { input.envelopeBytes.fill(0); input.proofBytes.fill(0); envelope.fill(0); p.fill(0); return { format: 'factory-original-inference-authentication', schemaVersion: 1, issuerId: 'owned-issuer', keyId: 'key-v1', envelopeSha256: originalSha, principalId: r.call.principalId, requestId: r.call.requestId, nonce: r.call.nonce }; });
  const cap = h.bootstrap.authenticate(envelope, p); assert.equal(h.bootstrap.inspect(cap).envelopeSha256, originalSha);
  h.bootstrap.withVerified(cap, record => { assert.deepEqual(record, r); assert.throws(() => record.call.role = 'reviewer', TypeError); });
});
test('forged, serialized, proxy and another bootstrap capabilities cannot reach factories', () => {
  const h = host(), other = host(), cap = h.bootstrap.authenticate(encoded(fixture()), proof); let reached = 0;
  for (const fake of [{}, JSON.parse(JSON.stringify(cap)), new Proxy(cap, {}), other.bootstrap.authenticate(encoded(fixture()), proof), null]) denied(() => h.bootstrap.withVerified(fake, () => reached++));
  assert.equal(reached, 0);
});
test('configuration accessor or proxy is refused rather than evaluated as authority', () => {
  let touched = 0;
  const cfg = Object.defineProperty({ issuerId: 'x', keyId: 'x' }, 'verifyOriginal', { get() { touched++; return () => true; } });
  denied(() => createOriginalInferenceBootstrap(cfg)); denied(() => createOriginalInferenceBootstrap(new Proxy({}, { getPrototypeOf() { touched++; throw new Error('secret'); } }))); assert.equal(touched, 0);
});
test('repeated authentication remains provenance and makes no durable or runtime admission claim', () => {
  const h = host(), input = encoded(fixture()), a = h.bootstrap.authenticate(input, proof), b = h.bootstrap.authenticate(input, proof);
  assert.notEqual(a, b); assert.deepEqual(h.bootstrap.inspect(a), h.bootstrap.inspect(b)); assert.equal(h.bootstrap.inspect(a).runtimeAdmission, 'HOLD');
  assert.equal(h.counters.database, 0); assert.equal(h.counters.credential, 0);
});
