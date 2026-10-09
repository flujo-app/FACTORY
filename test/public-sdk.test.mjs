import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Factory, FactoryControl, liteWorkerCommand, startLiteWorker } from '../src/public-sdk.mjs';

const cli = fileURLToPath(new URL('../bin/factory-public.mjs', import.meta.url));
const mcp = process.env.FACTORY_TEST_MCP ?? fileURLToPath(new URL('../bin/factory-mcp.mjs', import.meta.url));

test('lite workers launch native CLIs with only the Factory MCP configuration', () => {
  for (const provider of ['codex', 'claude']) {
    const spec = liteWorkerCommand({ provider, database: 'board.sqlite', prompt: 'Work on the board' });
    assert.equal(spec.command, provider);
    assert.equal(spec.args.at(-1), 'Work on the board');
    assert.ok(spec.args.join(' ').includes('factory-mcp.mjs'));
    assert.ok(spec.args.join(' ').includes('board.sqlite'));
  }
  const codex = liteWorkerCommand({ provider: 'codex', database: 'board.sqlite' });
  assert.ok(codex.args.includes('danger-full-access'));
  assert.ok(codex.args.includes('never'));
  assert.equal(codex.args.filter(value => value === '--config').length, 1);
  assert.ok(codex.env.CODEX_HOME.endsWith(join('.factory', 'lite-codex')));
  const claude = liteWorkerCommand({ provider: 'claude', database: 'board.sqlite' });
  assert.ok(claude.args.includes('--dangerously-skip-permissions'));
  assert.ok(claude.args.includes('--strict-mcp-config'));
  assert.deepEqual(Object.keys(JSON.parse(claude.args[claude.args.indexOf('--mcp-config') + 1]).mcpServers), ['factory']);
  assert.throws(() => liteWorkerCommand({ provider: 'flujo', database: 'board.sqlite' }), /provider/);
});

test('public SDK starts a lite worker through the same launcher as the CLI', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-lite-sdk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, 'board.sqlite');
  const factory = new Factory(database);
  const child = { pid: 1234 };
  let launched;
  const result = factory.startLiteWorker({ provider: 'claude', prompt: 'Work on the board', cwd: dir,
    stdio: 'pipe', spawnImpl(command, args, options) { launched = { command, args, options }; return child; } });
  assert.equal(result, child);
  assert.equal(launched.command, 'claude');
  assert.equal(launched.options.cwd, dir);
  assert.equal(launched.options.stdio, 'pipe');
  assert.equal(JSON.parse(launched.args[launched.args.indexOf('--mcp-config') + 1]).mcpServers.factory.args[1], database);
  assert.equal(typeof startLiteWorker, 'function');
});

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
  const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(client.getServerVersion()?.version, packageVersion);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('factory_create') && names.includes('factory_status'));
  const created = await client.callTool({ name: 'factory_create', arguments: { mission: 'Build', budgetCents: 0,
    agents: [{ id: 'builder', role: 'developer' }] } });
  assert.equal(created.isError, undefined);
  const status = await client.callTool({ name: 'factory_status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).cells.length, 2);
  const templates = await client.callTool({name:'factory_template_list',arguments:{}});
  assert.equal(templates.isError, undefined);
  assert.ok(JSON.parse(templates.content[0].text).templates.some(template => template.name === 'generic'));
  const custom = await client.callTool({name:'factory_template_create',arguments:{name:'product',goalContext:'Ship a usable intake'}});
  assert.equal(custom.isError, undefined);
  const record = JSON.parse(custom.content[0].text);
  const changed = await client.callTool({name:'factory_template_update',arguments:{name:'product',expectedRevision:record.revision,description:'Reusable product team'}});
  assert.equal(changed.isError, undefined);
  const stale = await client.callTool({name:'factory_template_delete',arguments:{name:'product',expectedRevision:record.revision}});
  assert.equal(stale.isError, true);
  const built = await client.callTool({name:'factory_template_build',arguments:{name:'product',model:'installed-model'}});
  assert.equal(built.isError, undefined);
  assert.equal(JSON.parse(built.content[0].text).flowSpecs.length, 2);
  const removed = await client.callTool({name:'factory_template_delete',arguments:{name:'product',expectedRevision:JSON.parse(changed.content[0].text).revision}});
  assert.equal(removed.isError, undefined);

});

