#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Factory } from '../src/public-sdk.mjs';

const usage = 'Usage: factory-lite <codex|claude|flujo> <database-path> [--model-provider <endpoint.json>] [--origin <url>] [prompt]\n'
  + '  --model-provider  use a self-hosted model (e.g. from `factory-selfhost endpoint`); its key is read from the\n'
  + '                    environment variable the file names in envKey. FLUJO needs this.\n'
  + '  --origin          FLUJO only: attach to this running FLUJO instead of starting one.\n';
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
    let origin;
    const originFlag = words.indexOf('--origin');
    if (originFlag !== -1) {
      origin = words[originFlag + 1];
      if (provider !== 'flujo' || !origin) throw new Error('--origin needs a URL and is for FLUJO workers.');
      words.splice(originFlag, 2);
    }
    const started = new Factory(database).startLiteWorker({ provider, prompt: words.length ? words.join(' ') : undefined, modelProvider, providerKey, ...(origin ? { origin } : {}) });
    if (provider === 'flujo') {
      const worker = await started;
      process.stdout.write(`FLUJO worker ready at ${worker.origin} in workspace ${worker.workspace}.\n`);
      const finish = () => { void worker.stop(); };
      process.once('SIGINT', finish); process.once('SIGTERM', finish);
      // With a prompt the worker ends with its turn; without one a started server stays up until stopped.
      if (words.length) {
        const turn = await worker.settled();
        process.stdout.write(`Turn ended: ${turn?.status}.\n`);
        process.exitCode = turn?.status === 'completed' ? 0 : 1;
        await worker.stop();
      } else if (origin) await worker.stop();
    } else {
    const child = started;
    child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
