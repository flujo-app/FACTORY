import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCloudLitePlan, agentInventory, machineConfig, secret } from '../src/cloud-lite/protocol.mjs';
import { cloudLiteBootstrap } from '../src/cloud-lite/bootstrap.mjs';
import { ClaudeSessionDriver, claudeCommandWrapper, claudeEnvironment, claudeSandboxPolicy, claudeSessionArguments } from '../src/cloud-lite/claude-driver.mjs';
import { ClaudeSubscriptionBroker, CodexSubscriptionBroker, FactoryCloudLiteFleet } from '../src/cloud-lite/fleet.mjs';
import { NativeOperatorStop } from '../src/cloud-lite/operator-stop.mjs';
import { NativeWorkflowWake } from '../src/cloud-lite/workflow-wake.mjs';
import { CloudLiteTrace } from '../src/cloud-lite/trace.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';
import { nativeStopTurn } from '../src/cloud-lite/runtime.mjs';
import { tempDir } from './support/temp-dir.mjs';

const fresh = () => tempDir('factory-cloud-lite-claude-');
const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const provider = (extra = {}) => ({ id: 'selfhosted', envKey: 'SELF_HOSTED_MODEL_KEY', model: 'served-model', apis: ['anthropic'],
  baseUrls: ['https://model-a.example.test/v1', 'https://model-b.example.test/v1'], contextWindow: 262144, autoCompactTokenLimit: 80000, ...extra });
const plan = (extra = {}) => validateCloudLitePlan({ runId: 'claude-test', app: 'factory-claude-test', goal: 'Work on operator jobs', machines: 1, agentsPerMachine: 2,
  workerProgram: 'claude', modelProvider: provider(), ...extra });
const text = value => [{ type: 'text', text: value }];

