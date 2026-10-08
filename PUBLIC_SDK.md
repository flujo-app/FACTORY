# Public local Factory SDK, CLI, and MCP

Licensed under [MIT](LICENSE), including commercial use.

Factory is a durable **local coordinator**. A swarm here means a mission, named
agent cells, budget allocations, and claimable tasks in one SQLite database.
Creating a swarm does not start agent processes, call an AI provider, or deploy
cloud infrastructure. Agents can be your own programs using this SDK or MCP.

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

## MCP

Configure a local stdio MCP server with command pointing to your project's
`node_modules/.bin/factory-mcp` (or `factory-mcp.cmd` on Windows) and argument
`/absolute/path/my-factory.sqlite`. It exposes `factory_create`,
`factory_add_agent`, `factory_add_task`, `factory_claim_task`, `factory_status`,
`factory_pause`, and `factory_resume`. The MCP client running this process can
mutate that database and receive task leases, so run it only in an environment
you trust. It does not expose cloud provider operations.
