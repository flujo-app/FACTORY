import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const helperDirectory = path.join(root, 'modal');
const probePath = path.join(helperDirectory, 'test_http_resume.py');
const sha = value => createHash('sha256').update(value).digest('hex');
// Explicit test dependencies, with no installation or skipped fallback:
// FACTORY_PYTHON: absolute base interpreter path;
// FACTORY_HUB_SITE: absolute owned site-packages with Hub 0.36.0 and Requests;
// FACTORY_PRIVATE_MODULE: absolute trusted private-files module path or file URI.
// FACTORY_HTTP_PROBE_ROOT optionally retains capsules under qualification evidence.
function dependency(name, allowFileUri = false) {
  const value = process.env[name];
  assert.ok(typeof value === 'string' && value.length > 0, `${name} is required for real SDK probes`);
  if (allowFileUri && value.startsWith('file:')) return new URL(value).href;
  assert.ok(path.isAbsolute(value), `${name} must be an absolute path${allowFileUri ? ' or file URI' : ''}`);
  return value;
}
const python = dependency('FACTORY_PYTHON');
const ownedSite = dependency('FACTORY_HUB_SITE');
const privateSource = dependency('FACTORY_PRIVATE_MODULE', true);
const privateFiles = await import(privateSource.startsWith('file:') ? privateSource : pathToFileURL(privateSource).href);
for (const name of ['ensurePrivateDirectory', 'readPrivateJson', 'writePrivateJson']) assert.equal(typeof privateFiles[name], 'function');
// -I -S removes inherited site/.pth initialization. Only the explicitly owned
// SDK directory is added; runpy receives this worktree's probe as an explicit file.
const bootstrap = 'import pathlib,runpy,sys; site=str(pathlib.Path(sys.argv[1]).resolve()); target=sys.argv[2]; sys.path.append(site); sys.argv=sys.argv[2:]; runpy.run_path(target,run_name="__main__")';

async function readRawReceipt(filename) {
  // Python's inherited owner-only file is raw fixture data, not a strict
  // private-helper-owned JSON record. Read it through a bounded descriptor.
  const before = await lstat(filename);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 128 * 1024);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
    assert.equal(opened.size, before.size); assert.ok(opened.isFile() && opened.nlink === 1);
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(filename);
    for (const value of [after, named]) {
      assert.equal(value.dev, opened.dev); assert.equal(value.ino, opened.ino);
      assert.equal(value.size, opened.size); assert.equal(value.mtimeMs, opened.mtimeMs);
      assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink === 1);
    }
    assert.equal(offset, before.size);
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

