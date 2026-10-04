import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FactoryControl, digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { createWorkerPowerController } from '../src/worker-power.mjs';
import { nativeMissionRequest } from '../src/native-mission-contract.mjs';
import { createPresentationServer } from '../src/presentation.mjs';
import { createNativeCell } from '../src/native-cell.mjs';
import { runNativeMission } from '../src/native-mission.mjs';

const flyToken = 'synthetic-fly-token-never-valid-at-provider', workerToken = 'synthetic-worker-token-never-valid-at-provider';
const compatibility = { applicationVersion: '3.46.2', snapshotFormatVersion: 2, layoutVersion: 2,
  workerProtocolVersion: 1, revision: '549792e1839931e862e6a305eb0d9ce2b82ae905' };
const origin = 'http://127.0.0.1:43445';
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function fixture(t, { enroll = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-power-'));
  let now = 1791028800000;
  const controls = new Set(), open = () => {
    const control = new FactoryControl(path.join(directory, 'control.sqlite'), { clock: () => now });
    controls.add(control); return control;
  };
  let control = open();
  const paid = new SpendingLedger(path.join(directory, 'paid.sqlite'), { clock: () => now });
  t.after(() => { for (const value of controls) value.close(); paid.close(); });
  control.initialize({ mission: 'Owned power fixture', budgetCents: 10000, maxCells: 4, maxDepth: 2 });
  paid.initialize({ limitCents: 10000, currency: 'USD' });
  control.reserveCell({ cellId: 'child', role: 'developer', budgetCents: 1000, purpose: 'Owned scale-to-zero worker' });
  control.createTask({ taskId: 'manage', projectId: 'factory', branch: 'codex/manage',
    specification: { problem: 'Manage owned worker power', acceptance: ['observe owned state'], baseline: 'fixture' } });
  const lease = control.claimTask('manage', 'root', 600000);
  control.admitEffect(lease, { key: 'provision', kind: 'provision', request: { cellId: 'child', app: 'factory-child' } });
  control.startEffect(lease, 'provision');
  control.settleEffect('provision', 'succeeded', { worker: 'factory-child', app: 'factory-child', state: 'ready' });
  control.enrollCell('child');
  const worker = { workspace: 'power', archiveSha256: 'a'.repeat(64), compatibility };
  const machine = { id: 'owned-machine', instance_id: 'owned-instance-1', name: 'owned-worker', state: 'started',
    image_ref: { digest: 'sha256:' + 'b'.repeat(64) }, config: {
      image: 'registry.example/owned@sha256:' + 'b'.repeat(64), metadata: { flujo_cloud_owner: '01234567-89ab-cdef-0123-456789abcdef' },
      env: { FLUJO_WORKER_SNAPSHOT_SHA256: worker.archiveSha256 }, services: [],
      mounts: [{ path: '/data', volume: 'owned-volume' }], restart: { policy: 'no' }, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
    } };
  const binding = { schemaVersion: 1, cellId: 'child', app: 'factory-child', provisionKey: 'provision',
    machineId: machine.id, instanceId: machine.instance_id, machineName: machine.name,
    owner: machine.config.metadata.flujo_cloud_owner, imageDigest: machine.image_ref.digest,
    configSha256: digest(machine.config), worker };
  const status = { mode: 'worker', state: 'ready', workspace: worker.workspace, archiveSha256: worker.archiveSha256 };
  const info = { workspace: worker.workspace, capability: 'available', activeOperation: null, workerCompatibility: compatibility };
  const calls = []; let hook = null, lose = false, machineResponse = null, workerStatus = 200;
  async function fetchImpl(input, options) {
    const url = new URL(input), method = options.method ?? 'GET';
    const record = { origin: url.origin, path: url.pathname, method, body: options.body ? JSON.parse(options.body) : null };
    calls.push(record);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    if (url.origin === 'https://api.machines.dev') {
      assert.equal(options.headers.authorization, 'Bearer ' + flyToken);
      assert.equal(url.pathname.startsWith('/v1/apps/factory-child/machines/owned-machine'), true);
      await hook?.(record);
      if (method === 'POST') {
        assert.ok(['/v1/apps/factory-child/machines/owned-machine/start', '/v1/apps/factory-child/machines/owned-machine/stop'].includes(url.pathname));
        machine.state = url.pathname.endsWith('/start') ? 'started' : 'stopped';
        if (lose) throw new Error('Synthetic lost response containing a secret must not escape');
        return response({});
      }
      assert.equal(method, 'GET'); return machineResponse instanceof Response ? machineResponse.clone() : response(machineResponse ?? structuredClone(machine));
    }
    assert.equal(url.origin, origin); assert.equal(options.headers.authorization, 'Bearer ' + workerToken);
    assert.equal(options.headers['x-flujo-workspace'], worker.workspace); assert.equal(url.searchParams.get('workspace'), worker.workspace);
    assert.equal(method, 'GET'); await hook?.(record);
    return response(structuredClone(url.pathname === '/api/worker/status' ? status : info), workerStatus);
  }
  const client = () => createWorkerPowerController({ control, paidAdmission: paid, binding, flyToken, workerToken,
    workerOrigin: origin, fetchImpl, timeoutMs: 1000 });
  if (enroll) await client().enroll(lease);
  calls.length = 0;
  function task(taskId = 'develop', { ceilingCents = 500 } = {}) {
    return control.createTask({ taskId, projectId: 'factory', branch: 'codex/' + taskId, specification: {
      problem: 'Improve FLUJO', acceptance: ['independent review'], baseline: 'fixture', nativeMission: {
        schemaVersion: 1, missionId: digest(taskId).slice(0, 32), cellId: 'child', app: binding.app, provisionKey: 'provision',
        worker, flowId: 'flow', flowSha256: 'c'.repeat(64), paid: { provider: 'fly', ceilingCents },
      } } });
  }
  const claim = taskId => {
    const value = control.task(taskId);
    return control.claimNativeMission({ taskId, expectedSpecDigest: value.spec_digest,
      expectedFactoryEpoch: control.control().epoch, workerProof: worker, ttlMs: 1000 });
  };
  return { directory, paid, lease, machine, binding, status, info, calls, task, claim, client,
    get control() { return control; }, get posts() { return calls.filter(c => c.method === 'POST'); },
    hook(value) { hook = value; }, lose(value = true) { lose = value; }, machineResponse(value) { machineResponse = value; },
    workerStatus(value) { workerStatus = value; }, advance(ms) { now += ms; }, reopen() { control = open(); },
    execute(input) { return client().execute(lease, input); },
  };
}

test('construction is inert; explicit enrollment binds actual owned provision and raw readiness', async t => {
  const f = await fixture(t, { enroll: false });
  f.client(); assert.equal(f.calls.length, 0);
  f.machineResponse({ owned: true, ready: true });
  await assert.rejects(f.client().enroll(f.lease), { code: 'WORKER_POWER_IDENTITY' });
  assert.throws(() => f.control.workerPowerBinding(f.binding.app), { code: 'WORKER_POWER_ENROLLMENT' });
  f.machineResponse(null); await f.client().enroll(f.lease);
  assert.deepEqual(f.control.workerPowerBinding(f.binding.app), f.binding);
  assert.throws(() => f.control.enrollWorkerPower(f.lease, { ...f.binding, instanceId: 'other' }), { code: 'CONFLICT' });
  assert.throws(() => createWorkerPowerController({ control: {}, paidAdmission: f.paid }), { code: 'WORKER_POWER_AUTHORITY' });
  assert.throws(() => createWorkerPowerController({ control: f.control, paidAdmission: f.paid, binding: f.binding,
    flyToken, workerToken, workerOrigin: 'https://public.example', fetchImpl: async () => {} }), { code: 'WORKER_POWER_BINDING' });
  assert.equal(f.posts.length, 0);
});

test('sleep and wake are separate owned effects; stopping retains allowance and fences native claims', async t => {
  const f = await fixture(t); f.task();
  f.paid.reserve({ reservationId: 'original-worker', provider: 'fly', ceilingCents: 4000 }); f.paid.start('original-worker');
  const before = f.paid.snapshot();
  const slept = await f.execute({ key: 'sleep-1', action: 'sleep' });
  assert.equal(slept.effect.kind, 'worker_sleep'); assert.equal(slept.effect.state, 'succeeded');
  assert.equal(slept.effect.scope, 'worker'); assert.equal(f.machine.state, 'stopped');
  assert.deepEqual(f.posts[0].body, { signal: 'SIGTERM', timeout: '20' });
  assert.deepEqual(f.paid.snapshot(), before); assert.equal(f.control.status().cells.find(c => c.id === 'child').status, 'ready');
  assert.throws(() => f.claim('develop'), { code: 'WORKER_POWER_UNAVAILABLE' });
  assert.throws(() => f.control.claimTask('develop', 'child'), { code: 'WORKER_POWER_UNAVAILABLE' });
  const woke = await f.execute({ key: 'wake-1', action: 'wake', ceilingCents: 500 });
  assert.equal(woke.effect.kind, 'worker_wake'); assert.equal(woke.effect.state, 'succeeded');
  assert.equal(woke.productionQualified, false); assert.equal(woke.queuePowerScheduling, false);
  assert.deepEqual(f.posts[1].body, {}); assert.equal(f.paid.row('power.wake-1').state, 'started');
  assert.equal(f.paid.snapshot().committedCents, 4500); assert.equal(f.claim('develop').cellId, 'child');
  assert.equal((await f.execute({ key: 'wake-1', action: 'wake', ceilingCents: 500 })).dispatched, false);
  assert.equal(f.posts.length, 2);
  assert.equal(JSON.stringify(woke).includes(flyToken), false); assert.equal(JSON.stringify(woke).includes(workerToken), false);
});

for (const reason of ['factory-paused', 'paid-paused', 'free-zero']) {
  test('new wake refuses ' + reason + ' before intent, allowance or provider mutation', async t => {
    const f = await fixture(t); f.machine.state = 'stopped';
    if (reason === 'factory-paused') f.control.pause();
    if (reason === 'paid-paused') f.paid.pauseAdmission();
    if (reason === 'free-zero') {
      f.paid.reserve({ reservationId: 'held', provider: 'modal', ceilingCents: 10000 }); f.paid.start('held');
      f.paid.retire('held', { evidenceDigest: 'd'.repeat(64) });
    }
    await assert.rejects(f.execute({ key: 'wake-blocked', action: 'wake', ceilingCents: 500 }));
    assert.equal(f.posts.length, 0); assert.equal(f.calls.length, 0);
    assert.equal(f.control.db.prepare("SELECT count(*) n FROM effects WHERE scope='worker'").get().n, 0);
    assert.equal(f.paid.rows().length, reason === 'free-zero' ? 1 : 0);
  });
}

for (const change of ['instance', 'owner', 'config', 'image', 'archive', 'public-service']) {
  test('changed ' + change + ' rejects power before POST', async t => {
    const f = await fixture(t);
    if (change === 'instance') f.machine.instance_id = 'foreign-version';
    if (change === 'owner') f.machine.config.metadata.flujo_cloud_owner = 'fedcba98-7654-3210-fedc-ba9876543210';
    if (change === 'config') f.machine.config.guest.memory_mb = 1024;
    if (change === 'image') f.machine.image_ref.digest = 'sha256:' + 'e'.repeat(64);
    if (change === 'archive') f.machine.config.env.FLUJO_WORKER_SNAPSHOT_SHA256 = 'e'.repeat(64);
    if (change === 'public-service') f.machine.config.services.push({ ports: [{ port: 80 }] });
    const r = await f.execute({ key: 'sleep-refused', action: 'sleep' });
    assert.equal(r.effect.state, 'not_applied'); assert.equal(f.posts.length, 0);
  });
}

for (const change of ['auth', 'active-operation', 'compatibility', 'workspace']) {
  test('authenticated readiness refuses ' + change + ' before sleep', async t => {
    const f = await fixture(t);
    if (change === 'auth') f.workerStatus(401);
    if (change === 'active-operation') f.info.activeOperation = { id: 'unknown-flow' };
    if (change === 'compatibility') f.info.workerCompatibility = { ...compatibility, revision: 'e'.repeat(40) };
    if (change === 'workspace') f.status.workspace = 'foreign';
    const r = await f.execute({ key: 'sleep-refused', action: 'sleep' });
    assert.equal(r.effect.state, 'not_applied'); assert.equal(f.posts.length, 0);
  });
}

for (const action of ['sleep', 'wake']) {
  test(action + ' lost response is durable; same key cannot repeat and paused observation resolves', async t => {
    const f = await fixture(t); f.machine.state = action === 'wake' ? 'stopped' : 'started'; f.lose();
    const input = { key: action + '-lost', action, ...(action === 'wake' ? { ceilingCents: 500 } : {}) };
    const first = await f.execute(input); assert.equal(first.effect.state, 'unknown'); assert.equal(first.dispatched, true);
    f.reopen(); f.control.pause(); f.paid.pauseAdmission();
    assert.equal((await f.execute(input)).effect.state, 'unknown'); assert.equal(f.posts.length, 1);
    assert.equal((await f.client().observe(input.key)).effect.state, 'succeeded'); assert.equal(f.posts.length, 1);
    assert.equal(f.paid.rows().length, action === 'wake' ? 1 : 0);
    if (action === 'wake') assert.equal(f.paid.row('power.' + input.key).state, 'started');
  });
}

test('unresolved power blocks replacement keys, lease takeover, retirement and task submission', async t => {
  const f = await fixture(t); f.lose(); await f.execute({ key: 'sleep-lost', action: 'sleep' });
  await assert.rejects(f.execute({ key: 'sleep-replacement', action: 'sleep' }), { code: 'WORKER_POWER_BUSY' });
  assert.throws(() => f.control.admitOwnedRetirement({ key: 'retire', app: f.binding.app }), { code: 'UNRECONCILED' });
  const artifact = path.join(f.directory, 'candidate.json'); await fs.writeFile(artifact, '{}', { flag: 'wx' });
  assert.throws(() => f.control.submit(f.lease, { artifactPath: artifact }), { code: 'UNRECONCILED' });
  f.advance(600001); assert.throws(() => f.control.claimTask('manage', 'root'), { code: 'UNRECONCILED' });
  assert.equal(f.posts.length, 1);
});

test('pending or foreign observation stays unknown and cannot release native dispatch', async t => {
  const f = await fixture(t); f.task(); f.lose(); await f.execute({ key: 'sleep-lost', action: 'sleep' });
  f.machine.state = 'started'; assert.equal((await f.client().observe('sleep-lost')).effect.state, 'unknown');
  f.machine.state = 'stopped'; f.machine.instance_id = 'foreign';
  assert.equal((await f.client().observe('sleep-lost')).effect.state, 'unknown');
  assert.throws(() => f.claim('develop'), { code: 'WORKER_POWER_UNAVAILABLE' });
  assert.equal(f.posts.length, 1);
});

test('wake response without matching ready worker remains unknown until a later authenticated observation', async t => {
  const f = await fixture(t); f.machine.state = 'stopped'; f.status.state = 'bootstrapping';
  const r = await f.execute({ key: 'wake-not-ready', action: 'wake', ceilingCents: 500 });
  assert.equal(r.effect.state, 'unknown'); assert.equal(f.posts.length, 1); f.control.pause(); f.paid.pauseAdmission();
  assert.equal((await f.client().observe('wake-not-ready')).effect.state, 'unknown');
  f.status.state = 'ready'; assert.equal((await f.client().observe('wake-not-ready')).effect.state, 'succeeded');
  assert.equal(f.posts.length, 1); assert.equal(f.paid.snapshot().committedCents, 500);
});

test('a fresh power key cannot adopt an independently retained paid reservation', async t => {
  const f = await fixture(t); f.machine.state = 'stopped';
  f.paid.reserve({ reservationId: 'power.wake-other', provider: 'fly', ceilingCents: 500 }); f.paid.start('power.wake-other');
  await assert.rejects(f.execute({ key: 'wake-other', action: 'wake', ceilingCents: 500 }), { code: 'WORKER_POWER_HISTORY' });
  assert.equal(f.posts.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.control.db.prepare("SELECT count(*) n FROM effects WHERE scope='worker'").get().n, 0);
  assert.equal(f.paid.snapshot().committedCents, 500);
});

test('another actual ledger owner wins the reservation race; fresh wake refuses rather than borrowing it', async t => {
  const f = await fixture(t); f.machine.state = 'stopped';
  const other = new SpendingLedger(path.join(f.directory, 'paid.sqlite'));
  t.after(() => other.close());
  const fresh = f.paid.reserveFresh.bind(f.paid);
  f.paid.reserveFresh = input => { other.reserve(input); return fresh(input); };
  const r = await f.execute({ key: 'wake-raced', action: 'wake', ceilingCents: 500 });
  assert.equal(r.dispatched, false); assert.equal(r.effect.state, 'not_applied'); assert.equal(f.posts.length, 0);
  assert.equal(other.row('power.wake-raced').state, 'reserved');
  assert.equal(f.paid.snapshot().committedCents, 500);
  assert.throws(() => f.paid.reserveFresh({ reservationId: 'power.wake-raced', provider: 'fly', ceilingCents: 500 }), { code: 'CONFLICT' });
  assert.equal(f.paid.reserve({ reservationId: 'power.wake-raced', provider: 'fly', ceilingCents: 500 }).state, 'reserved');
});

test('paused paid gate immediately before callback refuses POST after durable start, retaining uncertain original intent', async t => {
  const f = await fixture(t); f.machine.state = 'stopped';
  const start = f.control.startWorkerPowerEffect.bind(f.control);
  f.control.startWorkerPowerEffect = (lease, key, dispatch) => start(lease, key, () => { f.paid.pauseAdmission(); return dispatch(); });
  const r = await f.execute({ key: 'wake-paid-final', action: 'wake', ceilingCents: 500 });
  assert.equal(r.dispatched, false); assert.equal(r.effect.state, 'unknown'); assert.equal(f.posts.length, 0);
  assert.equal(f.paid.snapshot().committedCents, 500);
  assert.equal((await f.client().observe('wake-paid-final')).effect.state, 'unknown');
  assert.throws(() => f.control.startEffect(f.lease, r.effect.key), { code: 'EFFECT' });
});

test('sleep refuses live native lease and unknown Flow even after lease expiry', async t => {
  const f = await fixture(t); f.task(); const lease = f.claim('develop');
  await assert.rejects(f.execute({ key: 'sleep-live', action: 'sleep' }), { code: 'WORKER_POWER_BUSY' });
  const admitted = f.control.admitNativeMissionEffect(lease, nativeMissionRequest(f.control.task('develop'), lease, path.join(f.directory, 'out.json')));
  f.control.settleEffect(admitted.effect.key, 'unknown'); f.advance(1001);
  await assert.rejects(f.execute({ key: 'sleep-unknown', action: 'sleep' }), { code: 'WORKER_POWER_BUSY' });
  assert.equal(f.calls.length, 0); assert.equal(f.posts.length, 0);
});

test('accepted sleep fences a competing native claim during async transport reads', async t => {
  const f = await fixture(t); f.task(); let fenced = 0;
  f.hook(record => { if (record.method === 'GET') { assert.throws(() => f.claim('develop'), { code: 'WORKER_POWER_UNAVAILABLE' }); fenced++; } });
  assert.equal((await f.execute({ key: 'sleep-once', action: 'sleep' })).effect.state, 'succeeded');
  assert.ok(fenced >= 2); assert.equal(f.posts.length, 1); assert.equal(f.control.task('develop').status, 'ready');
});

for (const gate of ['factory', 'paid']) {
  test('pause ' + gate + ' during awaited prepare fences wake POST and retains any committed allowance', async t => {
    const f = await fixture(t); f.machine.state = 'stopped'; let reads = 0;
    f.hook(record => { if (record.method === 'GET' && ++reads === 2) {
      if (gate === 'factory') f.control.pause(); else f.paid.pauseAdmission();
    } });
    const r = await f.execute({ key: 'wake-fenced', action: 'wake', ceilingCents: 500 });
    assert.equal(r.dispatched, false); assert.equal(r.effect.state, 'not_applied'); assert.equal(f.posts.length, 0);
    assert.equal(f.paid.snapshot().committedCents, gate === 'factory' ? 500 : 0);
  });
}

test('running intent is externally durable before POST; rollback after POST retains unknown', async t => {
  const f = await fixture(t); f.machine.state = 'stopped';
  const original = f.control.db.exec.bind(f.control.db); let failCommit = false;
  f.control.db.exec = sql => { if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('Owned fixture final COMMIT failure'); } return original(sql); };
  f.hook(record => { if (record.method === 'POST') {
    const other = new DatabaseSync(path.join(f.directory, 'control.sqlite'), { readOnly: true });
    try { assert.equal(other.prepare('SELECT state FROM effects WHERE key=?').get('wake-durable').state, 'running'); }
    finally { other.close(); }
    failCommit = true;
  } });
  const r = await f.execute({ key: 'wake-durable', action: 'wake', ceilingCents: 500 });
  f.control.db.exec = original;
  assert.equal(r.dispatched, true); assert.equal(r.effect.state, 'unknown'); assert.equal(f.posts.length, 1);
  f.hook(null); f.reopen(); assert.equal((await f.client().observe('wake-durable')).effect.state, 'succeeded');
  assert.equal((await f.execute({ key: 'wake-durable', action: 'wake', ceilingCents: 500 })).dispatched, false);
  assert.equal(f.posts.length, 1); assert.equal(f.paid.row('power.wake-durable').state, 'started');
});

