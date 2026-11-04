import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCloudLitePlan, agentInventory, machineConfig, secret } from '../src/cloud-lite/protocol.mjs';
import { cloudLiteBootstrap } from '../src/cloud-lite/bootstrap.mjs';
import { FlujoProgram, FlujoSessionDriver, FLUJO_WORKER_SERVERS, flujoEnvironment } from '../src/cloud-lite/flujo-driver.mjs';
import { packFactorySdk } from '../src/cloud-lite/bundle.mjs';
import { FactoryCloudLiteFleet } from '../src/cloud-lite/fleet.mjs';
import { NativeOperatorStop } from '../src/cloud-lite/operator-stop.mjs';
import { NativeWorkflowWake } from '../src/cloud-lite/workflow-wake.mjs';
import { CloudLiteTrace } from '../src/cloud-lite/trace.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';
import { nativeStopTurn } from '../src/cloud-lite/runtime.mjs';
import { FactoryArtifactStore } from '../src/workflows/artifacts.mjs';
import { captureWorkspace, readWorkspaceManifest } from '../src/workflows/workspace.mjs';
import { flujoProviderModel, liteWorkerCommand, programApi, startLiteWorker } from '../src/public-sdk.mjs';
import { FakeFlujo } from './fixtures/fake-flujo.mjs';
import { tempDir } from './support/temp-dir.mjs';

const fresh = () => tempDir('factory-cloud-lite-flujo-');
const fakeProgram = fileURLToPath(new URL('./fixtures/fake-flujo.mjs', import.meta.url));
const key = 'provider-key-value-1234';
const provider = (extra = {}) => ({ id: 'selfhosted', envKey: 'SELF_HOSTED_MODEL_KEY', model: 'served-model', name: 'Served', apis: ['responses', 'chat', 'anthropic'],
  baseUrls: ['https://model-a.example.test/v1', 'https://model-b.example.test/v1'], contextWindow: 262144, autoCompactTokenLimit: 80000, ...extra });
const plan = (extra = {}) => validateCloudLitePlan({ runId: 'flujo-test', app: 'factory-flujo-test', goal: 'Work on operator jobs', machines: 1, agentsPerMachine: 2,
  workerProgram: 'flujo', modelProvider: provider(), ...extra });
const text = value => [{ type: 'text', text: value }];
const board = { command: process.execPath, args: ['board-proxy.mjs'], env: { FACTORY_BOARD_URL: 'http://board.invalid', FACTORY_BOARD_TOKEN: 'board-credential-value', FACTORY_WORKTREE: '/work/a0' } };
const waitFor = async (condition, ms = 5000) => { const end = Date.now() + ms; for (;;) { const value = await condition(); if (value) return value; if (Date.now() > end) throw new Error('Condition was not reached.'); await new Promise(resolve => setTimeout(resolve, 10)); } };

async function harness({ script, root = fresh(), team, servers, fake: existing, ...options } = {}) {
  const fake = existing ?? await new FakeFlujo({ script }).listen();
  const driver = new FlujoSessionDriver({ origin: fake.origin, stateDirectory: join(root, 'state'), privateDirectory: join(root, 'private'), team, servers,
    modelRecord: name => flujoProviderModel(provider(), { key, model: name }), pollMs: 20, reconnectMs: 10, submitTimeoutMs: 400, interruptResendMs: 30, drainMs: 200, ...options });
  const notes = [];
  driver.on('notification', note => notes.push(note));
  const finished = () => new Promise(resolve => { const check = note => { if (note.method === 'turn/completed') { driver.off('notification', check); resolve(note.params.turn); } }; driver.on('notification', check); });
  return { root, fake, driver, notes, finished, end: async () => { driver.close(); await fake.close(); } };
}
const started = (h, extra = {}) => { mkdirSync(join(h.root, 'work'), { recursive: true }); return h.driver.request('thread/start', { model: 'served-model', cwd: join(h.root, 'work'), sandbox: 'danger-full-access', developerInstructions: 'Be useful.', ...extra }); };
const items = (notes, type) => notes.filter(note => note.method === 'item/completed' && note.params.item.type === type).map(note => note.params.item);

test('a plan can choose FLUJO, and refuses what FLUJO cannot do', () => {
  assert.equal(plan().workerProgram, 'flujo');
  assert.equal(plan().modelProvider.model, 'served-model');
  assert.equal('model' in plan(), false, 'a FLUJO plan names no vendor model');
  assert.throws(() => plan({ modelProvider: undefined }), /need a modelProvider/);
  assert.throws(() => plan({ modelProvider: provider({ model: undefined }) }), /served model/);
  assert.equal(plan({ modelProvider: provider({ model: undefined }), model: 'named' }).subagentModel, 'named', 'every agent has a model');
  assert.throws(() => plan({ sandbox: 'read-only' }), /danger-full-access/);
  assert.throws(() => plan({ sandbox: 'workspace-write' }), /danger-full-access/);
  assert.equal(plan({ sandbox: 'danger-full-access' }).sandbox, 'danger-full-access');
  assert.throws(() => validateCloudLitePlan({ runId: 'codex-test', app: 'factory-codex-test', goal: 'x', flujo: {} }), /belong to FLUJO/);
  assert.throws(() => plan({ flujo: { teamConcurrency: 10 } }), /teamConcurrency/);
  assert.throws(() => plan({ flujo: { servers: ['flujo'] } }), /flujo\.servers/);
  assert.throws(() => plan({ flujo: { agentTurns: 0 } }), /agentTurns/);
  assert.equal(plan({ flujo: { teamConcurrency: 4, servers: ['bash'] } }).flujo.teamConcurrency, 4);
  assert.equal(machineConfig(plan(), { image: 'i', volumeId: 'v', index: 0, environment: {} }).metadata['factory.runtime'], 'flujo-lite');
  assert.equal(machineConfig(plan({ workerProgram: 'claude', model: 'm', sandbox: undefined }), { image: 'i', volumeId: 'v', index: 0, environment: {} }).metadata['factory.runtime'], 'claude-lite');
  assert.equal(machineConfig(validateCloudLitePlan({ runId: 'codex-test', app: 'factory-codex-test', goal: 'x' }), { image: 'i', volumeId: 'v', index: 0, environment: {} }).metadata['factory.runtime'], 'codex-lite');
});

