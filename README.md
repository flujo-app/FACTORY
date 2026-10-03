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

The live Fly pilot passed with two real FLUJO workers, independent candidate
review and verified owned retirement. A real source-pinned FLUJO API documentation
task also passed independent review and local Git delivery from fresh upstream.
An isolated native FLUJO outcome repair then passed **213/213** targeted checks,
type checking, lint, separate acceptance and local Git delivery. It prevents
replayed Activities from corrupting Behavior outcome measurements; see
[NATIVE_OUTCOME.md](NATIVE_OUTCOME.md) for exact source, evidence and limits.
The deterministic recovery pilot uses real local processes, SQLite and Git with
fixed code fixtures. Modal inference and native Flow proof remain open: R3's
original v2-cache prefetch reached its bridge bound with an unknown outcome;
owned App/Volume cleanup and a fresh provider absence witness then completed.
All four paid reservations are `retired-meter-pending`, retaining the full $100
with $0 unallocated. Recorded observations conservatively round to 30 cents;
they are neither exact total spend nor a strict monetary lower bound. Final spend
remains unknown and no new paid run is admitted. See
[QUALIFICATION.md](QUALIFICATION.md) for evidence and remaining work.

Source `a283701933710bf39ea0673ab661064586e200f8` adds authenticated advisory
peer messages with a durable outbox/inbox, fixed destinations, credential
generations and private setup recovery. Its **11/11** focused checks include a
real receiver exit after inbox commit but before acknowledgement, both-process
restart, and retry resolving one original outbox with one inbox record/event.
The exact ten new files were adopted with all 54 existing runtime pins unchanged.
A subsequent actual pilot used two local CLI gateways to exchange authenticated
controller, paid-budget and Modal-journal observations in both directions. Each
store retained one acknowledged outbox and one inbox; both gateways closed with
the 64 source and 29 accounting/history witnesses unchanged. The observations
describe persisted history. Deployed peers, independent-host recovery and
autonomous enrollment remain open. See [PEER_MESSAGING.md](PEER_MESSAGING.md).

Source commit `0948fdd9ff7f5d379982e6e7286fd220236a1993` adopts the independently
reviewed logical lifecycle subset and low-memory HTTP preparation. The combined
188/188 qualification ran once in its isolated stage; adoption matched those
source bytes after line-ending normalization without another suite at that
adoption. The
HTTP download variant has not run in the cloud. Logical closure is implemented
for task release and never-provision-bound leaf cells. Later source `8dce857`
adds the narrow qualified provider-bound path described below. The historical port 4343 API used build `6fcd718` for the
Fly controller; that endpoint was subsequently observed unreachable.

Source `67997585baa897bd7586fe21b9a755c89739a1a3` adds authenticated, read-only
Modal journal observation with private operator configuration and independent
content revisions. Its full combination passed **270/270**, exit 0, with unchanged
source during execution. A separate local API on port 4344 projected all three
actual journals and their 15 operations without changing their database/WAL bytes
or paid accounting. All three prefetch outcomes remain unknown. This view reports
persisted history rather than fresh provider status and does not establish model
inference or native Flow success. See [MODAL_OBSERVATION.md](MODAL_OBSERVATION.md)
for its separate contract and [QUALIFICATION.md](QUALIFICATION.md) for the exact
test and live-witness records.

Source `8f5a94048e9c8be007cf3b5229607783b49cd47f` fixes the pinned vLLM startup
flag and adds complete artifact verification, private source/receipt binding and
read-only source preflight before paid resource admission. Its frozen combination
passed **274/274**, with matching source and historical paid-state bytes before
and after the final run. Earlier unstable/interrupted qualification attempts are
preserved separately. GPU boot, inference and native Flow remain unproven;
local artifact bytes were subsequently validated as described below. See the
[model definition](modal/README.md) and
[qualification record](QUALIFICATION.md).

