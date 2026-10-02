# FLUJO factory pilot

The factory's first mission is to improve FLUJO, optimizing the time from an
accepted requirement to independently accepted delivery within quality and cost
constraints. This directory contains the first runnable **local coordination and
recovery pilot**. The larger design is in [FACTORY_DESIGN.md](FACTORY_DESIGN.md) and
[FEDERATION.md](FEDERATION.md).

The controller records missions, delegated allocations, cells, task ownership,
candidate reviews, messages and external-effect receipts in SQLite. The gateway
admits an effect before dispatch and preserves uncertainty across interruption.
Adapters reuse local Git and the existing `flujo-cloud` `ManagedCloud` service.

**Cloud proof remains open.** The deterministic pilot uses real local processes,
SQLite and Git with fixed code fixtures. It invokes no model, provisions no cloud
resource and does not establish cross-host coordination or autonomous FLUJO peers.

## Run locally

Requirements: Node.js **24 or newer**, Git on `PATH`, and a local filesystem for
the controller database. There are no npm runtime dependencies to install.

From this directory, with a suitable default Node:

```powershell
node --test
node scripts/pilot.mjs .\evidence\local-pilot-01
```

Use a fresh output directory for each deterministic pilot. The script preserves
its repository, controller database, candidate/review files, reconciliation
evidence and `report.json`; it deliberately does not reuse an existing fixture.

The bundled runtime available on this machine is:

```powershell
$factoryNode = 'C:\Users\Moe\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $factoryNode --test
& $factoryNode scripts/pilot.mjs .\evidence\local-pilot-01
```

`npm test` and `npm run pilot` use the default Node executable. Invoke the bundled
executable directly when the default installation is older than Node 24.

## What the deterministic pilot checks

The pilot creates two candidate branches from one baseline. A separate evaluation
process accepts the correct implementation and rejects the competing fixture. A
single integration owner admits the accepted candidate's exact target, baseline
and commit.

The delivery subprocess then updates a real Git reference and exits before its
receipt is saved. A fresh controller observes the unresolved effect, refuses
takeover, inspects the actual Git reference and records reconciliation. It marks
the task delivered, grants a successor ownership epoch, rejects stale authority
and finishes with admission paused.

The accompanying tests exercise concurrent processes sharing the SQLite database,
allocation conservation, duplicate identities, ownership fencing, candidate and
review binding, private result artifacts, receipt/finalization replay and atomic
Git compare-and-swap. The branch builders are deterministic fixtures; the pilot
does not measure model-generated development speed or improve production FLUJO.

Read `report.json` for the evidence scope and result. `state.json` is an operational
snapshot; the SQLite database is the authoritative record.

## Controller CLI

```powershell
node bin/factory.mjs <command> <absolute-database-path>
```

Commands that need input read one JSON object from standard input. For example:

```powershell
$factoryDatabase = Join-Path (Get-Location) '.factory\controller.sqlite'
'{"mission":"Improve FLUJO development speed","budgetCents":10000,"maxCells":5,"maxDepth":2}' |
  node bin/factory.mjs init $factoryDatabase
node bin/factory.mjs status $factoryDatabase
node bin/factory.mjs pause $factoryDatabase
node bin/factory.mjs resume $factoryDatabase
```

Replace `node` with `& $factoryNode` when using the bundled runtime.

| Command | JSON input |
| --- | --- |
| `init` | `mission`, `budgetCents`, optional `maxCells`, `maxDepth` |
| `status`, `pause`, `resume` | No input |
| `reserve` | `cellId`, `budgetCents`, `purpose`; optional `parentId`, `role` |
| `enroll` | `cellId` |
| `task` | `taskId`, `projectId`, `branch`, `specification` |
| `claim` | `taskId`, `cellId`; optional `ttlMs` |
| `integration` | `projectId`; optional `cellId`, `ttlMs` |
| `message` | `sender`, `messageId`, `recipient`, `payload`; optional `taskId`, `attempt` |
| `inbox` | `cellId` |

A task specification names `problem`, `acceptance` and `baseline`. Git delivery
also pins `deliveryTarget: {repository, ref}`. The reviewed candidate artifact
records `{repository, ref, baseline, candidateHead, branch}`; admission binds the
delivery request to those bytes.

