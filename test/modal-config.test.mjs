import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const modalDir = fileURLToPath(new URL('../modal/', import.meta.url));
const config = JSON.parse(readFileSync(join(modalDir, 'config.json'), 'utf8'));
const installedPython = 'C:/Users/Moe/AppData/Local/Programs/Python/Python313/python.exe';
const python = process.env.FACTORY_PYTHON || (existsSync(installedPython) ? installedPython : 'python3');

test('offline endpoint admission and ASGI privacy/cancellation suite', () => {
  const output = execFileSync(python, ['-B', '-m', 'unittest', 'test_policy.py'], {
    cwd: modalDir, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(output, '');
});

test('fake SDK profile, ownership, durable admission and teardown proof suite', () => {
  const output = execFileSync(python, ['-B', '-m', 'unittest', 'test_run_pilot.py'], {
    cwd: modalDir, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(output, '');
});

test('compute projection covers one bounded L4 pool and is explicitly an estimate', () => {
  const rate = config.pricing.gpuPerSecond + config.cpuCores * config.pricing.physicalCpuCorePerSecond
    + (config.memoryMiB / 1024) * config.pricing.gibMemoryPerSecond;
  assert.equal(config.maxContainers, 1);
  assert.equal(config.minContainers, 0);
  assert.equal(config.bufferContainers, 0);
  assert.ok(Math.abs(rate * 3600 - 1.021392) < 0.000001);
  assert.equal(config.pricing.isEstimate, true);
  assert.equal(config.experimentAllocationUsd, 30);
});

test('pinned source metadata and anonymous import are offline', () => {
  assert.match(config.revision, /^[0-9a-f]{40}$/);
  assert.equal(config.license, 'Apache-2.0');
  const code = `import os,sys; sys.path.insert(0,${JSON.stringify(modalDir)}); os.environ['FACTORY_MODAL_APP_NAME']='factory-offline-import'; os.environ['FACTORY_MODAL_VOLUME_NAME']='factory-offline-weights'; import inference; assert inference.app.name == 'factory-offline-import'; print('offline-definition-ok')`;
  const output = execFileSync(python, ['-B', '-c', code], {
    cwd: modalDir, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, MODAL_TOKEN_ID: '', MODAL_TOKEN_SECRET: '' },
  });
  assert.equal(output.trim(), 'offline-definition-ok');
});