test('lost response combined with post-dispatch commit failure keeps one observed attempt without unhandled rejection', async t => {
  const f = await fixture(t); f.machine.state = 'stopped'; f.lose();
  const exec = f.control.db.exec.bind(f.control.db); let fail = false;
  f.control.db.exec = sql => { if (sql === 'COMMIT' && fail) { fail = false; throw new Error('Synthetic COMMIT failure'); } return exec(sql); };
  f.hook(record => { if (record.method === 'POST') fail = true; });
  const result = await f.execute({ key: 'wake-double-failure', action: 'wake', ceilingCents: 500 });
  f.control.db.exec = exec; await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.effect.state, 'unknown'); assert.equal(f.posts.length, 1);
  f.hook(null); assert.equal((await f.client().observe(result.effect.key)).effect.state, 'succeeded');
  assert.equal(f.posts.length, 1);
});

test('accepted-undispatched crash intent never repeats and blocks both native and retirement admission', async t => {
  const f = await fixture(t); f.task();
  f.control.admitWorkerPower(f.lease, { key: 'sleep-crash', request: { app: f.binding.app, bindingDigest: digest(f.binding), action: 'sleep', paid: null } });
  assert.equal((await f.execute({ key: 'sleep-crash', action: 'sleep' })).effect.state, 'accepted');
  assert.equal((await f.client().observe('sleep-crash')).effect.state, 'accepted');
  assert.throws(() => f.claim('develop'), { code: 'WORKER_POWER_UNAVAILABLE' });
  f.control.createTask({ taskId: 'retire', projectId: 'factory', branch: 'codex/retire', specification: {
    problem: 'Retire', acceptance: { scope: 'recorded-controller-operation-receipts-only' }, baseline: 'fixture', taskType: 'operation',
    operation: { kind: 'retire', cellId: 'child', app: f.binding.app },
  } });
  const lease = f.control.claimTask('retire', 'root');
  assert.throws(() => f.control.admitEffect(lease, { key: 'retire', kind: 'retire',
    request: { cellId: 'child', app: f.binding.app, provisionKey: 'provision' } }), { code: 'UNRECONCILED' });
  await assert.rejects(f.client().execute(lease, { key: 'sleep-other', action: 'sleep' }), { code: 'OPERATION_BINDING' });
  assert.equal(f.calls.length, 0); assert.equal(f.posts.length, 0);
});

