import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { createNativeCell } from '../src/native-cell.mjs';
import { claimNativeMission } from '../src/native-mission.mjs';
import { canonicalMissionPacket, nativeMissionRequest, nativeMissionEffectKey } from '../src/native-mission-contract.mjs';

const compatibility = { applicationVersion: '3.46.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 };
const privateBody = 'private native completion must remain in its owned artifact';
const privateProblem = 'private fixture instruction must not appear in cell status';
const privateFiles = process.env.FACTORY_PRIVATE_MODULE
  ? await import(pathToFileURL(process.env.FACTORY_PRIVATE_MODULE).href)
  : {
    ensurePrivateDirectory: async p => fs.mkdir(p, { recursive: true }),
    readPrivateJson: async p => JSON.parse(await fs.readFile(p, 'utf8')),
    writePrivateJson: async (p, value) => fs.writeFile(p, JSON.stringify(value), { flag: 'wx', mode: 0o600 }),
  };
const missionId = taskId => createHash('sha256').update(taskId).digest('hex').slice(0, 32);
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function barrier(count) {
  const gate = deferred(); let arrived = 0;
  return async () => { if (++arrived === count) gate.resolve(); await gate.promise; };
}
function safeStatus(status) {
  const fields = new Set(['state', 'taskId', 'key', 'effectState', 'reason', 'observations', 'unallocatedCents']);
  assert.ok(Object.keys(status).every(key => fields.has(key)));
  assert.ok(['idle', 'paused', 'paid_paused', 'budget', 'dispatched', 'recovered', 'unresolved',
    'awaiting_review', 'blocked', 'released', 'busy', 'stopped'].includes(status.state));
  if (status.reason !== undefined) assert.match(status.reason, /^[a-z0-9_]+$/);
  for (const row of status.observations ?? []) assert.deepEqual(Object.keys(row).sort(), ['effectState', 'key', 'taskId']);
  const encoded = JSON.stringify(status);
  assert.ok(!encoded.includes(privateBody) && !encoded.includes(privateProblem));
  assert.ok(!encoded.includes('"packet"') && !encoded.includes('"token"') && !encoded.includes('"body"'));
  return status;
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-native-cell-'));
  await privateFiles.ensurePrivateDirectory(dir);
  let now = 1791028800000;
  const clock = () => now, controls = new Set();
  const openControl = () => { const value = new FactoryControl(path.join(dir, 'control.sqlite'), { clock }); controls.add(value); return value; };
  let control = openControl();
  const paid = new SpendingLedger(path.join(dir, 'paid.sqlite'), { clock });
  t.after(() => { for (const value of controls) value.close(); paid.close(); });
  // Retain the owned fixture evidence, as the existing native-mission tests do.
  control.initialize({ mission: 'Native cell fixture', budgetCents: 10000, maxCells: 4, maxDepth: 2 });
  paid.initialize({ limitCents: 10000, currency: 'USD' });
  control.reserveCell({ cellId: 'child', role: 'developer', budgetCents: 1000, purpose: 'Assigned native mission queue' });
  control.createTask({ taskId: 'launch', projectId: 'fixture', branch: 'codex/launch',
    specification: { problem: 'Provision', acceptance: ['ready worker'], baseline: 'fixture' } });
  const launcher = control.claimTask('launch', 'root', 600000);
  control.admitEffect(launcher, { key: 'provision', kind: 'provision', request: { cellId: 'child', app: 'factory-child' } });
  control.startEffect(launcher, 'provision');
  control.settleEffect('provision', 'succeeded', { worker: 'factory-child', app: 'factory-child', state: 'ready' });
  const worker = { workspace: 'mission', archiveSha256: 'a'.repeat(64), compatibility: structuredClone(compatibility) };
  const profile = { cellId: 'child', app: 'factory-child', provisionKey: 'provision', worker,
    outputDirectory: path.join(dir, 'outputs'), ttlMs: 1000, pollMs: 100 };
  const calls = { posts: 0, prepares: 0, observes: 0, dispatches: 0 };
  const observations = new Map();
  let prepareHook = null, dispatchHook = null, loseResponse = false, observationMode = null;
  const client = {
    binding: Object.freeze({ ...worker, compatibility: Object.freeze(structuredClone(compatibility)) }),
    async prepare(input) { calls.prepares++; await prepareHook?.(input); },
    async dispatch(input, { admitPost }) {
      calls.dispatches++; await dispatchHook?.(input);
      await admitPost(() => {
        calls.posts++;
        observations.set(input.conversationId, { state: 'completed', body: JSON.stringify({ id: input.conversationId,
          flowId: input.flowId, status: 'completed', messages: [
            { role: 'user', content: canonicalMissionPacket(input.packet) }, { role: 'assistant', content: privateBody },
          ] }) });
        return Promise.resolve();
      });
      if (loseResponse) throw new Error('private dispatch diagnostic must not be emitted');
      return observations.get(input.conversationId);
    },
    async observe(input) {
      calls.observes++;
      return observationMode ? { state: observationMode, body: null }
        : observations.get(input.conversationId) ?? { state: 'absent', body: null };
    },
  };
  function addTask(taskId, overrides = {}) {
    const nativeMission = { schemaVersion: 1, missionId: missionId(taskId), cellId: 'child', app: 'factory-child',
      provisionKey: 'provision', worker: structuredClone(worker), flowId: 'mission-flow', flowSha256: 'c'.repeat(64),
      paid: { provider: 'fly', ceilingCents: 500 }, ...overrides };
    return control.createTask({ taskId, projectId: 'fixture', branch: 'codex/' + taskId,
      specification: { problem: privateProblem, acceptance: ['independent software review'], baseline: 'fixture', nativeMission } });
  }
  const outputFile = taskId => path.join(profile.outputDirectory, missionId(taskId) + '.private.json');
  const makeCell = (options = {}) => createNativeCell({ control: options.control ?? control, paidAdmission: paid, client,
    privateFiles: options.privateFiles ?? privateFiles, profile: { ...profile, ...options.profile } });
  const effects = taskId => control.db.prepare("SELECT key,state FROM effects WHERE scope='task' AND scope_id=? ORDER BY created,key").all(taskId);
  const eventCount = (type, subject) => control.db.prepare('SELECT count(*) n FROM events WHERE type=? AND subject=?').get(type, subject).n;
  const releaseInput = taskId => { const task = control.task(taskId); return { taskId, expectedAttempt: task.epoch,
    expectedSpecDigest: task.spec_digest, expectedFactoryEpoch: control.control().epoch, workerProof: worker }; };
  return { dir, paid, client, profile, worker, calls, addTask, outputFile, makeCell, effects, eventCount, releaseInput,
    get control() { return control; }, openControl, advance: ms => { now += ms; },
    prepareHook: hook => { prepareHook = hook; }, dispatchHook: hook => { dispatchHook = hook; },
    loseResponse: () => { loseResponse = true; }, observationMode: mode => { observationMode = mode; },
    claim: taskId => claimNativeMission({ control, taskId, client, outputFile: outputFile(taskId), ttlMs: profile.ttlMs }),
    reopen: () => { control.close(); controls.delete(control); control = openControl(); },
  };
}

test('native cell validates a closed private profile and immutable worker binding', async t => {
  const f = await fixture(t);
  for (const profile of [{ extra: true }, { outputDirectory: 'relative' }, { ttlMs: 999 }, { pollMs: 99 },
    { worker: { ...f.worker, archiveSha256: 'd'.repeat(64) } }]) {
    assert.throws(() => f.makeCell({ profile }), { code: 'NATIVE_CELL_PROFILE' });
  }
  const cell = f.makeCell();
  f.profile.app = 'changed-after-construction';
  f.addTask('develop');
  assert.equal(safeStatus(await cell.tick()).state, 'dispatched');
  assert.equal(f.calls.posts, 1);
});

test('unrelated ordinary tasks and every different immutable worker tuple remain untouched', async t => {
  const f = await fixture(t);
  f.control.createTask({ taskId: 'ordinary', projectId: 'fixture', branch: 'codex/ordinary',
    specification: { problem: 'Unrelated task', acceptance: ['review'], baseline: 'fixture' } });
  f.addTask('other-cell', { cellId: 'other' });
  f.addTask('other-app', { app: 'factory-other' });
  f.addTask('other-provision', { provisionKey: 'other-provision' });
  f.addTask('other-worker', { worker: { ...f.worker, archiveSha256: 'd'.repeat(64) } });
  assert.equal(safeStatus(await f.makeCell().tick()).state, 'idle');
  for (const taskId of ['ordinary', 'other-cell', 'other-app', 'other-provision', 'other-worker']) {
    assert.equal(f.control.task(taskId).status, 'ready'); assert.equal(f.control.task(taskId).epoch, 0);
    assert.equal(f.effects(taskId).length, 0);
  }
  assert.deepEqual(f.calls, { posts: 0, prepares: 0, observes: 0, dispatches: 0 });
  assert.equal(f.paid.rows().length, 0);
});

test('queue selection is lexical; completed native output does not accept software or block the next mission', async t => {
  const f = await fixture(t); f.addTask('b-develop'); f.addTask('a-develop');
  const cell = f.makeCell();
  const first = safeStatus(await cell.tick()); assert.equal(first.taskId, 'a-develop'); assert.equal(first.state, 'dispatched');
  const second = safeStatus(await cell.tick()); assert.equal(second.taskId, 'b-develop'); assert.equal(second.state, 'dispatched');
  assert.equal(f.calls.posts, 2); assert.equal(f.paid.rows().length, 2);
  for (const taskId of ['a-develop', 'b-develop']) {
    const task = f.control.task(taskId); assert.equal(task.status, 'running'); assert.equal(task.candidate, null); assert.equal(task.review, null);
    assert.equal(f.effects(taskId)[0].state, 'succeeded');
    const artifact = await privateFiles.readPrivateJson(f.outputFile(taskId));
    assert.equal(artifact.body.messages[1].content, privateBody);
    assert.equal(f.control.effect(f.effects(taskId)[0].key).receipt.outputPath, f.outputFile(taskId));
  }
  assert.equal(safeStatus(await cell.tick()).state, 'awaiting_review'); assert.equal(f.calls.posts, 2);
});

test('two cell instances sharing actual controller and paid databases admit one original POST', async t => {
  const f = await fixture(t); f.addTask('develop'); f.prepareHook(barrier(2));
  const otherControl = f.openControl();
  const results = await Promise.all([f.makeCell().tick(), f.makeCell({ control: otherControl }).tick()]);
  results.forEach(safeStatus);
  assert.equal(f.calls.posts, 1); assert.equal(f.effects('develop').length, 1);
  assert.equal(f.paid.rows().length, 1); assert.equal(f.paid.snapshot().committedCents, 500);
  assert.equal(f.eventCount('native_mission_admitted', f.effects('develop')[0].key), 1);
});

test('same-cell concurrent claims for distinct tasks cannot create two live claim gaps', async t => {
  const f = await fixture(t); f.addTask('a-develop'); f.addTask('b-develop'); f.prepareHook(barrier(2));
  const other = f.openControl();
  const results = await Promise.allSettled([
    claimNativeMission({ control: f.control, taskId: 'a-develop', client: f.client, outputFile: f.outputFile('a-develop'), ttlMs: 1000 }),
    claimNativeMission({ control: other, taskId: 'b-develop', client: f.client, outputFile: f.outputFile('b-develop'), ttlMs: 1000 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BUSY');
  assert.equal(['a-develop', 'b-develop'].filter(id => f.control.task(id).status === 'running').length, 1);
  assert.equal(f.calls.posts, 0); assert.equal(f.paid.rows().length, 0);
});

test('accepted original intent blocks another ready mission and is never resumed by a second cell', async t => {
  const f = await fixture(t); f.addTask('a-develop'); f.addTask('b-develop');
  const entered = deferred(), release = deferred();
  f.dispatchHook(async () => { entered.resolve(); await release.promise; });
  const first = f.makeCell().tick(); await entered.promise;
  let completed;
  try {
    assert.equal(f.effects('a-develop')[0].state, 'accepted');
    const second = safeStatus(await f.makeCell({ control: f.openControl() }).tick());
    assert.equal(second.state, 'blocked'); assert.equal(second.reason, 'original_intent_requires_operator');
    assert.equal(f.calls.posts, 0); assert.equal(f.calls.observes, 0);
    assert.equal(f.control.task('b-develop').status, 'ready'); assert.equal(f.effects('b-develop').length, 0);
  } finally { release.resolve(); completed = await first; }
  assert.equal(safeStatus(completed).state, 'dispatched'); assert.equal(f.calls.posts, 1);
});

test('lost-response recovery survives reopen and both pause switches using observation without another POST', async t => {
  const f = await fixture(t); f.addTask('develop'); f.loseResponse();
  const first = safeStatus(await f.makeCell().tick()); assert.equal(first.effectState, 'unknown'); assert.equal(f.calls.posts, 1);
  const beforePaid = f.paid.rows().length;
  f.reopen(); f.control.pause(); f.paid.pauseAdmission();
  const recovered = safeStatus(await f.makeCell().tick()); assert.equal(recovered.state, 'recovered');
  assert.equal(f.calls.observes, 1); assert.equal(f.calls.posts, 1); assert.equal(f.paid.rows().length, beforePaid);
  assert.equal(f.effects('develop')[0].state, 'succeeded'); assert.equal(f.control.task('develop').candidate, null);
  assert.equal((await privateFiles.readPrivateJson(f.outputFile('develop'))).body.messages[1].content, privateBody);
});

test('pending unknown observation blocks later work across repeated ticks without resetting the lifetime intent', async t => {
  const f = await fixture(t); f.addTask('a-develop'); f.addTask('b-develop'); f.loseResponse();
  await f.makeCell().tick(); f.observationMode('pending'); f.reopen(); const cell = f.makeCell();
  for (let i = 0; i < 2; i++) assert.equal(safeStatus(await cell.tick()).state, 'unresolved');
  assert.equal(f.calls.posts, 1); assert.equal(f.calls.observes, 2); assert.equal(f.effects('a-develop')[0].state, 'unknown');
  assert.equal(f.control.task('b-develop').status, 'ready'); assert.equal(f.effects('b-develop').length, 0);
  assert.equal(f.paid.rows().length, 1);
});

test('durable running intent is observed first while the factory is paused', async t => {
  const f = await fixture(t); f.addTask('develop'); const lease = await f.claim('develop');
  const request = nativeMissionRequest(f.control.task('develop'), lease, f.outputFile('develop'));
  const key = nativeMissionEffectKey(request); f.control.admitNativeMissionEffect(lease, request);
  f.control.startNativeMissionEffect(lease, key, () => Promise.resolve());
  f.control.pause(); f.observationMode('pending');
  assert.equal(safeStatus(await f.makeCell().tick()).state, 'unresolved');
  assert.equal(f.calls.observes, 1); assert.equal(f.calls.posts, 0); assert.equal(f.paid.rows().length, 0);
  assert.equal(f.control.effect(key).state, 'unknown');
});

test('fully committed real paid fixture rejects before claiming and keeps queued tasks ready', async t => {
  const f = await fixture(t); f.addTask('develop');
  f.paid.reserve({ reservationId: 'fully-held', provider: 'modal', ceilingCents: 10000 });
  assert.equal(safeStatus(await f.makeCell().tick()).state, 'budget');
  assert.equal(f.control.task('develop').status, 'ready'); assert.equal(f.control.task('develop').epoch, 0);
  assert.equal(f.effects('develop').length, 0); assert.equal(f.eventCount('native_mission_claimed', 'develop'), 0);
  assert.deepEqual(f.calls, { posts: 0, prepares: 0, observes: 0, dispatches: 0 });
  assert.equal(f.paid.snapshot().committedCents, 10000); assert.equal(f.paid.rows().length, 1);
});

test('factory and paid pause switches refuse fresh claims but do not consume queue identity', async t => {
  const f = await fixture(t); f.addTask('develop'); const cell = f.makeCell();
  f.paid.pauseAdmission(); assert.equal(safeStatus(await cell.tick()).state, 'paid_paused');
  f.paid.resumeAdmission(); f.control.pause(); assert.equal(safeStatus(await cell.tick()).state, 'paused');
  assert.equal(f.control.task('develop').status, 'ready'); assert.equal(f.control.task('develop').epoch, 0);
  assert.equal(f.effects('develop').length, 0); assert.equal(f.calls.prepares, 0); assert.equal(f.calls.posts, 0);
});

test('paid exhaustion during asynchronous preparation is fenced by the real mission runner before POST', async t => {
  const f = await fixture(t); f.addTask('develop');
  f.prepareHook(() => f.paid.reserve({ reservationId: 'racing-hold', provider: 'modal', ceilingCents: 10000 }));
  const status = safeStatus(await f.makeCell().tick()); assert.equal(status.state, 'blocked');
  assert.equal(f.effects('develop').length, 1); assert.equal(f.effects('develop')[0].state, 'not_applied');
  assert.equal(f.calls.posts, 0); assert.equal(f.paid.rows().length, 1); assert.equal(f.paid.snapshot().committedCents, 10000);
});

test('factory pause during preparation prevents the atomic claim and leaves no native effect', async t => {
  const f = await fixture(t); f.addTask('develop'); f.prepareHook(() => f.control.pause());
  assert.equal(safeStatus(await f.makeCell().tick()).state, 'blocked');
  assert.equal(f.control.task('develop').status, 'ready'); assert.equal(f.effects('develop').length, 0);
  assert.equal(f.calls.posts, 0); assert.equal(f.paid.rows().length, 0);
});

test('paid admission pause during preparation preserves the switch and fences POST without inventing a reservation', async t => {
  const f = await fixture(t); f.addTask('develop'); f.prepareHook(() => f.paid.pauseAdmission());
  assert.equal(safeStatus(await f.makeCell().tick()).state, 'blocked');
  assert.equal(f.effects('develop').length, 1); assert.equal(f.effects('develop')[0].state, 'not_applied');
  assert.equal(f.calls.posts, 0); assert.equal(f.paid.rows().length, 0);
  assert.throws(() => f.paid.assertAdmission(), { code: 'PAUSED' });
});

test('live unstarted claim stays busy; expired stamped claim releases without executing and can then be assigned', async t => {
  const f = await fixture(t); f.addTask('develop'); const lease = await f.claim('develop'); const cell = f.makeCell();
  assert.equal(safeStatus(await cell.tick()).state, 'busy');
  f.advance(1001); const released = safeStatus(await cell.tick()); assert.equal(released.state, 'released');
  assert.equal(f.control.task('develop').status, 'ready'); assert.equal(f.control.task('develop').epoch, lease.epoch);
  assert.equal(f.effects('develop').length, 0); assert.equal(f.calls.posts, 0); assert.equal(f.paid.rows().length, 0);
  assert.equal(f.eventCount('native_mission_unstarted_released', 'develop'), 1);
  assert.equal(safeStatus(await cell.tick()).state, 'dispatched');
  assert.equal(f.control.task('develop').epoch, lease.epoch + 1); assert.equal(f.calls.posts, 1);
});

test('old factory epoch permits only exact stamped claim-gap release even before wall-clock expiry', async t => {
  const f = await fixture(t); f.addTask('develop'); const lease = await f.claim('develop');
  f.control.pause(); f.control.resume();
  assert.equal(safeStatus(await f.makeCell().tick()).state, 'released');
  assert.equal(f.control.task('develop').epoch, lease.epoch); assert.equal(f.control.task('develop').status, 'ready');
  assert.equal(f.calls.posts, 0); assert.equal(f.effects('develop').length, 0); assert.equal(f.paid.rows().length, 0);
});

test('expired claim release fails closed on attempt, specification, factory epoch and worker proof mismatches', async t => {
  const f = await fixture(t); f.addTask('develop'); await f.claim('develop'); f.advance(1001);
  const input = f.releaseInput('develop');
  for (const change of [{ expectedAttempt: input.expectedAttempt + 1 }, { expectedSpecDigest: 'f'.repeat(64) },
    { expectedFactoryEpoch: input.expectedFactoryEpoch + 1 }, { workerProof: { ...f.worker, archiveSha256: 'd'.repeat(64) } }]) {
    assert.throws(() => f.control.releaseUnstartedNativeMission({ ...input, ...change }), { code: 'NATIVE_MISSION_UNSTARTED' });
    assert.equal(f.control.task('develop').status, 'running'); assert.equal(f.eventCount('native_mission_unstarted_released', 'develop'), 0);
  }
  assert.equal(f.control.releaseUnstartedNativeMission(input).status, 'ready'); assert.equal(f.calls.posts, 0);
});

test('an ordinary claim has no native claim stamp and cannot use claim-gap recovery', async t => {
  const f = await fixture(t); f.addTask('develop'); f.control.enrollCell('child');
  f.control.claimTask('develop', 'child', 1000); f.advance(1001);
  assert.equal(f.eventCount('native_mission_claimed', 'develop'), 0);
  assert.throws(() => f.control.releaseUnstartedNativeMission(f.releaseInput('develop')), { code: 'NATIVE_MISSION_UNSTARTED' });
  const status = safeStatus(await f.makeCell().tick()); assert.equal(status.state, 'blocked');
  assert.equal(f.control.task('develop').status, 'running'); assert.equal(f.calls.posts, 0); assert.equal(f.paid.rows().length, 0);
});

test('even a terminal not-applied lifetime effect forbids unstarted-claim release', async t => {
  const f = await fixture(t); f.addTask('develop'); const lease = await f.claim('develop');
  const request = nativeMissionRequest(f.control.task('develop'), lease, f.outputFile('develop'));
  const key = nativeMissionEffectKey(request); f.control.admitNativeMissionEffect(lease, request);
  f.control.settleEffect(key, 'not_applied', { state: 'not_applied' }); f.advance(1001);
  assert.throws(() => f.control.releaseUnstartedNativeMission(f.releaseInput('develop')), { code: 'NATIVE_MISSION_UNSTARTED' });
  assert.equal(f.control.task('develop').status, 'running'); assert.equal(f.control.effect(key).state, 'not_applied');
  assert.equal(f.eventCount('native_mission_unstarted_released', 'develop'), 0); assert.equal(f.calls.posts, 0);
});

test('changed output directory cannot reinterpret an unknown original request or move its private result', async t => {
  const f = await fixture(t); f.addTask('develop'); f.loseResponse(); await f.makeCell().tick();
  const otherDirectory = path.join(f.dir, 'other-output');
  const mismatch = safeStatus(await f.makeCell({ profile: { outputDirectory: otherDirectory } }).tick());
  assert.equal(mismatch.state, 'blocked'); assert.equal(mismatch.reason, 'output_binding');
  assert.equal(f.calls.observes, 0); assert.equal(f.calls.posts, 1); assert.equal(f.effects('develop')[0].state, 'unknown');
  assert.deepEqual(await fs.readdir(otherDirectory), []);
  assert.equal(safeStatus(await f.makeCell().tick()).state, 'recovered');
  assert.equal(f.control.effect(f.effects('develop')[0].key).receipt.outputPath, f.outputFile('develop'));
  assert.equal(f.calls.posts, 1);
});

test('aborting after preparation leaves an unstarted stamped claim rather than admitting a POST', async t => {
  const f = await fixture(t); f.addTask('develop'); const abort = new AbortController();
  f.prepareHook(() => abort.abort());
  assert.equal(safeStatus(await f.makeCell().tick({ signal: abort.signal })).state, 'stopped');
  assert.equal(f.control.task('develop').status, 'running'); assert.equal(f.eventCount('native_mission_claimed', 'develop'), 1);
  assert.equal(f.effects('develop').length, 0); assert.equal(f.calls.posts, 0); assert.equal(f.paid.rows().length, 0);
  f.advance(1001); assert.equal(safeStatus(await f.makeCell().tick()).state, 'released');
});

test('abort during dispatch preflight is checked under paid admission before running or invoking POST', async t => {
  const f = await fixture(t); f.addTask('develop'); const abort = new AbortController();
  f.dispatchHook(() => abort.abort());
  const status = safeStatus(await f.makeCell().tick({ signal: abort.signal }));
  assert.equal(status.state, 'blocked'); assert.equal(status.effectState, 'not_applied');
  assert.equal(f.effects('develop').length, 1); assert.equal(f.effects('develop')[0].state, 'not_applied');
  assert.equal(f.calls.dispatches, 1); assert.equal(f.calls.posts, 0);
  assert.equal(f.paid.rows().length, 1); assert.equal(f.paid.rows()[0].state, 'started');
  assert.equal(f.paid.snapshot().committedCents, 500);
});

test('failed preflight rotates past an unavailable first mission without consuming its claim or lifetime intent', async t => {
  const f = await fixture(t); f.addTask('a-unavailable'); f.addTask('b-develop'); const prepared = [];
  f.prepareHook(input => {
    prepared.push(input.packet.taskId);
    if (input.packet.taskId === 'a-unavailable') throw Object.assign(new Error('private worker diagnostic'), { code: 'NATIVE_MISSION_UNAVAILABLE' });
  });
  const cell = f.makeCell();
  const unavailable = safeStatus(await cell.tick()); assert.equal(unavailable.state, 'blocked'); assert.equal(unavailable.reason, 'worker_not_ready');
  assert.equal(f.control.task('a-unavailable').status, 'ready'); assert.equal(f.control.task('a-unavailable').epoch, 0);
  assert.equal(f.effects('a-unavailable').length, 0); assert.equal(f.paid.rows().length, 0);
  const dispatched = safeStatus(await cell.tick()); assert.equal(dispatched.state, 'dispatched'); assert.equal(dispatched.taskId, 'b-develop');
  assert.deepEqual(prepared, ['a-unavailable', 'b-develop']); assert.equal(f.calls.posts, 1);
  assert.equal(f.control.task('a-unavailable').status, 'ready'); assert.equal(f.effects('a-unavailable').length, 0);
});

test('an unaffordable lexical head is skipped for an eligible mission within the remaining real allowance', async t => {
  const f = await fixture(t);
  f.addTask('a-expensive', { paid: { provider: 'fly', ceilingCents: 501 } }); f.addTask('b-affordable');
  f.paid.reserve({ reservationId: 'other-held', provider: 'modal', ceilingCents: 9500 });
  const status = safeStatus(await f.makeCell().tick()); assert.equal(status.state, 'dispatched'); assert.equal(status.taskId, 'b-affordable');
  assert.equal(f.calls.posts, 1); assert.equal(f.control.task('a-expensive').status, 'ready');
  assert.equal(f.control.task('a-expensive').epoch, 0); assert.equal(f.effects('a-expensive').length, 0);
  assert.equal(f.paid.snapshot().committedCents, 10000); assert.equal(f.paid.snapshot().unallocatedCents, 0);
});

test('continuous cell reports only status changes and aborts a quiet loop without touching tasks or paid work', { timeout: 15000 }, async t => {
  const f = await fixture(t), abort = new AbortController(), changes = []; let polls = 0;
  const files = { ...privateFiles, async ensurePrivateDirectory(p) {
    await privateFiles.ensurePrivateDirectory(p); if (++polls === 3) abort.abort();
  } };
  const status = await f.makeCell({ privateFiles: files }).run({ signal: abort.signal, onChange: change => { changes.push(safeStatus(change)); } });
  assert.equal(status.state, 'stopped'); assert.equal(polls, 3); assert.deepEqual(changes, [{ state: 'idle' }]);
  assert.equal(f.calls.posts, 0); assert.equal(f.calls.prepares, 0); assert.equal(f.paid.rows().length, 0);
  const cell = f.makeCell(); const preAborted = new AbortController(); preAborted.abort();
  assert.equal(safeStatus(await cell.tick({ signal: preAborted.signal })).state, 'stopped');
});