test('the FLUJO mapping prefers Responses and stores the key in a model record', () => {
  const responses = flujoProviderModel(provider(), { index: 1, key });
  assert.deepEqual([responses.id, responses.name, responses.provider, responses.adapter, responses.baseUrl, responses.ApiKey, responses.contextWindow, responses.compactionThreshold, responses.supportsTools],
    ['factory-selfhosted', 'served-model', 'openai', 'openai-responses', 'https://model-b.example.test/v1', key, 262144, 80000, true]);
  const chat = flujoProviderModel(provider({ apis: ['chat'] }), { key });
  assert.deepEqual([chat.adapter, chat.baseUrl], ['openai', 'https://model-a.example.test/v1']);
  const anthropic = flujoProviderModel(provider({ apis: ['anthropic'] }), { key });
  assert.deepEqual([anthropic.provider, anthropic.adapter, anthropic.baseUrl], ['anthropic', 'anthropic', 'https://model-a.example.test']);
  assert.equal(programApi(provider({ apis: ['chat', 'responses'] }), 'flujo'), 'responses', 'the order is the program\'s, not the provider\'s');
  assert.throws(() => flujoProviderModel(provider(), { key: 'short' }), /API key/);
  assert.throws(() => flujoProviderModel(provider({ model: undefined }), { key }), /served model/);
  assert.equal(flujoProviderModel(provider({ model: undefined }), { key, model: 'from-plan' }).name, 'from-plan');
});

test('the FLUJO process environment carries no key, and the bootstrap pins the program by checksum', () => {
  const env = flujoEnvironment({ home: '/data/flujo', path: '/bin' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/data', FLUJO_DATA_DIR: '/data/flujo', FLUJO_PORT: '4210', FLUJO_EXPOSURE_MODE: 'localhost', NEXT_TELEMETRY_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' });
  const script = cloudLiteBootstrap('a'.repeat(64), { workerProgram: 'flujo' });
  assert.match(script, /flujo-ai-\d+\.\d+\.\d+\.tgz -o \/tmp\/flujo\.tgz/);
  assert.match(script, /^echo '[a-f0-9]{64} {2}\/tmp\/flujo\.tgz' \| sha256sum -c -$/m);
  assert.ok(script.indexOf('sha256sum -c -\nnpm install --prefix /data/flujo-program') > 0, 'the checksum is checked before install');
  assert.match(script, /--ignore-scripts/);
  assert.match(script, /command -v flujo/, 'an image with FLUJO skips the install');
  assert.match(script, /FLUJO_DATA_DIR=\/data\/flujo/);
  assert.doesNotMatch(script, /codex|claude/i);
  assert.doesNotMatch(cloudLiteBootstrap('a'.repeat(64)), /flujo-ai/);
});

test('a thread gets its own workspace with only its tools, and no secret in FLUJO settings', async () => {
  const h = await harness();
  try {
    const { thread } = await started(h, { config: { mcp_servers: { factory: board }, 'sandbox_workspace_write.writable_roots': ['/extra'] } });
    assert.match(thread.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.equal(thread.status.type, 'idle');
    const space = h.fake.workspaces.get(`factory-${thread.id}`);
    assert.deepEqual(space.roots, [join(h.root, 'work'), '/extra']);
    assert.equal(space.models[0].ApiKey, key);
    assert.equal(space.servers.find(server => server.name === 'flujo').disabled, true, 'the control server stays off');
    assert.deepEqual(space.servers.filter(server => !server.disabled).map(server => server.name), [...FLUJO_WORKER_SERVERS, 'factory']);
    const server = space.servers.find(entry => entry.name === 'factory');
    assert.equal(JSON.stringify(server).includes('board-credential-value'), false);
    assert.deepEqual(server.env, { FACTORY_WORKTREE: '/work/a0' });
    const config = server.args[server.args.indexOf('--config') + 1];
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { url: 'http://board.invalid', token: 'board-credential-value' });
    if (process.platform !== 'win32') assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.deepEqual(space.flows.map(flow => flow.name), ['swarm_agent']);
    const agent = space.flows[0].spec.nodes.find(node => node.key === 'agent');
    assert.deepEqual(agent.servers.map(entry => entry.name), [...FLUJO_WORKER_SERVERS, 'factory']);
    assert.match(space.flows[0].spec.nodes[0].prompt, /Your working folder is .*Pass it as cwd/s);
    assert.match(space.flows[0].spec.nodes[0].prompt, /Be useful\./);
    assert.equal(h.notes.some(note => note.method === 'thread/started' && note.params.threadId === thread.id), true);
  } finally { await h.end(); }
});