test('native queue reports sleeping worker as blocked; after wake the original Flow is still sent once', async t => {
  const f = await fixture(t); const task = f.task();
  await f.execute({ key: 'sleep-queue', action: 'sleep' });
  let flowPosts = 0;
  const client = { binding: f.binding.worker, async prepare() {}, async observe() { return { state: 'absent', body: null }; },
    async dispatch(input, { admitPost }) {
      await admitPost(() => { flowPosts++; return Promise.resolve(); });
      return { state: 'completed', body: JSON.stringify({ id: input.conversationId, flowId: input.flowId,
        status: 'completed', messages: [{ role: 'assistant', content: 'owned synthetic candidate' }] }) };
    } };
  const privateFiles = { ensurePrivateDirectory: async p => fs.mkdir(p, { recursive: true }),
    readPrivateJson: async p => JSON.parse(await fs.readFile(p, 'utf8')),
    writePrivateJson: async (p, value) => fs.writeFile(p, JSON.stringify(value), { flag: 'wx', mode: 0o600 }) };
  const outputDirectory = path.join(f.directory, 'outputs');
  const cell = createNativeCell({ control: f.control, paidAdmission: f.paid, client, privateFiles, profile: {
    cellId: 'child', app: f.binding.app, provisionKey: 'provision', worker: f.binding.worker,
    outputDirectory, ttlMs: 1000, pollMs: 100,
  } });
  assert.deepEqual(await cell.tick(), { state: 'blocked', reason: 'worker_power_unavailable' });
  assert.equal(flowPosts, 0);
  await f.execute({ key: 'wake-queue', action: 'wake', ceilingCents: 500 });
  const lease = f.claim(task.id), outputFile = path.join(outputDirectory, task.specification.nativeMission.missionId + '.private.json');
  const run = () => runNativeMission({ control: f.control, paidAdmission: f.paid, client, privateFiles, lease, outputFile });
  assert.equal((await run()).effect.state, 'succeeded'); assert.equal((await run()).dispatched, false);
  assert.equal(flowPosts, 1); assert.equal(f.posts.length, 2);
});