function harness({ root = fresh(), args = [], ...options } = {}) {
  const log = join(root, 'invocations.jsonl');
  const driver = new ClaudeSessionDriver({ command: process.execPath, args: [fake, ...args], configDirectory: join(root, 'claude'), stateDirectory: join(root, 'state'),
    environment: () => ({ ...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude'), FAKE_CLAUDE_LOG: log }), ...options });
  const notes = [];
  driver.on('notification', note => notes.push(note));
  const finished = () => new Promise(resolve => { const check = note => { if (note.method === 'turn/completed') { driver.off('notification', check); resolve(note.params.turn); } }; driver.on('notification', check); });
  const invocations = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, driver, notes, finished, invocations };
}
const started = ({ driver, root }, extra = {}) => driver.request('thread/start', { model: 'served-model', cwd: root, sandbox: 'danger-full-access', developerInstructions: 'Be useful.', ...extra });
const output = (notes, type) => notes.filter(note => note.method === 'item/completed' && note.params.item.type === type).map(note => note.params.item);
const waitFor = async condition => { for (let i = 0; i < 400; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Condition was not reached.'); };

test('plans choose a worker program and refuse a provider without the API it needs', () => {
  assert.equal('workerProgram' in validateCloudLitePlan({ runId: 'codex-test', app: 'factory-codex-test', goal: 'x' }), false, 'existing fleet bindings stay unchanged');
  assert.equal(validateCloudLitePlan({ runId: 'codex-test', app: 'factory-codex-test', goal: 'x' }).model, 'gpt-6.1-sol');
  const subscription = plan({ modelProvider: undefined });
  assert.deepEqual([subscription.workerProgram, subscription.model, subscription.subagentModel], ['claude', 'opus', 'sonnet']);
  assert.equal(plan().modelProvider.model, 'served-model');
  assert.throws(() => plan({ workerProgram: 'other' }), /workerProgram must be one of codex, claude/);
  assert.throws(() => plan({ modelProvider: provider({ apis: ['responses'] }) }), /offers the anthropic API/);
  assert.throws(() => plan({ workerProgram: 'codex' }), /offers the responses API/);
  assert.throws(() => plan({ modelProvider: provider({ model: undefined }) }), /served model/);
  assert.equal(plan({ modelProvider: provider({ model: undefined }), model: 'named' }).model, 'named');
  assert.equal(machineConfig(plan(), { image: 'i', volumeId: 'v', index: 0, environment: {} }).metadata['factory.runtime'], 'claude-lite');
  assert.equal(machineConfig(plan({ workerProgram: 'codex', modelProvider: provider({ apis: ['responses'] }) }), { image: 'i', volumeId: 'v', index: 0, environment: {} }).metadata['factory.runtime'], 'codex-lite');
});

test('the environment holds the key, the arguments never do, and agent commands lose it', () => {
  const key = secret(), githubToken = secret();
  const env = claudeEnvironment({ plan: plan(), index: 1, home: '/data/claude', commandWrapper: '/w.sh', providerKey: key, githubToken, path: '/usr/bin' });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, key);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://model-b.example.test');
  assert.equal(env.ANTHROPIC_MODEL, 'served-model');
  assert.equal(env.CLAUDE_CODE_SHELL_PREFIX, '/w.sh');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/data/claude');
  assert.equal(env.GH_TOKEN, githubToken);
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false);
  assert.equal('GH_TOKEN' in claudeEnvironment({ plan: plan(), home: '/h', providerKey: key, githubToken, deployKey: 'k' }), false);
  const oauthToken = secret();
  const subscription = claudeEnvironment({ plan: plan({ modelProvider: undefined }), home: '/h', oauthToken });
  assert.equal(subscription.CLAUDE_CODE_OAUTH_TOKEN, oauthToken);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in subscription, false);
  const providerWrapper = claudeCommandWrapper({ provider: true });
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN']) assert.match(providerWrapper, new RegExp(`-u ${name}\\b`));
  assert.doesNotMatch(claudeCommandWrapper(), /GH_TOKEN/, 'subscription workers keep GitHub access, as Codex does');
  assert.match(providerWrapper, /bash -c "\$1"/);
});

test('sandbox names map to permission modes and the operating system sandbox', () => {
  const full = claudeSandboxPolicy({ directory: '/w' });
  assert.deepEqual(full.args, ['--dangerously-skip-permissions']);
  assert.equal(full.settings, undefined);
  const write = claudeSandboxPolicy({ sandbox: 'workspace-write', directory: '/w', writableRoots: ['/scratch'] });
  assert.deepEqual(write.args, ['--permission-mode', 'acceptEdits', '--add-dir', '/scratch']);
  assert.deepEqual(write.settings.sandbox.filesystem, { allowWrite: ['/scratch'] });
  assert.deepEqual(write.settings.sandbox.network, { allowedDomains: [] });
  assert.equal(write.settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(write.settings.sandbox.failIfUnavailable, true);
  assert.ok(write.tools.includes('Write'));
  const read = claudeSandboxPolicy({ sandbox: 'read-only', directory: '/w' });
  assert.deepEqual(read.args, ['--permission-mode', 'dontAsk']);
  assert.deepEqual(read.settings.sandbox.filesystem, { denyWrite: ['/w'] });
  assert.equal(read.tools.includes('Write') || read.tools.includes('Edit'), false);
  assert.throws(() => claudeSandboxPolicy({ sandbox: 'none', directory: '/w' }), /Unsupported sandbox/);
  const args = claudeSessionArguments({ threadId: 't', resume: false, model: 'm', effort: 'unknown', policy: full, boardTools: false });
  assert.equal(args.includes('--effort'), false, 'an effort the program does not know is left out');
  assert.equal(args.includes('--allowedTools'), false, 'no board tools to allow');
  assert.deepEqual(args.slice(-2), ['--session-id', 't']);
  const board = claudeSessionArguments({ threadId: 't', resume: true, effort: 'high', policy: write, boardTools: true, mcpConfigFile: '/m.json', settingsFile: '/s.json' });
  assert.equal(board[board.indexOf('--allowedTools') + 1], 'Bash,mcp__factory__*');
  assert.equal(board[board.indexOf('--effort') + 1], 'high');
  assert.equal(board[board.indexOf('--strict-mcp-config') + 1], '--setting-sources');
  assert.deepEqual(board.slice(-2), ['--resume', 't']);
});

test('a session starts, maps its events to trace records, and resumes on the next turn', async () => {
  const h = harness(); const { driver, notes } = h;
  const board = { command: 'node', args: ['proxy.mjs'], env: { FACTORY_BOARD_TOKEN: 'board-credential' } };
  const { thread } = await started(h, { config: { mcp_servers: { factory: { ...board, required: true } } } });
  assert.deepEqual(thread.status, { type: 'idle' });
  assert.match(thread.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  const first = h.finished();
  const { turn } = await driver.request('turn/start', { threadId: thread.id, input: text('TOOL please'), effort: 'medium' });
  assert.equal((await driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'active');
  await assert.rejects(driver.request('turn/start', { threadId: thread.id, input: text('again') }), error => error.code === -32600);
  assert.deepEqual(await first, { id: turn.id, status: 'completed' });
  const methods = notes.map(note => note.method);
  assert.deepEqual(methods.slice(0, 3), ['thread/started', 'thread/status/changed', 'turn/started']);
  assert.deepEqual(methods.slice(-3), ['thread/tokenUsage/updated', 'turn/completed', 'thread/status/changed']);
  assert.equal(notes.at(-1).params.status.type, 'idle');
  assert.equal(output(notes, 'reasoning')[0].text, 'choosing');
  assert.deepEqual(output(notes, 'toolCall')[0], { type: 'toolCall', id: 'toolu_1', tool: 'Bash', arguments: { command: 'true' } });
  assert.deepEqual(output(notes, 'toolResult')[0], { type: 'toolResult', id: 'toolu_1', isError: false, content: 'ok' });
  assert.equal(output(notes, 'agentMessage')[0].text, 'reply to: TOOL please');
  assert.deepEqual(notes.find(note => note.method === 'thread/tokenUsage/updated').params.tokenUsage.last, { inputTokens: 100, cachedInputTokens: 90, outputTokens: 5 });
  const read = await driver.request('thread/read', { threadId: thread.id, includeTurns: true });
  assert.deepEqual(read.thread, { id: thread.id, status: { type: 'idle' }, turns: [{ id: turn.id, status: 'completed' }] });

  const second = h.finished();
  await driver.request('turn/start', { threadId: thread.id, input: text('next') });
  assert.equal((await second).status, 'completed');
  const [one, two] = h.invocations();
  assert.equal(one.args[one.args.indexOf('--session-id') + 1], thread.id);
  assert.equal(two.args[two.args.indexOf('--resume') + 1], thread.id);
  assert.equal(two.args.includes('--session-id'), false);
  assert.equal(one.args[one.args.indexOf('--append-system-prompt') + 1], 'Be useful.');
  assert.equal(one.args[one.args.indexOf('--model') + 1], 'served-model');
  assert.equal(one.args[one.args.indexOf('--effort') + 1], 'medium');
  assert.equal(one.args.includes('board-credential'), false, 'the board credential stays out of arguments');
  const mcpFile = one.args[one.args.indexOf('--mcp-config') + 1];
  assert.deepEqual(JSON.parse(readFileSync(mcpFile, 'utf8')), { mcpServers: { factory: board } });
  if (process.platform !== 'win32') assert.equal(statSync(mcpFile).mode & 0o777, 0o600);
  driver.close();
});

test('a restarted machine resumes a session, and only lost history is reported as unavailable', async () => {
  const root = fresh(); const first = harness({ root });
  const { thread } = await started(first);
  const done = first.finished();
  await first.driver.request('turn/start', { threadId: thread.id, input: text('work') });
  await done;
  const later = harness({ root });
  const { thread: resumed } = await later.driver.request('thread/resume', { threadId: thread.id, cwd: root, sandbox: 'danger-full-access', model: 'served-model', developerInstructions: 'Be useful.' });
  assert.equal(resumed.id, thread.id);
  assert.equal(later.notes[0].method, 'thread/resumed');
  const next = later.finished();
  await later.driver.request('turn/start', { threadId: thread.id, input: text('more') });
  assert.equal((await next).status, 'completed');
  const invocation = later.invocations().at(-1);
  assert.equal(invocation.args[invocation.args.indexOf('--resume') + 1], thread.id);
  assert.equal(invocation.args[invocation.args.indexOf('--append-system-prompt') + 1], 'Be useful.');

  // The runtime recognizes exactly this error and starts a replacement session.
  const unknown = '01a13923-1da9-76a1-0a6e-af0c060ec3a4';
  await assert.rejects(later.driver.request('thread/resume', { threadId: unknown, cwd: root }),
    error => error.code === -32600 && error.message === `no rollout found for thread id ${unknown}`);
  const idle = await started(later);
  const { thread: stillIdle } = await harness({ root }).driver.request('thread/resume', { threadId: idle.thread.id, cwd: root, sandbox: 'danger-full-access' });
  assert.equal(stillIdle.status.type, 'idle', 'a session that never ran a turn has nothing to lose');
  writeFileSync(join(root, 'state', `${unknown}.claude.json`), JSON.stringify({ threadId: unknown, lastTurn: { id: 'gone', status: 'completed' } }));
  await assert.rejects(later.driver.request('thread/resume', { threadId: unknown, cwd: root }), /no rollout found/);
  const interrupted = '01a13924-1da9-76a1-0a6e-af0c060ec3a4';
  writeFileSync(join(root, 'state', `${interrupted}.claude.json`), JSON.stringify({ threadId: interrupted, lastTurn: { id: 'crashed', status: 'inProgress' } }));
  await assert.rejects(later.driver.request('thread/resume', { threadId: interrupted, cwd: root }), /no rollout found/);
});

test('a turn left running by a lost machine reads back as interrupted', async () => {
  const root = fresh(); const first = harness({ root });
  const { thread } = await started(first);
  const done = first.finished();
  await first.driver.request('turn/start', { threadId: thread.id, input: text('work') });
  await done;
  const file = join(root, 'state', `${thread.id}.claude.json`);
  writeFileSync(file, JSON.stringify({ threadId: thread.id, lastTurn: { id: 'crashed', status: 'inProgress' } }));
  const later = harness({ root });
  await later.driver.request('thread/resume', { threadId: thread.id, cwd: root, sandbox: 'danger-full-access' });
  const read = await later.driver.request('thread/read', { threadId: thread.id, includeTurns: true });
  assert.deepEqual(read.thread.turns, [{ id: 'crashed', status: 'interrupted' }]);
});

test('an operator message steers a running turn, which ends only once', async () => {
  const h = harness(); const { driver, notes } = h;
  const { thread } = await started(h);
  await assert.rejects(driver.request('turn/steer', { threadId: thread.id, input: text('early') }), /no active turn to steer/);
  const done = h.finished();
  const { turn } = await driver.request('turn/start', { threadId: thread.id, input: text('LONG job') });
  await assert.rejects(driver.request('turn/steer', { threadId: thread.id, expectedTurnId: '01a13923-1da9-76a1-0a6e-af0c060ec3a4', input: text('wrong') }), error => error.code === -32600);
  assert.deepEqual(await driver.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, input: text('change course') }), { turnId: turn.id });
  assert.deepEqual(await done, { id: turn.id, status: 'completed' });
  assert.equal(output(notes, 'agentMessage')[0].text, 'steered by: change course');
  assert.equal(notes.filter(note => note.method === 'turn/completed').length, 1);
  await assert.rejects(driver.request('turn/steer', { threadId: thread.id, input: text('late') }), /no active turn to steer/);
});

test('a turn stays open while a queued message has not run yet', async () => {
  const h = harness(); const { driver, notes } = h;
  const { thread } = await started(h);
  const done = h.finished();
  const { turn } = await driver.request('turn/start', { threadId: thread.id, input: text('QUEUE BRIEF job') });
  await driver.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, input: text('and then this') });
  assert.deepEqual(await done, { id: turn.id, status: 'completed' });
  assert.equal(output(notes, 'agentMessage').at(-1).text, 'reply to: and then this');
  assert.equal(notes.filter(note => note.method === 'thread/tokenUsage/updated').length, 2);
  assert.equal(notes.filter(note => note.method === 'turn/completed').length, 1);
});

test('a queued message that never comes back cannot hold the turn open', async () => {
  const h = harness({ steerGraceMs: 100 }); const { driver, notes } = h;
  const { thread } = await started(h);
  const done = h.finished();
  const { turn } = await driver.request('turn/start', { threadId: thread.id, input: text('DROP BRIEF job') });
  await driver.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, input: text('lost') });
  assert.deepEqual(await done, { id: turn.id, status: 'completed' });
  assert.equal(notes.filter(note => note.method === 'turn/completed').length, 1);
});

