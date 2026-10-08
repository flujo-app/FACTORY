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
isolated FLUJO 3.46.1 development server. Each test workspace was deleted and
its absence confirmed. No inference ran in those checks. A separate older,
shared FLUJO checkout returned HTTP 500 on workspace creation; no test
workspace remained there. The 10-worker/100-conversation and 300-conversation
checks use injected adapters, so live fleet throughput is still unverified.
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
`fleet.cancel({jobId})` records one stop intent and asks FLUJO to cancel the
active conversation. A `requested` receipt confirms the request was processed,
not that the run reached a terminal cancelled state. If the original call then
ends without a confirmed output, FACTORY retains the task as `held` for
reconciliation; replay never sends a second stop request.

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
The checked-in Brain Online `factorySnapshotSchema` currently recognizes four
effect kinds (`provision`, `flow_call`, `retire`, `delivery`), while FACTORY can
also present `worker_wake`, `worker_sleep`, `message`, and `flow_cancel`. That consumer contract
needs a matching update before it can parse snapshots containing those effects.

## MCP

Configure a local stdio MCP server with command pointing to your project's
`node_modules/.bin/factory-mcp` (or `factory-mcp.cmd` on Windows) and argument
`/absolute/path/my-factory.sqlite`. It exposes `factory_create`,
`factory_add_agent`, `factory_add_task`, `factory_claim_task`, `factory_status`,
`factory_pause`, and `factory_resume`. The MCP client running this process can
mutate that database and receive task leases, so run it only in an environment
you trust. It does not expose cloud provider operations.
