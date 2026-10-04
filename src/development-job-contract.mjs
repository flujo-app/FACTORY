import { createHash } from 'node:crypto';
import { types } from 'node:util';

/**
 * Source-only development job protocol v1. No execution, filesystem or network I/O.
 * bindDevelopmentJob(job) copies, validates and freezes the closed job description;
 * its digest binds the namespace, task, candidate hashes, executor build and check.
 * projectDevelopmentJob(job, { bytes, expectedSha256 }) consumes canonical UTF-8
 * factory-development-check-receipt v1 bytes, with an independently supplied pin.
 * Example: const binding = bindDevelopmentJob(job);
 *   const view = projectDevelopmentJob(binding.job, { bytes, expectedSha256 });
 * A receipt contains jobSha256: binding.sha256, candidateFilesSha256:
 * binding.candidateFilesSha256, and the job's namespace/jobId/task.sha256/executor/check.
 * The only recipe is node-test-v1 targeting a candidate test/*.test.mjs file;
 * its declared argv is exactly ['node', '--test', target]. The host owns execution.
 * Canonical JSON sorts object keys, preserves arrays, and permits safe integers only.
 * The expected receipt digest must come from independent retained evidence, not be
 * calculated as an approval from the same untrusted incoming bytes. Digests and
 * declared executor identities do not authenticate a runtime, caller or execution.
 * A supplied completed passing check yields 'checked'; other results stay 'proposed'.
 * Applied code is always 'not_applied', income always 'no_evidence'. External-send
 * owner/scope/request labels always require a trusted owner bridge outside v1;
 * this module issues no capability and every projection has NO_ADMISSION.
 */

const SHA = /^[a-f0-9]{64}$/;
const isSha = value => typeof value === 'string' && SHA.test(value);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const id = value => typeof value === 'string' && ID.test(value);
const MAX_BYTES = 65536;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const setBytes = Uint8Array.prototype.set;
const isWellFormed = String.prototype.isWellFormed;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const denied = () => { throw Object.assign(new Error('Development job contract denied.'), { code: 'DEVELOPMENT_JOB_DENIED' }); };
const require = condition => { if (!condition) denied(); };