test('presentation exposes typed power state without tokens, config, receipts or enrollment detail', async t => {
  const f = await fixture(t); await f.execute({ key: 'sleep-visible', action: 'sleep' });
  const token = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const server = createPresentationServer({ databasePath: path.join(f.directory, 'control.sqlite'), factoryId: 'fixture', token });
  let payload = null;
  await server.emit('request', { url: '/v1/snapshot', method: 'GET', headers: { authorization: 'Bearer ' + token } }, {
    writeHead(code) { assert.equal(code, 200); }, end(body) { payload = JSON.parse(body); },
  });
  // The handler is async but only reads local SQLite; await its response, without opening a server/socket.
  for (let i = 0; payload === null && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(payload); assert.equal(payload.snapshot.effects.find(row => row.key === 'sleep-visible').kind, 'worker_sleep');
  const encoded = JSON.stringify(payload);
  for (const secret of [flyToken, workerToken, f.binding.owner, f.binding.machineId, 'configSha256', 'receipt', 'bindingDigest']) assert.equal(encoded.includes(secret), false, secret);
});

for (const failure of ['malformed-json', 'fetch-error']) {
  test('enrollment with ' + failure + ' exposes only a content-free HTTP refusal', async t => {
    const f = await fixture(t, { enroll: false });
    if (failure === 'malformed-json') f.machineResponse(new Response(flyToken, { headers: { 'content-type': 'application/json' } }));
    else f.hook(() => { throw new Error(workerToken); });
    await assert.rejects(f.client().enroll(f.lease), error => {
      assert.equal(error.code, 'WORKER_POWER_HTTP');
      assert.equal(error.message, 'Worker power operation refused.');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(error.stack.includes('synthetic-'), false);
      return true;
    });
    assert.equal(f.posts.length, 0);
    assert.throws(() => f.control.workerPowerBinding(f.binding.app), { code: 'WORKER_POWER_ENROLLMENT' });
  });
}

function queueCell(f, { power = f.client(), ceilingCents = 100 } = {}) {
  const calls = { posts: 0, prepares: 0, observes: 0 };
  const client = { binding: f.binding.worker,
    async prepare() { calls.prepares++; },
    async observe() { calls.observes++; return { state: 'absent', body: null }; },
    async dispatch(input, { admitPost }) {
      await admitPost(() => { calls.posts++; return Promise.resolve(); });
      return { state: 'completed', body: JSON.stringify({ id: input.conversationId, flowId: input.flowId,
        status: 'completed', messages: [{ role: 'assistant', content: 'queue fixture result' }] }) };
    },
  };
  const privateFiles = { ensurePrivateDirectory: async p => fs.mkdir(p, { recursive: true }),
    readPrivateJson: async p => JSON.parse(await fs.readFile(p, 'utf8')),
    writePrivateJson: async (p, value) => fs.writeFile(p, JSON.stringify(value), { flag: 'wx', mode: 0o600 }) };
  return { calls, power, cell: createNativeCell({ control: f.control, paidAdmission: f.paid, client, privateFiles,
    profile: { cellId: 'child', app: f.binding.app, provisionKey: 'provision', worker: f.binding.worker,
      outputDirectory: path.join(f.directory, 'queue-outputs'), ttlMs: 1000, pollMs: 100 },
    powerScheduling: { controller: power, managementLease: f.lease, wakeCeilingCents: ceilingCents } }) };
}

test('opt-in queue sleeps idle, restarts without replay, wakes exact demand and dispatches one native Flow', async t => {
  const f = await fixture(t); let q = queueCell(f);
  const sleep = await q.cell.tick(); assert.equal(sleep.state, 'power_transition');
  assert.equal(f.machine.state, 'stopped'); assert.equal(f.posts.length, 1); assert.equal(f.paid.rows().length, 0);
  f.reopen(); q = queueCell(f);
  assert.deepEqual(await q.cell.tick(), { state: 'sleeping' }); assert.equal(f.posts.length, 1);
  f.task(); const wake = await q.cell.tick(); assert.equal(wake.state, 'power_transition');
  assert.notEqual(wake.key, sleep.key); assert.equal(f.machine.state, 'started'); assert.equal(f.posts.length, 2);
  assert.equal(f.paid.row('power.' + wake.key).ceiling_cents, 100);
  assert.equal((await q.cell.tick()).state, 'dispatched'); assert.equal(q.calls.posts, 1);
  assert.equal((await q.cell.tick()).state, 'awaiting_review'); assert.equal(q.calls.posts, 1); assert.equal(f.posts.length, 2);
  await assert.rejects(q.power.schedule(f.lease, { wakeCeilingCents: 100 }), { code: 'WORKER_POWER_BUSY' });
});

test('queue power construction refuses a fabricated controller or a different local spending authority', async t => {
  const f = await fixture(t);
  assert.throws(() => queueCell(f, { power: { binding: f.binding, schedule() {}, reconcile() {} } }), { code: 'WORKER_POWER_AUTHORITY' });
  const other = new SpendingLedger(path.join(f.directory, 'other-paid.sqlite'));
  t.after(() => other.close()); other.initialize({ limitCents: 10000, currency: 'USD' });
  const power = createWorkerPowerController({ control: f.control, paidAdmission: other, binding: f.binding,
    flyToken, workerToken, workerOrigin: origin, fetchImpl: () => { throw new Error('never called'); } });
  assert.throws(() => queueCell(f, { power }), { code: 'WORKER_POWER_AUTHORITY' }); assert.equal(f.calls.length, 0);
});

test('irrelevant queued tuples and ordinary tasks do not wake a sleeping worker', async t => {
  const f = await fixture(t); const q = queueCell(f); await q.cell.tick();
  f.control.createTask({ taskId: 'ordinary', projectId: 'factory', branch: 'codex/ordinary',
    specification: { problem: 'unrelated', acceptance: ['review'], baseline: 'fixture' } });
  for (const [taskId, override] of [['other-cell', { cellId: 'other' }], ['other-app', { app: 'factory-other' }],
    ['other-provision', { provisionKey: 'other-provision' }], ['other-worker', { worker: { ...f.binding.worker, archiveSha256: 'e'.repeat(64) } }]]) {
    f.control.createTask({ taskId, projectId: 'factory', branch: 'codex/' + taskId, specification: {
      problem: 'unrelated worker', acceptance: ['review'], baseline: 'fixture', nativeMission: {
        schemaVersion: 1, missionId: digest(taskId).slice(0, 32), cellId: 'child', app: f.binding.app, provisionKey: 'provision',
        worker: f.binding.worker, flowId: 'flow', flowSha256: 'c'.repeat(64), paid: { provider: 'fly', ceilingCents: 500 }, ...override } } });
  }
  assert.deepEqual(await q.cell.tick(), { state: 'sleeping' });
  assert.equal(f.posts.length, 1); assert.equal(q.calls.posts, 0); assert.equal(f.paid.rows().length, 0);
});

test('new ready demand during authenticated idle reads prevents sleep at the final dispatch fence', async t => {
  const f = await fixture(t); const q = queueCell(f); let inserted = false;
  f.hook(record => { if (!inserted && record.path === '/api/snapshot/info') { inserted = true; f.task(); } });
  const first = await q.cell.tick(); assert.equal(first.state, 'blocked');
  assert.equal(f.control.effect(first.key).state, 'not_applied'); assert.equal(f.posts.length, 0);
  f.hook(null); f.reopen(); const restarted = queueCell(f);
  const second = await restarted.cell.tick(); assert.equal(second.state, 'dispatched');
  assert.equal(f.posts.length, 0); assert.equal(restarted.calls.posts, 1);
  assert.equal((await restarted.cell.tick()).state, 'awaiting_review'); assert.equal(restarted.calls.posts, 1);
});

test('accepted queue intent survives restart and never resumes or obtains a new transition key', async t => {
  const f = await fixture(t); const plan = f.control.workerQueuePowerPlan(f.binding.app, { wakeCeilingCents: 100 });
  f.control.admitWorkerPower(f.lease, { key: plan.key, request: plan.request, queue: plan.queue });
  f.reopen(); const q = queueCell(f); f.task();
  const result = await q.cell.tick(); assert.equal(result.state, 'blocked'); assert.equal(result.key, plan.key);
  assert.equal(result.effectState, 'accepted'); assert.equal(f.posts.length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await q.cell.tick()).key, plan.key); assert.equal(f.paid.rows().length, 0);
});

