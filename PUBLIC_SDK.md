# Public local Factory SDK, CLI, and MCP

Version 0.12.0 is distributed as a versioned package in
[GitHub Releases](https://github.com/flujo-app/FACTORY/releases/tag/v0.12.0):

```sh
npm install https://github.com/flujo-app/FACTORY/releases/download/v0.12.0/flujo-factory-0.12.0.tgz
```

FACTORY can serve an open-weight model on your own Modal GPUs and run workers on it.
`ModalSelfHostedModel` and `factory-selfhost` deploy, verify, stop and retire a vLLM endpoint
with Qwen3.8-27B (H100) or Nemotron 3.5 Super (B300) profiles; see
[selfhost/README.md](selfhost/README.md). `RunPodSelfHostedModel` (`factory-selfhost --cloud runpod`)
runs the same profiles on RunPod GPU pods that switch themselves off when idle; see
[selfhost/runpod/README.md](selfhost/runpod/README.md). Its endpoint description is a model provider that
cloud and local lite workers (Codex, Claude Code or FLUJO) use directly. See
[Self-hosted models and operator-driven jobs](#self-hosted-models-and-operator-driven-jobs)
for the provider, read-only deploy keys, prepare hooks, operator-driven jobs and quieter
traces added in 0.4.0. All of it is optional; existing plans behave as before, except that
streaming deltas are no longer traced unless `traceDeltas` is set.

`FactoryControl` and `executeEffect` are public exports for integrations that
retain FACTORY's durable admission while using an existing fleet executor.
Repeating an effect key observes its original outcome without dispatching again.
The release does not require npm registry publication or private package access.

The optional [verified workflow SDK](WORKFLOWS.md) adds frozen candidates,
independent review, executable verification, portable artifacts, typed events,
workflow templates, curated knowledge, and matched comparison tooling.

Licensed under [MIT](LICENSE), including commercial use.

Factory keeps a durable swarm ledger: mission, agent cells, budget allocations,
tasks, and external effects. `createSwarm` initializes the mission and initial
agents in one transaction; a failed agent admission leaves no partial swarm.
`FactorySwarmEngine` can dispatch work through an explicitly configured local
FLUJO or managed cloud adapter. Agents can also use the SDK or MCP directly.

The public SDK package supports Node.js 22.17 or newer on the 22 line, or
Node.js 24 or newer. Its installed package, focused fleet/presentation tests,
and CLI smoke passed on both versions in the
[dual-runtime public gate](https://github.com/flujo-app/FACTORY/actions/runs/37859951050).
Some repository-internal capacity, growth and native-cell CLIs still require
Node 24; the public package does not promise those private commands on Node 22.
The new fleet APIs are on the development main
branch: `npm install github:flujo-app/FACTORY#main`. A local checkout can be
installed with `npm install .`. The older `v0.2.0` tag contains only the local
coordination SDK. Run the project-local CLI with `npx factory`.
The `0.3.0-dev.7` package declares the exact public Git repository and defaults
an npm publication to the `next` tag. Its first registry publication still
requires an authorized npm owner session; npm's trusted-publisher setup is
configured from an existing package's settings. After that bootstrap, a
[trusted GitHub publisher](https://docs.npmjs.com/trusted-publishers/) can be
configured for subsequent releases. No npm publication has occurred.
The [0.3.0-dev.7 release-candidate check](evidence/public-release-candidate-20261008.json)
packed the current source, installed its tarball into a fresh local consumer,
created a durable two-cell swarm, opened the installed CLI and passed all 793
source tests under Node 24. It did not publish the package.
The packed package includes both the public CLI and the separate internal
`npm run factory` and offline `npm run pilot` entry files. `npm test` is a
source-checkout command: the public tarball omits the private/integration test
fixtures and their dependencies.
The [Public SDK CI run](https://github.com/flujo-app/FACTORY/actions/runs/37852291808)
passed on Ubuntu with Node 24 at commit `2ca4d5a`: it audited runtime
dependencies, ran 16 focused SAVIA and managed-fleet tests, installed the
packed tarball in a fresh consumer, created a two-cell swarm and opened the
installed CLI.
The [expanded gate](https://github.com/flujo-app/FACTORY/actions/runs/37852542753)
also passed the 23 FACTORY presentation tests at `7096f39`, covering the
authenticated read-only snapshot, events, Modal observation and paid-budget
projection consumed by Brain Online and the Observatory.
The [fresh-install check](evidence/public-sdk-install-20261008.json) resolved
main at `e3925c7` and created/replayed a three-cell swarm through the installed
package. A separate credential-free HTTPS source download and tarball install
passed the same local SDK check. A pinned Git install at `b93f627` also created
three cells through the installed SDK and exposed `FactoryLocalFleet.closeRetired`.
A pinned public Git install at `7c23d03` exported `buildSaviaCasePlan` and
constructed ten team leads with an exact 103-cent logical allocation under
Node 24; see the same evidence record. This check did not call FLUJO or a model.
A fresh pinned Git install at `d086f9a` constructed the ten-lead plan with its
case ID and exposed `observeSaviaCaseTopology` under Node 24. This confirms the
current role-observation API is in the installable public package; the install
check did not observe a live FLUJO run.
A fresh pinned Git install at `5df5c7a` confirmed the installed managed fleet
rejects its five unsupported message, cancellation and reconciliation methods
before making a provider call.
A fresh pinned Git install at `3579051` also exported and constructed
`FactoryManagedFleet` under Node 24 with an inert synthetic adapter. It did not
deploy a cloud worker.
At `bf8d350`, the fresh public Git install exported `SpendingLedger` and
refused `FactoryManagedFleet` construction without it. Construction with an
initialized ledger passed under Node 24 with zero provider calls; see the
same evidence record.
`flujo-factory` is not yet published to the npm registry.

## Default generic native team and template CRUD

FACTORY owns the reusable setup; applications supply their goal, environment descriptions,
upstream pins and runtime bindings. The built-in `generic` template produces the existing
native `swarm_agent` / `swarm_team` pair with one shared subflow concurrency gate. It uses
observed connected tools, concise shared-board coordination, independent review and useful
product delivery. Specialized SAVIA roles remain an explicit opt-in.

```js
const factory = new Factory('/private/control.sqlite');
const defaults = factory.getTemplate('generic');
factory.updateTemplate('generic', {
  expectedRevision: defaults.revision,
  environment: { workspace: '/workspace', board: 'https://github.com/org/project/issues/1' },
  goalContext: 'Reuse the installed upstream systems and ship a usable product slice',
});
const flowSpecs = factory.buildTemplate('generic', {
  model: 'installed-model-id',
  availableServers: ['filesystem', 'bash'],
  availableTools: { filesystem: ['read_file', 'write_file'], bash: ['run'] },
});
```

`listTemplates()`, `getTemplate(name)`, `createTemplate({name, ...settings})`,
`updateTemplate(name, {expectedRevision, ...settings})` and
`deleteTemplate(name, {expectedRevision})` persist in the same local Factory database.
Settings are `description`, `goalContext`, `environment` (string-valued descriptions) and
`limits` (`agentTurns`, `leadTurns`, `concurrency`). Revisions protect concurrent writers
and survive deletion/recreation. Deleting a persisted `generic` override resets it to the
built-in default. Put credentials in private runtime configuration, never template settings.

The CLI exposes `template-list` and JSON-input `template-read`, `template-create`,
`template-update`, `template-delete`, `template-build`; the MCP server exposes corresponding
`factory_template_*` tools. CRUD and building specifications start no workers.

Provisioning through `createFlujoWorkspaceAdapter` with `modelConfig` and no explicit
flows selects the generic native team automatically. Explicit `flowSpec`, `flowSpecs` or
`teamTemplate` continues to take precedence. To install a catalog template, pass the
built `flowSpecs` through the adapter's existing provisioning interface; the catalog's
local overrides are not implicitly shared with a remote adapter.

## CLI

### Lite workers

`factory-lite` opens a regular interactive Codex or Claude CLI session in the
current directory, or runs a FLUJO worker (see below). A CLI session does not provision a FLUJO worker or use the FLUJO
conversation harness. The CLI retains its built-in tools and unrestricted file
and command access. The only MCP server supplied for that session is FACTORY's
local board/swarm server, connected to the specified durable database.

```sh
factory-lite codex /absolute/path/board.sqlite "Work on the Factory board"
factory-lite claude /absolute/path/board.sqlite "Work on the Factory board"
```

Create the swarm first with `factory create` or the SDK. Lite Codex uses a
dedicated persistent CLI home at `~/.factory/lite-codex`, so its first launch
may require a separate Codex login. Claude uses its normal login and loads only
the explicit FACTORY MCP config. The optional prompt can be
omitted to start an interactive session without initial instructions.


Use an absolute database path for a durable swarm:

```sh
npx factory create /tmp/my-factory.sqlite '{"mission":"Build an app","budgetCents":0,"agents":[{"id":"builder","role":"developer"},{"id":"reviewer","role":"verifier"}]}'
npx factory status /tmp/my-factory.sqlite
npx factory task /tmp/my-factory.sqlite '{"id":"first-task","projectId":"app","branch":"codex/first-task","problem":"Build the app","acceptance":"Tests pass","baseline":"main"}'
npx factory claim /tmp/my-factory.sqlite '{"taskId":"first-task","agentId":"builder"}'
npx factory pause /tmp/my-factory.sqlite
```

The `claim` response contains a private lease token. Keep it inside the agent
runtime. `factory agent` adds one cell; `factory resume` reopens admission.
An empty swarm reserves room for 15 later agents by default. Set `maxCells`
when creating the swarm to choose another ceiling.
Use `growthMode: 'budget-only'` in the JavaScript SDK to omit cell-count and
depth ceilings while preserving each parent's logical budget allocation.
On Windows, put JSON in a file and pass `@config.json` as the final argument;
this avoids `cmd.exe` quote conversion. Use `-` to read JSON from stdin.

## JavaScript SDK

```js
import { Factory } from 'flujo-factory';

const factory = new Factory('/tmp/my-factory.sqlite');
factory.createSwarm({ mission: 'Build an app', budgetCents: 0,
  agents: [{ id: 'builder', role: 'developer' }, { id: 'reviewer', role: 'verifier' }] });
console.log(factory.status());
const worker = factory.startLiteWorker({ provider: 'codex', prompt: 'Work on the Factory board' });
worker.on('exit', code => console.log('lite worker exited:', code));
```

The lower-level `FactoryControl` is also exported for the full local controller
API. Each ledger SDK call closes its database connection before returning.
`startLiteWorker` returns a Node `ChildProcess`; it runs in the caller's current
directory by default and inherits the terminal. Pass `cwd` or `stdio` to change
those process options. The standalone `startLiteWorker({provider,database,...})`
and `liteWorkerCommand({provider,database,...})` are also exported; the latter
only builds the process specification.

Local lite workers can also run on a self-hosted model. Pass the same provider
description the cloud plan uses (see
[Self-hosted models](#self-hosted-models-and-operator-driven-jobs)) and its key:
`startLiteWorker({ provider: 'claude', modelProvider, providerKey })`. From the
command line, `factory-lite claude board.sqlite --model-provider endpoint.json`
reads the key from the variable the file names in `envKey`.

A local FLUJO worker has no terminal session. It attaches to a running FLUJO, or starts
its own with a separate data folder, installs the generic team template with the board
as a tool server, and keeps its conversation across runs:

```js
const worker = await factory.startLiteWorker({ provider: 'flujo', modelProvider, providerKey,
  origin: 'http://127.0.0.1:4200', prompt: 'Work on the Factory board' });
const turn = await worker.settled();
await worker.send('Next job');
await worker.stop();
```

From the command line: `factory-lite flujo board.sqlite --model-provider endpoint.json
[--origin http://127.0.0.1:4200] "Work on the Factory board"`. Without `--origin`, the
`flujo` command from `npm install -g flujo-ai` must be on the path. A record from
`POST /api/model` can stand in for a provider as `flujoModel`.

## FLUJO worker dispatch

### Cloud lite workers (development)

`FactoryCloudLiteFleet` provisions a dedicated Fly fleet running native Codex
app-server harnesses (or Claude Code, see
[Claude Code as the worker program](#claude-code-as-the-worker-program)) with their
built-in tools and only FACTORY's board MCP.
Each machine has one orchestrator and `agentsPerMachine - 1` subordinate
sessions, isolated Git worktrees, persisted native histories, and durable traces.
The SDK starts and registers the configured pool; additional native automatic
fanout is disabled so every subordinate has its own board identity and policy.
CPU kind, CPU count, RAM, persistent disk, region, machine count and agent count
are explicit plan settings. No FLUJO worker harness is used for this path.

```js
import { FactoryCloudLiteFleet, CodexSubscriptionBroker } from 'flujo-factory';

const fleet = new FactoryCloudLiteFleet({
  directory: '/absolute/private/fleet-run',
  flujoCloudPath: '/absolute/installed/flujo-cloud',
  auth: new CodexSubscriptionBroker({ authFile: '/absolute/private/.codex/auth.json' }),
});
await fleet.deploy({
  runId: 'my-cloud-lite-run', app: 'my-cloud-lite-app',
  repository: 'mario-andreschak/FLUJO', goal: ownerGoal,
  machines: 10, agentsPerMachine: 10,
  cpuKind: 'shared', cpus: 2, memoryMb: 4096, diskGb: 20, region: 'iad',
  model: 'gpt-6.1-sol', subagentModel: 'gpt-6-luna', reasoningEffort: 'medium',
}, { image: immutableWorkerImage, githubToken: privateGithubCredential,
  bundlePath: '/absolute/private/flujo-factory.tgz' });
const observation = await fleet.observe();
await fleet.disconnect();
```

The coordinator lives on the first machine and retains the one authoritative
FactoryControl database on its volume. Orchestrators can message other
orchestrators and their own machine's agents; subagents can message only their
own machine. Individual credentials bind the sender independently of tool input.
Atomic PR/issue claims prevent cross-machine duplicate assignment. Tool access is
not hostile-process isolation: agents have the native shell/filesystem access
requested for the job and must be trusted with their machine and repository.

Provisioning imports flujo-cloud's `createMachine`, `createFlyRunner`,
`buildMachineConfig`, `resolveWorkerImage`, and private proxy implementation
from the selected installation. It does not copy their source or perform an
image build, registry login, or image push. `imageSource` can supply FLUJO's
compatibility advertisement for its existing official image resolver; an
explicit immutable image retains the upstream custom-image contract. The native
Codex bootstrap accepts a digest-bound SDK tarball on an existing Node image.
Workers communicate over the exact coordinator Machine's private Fly address,
and the host uses flujo-cloud's private proxy. No public worker services or
dedicated IP addresses are created by the native profile.

Subscription access tokens use upstream Codex's external-token app-server login.
Refresh tokens stay on the trusted host, which runs native Codex refresh and
updates the coordinator when workers request it. Run `observe()` continuously
while workers execute; a disconnected host can prevent authentication renewal.
The runtime does not switch to an API key. Credentials never belong in an image,
public journal, source commit or trace. Store the fleet directory privately.

#### Claude Code as the worker program

Set `workerProgram: 'claude'` in the plan (the default stays `'codex'`). Everything
else works the same way: the board, operator commands and stop receipts, durable
traces, prepare hooks, evidence collection and verified workflows.

```js
import { FactoryCloudLiteFleet, ClaudeSubscriptionBroker } from 'flujo-factory';

// On a subscription: a token from `claude setup-token`, in a private file on this host.
const fleet = new FactoryCloudLiteFleet({ directory: '/absolute/private/fleet-run',
  flujoCloudPath: '/absolute/installed/flujo-cloud',
  auth: new ClaudeSubscriptionBroker({ tokenFile: '/absolute/private/claude-token' }) });
await fleet.deploy({ runId: 'my-claude-run', app: 'my-claude-app', goal: ownerGoal,
  workerProgram: 'claude', model: 'opus', subagentModel: 'sonnet',
  machines: 1, agentsPerMachine: 4 }, { image: immutableWorkerImage, bundlePath: '/absolute/private/flujo-factory.tgz' });

// Or on a self-hosted model: the same description Codex uses.
const provider = model.endpoint();
await selfHostedFleet.deploy({ ...plan, workerProgram: 'claude', model: provider.model, subagentModel: provider.model, modelProvider: provider },
  { image: immutableWorkerImage, bundlePath: '/absolute/private/flujo-factory.tgz', providerKey: await model.key() });
```

- **Install:** the bootstrap installs one pinned Claude Code release (2.1.323, which
  knows Claude Fable 5.2 and Claude Opus 5.5), checked against
  its SHA-256, plus `bubblewrap` and `socat` for its sandbox. A custom image must
  provide `claude` on the path, and `/bin/bash`.
- **Sessions:** each agent slot keeps one session, with history in
  `/data/claude/projects`. Each turn is one Claude Code process, so an idle agent uses
  no memory beyond its files. A message during a turn joins that turn. A stop
  interrupts it; if the program does not answer within 10 seconds its process is
  ended. A stop receipt is issued only after the process has gone and the session
  reads back as idle.
- **Plans:** a plan without `modelProvider` needs a broker made for its program, and a
  provider must offer the program's API: `anthropic` for Claude Code, `responses` for
  Codex. The models default to `opus` and `sonnet`; with a provider, name the served model.
- **Subscription:** the token from `claude setup-token` is long-lived, and this host
  holds no refresh token for it. To rotate it, replace the file; when a worker reports a
  refused token, `fleet.observe()` passes on the file's current token for the next turn.
- **Keys and agent commands:** the key or token reaches only the Claude Code process.
  `CLAUDE_CODE_SHELL_PREFIX` removes it from the environment of agent commands and the
  board MCP server; with a provider the GitHub token goes too, as with Codex. Journals
  and traces do not contain it. With `danger-full-access`, an agent command runs as the
  same user and could still read it from the parent process, so use a narrower sandbox
  when agents handle untrusted input. Claude Code's own `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
  is not used, because it also forces interactive permission checks on these sessions.
- **Sandbox:** `danger-full-access` skips permission checks; the Machine is the
  sandbox. `workspace-write` runs commands in Claude Code's bubblewrap sandbox, writing
  only to the agent's folder and `writableRoots`, with no network, and its file tools
  stay in the same folders. `read-only` also blocks writes to the agent's folder and
  removes the file-writing tools. Both narrow modes refuse to run commands without
  the sandbox, so the worker image must allow bubblewrap. Network tools, automatic
  subagents, schedules, background tasks, skills, auto memory and repository settings
  files are off in every mode. The only MCP servers are the job board and the plan's
  [`mcpServers`](#extra-mcp-servers-for-every-agent).
- **Traces:** assistant text, thinking, tool calls and results become `item/completed`
  records (`agentMessage`, `reasoning`, `toolCall`, `toolResult`), token use becomes
  `thread/tokenUsage/updated`, and model retries become `model/retry`. Streaming deltas
  are skipped unless `traceDeltas` is on.

#### FLUJO as the worker program

Set `workerProgram: 'flujo'` to run a FLUJO server on each machine. The board, operator
commands and stop receipts, durable traces, prepare hooks, evidence collection and
verified workflows are the same shared code as for Codex and Claude Code.

```js
const fleet = new FactoryCloudLiteFleet({ directory: '/absolute/private/fleet-run',
  flujoCloudPath: '/absolute/installed/flujo-cloud' });
await fleet.deploy({ runId: 'my-flujo-run', app: 'my-flujo-app', goal: ownerGoal,
  workerProgram: 'flujo', machines: 3, agentsPerMachine: 1,
  modelProvider: model.endpoint(),
  // Optional: each orchestrator leads a team of native FLUJO subflows.
  flujo: { teamConcurrency: 4, agentTurns: 200, leadTurns: 600 },
}, { image: immutableNodeImage, bundlePath: '/absolute/private/flujo-factory.tgz', providerKey: await model.key() });
```

- **Model:** a plan needs a `modelProvider`; FLUJO workers have no subscription login. It
  can offer `responses`, `chat` or `anthropic`, and FLUJO uses the first of those that the
  provider has. `flujoProviderModel` is the exported mapping. FLUJO stores the key in its
  own encrypted settings, so the FLUJO process and the agent commands it starts never have
  it in their environment. `reasoningEffort` does not apply: FLUJO accepts it only for
  models it knows by name.
- **Bundle:** `bundlePath` can be a release file, or what `packFactorySdk(file)` writes from
  the installed package, which needs no `npm` or `tar` on the host. `network` in the plan
  puts the fleet's app on its own private network.
- **Install:** the bootstrap installs one pinned `flujo-ai` release on the volume, checked
  against its SHA-256, so a restarted Machine does not install it again. Allow about four
  minutes on first start. A custom image can provide `flujo` on the path instead. Use a Node image of
  at least 24.22.1 or 22.23.4, running as root; FLUJO's official image runs as a normal user.
  Fly needs the full reference, such as `docker.io/library/node@sha256:...`.
- **Sessions:** each agent slot has its own FLUJO workspace with one conversation, so its
  board identity, model record and tools stay apart. FLUJO runs on port 4210 on the
  Machine's loopback, or `FACTORY_FLUJO_PORT`. Each workspace runs its own tool servers, so
  plan on about 400 MB per agent plus 300 MB for FLUJO. FLUJO restarts by itself up to
  three times in ten minutes; after that the worker stops, as with the other programs.
- **Team:** with `flujo.teamConcurrency` an orchestrator gets the `swarm_team` flow, with one
  native gate for its subflows, and `flujo.specialists` can give it a role catalog. The others get `swarm_agent`. A turn ends, and a stop receipt
  is issued, only after every child conversation has ended too. Each conversation lists its
  children under `/v1/chat/conversations?descendantsOf=<thread>`.
- **Tools:** `bash` and `filesystem`, plus `browser` if `flujo.servers` lists it and the image
  has its browser; the bootstrap does not download one. The FLUJO control server stays off.
  The board server takes its address and credential from a private file. A worker's prompt
  names its working folder, because FLUJO's tools otherwise start in FLUJO's data folder.
- **Sandbox:** only `danger-full-access`. FLUJO's folder settings are a guide for its tools,
  not a boundary, so the Machine is the sandbox, and a plan with a narrower `sandbox` is
  refused. Agents get no GitHub token, as with other self-hosted model plans. An agent command
  runs as the same user, so it could still read FLUJO's stored settings, including the model
  key; use another program with a narrower sandbox when agents handle untrusted input.
- **Runs:** a run belongs to FLUJO, not to the connection that asked for it. A dropped event
  stream is followed again from its last event. A submission whose answer was lost is read
  back and never sent twice. While FLUJO is under pressure a turn waits for up to five
  minutes. A question or form from a tool is declined, because nobody is there to answer it.
- **Messages and stops:** a message during a turn joins it at its next safe point; if the run
  ended before taking it, the same turn goes on with it. A stop is requested again until FLUJO
  has stopped, and wins over a queued message. If it never stops, no receipt is issued.
- **Restarts:** the conversation survives. A turn that was running when FLUJO died ends as
  `interrupted`. It is not replayed; in autonomous mode the agent gets a new turn. If the
  conversation is gone, the usual recovery for an unavailable session applies.
- **Traces and evidence:** messages, tool calls and results and subflow starts and ends become
  `item/completed` records (`agentMessage`, `toolCall`, `toolResult`, `subflow`), with `depth`
  and `lane` for children. Token use becomes `thread/tokenUsage/updated`, retries become
  `model/retry`, and errors become `flujo/error`. Evidence holds the conversations from
  `/data/flujo/workspaces`, not its keys, server settings or tool copies.

#### Extra MCP servers for every agent

Every agent has FACTORY's job board as an MCP server. `mcpServers` in the plan adds
more, the same for every agent of the fleet, with Codex or Claude Code as the worker
program:

```js
await fleet.deploy({ ...plan,
  mcpServers: {
    // Runs inside each worker container: the worker image must have the command.
    lean: { command: 'lean-lsp-mcp', env: { LEAN_PROJECT_PATH: '/data/repository' }, required: true },
    // Reached over the network. A key is written { secret: 'NAME' } and given to deploy.
    docs: { url: 'https://mcp.example.com/mcp', headers: { Authorization: { secret: 'DOCS_AUTH' } } },
  },
}, { ...options, mcpSecrets: { DOCS_AUTH: `Bearer ${docsToken}` } });
```

- **A server in each container**: `command`, with optional `args` and `env`. It
  runs next to the worker program, as the same user, so the worker image must
  provide it; on Docker, put it in the base `image` you pass with `prebuild: true`.
- **A server over the network**: `url` and optional `headers`. The address must be
  `https`; plain `http` only for a server on the deploying computer, which a Docker
  fleet reaches as `http://host.docker.internal:<port>` and a Fly fleet cannot reach.
- **Keys**: a value in `env` or `headers` written `{ secret: 'NAME' }` is filled in
  inside the container from `deploy(plan, { mcpSecrets: { NAME: '...' } })`. Every
  key the servers refer to must be given, and no other; each has at least 8
  characters. Keys travel like the logins, as a staged secret, and stay out of the
  plan, the fleet journal, traces and collected evidence: the session settings that
  hold them are in `/data/factory-private`, which evidence never collects. Give the
  keys again when `deploy` resumes a fleet; to change one, start a new fleet.
- **`required: true`**: an agent never works without that server. Its Codex
  session does not start, or its Claude Code turn ends as failed, when the server
  did not connect. Without it, the agent works on and the trace shows the server
  as failed. The job board is always required.
- **What connected**: each Claude Code turn records `session/configured` in the
  trace: the model that answers and the status of every MCP server.
- **Permissions**: Claude Code may use the servers' tools in every sandbox. Codex
  asks for approval before an MCP tool call under `workspace-write` and
  `read-only`, and the fleet never approves, so use them with Codex under
  `danger-full-access`.
- Server names use lowercase letters, digits, `-` and `_`; `factory` is the job
  board's. Up to 16 servers. `validateMcpServers(servers)` checks a list and
  returns the key names it refers to. FLUJO workers do not take `mcpServers` yet;
  they use `flujo.servers`. Servers per team or per seat are on the
  [roadmap](https://github.com/flujo-app/FACTORY/issues/46).

#### Agent instructions and the job board

Each agent gets FACTORY's built-in instructions, added to its system prompt, and
the goal as its first message: a lead gets the goal as it is, the others are told
to work on it under their lead. The built-in instructions are also where an agent
learns how FACTORY works: use the board tools, claim an item before working on it,
one team per item, who may message whom, read the inbox.

> [!IMPORTANT]
> `agentInstructions`, and a seat's `instructions` from a `prepare` hook,
> **replace** the built-in instructions; they are not added to them. Copy the
> job-board part into your own text (the built-in text is in
> `src/cloud-lite/runtime.mjs`, where each agent's instructions are set), or the
> agents will not know how to use the board. Keeping that part always in is on the
> [roadmap](https://github.com/flujo-app/FACTORY/issues/46).

#### Self-hosted models and operator-driven jobs

To run the model yourself, `ModalSelfHostedModel` (CLI `factory-selfhost`) deploys a
bundled vLLM profile on your Modal account and returns this description from `endpoint()`,
with its key from `key()`; see [selfhost/README.md](selfhost/README.md).
`RunPodSelfHostedModel` does the same on RunPod GPU pods, with the same description and key
([selfhost/runpod/README.md](selfhost/runpod/README.md)).

Lite workers can run on a self-hosted, OpenAI-compatible model instead of the
subscription login. Codex reaches it through the Responses API
(`/v1/responses`), which vLLM serves for every model. Add `modelProvider` to the
plan and pass its key as `providerKey`; no `auth` broker is needed. A read-only
GitHub deploy key can replace the GitHub token:

```js
const fleet = new FactoryCloudLiteFleet({ directory: '/absolute/private/fleet-run',
  flujoCloudPath: '/absolute/installed/flujo-cloud' });
await fleet.deploy({
  runId: 'my-selfhosted-run', app: 'my-selfhosted-app', goal: ownerGoal,
  repository: 'owner/project', repositoryRevision: pinnedCommitSha,
  machines: 10, agentsPerMachine: 19,
  model: 'nemotron-3.5-super-vl', subagentModel: 'nemotron-3.5-super-vl', reasoningEffort: 'medium',
  modelProvider: {
    id: 'selfhosted', name: 'Self-hosted model', envKey: 'SELF_HOSTED_MODEL_KEY',
    baseUrls: ['https://model-a.example/v1', 'https://model-b.example/v1'],
    contextWindow: 262144, autoCompactTokenLimit: 80000,
  },
  supervision: 'operator', sandbox: 'workspace-write', boardTools: false, monitorIntervalMs: 4000,
  agentInstructions: 'Wait for operator jobs and work only in your folder.',
  prepare: { argv: ['node', 'tools/prepare-agents.mjs'], spec: { jobsPerMachine: 18 } },
}, { image: immutableWorkerImage, bundlePath: '/absolute/private/flujo-factory.tgz',
  providerKey: privateEndpointKey, deployKey: readOnlyDeployKey });
await fleet.command('m0-a1', { id: 'job-1', action: 'message', message: 'First job ...' });
```

- **`modelProvider`** is one description of the endpoint that each worker program
  maps to its own settings. `id`, `envKey` (the variable that carries the key) and
  `https` `baseUrls` (OpenAI-style, ending in `/v1`) without credentials are
  required. `apis` lists the wire APIs the server offers: `responses` (Codex),
  `anthropic` (Claude Code, `/v1/messages`) and `chat`; FLUJO can use any of them. vLLM
  serves all three; the default is `['responses']`. `name`, `model`, `contextWindow`,
  `autoCompactTokenLimit`, `toolOutputTokenLimit`, `requestMaxRetries`,
  `streamMaxRetries`, `streamIdleTimeoutMs` and `requestTimeoutMs` are optional.
  `codexProviderConfig`, `codexProviderOverrides`, `claudeProviderEnvironment` and
  `flujoProviderModel` are exported mappings; `providerPrograms(provider)` says which programs can use
  it. Each Codex gets a `config.toml` with the provider, the model's real context
  window and its compaction point; web search, multi-agent, apps, plugins, goals,
  memories and skill instructions are off, and agents' shell commands inherit only
  the core environment. The key is a staged Fly app secret placed only in the
  worker program's process environment; agent commands, journals and traces do not get it.
  Machine *i* uses `baseUrls[i % n]`, so each machine keeps its prompt cache on one
  server. Codex offers no `apply_patch` tool to an unknown model, so ask agents to
  edit files with shell commands.
  Claude Code gets the server root as `ANTHROPIC_BASE_URL`, the key as a bearer
  token, every model alias on the served model, the real context window and
  compaction point, and no telemetry or per-turn token reminder. That reminder
  would be an extra system message that templates move to the front of the
  prompt, which defeats the server's prompt cache.
- **`supervision: 'operator'`**: agents start idle. There is no automatic first
  turn, follow-up or wake; every turn comes from a durable
  `fleet.command(agent, { id, action: 'message' | 'stop' })`. The default,
  `'autonomous'`, keeps the existing goal-driven behavior.
- **`sandbox`**: the sandbox for agent commands. The default stays
  `danger-full-access`. `workspace-write` lets commands write only the agent's
  folder plus the prepare hook's `writableRoots`, with no network; `read-only` is
  also accepted.
- **`boardTools: false`** removes the FACTORY board MCP server from the sessions.
  The default instructions refer to board tools, so also set `agentInstructions`
  or per-agent `instructions` from the prepare hook. Verified workflows need the
  board tools and automatic wakes, so they refuse either setting.
- **`prepare`** runs `argv` once per machine after the pinned clone, in the
  repository folder, with `FACTORY_MACHINE_INDEX` and `FACTORY_PREPARE_SPEC` (a
  JSON file holding `spec`). It prints one JSON line,
  `{ "agents": [{ "cwd", "writableRoots"?, "instructions"? }] }`, with one entry per
  agent slot and absolute paths. The result is kept on the volume, so a restarted
  machine reuses the prepared folders without cloning again; the hook may remove
  files agents must not read. Output goes to `/data/factory/prepare.log`. The
  hook must be idempotent and finish within `timeoutMs` (default 30 minutes).
- **`deployKey`** clones over SSH with GitHub's published host key pinned. No `gh`
  login happens and agents receive no Git credential. Use a read-only deploy key;
  images without the bundle bootstrap need `openssh-client`.
- **Traces**: streaming deltas (`*Delta`, `*/delta`, rate-limit updates), the bulk
  of all notifications, are no longer recorded; `item/completed` carries the same
  content. `traceDeltas: true` records them again. `monitorIntervalMs` (default
  15000) sets how often each machine reads operator commands.

Example models (vLLM 0.32 with `--enable-auto-tool-choice`, `--enable-prefix-caching`):

| Model | GPU | Parsers | `contextWindow` | `autoCompactTokenLimit` |
|---|---|---|---|---|
| Qwen3.8-27B FP8 | 1 × H100 80 GB | `--tool-call-parser qwen3_xml --reasoning-parser qwen3` | 262144 | 80000–100000 |
| Nemotron 3.5 Super VL 120B-A12B NVFP4 | 1 × B300 | `--tool-call-parser qwen3_coder --reasoning-parser nemotron_v3 --trust-remote-code --mamba-cache-mode align` | 262144 | 80000 |

Measured with operator-driven coding jobs: one H100 with the Qwen model kept
about 8 long conversations (histories averaging 55k tokens) at full speed; beyond that its
cache could not hold every history and prompt-cache hits fell from about 90% to
15%. One B300 with the Nemotron model carried a 190-agent run (10 machines × 19
sessions): about 170 requests at once at the peak with none queued, GPU cache at
most 37% full, 84% of 464 million input tokens served from the prompt cache, and
12.5 million output tokens in 2 h 18 min for about $20 of GPU time. Its
multi-token prediction (`--speculative-config '{"method":"mtp","num_speculative_tokens":1}'`)
makes each agent faster up to about 128 agents; beyond that run without it.
Compacting at 80000 tokens kept agent contexts between 30k and 90k.

The cloud MCP adds identity/status, work claims and progress, authenticated
messages/inbox, checkpoints, and supervisor Windows/Linux validation requests.
The operator HTTP interface supports authenticated observations, trace export,
validation evidence and durable steer/stop commands. Agent-reported work status
is distinct from independently verified GitHub delivery.

Provider mutations retain durable intents. An uncertain operation blocks another
mutation under that key rather than launching duplicate infrastructure. Stop,
artifact collection, owned retirement, provider billing and filesystem cleanup
remain distinct stages. Native histories and local trace outboxes survive on
the volumes; collect them before retirement. `quiesce()` sends durable stop
commands and waits for every native agent to acknowledge. A new stop supersedes
older queued messages, with separate cancellation receipts; retrying its id
preserves later explicit messages. `collect()` quiesces the pool, copies all
worker data, makes consistent SQLite backups, and downloads archives with
verified SHA-256 digests and file manifests. Each Machine retains its collection
job receipt; incomplete JSONL tails are preserved separately as raw bytes.
Observation timeouts do not launch another copy. A failed or missing
job requires inspection before an explicit new `attempt` identity is selected.
Transfers report captured bytes, accept `transferTimeoutMs`, and retain partial
downloads. Repeating the same capture attempt observes its original remote job
and uses a fresh destination for an incomplete download.
`includeGitObjects: false` omits cloned Git object stores while retaining current
source files, Git metadata, native histories, traces and test evidence. Select a
new capture `attempt` when changing this setting; full Git history is included
by default.
Identical files with matching permissions share snapshot hard links, so repeated
worktree assets occupy one archive entry while every original path is retained.
`machineIds` selects original owned Machines for recovery of an incomplete
collection. Previously verified archives are retained; the returned `complete`
flag is true only when all original Machines have collected receipts.
Dependency caches, `.next` output and `auth.json` are omitted. Archives remain
private because native histories and worktrees can contain confidential source.
`retire()` verifies the original Machine and volume inventory before destroying
the dedicated app.

The [2026-10-14 Fly run](evidence/cloud-lite-run-20261014.json) verified 10 real
Machines with 100 distinct subscription-authenticated native sessions. All 100
started turns and used built-in shell or MCP tools. The observed 943 agent
messages included 298 cross-machine orchestrator messages and no forbidden
subagent deliveries; a real cross-machine subagent call was explicitly rejected.
A separate cold SDK deployment reached its native shell/MCP checkpoint in about
155 seconds from app creation, using the upstream Machines API and private proxy.
This proves the configured launch and communication path. FLUJO reviews retained
real test receipts and findings, but other owners performed the observed merges;
five owned drafts retain their original acceptance holds. Full production
qualification and those held FLUJO deliveries are not asserted.

### Lite fleets on local Docker

`FactoryDockerLiteFleet` runs the same fleet on this computer's Docker instead of
Fly. It needs Docker with Linux containers, no Fly account and no flujo-cloud.
The plan, the worker programs (Codex, Claude Code, FLUJO), the logins, the shared
board and every fleet action (`observe`, `command`, `stop`, `start`,
`updateRuntime`, `quiesce`, `collect`, `supervise`, `retire`) are those of
`FactoryCloudLiteFleet`.

```js
import { FactoryDockerLiteFleet, CodexSubscriptionBroker } from 'flujo-factory';

const fleet = new FactoryDockerLiteFleet({
  directory: '/absolute/private/fleet-run',
  auth: new CodexSubscriptionBroker({ authFile: '/absolute/private/.codex/auth.json' }),
});
await fleet.deploy({
  runId: 'my-local-run', app: 'my-local-swarm', goal: ownerGoal,
  machines: 3, agentsPerMachine: 4, cpus: 2, memoryMb: 4096,
});
const observation = await fleet.observe();
await fleet.retire();
```

What a plan turns into:

- **One container per machine**, named `factory-<runId>-m<index>`, with one Docker
  volume `<app>-factory_m<index>` on `/data` and one private network named after
  the app. The first container holds the board, as on Fly.
- **The same private name for the board.** Each container answers on the network
  as `<machine id>.vm.<app>.internal`, so the worker runtime is unchanged.
- **The host reaches the board on a loopback-only port** that Docker picks
  (`127.0.0.1`). No worker port is published, so nothing is open to the local network.
- **`cpus` and `memoryMb` are limits for each container.** `region` and `cpuKind`
  have no effect.
- **`diskGb` has no effect.** On Fly every machine gets its own disk of that size.
  A Docker volume is a folder on Docker's one shared disk, and Docker sets no
  size limit per volume: every machine can write until that shared disk is full.
  Its size is a Docker setting (Docker Desktop: Settings, Resources).
- **A model server on this computer** (Ollama, LM Studio, llama.cpp, vLLM) can
  serve the workers over plain `http`, as `http://host.docker.internal:<port>/v1`;
  see below.

`deploy` takes the same options as on Fly, with two defaults. Without `image`,
workers start from `node:24-bookworm-slim` and set themselves up on their first
start; any Debian-based image with a supported Node works, and a
digest reference (`node@sha256:...`) keeps runs repeatable. Without `bundlePath`,
the installed SDK is packed once into `factory-sdk.tgz` in the fleet directory and
reused when the fleet is resumed. Pass `bundlePath: false` for an image that
already holds the runtime in `/opt/factory`. Fly image sources (`imageSource`,
`channel`) and the plan's `network` are refused.

**Set-up once instead of in every container: `prebuild: true`.** The set-up
(system packages, the worker program, the SDK and its packages) takes minutes.
With `deploy(plan, { prebuild: true })` it runs once, in an image built from
`image`, and every container starts from that image in seconds:

```js
await fleet.deploy(plan, { prebuild: true });
```

The image is named `factory-worker:<program>-<hash>`. The hash follows from the
base image, the SDK bundle and the worker program, so a later fleet with the same
three finds the image and builds nothing. A new SDK version means one new build.
Images stay until you remove them: `docker image ls --filter label=factory.docker.image`
lists them. `fleet.infrastructure.buildImage({ baseImage, bundlePath, workerProgram })`
builds one without deploying.

Without `prebuild`, each container runs the set-up itself on its first start.
Either way a container records the finished set-up and skips it when it is
started again, so `stop()` and `start()` take seconds. `updateRuntime` with a new
bundle makes new containers that set themselves up once more.

**A model on this computer.** A `modelProvider` may use plain `http` for a server
on the same computer. Containers reach it as `host.docker.internal`:

```js
const fleet = new FactoryDockerLiteFleet({ directory: '/absolute/private/fleet-run' });
await fleet.deploy({
  runId: 'my-local-run', app: 'my-local-swarm', goal: ownerGoal, machines: 2, agentsPerMachine: 3,
  model: 'my-model', subagentModel: 'my-model',
  modelProvider: { id: 'local', envKey: 'LOCAL_MODEL_KEY', model: 'my-model',
    baseUrls: ['http://host.docker.internal:11434/v1'], apis: ['responses'] },
}, { providerKey: 'any-text-if-the-server-wants-no-key', prebuild: true });
```

- Plain `http` is accepted only for names of this computer: `localhost`,
  `127.0.0.1`, `[::1]` and `host.docker.internal`. Every other address still
  needs `https`.
- A Docker fleet takes only `host.docker.internal`: inside a container,
  `localhost` is the container itself. A Fly fleet refuses all four, because a
  Fly machine cannot reach the computer that deploys it. Local lite workers
  (`factory-lite ... --model-provider`) run on this computer and may use `localhost`.
- The server must offer the interface of the worker program: `responses` for
  Codex, `anthropic` for Claude Code, any of the three for FLUJO. Ollama offers
  all three.
- On Docker Desktop a server that listens only on `127.0.0.1` is reachable. On
  Docker for Linux the server must listen on the Docker bridge address too (for
  Ollama: `OLLAMA_HOST=0.0.0.0`).
- The model must be able to call tools for agents to use the board. A model too
  small for that still answers, which is enough to check the connection.
- The same rules hold for an [extra MCP server](#extra-mcp-servers-for-every-agent)
  on this computer: `url: 'http://host.docker.internal:<port>/...'`.

**The stricter sandboxes need `nestedSandbox: true`.** With the plan's default
sandbox (`danger-full-access`) an agent's commands may do anything inside its
container; the container is what keeps them off this computer. `workspace-write`
lets them write only in the agent's own folder, with no network, and `read-only`
lets them write nowhere. The worker program enforces both by running each command
in a small isolated area of its own (bubblewrap). A default Docker container may
not create such an area: in a real run every command of an agent failed with
`bwrap: No permissions to create new namespace`. So a Docker fleet refuses these
two sandboxes unless it was created for them:

```js
const fleet = new FactoryDockerLiteFleet({ directory, auth, nestedSandbox: true });
await fleet.deploy({ ...plan, sandbox: 'workspace-write' }, { prebuild: true });
```

`nestedSandbox: true` runs the fleet's containers without Docker's system-call
filter (`--security-opt seccomp=unconfined`), which the isolated area needs. That
is a trade: agent commands are held more tightly, while the container as a whole
loses one of Docker's own protections. Nothing else changes: no extra privileges
and no access to this computer's files. As on Fly, Codex asks for approval before
a board tool call under these sandboxes and the fleet never approves, so pair them
with `boardTools: false` for Codex.

Before anything is recorded, the fleet checks that Docker runs, uses Linux
containers and has the CPUs one machine asks for. A stopped Docker therefore
leaves no half-made fleet directory behind.

Logins and board credentials are copied into each container as root-only files
under `/run/factory/secrets` and become environment variables of the worker
runtime only. They are never part of a command line or of `docker inspect`. The
fleet directory keeps them in `docker-secrets.json` until `retire()`; store the
directory privately. Anyone who may use Docker on this computer can read inside
the containers, as with any local container.

Everything the fleet creates carries the label `factory.docker.app=<app>`. A
volume or network that already exists under a needed name is never adopted, and
`retire()` removes only labelled containers, volumes and the network, after the
same inventory check as on Fly. `updateRuntime` replaces each container with a new
one that keeps its machine identity, name and volume; the old container is set
aside until the new one runs and is put back if the replacement fails. A machine
whose setup fails stops its container: read `docker logs factory-<runId>-m<index>`
or `/data/factory/bootstrap.log` on its volume.

Containers do not restart by themselves. After `stop()`, or after the computer
or Docker was restarted, call `start({ attempt })` with a new attempt name; a later
`stop()` then stops them again. A container that is started again skips its
set-up and is back in seconds. An agent resumes the session it had; a Codex
session that never ran a turn has no history to resume, so that agent records it
and opens a new one.

`createDockerInfrastructure({ directory })` is the provider on its own. It answers
the provider commands a fleet sends, for use as the `infrastructure` of a
`FactoryCloudLiteFleet`.

The [2026-11-23 Docker run](evidence/docker-fleet-acceptance-20261123.json) used
real containers on Docker Desktop for Windows: two machines with two Codex agents
each, on a subscription login. All four agents enrolled through the shared board.
An agent in the second container recorded a claim on the board in the first,
once before and once after a stop and start. The runtime update, the collection
with verified archives and the removal of every container, volume and the network
passed too. The same record holds two shorter runs in which Claude Code and FLUJO
workers started in containers and enrolled on the board. Those two used
placeholder logins and called no model, so model turns of Claude Code and FLUJO
on Docker are not asserted by that record.

A [second record of the same day](evidence/docker-fleet-runs-20261123.json) holds
seven more real runs on the same computer:

- **Claude Code with real turns.** Two containers with two agents each, from a
  pre-built image, on a subscription token: a claim recorded on the shared board
  before and after a stop and start, then a runtime update, collection and
  removal. The image took 3 minutes 43 seconds to build, once. After that all
  agents were enrolled 4 seconds after the deploy, and back 5 seconds after a
  restart.
- **Ten teams of nine workers and a lead.** Ten containers, 100 Claude Code
  agents, every one with a real model turn. Each worker recorded its own claim
  and messaged its lead; each lead read its inbox and found its nine messages.
  Once the image was ready, the ten containers were created and all 100 agents
  enrolled within 12 seconds. The 100 turns took a minute and a half, and an idle
  container used about 46 MB of memory.
- **A model on the same computer.** Codex, Claude Code and FLUJO workers each
  completed a turn with an answer from a model served by Ollama over plain
  `http`. The model was the 9 MB TinyLLama-v0, which writes story-like text and
  cannot use tools: these runs show the connection, not useful work by a local
  model.
- **The `workspace-write` sandbox** with `nestedSandbox: true`, for Codex and for
  Claude Code: the agent's command wrote a file in its work folder and could not
  write one outside it.

Not shown by either record: useful work by a model served on the same computer,
Docker on a Linux host, the `read-only` sandbox, and more than ten machines. To
repeat the checks on your own Docker:

```sh
node scripts/docker-fleet-smoke.mjs --directory /absolute/empty/folder --evidence /absolute/result.json --prebuild
```

Add `--turn` for two real messages to one agent, or `--teams --machines 10 --agents 10`
for a real turn of every agent. `--program claude --claude-token <file>` and
`--program flujo` select the other worker programs. `--model-url <address> --model <name>`
uses a model server instead of a login, with `--reply` when the model cannot use
tools. `--sandbox workspace-write` checks the sandbox. `--quick` skips the stop,
start, update and collection.

### Lite fleets on Fly.io Sprites

`FactorySpriteLiteFleet` runs the same fleet on [Fly.io Sprites](https://sprites.dev)
instead of Fly Machines. A Sprite is a ready-made Linux computer (Ubuntu, 8 CPUs,
100 GB of disk, Node, git and Claude Code already on it) that keeps its files and
pauses when nothing runs on it. There is no image to build and no flujo-cloud: a
Sprites token from the Fly dashboard (Sprites, Tokens) is all it needs.

```js
import { FactorySpriteLiteFleet, ClaudeSubscriptionBroker } from 'flujo-factory';

const fleet = new FactorySpriteLiteFleet({
  directory: '/absolute/private/fleet-run',
  tokenFile: '/absolute/private/sprites-token',   // or token: '...', or SPRITES_TOKEN
  auth: new ClaudeSubscriptionBroker({ tokenFile: '/absolute/private/claude-token' }),
});
await fleet.deploy({
  runId: 'my-sprite-run', app: 'my-sprite-swarm', goal: ownerGoal,
  workerProgram: 'claude', machines: 3, agentsPerMachine: 10,
});
const observation = await fleet.observe();
await fleet.retire();
```

What a plan turns into:

- **One Sprite per machine**, named `<app>-m<index>`. The worker runs as the
  Sprite service `factory`: `sudo` starts `/etc/factory/start.sh` as root, which
  loads the machine's settings and secrets and then runs the same bootstrap as a
  Fly Machine. The first start sets the Sprite up (system packages, the pinned
  worker program, the SDK) in about 20 seconds; the Sprite keeps that set-up on its
  disk, so `stop()` and `start()` take seconds.
- **The board on the first Sprite's public address.** Sprites have no private
  network, so the first Sprite's address is public and routed to the board's
  port, and the other machines reach the board there (`FACTORY_BOARD_ORIGIN`).
  Every call to the board still needs that agent's own credential or the operator
  token, as on Fly; only `/health` answers without one. The other Sprites stay
  private. The host reaches the board on the same address; nothing runs on this
  computer.
- **Awake while the workers run, asleep after.** A Sprite pauses about 30 seconds
  after its last connection, even in the middle of a model call. The start script
  therefore holds a Sprite task (renewed every minute, five minutes at a time)
  for as long as the worker runs, and gives it back when the worker stops. A
  stopped fleet's Sprites pause and cost only their disk.
- **A volume is the Sprite's own disk.** `/data` is a folder on it, and it stays
  until `retire()` deletes the Sprite.
- **`cpus`, `cpuKind`, `memoryMb`, `diskGb` and `region` have no effect.** Every
  Sprite has 8 CPUs and 100 GB; its memory is managed by the platform.
- **Secrets** (logins, board credentials, the plan's MCP keys) reach each Sprite as
  root-only files under `/etc/factory/secrets`, written through the input of one
  command, never in an address or a command line. The fleet directory keeps them
  in `sprites-secrets.json` until `retire()`, and records the fleet's Sprites in
  `sprites-state.json`; store the directory privately. The Sprites token itself is
  never written there.

`deploy` takes the same options as on Fly, except the image: Sprites have none, so
`image`, `imageSource`, `channel` and `prebuild` are refused, and so is the plan's
`network`. Without `bundlePath` the installed SDK is packed once into
`factory-sdk.tgz` in the fleet directory. A model server on this computer cannot be
reached from a Sprite; give it an `https` address.

Sprites named like the fleet's (`<app>-m<index>`) that this fleet directory did not
create are never adopted: `deploy` refuses to start, and `retire()` refuses to
delete anything while one exists. A machine whose set-up fails is deleted again by
the call that created it. Read a Sprite's start with
`sprite exec -s <app>-m0 sudo cat /data/factory/bootstrap.log` or its service log in
`/.sprite/logs/services/factory.log`.

On Fly's Free plan an organization may have 3 Sprites at a time, and usage counts
against its monthly $5; Sprites are billed only while they are awake (Fly lists
about $0.04 per CPU-hour and $0.02 per GB-hour of memory, November 2026).

`createSpritesInfrastructure({ directory, token })` is the provider on its own, for
use as the `infrastructure` of a `FactoryCloudLiteFleet`.

The [2026-11-23 Sprite runs](evidence/sprite-fleet-run-20261123.json) used real
Sprites on a Free plan organization, one Sprite with four Claude Code agents on a
subscription login. In the final run the Sprite was created in 11 seconds, set
itself up, and all four agents had enrolled on the board through its public
address 32 seconds after the deploy. With nothing on this computer talking to it,
it was still running after 90 seconds. An agent took a real turn and recorded a
claim on the board. After `stop()` the Sprite paused; after `start()` it woke,
skipped its set-up, every agent was enrolled again 9 seconds later, and a second
real turn recorded its claim. `retire()` deleted the Sprite. The two earlier runs
of that record found two faults that are fixed: a stopped worker ended with its
signal's exit code, which the Sprite recorded as a crash, and the Sprite's own
older Claude Code stood in for the pinned one.

Not shown by that record: a fleet of more than one Sprite (a second Sprite reaches
the board the same way this computer did), memory per agent (`free` inside a Sprite
gave readings too far apart to use), the stricter sandboxes inside a Sprite, and
collection or a runtime update on a real Sprite, which the tests check against a
stand-in for the Sprites API. To repeat the run on your own Sprites (agents enrol
and wait; add `--claude-token <file> --turn` for two real model turns):

```sh
node scripts/sprite-fleet-smoke.mjs --directory /absolute/empty/folder --evidence /absolute/result.json --sprites-token /absolute/private/sprites-token
```

`FactorySwarmEngine` and `createManagedCloudAdapter` are exported from the same
package. The engine accepts a configured adapter and a claimed `FactoryControl`
task lease. `provisionWorker` reserves a child cell and records a provider
provisioning effect before calling the adapter. `callWorker` records one flow-call
effect under a key derived from the worker and explicit conversation ID.
`runConversations` sends distinct claimed tasks through a bounded concurrent
queue, preserving each task and conversation ID for recovery.
`retireWorker` records an owned cleanup effect.
Repeated keys return the retained effect without another external call. An
uncertain provider outcome remains `unknown` and requires reconciliation.
For an unknown local FLUJO retirement, call
`engine.reconcileRetiredWorker({app})` after the external lifecycle has settled.
The FLUJO adapter observes exact workspace absence for 15 seconds without
issuing another delete. A present or reappearing workspace leaves the original
effect unknown; a confirmed absence settles that effect and makes subsequent
replays stable. Other adapters must implement `observeRetired(app)` to use this
method. The observation is bounded and cannot guarantee that a faulty FLUJO
background writer will never recreate the workspace later.
Worker retirement alone does not close the Factory cell; that requires the
controller's separate provider-evidence closure path.

For managed FLUJO-CLOUD workers, construct the same engine with
`createManagedCloudAdapter({ modulePath, options })`, where `modulePath` is the
absolute path to the installed `flujo-cloud` `lib/managed.mjs` and `options`
contains that service's private configuration. Claim a FACTORY task through
`FactoryControl`, then pass its lease to `engine.provisionWorker` with a unique
`cellId`, exact `app`, and the `ManagedCloud.up` input. Use `engine.callWorker`
with the same lease, exact worker app, a unique `conversationId`, a FLUJO flow
`request`, and an absolute private `outputPath`; use `engine.retireWorker` for
recorded cleanup. Each operation uses the FACTORY ledger and retains its
original outcome on replay. The managed adapter does not implement live
health inspection or automatic reconciliation of uncertain cloud retirement:
retain the attempt files and use the provider's recovery procedure before
claiming closure. `FactoryManagedFleet` accepts this managed adapter and the
same durable worker plan shape as `FactoryLocalFleet`: `run`, append-only
`scale`, bounded conversation dispatch, replay and child-first `retire`.
Each worker needs a positive `paidCeilingCents`; `budgetCents` remains a separate
logical cell allocation. Pass an already initialized shared `SpendingLedger`
and an explicit provider to the fleet. It reserves and starts one durable paid
hold before each managed provision, checks paid admission again before each
managed flow call, and retains the full hold pending final billing after
retirement. This is an accounting admission boundary; it cannot enforce a
provider-side spending cap or establish final charges.
`fleet.paidReservationId(app)` returns the stable reservation key for later
meter observations and final billing reconciliation through the shared ledger.
One setting picks the CPU of a Fly worker: `cpuKind`, either `'performance'`
(the default) or `'shared'`. Pass it to `adapter.preflight(...)`,
`adapter.provision(...)`, or in a managed fleet worker's `provisionInput`:

```js
provisionInput: { app: 'my-worker', workspace: 'my-workspace', cpuKind: 'shared' }
```

A worker has two CPUs, and `memoryMb` follows the kind, within Fly's limits per
CPU: `'performance'` takes 4096 to 16384 in steps of 2048 (4096 when omitted),
`'shared'` takes 1024 to 4096 in steps of 256 (2048 when omitted). A size outside
that range is refused before anything is created; a call that sets
`memoryMb: 2048` therefore also needs `cpuKind: 'shared'`. A shared CPU is
throttled to a small share of its time after a short burst, a performance CPU is
not, and a running performance worker costs about five times as much (Fly lists
$66.00 against $13.39 a month for the two default sizes, November 2026).
The bundled ManagedCloud bridge applies the selection to both initial creation
and bootstrap, and the journal and receipts record it. An external `flujo-cloud`
module must support `cpuKind` to apply this setting; a receipt without `cpuKind`
means the module did not apply it. A cloud lite fleet has the same setting in
its plan (`cpuKind`, beside `cpus` and `memoryMb`), where `'shared'` stays the
default.

Each worker's `provisionInput` is its exact `ManagedCloud.up` input, including
`app`; each conversation supplies its exact `conversationId`, FLUJO request
and absolute private output path. FACTORY persists input digests and effect
receipts rather than the private deployment input. Managed retirement confirms
the adapter's `down` receipt; it leaves the logical cell ready. After successful
child-first retirement, `fleet.closeRetired(plan,{workerId,flyPath,managedDirectory,org,workspace})`
can close that cell using the original ManagedCloud private journal, the exact
FACTORY task/effect/paid-hold binding, and a fresh read-only Fly app inventory
from the explicitly selected CLI and organization. It rejects a visible app,
changed generation, unresolved effect or missing provider evidence. Closure
accepts an already settled bill and never changes the paid reservation; an
unsettled hold remains pending metering and final billing. A new fleet instance
with a reopened controller and paid ledger can complete or replay the closure
without repeating the managed `down` operation.
An `unknown` managed `down` remains held without a second provider call;
an effect still marked `running` cannot be reconciled while its caller may
remain active.
If ManagedCloud's private journal already records cloud-confirmed teardown,
`fleet.reconcileRetired(plan,{workerId,flyPath,managedDirectory,org,workspace})`
can use the same fresh provider absence inspection to settle the original
retirement effect and paid hold, including after a restart. It then permits
`closeRetired`. A missing or incomplete journal remains held for operator
recovery.
ManagedCloud's cached `list` inventory is not live health or physical absence
evidence.
`FactoryManagedFleet` rejects inherited live message, cancellation and
conversation reconciliation calls explicitly because this adapter cannot
provide the corresponding FLUJO evidence.
The [real-module integration check](evidence/managed-fleet-real-module-20261008.json)
ran this paid fleet through the vendored `ManagedCloud` application service and
its private journal, with synthetic local source, image and cloud bridge
fixtures. It covered provision, flow call, replay, retirement and logical cell
closure from that service's own retired journal plus a synthetic read-only Fly
absence response. It did not create a provider resource or establish final
billing.

```js
import { FactoryManagedFleet, SpendingLedger, createManagedCloudAdapter } from 'flujo-factory';

const paidAdmission = new SpendingLedger('/absolute/private/shared-spending.sqlite');
paidAdmission.initialize({ limitCents: 10000, currency: 'USD' });
const adapter = await createManagedCloudAdapter({
  modulePath: '/absolute/flujo-cloud/lib/managed.mjs', options: privateOptions,
});
// Each managedPlan worker includes paidCeilingCents and its ManagedCloud.up input.
const fleet = new FactoryManagedFleet('/absolute/private/factory.sqlite', adapter,
  { paidAdmission, provider: 'fly' });
const result = await fleet.run(managedPlan, { workerConcurrency: 4, conversationConcurrency: 20 });
paidAdmission.close();
```

Recursive delegation uses the same database: a ready child cell claims its own
FACTORY task, then passes that lease to `provisionWorker` to reserve and launch
its child. Budget-only growth retains each parent's allocation as the limit.
`FactoryLocalFleet` automates this for a supplied local FLUJO plan: it creates
immutable provision and conversation tasks, launches parents before children,
dispatches bounded conversations, and closes only from exact retained receipts.
Replaying a completed plan checks the original worker binding and saved output
bytes. Busy or uncertain work returns `held` and is not sent again.
To grow a running local swarm, call `fleet.scale(expandedPlan, options)` with
the original workers and jobs plus new workers or conversations. The plan is
append-only: existing task identities and inputs must match their recorded
specifications. A job still running in this fleet instance is reported as
`running` in the scale result; its original `run` promise remains its completion
handle. Concurrent runs on one fleet instance share worker and conversation
slots, so use the same concurrency options until they finish. Child workers
wait for their parent launch. The controller remains the one worker registry.
After all plan conversations reach `completed` or `cancelled`, call
`fleet.retire(plan)` to retire workers from leaves toward the root through
recorded cleanup effects. A concurrent run or unresolved conversation or
steering effect holds retirement. Repeating a successful retirement observes
its original effect without another provider call. For an unknown local retirement, call
`fleet.reconcileRetired(plan,{workerId})` after FLUJO has settled; this requires
the adapter's read-only absence evidence. Workspace retirement alone does not
close the Factory cell. With the official `createFlujoWorkspaceAdapter`, call
`fleet.closeRetired(plan,{workerId})` after the worker's retirement succeeds,
closing children before parents. It makes a separate direct, read-only
15-second exact-workspace absence check against the origin bound into the
original provision and retirement receipts, then retires the logical cell
through FACTORY's opaque proof path. Replaying a closed cell does not inspect
FLUJO again. An injected adapter or an older provision receipt without that
origin binding cannot use this closure path. Local workspace absence does not
establish physical machine isolation or provider billing finality.
The [live retirement check](evidence/local-flujo-fleet-retirement-20261008.json)
ran the fleet-level path with one unpaid synthetic worker and conversation
against the pinned FLUJO lifecycle PR. The earlier 10-worker/300-conversation
acceptance exercised the same scheduler with lower-level retirement.
The [live cell-closure check](evidence/local-flujo-cell-closure-20261008.json)
then ran one unpaid synthetic worker through the current SDK's workspace
retirement and trusted logical cell closure against an isolated FLUJO scratch
server. The scratch source is identified in that record and predates the
merged FLUJO #955 main commit.

`createFlujoWorkspaceAdapter({origin, token})` drives local FLUJO workspaces.
Provisioning takes `{app, flowSpec}` or `{app, flowSpecs}` and requires a new
`swarm-<app>` workspace; it compiles every supplied flow before marking the
worker ready. `buildFactoryTeamSpecs` produces the local `swarm_agent` and
`swarm_team` pair. With `CASE_SPECIALISTS_V1`, each team has one lead and a gate
for nine specialist subflows; ten such teams describe SAVIA's 100-conversation
topology. This is a template target, not evidence that 100 conversations ran.
Pass `teamTemplate: {model, specialists: CASE_SPECIALISTS_V1}` during provisioning
to build the pair from the newly created workspace's actual connected tool
inventory.
The template's `model` is an ID installed in each target FLUJO workspace. Pass
`modelConfig` with the same ID during provisioning when the workspace needs that
model installed. `availableServers` must reflect the workspace's connected tool
inventory. Model credentials remain private input to the adapter and are not
included in Factory observation receipts.

For a SAVIA case, `buildSaviaCasePlan` assembles the ten distinct lead launches
and their `swarm_team` submissions. Supply ten independent `angles`, an explicit
logical `budgetCents`, an installed `model`, and an existing absolute private
`outputDirectory` before calling `fleet.run(plan)`. By default the logical case
budget is split as evenly as possible across the ten leads. Optional
`teamBudgetCents` overrides those allocations; optional `timeoutMs` sets a per-lead
deadline. Without it, the FLUJO client uses its normal run timeout. Keep any
`modelConfig` and generated plan private if they contain credentials. The helper
does not start a provider call by itself. The nine specialist subflows per team
remain a topology target until run records prove that they launched and finished;
the plan records ten lead conversations in FACTORY.
After a run, `observeSaviaCaseTopology(plan, {origin, token})` reads each lead
and its FLUJO descendant listing. It reports `topologyObserved: true` only when
all ten leads and exactly nine direct children per lead are persisted as
completed, with no truncated descendant page. This is a point-in-time topology
check. It does not prove that the nine children used distinct specialist roles,
that their work met case quality criteria, or that provider billing is final.
Pass `verifyRoleBriefs: true` to additionally read the 90 child conversation
messages and require one distinct `CASE_SPECIALISTS_V1` role brief, case ID,
team ID and agent ID per child. The result reports `roleBriefsObserved`
separately from `topologyObserved`. This reads private conversation content;
the SDK does not return message bodies, and a matching brief establishes
assignment rather than quality or actual role performance.
An [unpaid local live check](evidence/savia-local-topology-20261008.json) used
this SDK with an isolated FLUJO scratch server and a scripted loopback model.
It persisted ten completed leads and ninety completed direct children, then
replayed without new model calls, retired all ten workspaces, and closed all ten
logical cells. The scripted child briefs are synthetic; this does not qualify
customer SAVIA work or the pending FLUJO production release. To repeat against
an isolated local server, set `FACTORY_FLUJO_ORIGIN` to its loopback origin and
`FACTORY_SAVIA_SMOKE_SPAWN=1`, then run `npm run smoke:savia-local-flujo` with
Node 24.

```js
import { FactoryLocalFleet, createFlujoWorkspaceAdapter } from 'flujo-factory';

const adapter = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200' });
const fleet = new FactoryLocalFleet('/absolute/path/factory.sqlite', adapter);
const result = await fleet.run({
  mission: 'Investigate a case', budgetCents: 0, projectId: 'case', baseline: 'reviewed-source',
  workers: [{ id: 'team-one', app: 'team-one', budgetCents: 0, purpose: 'Investigate',
    provisionInput: { app: 'team-one', teamTemplate: { model: 'installed-model' } },
    conversations: [{ id: 'lead-one', input: { conversationId: 'case-one-lead',
      request: { flowName: 'swarm_team', prompt: 'Investigate the case' } },
      outputPath: '/absolute/private/lead-one.txt' }],
  }],
});
```

The example requires a reachable FLUJO installation with that model available
in the created workspace. `FactoryLocalFleet` uses local workspaces and does not
make provider spend or physical machine isolation claims. A completed
conversation task means its original output was retained, not that its answer
passed independent review.

On 2026-10-08, the generic team and SAVIA specialist pair both compiled on an
isolated FLUJO 3.46.1 development server. A later live synthetic-model run
completed one FACTORY conversation, but exposed FLUJO workspace recreation
after a successful delete response. FACTORY now watches exact-name absence
for 15 seconds and leaves retirement `unknown` if the workspace returns.
Fresh isolated FLUJO runs also hit Windows `EPERM` while renaming a staged
shipped MCP package into a new workspace under the Documents data root. The
system temp data root avoided that provisioning failure. With the ongoing-goal
and MCP teardown fixes in
[FLUJO PR #958](https://github.com/mario-andreschak/FLUJO/pull/958), an isolated
current-main development server completed live unpaid runs with 10 workspaces
and 100, then 300 synthetic-model conversations. Both runs confirmed exact
replay and retirement of all ten workspaces. The
[300-conversation acceptance record](evidence/local-flujo-fleet-acceptance-20261008.json)
pins the tested revisions and result. These checks establish local synthetic
dispatch, replay, and workspace cleanup; they do not measure paid model
inference, independent answer quality, or cloud machine isolation. The FLUJO
fix was first merged by PR #958 into FLUJO's
`codex/563-consolidated-integration-20261008` branch on 2026-10-08. That
integration branch's lockfile passed
`npm audit --include=dev --audit-level=high --package-lock-only` with zero
high or critical findings (20 moderate findings remain).
The [FLUJO #955 production workflow](https://github.com/mario-andreschak/FLUJO/actions/runs/37837094757)
completed successfully on 2026-10-08, including its Windows packed Antigravity
consumer. [PR #955](https://github.com/mario-andreschak/FLUJO/pull/955)
then auto-merged into protected FLUJO `main` as
`91ba5131743eed7ac3121753791d80b0b99c8e58`. This establishes source
adoption, not a published FLUJO release or a production SAVIA role run.
At the 2026-10-08 check, FLUJO main declared package `flujo-ai` version
`3.46.3`, while npm and the latest GitHub release still exposed `3.46.2`.
Install FLUJO from a source revision containing the merge when testing this
local lifecycle; the published `3.46.2` package is not evidence for it.

To reproduce without paid inference, start an isolated local FLUJO server and run
`FACTORY_FLUJO_ORIGIN=http://127.0.0.1:<port> npm run smoke:local-flujo`
(set the environment variable with `$env:` in PowerShell). The smoke accepts
`FACTORY_SMOKE_WORKERS` up to 10 and
`FACTORY_SMOKE_CONVERSATIONS_PER_WORKER` up to 30; it retains its SQLite ledger
on failure and reports unresolved effects.
Calls take
`{conversationId, request:{flowName,prompt}}`. A workspace shares the FLUJO
machine with other workspaces, so it is not a separate sandbox. The adapter
does not grant agents recursive delegation tools.

While `fleet.run(plan)` is active, `fleet.message({jobId,messageId,content})`
steers a running conversation. `messageId` is a caller-generated UUID and is
reused for exact replay. A `queued` receipt confirms FLUJO accepted the message
for its next safe boundary; the receipt alone does not prove the model consumed
it. FACTORY stores the content digest and acknowledgement, not the message body.
The fleet instance must still hold the active task lease. Uncertain submission
stays in the ledger for reconciliation and is never blindly sent again.
The fleet renews its task leases during provisioning and conversation calls.
The optional constructor settings `{leaseTtlMs, renewEveryMs}` default to ten
minutes and one minute; keep the renewal interval below half the lease TTL.
If a process or transport failure leaves the original call `running` or
`unknown`, a new fleet instance can call `reconcileCompleted(plan,{jobId})`.
It reads the original FLUJO conversation ID, accepts only a matching terminal
`completed` response, retains the answer at the plan's private output path,
settles the original effect, and closes the exact task. A conflicting output
file or nonterminal response stays held; no inference is sent again. Completed
reconciliation replays from FACTORY's ledger without another FLUJO read.
`fleet.cancel({jobId})` records one stop intent and asks FLUJO to cancel the
active conversation. A `requested` receipt confirms the request was processed,
not that the run reached a terminal cancelled state. If the original call then
ends without a confirmed output, FACTORY retains the task as `held` for
reconciliation; replay never sends a second stop request.
After FLUJO has reached a terminal state, call
`fleet.reconcileCancelled(plan,{jobId})`. It checks the exact original call and
stop effects against FLUJO's `error`/`cancelled`/`user_cancelled` recovery
metadata, then closes the task as cancelled. Still-running or ambiguous states
remain held. A completed reconciliation replays from FACTORY's ledger without
another FLUJO read. Unknown steering effects continue to block closure.

The FLUJO HTTP client and specialist profile in `src/flujo-swarm` are source
extractions from the
MIT-licensed Seagulled package, revision `70f1a7f115203e723fdc18e5a2cd5b9d391db363`,
which in turn records its source extraction from `flujo-app/swarm-teams`.

## Observatory feed

Server-side hosts such as FLUJO-WORLD can use `createObservatoryClient` to read
the local feed without placing the bearer in browser code. The client pins the
expected factory ID, accepts only an explicit `127.0.0.1` snapshot endpoint,
rejects redirects and invalid topology, and returns the versioned snapshot
envelope. `reader.events({ after: envelope.cursor, limit: 100 })` reads a bounded,
validated event page for reconnects; its returned `cursor` is the next `after`.
The `flujo-factory/observatory` package entry has TypeScript declarations for
the fields the reader validates. Hosts should narrow additional projection
fields before using them. This is the bridge for showing FACTORY cells and tasks alongside
FLUJO-WORLD's separate automation map. [FLUJO PR #973](https://github.com/mario-andreschak/FLUJO/pull/973)
merged into `main` and implements a server-side reader of this same HTTP
contract for its Wave Observatory FACTORY view. It currently implements that
narrow reader directly; the shared SDK client passed its public package gate on
Node 22.17 and 24 and can replace it in a later integration revision. The view
has not yet been connected to a live FACTORY source.

```js
import { createObservatoryClient } from 'flujo-factory/observatory';
const reader = createObservatoryClient({
  snapshotUrl: 'http://127.0.0.1:4343/v1/snapshot',
  token: process.env.FACTORY_VIEWER_TOKEN,
  expectedFactoryId: 'my-swarm',
});
const envelope = await reader.snapshot();
```

`createPresentationServer` and `startPresentationServer` are also exported by
the SDK. They expose FACTORY's existing authenticated, command-disabled v1
snapshot and event feed consumed by Brain Online and Brain Observatory. The
viewer token belongs on the server; it must not be passed to the browser.
See [BRAIN_ONLINE_INTEGRATION.md](BRAIN_ONLINE_INTEGRATION.md) for the exact
identity, event, freshness and read-only contract.

The SDK also exports the local fleet scheduler and conversation templates above.
Observatory consumes this read-only feed as a separate host. FACTORY does not
provide Observatory's UI or its private provider-detail projection.
FACTORY presents `worker_wake`, `worker_sleep`, `message`, and `flow_cancel`
alongside its original effect kinds, with a terminal `cancelled` state and
worker scope. The consumer allowlist updates merged into the Observatory
branches through [Brain PR #7](https://github.com/flujo-app/brain/pull/7) and
[Brain Online PR #41](https://github.com/flujo-app/brain-online/pull/41).
Private effect receipts stay out of the read-only feed.
The base viewer is [Brain PR #4](https://github.com/flujo-app/brain/pull/4),
consumed by [Brain Online PR #34](https://github.com/flujo-app/brain-online/pull/34).
The base PRs remain open and document their release gates: a qualified FLUJO
release, private source connectivity,
and signed-in staff observation. The preview deployment demonstrates the viewer;
it does not establish a live FACTORY source in production.

## MCP

Configure a local stdio MCP server with command pointing to your project's
`node_modules/.bin/factory-mcp` (or `factory-mcp.cmd` on Windows) and argument
`/absolute/path/my-factory.sqlite`. It exposes `factory_create`,
`factory_add_agent`, `factory_add_task`, `factory_claim_task`, `factory_status`,
`factory_pause`, and `factory_resume`. The MCP client running this process can
mutate that database and receive task leases, so run it only in an environment
you trust. It does not expose cloud provider operations.
