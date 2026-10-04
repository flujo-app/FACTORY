import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bindDevelopmentJob, projectDevelopmentJob } from '../src/development-job-contract.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ?
  '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const denied = fn => assert.throws(fn, error => error.code === 'DEVELOPMENT_JOB_DENIED');
function job() {
  const text = 'Improve FLUJO startup feedback.';
  return { format: 'factory-development-job', schemaVersion: 1, namespace: 'flujo', jobId: 'startup-feedback',
    task: { text, sha256: sha(text) }, candidateFiles: [
      { path: 'test/startup.test.mjs', sha256: '2'.repeat(64) }, { path: 'src/startup.mjs', sha256: '1'.repeat(64) },
    ], executor: { id: 'owned-code-executor', buildSha256: '3'.repeat(64) },
    check: { id: 'node-test-v1', target: 'test/startup.test.mjs' }, externalSend: null };
}
function receipt(input = job()) {
  const binding = bindDevelopmentJob(input);
  return { format: 'factory-development-check-receipt', schemaVersion: 1, jobSha256: binding.sha256,
    namespace: input.namespace, jobId: input.jobId, taskSha256: input.task.sha256, candidateFilesSha256: binding.candidateFilesSha256,
    executor: structuredClone(input.executor), check: structuredClone(input.check), argv: ['node', '--test', input.check.target],
    state: 'completed', outcome: 'passed', exitCode: 0, signal: null,
    counts: { passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, stdoutSha256: sha('synthetic TAP'), stderrSha256: sha('') };
}
const supplied = value => { const bytes = Buffer.from(canonical(value)); return { bytes, expectedSha256: sha(bytes) }; };

test('a proposed candidate makes no execution, applied-code, income or admission claim', () => {
  const view = projectDevelopmentJob(job());
  assert.equal(view.deliverable, 'proposed'); assert.equal(view.check.status, 'not_supplied');
  assert.equal(view.check.provenance, 'no_receipt'); assert.equal(view.appliedCode, 'not_applied');
  assert.equal(view.income, 'no_evidence'); assert.equal(view.admission, 'NO_ADMISSION');
});
test('exact supplied passing evidence yields checked with explicit unauthenticated provenance', () => {
  const input = job(), evidence = supplied(receipt(input)), view = projectDevelopmentJob(input, evidence);
  assert.equal(view.deliverable, 'checked'); assert.equal(view.check.status, 'passed');
  assert.equal(view.check.receiptSha256, evidence.expectedSha256); assert.equal(view.check.provenance, 'supplied_receipt');
  assert.equal(view.check.runtimeAuthentication, 'not_authenticated'); assert.equal(view.appliedCode, 'not_applied');
  assert.equal(view.income, 'no_evidence'); assert.equal(view.admission, 'NO_ADMISSION');
});
test('copied and deeply frozen projections retain no mutable job or receipt input', () => {
  const input = job(), evidence = supplied(receipt(input)), binding = bindDevelopmentJob(input), view = projectDevelopmentJob(input, evidence);
  input.task.text = 'mutated'; input.candidateFiles[0].sha256 = '9'.repeat(64); input.executor.id = 'changed'; evidence.bytes.fill(0);
  assert.equal(binding.job.task.text, 'Improve FLUJO startup feedback.'); assert.equal(view.candidateFiles[1].sha256, '2'.repeat(64));
  assert.equal(view.deliverable, 'checked'); assert.ok(Object.isFrozen(binding.job.task)); assert.ok(Object.isFrozen(view.check));
  assert.throws(() => view.candidateFiles.push({}), TypeError);
});
test('every job scope binding refuses the unchanged old receipt', () => {
  const input = job(), evidence = supplied(receipt(input));
  const changes = [v => v.namespace = 'other', v => v.jobId = 'other', v => { v.task.text = 'Another task'; v.task.sha256 = sha(v.task.text); },
    v => v.candidateFiles[0].sha256 = '9'.repeat(64), v => v.executor.id = 'other', v => v.executor.buildSha256 = '9'.repeat(64),
    v => { v.check.target = 'test/another.test.mjs'; v.candidateFiles.push({ path: v.check.target, sha256: '4'.repeat(64) }); }];
  for (const change of changes) { const changed = structuredClone(input); change(changed); denied(() => projectDevelopmentJob(changed, evidence)); }
});
test('independently pinned raw bytes refuse tampering before receipt interpretation', () => {
  const evidence = supplied(receipt()); evidence.bytes[0] ^= 1; denied(() => projectDevelopmentJob(job(), evidence));
  const wrong = supplied(receipt()); wrong.expectedSha256 = '0'.repeat(64); denied(() => projectDevelopmentJob(job(), wrong));
});
test('recomputed raw digest cannot hide receipt scope or fixed recipe mismatch', () => {
  const changes = [v => v.jobSha256 = '9'.repeat(64), v => v.namespace = 'other', v => v.jobId = 'other',
    v => v.taskSha256 = '9'.repeat(64), v => v.candidateFilesSha256 = '9'.repeat(64), v => v.executor.id = 'other',
    v => v.check.id = 'arbitrary-shell', v => v.argv.push('--eval', 'send()'), v => v.schemaVersion = 2];
  for (const change of changes) { const value = receipt(); change(value); denied(() => projectDevelopmentJob(job(), supplied(value))); }
});
test('pending and unknown results remain proposed; a failed check is not a pass', () => {
  for (const state of ['pending', 'unknown']) {
    const value = receipt(); Object.assign(value, { state, outcome: 'unknown', exitCode: null });
    const view = projectDevelopmentJob(job(), supplied(value)); assert.equal(view.deliverable, 'proposed'); assert.equal(view.check.status, state);
  }
  const value = receipt(); Object.assign(value, { outcome: 'failed', exitCode: 1 }); value.counts.failed = 1;
  const view = projectDevelopmentJob(job(), supplied(value)); assert.equal(view.check.status, 'failed'); assert.equal(view.deliverable, 'proposed');
});
test('pending, unknown, nonzero, signalled, empty or incomplete checks cannot claim passed', () => {
  const changes = [v => v.state = 'pending', v => v.state = 'unknown', v => v.exitCode = 1, v => v.exitCode = null,
    v => v.signal = 'SIGTERM', v => v.counts.passed = 0, ...['failed', 'cancelled', 'skipped', 'todo'].map(key => v => v.counts[key] = 1)];
  for (const change of changes) { const value = receipt(); change(value); denied(() => projectDevelopmentJob(job(), supplied(value))); }
});
test('closed v1 refuses applied, payment, authority flags, callbacks and future fields', () => {
  for (const key of ['appliedCode', 'paymentProof', 'ownerApproved', 'verifyOwner', 'future']) {
    const input = job(); let invoked = false; input[key] = key === 'verifyOwner' ? async () => { invoked = true; return true; } : true;
    denied(() => projectDevelopmentJob(input)); assert.equal(invoked, false);
    const value = receipt(); value[key] = true; denied(() => projectDevelopmentJob(job(), supplied(value)));
  }
});
test('named external-send owner remains gated even after a supplied passing check', () => {
  const input = job(); input.externalSend = { ownerId: 'business-owner', scope: 'development-job.external-send', requestSha256: sha('exact proposed outbound request') };
  const view = projectDevelopmentJob(input, supplied(receipt(input)));
  assert.equal(view.deliverable, 'checked'); assert.equal(view.externalSend.ownerId, 'business-owner');
  assert.equal(view.externalSend.status, 'owner_authority_required'); assert.equal(view.admission, 'NO_ADMISSION');
  const changed = structuredClone(input); changed.externalSend.ownerId = 'other';
  denied(() => projectDevelopmentJob(changed, supplied(receipt(input))));
  input.externalSend.ownerApproved = true; denied(() => projectDevelopmentJob(input));
});
test('getter, prototype, toJSON and proxy hooks are rejected without invocation', () => {
  let invoked = 0;
  const input = job(); Object.defineProperty(input.task, 'text', { enumerable: true, get() { invoked++; return 'wrong'; } });
  denied(() => projectDevelopmentJob(input));
  const withToJSON = job(); withToJSON.toJSON = () => { invoked++; return job(); }; denied(() => projectDevelopmentJob(withToJSON));
  const inherited = job(); Object.setPrototypeOf(inherited, { ownerApproved: true }); denied(() => projectDevelopmentJob(inherited));
  const proxy = new Proxy(job(), { getPrototypeOf() { invoked++; return Object.prototype; } }); denied(() => projectDevelopmentJob(proxy));
  const evidence = supplied(receipt()); Object.defineProperty(evidence, 'bytes', { enumerable: true, get() { invoked++; return Buffer.alloc(1); } });
  denied(() => projectDevelopmentJob(job(), evidence)); assert.equal(invoked, 0);
});
test('malformed UTF-8, duplicate keys, whitespace and shared receipt memory are refused', () => {
  const valid = canonical(receipt());
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from(' ' + valid), Buffer.from(valid.replace('{', '{"jobId":"ignored",'))]) {
    denied(() => projectDevelopmentJob(job(), { bytes, expectedSha256: sha(bytes) }));
  }
  const shared = new Uint8Array(new SharedArrayBuffer(1)); denied(() => projectDevelopmentJob(job(), { bytes: shared, expectedSha256: sha(shared) }));
  denied(() => projectDevelopmentJob(job(), { bytes: Promise.resolve(Buffer.from(valid)), expectedSha256: sha(valid) }));
});
test('candidate path ambiguity, stale task digest and unsupported check targets refuse', () => {
  const changes = [v => v.task.text += ' changed', v => v.candidateFiles[0].path = '../outside.mjs',
    v => v.candidateFiles.push({ path: 'SRC/startup.mjs', sha256: '4'.repeat(64) }), v => v.check.id = 'shell',
    v => v.check.target = 'test/absent.test.mjs', v => v.candidateFiles[0].sha256 = 'SHA256:bad'];
  for (const change of changes) { const input = job(); change(input); denied(() => projectDevelopmentJob(input)); }
});
test('digest arrays and objects never coerce into valid SHA text', () => {
  for (const malformed of [['a'.repeat(64)], { digest: 'a'.repeat(64) }]) {
    const changes = [v => v.task.sha256 = malformed, v => v.candidateFiles[0].sha256 = malformed,
      v => v.executor.buildSha256 = malformed, v => { v.externalSend = { ownerId: 'owner', scope: 'development-job.external-send', requestSha256: malformed }; }];
    for (const change of changes) { const input = job(); change(input); denied(() => projectDevelopmentJob(input)); }
    for (const key of ['stdoutSha256', 'stderrSha256']) { const value = receipt(); value[key] = malformed; denied(() => projectDevelopmentJob(job(), supplied(value))); }
    const evidence = supplied(receipt()); evidence.expectedSha256 = malformed; denied(() => projectDevelopmentJob(job(), evidence));
  }
  for (const key of ['namespace', 'jobId']) { const input = job(); input[key] = 1; denied(() => projectDevelopmentJob(input)); }
});