test('unknown power can only be observed while OFF and paid-paused; changed identity stays held', async t => {
  const f = await fixture(t); let q = queueCell(f); f.lose();
  const first = await q.cell.tick(); assert.equal(first.effectState, 'unknown'); assert.equal(f.posts.length, 1);
  f.reopen(); q = queueCell(f); f.control.pause(); f.paid.pauseAdmission();
  f.machine.instance_id = 'foreign-instance';
  const held = await q.cell.tick(); assert.equal(held.state, 'blocked'); assert.equal(held.key, first.key); assert.equal(held.effectState, 'unknown');
  f.machine.instance_id = f.binding.instanceId;
  const observed = await q.cell.tick(); assert.equal(observed.state, 'power_observed'); assert.equal(observed.key, first.key);
  assert.equal(observed.effectState, 'succeeded'); assert.equal(f.posts.length, 1);
  assert.deepEqual(await q.cell.tick(), { state: 'paused' }); assert.equal(f.paid.rows().length, 0);
});

for (const reason of ['factory-paused', 'paid-paused', 'free-zero', 'wake-plus-mission-short', 'expired-management']) {
  test('queue wake retains fences for ' + reason, async t => {
    const f = await fixture(t); const q = queueCell(f); await q.cell.tick(); f.task();
    if (reason === 'factory-paused') f.control.pause();
    if (reason === 'paid-paused') f.paid.pauseAdmission();
    if (['free-zero', 'wake-plus-mission-short'].includes(reason)) {
      f.paid.reserve({ reservationId: 'other-held', provider: 'modal', ceilingCents: reason === 'free-zero' ? 10000 : 9450 });
      f.paid.start('other-held');
    }
    if (reason === 'expired-management') f.advance(600001);
    const outcome = await q.cell.tick(); assert.ok(['paused', 'paid_paused', 'budget', 'blocked'].includes(outcome.state));
    assert.equal(f.posts.length, 1); assert.equal(q.calls.posts, 0);
    assert.equal(f.control.task('develop').status, 'ready'); assert.equal(f.control.task('develop').epoch, 0);
    assert.equal(f.control.db.prepare("SELECT count(*) n FROM effects WHERE kind='worker_wake'").get().n, 0);
    assert.equal(f.paid.rows().some(row => row.id.startsWith('power.')), false);
  });
}

