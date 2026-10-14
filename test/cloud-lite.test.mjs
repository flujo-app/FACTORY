import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, fsync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudLiteBoard } from '../src/cloud-lite/board.mjs';
import { validateCloudLitePlan, agentInventory, machineConfig, redact, secret, hash } from '../src/cloud-lite/protocol.mjs';
import { FactoryCloudLiteFleet } from '../src/cloud-lite/fleet.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';
import { CloudLiteTrace } from '../src/cloud-lite/trace.mjs';
import { collectCloudLiteSnapshot } from '../src/cloud-lite/collect.mjs';
import { DatabaseSync } from 'node:sqlite';

const plan = () => validateCloudLitePlan({ runId: 'lite-test', app: 'factory-lite-test', repository: 'mario-andreschak/FLUJO', goal: 'Analyze and merge existing PRs', machines: 10, agentsPerMachine: 10 });
const fresh = () => mkdtempSync(join(tmpdir(), 'factory-cloud-lite-'));
test('requested 10 by 10 topology and Fly resource selection retain exact values', () => {
  const input = plan(); const agents = agentInventory(input);
  assert.equal(agents.length, 100); assert.equal(agents.filter(x => x.role === 'orchestrator').length, 10);
  const config = machineConfig(input, { image: 'example@sha256:123', volumeId: 'vol_one', index: 4, environment: {} });
  assert.deepEqual(config.guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 }); assert.equal(config.mounts[0].volume, 'vol_one');
  assert.equal(config.services.length, 0);
  assert.throws(() => validateCloudLitePlan({ ...input, agentsPerMachine: -1 }));
});
test('board rejects cross-machine subagent messages while allowing orchestrator and local peer messages', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()]));
  const board = new CloudLiteBoard(join(fresh(), 'board.sqlite'), { plan: p, credentials });
  try {
    const a = id => board.authenticate(credentials[id]);
    assert.throws(() => board.call(a('m0-a1'), 'factory_message', { recipient: 'm1-a1', messageId: 'forbidden', message: {} }), /communication policy/);
    assert.throws(() => board.call(a('m0-a1'), 'factory_message', { recipient: 'm1-a0', messageId: 'also-forbidden', message: {} }), /communication policy/);
    assert.deepEqual(board.call(a('m0-a0'), 'factory_message', { recipient: 'm1-a0', messageId: 'leaders', message: { work: 'pr:1' } }), { duplicate: false });
    board.call(a('m0-a1'), 'factory_message', { recipient: 'm0-a2', messageId: 'local', message: { review: true } });
    assert.equal(board.call(a('m0-a2'), 'factory_inbox').messages.length, 1);
  } finally { board.close(); }
});
test('separate controller connections cannot assign the same resource to two machines', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()])); const db = join(fresh(), 'board.sqlite');
  const first = new CloudLiteBoard(db, { plan: p, credentials }); const second = new CloudLiteBoard(db, { plan: p, credentials });
  try {
    assert.equal(first.call(first.authenticate(credentials['m0-a0']), 'factory_claim', { resource: 'pr:1140' }).claimed, true);
    const refused = second.call(second.authenticate(credentials['m1-a0']), 'factory_claim', { resource: 'pr:1140' });
    assert.equal(refused.claimed, false); assert.equal(refused.claim.owner, 'm0-a0');
  } finally { first.close(); second.close(); }
});
test('trace replay commits once and rejects altered bytes after a lost ACK', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()])); const board = new CloudLiteBoard(join(fresh(), 'board.sqlite'), { plan: p, credentials });
  try {
    const actor = board.authenticate(credentials['m0-a0']); const events = [{ seq: 1, kind: 'tool', body: { command: 'npm run lint' } }];
    board.trace(actor, events); board.trace(actor, events); assert.equal(board.events().length, 1);
    assert.throws(() => board.trace(actor, [{ ...events[0], body: { changed: true } }]), /different bytes/);
  } finally { board.close(); }
});

test('trace pages enforce both the event budget and the captured through watermark', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()]));
  const board = new CloudLiteBoard(join(fresh(), 'board.sqlite'), { plan: p, credentials });
  try {
    const actor = board.authenticate(credentials['m0-a0']);
    board.trace(actor, Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, kind: 'fixture', body: { index } })));
    const watermark = board.snapshot().traceSequence;
    board.trace(actor, Array.from({ length: 2 }, (_, index) => ({ seq: index + 101, kind: 'late', body: { index } })));
    const first = board.events(0, watermark);
    assert.equal(first.length, 100);
    assert.equal(first.at(-1).seq, watermark);
    assert.equal(board.events(watermark, watermark).length, 0);
    assert.deepEqual(board.events(watermark, watermark + 2).map(event => event.seq), [watermark + 1, watermark + 2]);
    board.trace(actor, [{ seq: 103, kind: 'large', body: 'x'.repeat(600 * 1024) }]);
    const oversized = board.events(watermark + 2, watermark + 3);
    assert.equal(oversized.length, 1);
    assert.equal(oversized[0].body.length, 600 * 1024);
  } finally { board.close(); }
});

