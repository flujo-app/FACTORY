#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ModalSelfHostedModel, selfHostedProfiles } from '../src/selfhost/modal.mjs';

const usage = `Usage: factory-selfhost <command> [options]

A self-hosted model (vLLM) on your Modal account, owned and journaled in a private folder.
Uses the active Modal profile and a Python that has the modal package.

  profiles                         list model profiles with list-price estimates
  deploy   --dir <dir> [--profile qwen|nemotron] [--set key=value ...] [--prefetch] [--no-verify]
                                   create the key, deploy, and verify the served model
  status   --dir <dir>             phase, model, GPU and price (no key or URL)
  endpoint --dir <dir> [--out f]   model-provider description for workers (no key)
  key      --dir <dir> --out <f>   write the endpoint key to a private file
  verify   --dir <dir>             check the served model again
  stop     --dir <dir>             GPU off now; deploy again to resume
  retire   --dir <dir>             delete the app, secret, volumes and key, and check it

Options: --python <path> (default python3, or python on Windows), --prefix <name> (default factory).
--set values are JSON when they parse (--set replicas=2 --set variant="fast"), text otherwise.
Running replicas cost money; idle ones stop after the profile's scale-down time.
`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  dir: { type: 'string' }, profile: { type: 'string' }, set: { type: 'string', multiple: true }, prefetch: { type: 'boolean' },
  'no-verify': { type: 'boolean' }, out: { type: 'string' }, python: { type: 'string' }, prefix: { type: 'string' }, help: { type: 'boolean' } } });
const [command] = positionals;
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function main() {
  if (!command || values.help || command === 'help') return process.stdout.write(usage);
  if (command === 'profiles') return print(selfHostedProfiles());
  if (!values.dir) throw new Error('--dir <private folder> is required.');
  const model = new ModalSelfHostedModel({ directory: resolve(values.dir), ...(values.python ? { python: values.python } : {}), ...(values.prefix ? { namePrefix: values.prefix } : {}) });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const signal = controller.signal;
  if (command === 'status') return print(model.status());
  if (command === 'endpoint') {
    const description = model.endpoint();
    if (values.out) { writeFileSync(values.out, JSON.stringify(description, null, 2)); return print({ written: values.out }); }
    return print(description);
  }
  if (command === 'key') {
    if (!values.out) throw new Error('--out <private file> is required; the key is never printed.');
    writeFileSync(values.out, await model.key(), { mode: 0o600 });
    return print({ written: values.out });
  }
  if (command === 'deploy') {
    const overrides = {};
    for (const entry of values.set ?? []) {
      const at = entry.indexOf('=');
      if (at < 1) throw new Error(`--set needs key=value: ${entry}`);
      const raw = entry.slice(at + 1);
      try { overrides[entry.slice(0, at)] = JSON.parse(raw); } catch { overrides[entry.slice(0, at)] = raw; }
    }
    return print(await model.deploy({ profile: values.profile ?? 'qwen', overrides, prefetch: values.prefetch === true, verify: values['no-verify'] !== true, signal }));
  }
  if (command === 'verify') return print(await model.verify({ signal }));
  if (command === 'stop') return print(await model.stop({ signal }));
  if (command === 'retire') return print(await model.retire({ signal }));
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
