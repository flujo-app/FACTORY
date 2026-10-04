import { createHash } from 'node:crypto';
import { types } from 'node:util';

/**
 * Pure integration for the existing supervised Python cloud runner, separate from
 * the historical Node development-job v1. No execution or filesystem/network I/O.
 * bindPythonCloudJob(job) copies and freezes a closed supplied description.
 * projectPythonCloudJob(job, {request: {bytes, expectedSha256}, response:
 * {bytes, expectedSha256}}) consumes independently retained original wire bytes.
 * Both pins must come from retained evidence, not from an approval computed over
 * incoming bytes. The request binds operationId and exact candidate source hashes.
 * The response is the original Modal JSON, not the lossy MCP/model projection.
 * Unsorted/spaced Python JSON is accepted; duplicate keys and invalid UTF-8 refuse.
 * Suite hashes below describe the injected service-owned source, with LF newlines,
 * separately from any candidate tests. Suite sha256 hashes canonical file-hash rows.
 * These declared build/suite identities and supplied bytes do not authenticate a
 * runtime or prove adversarial test integrity. Passing evidence yields 'checked',
 * never applied code, income, an external-send capability or dispatch admission.
 */

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const isSha = value => typeof value === 'string' && SHA.test(value);
const id = value => typeof value === 'string' && ID.test(value);
const MAX_REQUEST = 2 * 1024 * 1024, MAX_RESPONSE = 256 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const wellFormed = String.prototype.isWellFormed;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const backingBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get;
const setBytes = Uint8Array.prototype.set;
const denied = () => { throw Object.assign(new Error('Python cloud job contract denied.'), { code: 'PYTHON_CLOUD_JOB_DENIED' }); };
const require = condition => { if (!condition) denied(); };

function freeze(value) {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
const digest = value => sha(Buffer.from(canonical(value)));
const arithmetic = { path: 'test_trusted_contract.py', sha256: '1a3ea01c9b3597f8da0222408c8a623cbe0acfd1e959747c0e343f09b2918da2' };
const invoice = { path: 'test_invoice_contract.py', sha256: 'dc2d0707eb08bdcafd85afb396a2b508824cb6b9f4d5adccaa4d2211b2e48d95' };
export const PYTHON_CLOUD_TRUSTED_SUITES = freeze({
  'arithmetic-v1': { sha256: 'ca047333e7c8d143441df46e13e551f2f395e4fdc2ab0111d6a1d4e83ee66397', minimum: 3, files: [arithmetic] },
  'arithmetic-and-invoice-v1': { sha256: 'a937f534be0265c8998a101a9949e15c1986385e3430cc8471b70251988047e5', minimum: 9, files: [arithmetic, invoice] },
});

// Reject hooks before inspecting descriptors. Only ordinary own data is copied.
function copy(value, depth = 0, seen = new Set()) {
  require(depth <= 12);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { require(wellFormed.call(value) && Buffer.byteLength(value) <= MAX_REQUEST); return value; }
  if (typeof value === 'number') { require(Number.isSafeInteger(value) && !Object.is(value, -0)); return value; }
  require(typeof value === 'object' && !types.isProxy(value) && !seen.has(value));
  const array = Array.isArray(value);
  require(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype));
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  require(keys.length <= 256 && keys.every(k => typeof k === 'string' && Object.hasOwn(ds[k], 'value') && (array && k === 'length' || ds[k].enumerable)));
  seen.add(value);
  let result;
  if (array) {
    const length = ds.length.value;
    require(Number.isSafeInteger(length) && length <= 64 && keys.length === length + 1 && keys.every(k => k === 'length' || /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < length));
    result = Array.from({ length }, (_, i) => copy(ds[String(i)].value, depth + 1, seen));
  } else {
    result = {};
    for (const k of keys) {
      require(!['__proto__', 'constructor', 'prototype'].includes(k));
      Object.defineProperty(result, k, { value: copy(ds[k].value, depth + 1, seen), enumerable: true });
    }
  }
  seen.delete(value); return result;
}
function closed(value, keys) {
  require(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
}
function sourcePath(value) {
  require(typeof value === 'string' && value.length <= 240 && value.endsWith('.py'));
  const parts = value.split('/');
  require(parts.length <= 8 && parts.every(p => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) && !/^(?:auth|credentials?|secrets?|private|config|database|models?|weights|node_modules)$/i.test(p)));
  require(!['test_trusted_contract.py', 'test_invoice_contract.py'].includes(parts.at(-1)));
}