test('a worker whose board did not connect ends its turn as failed', async () => {
  const errors = []; const h = harness({ args: ['--fake-board-failed'], onStderr: value => errors.push(value) });
  const { thread } = await started(h, { config: { mcp_servers: { factory: { command: 'node', args: [], env: {} } } } });
  const done = h.finished();
  await h.driver.request('turn/start', { threadId: thread.id, input: text('LONG job') });
  assert.equal((await done).status, 'failed');
  assert.match(errors.join(' '), /board MCP server did not connect/);
});

function stopper(h, threadId, destination) {
  const turns = new Map(), terminalTurns = new Map(), records = [];
  const stop = new NativeOperatorStop({ rpc: h.driver, threadId, getTurn: () => nativeStopTurn(turns, terminalTurns, threadId),
    trace: (kind, body) => { records.push({ kind, body }); destination?.record(kind, body); }, flush: async () => destination?.flush(), timeoutMs: 5000 });
  h.driver.on('notification', ({ method, params }) => {
    if (method === 'turn/started') { terminalTurns.delete(threadId); turns.set(threadId, params.turn.id); stop.observeTurnStarted({ threadId, turnId: params.turn.id }); }
    if (method === 'turn/completed') { terminalTurns.set(threadId, { id: params.turn.id, status: params.turn.status }); stop.observeTerminal({ threadId, turnId: params.turn.id, status: params.turn.status }); }
  });
  return { stop, records };
}

