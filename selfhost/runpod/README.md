# Self-hosted model on RunPod

FACTORY can run its self-hosted model on a RunPod GPU instead of Modal, for example to spend
RunPod credits. Workers notice no difference: they get the same model description (address, model
name, context size) and the same kind of key as with Modal.

## What happens

- `deploy` rents one GPU machine (a "pod") on RunPod's secure cloud: a **B300** (288 GB) first,
  a **B200** or **H200** when no B300 is free. More replicas mean one pod each.
- The pod runs the **official vLLM image**, pinned exactly as in the Modal profile, and downloads
  **NVIDIA's own weights** at the pinned version (`nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4`,
  revision `2e5cc39…`) to its own disk. The weights cannot be swapped for another copy.
- The server settings are the Modal profile's own: same flags, same variants (`mtp1` by default,
  `fast`, `mtp1-fp16`, …; see [the Modal guide](../README.md)).
- FACTORY makes a new secret key, waits until the model answers, and checks it answers correctly.
  Only then is it `ready`.
- **It switches itself off when idle.** After 8 minutes without a model request (the profile's
  scale-down time), the pod stops itself. Health checks and reading its meters do not count as use,
  so they never keep it running. This works even when your own computer is off.
- A vLLM that does not come up within 40 minutes, or keeps crashing, also switches the pod off.

Your RunPod key stays on your computer. The pod gets only the model's own key; to switch itself
off it uses the key RunPod gives every pod for that pod alone.

## Before you start

- A RunPod account with credit, and an API key in `RUNPOD_API_KEY`.
- Python 3.10 or newer (no extra packages): it builds the server settings, as for Modal.
- A private folder for FACTORY's notes about the model, kept out of Git.

## Start

```sh
export RUNPOD_API_KEY=...                       # PowerShell: $env:RUNPOD_API_KEY = '...'
factory-selfhost deploy --cloud runpod --dir ./private/runpod-model                     # Nemotron, mtp1
factory-selfhost deploy --cloud runpod --dir ./private/runpod-model --set variant=fast     # 128-200 agents
factory-selfhost deploy --cloud runpod --dir ./private/runpod-model --wait-gpu 60       # wait up to an hour for a free GPU
factory-selfhost endpoint --dir ./private/runpod-model --out endpoint.json              # for the workers, no key
factory-selfhost key --dir ./private/runpod-model --out ./private/runpod-model-key       # the key, into a private file
```

The first start downloads the image and the weights; the GPU is paid from then on. FACTORY waits up
to 45 minutes for the first correct answer.

## Stop

```sh
factory-selfhost stop    --dir ./private/runpod-model   # GPU off now; the disk with the weights stays
factory-selfhost refresh --dir ./private/runpod-model   # has it switched itself off?
factory-selfhost deploy  --dir ./private/runpod-model   # start it again
factory-selfhost retire  --dir ./private/runpod-model   # delete the pods and their disks; nothing more is billed
```

A stopped model does not wake up by itself on the next request (Modal's does). Start it again
with `deploy`: the weights are still on its disk. If RunPod gave that machine's GPU to someone
else meanwhile, `deploy` rents a new pod; the weights then download again and the address
changes, so hand the workers a fresh `endpoint`.

## Prices

| GPU | Secure cloud, per hour | Community cloud, per hour |
|---|---|---|
| B300 288 GB | $8.99 | $6.94 |
| B200 180 GB | $7.99 | $5.98 |
| H200 141 GB | $5.29 | $3.59 |

RunPod list prices, read 2026-11-23 ([gpus.json](gpus.json)); at start FACTORY reads RunPod's live
prices when the key may. The weights disk is 110 GB: about $11 a month while running, $22 a month
while stopped. `retire` ends that.

## Options

| CLI | SDK (`deploy({...})`) | Meaning |
|---|---|---|
| `--gpu B300,B200` | `gpus: ['B300', 'B200']` | GPU types to try, in order |
| `--wait-gpu 60` | `waitForGpuMinutes: 60` | keep trying that long when no GPU is free |
| `--community` | `cloud: 'COMMUNITY'` | RunPod's community cloud (machines of other hosts) instead of its own data centres |
| `--volume-gb 150` | `volumeGb: 150` | size of the weights disk |
| `--network-volume <id>` | `networkVolumeId` | keep the weights on an existing RunPod network volume; FACTORY never deletes it |
| `--data-center EU-RO-1` | `dataCenterIds: ['EU-RO-1']` | where the pod may run |
| `--set key=value` | `overrides` | profile settings (`variant`, `replicas`, `scaledown_minutes`, ...) |

The weights (`model`, `revision`) cannot be overridden. Another image must also be an official
`vllm/vllm-openai@sha256:...` image.

## In code

```js
import { RunPodSelfHostedModel } from 'flujo-factory';

const model = new RunPodSelfHostedModel({ directory: '/absolute/private/runpod-model' });   // reads RUNPOD_API_KEY
await model.deploy({ profile: 'nemotron', overrides: { variant: 'fast' }, waitForGpuMinutes: 60 });
const modelProvider = model.endpoint();                    // the same description Modal gives
await fleet.deploy({ ...plan, model: modelProvider.model, subagentModel: modelProvider.model, modelProvider },
  { image, bundlePath, providerKey: await model.key() });
// ...
await model.refresh();                                     // `stopped` once the pod switched itself off
await model.retire();
```

Like on Modal, anything uncertain (a lost answer from RunPod, a model that answers wrongly)
leaves the model `unknown`; FACTORY never repeats it by itself. `retire` then finds every pod
by its name and deletes it. `stop` and `retire` refuse a key that cannot see the model's pods.

## Good to know

- The address is RunPod's `https://<pod>-8000.proxy.runpod.net`. RunPod's front door ends a
  request that gets no answer within 100 seconds; workers stream their answers, so the first
  words arrive long before that.
- Offline checks: `python -B -m unittest discover -s selfhost/runpod -p "test_*.py"` and
  `node --test test/selfhost-runpod.test.mjs`. Neither calls RunPod or a model.
