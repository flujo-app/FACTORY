import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const windowsPython = 'C:/Users/Moe/AppData/Local/Programs/Python/Python313/python.exe';
const python = process.env.FACTORY_PYTHON ?? (existsSync(windowsPython) ? windowsPython : 'python3');

test('fixed public model artifact manifest pins thirteen files and four authoritative LFS digests', async () => {
  const raw = await readFile(path.resolve('modal/model-artifacts.json'));
  const manifest = JSON.parse(raw);
  const helper = await readFile(path.resolve('modal/model_artifacts.py'), 'utf8');
  const actualHash = createHash('sha256').update(raw).digest('hex');
  assert.ok(helper.includes(`MANIFEST_SHA256 = "${actualHash}"`));
  assert.equal(raw.includes(13), false);
  assert.equal(manifest.model, 'Qwen/Qwen2.5-Coder-7B-Instruct');
  assert.equal(manifest.revision, 'c03e6d358207e414f1eca0bb1891e29f1db0e242');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.files.length, 13);
  assert.equal(manifest.files.reduce((sum, row) => sum + row.size, 0), 15242805878);
  const shards = manifest.files.filter(row => row.algorithm === 'sha256');
  assert.equal(shards.length, 4);
  assert.deepEqual(shards.map(row => row.name), manifest.index.shards);
  assert.ok(shards.every(row => /^[a-f0-9]{64}$/.test(row.digest)));
  assert.ok(manifest.files.filter(row => !shards.includes(row)).every(row => row.algorithm === 'git-blob-sha1' && /^[a-f0-9]{40}$/.test(row.digest)));
  assert.equal(manifest.index.tensorCount, 339);
  assert.equal(manifest.index.totalSize, 15231233024);
  assert.ok(manifest.source.tree.url.includes(`/tree/${manifest.revision}?`));
  assert.ok(manifest.source.revision.url.endsWith(`/revision/${manifest.revision}`));
});

test('offline Python artifact guard fixtures reject incomplete actual pins and qualify bounded helper reads', async () => {
  const { stdout, stderr } = await runFile(python, ['-B', path.resolve('modal/test_model_artifacts.py'), '-v'], {
    windowsHide: true, timeout: 60_000, maxBuffer: 128 * 1024,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(stdout, '');
  assert.match(stderr, /Ran 25 tests/);
  assert.match(stderr, /\bOK\b/);
  assert.doesNotMatch(stderr, /\bFAILED\b|\bskipped\b|Traceback/);
});
