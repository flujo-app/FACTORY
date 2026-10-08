import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(root, 'test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join(root, 'test', name));
if (files.length === 0) throw new Error('No test files found');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
