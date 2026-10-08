# Public local Factory SDK, CLI, and MCP

Licensed under [MIT](LICENSE), including commercial use.

Factory keeps a durable swarm ledger: mission, agent cells, budget allocations,
tasks, and external effects. `createSwarm` only initializes that ledger.
`FactorySwarmEngine` can dispatch work through an explicitly configured local
FLUJO or managed cloud adapter. Agents can also use the SDK or MCP directly.

Requires Node.js 24 or newer. The new fleet APIs are on the development main
branch: `npm install github:flujo-app/FACTORY#main`. A local checkout can be
installed with `npm install .`. The older `v0.2.0` tag contains only the local
coordination SDK. Run the project-local CLI with `npx factory`.

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
fix remains an open PR until merged.
To reproduce without paid
inference, start an isolated local FLUJO server and run
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
The active Observatory consumer branches still recognize only four effect
kinds (`provision`, `flow_call`, `retire`, `delivery`). FACTORY also presents
`worker_wake`, `worker_sleep`, `message`, and `flow_cancel`, with a terminal
`cancelled` state and worker scope. The allowlist updates are in
[Brain PR #7](https://github.com/flujo-app/brain/pull/7) and
[Brain Online PR #41](https://github.com/flujo-app/brain-online/pull/41).
Both are stacked on their existing Observatory branches and remain pending
until merged; private effect receipts stay out of the read-only feed.

## MCP

Configure a local stdio MCP server with command pointing to your project's
`node_modules/.bin/factory-mcp` (or `factory-mcp.cmd` on Windows) and argument
`/absolute/path/my-factory.sqlite`. It exposes `factory_create`,
`factory_add_agent`, `factory_add_task`, `factory_claim_task`, `factory_status`,
`factory_pause`, and `factory_resume`. The MCP client running this process can
mutate that database and receive task leases, so run it only in an environment
you trust. It does not expose cloud provider operations.
