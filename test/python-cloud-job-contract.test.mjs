import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bindPythonCloudJob, projectPythonCloudJob, PYTHON_CLOUD_TRUSTED_SUITES } from '../src/python-cloud-job-contract.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const OP = 'd8b5f3b6-1c2d-4e5f-8a9b-123456789abc';
const source = 'def add(a, b):\n    return a + b\n';
const invoiceSource = 'def summarize_invoices(csv_text):\n    raise ValueError("synthetic fixture")\n';
const denied = fn => assert.throws(fn, error => error.code === 'PYTHON_CLOUD_JOB_DENIED');
const pin = bytes => ({ bytes, expectedSha256: sha(bytes) });
const json = value => pin(Buffer.from(JSON.stringify(value)));
function job(invoice = false) {
  const text = invoice ? 'Summarize fictional invoices.' : 'Implement addition.';
  const suite = invoice ? 'arithmetic-and-invoice-v1' : 'arithmetic-v1';
  return { format: 'factory-python-cloud-job', schemaVersion: 1, namespace: 'flujo', jobId: 'python-example', operationId: OP,
    task: { text, sha256: sha(text) }, candidateFiles: [{ path: 'solution.py', sha256: sha(source) }, ...(invoice ? [{ path: 'invoice_report.py', sha256: sha(invoiceSource) }] : [])],
    executor: { id: 'owned-modal-python-runner', buildSha256: '1'.repeat(64) },
    check: { id: 'python-unittest-v1', suite, suiteSha256: PYTHON_CLOUD_TRUSTED_SUITES[suite].sha256, minimum: invoice ? 9 : 3 }, externalSend: null };
}
function request(invoice = false) {
  return { operationId: OP, files: [...(invoice ? [{ path: 'invoice_report.py', content: invoiceSource }] : []), { path: 'solution.py', content: source }] };
}
function response(invoice = false) {
  return { operationId: OP, state: 'COMPLETED', exitCode: 0, testsRun: invoice ? 9 : 3,
    trustedMinimum: invoice ? 9 : 3, trustedSuiteComplete: true, trustedSuite: invoice ? 'arithmetic-and-invoice-v1' : 'arithmetic-v1',
    stdout: 'synthetic output', stderr: `...\nRan ${invoice ? 9 : 3} tests in 0.002s\n\nOK\n`, sandboxId: 'sb-synthetic-unit-test', replayAllowed: false, cleanupConfirmed: true };
}
const evidence = (req = request(), result = response()) => ({ request: json(req), response: json(result) });