export function bindPythonCloudJob(input) {
  const job = copy(input);
  closed(job, ['format', 'schemaVersion', 'namespace', 'jobId', 'operationId', 'task', 'candidateFiles', 'executor', 'check', 'externalSend']);
  require(job.format === 'factory-python-cloud-job' && job.schemaVersion === 1 && id(job.namespace) && id(job.jobId) && typeof job.operationId === 'string' && UUID.test(job.operationId));
  closed(job.task, ['text', 'sha256']);
  require(typeof job.task.text === 'string' && job.task.text.trim().length > 0 && Buffer.byteLength(job.task.text) <= 16384 && isSha(job.task.sha256) && sha(job.task.text) === job.task.sha256);
  require(Array.isArray(job.candidateFiles) && job.candidateFiles.length >= 1 && job.candidateFiles.length <= 32);
  const names = new Set();
  for (const file of job.candidateFiles) {
    closed(file, ['path', 'sha256']); sourcePath(file.path); require(isSha(file.sha256) && !names.has(file.path.toLowerCase())); names.add(file.path.toLowerCase());
  }
  job.candidateFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  require(job.candidateFiles.some(f => f.path === 'solution.py'));
  closed(job.executor, ['id', 'buildSha256']); require(id(job.executor.id) && isSha(job.executor.buildSha256));
  closed(job.check, ['id', 'suite', 'suiteSha256', 'minimum']);
  const suiteName = job.candidateFiles.some(f => f.path === 'invoice_report.py') ? 'arithmetic-and-invoice-v1' : 'arithmetic-v1';
  const suite = PYTHON_CLOUD_TRUSTED_SUITES[suiteName];
  require(job.check.id === 'python-unittest-v1' && job.check.suite === suiteName && job.check.suiteSha256 === suite.sha256 && job.check.minimum === suite.minimum);
  if (job.externalSend !== null) {
    closed(job.externalSend, ['ownerId', 'scope', 'requestSha256']);
    require(id(job.externalSend.ownerId) && job.externalSend.scope === 'development-job.external-send' && isSha(job.externalSend.requestSha256));
  }
  require(Buffer.byteLength(canonical(job)) <= 65536);
  return freeze({ job, sha256: digest(job), candidateFilesSha256: digest(job.candidateFiles) });
}