test('an orchestrator leads a team when the plan asks for one', async () => {
  const h = await harness({ team: { concurrency: 4, agentTurns: 6, leadTurns: 12 } });
  try {
    const lead = (await started(h, { agentRole: 'orchestrator' })).thread;
    const member = (await started(h, { agentRole: 'subagent' })).thread;
    const space = h.fake.workspaces.get(`factory-${lead.id}`);
    assert.deepEqual(space.flows.map(flow => flow.name), ['swarm_agent', 'swarm_team']);
    assert.equal(space.flows[1].spec.nodes.find(node => node.key === 'agents').concurrencyLimit, 4);
    assert.equal(space.flows[1].spec.nodes.find(node => node.key === 'lead').maxTurns, 12);
    await h.driver.request('turn/start', { threadId: lead.id, input: text('lead') });
    await h.driver.request('turn/start', { threadId: member.id, input: text('member') });
    await waitFor(() => h.fake.count('POST', '/v1/chat/completions') === 2);
    const flows = h.fake.requests.filter(entry => entry.path === '/v1/chat/completions').map(entry => entry.body.model);
    assert.deepEqual(flows, ['flow-swarm_team', 'flow-swarm_agent']);
  } finally { await h.end(); }
});

test('the board must connect before a thread starts', async () => {
  const h = await harness({ toolsTimeoutMs: 50 });
  h.fake.boardFails = true;
  try { await assert.rejects(started(h, { config: { mcp_servers: { factory: board } } }), /factory server did not connect/); }
  finally { await h.end(); }
});

test('a turn maps FLUJO events to the shared trace and ends only when FLUJO says so', async () => {
  const h = await harness({ script: run => { run.say('working'); run.tool('bash_run'); run.usage(); run.emit({ type: 'recovery:retry', attempt: 2, retryAt: 5, failure: { category: 'rate_limit' } }); run.emit({ type: 'model:delta', delta: 'skipped' }); run.say('done'); run.done(); } });
  try {
    const { thread } = await started(h);
    const ended = h.finished();
    let readAtEnd;
    h.driver.on('notification', note => { if (note.method === 'turn/completed') readAtEnd ??= h.driver.request('thread/read', { threadId: thread.id }); });
    const { turn } = await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    assert.equal(turn.status, 'inProgress');
    assert.equal((await h.driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'active');
    const final = await ended;
    assert.deepEqual(final, { id: turn.id, status: 'completed' });
    assert.equal((await readAtEnd).thread.status.type, 'idle', 'idle is already readable when the turn ends');
    assert.deepEqual(items(h.notes, 'agentMessage').map(item => item.text), ['working', 'done']);
    assert.equal(items(h.notes, 'toolCall')[0].tool, 'bash_run');
    assert.equal(items(h.notes, 'toolResult')[0].isError, false);
    const usage = h.notes.find(note => note.method === 'thread/tokenUsage/updated').params.tokenUsage;
    assert.deepEqual(usage.last, { inputTokens: 40, cachedInputTokens: 10, outputTokens: 4 });
    assert.equal(h.notes.find(note => note.method === 'model/retry').params.error, 'rate_limit');
    assert.equal(h.notes.some(note => note.method === 'item/stream/delta'), false, 'streaming stays off unless asked for');
    const methods = h.notes.map(note => note.method);
    assert.ok(methods.indexOf('turn/started') < methods.indexOf('turn/completed'));
    assert.equal(methods.at(-1), 'thread/status/changed');
    // The next turn continues the same conversation and is not confused by the previous run's end.
    const next = h.finished();
    const second = await h.driver.request('turn/start', { threadId: thread.id, input: text('again') });
    assert.equal((await next).id, second.turn.id);
    assert.equal(h.fake.conversationOf(thread.id).messages.filter(message => message.role === 'user').length, 2);
  } finally { await h.end(); }
});

test('a capped run counts as completed, and a failed run keeps its provider status', async () => {
  let mode = 'capped';
  const h = await harness({ script: run => { if (mode === 'capped') run.capped(); else run.fail(429); } });
  try {
    const { thread } = await started(h);
    let ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('one') });
    assert.equal((await ended).status, 'completed');
    mode = 'fail'; ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('two') });
    const failed = await ended;
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.error, { code: 429 });
  } finally { await h.end(); }
});

test('a lost stream cannot leave a turn open: the state is read on a timer', async () => {
  const h = await harness({ script: run => { run.say('quiet'); run.endSilently('completed'); }, drainMs: 60 });
  try {
    const { thread } = await started(h);
    const ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    assert.equal((await ended).status, 'completed');
  } finally { await h.end(); }
});

test('a dropped stream is followed again from where it stopped, without repeating events or the task', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ script: async run => { run.say('before'); await gate; run.say('after'); run.done(); } });
  try {
    const { thread } = await started(h);
    const ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    await waitFor(() => items(h.notes, 'agentMessage').length === 1);
    for (const stream of h.fake.streams) stream.destroy();
    await waitFor(() => h.fake.count('GET', `/v1/chat/conversations/${thread.id}/events`) >= 2);
    release();
    assert.equal((await ended).status, 'completed');
    assert.deepEqual(items(h.notes, 'agentMessage').map(item => item.text), ['before', 'after']);
    assert.equal(h.fake.count('POST', '/v1/chat/completions'), 1);
  } finally { await h.end(); }
});