function copy(value, depth = 0, seen = new Set()) {
  require(depth <= 12);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    require(isWellFormed.call(value) && Buffer.byteLength(value) <= MAX_BYTES);
    return value;
  }
  if (typeof value === 'number') { require(Number.isSafeInteger(value) && !Object.is(value, -0)); return value; }
  require(typeof value === 'object' && !types.isProxy(value) && !seen.has(value));
  const array = Array.isArray(value);
  require(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  require(keys.length <= 256 && keys.every(key => typeof key === 'string'));
  require(keys.every(key => Object.hasOwn(descriptors[key], 'value') &&
    (array && key === 'length' || descriptors[key].enumerable)));
  seen.add(value);
  let result;
  if (array) {
    const length = descriptors.length.value;
    require(Number.isSafeInteger(length) && length <= 64 && keys.length === length + 1);
    require(keys.every(key => key === 'length' || /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length));
    result = Array.from({ length }, (_, i) => copy(descriptors[String(i)].value, depth + 1, seen));
  } else {
    result = {};
    for (const key of keys) {
      require(key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
      Object.defineProperty(result, key, { value: copy(descriptors[key].value, depth + 1, seen), enumerable: true });
    }
  }
  seen.delete(value);
  return result;
}

function closed(value, keys) {
  require(value && !Array.isArray(value) && typeof value === 'object');
  require(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const digest = value => sha(Buffer.from(canonical(value)));
function path(value) {
  require(typeof value === 'string' && value.length <= 256 && value.length > 0);
  require(value.split('/').every(part => /^[a-zA-Z0-9_.-]{1,128}$/.test(part) && part !== '.' && part !== '..'));
}

export function bindDevelopmentJob(input) {
  const job = copy(input);
  closed(job, ['format', 'schemaVersion', 'namespace', 'jobId', 'task', 'candidateFiles', 'executor', 'check', 'externalSend']);
  require(job.format === 'factory-development-job' && job.schemaVersion === 1 && id(job.namespace) && id(job.jobId));
  closed(job.task, ['text', 'sha256']);
  require(typeof job.task.text === 'string' && job.task.text.trim().length > 0 && Buffer.byteLength(job.task.text) <= 16384);
  require(isSha(job.task.sha256) && sha(Buffer.from(job.task.text)) === job.task.sha256);
  require(Array.isArray(job.candidateFiles) && job.candidateFiles.length > 0 && job.candidateFiles.length <= 32);
  const names = new Set();
  for (const file of job.candidateFiles) {
    closed(file, ['path', 'sha256']); path(file.path); require(isSha(file.sha256));
    require(!names.has(file.path.toLowerCase())); names.add(file.path.toLowerCase());
  }
  job.candidateFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  closed(job.executor, ['id', 'buildSha256']);
  require(id(job.executor.id) && isSha(job.executor.buildSha256));
  closed(job.check, ['id', 'target']);
  require(job.check.id === 'node-test-v1'); path(job.check.target);
  require(/^test\/.+\.test\.mjs$/.test(job.check.target) && job.candidateFiles.some(file => file.path === job.check.target));
  if (job.externalSend !== null) {
    closed(job.externalSend, ['ownerId', 'scope', 'requestSha256']);
    require(id(job.externalSend.ownerId) && job.externalSend.scope === 'development-job.external-send' && isSha(job.externalSend.requestSha256));
  }
  require(Buffer.byteLength(canonical(job)) <= MAX_BYTES);
  return freeze({ job, sha256: digest(job), candidateFilesSha256: digest(job.candidateFiles) });
}

function receiptBytes(value) {
  require(value && !types.isProxy(value) && types.isUint8Array(value));
  const length = byteLength.call(value), backing = buffer.call(value);
  require(length > 0 && length <= MAX_BYTES && !types.isSharedArrayBuffer(backing));
  require(!Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get.call(backing));
  const bytes = new Uint8Array(length); setBytes.call(bytes, value); return bytes;
}

function checkReceipt(binding, supplied) {
  // Inspect metadata without traversing the typed-array bytes or invoking accessors.
  require(supplied && !types.isProxy(supplied) && Object.getPrototypeOf(supplied) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(supplied);
  require(Reflect.ownKeys(ds).length === 2 && ['bytes', 'expectedSha256'].every(key =>
    ds[key] && Object.hasOwn(ds[key], 'value') && ds[key].enumerable));
  const expectedSha256 = ds.expectedSha256.value;
  require(isSha(expectedSha256));
  const bytes = receiptBytes(ds.bytes.value);
  require(sha(bytes) === expectedSha256);
  let text, receipt;
  try { text = utf8.decode(bytes); receipt = copy(JSON.parse(text)); } catch { denied(); }
  require(canonical(receipt) === text);
  closed(receipt, ['format', 'schemaVersion', 'jobSha256', 'namespace', 'jobId', 'taskSha256', 'candidateFilesSha256', 'executor', 'check', 'argv', 'state', 'outcome', 'exitCode', 'signal', 'counts', 'stdoutSha256', 'stderrSha256']);
  const job = binding.job;
  require(receipt.format === 'factory-development-check-receipt' && receipt.schemaVersion === 1);
  require(receipt.jobSha256 === binding.sha256 && receipt.namespace === job.namespace && receipt.jobId === job.jobId &&
    receipt.taskSha256 === job.task.sha256 && receipt.candidateFilesSha256 === binding.candidateFilesSha256);
  require(canonical(receipt.executor) === canonical(job.executor) && canonical(receipt.check) === canonical(job.check));
  require(canonical(receipt.argv) === canonical(['node', '--test', job.check.target]));
  require(['completed', 'pending', 'unknown'].includes(receipt.state) && ['passed', 'failed', 'unknown', 'not_run'].includes(receipt.outcome));
  require(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode) && receipt.exitCode >= 0 && receipt.exitCode <= 255);
  require(receipt.signal === null || typeof receipt.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(receipt.signal));
  closed(receipt.counts, ['passed', 'failed', 'cancelled', 'skipped', 'todo']);
  require(Object.values(receipt.counts).every(n => Number.isSafeInteger(n) && n >= 0));
  require(isSha(receipt.stdoutSha256) && isSha(receipt.stderrSha256));
  let status = 'unknown';
  if (receipt.state === 'pending') status = 'pending';
  else if (receipt.state === 'completed' && receipt.outcome === 'failed') status = 'failed';
  if (receipt.outcome === 'passed') {
    require(receipt.state === 'completed' && receipt.exitCode === 0 && receipt.signal === null &&
      receipt.counts.passed > 0 && ['failed', 'cancelled', 'skipped', 'todo'].every(key => receipt.counts[key] === 0));
    status = 'passed';
  }
  return { status, receiptSha256: expectedSha256 };
}

export function projectDevelopmentJob(input, suppliedReceipt = null) {
  const binding = bindDevelopmentJob(input);
  const result = suppliedReceipt === null ? { status: 'not_supplied', receiptSha256: null } : checkReceipt(binding, suppliedReceipt);
  return freeze({
    format: 'factory-development-job-projection', schemaVersion: 1,
    namespace: binding.job.namespace, jobId: binding.job.jobId, jobSha256: binding.sha256,
    candidateFiles: binding.job.candidateFiles,
    deliverable: result.status === 'passed' ? 'checked' : 'proposed',
    check: { ...result, provenance: suppliedReceipt === null ? 'no_receipt' : 'supplied_receipt', runtimeAuthentication: 'not_authenticated' },
    appliedCode: 'not_applied', income: 'no_evidence',
    externalSend: binding.job.externalSend === null ? { status: 'not_requested' } : { ...binding.job.externalSend, status: 'owner_authority_required' },
    admission: 'NO_ADMISSION',
  });
}