// JSON.parse discards duplicate keys. This bounded parser rejects them after escape
// decoding while accepting normal Python json.dumps whitespace/key order.
function parseJson(text) {
  let at = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[at] ?? '\0')) at++; };
  function string() {
    require(text[at] === '"'); const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') { require(at < text.length); at++; }
      else if (c === '"') {
        let value; try { value = JSON.parse(text.slice(start, at)); } catch { denied(); }
        require(wellFormed.call(value)); return value;
      }
    }
    denied();
  }
  function value(depth) {
    require(depth <= 12); space(); const c = text[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; space(); const result = {}, seen = new Set();
      if (text[at] === '}') { at++; return result; }
      while (true) {
        space(); const key = string(); require(!seen.has(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && seen.size < 256); seen.add(key);
        space(); require(text[at++] === ':'); const v = value(depth + 1);
        Object.defineProperty(result, key, { value: v, enumerable: true }); space();
        const delimiter = text[at++]; if (delimiter === '}') return result; require(delimiter === ',');
      }
    }
    if (c === '[') {
      at++; space(); const result = []; if (text[at] === ']') { at++; return result; }
      while (true) {
        require(result.length < 64); result.push(value(depth + 1)); space();
        const delimiter = text[at++]; if (delimiter === ']') return result; require(delimiter === ',');
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
    require(match); at += match[0].length; const result = Number(match[0]); require(Number.isSafeInteger(result) && !Object.is(result, -0)); return result;
  }
  const result = value(0); space(); require(at === text.length); return result;
}
function suppliedPair(supplied) {
  require(supplied && !types.isProxy(supplied) && Object.getPrototypeOf(supplied) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(supplied);
  require(Reflect.ownKeys(ds).length === 2 && ['request', 'response'].every(k => ds[k] && Object.hasOwn(ds[k], 'value') && ds[k].enumerable));
  return { request: ds.request.value, response: ds.response.value };
}
function pinnedJson(supplied, maximum) {
  require(supplied && !types.isProxy(supplied) && Object.getPrototypeOf(supplied) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(supplied);
  require(Reflect.ownKeys(ds).length === 2 && ['bytes', 'expectedSha256'].every(k => ds[k] && Object.hasOwn(ds[k], 'value') && ds[k].enumerable));
  require(isSha(ds.expectedSha256.value)); const value = ds.bytes.value;
  require(value && !types.isProxy(value) && types.isUint8Array(value));
  const length = byteLength.call(value), backing = backingBuffer.call(value);
  require(length > 0 && length <= maximum && !types.isSharedArrayBuffer(backing) && !resizable.call(backing));
  const bytes = new Uint8Array(length); setBytes.call(bytes, value); require(sha(bytes) === ds.expectedSha256.value);
  let parsed; try { parsed = parseJson(utf8.decode(bytes)); } catch { denied(); }
  return { parsed, sha256: ds.expectedSha256.value };
}
function checkRequest(job, request) {
  closed(request, ['operationId', 'files']); require(request.operationId === job.operationId && Array.isArray(request.files) && request.files.length === job.candidateFiles.length);
  const actual = new Map(); let total = 0;
  for (const file of request.files) {
    closed(file, ['path', 'content']); sourcePath(file.path); require(typeof file.content === 'string' && !actual.has(file.path));
    const length = Buffer.byteLength(file.content); total += length; require(length <= 256 * 1024 && total <= 1024 * 1024);
    actual.set(file.path, sha(file.content));
  }
  require(job.candidateFiles.every(f => actual.get(f.path) === f.sha256));
}
const resultFields = ['exitCode', 'testsRun', 'trustedMinimum', 'trustedSuiteComplete', 'trustedSuite', 'stdout', 'stderr', 'sandboxId'];
function checkResponse(job, response) {
  const base = ['operationId', 'state', 'replayAllowed', 'cleanupConfirmed'];
  require(response && typeof response === 'object' && !Array.isArray(response));
  require(response.operationId === job.operationId && response.replayAllowed === false && typeof response.cleanupConfirmed === 'boolean');
  require(['COMPLETED', 'UNKNOWN'].includes(response.state));
  const full = resultFields.some(k => Object.hasOwn(response, k)), code = Object.hasOwn(response, 'code');
  closed(response, [...base, ...(full ? resultFields : []), ...(code ? ['code'] : [])]);
  if (code) require(response.code === 'SANDBOX_OR_EXEC_UNKNOWN' && response.cleanupConfirmed === true ||
    response.code === 'SANDBOX_CLEANUP_UNKNOWN' && response.cleanupConfirmed === false);
  if (response.state === 'COMPLETED') require(full && !code && response.cleanupConfirmed === true);
  else if (full) require(code && response.code === 'SANDBOX_CLEANUP_UNKNOWN' && response.cleanupConfirmed === false);
  else if (!code) require(response.cleanupConfirmed === false);
  if (full) {
    require(Number.isSafeInteger(response.exitCode) && response.exitCode >= -2147483648 && response.exitCode <= 2147483647);
    require(Number.isSafeInteger(response.testsRun) && response.testsRun >= 1 && response.trustedMinimum === job.check.minimum && response.trustedSuite === job.check.suite);
    require(typeof response.trustedSuiteComplete === 'boolean' && response.trustedSuiteComplete === (response.testsRun >= job.check.minimum));
    require(typeof response.stdout === 'string' && typeof response.stderr === 'string' &&
      Buffer.byteLength(response.stdout) <= 65536 && Buffer.byteLength(response.stderr) <= 65536 &&
      Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr) <= 131072);
    require(typeof response.sandboxId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(response.sandboxId));
    const counts = [...response.stderr.matchAll(/(?:^|\n)Ran ([0-9]+) tests? in /g)];
    require(counts.length > 0 && Number(counts.at(-1)[1]) === response.testsRun);
    if (response.exitCode === 0) require(response.trustedSuiteComplete === true);
  }
  return response.state === 'UNKNOWN' ? 'unknown' : response.exitCode === 0 ? 'passed' : 'failed';
}

export function projectPythonCloudJob(input, supplied = null) {
  const binding = bindPythonCloudJob(input); let evidence = { status: 'not_supplied', requestSha256: null, responseSha256: null };
  if (supplied !== null) {
    const pair = suppliedPair(supplied), request = pinnedJson(pair.request, MAX_REQUEST), response = pinnedJson(pair.response, MAX_RESPONSE);
    checkRequest(binding.job, request.parsed);
    evidence = { status: checkResponse(binding.job, response.parsed), requestSha256: request.sha256, responseSha256: response.sha256,
      testsRun: response.parsed.testsRun ?? null, trustedMinimum: response.parsed.trustedMinimum ?? null, trustedSuite: response.parsed.trustedSuite ?? null,
      cleanupConfirmed: response.parsed.cleanupConfirmed };
  }
  return freeze({ format: 'factory-python-cloud-job-projection', schemaVersion: 1,
    namespace: binding.job.namespace, jobId: binding.job.jobId, operationId: binding.job.operationId, jobSha256: binding.sha256,
    candidateFiles: binding.job.candidateFiles, executor: binding.job.executor, declaredCheck: binding.job.check,
    deliverable: evidence.status === 'passed' ? 'checked' : 'proposed',
    check: { ...evidence, provenance: supplied === null ? 'no_receipt' : 'supplied_raw_request_and_response', runtimeAuthentication: 'not_authenticated', suiteAuthentication: 'not_authenticated' },
    appliedCode: 'not_applied', income: 'no_evidence',
    externalSend: binding.job.externalSend === null ? { status: 'not_requested' } : { ...binding.job.externalSend, status: 'owner_authority_required' },
    admission: 'NO_ADMISSION' });
}