test('invalid swarm allocation fails before creating a database', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, 'swarm.sqlite');
  assert.throws(() => new Factory(database).createSwarm({ mission: 'Build', budgetCents: 1,
    agents: [{ id: 'builder', budgetCents: 2 }] }), /allocations exceed/);
  await assert.rejects(stat(database), { code: 'ENOENT' });
});

test('swarm creation rolls back agents admitted before a later conflict', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const factory = new Factory(join(dir, 'swarm.sqlite'));
  factory.createSwarm({ mission: 'Build', agents: [{ id: 'existing', role: 'verifier' }] });
  assert.throws(() => factory.createSwarm({ mission: 'Build', agents: [
    { id: 'new-builder' }, { id: 'existing', role: 'developer' },
  ] }), /Cell identity is already bound/);
  assert.deepEqual(factory.status().cells.map(cell => cell.id).sort(), ['existing', 'root']);
  assert.equal(factory.createSwarm({ mission: 'Build', agents: [
    { id: 'new-builder' }, { id: 'existing', role: 'verifier' },
  ] }).cells.length, 3);
});

test('failed initial admission rolls back the root and earlier agents', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-root-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, 'swarm.sqlite');
  const control = new FactoryControl(database);
  try {
    assert.throws(() => control.initializeSwarm({ mission: 'Build', budgetCents: 0, maxCells: 16, maxDepth: 2 }, [
      { cellId: 'builder', budgetCents: 0, purpose: 'Build' },
      { cellId: 'reviewer', budgetCents: 0, purpose: '' },
    ]), /Role and purpose are required/);
    assert.throws(() => control.status(), /Initialize the factory first/);
  } finally { control.close(); }
  assert.equal(new Factory(database).createSwarm({ mission: 'Build', agents: [{ id: 'builder' }] }).cells.length, 2);
});

test('empty swarm can enroll agents after creation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const factory = new Factory(join(dir, 'swarm.sqlite'));
  assert.equal(factory.createSwarm({ mission: 'Build' }).cells.length, 1);
  assert.equal(factory.addAgent({ id: 'builder' }).status, 'ready');
  assert.equal(factory.status().cells.length, 2);
});

test('public SDK exposes budget-only growth without a cell or depth ceiling', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-growth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const factory = new Factory(join(dir, 'swarm.sqlite'));
  assert.equal(factory.createSwarm({ mission: 'Deep FLUJO swarm', budgetCents: 0,
    growthMode: 'budget-only' }).control.policy.growthMode, 'budget-only');
  let parentId = 'root';
  for (let index = 0; index < 32; index++) {
    const id = `agent-${index}`;
    factory.addAgent({ id, parentId, budgetCents: 0, purpose: 'Delegated work' });
    parentId = id;
  }
  assert.equal(factory.status().cells.length, 33);
  assert.throws(() => new Factory(join(dir, 'invalid.sqlite')).createSwarm({ mission: 'Invalid',
    growthMode: 'budget-only', maxCells: 100 }), /cannot include numeric/);
});

test('CLI reads a JSON file without shell quoting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-public-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'create.json'), database = join(dir, 'swarm.sqlite');
  await writeFile(input, JSON.stringify({ mission: 'Build', agents: [{ id: 'builder' }] }));
  const result = spawnSync(process.execPath, [cli, 'create', database, '@' + input], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cells.length, 2);
});

test('CLI manages templates using JSON files before swarm initialization', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-template-cli-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const database = join(dir,'templates.sqlite');
  function run(command,input) {
    const result=spawnSync(process.execPath,[cli,command,database,...(input ? [JSON.stringify(input)] : [])],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  }
  assert.ok(run('template-list').some(record=>record.name==='generic'));
  const created=run('template-create',{name:'cli-product',goalContext:'Build intake'});
  assert.equal(run('template-read',{name:'cli-product'}).revision,created.revision);
  assert.equal(run('template-build',{name:'cli-product',model:'installed-model'}).length,2);
  const changed=run('template-update',{name:'cli-product',expectedRevision:created.revision,description:'Updated'});
  run('template-delete',{name:'cli-product',expectedRevision:changed.revision});
  assert.equal(run('template-list').some(record=>record.name==='cli-product'),false);
});
