# Public local Factory SDK, CLI, and MCP

Licensed under [MIT](LICENSE), including commercial use.

Factory keeps a durable swarm ledger: mission, agent cells, budget allocations,
tasks, and external effects. `createSwarm` only initializes that ledger.
`FactorySwarmEngine` can dispatch work through an explicitly configured local
FLUJO or managed cloud adapter. Agents can also use the SDK or MCP directly.

Requires Node.js 24 or newer. Install version 0.2.0 into your project with
`npm install github:flujo-app/FACTORY#v0.2.0` or from a local checkout with
`npm install .`. Run the project-local CLI with `npx factory`.

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

`createFlujoWorkspaceAdapter({origin, token})` drives local FLUJO workspaces.
Provisioning takes `{app, flowSpec}` and requires a new `swarm-<app>` workspace;
it compiles the supplied flow spec before marking the worker ready. Calls take
`{conversationId, request:{flowName,prompt}}`. A workspace shares the FLUJO
machine with other workspaces, so it is not a separate sandbox. The adapter
does not install the recovered fleet template or grant agents delegation tools.

The FLUJO HTTP client in `src/flujo-swarm` is a source extraction from the
MIT-licensed Seagulled package, revision `70f1a7f115203e723fdc18e5a2cd5b9d391db363`,
which in turn records its source extraction from `flujo-app/swarm-teams`.

This is the first public cloud dispatch surface. It does not yet include the
recursive worker scheduler, conversation templates, or the Observatory host.

## MCP

Configure a local stdio MCP server with command pointing to your project's
`node_modules/.bin/factory-mcp` (or `factory-mcp.cmd` on Windows) and argument
`/absolute/path/my-factory.sqlite`. It exposes `factory_create`,
`factory_add_agent`, `factory_add_task`, `factory_claim_task`, `factory_status`,
`factory_pause`, and `factory_resume`. The MCP client running this process can
mutate that database and receive task leases, so run it only in an environment
you trust. It does not expose cloud provider operations.
