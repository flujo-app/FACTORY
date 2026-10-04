# FLUJO factory pilot

The factory's first mission is to improve FLUJO, optimizing the time from an
accepted requirement to independently accepted delivery within quality and cost
constraints. This directory contains the first runnable **local coordination and
recovery pilot**. The larger design is in [FACTORY_DESIGN.md](FACTORY_DESIGN.md) and
[FEDERATION.md](FEDERATION.md).

## October 4 priority

Make the supervised WebUI → Fly FLUJO workers → private Modal route usable first.
Development that produces and checks code comes next; broad scorecards,
polishing and audit expansion wait.

The existing cloud lane is owned by [Review linked Codex thread](codex://threads/01a0ff01-f462-7712-a465-eb234970f7e9).
Its [recorded acceptance](C:/Users/Moe/Documents/GitHub/iambrokeplshlp/artifacts/cloud-spike-live-acceptance-20261004.json)
establishes one supervised text job through two Fly workers using private
Ollama Qwen3 4B on Modal, followed by exact completed-job recovery after restart
with no inference replay. The developer gave an incorrect arithmetic answer
and the reviewer corrected it. FACTORY read the public receipt and recovery
contract; that recorded scope does not include code tools or income.

Reuse that working gateway and worker lane. Root/Auth own its code executor.
FACTORY provides the supplied-task and immutable test/result receipt
contract in [src/development-job-contract.mjs](src/development-job-contract.mjs).
Its 14 focused tests pass. bindDevelopmentJob() freezes the task, candidate
file hashes, executor build and fixed Node test target; projectDevelopmentJob()
checks an independently pinned supplied receipt against that binding. A passing
receipt marks the proposal checked with explicitly unauthenticated provenance.
Applied code remains not_applied, income remains no_evidence and admission is
NO_ADMISSION; external sends require the named owner bridge.

The working Python cloud executor has its own supplied-result contract in
[src/python-cloud-job-contract.mjs](src/python-cloud-job-contract.mjs).
bindPythonCloudJob() freezes the selected task and Python source hashes;
projectPythonCloudJob() checks the retained original request and response bytes
against the operation and fixed injected arithmetic or invoice suite. Its 17
focused tests pass. The original runner response must retain trustedSuite,
trustedMinimum and trustedSuiteComplete; the current MCP text projection drops
those fields and cannot substitute for the raw receipt. Passing evidence yields
checked with unauthenticated runtime/suite provenance, NO_ADMISSION,
not_applied and no_evidence. The existing Node contract remains separate.

The adapter also accepted a retained original cloud request and response for a
CSV job: ten project cases plus three fixed arithmetic cases, minimum three,
with cleanup confirmed. This was a local projection of saved bytes with no job
replay. Task and executor labels were supplied retrospectively; the actual
executor build remains unknown. Its checked result retains NO_ADMISSION and
not_applied. The earlier invoice fallback's original wire bytes were not retained
and were not reconstructed for this check.

The cloud owner's [code acceptance record](C:/Users/Moe/Documents/GitHub/iambrokeplshlp/artifacts/cloud-native-code-acceptance-20261004.json)
reports a real three-test arithmetic run and a deterministic invoice fallback
that passed 13 CPU checks with cleanup confirmed. The generated invoice V5
passed nine fixed cases but retains known whitespace/precision gaps. The phone
reviewer assessed text; independent code execution is a separate sandbox result.
FACTORY consumed that public record without replaying the job or inference.

[modal/communityai_bootstrap.py](modal/communityai_bootstrap.py) now wires the
pinned Qwen3 1.7B manifest, two complementary block workers, a text peer and
the actual CommunityAI coordinator APIs. A supplied four-role formation retains
actual public TCP ports and application TLS; host admission and receiver
authentication must be supplied by its owner. The launch contract requires the
exact retained model index, derives both block selections and carries all five
worker consistency claims. Model files use a read-only declared snapshot;
locks and cache state use distinct writable directories for each role.
Forty-one focused checks passed in the combined main checkout, covering
planning, held lifecycle behavior and image export/build receipts.

[modal/communityai_runtime.py](modal/communityai_runtime.py) adds the real TLS
DHT bootstrap entry point, actual public/listen port handling, one bounded
startup observation deadline, expiry/stop handling and cleanup without retry.
Lifecycle observer calls have a one-second return bound. A stalled startup
observer causes same-DHT shutdown and suppresses a concurrent final callback;
a stalled final observer is an error after shutdown. The retained record labels
both publication states, possible late daemon-thread side effects and unverified
descendant retirement. On Linux the CLI writes each small JSON record directly
to nonblocking stdout, so a full log pipe fails the publication instead of
holding the cleanup path. Callback return means only that publication code
returned; it does not prove external delivery.

The [bootstrap watchdog](modal/communityai_runtime_watchdog.py) runs that CLI in
an isolated Linux process group, anchors the supplied expiry to a monotonic
deadline, requests stop and sends a hard kill if the child misses a seven-second
cleanup grace. It inherits the child's lifecycle stream rather than inventing a
success record. A hard kill, nonzero exit or missing final record is
**unverified cleanup**, even if an earlier startup record was emitted. The
provider supervisor must still verify and retire owned resources and descendants;
Python cannot cancel a blocked observer thread or infer that they exited from
the DHT's local return. Focused offline tests cover blocked startup/final
publication, stdout backpressure and a stopped child process. All 21 focused
cases passed in a local network-none Linux Python 3.12.13 container, including
the real full-pipe and process-group kill cases. DHT lifecycle cases use component
doubles. The
[image recipe](modal/Dockerfile.communityai-runtime) requires an immutable
Python/compiler/build-tools image and a coherent locked source context.
Its current source context is [PR40](https://github.com/flujo-app/CommunityAI/pull/40)
revision 681deb528a2d83a354a991a032c6ffa8d14a4242, stacked on PR38's
receiver and API lock repair. Direct server/text-peer roles accept a strict
`artifact_root` and separate writable `cache_dir`; missing, corrupt, linked or
undeclared inputs reject before model construction. The owner reports 110
selected offline tests passed, and an independent reviewer reports 42 snapshot
tests passed. Hosted model CI was deliberately skipped. This direct interface
does not propagate through `drift node`. Dependency metadata and the lock are
byte-identical to PR38. A local compiler image has
been built with Python 3.12.13 and a retained tool/package inventory; its first
Debian package resolution was floating. The full local role image was built from
the locked source, with 101 compatible packages. Real runtime imports and all
four role help commands passed in a network-none container. Its retained local
image ID is
`sha256:07fe68fbe314f5ff0bcc3ed1dd82c6644af0253bb0ee0ad410489ea1c77df405`.
That retained image uses PR38 and lacks PR40's artifact-root interface. A fresh
image of the current source must qualify before it can replace that evidence.
Separate retained qualification matches BuildKit's compiler material to the
inspected rootfs chain and records the compiler tag's configuration ID before
and after the build. Those local observations do not establish an immutable
compiler reference. Registry portability remains unqualified.

The [local preparation helper](modal/prepare_communityai_local_image.py) exports
the recipe and Factory runtime files from exact committed Git blobs, preserving
the manifest's raw hash across dirty or CRLF checkouts, and records the complete
context. The
[local build helper](modal/build_communityai_local_image.py) rejects changed,
added, removed or linked context inputs, reserves its build intent exclusively,
and retains the output configuration ID, metadata hash and BuildKit reference
before compiler qualification. Receipt updates use flushed atomic replacements,
so interrupted writes leave the previous complete intent or PID record readable.
Uncertain builds cannot replay. Legacy
qualification requires a separately retained metadata witness and preserves the
original receipt; the caller must establish that witness's historical origin.
Eight fake-Docker provenance, concurrency and interruption checks passed. The
[import smoke](modal/smoke_communityai_local_image.py) checks imports and help
commands without starting roles.

The current recipe copies only the pinned project metadata and lock before
dependency sync, then copies Python source. An actual network-none uv dry-run
accepted that exact metadata without README or source. This lets subsequent
source-only edits retain the dependency layer after the first build with this
ordering; a cache hit or build-speed gain has not been measured. The existing
image above retains its original recipe and evidence. New preparations must
select the exact reviewed recipe commit with required `--factory-commit`.
The export includes the launch-contract module imported by the bootstrap.

All eight declared artifacts already present in the local Hub cache passed full
size/SHA verification and were copied into a separate plain-file snapshot.
The 4,079,422,995 copied bytes passed an independent rehash; the source cache
was unchanged and no download or model execution occurred. The
[snapshot smoke](modal/smoke_communityai_snapshot.py) is prepared to check an
actual read-only mount, writable runtime lock and rejected loader constructors
in the new image. That container check and remote Volume qualification remain
pending.

Two real DHT nodes in that image then exchanged one exact short-lived value
over loopback with both p2pd processes configured for TLS. Each same DHT instance
shut down once with exit zero; the owned container exited zero and was removed.
A Torch shared-memory manager remained in the snapshot before parent exit,
explicitly recorded as unverified descendant cleanup. The smoke used a different
import order from the bootstrap role and proves local transport only.
Remote model cache qualification, Modal tunnel reachability, distributed model inference
and provider retirement remain unverified. Recursive provisioning and live
queue-driven scale-to-zero also remain subsequent integration work.

The [host supervisor](modal/COMMUNITYAI_SUPERVISOR.md) now journals exact Modal
role resources, retains Sandbox IDs and actual raw TCP sockets, and fences
uncertain mutations against replay. Per-role OS locks protect observations and
checkpoint updates; terminal retirement evidence survives later running polls,
and retired roles cannot launch. Its four-role batch and model-worker/text exec
are explicitly held before paid creation or driver work until the reviewed
local-only artifact loader and corresponding image qualify. Standalone
bootstrap lifecycle still requires explicit owner admission, existing hydrated
handles and budget authority. Eleven Node and sixteen Python checks pass on
fresh owned fixtures and SDK/driver doubles. An actual owner bridge, verified
cache, registry image mapping, remote Original coordinator authority and live
distributed inference remain required.

The original FACTORY controller remains paused with its $100 fully held,
$0 unallocated and final spending unknown. The new cloud lane keeps separate
ownership; its observations do not reset the original journals or reservations.

An opt-in existing-worker power slice records owned Fly sleep/wake effects on the
original controller and shared paid ledger. Sleeping and unresolved workers fence
native dispatch; wake retains a separate spending allowance. Explicit native-cell
queue power scheduling now selects idle sleep or demand wake through that same
authority, with 87 focused local checks passing. The deployed native CLI now
accepts an explicit private powerScheduling profile; eight fake-transport CLI
checks pass, including restart, UNKNOWN and paid-zero cases. Live Fly and new
image qualification remain open. See [WORKER_POWER.md](WORKER_POWER.md) and
[NATIVE_CELLS.md](NATIVE_CELLS.md).

The local model-step journal retains an immutable witness for each logical claim.
Unclaimed or missing model steps cannot satisfy parent completion, and retries
observe the original claim after interruption. The focused five-file capture passed
**129/129**, including 49 journal cases, and independent review accepted the exact
local adoption at `13d590f83aa9dc856ef1981b794f6dc1523943ab`. See
[the journal guide](MODEL_STEP_JOURNAL.md) and
[the next offline FLUJO bridge plan](FLUJO_OWNER_BRIDGE.md). Original live migration,
physical sending and provider admission remain held.

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
fixed code fixtures. Modal inference and Modal-backed native Flow proof remain open: R3's
original v2-cache prefetch reached its bridge bound with an unknown outcome;
owned App/Volume cleanup and a fresh provider absence witness then completed.
All four paid reservations are `retired-meter-pending`, retaining the full $100
with $0 unallocated. Recorded observations conservatively round to 30 cents;
they are neither exact total spend nor a strict monetary lower bound. Final spend
remains unknown and no new paid run is admitted. See
[QUALIFICATION.md](QUALIFICATION.md) for evidence and remaining work.

Source `d9d87c6ebbd05b6c82bdbf0f7c537e76eb4b9a66` repeats shared paid-admission checks after awaited
stage notifications and FLUJO source discovery, immediately before paid SDK,
direct HTTP or Flow dispatch. Its complete Node 24 suite passed **461/461** and
focused Modal checks **36/36**. Separate retained-evidence qualification accepts
the actual closed run while preserving its failed raw collector receipt. Owned
cleanup and GET recovery of an original generation remain available while paid
admission is paused. This is local source qualification; mounted Modal weights,
GPU startup, Modal-backed native Flow and deployed autonomy remain open.

Earlier source `72aec7cd64ff7d55ba8c7cb31bf371dee8a88044` adds explicit budget-only growth:
factory policy schema 2 removes cell-count and delegation-depth ceilings, and
capacity grant schema 2 removes its child-count ceiling. Parent allocations,
lifetime grant monetary ceilings and the shared SpendingLedger still constrain
admission. The complete suite passed **456/456** and the focused suite **60/60**.
Actual Docker capture/restore and schema-2 broker refusal/restart passed against
a fully held fixture budget. The original controller now uses budget-only policy,
paused at epoch 5 and revision 92. Its mission, budget and historical records
were preserved; the same loaded API served the transition. See
[the growth guide](BUDGET_GROWTH.md) for the exact policy and
trusted local migration commands.

Source `fea3d151c1a4380495094744d00a33770b1abbb5` packages native-cell and
capacity-broker roles over one private authority. The full suite passed
**433/433**; the later fixture-only correction passed separate final-image
Docker acceptance. An authenticated container source exported its workspace,
and a second native worker restored its configuration with due schedules dormant.
Both workers exposed the expected MCP tool without invoking it. A fully held
fixture budget refused provisioning and broker restart preserved the original
`not_applied` intent. Separate native-cell acceptance retained one POST and one
synthetic-model call across lost-response restart and paused GET recovery.
All owned test resources were removed. See [the service guide](deploy/factory-service.md)
and [capacity broker guide](deploy/factory-service.broker.md). Paid inference,
cloud enrollment, shared remote authority and independent-host recovery remain open.

Source `8ef36348f04d0a4a452acd75c493fb1cffa3c97c` adds the native cell mission queue. Its complete isolated
Node 24.19.0 suite passed **408/408**; the focused combination passed **50/50**.
Separate acceptance used actual daemon and FLUJO processes: new work arrived
after startup, a completed response was lost, both processes restarted, and
GET-only recovery succeeded while paused. Exactly one POST and one fixture-model
call occurred. A fully held fixture budget left the next task ready. All three
daemon processes and both native workers closed. This is local execution proof;
deployed autonomy, shared remote authority and paid Modal inference remain open.
See [NATIVE_CELLS.md](NATIVE_CELLS.md).

Source `a05ae09e7faeba40d8d24470a924cf9e4b4b5f49` adds assigned native missions:
authenticated child preparation, atomic enrollment/task claim, one durable Flow
dispatch and recovery of the original result. The complete source suite passed
**383/383**. Separate acceptance restored a fresh native child, dropped its
completed response, restarted controller and worker, and recovered with exactly
one POST and one fixture-model call. Both actual workers closed. The software
task still requires independent review and delivery. This is local native
execution proof with a provisioning fixture; cloud autonomy and Modal inference
remain open. See [NATIVE_MISSIONS.md](NATIVE_MISSIONS.md).

Source `56a2048485525e369a30e95e36c86397eea2b5ab` connects a native FLUJO Flow
to bounded child-capacity requests through a private MCP tool, authenticated
peers and a trusted standing-grant broker. Child allocation, lifetime grant
quota and provisioning intent commit together; actual SpendingLedger admission
precedes ManagedCloud dispatch. Exact replay never relaunches an intent.
The complete combination passed **358/358**. A fresh encrypted native worker
executed two real Flow/MCP requests using a synthetic loopback model: one
injected provision survived lost-ACK/store/process recovery without a second
dispatch, and the next request was refused against a fully held fixture budget.
All native workers closed. This proves local native request admission; deployed
child enrollment/autonomy and paid inference remain open. See
[NATIVE_CAPACITY.md](NATIVE_CAPACITY.md).

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

Source `26c8cc4637a8f89c2f4a83092cb5d35f735794fc` adds automatic authenticated
mutual watching through `peer watch`: each native process probes the other
peer's own read-only controller and paid projection, persists meaningful changes
and retries exact original advisory messages after interruption. The complete
combination passed **335/335**; actual two-process acceptance showed unchanged
poll silence, a native state change, a missing peer, both-process restart and
replay of one original message after a deliberately lost ACK. Local detection was
about one second and reciprocal recovery about 1.29 seconds in this trial.
It creates no control or spending authority. Independent-host deployment, native
enrollment, Modal GPU/native Flow and a development-speed comparison remain open.
See [PEER_MESSAGING.md](PEER_MESSAGING.md) and
[QUALIFICATION.md](QUALIFICATION.md).

Source `5293cfb22adde92d64ac27e3441b9b43f1d881c4` adds explicit operation completion
and task cancellation. Completion requires an immutable operation contract and
exact recorded success receipts; cancellation preserves acceptance, candidate
and review history. Neither establishes reviewed software delivery. The complete
combination passed **324/324** with actual exit 0 and process closure. Adoption
matched six qualified files and preserved 63 untouched runtime files and all
29 accounting/history witnesses. A rehearsal cancelled the original launch task
on a private database copy only. The separate growth-policy transition advanced
the live controller to revision 92 and paused epoch 5; that task remains running.
At the 15:16 UTC reconciliation, the original port 4344 API served build
`8f5a940`. A fresh 17:26 UTC process/listener inspection found its PID 52524 absent
and no listener on port 4344. A separate **18:35 UTC** read-only reconciliation
verified the single replacement **PID 29756** on `127.0.0.1:4344`, serving qualified
runtime `d9d87c6ebbd05b6c82bdbf0f7c537e76eb4b9a66`. Authenticated snapshot, events
and Modal-journal GETs returned 200/no-store; anonymous requests returned
401/no-store. The original launcher receipt remains failed after its Windows
argument-parser check; the separate reconciliation verified the existing process
without another launch or cleanup. Controller epoch 5/revision 92, paid revision
19, all original SQL histories and source bytes stayed unchanged. Commands remain
disabled. Brain's reader source is qualified; active O readers still need
qualification before any later live terminal transition. See [LIFECYCLE.md](LIFECYCLE.md) and
[QUALIFICATION.md](QUALIFICATION.md).

Source `ac8b51fbf2833d347a0d96ed7f422a0bd82412bc` rejects invalid HTTP
continuations before the pinned Hub SDK appends bytes, including across redirects
and native retries. It binds an exact guard identity to new Modal intents and
receipts while preserving original cleanup. Its complete source combination
passed **302/302** on Node 24.19.0, including genuine tiny-body SDK probes and
the existing controller, budget and peer tests. Source adoption preserved all
57 untouched runtime files and 29 accounting/history files. This is local
qualification; mounted Modal weights, GPU startup and native Flow remain open.

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

The full test suite additionally needs Python and the installed Modal SDK for
its definition checks. The genuine HTTP probes require explicit
`FACTORY_PYTHON`, `FACTORY_HUB_SITE` and `FACTORY_PRIVATE_MODULE` inputs: an
absolute base interpreter, owned site-packages containing Hub 0.36.0 and Requests,
and the trusted private-files module. Missing inputs fail rather than skip.
See [the Modal test instructions](modal/README.md) for the isolated probe scope.
Set these inputs before the complete test commands below.

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
$env:FACTORY_PYTHON = 'C:\Users\Moe\AppData\Local\Programs\Python\Python313\python.exe'
$env:FACTORY_HUB_SITE = 'C:\Users\Moe\Documents\ChatGPT\FACTORY\.factory\model-local-20261003-r2\venv\Lib\site-packages'
$env:FACTORY_PRIVATE_MODULE = 'C:\Users\Moe\Documents\GitHub\flujo-cloud\lib\private-files.mjs'
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
| `init` | `mission`, `budgetCents`; legacy optional `maxCells`, `maxDepth`, or explicit `growthMode: "budget-only"` |
| `status`, `pause`, `resume` | No input |
| `growth-policy` | No input; read existing policy, epoch, status and policy digest |
| `budget-growth` | `transitionId`, `expectedFactoryEpoch`, `expectedPolicyDigest`; existing paused authority only |
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