test('an operator stop interrupts the running turn and proves the session idle', async () => {
  const h = harness(); const { driver } = h;
  const { thread } = await started(h);
  const { stop, records } = stopper(h, thread.id);
  const { turn } = await driver.request('turn/start', { threadId: thread.id, input: text('LONG job') });
  const receipt = await stop.stop('stop-1', { expectedThreadId: thread.id, expectedTurnId: turn.id });
  assert.deepEqual(receipt, { commandId: 'stop-1', expectedThreadId: thread.id, expectedTurnId: turn.id, threadId: thread.id, threadStatus: 'idle', turn: { id: turn.id, status: 'interrupted' } });
  assert.deepEqual(records.map(record => record.kind), ['thread/status/changed', 'native.operator.stop.completed']);
  assert.equal((await driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'idle');
  // Stopping an idle session is a readback, and a new turn then continues the same session.
  assert.equal((await stop.stop('stop-2', { expectedThreadId: thread.id, expectedTurnId: turn.id })).threadStatus, 'idle');
  const again = h.finished();
  await driver.request('turn/start', { threadId: thread.id, input: text('continue') });
  assert.equal((await again).status, 'completed');
});

test('an unanswered interrupt ends the process, and stop wins over a queued message', async () => {
  const deaf = harness({ interruptGraceMs: 100, killGraceMs: 2000 });
  const { thread } = await started(deaf);
  const { stop } = stopper(deaf, thread.id);
  const { turn } = await deaf.driver.request('turn/start', { threadId: thread.id, input: text('DEAF job') });
  const receipt = await stop.stop('stop-deaf', { expectedThreadId: thread.id, expectedTurnId: turn.id });
  assert.equal(receipt.turn.status, 'interrupted');
  assert.equal(receipt.threadStatus, 'idle');

  const queued = harness();
  const second = await started(queued);
  const done = queued.finished();
  const running = await queued.driver.request('turn/start', { threadId: second.thread.id, input: text('QUEUE LONG job') });
  await queued.driver.request('turn/steer', { threadId: second.thread.id, input: text('queued work') });
  await queued.driver.request('turn/interrupt', { threadId: second.thread.id, turnId: running.turn.id });
  await assert.rejects(queued.driver.request('turn/steer', { threadId: second.thread.id, input: text('too late') }), /no active turn to steer/);
  assert.equal((await done).status, 'interrupted');
  assert.deepEqual(output(queued.notes, 'agentMessage'), [], 'the queued message did not run');
  assert.deepEqual(await queued.driver.request('turn/interrupt', { threadId: second.thread.id, turnId: running.turn.id }), {}, 'interrupting a finished turn is harmless');
  await assert.rejects(queued.driver.request('turn/interrupt', { threadId: second.thread.id, turnId: 'other' }), error => error.code === -32600);
});

test('a crash, a refused key and a wrong session end the turn as failed without blocking the next one', async () => {
  const h = harness(); const { driver } = h;
  const { thread } = await started(h);
  const crashed = h.finished();
  await driver.request('turn/start', { threadId: thread.id, input: text('CRASH') });
  assert.equal((await crashed).status, 'failed');
  const auth = []; driver.on('authFailed', value => auth.push(value));
  const refused = h.finished();
  await driver.request('turn/start', { threadId: thread.id, input: text('REFUSED') });
  assert.deepEqual((await refused).error, { code: 401 });
  assert.deepEqual(auth, [{ threadId: thread.id }]);
  const ok = h.finished();
  await driver.request('turn/start', { threadId: thread.id, input: text('fine') });
  assert.equal((await ok).status, 'completed');

  const other = harness({ args: ['--fake-other'] });
  const { thread: otherThread } = await started(other);
  const ended = other.finished();
  await other.driver.request('turn/start', { threadId: otherThread.id, input: text('LONG') });
  assert.equal((await ended).status, 'failed');

  const missing = new ClaudeSessionDriver({ command: join(h.root, 'not-installed'), configDirectory: join(h.root, 'c2'), stateDirectory: join(h.root, 's2'), environment: () => process.env });
  const { thread: lonely } = await missing.request('thread/start', { cwd: h.root });
  const gone = new Promise(resolve => missing.on('notification', note => { if (note.method === 'turn/completed') resolve(note.params.turn.status); }));
  await missing.request('turn/start', { threadId: lonely.id, input: text('hello') });
  assert.equal(await gone, 'failed');
  assert.equal((await missing.request('thread/read', { threadId: lonely.id })).thread.status.type, 'idle');
});

test('a durable workflow wake delivers a turn and reads it back after an unknown outcome', async () => {
  const h = harness(); const { driver } = h;
  const { thread } = await started(h);
  const done = h.finished();
  const wake = new NativeWorkflowWake({ rpc: driver, threadId: thread.id, file: join(h.root, 'wake.json'), effort: 'medium' });
  const delivered = await wake.wake({ trigger: 'first', input: 'start', initial: true });
  assert.equal(delivered.status, 'delivered');
  const turn = await done;
  assert.equal(delivered.turnId, turn.id);
  assert.deepEqual(await wake.read(), { status: 'idle', turnId: turn.id });
});

test('a real stop command reaches the board as a verified receipt', async () => {
  const p = plan({ agentsPerMachine: 1 }); const agent = agentInventory(p)[0];
  const credentials = { [agent.id]: secret() }; const operatorToken = secret(); const root = fresh();
  const coordinator = await startCloudLiteCoordinator({ database: join(root, 'board.sqlite'), plan: p, credentials, operatorToken, auth: {}, host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const post = async (path, body, token = operatorToken) => {
    const response = await fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  const h = harness({ root }); const { driver } = h;
  try {
    const { thread } = await started(h);
    await post('/operator/session', { agent: agent.id, session: thread.id });
    const trace = new CloudLiteTrace({ file: join(root, 'trace.jsonl'), url, token: credentials[agent.id] });
    const { stop } = stopper(h, thread.id, trace);
    driver.on('notification', ({ method, params }) => {
      if (method === 'turn/started') trace.record('native.turn.started', { threadId: thread.id, turn: params.turn });
      if (method === 'turn/completed') trace.record('native.turn.completed', { threadId: thread.id, turn: params.turn });
      if (method === 'item/completed') trace.record(method, params);
    });
    trace.record('native.thread.started', { threadId: thread.id, threadStatus: 'idle' });
    const { turn } = await driver.request('turn/start', { threadId: thread.id, input: text('LONG job') });
    await trace.flush();
    await waitFor(() => h.invocations().length === 1);
    await post('/operator/command', { id: 'stop-board', recipient: agent.id, action: 'stop', expectedThreadId: thread.id, expectedTurnId: turn.id });
    const { commands } = await post('/commands', {}, credentials[agent.id]);
    const command = commands.find(value => value.id === 'stop-board');
    await stop.stop(command.id, { expectedThreadId: command.expectedThreadId, expectedTurnId: command.expectedTurnId });
    const ack = await post('/commands', { acknowledge: command.id }, credentials[agent.id]);
    assert.equal(ack.acknowledged, true);
    const native = coordinator.board.snapshot().agents.find(value => value.id === agent.id).nativeRuntime;
    assert.equal(native.threadStatus, 'idle');
    assert.equal(native.turnStatus, 'interrupted');
    assert.equal(native.operatorStopReceipt.commandId, 'stop-board');
    assert.equal(native.operatorStopReceipt.threadId, thread.id);
    assert.equal(native.operatorStopReceipt.turnId, turn.id);
  } finally { driver.close(); await coordinator.close(); }
});

test('bootstrap installs only the selected program, pinned by checksum', () => {
  const digest = 'a'.repeat(64);
  const codex = cloudLiteBootstrap(digest);
  assert.equal(codex, cloudLiteBootstrap(digest, { workerProgram: 'codex' }));
  assert.match(codex, /rust-v0\.162\.1/);
  assert.match(codex, /CODEX_HOME=\/data\/codex/);
  assert.doesNotMatch(codex, /claude/i);
  const claude = cloudLiteBootstrap(digest, { workerProgram: 'claude' });
  assert.match(claude, /claude-code-releases\/\d+\.\d+\.\d+\/linux-x64\/claude/);
  assert.match(claude, /^echo '[a-f0-9]{64} {2}\/tmp\/claude' \| sha256sum -c -$/m);
  assert.match(claude, /bubblewrap socat/);
  assert.match(claude, /CLAUDE_CONFIG_DIR=\/data\/claude/);
  assert.doesNotMatch(claude, /codex/i);
  assert.ok(claude.indexOf('sha256sum -c -\ninstall') > 0, 'the checksum is checked before install');
  assert.throws(() => cloudLiteBootstrap(digest, { workerProgram: 'other' }), /Unknown worker program/);
});

test('the subscription broker holds one token and fleets refuse the wrong broker', async () => {
  assert.throws(() => new ClaudeSubscriptionBroker({ tokenFile: 'relative' }), /absolute/);
  const root = fresh(); const tokenFile = join(root, 'token'); const token = 'sk-ant-oat01-' + 'x'.repeat(40);
  const broker = new ClaudeSubscriptionBroker({ tokenFile });
  writeFileSync(tokenFile, `${token}\n`);
  assert.deepEqual(broker.read(), { accessToken: token });
  writeFileSync(tokenFile, `${token}-rotated`);
  assert.deepEqual(await broker.refresh(), { accessToken: `${token}-rotated` });
  writeFileSync(tokenFile, 'sk-ant-api03-' + 'x'.repeat(40));
  assert.throws(() => broker.read(), /API-key fallback is disabled/);
  writeFileSync(tokenFile, 'short');
  assert.throws(() => broker.read(), /one token/);
  const image = 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64);
  const codexBroker = new FactoryCloudLiteFleet({ directory: fresh(), auth: new CodexSubscriptionBroker({ authFile: join(root, 'auth.json') }), infrastructure: {} });
  await assert.rejects(codexBroker.deploy(plan({ modelProvider: undefined }), { image }), /codex subscription broker cannot serve claude workers/);
  const claudeBroker = new FactoryCloudLiteFleet({ directory: fresh(), auth: broker, infrastructure: {} });
  await assert.rejects(claudeBroker.deploy({ runId: 'codex-test', app: 'factory-codex-test', goal: 'x' }, { image }), /claude subscription broker cannot serve codex workers/);
});

test('a Claude fleet stages the token only as a secret and keeps it out of the journal', async () => {
  const root = fresh(); const tokenFile = join(root, 'token'); const token = 'sk-ant-oat01-' + 'y'.repeat(40);
  writeFileSync(tokenFile, token);
  const calls = []; const machines = [];
  const infrastructure = {
    run: async (args, options = {}) => { calls.push({ args, input: options.input }); if (args[0] === 'volumes') return JSON.stringify({ id: 'vol_1' }); if (args[0] === 'machine') return JSON.stringify(machines); return ''; },
    buildMachineConfig: () => ({ init: { cmd: ['upstream'] }, services: [] }),
    createMachine: async ({ name, config }) => { const machine = { id: `machine-${machines.length}`, name, config }; machines.push(machine); return machine; },
  };
  const bundlePath = join(root, 'bundle.tgz'); writeFileSync(bundlePath, 'bundle');
  const fleet = new FactoryCloudLiteFleet({ directory: join(root, 'fleet'), auth: new ClaudeSubscriptionBroker({ tokenFile }), infrastructure });
  const image = 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64);
  const result = await fleet.deploy(plan({ modelProvider: undefined, machines: 1 }), { image, bundlePath });
  assert.equal(result.machines.length, 1);
  const staged = calls.find(call => call.args[0] === 'secrets');
  const config = JSON.parse(Buffer.from(staged.input.trim().split('=').slice(1).join('='), 'base64').toString());
  assert.deepEqual(config.initialAuth, { accessToken: token });
  assert.equal(config.plan.workerProgram, 'claude');
  assert.equal(readFileSync(join(root, 'fleet', 'fleet.json'), 'utf8').includes(token), false);
  assert.match(readFileSync(join(root, 'fleet', 'bootstrap.sh'), 'utf8'), /claude-code-releases/);
  assert.equal(machines[0].config.metadata['factory.runtime'], 'claude-lite');
});