Lease responses contain private runner capability tokens. Keep them in
owner-private runner storage and exclude them from public reports. The CLI is a
trusted local operator interface. Worker authentication over HTTP, remote
enrollment and cross-host consensus are future work.

## State, pause and recovery

`control.status: active` permits admission; it does not mean workers have started.
`paused` revokes new admission and advances the control epoch. `resume` advances
it again, so old leases remain stale.

`effectsDrained` means the ledger has no accepted, running or unknown effects.
`workerQuiescence: unverified` means the controller has not established that every
worker/process has stopped. A paused controller can still have an admitted effect
finishing or an unresolved external outcome. This pilot does not stop unrelated
Codex chats, automations or processes.

An effect's stable key and request digest identify its intent. Matching receipt
replay and delivery finalization preserve the original result without dispatching
again or recording a second completion. A different request or ownership attempt
cannot reuse that key.

After interruption, inspect the existing task, effect and destination before
retrying. A timeout does not prove an operation failed. Unresolved effects block
conflicting takeover. An accepted intent that never started can be cancelled;
negative reconciliation of a started or unknown effect is deliberately
unsupported until executor and destination reconciliation exists. The local Git
pilot demonstrates positive reconciliation of an observed exact commit.

Preserve the controller database and recovery artifacts. For cloud operations,
also preserve `ManagedCloud` attempt metadata, journals and credentials until
owned retirement is confirmed. A new worker name is a new deployment, not a
recovery of the previous uncertain attempt.

## Read-only cloud preflight

The preflight script verifies an explicitly selected native source, reads
workspace/configuration metadata and checks compatible official-image selection.
It creates no deployment and runs no Flow.

```powershell
node scripts/cloud-preflight.mjs `
  --module-path 'C:\Users\Moe\Documents\GitHub\flujo-cloud\lib\managed.mjs' `
  --source 'http://127.0.0.1:4200' `
  --workspace 'factory-pilot'
```

Use the actual registered source origin. Exit code `0` means compatible image
selection was confirmed; `2` means selection was unconfirmed or the workspace was
absent; `1` means the preflight itself could not be confirmed. This is preparation
evidence, not a running-worker acceptance result.

## Planned isolated live pilot

The spending intent is **at most US$100 across the paid cloud work**, including
the Modal/open-weight model path. `src/spending.mjs` conserves one durable USD
allowance across providers, using integer cents and serialized admission. The
first experiment reserves $10 for Fly and $30 for Modal, leaving $60 unallocated.
Each paid dispatch rechecks its reservation; known experiment or global exhaustion
blocks new paid work. Owned cleanup remains possible. Retirement keeps funds held
until final billing evidence arrives; it cannot release uncertain charges. The
ledger covers registered factory spending, not unrelated provider-account costs.

The local `budgetCents` and child
allocations conserve delegated budget; they do not meter actual compute,
inference, storage or provider charges and are not a provider-side billing stop.
An experiment needs explicit resource/time limits and observed cleanup as well as
budget records. Overall factory work has no time limit; the limits below apply to
this first Fly experiment.

The initial live slice is bounded to **two temporary cloud workers**, delegation
depth **two**, Flow-call timeout **180 seconds**, and a **15-minute work deadline**.
It uses a dedicated `factory-pilot` workspace with a minimal Flow and no attached
MCP tools. The first worker produces a bounded function candidate and a
schema-validated child request. The local coordinator admits and provisions that
child from its parent's allocation. The child returns a JSON review, and the local
verifier checks the candidate's exact pure-function grammar and fixed acceptance
table. Generated code is preserved as an artifact and is never executed locally.

The work deadline bounds new admission and individual HTTP/Fly commands. It does
not guarantee a global cancellation or shutdown time. Owned cleanup has a separate
five-minute command deadline.

The live runner prepares read-only unless `--execute` is supplied:

```powershell
$cloudPilotDirectory = Join-Path (Get-Location) '.factory\cloud-pilot-01'
node scripts/cloud-pilot.mjs `
  --run-id 'cloud-pilot-01' `
  --output $cloudPilotDirectory `
  --module-path 'C:\Users\Moe\Documents\GitHub\flujo-cloud\lib\managed.mjs' `
  --source 'http://127.0.0.1:4200'
