import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCloudLitePlan, secret } from '../src/cloud-lite/protocol.mjs';
import { validateMcpServers, validateMcpSecrets, resolveMcpServers, MCP_SERVER_LIMIT } from '../src/cloud-lite/mcp-servers.mjs';
import { nativeAgentConfig } from '../src/cloud-lite/runtime.mjs';
import { ClaudeSessionDriver } from '../src/cloud-lite/claude-driver.mjs';
import { ClaudeSubscriptionBroker, FactoryCloudLiteFleet } from '../src/cloud-lite/fleet.mjs';
import { tempDir } from './support/temp-dir.mjs';

const fresh = () => tempDir('factory-cloud-lite-mcp-');
const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
// A Lean server in each container with a key, a network server whose header is a key, and one on this computer.
const servers = () => ({
  lean: { command: 'lean-lsp-mcp', args: ['--transport', 'stdio'], env: { LEAN_PROJECT_PATH: '/data/repository', LEAN_KEY: { secret: 'LEAN_KEY' } }, required: true },
  docs: { url: 'https://mcp.example.test/mcp', headers: { Authorization: { secret: 'DOCS_AUTH' }, 'X-Team': 'factory' } },
  local: { url: 'http://host.docker.internal:8931/mcp' },
});
const base = (extra = {}) => ({ runId: 'mcp-test', app: 'factory-mcp-test', goal: 'Prove a theorem', machines: 1, agentsPerMachine: 2, workerProgram: 'claude', ...extra });
const keys = () => ({ LEAN_KEY: `lean-${secret()}`, DOCS_AUTH: `Bearer ${secret()}` });
const board = { command: 'node', args: ['proxy.mjs'], env: { FACTORY_BOARD_URL: 'http://board', FACTORY_BOARD_TOKEN: 'agent-board-token' } };

