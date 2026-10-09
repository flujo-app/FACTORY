#!/usr/bin/env node
import { Factory } from '../src/public-sdk.mjs';

const [provider, database, ...words] = process.argv.slice(2);
if (provider === '--help' || provider === 'help' || !provider) {
  process.stdout.write('Usage: factory-lite <codex|claude> <database-path> [prompt]\n');
} else {
  try {
    const child = new Factory(database).startLiteWorker({ provider, prompt: words.length ? words.join(' ') : undefined });
    child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
