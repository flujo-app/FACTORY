#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Factory } from '../src/public-sdk.mjs';

const usage = 'Usage: factory-lite <codex|claude> <database-path> [--model-provider <endpoint.json>] [prompt]\n'
  + '  --model-provider  use a self-hosted model (e.g. from `factory-selfhost endpoint`); its key is read from the\n'
  + '                    environment variable the file names in envKey.\n';
const args = process.argv.slice(2);
const [provider, database] = args;
if (provider === '--help' || provider === 'help' || !provider) {
  process.stdout.write(usage);
} else {
  try {
    const words = args.slice(2);
    let modelProvider, providerKey;
    const flag = words.indexOf('--model-provider');
    if (flag !== -1) {
      const file = words[flag + 1];
      if (!file) throw new Error('--model-provider needs an endpoint description file.');
      words.splice(flag, 2);
      modelProvider = JSON.parse(readFileSync(file, 'utf8'));
      providerKey = process.env[modelProvider.envKey];
      if (!providerKey) throw new Error(`Set ${modelProvider.envKey} to the endpoint key.`);
    }
    const child = new Factory(database).startLiteWorker({ provider, prompt: words.length ? words.join(' ') : undefined, modelProvider, providerKey });
    child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