test('credentials cannot appear in diagnostic trace projection', () => {
  const credential = secret(); assert.equal(redact({ stderr: `failed with ${credential}` }, [credential]).stderr, 'failed with [REDACTED]');
  assert.equal(redact({ jwt: 'eyJabcdefgh.abcdefghijkl.abcdefghijk' }).jwt, '[REDACTED]');
});

test('slow trace durability keeps coordinator health available and sends only the durable batch', async () => {
  const p = validateCloudLitePlan({ ...plan(), machines: 1, agentsPerMachine: 1 });
  const credentials = { 'm0-a0': secret() }; const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(fresh(), 'board.sqlite'), plan: p, credentials, operatorToken,
    auth: { accessToken: secret(), chatgptAccountId: 'account' }, githubToken: secret(), host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  let release; let entered;
  const delayedDisk = new Promise(resolve => { release = resolve; });
  const diskStarted = new Promise(resolve => { entered = resolve; });
  const file = join(fresh(), 'trace.jsonl');
  const trace = new CloudLiteTrace({ file, url, token: credentials['m0-a0'], sync: async fd => {
    entered(); await delayedDisk; await promisify(fsync)(fd);
  } });
  let pending;
  try {
    trace.record('turn/completed', { threadId: 'native-thread' });
    pending = trace.flush(); await diskStarted;
    const health = await fetch(url + '/health', { signal: AbortSignal.timeout(2000) });
    assert.equal(health.status, 200); assert.equal((await health.json()).runId, p.runId);
    assert.equal(coordinator.board.events().length, 0);
    trace.record('item/completed', { command: 'node --version' });
    release(); await pending;
    assert.deepEqual(coordinator.board.events().map(event => event.source_seq), [1]);
    assert.equal(readFileSync(trace.ackFile, 'utf8'), '1'); assert.equal(trace.queue.length, 1);
    await trace.flush();
    assert.deepEqual(coordinator.board.events().map(event => event.source_seq), [1, 2]);
    assert.equal(readFileSync(trace.ackFile, 'utf8'), '2'); assert.equal(trace.queue.length, 0);
  } finally { release(); await pending?.catch(() => {}); await coordinator.close(); }
});

