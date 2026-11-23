#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ModalSelfHostedModel, selfHostedProfiles } from '../src/selfhost/modal.mjs';
import { RunPodSelfHostedModel } from '../src/selfhost/runpod.mjs';

const usage = `Usage: factory-selfhost <command> [options]

A self-hosted model (vLLM) on your Modal account or on RunPod GPU pods, owned and journaled in a
private folder. Modal uses the active Modal profile and a Python with the modal package; RunPod
uses the key in RUNPOD_API_KEY and any Python 3.10+ (it builds the same server settings).

  profiles                         list model profiles with list-price estimates (Modal prices)
  deploy   --dir <dir> [--cloud modal|runpod] [--profile qwen|nemotron] [--set key=value ...] [--no-verify]
                                   create the key, deploy, and verify the served model
  status   --dir <dir>             phase, model, GPU and price (no key or URL)
  refresh  --dir <dir>             RunPod: ask whether the pods still run (an idle pod stops itself)
  endpoint --dir <dir> [--out f]   model-provider description for workers (no key)
  key      --dir <dir> --out <f>   write the endpoint key to a private file
  verify   --dir <dir>             check the served model again
  stop     --dir <dir>             GPU off now; deploy again to resume
  retire   --dir <dir>             delete everything the model owns, and check it

Modal only: --prefetch (CPU weight download before the deployment). The default profile is qwen.
RunPod only (the default profile is nemotron):
  --gpu B300,B200,H200   GPU types to try in order (default: the profile's GPU and its fallbacks)
  --wait-gpu <minutes>   keep trying that long when no GPU is free (default 0)
  --community            RunPod's community cloud instead of its secure cloud
  --volume-gb <n>        disk for the weights (default: weights + 40 GB)
  --network-volume <id>  keep the weights on an existing network volume (never deleted)
  --data-center <id>     a RunPod data centre, repeatable

Options: --python <path> (default python3, or python on Windows), --prefix <name> (default factory).
--set values are JSON when they parse (--set replicas=2 --set variant="fast"), text otherwise.
Running replicas cost money; idle ones stop after the profile's scale-down time.
A folder remembers its cloud; --cloud is needed only for its first deploy.
`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  dir: { type: 'string' }, profile: { type: 'string' }, set: { type: 'string', multiple: true }, prefetch: { type: 'boolean' },
  'no-verify': { type: 'boolean' }, out: { type: 'string' }, python: { type: 'string' }, prefix: { type: 'string' }, help: { type: 'boolean' },
  cloud: { type: 'string' }, gpu: { type: 'string' }, 'wait-gpu': { type: 'string' }, community: { type: 'boolean' }, 'volume-gb': { type: 'string' },
  'network-volume': { type: 'string' }, 'data-center': { type: 'string', multiple: true } } });
const [command] = positionals;
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const whole = (name, raw) => {
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} needs a whole number.`);
  return Number(raw);
};

// The cloud a folder's journal belongs to, else the --cloud option.
function cloudOf(directory) {
  const path = join(directory, 'model.json');
  let journaled = null;
  if (existsSync(path)) { try { journaled = JSON.parse(readFileSync(path, 'utf8'))?.cloud === 'runpod' ? 'runpod' : 'modal'; } catch { journaled = 'modal'; } }
  if (values.cloud && !['modal', 'runpod'].includes(values.cloud)) throw new Error('--cloud must be modal or runpod.');
  if (values.cloud && journaled && values.cloud !== journaled) throw new Error(`This folder holds a ${journaled} model; use another folder for ${values.cloud}.`);
  return values.cloud ?? journaled ?? 'modal';
}

async function main() {
  if (!command || values.help || command === 'help') return process.stdout.write(usage);
  if (command === 'profiles') return print(selfHostedProfiles());
  if (!values.dir) throw new Error('--dir <private folder> is required.');
  const directory = resolve(values.dir);
  const cloud = cloudOf(directory);
  const runpod = cloud === 'runpod';
  const Model = runpod ? RunPodSelfHostedModel : ModalSelfHostedModel;
  const model = new Model({ directory, ...(values.python ? { python: values.python } : {}), ...(values.prefix ? { namePrefix: values.prefix } : {}) });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const signal = controller.signal;
  if (command === 'status') return print(model.status());
  if (command === 'refresh') {
    if (!runpod) throw new Error('refresh is for RunPod models; a Modal model starts again by itself on the next request.');
    return print(await model.refresh({ signal }));
  }
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
    const verify = values['no-verify'] !== true;
    if (!runpod) {
      for (const name of ['gpu', 'wait-gpu', 'community', 'volume-gb', 'network-volume', 'data-center']) if (values[name] !== undefined) throw new Error(`--${name} is for RunPod (--cloud runpod).`);
      return print(await model.deploy({ profile: values.profile ?? 'qwen', overrides, prefetch: values.prefetch === true, verify, signal }));
    }
    if (values.prefetch) throw new Error('--prefetch is for Modal; a RunPod pod downloads the weights to its own disk when it first starts.');
    return print(await model.deploy({ profile: values.profile ?? 'nemotron', overrides, verify, signal,
      ...(values.gpu ? { gpus: values.gpu.split(',').map(name => name.trim()).filter(Boolean) } : {}),
      ...(values['wait-gpu'] ? { waitForGpuMinutes: whole('wait-gpu', values['wait-gpu']) } : {}),
      ...(values.community ? { cloud: 'COMMUNITY' } : {}),
      ...(values['volume-gb'] ? { volumeGb: whole('volume-gb', values['volume-gb']) } : {}),
      ...(values['network-volume'] ? { networkVolumeId: values['network-volume'] } : {}),
      ...(values['data-center'] ? { dataCenterIds: values['data-center'] } : {}) }));
  }
  if (command === 'verify') return print(await model.verify({ signal }));
  if (command === 'stop') return print(await model.stop({ signal }));
  if (command === 'retire') return print(await model.retire({ signal }));
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
