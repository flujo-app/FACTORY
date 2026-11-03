#!/usr/bin/env node
// Runs `node --test <files>` with the temp location pointed at a private empty
// folder, then fails if anything is left in it. Tests that leave folders behind
// would otherwise fill a developer's temp directory run after run.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: test-temp-guard.mjs <test files...>');
const root = mkdtempSync(join(tmpdir(), 'factory-temp-guard-'));
const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
delete env.FACTORY_TEST_TMP;
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
if (result.error) throw result.error;
const left = readdirSync(root).sort();
console.log(`temp guard: ${left.length} item(s) left in the test temp location`);
for (const name of left.slice(0, 50)) console.log(`  ${name}`);
rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exitCode = result.status || (left.length ? 1 : 0);