test('a concurrent observer retains controller receipts and resumes its separate trace cursor', async () => {
  const directory = fresh();
  const controller = new FactoryCloudLiteFleet({ directory });
  controller.state = { plan: plan(), machines: [{ id: 'owned-machine' }], operations: {} }; controller.save();
  const observer = new FactoryCloudLiteFleet({ directory });
  observer.request = async path => {
    if (path === '/operator/status') {
      controller.state.operations.upgrade = { state: 'succeeded', result: { machineId: 'owned-machine' } }; controller.save();
      return { agents: [], traceSequence: 19, refreshRequested: false };
    }
    assert.equal(path, '/operator/events?after=0&through=19');
    return { events: [{ seq: 19, kind: 'turn/started' }] };
  };
  await observer.observe();
  assert.equal(JSON.parse(readFileSync(controller.journalPath, 'utf8')).operations.upgrade.state, 'succeeded');
  const resumed = new FactoryCloudLiteFleet({ directory });
  resumed.request = async path => {
    if (path === '/operator/status') return { agents: [], traceSequence: 19, refreshRequested: false };
    assert.equal(path, '/operator/events?after=19&through=19'); return { events: [] };
  };
  await resumed.observe();
  assert.equal(readFileSync(join(directory, 'traces.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(JSON.parse(readFileSync(controller.journalPath, 'utf8')).operations.upgrade.state, 'succeeded');
});

test('observer drains only a bounded fixed watermark and resumes from its durable cursor', async () => {
  const directory = fresh();
  const fleet = new FactoryCloudLiteFleet({ directory }); fleet.state = { plan: plan(), machines: [], operations: {} }; fleet.save();
  let pass = 0;
  const requests = [];
  fleet.request = async path => {
    if (path === '/operator/status') return { traceSequence: pass++ === 0 ? 205 : 210, agents: [], refreshRequested: false };
    requests.push(path);
    const url = new URL(path, 'http://localhost');
    const after = Number(url.searchParams.get('after'));
    const through = Number(url.searchParams.get('through'));
    const end = Math.min(through, after + 100);
    return { events: Array.from({ length: Math.max(0, end - after) }, (_, index) => ({ seq: after + index + 1, kind: 'fixture' })) };
  };

  const first = await fleet.observe({ maxPages: 2 });
  assert.equal(first.traceCollection.traceCursor, 200); assert.equal(first.traceCollection.traceWatermark, 205);
  assert.equal(first.traceCollection.complete, false); assert.equal(first.traceCollection.remainingLag, 5);
  assert.equal(first.traceCollection.observedLag, 5); assert.equal(first.traceCollection.pages, 2);
  assert.equal(first.traceCollection.eventsCollected, 200); assert.equal(first.traceCollection.lastPageEvents, 100);
  assert.deepEqual(requests, ['/operator/events?after=0&through=205', '/operator/events?after=100&through=205']);
  assert.equal(readFileSync(join(directory, 'traces.jsonl'), 'utf8').trim().split('\n').length, 200);
  const retained = JSON.parse(readFileSync(join(directory, 'observation.json'), 'utf8'));
  assert.equal(retained.traceCursor, 200); assert.equal(retained.traceWatermark, 205);

  const secondFleet = new FactoryCloudLiteFleet({ directory });
  secondFleet.request = fleet.request;
  const second = await secondFleet.observe({ maxPages: 2 });
  assert.equal(second.traceCollection.traceCursor, 205); assert.equal(second.traceCollection.traceWatermark, 205);
  assert.equal(second.traceCollection.complete, true); assert.equal(second.traceCollection.remainingLag, 0);
  assert.equal(second.traceCollection.observedLag, 5); assert.equal(second.traceCollection.pages, 1);
  assert.equal(second.traceCollection.eventsCollected, 5); assert.equal(second.traceCollection.lastPageEvents, 5);
  assert.equal(requests.at(-1), '/operator/events?after=200&through=205');
  const thirdFleet = new FactoryCloudLiteFleet({ directory });
  thirdFleet.request = fleet.request;
  const third = await thirdFleet.observe({ maxPages: 2 });
  assert.equal(third.traceCollection.traceCursor, 210); assert.equal(third.traceCollection.traceWatermark, 210);
  assert.equal(third.traceCollection.complete, true); assert.equal(third.traceCollection.remainingLag, 0);
  assert.equal(third.traceCollection.observedLag, 0); assert.equal(third.traceCollection.pages, 1);
  const events = readFileSync(join(directory, 'traces.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 210);
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: 210 }, (_, index) => index + 1));
  assert.equal(requests.at(-1), '/operator/events?after=205&through=210');
});

test('observer reconciles a durable page append after a cursor-write interruption without duplicates', async () => {
  const directory = fresh();
  const fleet = new FactoryCloudLiteFleet({ directory }); fleet.state = { plan: plan(), machines: [], operations: {} }; fleet.save();
  writeFileSync(join(directory, 'traces.jsonl'), JSON.stringify({ seq: 1, kind: 'fixture' }) + '\n');
  writeFileSync(join(directory, 'observation.json'), JSON.stringify({ runId: 'lite-test', traceCursor: 0, traceWatermark: 2 }));
  fleet.request = async path => {
    if (path === '/operator/status') return { traceSequence: 2, agents: [], refreshRequested: false };
    assert.equal(path, '/operator/events?after=1&through=2'); return { events: [{ seq: 2, kind: 'fixture' }] };
  };
  await fleet.observe();
  const events = readFileSync(join(directory, 'traces.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.seq), [1, 2]);
  assert.equal(JSON.parse(readFileSync(join(directory, 'observation.json'), 'utf8')).traceCursor, 2);
});

test('observer scans large durable tail records and preserves large torn fragments during recovery', async () => {
  const directory = fresh();
  const fleet = new FactoryCloudLiteFleet({ directory }); fleet.state = { plan: plan(), machines: [], operations: {} }; fleet.save();
  const traceFile = join(directory, 'traces.jsonl');
  const first = JSON.stringify({ seq: 1, kind: 'fixture', body: 'x'.repeat(300 * 1024) }) + '\n';
  const fragment = Buffer.from('t'.repeat(300 * 1024));
  writeFileSync(traceFile, first + fragment);
  fleet.request = async path => {
    if (path === '/operator/status') return { traceSequence: 2, agents: [], refreshRequested: false };
    assert.equal(path, '/operator/events?after=1&through=2'); return { events: [{ seq: 2, kind: 'fixture' }] };
  };
  await fleet.observe();
  const events = readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.seq), [1, 2]);
  const preserved = `${traceFile}.preserved-tail-${hash(fragment)}.raw`;
  assert.equal(readFileSync(preserved).equals(fragment), true);
});

test('observer rejects out-of-watermark and oversized pages before writing any trace bytes', async () => {
  for (const events of [
    [{ seq: 1, kind: 'fixture' }, { seq: 3, kind: 'beyond-watermark' }],
    [{ seq: 1, kind: 'large', body: 'x'.repeat(300 * 1024) }, { seq: 2, kind: 'large', body: 'y'.repeat(300 * 1024) }],
  ]) {
    const directory = fresh();
    const fleet = new FactoryCloudLiteFleet({ directory }); fleet.state = { plan: plan(), machines: [], operations: {} }; fleet.save();
    fleet.request = async path => path === '/operator/status'
      ? { traceSequence: 2, agents: [], refreshRequested: false }
      : { events };
    await assert.rejects(fleet.observe(), /watermark|byte limit/);
    assert.equal(existsSync(join(directory, 'traces.jsonl')), false);
    assert.equal(existsSync(join(directory, 'observation.json')), false);
  }
});

test('observer makes progress on one legacy oversized trace record across restart', async () => {
  const directory = fresh();
  const fleet = new FactoryCloudLiteFleet({ directory }); fleet.state = { plan: plan(), machines: [], operations: {} }; fleet.save();
  let archiveRequests = 0;
  fleet.request = async path => {
    if (path === '/operator/status') return { traceSequence: 1, agents: [], refreshRequested: false };
    archiveRequests++;
    assert.equal(path, '/operator/events?after=0&through=1');
    return { events: [{ seq: 1, kind: 'large', body: 'x'.repeat(600 * 1024) }] };
  };
  const first = await fleet.observe();
  assert.equal(first.traceCollection.complete, true); assert.equal(first.traceCollection.traceCursor, 1);
  const resumed = new FactoryCloudLiteFleet({ directory });
  resumed.request = async path => {
    assert.equal(path, '/operator/status'); return { traceSequence: 1, agents: [], refreshRequested: false };
  };
  await resumed.observe();
  assert.equal(archiveRequests, 1);
  assert.equal(JSON.parse(readFileSync(join(directory, 'traces.jsonl'), 'utf8').trim()).seq, 1);
});

test('bounded observer batches make sustained progress while a newer trace tail arrives', async () => {
  const directory = fresh();
  const fleet = new FactoryCloudLiteFleet({ directory }); fleet.state = { plan: plan(), machines: [], operations: {} }; fleet.save();
  let statusCount = 0;
  const requests = [];
  fleet.request = async path => {
    if (path === '/operator/status') return { traceSequence: [1000, 1005, 1005][statusCount++] ?? 1005, agents: [], refreshRequested: false };
    requests.push(path);
    const query = new URL(path, 'http://localhost').searchParams;
    const after = Number(query.get('after')); const through = Number(query.get('through'));
    const end = Math.min(through, after + 100);
    return { events: Array.from({ length: end - after }, (_, index) => ({ seq: after + index + 1, kind: 'burst' })) };
  };
  const first = await fleet.observe({ maxPages: 5 });
  assert.equal(first.traceCollection.pages, 5); assert.equal(first.traceCollection.eventsCollected, 500);
  assert.equal(first.traceCollection.remainingLag, 500);
  const resumed = new FactoryCloudLiteFleet({ directory }); resumed.request = fleet.request;
  const second = await resumed.observe({ maxPages: 5 });
  assert.equal(second.traceCollection.pages, 5); assert.equal(second.traceCollection.traceWatermark, 1000);
  assert.equal(second.traceCollection.complete, true); assert.equal(second.traceCollection.observedLag, 5);
  const final = new FactoryCloudLiteFleet({ directory }); final.request = fleet.request;
  const third = await final.observe({ maxPages: 5 });
  assert.equal(third.traceCollection.traceWatermark, 1005); assert.equal(third.traceCollection.remainingLag, 0);
  assert.equal(requests.some(path => path.endsWith('through=1005') && path.includes('after=500')), false);
  const events = readFileSync(join(directory, 'traces.jsonl'), 'utf8').trim().split('\n');
  assert.equal(events.length, 1005);
});

test('observer handles requested auth refresh before malformed archive metadata', async () => {
  const directory = fresh();
  const fleet = new FactoryCloudLiteFleet({ directory }); fleet.state = { plan: plan(), machines: [], operations: {} }; fleet.save();
  writeFileSync(join(directory, 'observation.json'), '{broken');
  const order = [];
  fleet.auth = { refresh: async () => { order.push('refresh'); return { accessToken: 'safe-test-token' }; } };
  fleet.request = async path => {
    order.push(path);
    if (path === '/operator/status') return { traceSequence: 0, agents: [], refreshRequested: true };
    if (path === '/operator/auth') return { updated: true };
    throw new Error('Archive should not be requested.');
  };
  await assert.rejects(fleet.observe(), SyntaxError);
  assert.deepEqual(order, ['/operator/status', 'refresh', '/operator/auth']);
});

test('agent progress cannot overwrite the SDK-registered native session identity', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id,secret()]));
  const board = new CloudLiteBoard(join(fresh(),'board.sqlite'),{plan:p,credentials});
  try {
    const session = '01a1390d-1da9-76a1-0a6e-af0c060ec3a4';
    board.registerSession('m0-a1',session);
    board.call(board.authenticate(credentials['m0-a1']),'factory_checkpoint',{status:'reviewing',session:'m0-a1'});
    assert.equal(board.inventory().find(agent=>agent.id==='m0-a1').session,session);
    assert.throws(()=>board.registerSession('m0-a1','made-up'),/real native/);
  } finally { board.close(); }
});