test('wake preserves the selected task and paid gates across asynchronous identity reads', async t => {
  const f = await fixture(t); const q = queueCell(f); await q.cell.tick(); f.task(); let changed = false;
  f.hook(record => { if (!changed && record.origin === 'https://api.machines.dev' && record.method === 'GET') {
    changed = true; f.paid.reserve({ reservationId: 'competing-spend', provider: 'modal', ceilingCents: 9500 }); f.paid.start('competing-spend');
  } });
  const result = await q.cell.tick(); assert.equal(result.state, 'blocked'); assert.equal(result.effectState, 'unknown');
  assert.equal(f.posts.length, 1); assert.equal(f.machine.state, 'stopped');
  assert.equal((await q.cell.tick()).key, result.key); assert.equal(f.posts.length, 1); assert.equal(q.calls.posts, 0);
});

test('duplicate queue schedulers share one durable key and issue one stop attempt', async t => {
  const f = await fixture(t); const first = f.client(), second = f.client();
  const outcomes = await Promise.all([first.schedule(f.lease, { wakeCeilingCents: 100 }), second.schedule(f.lease, { wakeCeilingCents: 100 })]);
  assert.equal(outcomes[0].key, outcomes[1].key); assert.equal(f.posts.length, 1);
  assert.equal(f.control.db.prepare("SELECT count(*) n FROM effects WHERE kind='worker_sleep'").get().n, 1);
  assert.equal((await second.schedule(f.lease, { wakeCeilingCents: 100 })).state, 'sleeping');
});