test('a plan may give every agent extra MCP servers, and refuses unclear or unsafe ones', () => {
  assert.deepEqual(validateMcpServers(servers()), ['DOCS_AUTH', 'LEAN_KEY'], 'the keys the servers refer to');
  assert.deepEqual(validateCloudLitePlan(base({ mcpServers: servers() })).mcpServers, servers());
  assert.deepEqual(validateCloudLitePlan(base({ workerProgram: 'codex', mcpServers: servers() })).mcpServers, servers());
  assert.equal('mcpServers' in validateCloudLitePlan(base()), false, 'no default is added to existing fleet bindings');
  assert.deepEqual(validateMcpServers({ quiet: { command: 'x', args: [''], env: { DEBUG: '' } } }), [], 'empty text is a value too');
  const flujo = { workerProgram: 'flujo', modelProvider: { id: 'served', envKey: 'P_MODEL_KEY', baseUrls: ['https://model.example.test/v1'], apis: ['chat'], model: 'm' } };
  assert.throws(() => validateCloudLitePlan(base({ ...flujo, mcpServers: servers() })), /not available for FLUJO workers yet/);
  const many = Object.fromEntries(Array.from({ length: MCP_SERVER_LIMIT + 1 }, (_, index) => [`s${index}`, { command: 'x' }]));
  const refused = [
    [[], /object of named servers/], [{}, /1 to 16/], [many, /1 to 16/],
    [{ 'Bad Name': { command: 'x' } }, /not a valid server name/], [{ factory: { command: 'x' } }, /job board/],
    [{ a: { command: 'x', url: 'https://x.example.test' } }, /either a command .* or a url/], [{ a: {} }, /either a command/], [{ a: 'x' }, /must be an object/],
    [{ a: { command: 'x', headers: {} } }, /cannot use: headers/], [{ a: { url: 'https://x.example.test', env: {} } }, /cannot use: env/],
    [{ a: { command: 'x', timeout: 5 } }, /cannot use: timeout/], [{ a: { command: 'x', required: 'yes' } }, /required must be true or false/],
    [{ a: { command: '' } }, /command must be one line/], [{ a: { command: 'x\ny' } }, /command must be one line/],
    [{ a: { command: 'x', args: 'y' } }, /args must be a list/], [{ a: { command: 'x', args: [1] } }, /args must be a list/],
    [{ a: { command: 'x', env: [] } }, /env must be an object/], [{ a: { command: 'x', env: { 'BAD-NAME': 'x' } } }, /not a valid environment variable name/],
    [{ a: { command: 'x', env: { A: 'two\nlines' } } }, /one line of text, or \{ secret/], [{ a: { command: 'x', env: { A: { secret: 'lower' } } } }, /\{ secret/],
    [{ a: { command: 'x', env: { A: { secret: 'OK', also: 1 } } } }, /\{ secret/], [{ a: { command: 'x', env: { A: 7 } } }, /\{ secret/],
    [{ a: { url: 'http://mcp.example.test/mcp' } }, /https address/], [{ a: { url: 'https://user:pw@mcp.example.test/mcp' } }, /https address/],
    [{ a: { url: 'https://mcp.example.test/mcp#part' } }, /https address/], [{ a: { url: 'ftp://mcp.example.test' } }, /https address/], [{ a: { url: 'not a url' } }, /https address/],
    [{ a: { url: 'https://mcp.example.test', headers: { 'Bad Header': 'x' } } }, /not a valid header name/],
  ];
  for (const [value, message] of refused) assert.throws(() => validateCloudLitePlan(base({ mcpServers: value })), message, JSON.stringify(value));
});

test('the keys given to deploy must be exactly the ones the plan refers to', () => {
  assert.deepEqual(validateMcpSecrets(undefined, undefined), {});
  assert.deepEqual(validateMcpSecrets({ plain: { command: 'x' } }, undefined), {}, 'servers without keys need none');
  const given = keys();
  assert.equal(validateMcpSecrets(servers(), given), given);
  assert.throws(() => validateMcpSecrets(servers(), undefined), /need these keys in mcpSecrets: DOCS_AUTH, LEAN_KEY/);
  assert.throws(() => validateMcpSecrets(servers(), { LEAN_KEY: given.LEAN_KEY }), /missing DOCS_AUTH/);
  assert.throws(() => validateMcpSecrets(servers(), { ...given, OTHER_KEY: secret() }), /OTHER_KEY, which no MCP server of the plan refers to/);
  assert.throws(() => validateMcpSecrets(undefined, { OTHER_KEY: secret() }), /no MCP server of the plan refers to/);
  assert.throws(() => validateMcpSecrets(servers(), { ...given, LEAN_KEY: 'short' }), /LEAN_KEY must be one line of at least 8 characters/);
  assert.throws(() => validateMcpSecrets(servers(), { ...given, LEAN_KEY: 'two\nlines-of-key' }), /at least 8 characters/);
});

test('every agent session gets the extra servers next to the board, with the keys filled in', () => {
  const given = keys();
  assert.deepEqual(resolveMcpServers(servers(), given), {
    lean: { command: 'lean-lsp-mcp', args: ['--transport', 'stdio'], env: { LEAN_PROJECT_PATH: '/data/repository', LEAN_KEY: given.LEAN_KEY }, required: true },
    docs: { url: 'https://mcp.example.test/mcp', http_headers: { Authorization: given.DOCS_AUTH, 'X-Team': 'factory' }, required: false },
    local: { url: 'http://host.docker.internal:8931/mcp', required: false },
  });
  assert.deepEqual(resolveMcpServers({ bare: { command: 'x' } }), { bare: { command: 'x', args: [], env: {}, required: false } });
  const plan = validateCloudLitePlan(base({ mcpServers: servers() }));
  const { config } = nativeAgentConfig({ plan, directory: '/data/worktrees/m0-a1', board, mcpSecrets: given });
  assert.deepEqual(Object.keys(config.mcp_servers), ['lean', 'docs', 'local', 'factory']);
  assert.deepEqual(config.mcp_servers.factory, { ...board, env: { ...board.env, FACTORY_WORKTREE: '/data/worktrees/m0-a1' }, required: true });
  assert.equal(config.mcp_servers.lean.env.LEAN_KEY, given.LEAN_KEY);
  const withoutBoard = nativeAgentConfig({ plan: { ...plan, boardTools: false }, directory: '/w', board, mcpSecrets: given }).config;
  assert.deepEqual(Object.keys(withoutBoard.mcp_servers), ['lean', 'docs', 'local']);
  assert.equal('mcp_servers' in nativeAgentConfig({ plan: { ...validateCloudLitePlan(base()), boardTools: false }, directory: '/w', board }).config, false);
});

function harness(args = []) {
  const root = fresh(), log = join(root, 'invocations.jsonl'), errors = [], notes = [];
  const driver = new ClaudeSessionDriver({ command: process.execPath, args: [fake, ...args], configDirectory: join(root, 'claude'), stateDirectory: join(root, 'state'),
    privateDirectory: join(root, 'private'), environment: () => ({ ...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude'), FAKE_CLAUDE_LOG: log }), onStderr: text => errors.push(text) });
  driver.on('notification', note => notes.push(note));
  const turn = async threadId => {
    const done = new Promise(resolve => { const check = note => { if (note.method === 'turn/completed') { driver.off('notification', check); resolve(note.params.turn); } }; driver.on('notification', check); });
    await driver.request('turn/start', { threadId, input: [{ type: 'text', text: 'work' }], effort: 'xhigh' });
    return done;
  };
  const invocations = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, driver, notes, errors, turn, invocations };
}

test('Claude Code gets every server in a private file, may use their tools in any sandbox, and reports whether each connected', async () => {
  const given = keys(), plan = validateCloudLitePlan(base({ mcpServers: servers(), sandbox: 'workspace-write' }));
  const h = harness();
  const { config } = nativeAgentConfig({ plan, directory: h.root, board, mcpSecrets: given });
  const { thread } = await h.driver.request('thread/start', { model: 'claude-fable-5-2', cwd: h.root, sandbox: 'workspace-write', config });
  assert.equal((await h.turn(thread.id)).status, 'completed');
  const [invocation] = h.invocations();
  const file = invocation.args[invocation.args.indexOf('--mcp-config') + 1];
  assert.equal(file, join(h.root, 'private', `${thread.id}.claude-mcp.json`), 'the file with keys is in the private directory, which evidence does not collect');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).mcpServers, {
    lean: { command: 'lean-lsp-mcp', args: ['--transport', 'stdio'], env: { LEAN_PROJECT_PATH: '/data/repository', LEAN_KEY: given.LEAN_KEY } },
    docs: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: given.DOCS_AUTH, 'X-Team': 'factory' } },
    local: { type: 'http', url: 'http://host.docker.internal:8931/mcp' },
    factory: { command: 'node', args: ['proxy.mjs'], env: { ...board.env, FACTORY_WORKTREE: h.root } },
  });
  assert.equal(existsSync(join(h.root, 'state', `${thread.id}.claude-mcp.json`)), false);
  assert.equal(invocation.args[invocation.args.indexOf('--allowedTools') + 1], 'Bash,mcp__lean__*,mcp__docs__*,mcp__local__*,mcp__factory__*');
  assert.equal(invocation.args.some(arg => arg.includes(given.LEAN_KEY) || arg.includes(given.DOCS_AUTH) || arg.includes('agent-board-token')), false, 'no key in the arguments');
  const configured = h.notes.find(note => note.method === 'session/configured').params;
  assert.deepEqual(configured, { threadId: thread.id, turnId: configured.turnId, model: 'claude-fable-5-2', mcpServers: [
    { name: 'lean', required: true, status: 'connected' }, { name: 'docs', required: false, status: 'connected' },
    { name: 'local', required: false, status: 'connected' }, { name: 'factory', required: true, status: 'connected' }] });
  assert.equal(JSON.stringify(h.notes).includes(given.LEAN_KEY), false, 'no key in what the trace records');
  // A file an older runtime left in the state directory, which evidence collects, goes when the session is resumed.
  const stale = join(h.root, 'state', `${thread.id}.claude-mcp.json`);
  writeFileSync(stale, JSON.stringify({ mcpServers: { factory: board } }));
  await h.driver.request('thread/resume', { threadId: thread.id, cwd: h.root, sandbox: 'workspace-write', config, model: 'claude-fable-5-2' });
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(file), true);
  h.driver.close();
});

test('a required MCP server that did not connect ends the turn; an optional one is reported and the turn goes on', async () => {
  const given = keys(), plan = validateCloudLitePlan(base({ mcpServers: servers() }));
  const start = async h => (await h.driver.request('thread/start', { model: 'm', cwd: h.root, sandbox: 'danger-full-access', config: nativeAgentConfig({ plan, directory: h.root, board, mcpSecrets: given }).config })).thread;
  const required = harness(['--fake-mcp-failed', 'lean']);
  assert.equal((await required.turn((await start(required)).id)).status, 'failed');
  assert.match(required.errors.join(' '), /The required MCP server lean did not connect; ending the turn/);
  const optional = harness(['--fake-mcp-failed', 'docs']);
  assert.equal((await optional.turn((await start(optional)).id)).status, 'completed');
  assert.deepEqual(optional.notes.find(note => note.method === 'session/configured').params.mcpServers.find(server => server.name === 'docs'), { name: 'docs', required: false, status: 'failed' });
  assert.deepEqual(optional.errors, []);
  const boardDown = harness(['--fake-board-failed']);
  assert.equal((await boardDown.turn((await start(boardDown)).id)).status, 'failed');
  assert.match(boardDown.errors.join(' '), /The board MCP server did not connect/);
});

function infrastructure(calls) {
  const machines = [];
  return {
    run: async (args, options = {}) => { calls.push({ args, input: options.input }); if (args[0] === 'volumes') return JSON.stringify({ id: `vol_${machines.length}` }); if (args[0] === 'machine') return JSON.stringify(machines); return ''; },
    buildMachineConfig: () => ({ init: { cmd: ['upstream'] }, services: [] }),
    createMachine: async ({ name, config }) => { const machine = { id: `machine-${machines.length}`, name, config }; machines.push(machine); return machine; },
  };
}
const image = 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64);

test('a fleet checks MCP keys before it creates anything and stages them only as a secret', async () => {
  const root = fresh(), tokenFile = join(root, 'token'); writeFileSync(tokenFile, 'sk-ant-oat01-' + 'z'.repeat(40));
  const fleetFor = calls => new FactoryCloudLiteFleet({ directory: join(fresh(), 'fleet'), auth: new ClaudeSubscriptionBroker({ tokenFile }), infrastructure: infrastructure(calls) });
  const remote = { lean: servers().lean, docs: servers().docs };
  for (const [mcpSecrets, message] of [[undefined, /need these keys/], [{ LEAN_KEY: keys().LEAN_KEY }, /missing DOCS_AUTH/], [{ ...keys(), EXTRA_KEY: secret() }, /EXTRA_KEY/]]) {
    const calls = [], fleet = fleetFor(calls);
    await assert.rejects(fleet.deploy(base({ mcpServers: remote }), { image, mcpSecrets }), message);
    assert.equal(calls.length, 0); assert.equal(fleet.state, null); assert.equal(existsSync(fleet.journalPath), false);
  }
  // A Fly machine cannot reach the deploying computer, so a plain-http MCP server there is refused at once.
  const local = [], flyFleet = fleetFor(local);
  await assert.rejects(flyFleet.deploy(base({ mcpServers: servers() }), { image, mcpSecrets: keys() }), /An MCP server on this computer \(plain http\) cannot be reached from Fly machines/);
  assert.equal(local.length, 0); assert.equal(flyFleet.state, null);

  const calls = [], fleet = fleetFor(calls), given = keys();
  await fleet.deploy(base({ mcpServers: remote }), { image, mcpSecrets: given });
  const staged = calls.find(call => call.args[0] === 'secrets');
  const config = JSON.parse(Buffer.from(staged.input.trim().split('=').slice(1).join('='), 'base64').toString());
  assert.deepEqual(config.mcpSecrets, given);
  assert.deepEqual(config.plan.mcpServers.lean.env.LEAN_KEY, { secret: 'LEAN_KEY' }, 'the plan keeps only the reference');
  const journal = readFileSync(fleet.journalPath, 'utf8');
  assert.equal(journal.includes(given.LEAN_KEY) || journal.includes(given.DOCS_AUTH), false);
  assert.equal(fleet.knownSecrets.includes(given.DOCS_AUTH), true, 'provider errors are redacted of the keys too');
  // A plan without MCP keys stages none.
  const plainCalls = [];
  await fleetFor(plainCalls).deploy(base(), { image });
  assert.equal('mcpSecrets' in JSON.parse(Buffer.from(plainCalls.find(call => call.args[0] === 'secrets').input.trim().split('=').slice(1).join('='), 'base64').toString()), false);
});