test('an uncertain submission is read back, never sent twice', async () => {
  const h = await harness();
  h.fake.dropAfterAccept = 1;
  try {
    const { thread } = await started(h);
    const ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    assert.equal((await ended).status, 'completed');
    assert.equal(h.fake.count('POST', '/v1/chat/completions'), 1);
  } finally { await h.end(); }
});

test('a run that never starts ends the turn as unfinished, without sending it again', async () => {
  const h = await harness({ script: () => {}, submitTimeoutMs: 60 });
  try {
    const { thread } = await started(h);
    const conversationStart = h.fake.complete.bind(h.fake);
    // FLUJO answers, but no run appears: its conversation stays as it was.
    h.fake.complete = (space, body, response) => { response.writeHead(200); response.write('data: {}\n\n'); return undefined; };
    const ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    assert.equal((await ended).status, 'failed');
    assert.equal((await h.driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'idle');
    h.fake.complete = conversationStart;
    assert.equal(h.fake.count('POST', '/v1/chat/completions'), 1, 'it was sent once');
  } finally { await h.end(); }
});

test('under pressure a turn waits and retries; a refusal ends it', async () => {
  const h = await harness({ submitTimeoutMs: 5000 });
  try {
    const { thread } = await started(h);
    h.fake.refuse = [503];
    let ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('busy') });
    assert.equal((await ended).status, 'completed');
    h.fake.refuse = [400];
    ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('bad') });
    assert.equal((await ended).status, 'failed');
    assert.equal((await h.driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'idle');
  } finally { await h.end(); }
});

test('a message during a turn joins it; with nothing running the refusal has the exact text', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ script: async run => { await gate; for (const message of run.conversation.steered) { run.conversation.messages.push(message); run.emit({ type: 'message', message }); } run.say('done'); run.done(); } });
  try {
    const { thread } = await started(h);
    await assert.rejects(h.driver.request('turn/steer', { threadId: thread.id, input: text('nothing runs') }), { message: 'no active turn to steer' });
    const ended = h.finished();
    const { turn } = await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    await waitFor(() => h.fake.conversationOf(thread.id)?.status === 'running');
    await assert.rejects(h.driver.request('turn/steer', { threadId: thread.id, expectedTurnId: 'other', input: text('wrong') }), /expected turn/);
    assert.deepEqual(await h.driver.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, input: text('correction') }), { turnId: turn.id });
    release();
    assert.equal((await ended).status, 'completed');
    assert.equal(h.fake.count('POST', '/v1/chat/completions'), 1, 'taken in by the run, so nothing is sent again');
    await assert.rejects(h.driver.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, input: text('late') }), { message: 'no active turn to steer' });
  } finally { await h.end(); }
});

test('a message that arrives as the run ends is still delivered, in the same turn', async () => {
  let release, runs = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ script: async run => { runs++; if (runs === 1) { await gate; run.say('first'); run.done(); return; } run.say('second'); run.done(); } });
  try {
    const { thread } = await started(h);
    const ended = h.finished();
    const { turn } = await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    await waitFor(() => h.fake.conversationOf(thread.id)?.status === 'running');
    await h.driver.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, input: text('owed') });
    release();
    assert.deepEqual(await ended, { id: turn.id, status: 'completed' });
    const posted = h.fake.requests.filter(entry => entry.path === '/v1/chat/completions');
    assert.deepEqual(posted.map(entry => entry.body.messages.at(-1).content), ['go', 'owed']);
    assert.deepEqual(items(h.notes, 'agentMessage').map(item => item.text), ['first', 'second']);
  } finally { await h.end(); }
});

test('a stop interrupts the turn, keeps asking until FLUJO has stopped, and a refused stop can be retried', async () => {
  const h = await harness({ script: () => {} });
  try {
    const { thread } = await started(h);
    const ended = h.finished();
    const { turn } = await h.driver.request('turn/start', { threadId: thread.id, input: text('long') });
    await waitFor(() => h.fake.conversationOf(thread.id)?.status === 'running');
    h.fake.cancelFails = 1;
    await assert.rejects(h.driver.request('turn/interrupt', { threadId: thread.id, turnId: turn.id }), /did not accept the stop/);
    await assert.rejects(h.driver.request('turn/interrupt', { threadId: thread.id, turnId: 'other' }), /expected turn/);
    h.fake.holdCancel = true;
    assert.deepEqual(await h.driver.request('turn/interrupt', { threadId: thread.id, turnId: turn.id }), {});
    await waitFor(() => h.fake.cancels >= 2, 2000);
    assert.equal((await h.driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'active', 'cancel requested is not stopped');
    h.fake.holdCancel = false;
    const conversation = h.fake.conversationOf(thread.id), run = conversation.run;
    run.ended = true; conversation.status = 'error'; conversation.lastError = { code: 'cancelled' }; run.emit({ type: 'run:done', status: 'error' });
    const final = await ended;
    assert.equal(final.status, 'interrupted');
    assert.equal((await h.driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'idle');
    assert.deepEqual(await h.driver.request('turn/interrupt', { threadId: thread.id, turnId: turn.id }), {}, 'a finished turn is already stopped');
    await assert.rejects(h.driver.request('turn/steer', { threadId: thread.id, input: text('late') }), { message: 'no active turn to steer' });
  } finally { await h.end(); }
});

test('a stop wins over a queued message, and a turn stopped before it ran is interrupted', async () => {
  const h = await harness({ script: () => {} });
  try {
    const { thread } = await started(h);
    let ended = h.finished();
    const { turn } = await h.driver.request('turn/start', { threadId: thread.id, input: text('long') });
    await waitFor(() => h.fake.conversationOf(thread.id)?.status === 'running');
    await h.driver.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, input: text('queued') });
    await h.driver.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
    assert.equal((await ended).status, 'interrupted');
    assert.equal(h.fake.count('POST', '/v1/chat/completions'), 1, 'the queued message does not start a new run');
    h.fake.refuse = [503];
    ended = h.finished();
    const second = await h.driver.request('turn/start', { threadId: thread.id, input: text('blocked') });
    assert.deepEqual(await h.driver.request('turn/interrupt', { threadId: thread.id, turnId: second.turn.id }), {});
    assert.equal((await ended).status, 'interrupted');
  } finally { await h.end(); }
});

