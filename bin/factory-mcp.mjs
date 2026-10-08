#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Factory } from '../src/public-sdk.mjs';

const database = process.argv[2];
if (!database || process.argv.length !== 3) {
  process.stderr.write('Usage: factory-mcp <database-path>\n');
  process.exit(1);
}
const factory = new Factory(database);
const definitions = [
  ['factory_create', 'Create a durable local swarm with mission, budgetCents, and an agents array.'],
  ['factory_add_agent', 'Reserve and enroll a local agent cell.'],
  ['factory_add_task', 'Add an immutable task for agents to claim.'],
  ['factory_claim_task', 'Claim a task for an agent and receive a private lease.'],
  ['factory_status', 'Read local cells, tasks, and admission status.'],
  ['factory_pause', 'Pause new local admission.'],
  ['factory_resume', 'Resume local admission.'],
];
const schemas = {
  factory_create: { required: ['mission'], properties: { mission: { type: 'string' }, budgetCents: { type: 'integer', minimum: 0 },
    agents: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' },
      role: { type: 'string', enum: ['developer', 'verifier', 'watcher', 'coordinator'] },
      parentId: { type: 'string' }, budgetCents: { type: 'integer', minimum: 0 }, purpose: { type: 'string' } } } },
    maxCells: { type: 'integer', minimum: 1 }, maxDepth: { type: 'integer', minimum: 1 },
    growthMode: { type: 'string', enum: ['budget-only'] } } },
  factory_add_agent: { required: ['id'], properties: { id: { type: 'string' }, parentId: { type: 'string' },
    role: { type: 'string', enum: ['developer', 'verifier', 'watcher', 'coordinator'] },
    budgetCents: { type: 'integer', minimum: 0 }, purpose: { type: 'string' } } },
  factory_add_task: { required: ['id', 'projectId', 'branch', 'problem', 'acceptance', 'baseline'], properties: {
    id: { type: 'string' }, projectId: { type: 'string' }, branch: { type: 'string' },
    problem: { type: 'string' }, acceptance: { type: 'string' }, baseline: { type: 'string' } } },
  factory_claim_task: { required: ['taskId', 'agentId'], properties: { taskId: { type: 'string' },
    agentId: { type: 'string' }, ttlMs: { type: 'integer', minimum: 1 } } },
};
const methods = {
  factory_create: args => factory.createSwarm(args),
  factory_add_agent: args => factory.addAgent(args),
  factory_add_task: args => factory.addTask(args),
  factory_claim_task: args => factory.claimTask(args),
  factory_status: () => factory.status(),
  factory_pause: () => factory.pause(),
  factory_resume: () => factory.resume(),
};
const server = new Server({ name: 'factory-local', version: '0.3.0-dev.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(([name, description]) => ({
  name, description, inputSchema: { type: 'object', additionalProperties: false, ...(schemas[name] ?? {}) },
  annotations: { readOnlyHint: name === 'factory_status', openWorldHint: false },
})) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const method = methods[request.params.name];
  if (!method) return { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] };
  try {
    const result = method(request.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `${error.code ?? 'FACTORY_ERROR'}: ${error.message}` }] };
  }
});
await server.connect(new StdioServerTransport());
