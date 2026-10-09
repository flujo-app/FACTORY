#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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
  ['factory_template_list', 'List durable templates, including the default generic native FLUJO team.'],
  ['factory_template_read', 'Read a template and its revision.'],
  ['factory_template_create', 'Create a reusable template without provisioning or launching workers.'],
  ['factory_template_update', 'Update template settings against an expected revision.'],
  ['factory_template_delete', 'Delete a custom template or reset the generic override.'],
  ['factory_template_build', 'Build native FLUJO flow specifications using an installed model and observed tool inventory.'],
  ['factory_create', 'Create a durable local swarm with mission, budgetCents, and an agents array.'],
  ['factory_add_agent', 'Reserve and enroll a local agent cell.'],
  ['factory_add_task', 'Add an immutable task for agents to claim.'],
  ['factory_claim_task', 'Claim a task for an agent and receive a private lease.'],
  ['factory_status', 'Read local cells, tasks, and admission status.'],
  ['factory_pause', 'Pause new local admission.'],
  ['factory_resume', 'Resume local admission.'],
];
const settings = { description: {type:'string'}, goalContext: {type:'string'},
  environment: {type:'object',additionalProperties:{type:'string'}},
  limits: {type:'object',additionalProperties:false,properties:{agentTurns:{type:'integer'},leadTurns:{type:'integer'},concurrency:{type:'integer'}}} };
const schemas = {
  factory_template_list: {},
  factory_template_read: {required:['name'],properties:{name:{type:'string'}}},
  factory_template_create: {required:['name'],properties:{name:{type:'string'},...settings}},
  factory_template_update: {required:['name','expectedRevision'],properties:{name:{type:'string'},expectedRevision:{type:'integer',minimum:0},...settings}},
  factory_template_delete: {required:['name','expectedRevision'],properties:{name:{type:'string'},expectedRevision:{type:'integer',minimum:0}}},
  factory_template_build: {required:['model'],properties:{name:{type:'string'},model:{type:'string'},
    availableServers:{type:'array',items:{type:'string'}}, availableTools:{type:'object',additionalProperties:{type:'array',items:{type:'string'}}}, limits:settings.limits}},
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
  factory_template_list: () => ({templates:factory.listTemplates()}),
  factory_template_read: args => {
    const record = factory.getTemplate(args.name);
    if (!record) throw Object.assign(new Error('Template does not exist.'), {code:'TEMPLATE_MISSING'});
    return record;
  },
  factory_template_create: args => factory.createTemplate(args),
  factory_template_update: ({name,...args}) => factory.updateTemplate(name,args),
  factory_template_delete: ({name,...args}) => factory.deleteTemplate(name,args),
  factory_template_build: ({name='generic',...args}) => ({flowSpecs:factory.buildTemplate(name,args)}),
  factory_create: args => factory.createSwarm(args),
  factory_add_agent: args => factory.addAgent(args),
  factory_add_task: args => factory.addTask(args),
  factory_claim_task: args => factory.claimTask(args),
  factory_status: () => factory.status(),
  factory_pause: () => factory.pause(),
  factory_resume: () => factory.resume(),
};
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const server = new Server({ name: 'factory-local', version: packageVersion }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(([name, description]) => ({
  name, description, inputSchema: { type: 'object', additionalProperties: false, ...(schemas[name] ?? {}) },
  annotations: { readOnlyHint: ['factory_status','factory_template_list','factory_template_read','factory_template_build'].includes(name), openWorldHint: false },
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