test('children keep a thread active until they have ended too', async () => {
  let child;
  const h = await harness({ script: run => { child = run.child('running'); run.say('lead is done'); run.done(); } });
  try {
    const { thread } = await started(h);
    const ended = h.finished();
    const { turn } = await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    await waitFor(() => child && h.fake.conversationOf(thread.id).status === 'completed');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(h.notes.some(note => note.method === 'turn/completed'), false, 'the lead has ended but a child still runs');
    assert.equal((await h.driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'active');
    child.status = 'completed';
    assert.equal((await ended).id, turn.id);
    assert.equal((await h.driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'idle');
    // A child that appears later is caught by the readback, so a stop receipt cannot be wrong.
    const late = h.fake.conversationOf(thread.id).run.child('running');
    assert.equal((await h.driver.request('thread/read', { threadId: thread.id })).thread.status.type, 'active');
    late.status = 'error';
  } finally { await h.end(); }
});

test('an unattended worker answers no questions: questions and forms are declined so a run never parks', async () => {
  const h = await harness({ script: run => { run.emit({ type: 'run:awaiting_question', questionId: 'q1', questions: [] }); run.emit({ type: 'run:awaiting_elicitation', elicitationId: 'e1', message: 'form', requestedSchema: {} }); run.done(); } });
  try {
    const { thread } = await started(h);
    const ended = h.finished();
    await h.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    await ended;
    await waitFor(() => h.fake.responses?.length === 2);
    assert.deepEqual(h.fake.responses.map(body => body.action).sort(), ['elicitation-cancel', 'question-decline']);
  } finally { await h.end(); }
});

test('resume keeps the conversation, and lost history gives the error the runtime recovers from', async () => {
  const fake = await new FakeFlujo().listen();
  const root = fresh();
  const first = await harness({ fake, root });
  try {
    const { thread } = await started(first);
    const unavailable = id => ({ code: -32600, message: `no rollout found for thread id ${id}` });
    const missing = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(first.driver.request('thread/resume', { threadId: missing, cwd: root }), unavailable(missing));
    const ended = first.finished();
    const { turn } = await first.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    await ended;
    first.driver.close();

    const second = await harness({ fake, root });
    const flowsBefore = fake.workspaces.get(`factory-${thread.id}`).flows.map(flow => flow.id);
    const resumed = await second.driver.request('thread/resume', { threadId: thread.id, model: 'served-model', cwd: join(root, 'work'), sandbox: 'danger-full-access', developerInstructions: 'Be useful.' });
    assert.equal(resumed.thread.status.type, 'idle');
    assert.equal(resumed.recoveredTurn, undefined);
    assert.deepEqual(fake.workspaces.get(`factory-${thread.id}`).flows.map(flow => flow.id), flowsBefore, 'an unchanged flow keeps its identity');
    assert.deepEqual((await second.driver.request('thread/read', { threadId: thread.id, includeTurns: true })).thread.turns, [{ id: turn.id, status: 'completed' }]);
    const next = second.finished();
    await second.driver.request('turn/start', { threadId: thread.id, input: text('more') });
    await next;
    assert.equal(fake.conversationOf(thread.id).messages.filter(message => message.role === 'user').length, 2);
    assert.deepEqual(items(second.notes, 'agentMessage').map(item => item.text), ['answer'], 'old events are not told again');
    second.driver.close();

    fake.workspaces.get(`factory-${thread.id}`).conversations.delete(thread.id);
    const third = await harness({ fake, root });
    await assert.rejects(third.driver.request('thread/resume', { threadId: thread.id, cwd: join(root, 'work') }), unavailable(thread.id));
    third.driver.close();
  } finally { await fake.close(); }
});

test('after a restart a dead turn is closed and a live one is observed, never replayed', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fake = await new FakeFlujo({ script: async run => { await gate; run.say('late'); run.done(); } }).listen();
  const root = fresh();
  const first = await harness({ fake, root });
  try {
    const { thread } = await started(first);
    const { turn } = await first.driver.request('turn/start', { threadId: thread.id, input: text('go') });
    await waitFor(() => fake.conversationOf(thread.id)?.status === 'running');
    first.driver.close();

    // FLUJO kept running, so the new driver follows the same turn.
    const second = await harness({ fake, root });
    const ended = second.finished();
    const resumed = await second.driver.request('thread/resume', { threadId: thread.id, cwd: join(root, 'work'), sandbox: 'danger-full-access' });
    assert.equal(resumed.thread.status.type, 'active');
    release();
    assert.deepEqual(await ended, { id: turn.id, status: 'completed' });
    assert.equal(fake.count('POST', '/v1/chat/completions'), 1);
    second.driver.close();

    // FLUJO died with the Machine: the conversation is terminal, so the retained turn did not finish.
    const state = join(root, 'state', `${thread.id}.flujo.json`);
    writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), lastTurn: { id: turn.id, status: 'inProgress' } }));
    const conversation = fake.conversationOf(thread.id);
    conversation.status = 'error'; conversation.recovery.classification = 'interrupted';
    const third = await harness({ fake, root });
    const closed = await third.driver.request('thread/resume', { threadId: thread.id, cwd: join(root, 'work'), sandbox: 'danger-full-access' });
    assert.equal(closed.thread.status.type, 'idle');
    assert.deepEqual(closed.recoveredTurn, { id: turn.id, status: 'interrupted' });
    third.driver.close();
  } finally { await fake.close(); }
});

