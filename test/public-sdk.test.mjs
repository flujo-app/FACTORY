import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Factory } from '../src/public-sdk.mjs';

const cli = fileURLToPath(new URL('../bin/factory-public.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('../bin/factory-mcp.mjs', import.meta.url));

test('public SDK and CLI coordinate a local swarm without a provider', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, 'swarm.sqlite');
  const factory = new Factory(database);
  const created = factory.createSwarm({ mission: 'Build an app', budgetCents: 0,
    agents: [{ id: 'builder', role: 'developer' }, { id: 'reviewer', role: 'verifier' }] });
  assert.equal(created.cells.length, 3);
  assert.deepEqual(created.cells.map(cell => cell.status), ['ready', 'ready', 'ready']);
  const result = spawnSync(process.execPath, [cli, 'task', database, JSON.stringify({ id: 'one', projectId: 'app',
    branch: 'codex/one', problem: 'Build', acceptance: 'Checks pass', baseline: 'main' })], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'ready');
  assert.equal(factory.claimTask({ taskId: 'one', agentId: 'builder' }).scopeId, 'one');
  assert.equal(factory.status().tasks[0].owner, 'builder');
  assert.equal(factory.pause().control.status, 'paused');
  assert.equal(factory.resume().control.status, 'active');
});

test('public MCP stdio server creates and reads a local swarm', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, join(dir, 'swarm.sqlite')] });
  const client = new Client({ name: 'factory-public-test', version: '1.0.0' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('factory_create') && names.includes('factory_status'));
  const created = await client.callTool({ name: 'factory_create', arguments: { mission: 'Build', budgetCents: 0,
    agents: [{ id: 'builder', role: 'developer' }] } });
  assert.equal(created.isError, undefined);
  const status = await client.callTool({ name: 'factory_status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).cells.length, 2);
});

test('invalid swarm allocation fails before creating a database', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, 'swarm.sqlite');
  assert.throws(() => new Factory(database).createSwarm({ mission: 'Build', budgetCents: 1,
    agents: [{ id: 'builder', budgetCents: 2 }] }), /allocations exceed/);
  await assert.rejects(stat(database), { code: 'ENOENT' });
});
