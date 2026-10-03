import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modalDir = fileURLToPath(new URL('../modal/', import.meta.url));
const installedPython = 'C:/Users/Moe/AppData/Local/Programs/Python/Python313/python.exe';
const python = process.env.FACTORY_PYTHON || (existsSync(installedPython) ? installedPython : 'python3');

test('actual serve command preserves offline privacy and resource bounds; no vLLM boot or RPC', () => {
  const output = execFileSync(python, ['-B', '-m', 'unittest', 'test_inference_cli.py'], {
    cwd: modalDir, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(output, '');
});