test('a durable workflow wake delivers a turn and reads it back', async () => {
  const h = await harness();
  try {
    const { thread } = await started(h);
    const done = h.finished();
    const wake = new NativeWorkflowWake({ rpc: h.driver, threadId: thread.id, file: join(h.root, 'wake.json'), effort: 'medium' });
    const delivered = await wake.wake({ trigger: 'first', input: 'start', initial: true });
    assert.equal(delivered.status, 'delivered');
    const turn = await done;
    assert.equal(delivered.turnId, turn.id);
    assert.deepEqual(await wake.read(), { status: 'idle', turnId: turn.id });
  } finally { await h.end(); }
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
  const h = await harness({ root, script: () => {} });
  try {
    const { thread } = await started(h);
    await post('/operator/session', { agent: agent.id, session: thread.id });
    const trace = new CloudLiteTrace({ file: join(root, 'trace.jsonl'), url, token: credentials[agent.id] });
    const turns = new Map(), terminal = new Map();
    h.driver.on('notification', ({ method, params }) => {
      if (method === 'turn/started') { terminal.delete(thread.id); turns.set(thread.id, params.turn.id); trace.record('native.turn.started', { threadId: thread.id, turn: params.turn }); stop.observeTurnStarted({ threadId: thread.id, turnId: params.turn.id }); }
      if (method === 'turn/completed') { terminal.set(thread.id, { id: params.turn.id, status: params.turn.status }); trace.record('native.turn.completed', { threadId: thread.id, turn: { id: params.turn.id, status: params.turn.status } }); stop.observeTerminal({ threadId: thread.id, turnId: params.turn.id, status: params.turn.status }); }
    });
    const stop = new NativeOperatorStop({ rpc: h.driver, threadId: thread.id, getTurn: () => nativeStopTurn(turns, terminal, thread.id), trace: (kind, body) => trace.record(kind, body), flush: () => trace.flush(), timeoutMs: 5000 });
    trace.record('native.thread.started', { threadId: thread.id, threadStatus: 'idle' });
    const { turn } = await h.driver.request('turn/start', { threadId: thread.id, input: text('long job') });
    await trace.flush();
    await waitFor(() => h.fake.conversationOf(thread.id)?.status === 'running');
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
  } finally { await h.end(); await coordinator.close(); }
});

test('no stop receipt is issued while FLUJO still reports work', async () => {
  const h = await harness({ script: () => {} });
  try {
    const { thread } = await started(h);
    const turns = new Map(), terminal = new Map();
    let stop;
    h.driver.on('notification', ({ method, params }) => {
      if (method === 'turn/started') turns.set(thread.id, params.turn.id);
      if (method === 'turn/completed') { terminal.set(thread.id, { id: params.turn.id, status: params.turn.status }); stop.observeTerminal({ threadId: thread.id, turnId: params.turn.id, status: params.turn.status }); }
    });
    const receipts = [];
    stop = new NativeOperatorStop({ rpc: h.driver, threadId: thread.id, getTurn: () => nativeStopTurn(turns, terminal, thread.id), trace: (kind, body) => receipts.push({ kind, body }), flush: async () => {}, timeoutMs: 60 });
    const { turn } = await h.driver.request('turn/start', { threadId: thread.id, input: text('long') });
    await waitFor(() => h.fake.conversationOf(thread.id)?.status === 'running');
    h.fake.holdCancel = true;
    await assert.rejects(stop.stop('stop-held', { expectedThreadId: thread.id, expectedTurnId: turn.id }), /terminal notification/);
    assert.equal(receipts.some(entry => entry.kind === 'native.operator.stop.completed'), false);
  } finally { await h.end(); }
});

const freePort = () => new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const programOptions = async (env = {}) => ({ command: process.execPath, args: [fakeProgram], port: await freePort(), environment: () => ({ ...process.env, ...env }), startTimeoutMs: 15000 });

test('the FLUJO process starts, restarts a few times if it dies, then reports the failure', async () => {
  const program = new FlujoProgram({ ...await programOptions({ FAKE_FLUJO_CRASH_AFTER: '2000' }), restartLimit: 2, restartWindowMs: 60000 });
  const seen = [];
  program.on('restarting', event => seen.push(`restarting ${event.restarts}`));
  program.on('restarted', event => seen.push(`restarted ${event.restarts}`));
  const exited = new Promise(resolve => program.on('exit', resolve));
  try {
    await program.start();
    const result = await exited;
    assert.equal(result.code, 7);
    assert.deepEqual(seen, ['restarting 1', 'restarted 1', 'restarting 2', 'restarted 2', 'restarting 3']);
  } finally { await program.stop(); }
});