test('unexecuted supplied job stays proposed and claims no runtime, application, income or admission', () => {
  const view = projectPythonCloudJob(job());
  assert.equal(view.deliverable, 'proposed'); assert.equal(view.check.status, 'not_supplied');
  assert.equal(view.check.runtimeAuthentication, 'not_authenticated'); assert.equal(view.check.suiteAuthentication, 'not_authenticated');
  assert.equal(view.appliedCode, 'not_applied'); assert.equal(view.income, 'no_evidence'); assert.equal(view.admission, 'NO_ADMISSION');
});
test('original unsorted spaced Python JSON is consumed without a fabricated canonical Node receipt', () => {
  const supplied = evidence();
  const spaced = '{"operationId": "' + OP + '", "state": "COMPLETED", "exitCode": 0, "testsRun": 3, "trustedMinimum": 3, "trustedSuiteComplete": true, "trustedSuite": "arithmetic-v1", "stdout": "π output", "stderr": "...\\nRan 3 tests in 0.002s\\n\\nOK\\n", "sandboxId": "sb-synthetic-unit-test", "replayAllowed": false, "cleanupConfirmed": true}';
  supplied.response = pin(Buffer.from(spaced)); const view = projectPythonCloudJob(job(), supplied);
  assert.equal(view.deliverable, 'checked'); assert.equal(view.check.status, 'passed');
  assert.equal(view.check.requestSha256, supplied.request.expectedSha256); assert.equal(view.check.responseSha256, supplied.response.expectedSha256);
  assert.equal(view.check.provenance, 'supplied_raw_request_and_response'); assert.equal(view.check.runtimeAuthentication, 'not_authenticated');
  assert.equal(view.appliedCode, 'not_applied'); assert.equal(view.income, 'no_evidence'); assert.equal(view.admission, 'NO_ADMISSION');
});
test('invoice selection binds its distinct fixed injected suite and nine-test minimum', () => {
  const view = projectPythonCloudJob(job(true), evidence(request(true), response(true)));
  assert.equal(view.deliverable, 'checked'); assert.equal(view.check.trustedSuite, 'arithmetic-and-invoice-v1'); assert.equal(view.check.trustedMinimum, 9);
  assert.notEqual(PYTHON_CLOUD_TRUSTED_SUITES['arithmetic-v1'].sha256, PYTHON_CLOUD_TRUSTED_SUITES['arithmetic-and-invoice-v1'].sha256);
  assert.equal(PYTHON_CLOUD_TRUSTED_SUITES['arithmetic-and-invoice-v1'].files[1].path, 'test_invoice_contract.py');
  for (const change of [v => v.check.suite = 'arithmetic-v1', v => v.check.suiteSha256 = '2'.repeat(64), v => v.check.minimum = 3]) {
    const input = job(true); change(input); denied(() => bindPythonCloudJob(input));
  }
});
test('fixed injected suite hashes are source pins, separate from candidate-owned tests', () => {
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  for (const suite of Object.values(PYTHON_CLOUD_TRUSTED_SUITES)) assert.equal(suite.sha256, sha(canonical(suite.files)));
  const arithmetic = 'import unittest\nfrom solution import add\n\nclass TrustedArithmeticContract(unittest.TestCase):\n    def test_positive(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_negative(self):\n        self.assertEqual(add(-7, 4), -3)\n    def test_zero(self):\n        self.assertEqual(add(0, 0), 0)\n';
  assert.equal(sha(arithmetic), PYTHON_CLOUD_TRUSTED_SUITES['arithmetic-v1'].files[0].sha256);
  const input = job(); input.candidateFiles.push({ path: 'test_candidate.py', sha256: sha('owned candidate tests') });
  const req = request(); req.files.push({ path: 'test_candidate.py', content: 'owned candidate tests' });
  const result = response(); result.testsRun = 4; result.stderr = 'Ran 4 tests in 0.001s\nOK';
  assert.equal(projectPythonCloudJob(input, evidence(req, result)).deliverable, 'checked');
});
test('job descriptions are copied, deeply frozen and hashed without mutating incoming arrays or bytes', () => {
  const input = job(true), before = structuredClone(input), supplied = evidence(request(true), response(true));
  const bound = bindPythonCloudJob(input), view = projectPythonCloudJob(input, supplied);
  assert.deepEqual(input, before); assert.equal(bound.job.candidateFiles[0].path, 'invoice_report.py');
  input.task.text = 'changed'; input.candidateFiles[0].sha256 = '9'.repeat(64); supplied.response.bytes.fill(0);
  assert.equal(view.deliverable, 'checked'); assert.equal(bound.job.task.text, 'Summarize fictional invoices.');
  assert.ok(Object.isFrozen(bound.job.task)); assert.ok(Object.isFrozen(view.check)); assert.ok(Object.isFrozen(PYTHON_CLOUD_TRUSTED_SUITES));
  assert.throws(() => view.candidateFiles.push({}), TypeError);
});
test('description hash binds task, namespace, job, operation, candidate, executor and external labels', () => {
  const initial = bindPythonCloudJob(job()).sha256;
  const changes = [v => v.namespace = 'other', v => v.jobId = 'other', v => v.operationId = 'e8b5f3b6-1c2d-4e5f-8a9b-123456789abc',
    v => { v.task.text = 'another supplied task'; v.task.sha256 = sha(v.task.text); }, v => v.candidateFiles[0].sha256 = '2'.repeat(64),
    v => v.executor.id = 'other', v => v.executor.buildSha256 = '2'.repeat(64),
    v => v.externalSend = { ownerId: 'owner', scope: 'development-job.external-send', requestSha256: '2'.repeat(64) }];
  for (const change of changes) { const input = job(); change(input); assert.notEqual(bindPythonCloudJob(input).sha256, initial); }
});
test('independent pins reject raw request and response tampering before JSON interpretation', () => {
  for (const side of ['request', 'response']) {
    const supplied = evidence(); supplied[side].bytes[0] ^= 1; denied(() => projectPythonCloudJob(job(), supplied));
    const wrong = evidence(); wrong[side].expectedSha256 = '0'.repeat(64); denied(() => projectPythonCloudJob(job(), wrong));
  }
});
test('recomputed pins cannot hide wrong operation, selected source, extra files or content', () => {
  const changes = [v => v.operationId = 'e8b5f3b6-1c2d-4e5f-8a9b-123456789abc', v => v.files[0].content += '#changed',
    v => v.files[0].path = 'other.py', v => v.files.push({ path: 'other.py', content: '' }), v => v.files[0].sha256 = sha(source)];
  for (const change of changes) { const req = request(); change(req); denied(() => projectPythonCloudJob(job(), evidence(req))); }
  const changed = job(); changed.candidateFiles[0].sha256 = '2'.repeat(64); denied(() => projectPythonCloudJob(changed, evidence()));
  const result = response(); result.operationId = 'e8b5f3b6-1c2d-4e5f-8a9b-123456789abc'; denied(() => projectPythonCloudJob(job(), evidence(request(), result)));
});
test('known nonzero completion remains a failed proposed deliverable, including a short import-failure count', () => {
  const result = response(true); Object.assign(result, { exitCode: 1, testsRun: 1, trustedSuiteComplete: false, stderr: 'Import error\nRan 1 test in 0.001s\nFAILED (errors=1)' });
  const view = projectPythonCloudJob(job(true), evidence(request(true), result));
  assert.equal(view.deliverable, 'proposed'); assert.equal(view.check.status, 'failed'); assert.equal(view.check.cleanupConfirmed, true);
});
test('actual minimal and cleanup-uncertain UNKNOWN shapes stay proposed without replay admission', () => {
  const values = [{ operationId: OP, state: 'UNKNOWN', cleanupConfirmed: false, replayAllowed: false },
    { operationId: OP, state: 'UNKNOWN', code: 'SANDBOX_OR_EXEC_UNKNOWN', cleanupConfirmed: true, replayAllowed: false },
    { operationId: OP, state: 'UNKNOWN', code: 'SANDBOX_CLEANUP_UNKNOWN', cleanupConfirmed: false, replayAllowed: false },
    { ...response(), state: 'UNKNOWN', code: 'SANDBOX_CLEANUP_UNKNOWN', cleanupConfirmed: false }];
  for (const result of values) { const view = projectPythonCloudJob(job(), evidence(request(), result)); assert.equal(view.deliverable, 'proposed'); assert.equal(view.check.status, 'unknown'); assert.equal(view.admission, 'NO_ADMISSION'); }
});
test('UNKNOWN codes refuse contradictory cleanup observations rather than projecting them', () => {
  for (const [code, cleanupConfirmed] of [['SANDBOX_OR_EXEC_UNKNOWN', false], ['SANDBOX_CLEANUP_UNKNOWN', true]]) {
    const result = { operationId: OP, state: 'UNKNOWN', code, cleanupConfirmed, replayAllowed: false };
    denied(() => projectPythonCloudJob(job(), evidence(request(), result)));
  }
});
test('each output stream is bounded independently even when their combined size is below its cap', () => {
  const result = response(); result.stdout = 'a'.repeat(65537);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) < 131072);
  denied(() => projectPythonCloudJob(job(), evidence(request(), result)));
  const other = response(); other.stderr = 'a'.repeat(65537) + '\nRan 3 tests in 0.002s\nOK';
  denied(() => projectPythonCloudJob(job(), evidence(request(), other)));
});
test('lossy MCP projections, empty or mismatched counts, suite drift and cleanup claims refuse', () => {
  const changes = [v => delete v.trustedMinimum, v => delete v.trustedSuite, v => delete v.trustedSuiteComplete, v => v.testsRun = 0,
    v => v.testsRun = 2, v => v.trustedMinimum = 1, v => v.trustedSuite = 'arbitrary-v1', v => v.trustedSuiteComplete = false,
    v => v.stderr = 'Ran 4 tests in 0.001s\nOK', v => v.cleanupConfirmed = false, v => v.replayAllowed = true, v => v.testsPassed = true,
    v => v.exitCode = null, v => v.sandboxId = '', v => v.state = 'ENTERED'];
  for (const change of changes) { const result = response(); change(result); denied(() => projectPythonCloudJob(job(), evidence(request(), result))); }
});
test('named external owner remains gated after checked evidence; authority fields and callbacks refuse', () => {
  const input = job(); input.externalSend = { ownerId: 'business-owner', scope: 'development-job.external-send', requestSha256: sha('supplied request') };
  const view = projectPythonCloudJob(input, evidence()); assert.equal(view.externalSend.status, 'owner_authority_required'); assert.equal(view.admission, 'NO_ADMISSION');
  for (const key of ['appliedCode', 'paymentProof', 'ownerApproved', 'future']) {
    const bad = job(); bad[key] = true; denied(() => bindPythonCloudJob(bad));
    const result = response(); result[key] = true; denied(() => projectPythonCloudJob(job(), evidence(request(), result)));
  }
});
test('getters, proxies, custom prototypes and toJSON never execute during input inspection', () => {
  let invoked = 0;
  const input = job(); Object.defineProperty(input.task, 'text', { enumerable: true, get() { invoked++; return 'bad'; } }); denied(() => bindPythonCloudJob(input));
  const proxy = new Proxy(job(), { getPrototypeOf() { invoked++; return Object.prototype; } }); denied(() => bindPythonCloudJob(proxy));
  const inherited = job(); Object.setPrototypeOf(inherited, { ownerApproved: true }); denied(() => bindPythonCloudJob(inherited));
  const toJSON = job(); toJSON.toJSON = () => { invoked++; return job(); }; denied(() => bindPythonCloudJob(toJSON));
  const supplied = evidence(); Object.defineProperty(supplied.request, 'bytes', { enumerable: true, get() { invoked++; return Buffer.alloc(1); } }); denied(() => projectPythonCloudJob(job(), supplied));
  const outer = evidence(); Object.defineProperty(outer, 'response', { enumerable: true, get() { invoked++; return json(response()); } }); denied(() => projectPythonCloudJob(job(), outer));
  const proxiedBytes = evidence(); proxiedBytes.response.bytes = new Proxy(proxiedBytes.response.bytes, { get() { invoked++; return null; } }); denied(() => projectPythonCloudJob(job(), proxiedBytes));
  assert.equal(invoked, 0);
});
test('duplicate decoded keys, malformed UTF-8, surrogate strings, BOM and trailing JSON refuse', () => {
  const valid = JSON.stringify(response());
  const bad = [Buffer.from([0xc3, 0x28]), Buffer.from('\ufeff' + valid), Buffer.from(valid + '{}'),
    Buffer.from(valid.replace('{', '{"operationId":"ignored",')), Buffer.from(valid.replace('{', '{"operation\\u0049d":"ignored",')),
    Buffer.from(valid.replace('synthetic output', '\\ud800')), Buffer.from(valid.replace('"exitCode":0', '"exitCode":NaN'))];
  for (const bytes of bad) denied(() => projectPythonCloudJob(job(), { request: json(request()), response: pin(bytes) }));
  const duplicateRequest = Buffer.from('{"operationId":"' + OP + '","files":[{"path":"solution.py","path":"solution.py","content":' + JSON.stringify(source) + '}]}');
  denied(() => projectPythonCloudJob(job(), { request: pin(duplicateRequest), response: json(response()) }));
});
test('shared/resizable byte backing, oversized bytes, unsupported paths and reserved injected names refuse', () => {
  for (const bytes of [new Uint8Array(new SharedArrayBuffer(1)), new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 })), Buffer.alloc(256 * 1024 + 1)]) {
    denied(() => projectPythonCloudJob(job(), { request: json(request()), response: pin(bytes) }));
  }
  for (const path of ['../solution.py', '/solution.py', 'secret/solution.py', 'nested/test_trusted_contract.py', 'test_invoice_contract.py', 'solution.js']) {
    const input = job(); input.candidateFiles[0].path = path; denied(() => bindPythonCloudJob(input));
  }
  const duplicate = job(); duplicate.candidateFiles.push({ path: 'SOLUTION.py', sha256: sha(source) }); denied(() => bindPythonCloudJob(duplicate));
  const missing = job(); missing.candidateFiles[0].path = 'other.py'; denied(() => bindPythonCloudJob(missing));
});
