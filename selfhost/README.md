# Self-hosted models on Modal

FACTORY can serve an open-weight model on your own Modal GPUs with vLLM, so workers run on it
instead of a vendor API: source code and prompts stay in your account. The served endpoint
speaks the OpenAI Responses API (Codex), the Anthropic Messages API (Claude Code) and Chat
Completions, and plugs straight into `plan.modelProvider` and the local lite workers.

This folder is separate from `modal/`, which holds the earlier pilot definitions.

## Profiles

| Profile | Model (served name) | GPU | Price while running | Context | Notes |
|---|---|---|---|---|---|
| `qwen` (default) | Qwen3.8-27B FP8 (`qwen3.8-27b`) | 1 × H100 80 GB | ~$4.84/h | 262,144 | vLLM 0.30.0; parsers `qwen3_xml` / `qwen3`; thinking on |
| `nemotron` | Nemotron 3.5 Super VL 120B-A12B NVFP4 (`nemotron-3.5-super-vl`) | 1 × B300 288 GB | ~$8.43/h | 262,144 | vLLM 0.32.0 release image (pinned by digest); parsers `qwen3_coder` / `nemotron_v3`; text only |

Prices are Modal list prices (GPU plus the reserved CPU and memory, `prices.json`, checked
2026-11-01), per running replica. They are estimates, not invoices; storage, egress and image
builds are extra. A replica with no requests stops after the profile's scale-down time (10 or
8 minutes) and costs nothing while stopped. Each replica is its own web function with at most
one GPU container (`replicas` 1–4), so the GPU count cannot grow by itself.

The Nemotron profile has named flag sets (`variant`), all checked against vLLM 0.32.0, the
current stable release:

| Variant | Adds | Use |
|---|---|---|
| `base` | FP32 Mamba state | reference |
| `fast` | async scheduling, FlashInfer Mamba kernel | 128–200 long conversations per GPU, full precision |
| `mtp1` (default) | `fast` + multi-token prediction, 1 draft token | up to ~128 conversations; each agent much faster |
| `mtp3` | `fast` + 3 draft tokens | up to ~32 conversations |
| `mtp1-fp16` | `mtp1` + FP16 Mamba state with stochastic rounding (lower precision) | MTP speed at ~190 conversations |

All Nemotron variants use prefix caching for the hybrid model (`--mamba-cache-mode align`,
`--enable-mamba-shared-prefix-checkpoint` with MTP) and load the language model only.

## Measured (long agent conversations, 300-token answers, histories 11k–100k tokens)

| Setup | Comfortable agents (turn ≤ 10 s, cache hits ≥ 85%) | Each agent | $ per agent-hour |
|---|---|---|---|
| Qwen, 1 × H100 | 8 | 39 tok/s | 0.61 |
| Nemotron `mtp1`, 1 × B300 | 64 (128 busy) | 57 tok/s (32 busy) | 0.13 (0.066 busy) |
| Nemotron `fast` / `mtp1-fp16`, 1 × B300 | 192 busy | 14 / 23 tok/s | 0.044 |

On one H100 the Qwen model's GPU cache (about 660k tokens) cannot hold more than about ten such
histories: cache hits fall from about 90% to 15% and answers wait 40–140 s. The B300 holds
23 million cache tokens, about 35 times more. In a real 190-agent coding run (10 lite-worker
machines × 19 Codex sessions, `fast`), one B300 carried about 170 requests at once with none
queued. The GPU cache was at most 37% full and 84% of 464 million input tokens came from the
prompt cache. The run wrote 12.5 million output tokens in 2 h 18 min for about $20 of GPU time.
Cold starts: Qwen 4–5 min (first 7.5 min); Nemotron about 9.5 min (weights from the volume plus
kernel compilation).

## Use it

Needs Python 3.10+ with `pip install modal` and a signed-in Modal profile
(`modal profile current`). The private folder holds the journal and, by default, the key; keep
it out of Git.

```sh
factory-selfhost profiles
factory-selfhost deploy --dir ./private/model --profile nemotron --prefetch   # CPU weight download first, then deploy and verify
factory-selfhost endpoint --dir ./private/model --out endpoint.json            # provider description, no key
factory-selfhost key --dir ./private/model --out ./private/model-key           # backend only
factory-selfhost stop --dir ./private/model                                    # GPU off now; deploy again to resume
factory-selfhost retire --dir ./private/model                                  # delete app, secret, volumes and key
```

```js
import { ModalSelfHostedModel, FactoryCloudLiteFleet } from 'flujo-factory';

const model = new ModalSelfHostedModel({ directory: '/absolute/private/model' });
await model.deploy({ profile: 'qwen', overrides: { replicas: 2 } });
const modelProvider = model.endpoint();              // validated provider description
await fleet.deploy({ ...plan, model: modelProvider.model, subagentModel: modelProvider.model, modelProvider },
  { image, bundlePath, providerKey: await model.key() });
// ...
await model.retire();
```

`deploy` creates an owned app name (`<prefix>-<profile>-<12 hex>`), checks the active Modal
profile and workspace, and generates a fresh key that only Modal's secret and your credential
store hold. It then deploys and proves each replica serves the expected model: the catalogue
lists it, and one non-thinking completion returns an exact challenge. Modal's 303 result links
are followed on the same origin only, so the POST is never repeated and the key never goes to
another host. Any uncertain remote outcome leaves the model `unknown`. It is never retried
automatically; `retire` reconciles it. `stop` and `retire` refuse a different Modal workspace,
and `retire` checks that the secret and both volumes are gone.
`adopt({ appName, profileName, workspaceName })` takes over an owned app that an earlier
version of your app created, in the `unknown` phase, so `retire` can clean it up.

Overrides are explicit settings fields, for example `{ replicas: 2 }`, `{ variant: 'fast' }`,
`{ enable_thinking: false }` or `{ scaledown_minutes: 2 }`. Unknown fields, unpinned images and
settings that would not fit the GPU are refused before anything is created.

## Things to know

- vLLM's `--api-key` protects `/v1/*`; `/health` and `/metrics` answer without it (counters only).
- A request to a cold replica is held, not refused, until the container is up.
- Qwen3.8's chat template accepts reasoning efforts `low`, `medium` and `xhigh` and rejects
  `high`. Nemotron's template ignores the effort; `enable_thinking` switches thinking.
- Spread workers over replicas (`baseUrls[i % n]`), so each worker keeps its prompt cache on one GPU.
- Offline checks: `python -B -m unittest discover -s selfhost/modal -p "test_*.py"` and
  `node --test test/selfhost-modal.test.mjs`. Neither makes a cloud call.