test('a FLUJO that cannot start is reported, and a stop ends it', async () => {
  const broken = new FlujoProgram(await programOptions({ FAKE_FLUJO_EXIT_AT_START: '3' }));
  await assert.rejects(broken.start(), /exited before it was ready \(3\)/);
  const program = new FlujoProgram(await programOptions());
  await program.start();
  const exited = new Promise(resolve => program.on('exit', resolve));
  await program.stop();
  await exited;
  assert.ok(program.child.exitCode !== null || program.child.signalCode !== null);
});

test('a driver owns its FLUJO process: it starts it, reports its version and ends with it', async () => {
  const root = fresh();
  const driver = new FlujoSessionDriver({ program: new FlujoProgram(await programOptions()), stateDirectory: join(root, 'state'), modelRecord: () => flujoProviderModel(provider(), { key }), pollMs: 20 });
  const exited = new Promise(resolve => driver.on('exit', resolve));
  await driver.initialize();
  assert.equal(await driver.version(), '9.9.9');
  mkdirSync(join(root, 'work'));
  const { thread } = await driver.request('thread/start', { cwd: join(root, 'work'), sandbox: 'danger-full-access' });
  assert.equal(thread.status.type, 'idle');
  driver.close();
  await exited;
});

test('evidence from a FLUJO worker holds its conversations and none of its keys', () => {
  const root = fresh(), space = join(root, 'workspaces', 'factory-thread', 'db');
  mkdirSync(join(space, 'conversations'), { recursive: true }); mkdirSync(join(space, 'conversation-logs')); mkdirSync(join(root, 'workspaces', 'factory-thread', 'mcp-servers'));
  writeFileSync(join(space, 'conversations', 'thread.json'), '{}'); writeFileSync(join(space, 'conversation-logs', 'thread.jsonl'), '{}\n');
  for (const name of ['encryption_key.json', 'models.json', 'mcp_servers.json']) writeFileSync(join(space, name), 'private');
  writeFileSync(join(root, 'workspaces', 'factory-thread', 'mcp-servers', 'server.js'), 'code');
  const store = new FactoryArtifactStore(join(fresh(), 'objects'));
  const exclude = ['encryption_key.json', 'models.json', 'mcp_servers.json', 'mcp-servers', 'browser-profile', 'bash-utils', 'screenshots', 'recordings', 'snapshots', '.runtime-locks', 'node_modules'];
  const captured = captureWorkspace(store, join(root, 'workspaces'), { exclude });
  const names = readWorkspaceManifest(store, captured.source.snapshot).files.map(file => file.path).sort();
  assert.deepEqual(names, ['factory-thread/db/conversation-logs/thread.jsonl', 'factory-thread/db/conversations/thread.json']);
  // The list above is the one the worker uses.
  const runtime = readFileSync(new URL('../src/cloud-lite/runtime.mjs', import.meta.url), 'utf8');
  assert.ok(runtime.includes(`sessionsExclude: ${JSON.stringify(exclude).replaceAll('"', "'").replaceAll(',', ', ')}`));
});

test('a FLUJO fleet stages the key only as a secret, needs a provider and keeps its program on updates', async () => {
  const root = fresh(); const calls = []; const machines = [];
  const infrastructure = {
    run: async (args, options = {}) => { calls.push({ args, input: options.input }); if (args[0] === 'volumes') return JSON.stringify({ id: 'vol_1' }); if (args[0] === 'machine' && args[1] === 'list') return JSON.stringify(machines.map(machine => ({ id: machine.id, name: machine.name, state: 'stopped', config: machine.config }))); return ''; },
    buildMachineConfig: () => ({ init: { cmd: ['upstream'] }, services: [] }),
    createMachine: async ({ name, config }) => { const machine = { id: `machine-${machines.length}`, name, config }; machines.push(machine); return machine; },
  };
  const bundlePath = join(root, 'bundle.tgz'); writeFileSync(bundlePath, 'bundle');
  const image = 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64);
  const fleet = new FactoryCloudLiteFleet({ directory: join(root, 'fleet'), infrastructure });
  await assert.rejects(fleet.deploy({ runId: 'flujo-test', app: 'factory-flujo-test', goal: 'x', workerProgram: 'flujo' }, { image, bundlePath }), /subscription auth broker \(or a model provider\)/);
  await assert.rejects(fleet.deploy(plan(), { image, bundlePath }), /needs its API key/);
  const result = await fleet.deploy(plan({ machines: 1 }), { image, bundlePath, providerKey: key });
  assert.equal(result.machines.length, 1);
  const staged = calls.find(call => call.args[0] === 'secrets');
  const config = JSON.parse(Buffer.from(staged.input.trim().split('=').slice(1).join('='), 'base64').toString());
  assert.equal(config.providerKey, key);
  assert.equal(config.plan.workerProgram, 'flujo');
  assert.equal(readFileSync(join(root, 'fleet', 'fleet.json'), 'utf8').includes(key), false);
  assert.match(readFileSync(join(root, 'fleet', 'bootstrap.sh'), 'utf8'), /flujo-ai-/);
  assert.equal(machines[0].config.metadata['factory.runtime'], 'flujo-lite');
  assert.equal(JSON.stringify(machines[0].config).includes(key), false);
  // A runtime update must not switch the fleet to another program.
  writeFileSync(bundlePath, 'bundle 2');
  try { await fleet.updateRuntime({ bundlePath }); } catch { /* The fake host has no update path; the script is what matters here. */ }
  const updated = readFileSync(join(root, 'fleet', 'fleet.json'), 'utf8');
  assert.ok(updated);
  const digest = (await import('node:crypto')).createHash('sha256').update('bundle 2').digest('hex');
  assert.match(readFileSync(join(root, 'fleet', `bootstrap-${digest}.sh`), 'utf8'), /flujo-ai-/);
});