test('an already-awake queue keeps existing next-mission throughput while prior output awaits review', async t => {
  const f = await fixture(t); const q = queueCell(f); f.task('first');
  assert.equal((await q.cell.tick()).state, 'dispatched'); f.task('second');
  assert.equal((await q.cell.tick()).state, 'dispatched'); assert.equal(q.calls.posts, 2); assert.equal(f.posts.length, 0);
  assert.equal((await q.cell.tick()).state, 'awaiting_review');
  await assert.rejects(q.power.schedule(f.lease, { wakeCeilingCents: 100 }), { code: 'WORKER_POWER_BUSY' });
});

test('wake selects affordable exact demand after accounting for its own reservation', async t => {
  const f = await fixture(t); const q = queueCell(f); await q.cell.tick();
  f.task('a-expensive', { ceilingCents: 600 }); f.task('b-affordable', { ceilingCents: 400 });
  f.paid.reserve({ reservationId: 'other-cost', provider: 'modal', ceilingCents: 9450 }); f.paid.start('other-cost');
  const wake = await q.cell.tick(); assert.equal(wake.state, 'power_transition');
  assert.equal(f.control.workerPowerQueue(wake.key).taskId, 'b-affordable');
  const flow = await q.cell.tick(); assert.equal(flow.state, 'dispatched'); assert.equal(flow.taskId, 'b-affordable');
  assert.equal(f.control.task('a-expensive').status, 'ready'); assert.equal(q.calls.posts, 1); assert.equal(f.posts.length, 2);
});