```

Use the registered native source origin. Add `--execute` and
`--spending-ledger` with the absolute path of the shared `.factory\spending.sqlite`
to this same invocation
to run the isolated pilot. The runner refuses to adopt an existing fixture
workspace. An existing manifest returns `observe-existing` without reprovisioning
or replaying model calls; inspect its original attempts before further recovery.
Exit code `2` means the live proof failed or an existing run needs reconciliation.
An explicit `--resume-fixture` is limited to the original pre-cloud fixture
failure: original source/image/manifest, empty owned workspace creation proof,
fixed model/Flow inventory, paused controller and zero historical effects are
required. Recovery preserves its old report and app identities. It is not a
general cloud retry.
The runner verifies that the source's default agent uses the approved
`gpt-6-astra / codex / codex-cli` model tuple; it does not change that source
binding. The dedicated source workspace remains available for inspection after
cloud retirement.

This qualifies gateway-mediated delegation if it succeeds. Native autonomous
child provisioning, cross-host ownership, mutual monitoring, source branch
development and fleet learning each still need their own proofs.

Owned retirement belongs in the runner's `finally` path and uses a narrow trusted
local cleanup authority. That authority can retire an app while admission is
paused only when the app is bound to this controller's original provisioning
intent. It cannot grant a general work lease or resume dispatch. Retirement
identity validation requires the matching app and a terminal destroyed result;
uncertain cleanup remains unresolved and cannot be blindly retried under another
key. Existing unresolved work records remain intact.

`ManagedCloud.down` verifies the deployment's journal and cloud ownership before
deleting its dedicated application. A failed or uncertain retirement must remain
visible with its original identities and recovery records. Deadline expiry alone
is not evidence that a resource was retired; recovery must inspect and reconcile
it. A separate same-host watcher can record heartbeat, ledger and live provider
observations; it cannot grant ownership, retire resources or recover from loss of
the host itself.

For an observation after the manifest and controller ledger exist:

```powershell
node scripts/watch-pilot.mjs `
  --manifest (Join-Path $cloudPilotDirectory 'manifest.json') `
  --module-path 'C:\Users\Moe\Documents\GitHub\flujo-cloud\lib\managed.mjs' `
  --fly-path 'C:\Users\Moe\.fly\bin\flyctl.exe' `
  --once
```

Use the actual absolute Fly executable path. Without `--once`, the watcher runs a
bounded observation loop. It records provider evidence in
`watch-observations.jsonl` and can send structured observations to the local root
inbox. A witness of app absence is stronger than cached inventory; it still does
not establish metered spend or full worker quiescence. If the coordinator dies,
the witness can report that condition but cannot perform teardown.

### Source and image boundaries

The existing shared FLUJO checkout is dirty. This factory does not use it as a
clean development baseline or change its branches. Select and preserve a clean,
explicit source revision for real FLUJO development.

The cloud bridge snapshots durable workspace state from a running native source
and selects a compatible immutable worker image. Application-version or channel
fallback establishes the declared compatibility contract; it does not establish
equality with an unreported or dirty local Git checkout. Preserve the selected
source, snapshot and image identities in live evidence.

Flow selection controls startup/call scope and does not redact unrelated
workspace data or credentials. Use the dedicated workspace to constrain the
transferred contents. Copied model authentication and shared provider accounts
also retain common failure dependencies; two cloud workers do not by themselves
prove independent authentication or inference availability.

## Current limits

- One local SQLite authority; no distributed failover or consensus qualification.
- Trusted local processes and filesystem; worker isolation and gateway-only
  external credentials need separate enforcement.
- Deterministic local source fixture; no unattended roadmap execution or measured
  factory self-improvement.
- Logical watcher/cell/message records; no independently hosted watchdog is
  established by the local pilot.
- Provisioning adapter over existing `ManagedCloud`; live deployment, durable
  remote-result reconciliation, health monitoring and owned cleanup remain to be
  exercised in the isolated cloud run.
