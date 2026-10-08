# Public local Factory SDK, CLI, and MCP

Licensed under [MIT](LICENSE), including commercial use.

Factory keeps a durable swarm ledger: mission, agent cells, budget allocations,
tasks, and external effects. `createSwarm` initializes the mission and initial
agents in one transaction; a failed agent admission leaves no partial swarm.
`FactorySwarmEngine` can dispatch work through an explicitly configured local
FLUJO or managed cloud adapter. Agents can also use the SDK or MCP directly.

Requires Node.js 24 or newer. The new fleet APIs are on the development main
branch: `npm install github:flujo-app/FACTORY#main`. A local checkout can be
installed with `npm install .`. The older `v0.2.0` tag contains only the local
coordination SDK. Run the project-local CLI with `npx factory`.
The [fresh-install check](evidence/public-sdk-install-20261008.json) resolved
main at `e3925c7` and created/replayed a three-cell swarm through the installed
package. A separate credential-free HTTPS source download and tarball install
passed the same local SDK check. A pinned Git install at `b93f627` also created
three cells through the installed SDK and exposed `FactoryLocalFleet.closeRetired`.
A pinned public Git install at `7c23d03` exported `buildSaviaCasePlan` and
constructed ten team leads with an exact 103-cent logical allocation under
Node 24; see the same evidence record. This check did not call FLUJO or a model.
A fresh pinned Git install at `3579051` also exported and constructed
`FactoryManagedFleet` under Node 24 with an inert synthetic adapter. It did not
deploy a cloud worker.
At `bf8d350`, the fresh public Git install exported `SpendingLedger` and
refused `FactoryManagedFleet` construction without it. Construction with an
initialized ledger passed under Node 24 with zero provider calls; see the
same evidence record.
`flujo-factory` is not yet published to the npm registry.

## CLI

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
```

The lower-level `FactoryControl` is also exported for the full local controller
API. Each SDK call closes its database connection before returning.

## FLUJO worker dispatch

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
Each worker's `provisionInput` is its exact `ManagedCloud.up` input, including
`app`; each conversation supplies its exact `conversationId`, FLUJO request
and absolute private output path. FACTORY persists input digests and effect
receipts rather than the private deployment input. Managed retirement confirms
the adapter's `down` receipt, but does not close a logical cell:
`closeRetired` refuses until an independent provider retirement proof path
exists. Uncertain cloud results remain held and are not automatically retried.
ManagedCloud's cached `list` inventory is not live health or physical absence
evidence.

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
server. The scratch source is identified in that record and is not the
FLUJO #955 release candidate.

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
fix was merged by PR #958 into FLUJO's
`codex/563-consolidated-integration-20261008` branch on 2026-10-08; that
branch is not FLUJO `main`. The integration branch's current lockfile passes
`npm audit --include=dev --audit-level=high --package-lock-only` with zero
high or critical findings (20 moderate findings remain).

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
