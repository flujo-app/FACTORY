import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { startPresentationServer } from '../src/presentation.mjs';

const TOKEN = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const PRIVATE = 'private-operational-closure-evidence';

function identity(control, taskId, closureId) {
  const task = control.task(taskId);
  return { closureId, expectedAttempt: task.epoch, expectedOwner: task.owner,
    expectedStatus: task.status, expectedTaskControlEpoch: task.control_epoch,
    expectedFactoryEpoch: control.control().epoch };
}

test('a loaded read-only server projects real completed operations and cancelled reviewed work without changing paid holds', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-presentation-closure-'));
  const databasePath = path.join(directory, 'control.sqlite');
  const spendingLedgerPath = path.join(directory, 'spending.sqlite');
  const control = new FactoryControl(databasePath);
  const paid = new SpendingLedger(spendingLedgerPath);
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    paid.close();
    control.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('factory-presentation-closure-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  control.initialize({ mission: 'Develop FLUJO', budgetCents: 10000, maxCells: 4, maxDepth: 1 });
  paid.initialize({ limitCents: 10000, currency: 'USD' });
  paid.reserve({ reservationId: 'modal', provider: 'modal', ceilingCents: 10000 });
  paid.start('modal');
  paid.retire('modal', { evidenceDigest: 'a'.repeat(64) });
  control.reserveCell({ cellId: 'worker', purpose: 'Explicit operation', budgetCents: 0 });
  control.reserveCell({ cellId: 'verifier', role: 'verifier', purpose: 'Independent review', budgetCents: 0 });
  control.enrollCell('verifier');
  control.createTask({ taskId: 'launch', projectId: 'flujo', branch: 'codex/operation',
    specification: { problem: 'Launch one worker', acceptance: { scope: 'recorded-controller-operation-receipts-only' }, baseline: 'fixture',
      taskType: 'operation', operation: { kind: 'provision', cellId: 'worker', app: 'ff-closure-worker' } } });
  const launchLease = control.claimTask('launch', 'root');
  control.admitEffect(launchLease, { key: 'provision', kind: 'provision',
    request: { cellId: 'worker', app: 'ff-closure-worker' } });
  control.startEffect(launchLease, 'provision');
  control.settleEffect('provision', 'succeeded', { worker: 'ff-closure-worker', state: 'ready' });
  control.createTask({ taskId: 'reviewed', projectId: 'flujo', branch: 'codex/reviewed',
    specification: { problem: PRIVATE, acceptance: 'Software acceptance retained', baseline: 'fixture' } });
  const softwareLease = control.claimTask('reviewed', 'root');
  const artifactPath = path.join(directory, 'candidate.json'), evidencePath = path.join(directory, 'review.json');
  await fs.writeFile(artifactPath, JSON.stringify({ privateValue: PRIVATE }));
  await fs.writeFile(evidencePath, JSON.stringify({ privateValue: PRIVATE }));
  control.submit(softwareLease, { artifactPath });
  control.reviewTask('reviewed', 'verifier', { accepted: true, evidencePath });
  const reviewedBefore = control.task('reviewed');
  server = await startPresentationServer({ databasePath, spendingLedgerPath, factoryId: 'flujo', token: TOKEN, port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (route = '/v1/snapshot', options = {}) => {
    const response = await fetch(new URL(route, origin), { headers: { Authorization: `Bearer ${TOKEN}` }, ...options });
    return { response, body: await response.json() };
  };
  const before = await request();
  assert.equal(before.response.status, 200);
  const paidRows = paid.db.prepare('SELECT * FROM spending_reservations ORDER BY id').all();
  const paidEvents = paid.db.prepare('SELECT * FROM spending_events ORDER BY seq').all();
  const complete = control.completeOperationalTask('launch', { ...identity(control, 'launch', 'complete-launch'), completionEffectKeys: ['provision'] });
  assert.equal(complete.status, 'completed');
  control.pause();
  const cancel = control.cancelTask('reviewed', { ...identity(control, 'reviewed', 'cancel-reviewed'), reason: 'abandoned' });
  assert.equal(cancel.status, 'cancelled');
  const after = await request();
  assert.equal(after.response.status, 200);
  assert.equal(after.body.schemaVersion, 1);
  assert.equal(after.body.snapshot.control.status, 'paused');
  assert.ok(after.body.revision > before.body.revision);
  assert.deepEqual(after.body.capabilities, { snapshot: true, events: true, commands: false });
  const launch = after.body.snapshot.tasks.find(task => task.id === 'launch');
  const reviewed = after.body.snapshot.tasks.find(task => task.id === 'reviewed');
  assert.equal(launch.status, 'completed');
  assert.equal(reviewed.status, 'cancelled');
  for (const task of [launch, reviewed]) {
    assert.equal(task.owner, null);
    assert.equal(task.leaseExpiry, null);
  }
  assert.equal(reviewed.specDigest, reviewedBefore.spec_digest);
  assert.deepEqual(reviewed.candidate, { sha256: reviewedBefore.candidate.sha256 });
  assert.equal(reviewed.review.accepted, true);
  assert.equal(reviewed.review.attempt, reviewedBefore.epoch);
  assert.deepEqual(after.body.snapshot.tasks.filter(task => ['verified', 'delivered'].includes(task.status)), []);
  assert.equal(after.body.snapshot.paidBudget.committedCents, 10000);
  assert.equal(after.body.snapshot.paidBudget.unallocatedCents, 0);
  assert.equal(after.body.snapshot.paidBudget.meteredSpendCents, null);
  assert.equal(after.body.snapshot.workerQuiescence, 'unverified');
  const serialized = JSON.stringify(after.body);
  for (const secret of [TOKEN, PRIVATE, directory, 'receipt', 'reason', 'token_hash', 'specification']) assert.equal(serialized.includes(secret), false, secret);
  const events = await request(`/v1/events?after=${before.body.cursor}`);
  assert.equal(events.response.status, 200);
  assert.ok(events.body.events.some(event => event.type === 'task_completed' && event.subject === 'launch'));
  assert.ok(events.body.events.some(event => event.type === 'task_cancelled' && event.subject === 'reviewed'));
  assert.ok(events.body.events.every(event => !Object.hasOwn(event, 'details')));
  assert.deepEqual(paid.db.prepare('SELECT * FROM spending_reservations ORDER BY id').all(), paidRows);
  assert.deepEqual(paid.db.prepare('SELECT * FROM spending_events ORDER BY seq').all(), paidEvents);
  assert.equal((await request('/v1/snapshot', { method: 'POST' })).response.status, 405);
});