Actual local pinned-weight preparation passed after a reviewed resume. A separate
process independently validated all **13 files / 15.24 GB** in **61.60 seconds**,
with **30.8 MiB** peak memory. Both operations closed successfully and preserved
the protected source, history and owner state. This admits no new paid cloud work. See
[LOCAL_MODEL_PREPARATION.md](LOCAL_MODEL_PREPARATION.md) for its current evidence
and the separate remaining Modal/GPU/Flow requirements.

The read-only API was restored on `127.0.0.1:4344` at build `8f5a940`; an actual
authenticated check again returned three journals and 15 operations without
changing their contents or paid accounting. The old port 4343 endpoint was not
restored. A brain-online adapter pinned to its old endpoint/build needs a reviewed
configuration update before using the restored service.

Source `8dce857df549f29c69e566fa7d927196cb324c3c` adds provider-bound logical
leaf closure from recorded owned Fly teardown and a fresh configured-credential
inventory. Its complete frozen suite passed **288/288** and independent source
and outcome audits passed. The original child/parent worker cells are now retired
at controller events 90/91, preserving reviewed work and the unfinished root launch
task. Root logical capacity returned by $60 once; paid revision 17 still holds all
$100. Actual API checks project the new state under its existing loaded build
`8f5a940`. Physical quiescence and final billing remain unverified. See
[LIFECYCLE.md](LIFECYCLE.md) and [QUALIFICATION.md](QUALIFICATION.md).

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
unsupported without executor proof. The local Git pilot demonstrates positive
reconciliation of an observed exact commit. `executeGitDelivery` in
`src/git-effect.mjs` adds a narrow exception for a completed, genuine local Git
compare-and-swap refusal: it settles as `not_applied` using a bound, single-use
in-process proof. A timeout, killed executor, forged error or missing receipt
still remains unknown. Refusal leaves the reviewed task undelivered; rebasing
requires a new candidate and review.

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

## Isolated live pilot operation

The spending intent is **at most US$100 across the paid cloud work**, including
the Modal/open-weight model path. `src/spending.mjs` conserves one durable USD
allowance across providers, using integer cents and serialized admission. The
first experiment reserved $10 for Fly and $30 for Modal. Two further, distinct
Modal experiments each hold $30; all $100 is reserved and $0 remains unallocated. Current
results and billing status are recorded in [QUALIFICATION.md](QUALIFICATION.md).
All four reservations are now retired pending final billing, with the full holds
unchanged. The latest paid revision is 19; its 30 recorded cents are conservatively
rounded partial observations, not exact total spend. No fresh paid experiment is
admitted by the source update.
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

The existing shared FLUJO checkout is dirty; its checkout and running build were
preserved. The one-file API documentation task used a fresh isolated worktree at
upstream `d68492712315d30c856c8d2ba95b0a26a859bd18`. Independent review accepted
candidate `ea66f1130e01d3208173cd850d40f85f319b3582`, and the reviewed local target
`refs/heads/codex/factory-reviewed-api-token-limit-docs` received that exact commit
through Git compare-and-swap. This corrected HTTP versus authored Flow token-limit
documentation; it created no PR, push, upstream merge or runtime change. Runtime
FLUJO improvements and upstream publication still require their own acceptance.
The task's `docs-builder` and `docs-reviewer` cells were then logically retired
using the qualified controller subset. Independent audit confirmed the exact
closure events, preserved delivered work and unchanged billing records.
Provider/process quiescence remains unverified.

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
- One real isolated documentation delivery and deterministic recovery fixtures;
  no unattended roadmap execution or measured factory self-improvement.
- Logical watcher/cell/message records; no independently hosted watchdog is
  established by the local pilot.
- Provisioning adapter over existing `ManagedCloud`; the bounded Fly deployment,
  model calls and owned cleanup passed. General remote-result reconciliation,
  automatic health recovery, runtime-source improvement and upstream publication
  remain unqualified.
