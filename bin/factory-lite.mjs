#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { liteWorkerCommand } from '../src/lite-worker.mjs';

const [provider, database, ...words] = process.argv.slice(2);
if (provider === '--help' || provider === 'help' || !provider) {
  process.stdout.write('Usage: factory-lite <codex|claude> <database-path> [prompt]\n');
} else {
  try {
    const spec = liteWorkerCommand({ provider, database, prompt: words.length ? words.join(' ') : undefined });
    if (spec.env?.CODEX_HOME) mkdirSync(spec.env.CODEX_HOME, { recursive: true, mode: 0o700 });
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'inherit' });
    child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