test('an app can pack the SDK from its own dependency, and the same files give the same bytes', () => {
  const root = fresh(), first = join(root, 'first.tgz'), second = join(root, 'nested', 'second.tgz');
  const packed = packFactorySdk(first);
  assert.ok(packed.files > 50);
  packFactorySdk(second);
  assert.deepEqual(readFileSync(first), readFileSync(second));
  const unpacked = join(root, 'unpacked'); mkdirSync(unpacked);
  // The bootstrap unpacks it the same way, and Git's tar on Windows reads a drive letter as a host.
  const relative = spawnSync('tar', ['-xzf', 'first.tgz', '--strip-components=1', '-C', 'unpacked'], { cwd: root, encoding: 'utf8' });
  assert.equal(relative.status, 0, relative.stderr);
  const sdk = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8')).version, sdk.version);
  for (const file of ['bin/factory-cloud-runtime.mjs', 'bin/factory-cloud-mcp.mjs', 'src/cloud-lite/runtime.mjs', 'src/cloud-lite/flujo-driver.mjs']) assert.equal(existsSync(join(unpacked, file)), true, file);
  assert.equal(existsSync(join(unpacked, 'node_modules')), false);
  assert.equal(existsSync(join(unpacked, 'test')), false);
  assert.ok(readdirSync(join(unpacked, 'src')).length > 10);
  assert.deepEqual(readFileSync(join(unpacked, 'src', 'cloud-lite', 'bundle.mjs')), readFileSync(new URL('../src/cloud-lite/bundle.mjs', import.meta.url)));
  if (process.platform !== 'win32') assert.equal(statSync(join(unpacked, 'bin', 'factory-cloud-runtime.mjs')).mode & 0o755, 0o755);
  assert.throws(() => packFactorySdk(), /where to write/);
});

test('a fleet can have its own private network', async () => {
  assert.throws(() => plan({ network: 'Bad Name' }), /Invalid network/);
  const root = fresh(), calls = [];
  const infrastructure = { run: async args => { calls.push(args); return ''; } };
  const fleet = new FactoryCloudLiteFleet({ directory: join(root, 'fleet'), infrastructure });
  await fleet.prepare(plan({ org: 'my-org', network: 'goal-network' }));
  assert.deepEqual(calls[0], ['apps', 'create', 'factory-flujo-test', '--org', 'my-org', '--network', 'goal-network']);
  const other = new FactoryCloudLiteFleet({ directory: join(root, 'other'), infrastructure });
  await other.prepare(plan({ org: 'my-org' }));
  assert.deepEqual(calls[1], ['apps', 'create', 'factory-flujo-test', '--org', 'my-org']);
});

test('a local FLUJO worker attaches, installs the template and the board, and keeps its conversation', async () => {
  const fake = await new FakeFlujo().listen();
  const root = fresh();
  const options = { provider: 'flujo', database: join(root, 'board.sqlite'), cwd: root, origin: fake.origin, modelProvider: provider({ apis: ['chat'] }), providerKey: key, stateDirectory: join(root, 'state'), teamConcurrency: 2, agentId: 'builder' };
  try {
    const spec = liteWorkerCommand({ ...options, port: 4321, dataDirectory: join(root, 'data'), env: { PATH: '/bin' } });
    assert.equal(spec.command, 'flujo');
    assert.deepEqual(spec.args, ['--no-open', '--port', '4321']);
    assert.deepEqual(spec.env, { PATH: '/bin', FLUJO_DATA_DIR: join(root, 'data'), FLUJO_PORT: '4321' });
    assert.ok(spec.server.args.includes('--actor'));
    assert.throws(() => liteWorkerCommand({ provider: 'other', database: 'x' }), /codex, claude or flujo/);
    await assert.rejects(startLiteWorker({ provider: 'flujo', database: join(root, 'board.sqlite'), origin: fake.origin, stateDirectory: join(root, 'other') }), /modelProvider or a flujoModel/);
    await assert.rejects(startLiteWorker({ ...options, providerKey: 'short' }), /API key/);

    const worker = await startLiteWorker({ ...options, prompt: 'Work on the board' });
    assert.equal(worker.origin, fake.origin);
    assert.equal(worker.child, null, 'nothing is started when attaching');
    assert.equal((await worker.settled()).status, 'completed');
    const space = fake.workspaces.get(worker.workspace);
    assert.equal(space.models[0].adapter, 'openai');
    assert.deepEqual(space.flows.map(flow => flow.name), ['swarm_agent', 'swarm_team']);
    const board = space.servers.find(server => server.name === 'factory');
    assert.equal(board.args.includes('--config'), false, 'a local board has no credential to hide');
    assert.ok(board.args.includes('builder'));
    const threadId = worker.threadId;
    await worker.stop();

    const again = await startLiteWorker({ ...options });
    assert.equal(again.threadId, threadId, 'the agent keeps its conversation across runs');
    await again.send('More work');
    assert.equal((await again.settled()).status, 'completed');
    assert.equal(fake.conversationOf(threadId).messages.filter(message => message.role === 'user').length, 2);
    await again.stop();
    assert.equal(existsSync(join(root, 'state', 'session.json')), true);
  } finally { await fake.close(); }
});