function validateFixtureFields(receipt) {
  assert.deepEqual(Object.keys(receipt).sort(), ['format', 'version', 'mode', 'success', 'testsRun', 'sourceTupleBefore',
    'sourceTupleAfter', 'sourceUnchanged', 'observations', 'siteInitializationDisabled', 'moduleImports', 'scope'].sort());
  assert.equal(receipt.format, 'factory-real-hub-loopback-resume-probes'); assert.equal(receipt.version, 1);
  assert.equal(receipt.scope, 'Real SDK tiny loopback control-flow evidence; no model/provider call or historical cloud-cause claim.');
  for (const tuple of [receipt.sourceTupleBefore, receipt.sourceTupleAfter]) {
    assert.deepEqual(Object.keys(tuple).sort(), ['probeSha256', 'guardSha256', 'hubVersion', 'fileDownloadSha256',
      'httpBackendSha256', 'requestsVersion', 'requestsSessionsSha256', 'requestsModelsSha256'].sort());
    for (const [key, value] of Object.entries(tuple)) {
      if (key === 'guardSha256' && value === null) continue;
      assert.match(value, key.endsWith('Sha256') ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9.!+-]{1,80}$/);
    }
  }
  assert.ok(Array.isArray(receipt.observations) && receipt.observations.length <= 20);
  for (const row of receipt.observations) {
    assert.match(row.case, /^[a-z0-9-]{1,64}$/);
    if (row.case.startsWith('invalid-identity-')) {
      assert.deepEqual(Object.keys(row).sort(), ['case', 'rejectedBeforeHttp', 'backendRestored'].sort());
      assert.equal(row.rejectedBeforeHttp, true); assert.equal(row.backendRestored, true);
      continue;
    }
    assert.deepEqual(Object.keys(row).sort(), ['case', 'initialBytes', 'actualBytes', 'actualBase64', 'sdkReturned',
      'errorType', 'requests', 'guardReceipt', 'backendRestored'].sort());
    for (const key of ['initialBytes', 'actualBytes']) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 11);
    assert.match(row.actualBase64, /^[A-Za-z0-9+/=]{0,20}$/);
    assert.equal(Buffer.from(row.actualBase64, 'base64').length, row.actualBytes);
    assert.equal(typeof row.sdkReturned, 'boolean'); assert.equal(row.backendRestored, true);
    if (row.errorType !== null) assert.match(row.errorType, /^[A-Za-z][A-Za-z0-9_]{0,79}$/);
    assert.ok(Array.isArray(row.requests) && row.requests.length <= 3);
    for (const request of row.requests) {
      assert.deepEqual(Object.keys(request).sort(), ['path', 'range']);
      assert.ok(['/body', '/retry', '/redirect', '/final'].includes(request.path));
      if (request.range !== null) assert.match(request.range, /^bytes=[0-9]{1,2}-$/);
    }
    if (row.guardReceipt !== null) {
      assert.deepEqual(Object.keys(row.guardReceipt).sort(), ['schemaVersion', 'protocol', 'guardSha256', 'validatedResponses'].sort());
      assert.equal(row.guardReceipt.schemaVersion, 1); assert.equal(row.guardReceipt.protocol, 'http-range-v1');
      assert.match(row.guardReceipt.guardSha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(row.guardReceipt.validatedResponses) && row.guardReceipt.validatedResponses >= 0 && row.guardReceipt.validatedResponses <= 1);
    }
  }
}

async function probes(mode) {
  let parent = os.tmpdir();
  if (process.env.FACTORY_HTTP_PROBE_ROOT !== undefined) {
    parent = dependency('FACTORY_HTTP_PROBE_ROOT');
    await privateFiles.ensurePrivateDirectory(parent);
  }
  const outputDirectory = await mkdtemp(path.join(parent, `factory-modal-http-${mode}-`));
  await privateFiles.ensurePrivateDirectory(outputDirectory);
  const emptyNetrc = path.join(outputDirectory, 'empty.netrc');
  await writeFile(emptyNetrc, '\n', { flag: 'wx', mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMDATA|ALLUSERSPROFILE)$/i.test(key)));
  Object.assign(env, { NETRC: emptyNetrc, HF_HOME: path.join(outputDirectory, 'hf-home'),
    HF_HUB_DISABLE_XET: '1', HF_HUB_ENABLE_HF_TRANSFER: '0', HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_XET_HIGH_PERFORMANCE: '0', PYTHONDONTWRITEBYTECODE: '1' });
  const probeBefore = sha(await readFile(probePath));
  const { stdout, stderr } = await execute(python, ['-I', '-S', '-B', '-c', bootstrap, ownedSite, probePath,
    '--mode', mode, '--owned-site', ownedSite, '--helper-directory', helperDirectory,
    '--output-directory', outputDirectory], { cwd: root, env, windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 });
  const summary = JSON.parse(stdout.trim());
  const receiptRaw = await readRawReceipt(path.join(outputDirectory, 'receipt.private.json'));
  const receipt = JSON.parse(receiptRaw);
  validateFixtureFields(receipt);
  assert.equal(sha(receiptRaw), summary.receiptSha256);
  assert.equal(summary.success, true);
  assert.equal(summary.mode, mode);
  assert.equal(summary.testsRun, mode === 'baseline' ? 2 : 20);
  assert.match(stderr, new RegExp(`Ran ${summary.testsRun} tests`));
  assert.match(stderr, /\bOK\b/);
  assert.doesNotMatch(stderr, /\bFAILED\b|\bskipped\b|Traceback/);
  assert.equal(sha(await readFile(probePath)), probeBefore);
  assert.equal(receipt.success, true);
  assert.equal(receipt.mode, mode);
  assert.equal(receipt.testsRun, summary.testsRun);
  assert.equal(receipt.sourceUnchanged, true);
  assert.deepEqual(receipt.sourceTupleBefore, receipt.sourceTupleAfter);
  assert.equal(receipt.sourceTupleBefore.probeSha256, probeBefore);
  assert.equal(receipt.sourceTupleBefore.hubVersion, '0.36.0');
  assert.equal(receipt.siteInitializationDisabled, true);
  assert.deepEqual(receipt.moduleImports, { modal: false, torch: false, vllm: false, hf_xet: false });
  const validated = { format: 'factory-validated-http-resume-loopback-receipt', version: 1,
    rawPythonReceiptName: 'receipt.private.json', rawPythonReceiptSha256: sha(receiptRaw), receipt };
  const validatedPath = path.join(outputDirectory, 'validated-receipt.private.json');
  await privateFiles.writePrivateJson(validatedPath, validated, { exclusive: true });
  const reread = await privateFiles.readPrivateJson(validatedPath, { maxBytes: 256 * 1024 });
  assert.deepEqual(reread, validated);
  return reread.receipt;
}