test('native lifecycle status is separate from agent checkpoint and strips failure text', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()]));
  const board = new CloudLiteBoard(join(fresh(), 'board.sqlite'), { plan: p, credentials });
  try {
    const actor = board.authenticate(credentials['m0-a1']);
    const threadId = '01a1390d-1da9-76a1-0a6e-af0c060ec3a4';
    const turnId = '01a1390e-1da9-76a1-0a6e-af0c060ec3a4';
    board.registerSession(actor.id, threadId);
    board.call(actor, 'factory_checkpoint', { status: 'reviewing' });
    board.trace(actor, [{ seq: 1, kind: 'thread/started', body: { thread: { id: threadId, status: { type: 'active' } } } }]);
    board.trace(actor, [{ seq: 2, kind: 'turn/started', body: { threadId, turn: { id: turnId, status: 'inProgress' } } }]);
    board.trace(actor, [{ seq: 3, kind: 'turn/completed', body: { threadId, turn: { id: turnId, status: 'failed', error: {
      code: -32000, message: 'never persist this private provider error',
    } } } }]);
    board.trace(actor, [{ seq: 2, kind: 'turn/started', body: { threadId, turn: { id: turnId, status: 'inProgress' } } }]);
    const agent = board.snapshot().agents.find(value => value.id === actor.id);
    assert.equal(agent.status, 'reviewing');
    assert.equal(agent.session, threadId);
    assert.deepEqual(agent.nativeRuntime, { threadId, eventSequence: 3, threadLifecycle: 'started', threadStatus: 'active', turnId,
      turnStatus: 'failed', failure: { category: 'turn_failed', errorCode: -32000 }, updated: agent.nativeRuntime.updated });
    assert.doesNotMatch(JSON.stringify(agent.nativeRuntime), /private provider error/);
    board.trace(actor, [{ seq: 4, kind: 'turn/started', body: { threadId: '01a1390d-1da9-76a1-0a6e-af0c060ec3a5', turn: { id: turnId } } }]);
    assert.equal(board.snapshot().agents.find(value => value.id === actor.id).nativeRuntime.eventSequence, 3);
    board.registerSession(actor.id, '01a1390f-1da9-76a1-0a6e-af0c060ec3a4');
    assert.equal(board.snapshot().agents.find(value => value.id === actor.id).nativeRuntime, null);
  } finally { board.close(); }
});