test('task cancellation during wake reads prevents POST and definite non-application preserves sleeping state', async t => {
  const f = await fixture(t); const q = queueCell(f); await q.cell.tick(); f.task(); let cancelled = false;
  f.hook(record => { if (!cancelled && record.origin === 'https://api.machines.dev' && record.method === 'GET') {
    cancelled = true; const task = f.control.task('develop');
    f.control.cancelTask('develop', { closureId: 'cancel-demand', expectedAttempt: task.epoch, expectedOwner: task.owner,
      expectedStatus: task.status, expectedTaskControlEpoch: task.control_epoch, expectedFactoryEpoch: f.control.control().epoch, reason: 'abandoned' });
  } });
  const outcome = await q.cell.tick(); assert.equal(outcome.state, 'blocked'); assert.equal(outcome.effectState, 'not_applied');
  assert.equal(f.posts.length, 1); assert.equal(f.machine.state, 'stopped'); f.hook(null);
  assert.deepEqual(await q.cell.tick(), { state: 'sleeping' }); assert.equal(f.posts.length, 1);
  f.task('new-demand'); const fresh = await q.cell.tick(); assert.equal(fresh.state, 'power_transition');
  assert.notEqual(fresh.key, outcome.key); assert.equal(f.control.workerPowerQueue(fresh.key).previousKey, outcome.key);
  assert.equal(f.posts.length, 2); assert.equal(f.machine.state, 'started');
});

test('caller mutation cannot reduce the persisted queue mission allowance at the final wake fence', async t => {
  const f = await fixture(t); const power = f.client(); await power.schedule(f.lease, { wakeCeilingCents: 100 }); f.task();
  const plan = f.control.workerQueuePowerPlan(f.binding.app, { wakeCeilingCents: 100 }), queue = structuredClone(plan.queue); let mutated = false;
  f.hook(record => { if (!mutated && record.origin === 'https://api.machines.dev' && record.method === 'GET') {
    mutated = true; queue.missionCeilingCents = 1;
    f.paid.reserve({ reservationId: 'competing-spend', provider: 'modal', ceilingCents: 9500 }); f.paid.start('competing-spend');
  } });
  const outcome = await power.execute(f.lease, { key: plan.key, action: 'wake', ceilingCents: 100, queue });
  assert.equal(outcome.effect.state, 'unknown'); assert.equal(outcome.queuePowerScheduling, true);
  assert.equal(f.control.workerPowerQueue(plan.key).missionCeilingCents, 500); assert.equal(f.posts.length, 1);
});

test('queue metadata has closed fields and cannot be supplied as a readiness assertion', async t => {
  const f = await fixture(t); const plan = f.control.workerQueuePowerPlan(f.binding.app, { wakeCeilingCents: 100 });
  for (const queue of [{ ...plan.queue, ready: true }, { ...plan.queue, previousKey: '' },
    { ...plan.queue, taskId: 'develop' }, { ...plan.queue, missionCeilingCents: 1 }]) {
    await assert.rejects(f.client().execute(f.lease, { key: plan.key, action: 'sleep', queue }), { code: 'WORKER_POWER_QUEUE' });
  }
  assert.equal(f.calls.length, 0); assert.equal(f.control.db.prepare("SELECT count(*) n FROM effects WHERE scope='worker'").get().n, 0);
});