test('real unguarded Hub HTTP appends ignored Range and accepts equal-length wrong-start content', async () => {
  const receipt = await probes('baseline');
  assert.equal(receipt.observations.length, 2);
  const ignored = receipt.observations.find(item => item.case === 'ignored-200');
  assert.equal(ignored.sdkReturned, false);
  assert.equal(ignored.initialBytes, 3);
  assert.equal(ignored.actualBytes, 11);
  assert.equal(Buffer.from(ignored.actualBase64, 'base64').toString(), 'abcabcdefgh');
  const wrongStart = receipt.observations.find(item => item.case === 'wrong-start-206');
  assert.equal(wrongStart.sdkReturned, true);
  assert.equal(wrongStart.actualBytes, 8);
  assert.equal(Buffer.from(wrongStart.actualBase64, 'base64').toString(), 'abccdefg');
  assert.ok(receipt.observations.every(item => item.guardReceipt === null && item.backendRestored));
});

test('real guarded Hub rejects invalid resumes before append and preserves recursive retry/redirect offsets', async () => {
  const receipt = await probes('candidate');
  const identity = { schemaVersion: 1, protocol: 'http-range-v1', guardSha256: sha(await readFile(path.join(helperDirectory, 'http_resume.py'))) };
  assert.equal(receipt.sourceTupleBefore.guardSha256, identity.guardSha256);
  assert.equal(receipt.observations.length, 20);
  const recursive = receipt.observations.find(item => item.case === 'retry-valid-redirect');
  assert.equal(recursive.actualBytes, 8);
  assert.equal(Buffer.from(recursive.actualBase64, 'base64').toString(), 'abcdefgh');
  assert.deepEqual(recursive.requests.map(item => item.range), [null, 'bytes=3-', 'bytes=3-']);
  assert.deepEqual(recursive.guardReceipt, { ...identity, validatedResponses: 1 });
  const interrupted = receipt.observations.find(item => item.case === 'retry-ignored-200');
  assert.equal(interrupted.actualBytes, 3);
  assert.equal(Buffer.from(interrupted.actualBase64, 'base64').toString(), 'abc');
  assert.equal(interrupted.errorType, 'HttpResumeError');
  assert.ok(receipt.observations.every(item => item.backendRestored));
});