test('SDK lifecycle and operator-stop paths never author the agent checkpoint', () => {
  const runtime = readFileSync(new URL('../src/cloud-lite/runtime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /factory_checkpoint/);
});

test('durable trace retry reconciles failed native turns in order after coordinator outage', async () => {
  const p = validateCloudLitePlan({ ...plan(), machines: 1, agentsPerMachine: 1 });
  const credentials = { 'm0-a0': secret() };
  const coordinator = await startCloudLiteCoordinator({ database: join(fresh(), 'board.sqlite'), plan: p, credentials,
    operatorToken: secret(), auth: { accessToken: secret(), chatgptAccountId: 'account' }, githubToken: secret(), host: '127.0.0.1', port: 0 });
  const threadId = '01a1390d-1da9-76a1-0a6e-af0c060ec3a4';
  const turnId = '01a1390e-1da9-76a1-0a6e-af0c060ec3a4';
  const actor = coordinator.board.authenticate(credentials['m0-a0']);
  coordinator.board.registerSession(actor.id, threadId);
  const trace = new CloudLiteTrace({ file: join(fresh(), 'native.jsonl'), url: `http://127.0.0.1:${coordinator.server.address().port}`,
    token: credentials['m0-a0'] });
  const traceIngest = coordinator.board.trace.bind(coordinator.board);
  try {
    trace.record('turn/started', { threadId, turn: { id: turnId } });
    trace.record('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { code: -32000, message: 'private failure' } } });
    coordinator.board.trace = () => { throw new Error('coordinator temporarily unavailable'); };
    await assert.rejects(trace.flush(), /refused/);
    assert.equal(trace.queue.length, 2);
    coordinator.board.trace = traceIngest;
    await trace.flush();
    let native = coordinator.board.inventory()[0].nativeRuntime;
    assert.equal(native.eventSequence, 2); assert.equal(native.turnStatus, 'failed');
    assert.deepEqual(native.failure, { category: 'turn_failed', errorCode: -32000 });
    trace.record('turn/started', { threadId, turn: { id: '01a13910-1da9-76a1-0a6e-af0c060ec3a4' } });
    await trace.flush();
    native = coordinator.board.inventory()[0].nativeRuntime;
    assert.equal(native.eventSequence, 3); assert.equal(native.turnStatus, 'inProgress');
    assert.equal(native.failure, undefined);
    assert.equal(coordinator.board.events(0, 3).length, 3);
    assert.doesNotMatch(JSON.stringify(native), /private failure/);
  } finally { coordinator.board.trace = traceIngest; await coordinator.close(); }
});

test('torn trace recovery preserves damaged bytes and never reuses a receiver-confirmed sequence', () => {
  const file = join(fresh(), 'trace.jsonl');
  const bytes = JSON.stringify({ seq: 1, kind: 'shell', body: { exit: 0 } }) + '\n' + '\0'.repeat(4096);
  writeFileSync(file, bytes); writeFileSync(file + '.ack', '\0');
  const trace = new CloudLiteTrace({ file, url: 'http://localhost', token: secret(), remoteSequence: 12 });
  assert.equal(trace.queue[0].kind, 'trace.recovery'); assert.equal(trace.queue[0].seq, 13);
  const evidence = trace.queue[0].body.preservedEvidence;
  assert.equal(existsSync(evidence), true); assert.equal(readFileSync(evidence, 'utf8'), bytes);
  assert.equal(trace.record('restarted', {}).seq, 14);
});
test('provider uncertainty stays held across controller restart without a second creation', async () => {
  const directory = fresh(); let calls = 0;
  const execute = async () => { calls++; throw new Error('Lost original provider response.'); };
  const options = { image: 'registry.example/image', githubToken: secret() };
  const auth = { read: () => ({ accessToken: secret(), chatgptAccountId: 'account' }) };
  const fleet = new FactoryCloudLiteFleet({ directory, execute, auth });
  await assert.rejects(fleet.deploy(plan(), options));
  const reopened = new FactoryCloudLiteFleet({ directory, execute, auth });
  await assert.rejects(reopened.deploy(plan(), options), /inspect the existing provider identity/);
  assert.equal(calls, 1); assert.equal(JSON.parse(readFileSync(join(directory, 'fleet.json'))).operations['app.create'].state, 'unknown');
});

test('fleet delegates immutable images to upstream Machines API and exposes no public worker service', async () => {
  const p = { ...plan(), machines: 2 }; const machines = []; const calls = [];
  const infrastructure = {
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'volumes') return JSON.stringify({ id: `vol_${machines.length}` });
      if (args[0] === 'machine') {
        assert.deepEqual(args.slice(0, 2), ['machine', 'list']);
        return JSON.stringify(machines);
      }
      return '';
    },
    buildMachineConfig: () => ({ init: { cmd: ['upstream-runtime'] }, services: [] }),
    createMachine: async ({ name, config }) => {
      assert.equal(config.image, 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64));
      assert.deepEqual(config.services, []);
      const machine = { id: `machine-${machines.length}`, name, config }; machines.push(machine); return machine;
    },
  };
  const fleet = new FactoryCloudLiteFleet({ directory: fresh(), infrastructure,
    auth: { read: () => ({ accessToken: secret(), chatgptAccountId: 'account' }) } });
  const result = await fleet.deploy(p, { image: 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64), githubToken: secret() });
  assert.equal(result.machines.length, 2);
  assert.equal(machines[1].config.env.FACTORY_BOARD_MACHINE_ID, machines[0].id);
  assert.equal(calls.some(args => ['deploy','ips','auth'].includes(args[0]) || args[0] === 'machine' && args[1] === 'run'), false);
});
test('authenticated HTTP board binds sender independently of client input', async () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()]));
  const coordinator = await startCloudLiteCoordinator({ database: join(fresh(), 'board.sqlite'), plan: p, credentials, operatorToken: secret(),
    auth: { accessToken: secret(), chatgptAccountId: 'account' }, githubToken: secret(), host: '127.0.0.1', port: 0 });
  try {
    const url = `http://127.0.0.1:${coordinator.server.address().port}`;
    assert.equal((await fetch(url + '/operator/status')).status, 401);
    const response = await fetch(url + '/tool', { method: 'POST', headers: { Authorization: `Bearer ${credentials['m0-a1']}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'factory_message', arguments: { sender: 'm0-a0', recipient: 'm1-a1', messageId: 'fake-role', message: {} } }) });
    assert.equal(response.status, 400);
  } finally { await coordinator.close(); }
});

test('evidence collection includes independent evidence roots and consistent WAL database content', async () => {
  const root = fresh(); const evidence = join(root, 'm8-evidence'); mkdirSync(evidence);
  writeFileSync(join(evidence, 'result.json'), '{"tests":54}');
  writeFileSync(join(evidence, 'duplicate-a'), 'identical-owned-evidence'); writeFileSync(join(evidence, 'duplicate-b'), 'identical-owned-evidence');
  writeFileSync(join(evidence, 'trace.jsonl'), '{"seq":1}\n{"seq":');
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'cache'), 'disposable');
  mkdirSync(join(root, 'repository', '.git', 'objects'), { recursive: true });
  writeFileSync(join(root, 'repository', '.git', 'HEAD'), 'public-source-revision'); writeFileSync(join(root, 'repository', '.git', 'objects', 'upstream-object'), 'cloned-history');
  writeFileSync(join(root, 'auth.json'), 'private-credential');
  const database = new DatabaseSync(join(root, 'board.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence(result TEXT); INSERT INTO evidence VALUES(\'passed\');');
  try {
    const destination = join(root, '.factory-export-test');
    const receipt = await collectCloudLiteSnapshot({ root, runId: 'lite-test', destination, includeGitObjects: false });
    assert.equal(receipt.sqliteBackups, 1); assert.equal(existsSync(receipt.archive), true);
    assert.ok(receipt.hardLinkedFiles > 0);
    assert.equal(statSync(join(destination, 'snapshot', 'm8-evidence', 'duplicate-a')).ino, statSync(join(destination, 'snapshot', 'm8-evidence', 'duplicate-b')).ino);
    assert.equal(readFileSync(join(destination, 'snapshot', 'm8-evidence', 'trace.jsonl'), 'utf8'), '{"seq":1}\n');
    const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json')));
    const fragment = manifest.files.find(file => file.preservedFrom === join('m8-evidence', 'trace.jsonl'));
    assert.equal(readFileSync(join(destination, 'snapshot', fragment.path), 'utf8'), '{"seq":');
    const retained = new DatabaseSync(join(destination, 'snapshot', 'board.sqlite'), { readOnly: true });
    try { assert.equal(retained.prepare('SELECT result FROM evidence').get().result, 'passed'); } finally { retained.close(); }
    assert.equal(existsSync(join(destination, 'snapshot', 'node_modules')), false);
    assert.equal(existsSync(join(destination, 'snapshot', 'auth.json')), false);
    assert.equal(existsSync(join(destination, 'snapshot', 'repository', '.git', 'objects')), false);
    assert.equal(readFileSync(join(destination, 'snapshot', 'repository', '.git', 'HEAD'), 'utf8'), 'public-source-revision');
    assert.equal(readFileSync(join(destination, 'snapshot', 'm8-evidence', 'result.json'), 'utf8'), '{"tests":54}');
    const firstArchive = readFileSync(receipt.archive);
    const second = await collectCloudLiteSnapshot({ root, runId: 'lite-test', includeGitObjects: false });
    assert.notEqual(second.archive, receipt.archive);
    assert.deepEqual(readFileSync(receipt.archive), firstArchive);
  } finally { database.close(); }
});

test('a new stop supersedes older work but replaying that stop preserves a later explicit message', async () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()])); const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(fresh(), 'board.sqlite'), plan: p, credentials, operatorToken,
    auth: { accessToken: secret(), chatgptAccountId: 'account' }, githubToken: secret(), host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const request = async (path, body, token = operatorToken) => {
    const response = await fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  try {
    await request('/operator/command', { id: 'old-work', recipient: 'm0-a0', action: 'message', message: 'Review PR' });
    const stop = { id: 'stop-work', recipient: 'm0-a0', action: 'stop' };
    await request('/operator/command', stop);
    let inbox = await request('/commands', {}, credentials['m0-a0']); assert.deepEqual(inbox.commands.map(command => command.id), ['stop-work']);
    assert.equal(coordinator.board.db.prepare('SELECT superseded_by FROM cloud_lite_command_cancellations WHERE command_id=?').get('old-work').superseded_by, 'stop-work');
    await request('/commands', { acknowledge: 'stop-work' }, credentials['m0-a0']);
    await request('/operator/command', { id: 'new-work', recipient: 'm0-a0', action: 'message', message: 'Resume review' });
    await request('/operator/command', stop);
    inbox = await request('/commands', {}, credentials['m0-a0']); assert.deepEqual(inbox.commands.map(command => command.id), ['new-work']);
  } finally { await coordinator.close(); }
});

test('retirement refuses an app containing a Machine absent from the original fleet journal', async () => {
  let destroyed = false; const original = { id: 'original', name: 'owned', volumeId: 'volume-one' };
  const fleet = new FactoryCloudLiteFleet({ directory: fresh(), execute: async (_command, args) => {
    if (args[0] === 'machine') return JSON.stringify([{ id: 'original', name: 'owned', config: { metadata: { 'factory.run': 'lite-test' }, mounts: [{ volume: 'volume-one' }] } }, { id: 'other' }]);
    if (args[0] === 'volumes') return JSON.stringify([{ id: 'volume-one' }]);
    destroyed = true; return '';
  } });
  fleet.state = { plan: plan(), machines: [original], operations: {} }; fleet.save();
  await assert.rejects(fleet.retire(), /exact original Machine and volume inventory/); assert.equal(destroyed, false);
});

test('an incomplete download is retained while a new destination receives verified archive bytes', async () => {
  const directory = fresh(); mkdirSync(join(directory, 'artifacts'));
  const partial = join(directory, 'artifacts', 'original-default.tgz'); writeFileSync(partial, 'partial');
  const originalBytes = readFileSync(partial); const archive = Buffer.from('complete-private-evidence');
  const receipt = { state: 'completed', archive: '/data/evidence.tgz', bytes: archive.length, sha256: hash(archive) };
  const fleet = new FactoryCloudLiteFleet({ directory, execute: async (_command, args) => {
    if (args[0] === 'machine') return JSON.stringify(receipt);
    assert.deepEqual(args.slice(0, 3), ['ssh', 'sftp', 'get']); writeFileSync(args[4], archive); return '';
  } });
  fleet.state = { plan: { ...plan(), machines: 1 }, machines: [{ id: 'original' }], operations: {} }; fleet.save();
  fleet.quiesce = async () => ({ agents: 10 });
  await fleet.collect({ concurrency: 1 });
  assert.deepEqual(readFileSync(partial), originalBytes);
  assert.notEqual(fleet.state.artifacts[0].file, partial);
  assert.deepEqual(readFileSync(fleet.state.artifacts[0].file), archive);
  assert.equal(fleet.state.partialDownloads[0].file, partial);
});

test('selective collection retains verified peers and distinguishes partial from full collection', async () => {
  const directory = fresh(); const archive = Buffer.from('one-machine-evidence');
  const providerReceipt = { state: 'completed', archive: '/data/evidence.tgz', bytes: archive.length, sha256: hash(archive) };
  const fleet = new FactoryCloudLiteFleet({ directory, execute: async (_command, args) => {
    if (args[0] === 'machine') return JSON.stringify(providerReceipt);
    writeFileSync(args[4], archive); return '';
  } });
  fleet.state = { plan: { ...plan(), machines: 2 }, machines: [{ id: 'first' }, { id: 'second' }], operations: {} }; fleet.save();
  fleet.quiesce = async () => ({ agents: 20 });
  const partial = await fleet.collect({ machineIds: ['first'], concurrency: 1 });
  assert.equal(partial.complete, false); assert.equal(partial.collected, 1); assert.equal(fleet.state.artifactsCollectedAt, undefined);
  const first = fleet.state.artifacts[0];
  const full = await fleet.collect({ machineIds: ['second'], concurrency: 1 });
  assert.equal(full.complete, true); assert.equal(full.collected, 2); assert.ok(fleet.state.artifacts.some(receipt => receipt.file === first.file));
  assert.deepEqual(readFileSync(first.file), archive);
});
