import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { FactoryLocalFleet, FactoryManagedFleet, SpendingLedger, managedFleetReservationId,
  createManagedCloudAdapter } from '../src/public-sdk.mjs';

function plan(directory) {
  return { mission: 'Managed FLUJO fleet', budgetCents: 0, projectId: 'managed-fleet',
    baseline: 'test-source', workers: ['managed-a', 'managed-b'].map(app => ({
      id: app, app, budgetCents: 0, paidCeilingCents: 100, purpose: `Managed worker ${app}`,
      provisionInput: { app, source: 'http://127.0.0.1:4200' },
      conversations: [{ id: `${app}-job`, input: { conversationId: `${app}-conversation`,
        request: { flowName: 'team', prompt: 'Synthetic task' } },
        outputPath: path.join(directory, `${app}.txt`) }],
    })) };
}

function service({ uncertainRetirement = false } = {}) {
  const counts = { up: 0, call: 0, down: 0 };
  return { counts,
    async sources() { return []; },
    async preflight() { return { readyToDeploy: true }; },
    async up(input) { counts.up++; return { worker: input.app, state: 'ready' }; },
    async call(worker, input) { counts.call++; return { body: `${worker}:${input.conversationId}`,
      contentType: 'text/plain' }; },
    async list() { return []; },
    async down(worker) { counts.down++; if (uncertainRetirement && worker === 'managed-b')
      throw new Error('provider acknowledgement missing');
    return { worker, state: 'destroyed' }; },
  };
}

test('managed fleet schedules, replays and retires through FACTORY durable effects', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-fleet-'));
  const cloud = service();
  const adapter = await createManagedCloudAdapter({ service: cloud });
  assert.throws(() => new FactoryLocalFleet(path.join(directory, 'local.sqlite'), adapter), TypeError);
  assert.throws(() => new FactoryManagedFleet(path.join(directory, 'unpaid.sqlite'), adapter), TypeError);
  const paid = new SpendingLedger(path.join(directory, 'spending.sqlite'));
  paid.initialize({ limitCents: 200, currency: 'USD' });
  t.after(async () => { paid.close(); await rm(directory, { recursive: true, force: true }); });
  const fleet = new FactoryManagedFleet(path.join(directory, 'managed.sqlite'), adapter,
    { paidAdmission: paid, provider: 'fly' });
  const work = plan(directory);
  for (const operation of [
    () => fleet.message({ jobId: 'managed-a-job', messageId: 'next', content: 'Continue' }),
    () => fleet.cancel({ jobId: 'managed-a-job' }),
    () => fleet.reconcileCompleted(work, { jobId: 'managed-a-job' }),
    () => fleet.reconcileCancelled(work, { jobId: 'managed-a-job' }),
    () => fleet.reconcileRetired(work, { workerId: 'managed-a' }),
  ]) await assert.rejects(operation, TypeError);
  assert.deepEqual(cloud.counts, { up: 0, call: 0, down: 0 });
  const result = await fleet.run(work, { workerConcurrency: 2, conversationConcurrency: 2 });
  assert.equal(result.launches.every(item => item.status === 'completed'), true);
  assert.equal(result.conversations.every(item => item.status === 'completed'), true);
  assert.deepEqual(cloud.counts, { up: 2, call: 2, down: 0 });
  assert.equal(paid.status().committedCents, 200);
  assert.equal(paid.status().reservations.some(item =>
    item.reservationId === fleet.paidReservationId('managed-a')), true);
  assert.equal(fleet.paidReservationId('managed-a'),
    managedFleetReservationId(path.join(directory, 'managed.sqlite'), 'managed-a'));
  assert.equal(await readFile(work.workers[0].conversations[0].outputPath, 'utf8'),
    'managed-a:managed-a-conversation');
  const replay = await fleet.run(work, { workerConcurrency: 2, conversationConcurrency: 2 });
  assert.equal(replay.conversations.every(item => item.replayed), true);
  assert.deepEqual(cloud.counts, { up: 2, call: 2, down: 0 });
  const retired = await fleet.retire(work, { workerConcurrency: 2 });
  assert.equal(retired.workers.every(item => item.status === 'retired'), true);
  assert.deepEqual(cloud.counts, { up: 2, call: 2, down: 2 });
  assert.equal(paid.status().reservations.every(item => item.state === 'retired-meter-pending'), true);
  await assert.rejects(() => fleet.closeRetired(work, { workerId: 'managed-a' }),
    { code: 'PROVIDER_RETIREMENT_INPUT' });
});

test('managed fleet restart reuses exact paid holds and rejects a changed ceiling', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-restart-'));
  const paidPath = path.join(directory, 'spending.sqlite');
  const database = path.join(directory, 'managed.sqlite');
  const paid = new SpendingLedger(paidPath);
  paid.initialize({ limitCents: 200, currency: 'USD' });
  t.after(async () => { paid.close(); await rm(directory, { recursive: true, force: true }); });
  const cloud = service();
  const adapter = await createManagedCloudAdapter({ service: cloud });
  const work = plan(directory);
  await new FactoryManagedFleet(database, adapter, { paidAdmission: paid, provider: 'fly' }).run(work,
    { workerConcurrency: 2, conversationConcurrency: 2 });
  const restarted = new FactoryManagedFleet(database, adapter, { paidAdmission: paid, provider: 'fly' });
  const changed = { ...work, workers: work.workers.map((worker, index) => index === 0
    ? { ...worker, paidCeilingCents: 101 } : worker) };
  await assert.rejects(() => restarted.run(changed), /different input/i);
  const replay = await restarted.run(work, { workerConcurrency: 2, conversationConcurrency: 2 });
  assert.equal(replay.launches.every(item => item.replayed), true);
  assert.equal(replay.conversations.every(item => item.replayed), true);
  assert.deepEqual(cloud.counts, { up: 2, call: 2, down: 0 });
  assert.equal(paid.status().reservations.length, 2);
});

test('managed fleet holds uncertain retirement without dispatching it twice', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-held-'));
  const cloud = service({ uncertainRetirement: true });
  const paid = new SpendingLedger(path.join(directory, 'spending.sqlite'));
  paid.initialize({ limitCents: 200, currency: 'USD' });
  t.after(async () => { paid.close(); await rm(directory, { recursive: true, force: true }); });
  const fleet = new FactoryManagedFleet(path.join(directory, 'managed.sqlite'),
    await createManagedCloudAdapter({ service: cloud }), { paidAdmission: paid, provider: 'fly' });
  const work = plan(directory);
  await fleet.run(work, { workerConcurrency: 2, conversationConcurrency: 2 });
  const first = await fleet.retire(work, { workerConcurrency: 2 });
  assert.equal(first.workers.find(item => item.workerId === 'managed-b').status, 'held');
  const repeated = await fleet.retire(work, { workerConcurrency: 2 });
  assert.equal(repeated.workers.find(item => item.workerId === 'managed-b').status, 'held');
  assert.equal(cloud.counts.down, 2);
  assert.deepEqual(paid.status().reservations.map(item => item.state).sort(),
    ['retired-meter-pending', 'started']);
});

test('managed fleet refuses a worker whose paid ceiling exceeds remaining capacity', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-budget-'));
  const paid = new SpendingLedger(path.join(directory, 'spending.sqlite'));
  paid.initialize({ limitCents: 100, currency: 'USD' });
  t.after(async () => { paid.close(); await rm(directory, { recursive: true, force: true }); });
  const cloud = service();
  const fleet = new FactoryManagedFleet(path.join(directory, 'managed.sqlite'),
    await createManagedCloudAdapter({ service: cloud }), { paidAdmission: paid, provider: 'fly' });
  const result = await fleet.run(plan(directory), { workerConcurrency: 1, conversationConcurrency: 2 });
  assert.equal(result.launches.filter(item => item.status === 'completed').length, 1);
  assert.equal(result.launches.filter(item => item.status === 'held').length, 1);
  assert.equal(cloud.counts.up, 1);
  assert.equal(cloud.counts.call, 1);
  assert.equal(paid.status().committedCents, 100);
});

test('managed fleet paid pause prevents cloud calls before provider dispatch', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-paused-'));
  const paid = new SpendingLedger(path.join(directory, 'spending.sqlite'));
  paid.initialize({ limitCents: 200, currency: 'USD' });
  paid.pauseAdmission();
  t.after(async () => { paid.close(); await rm(directory, { recursive: true, force: true }); });
  const cloud = service();
  const fleet = new FactoryManagedFleet(path.join(directory, 'managed.sqlite'),
    await createManagedCloudAdapter({ service: cloud }), { paidAdmission: paid, provider: 'fly' });
  const result = await fleet.run(plan(directory), { workerConcurrency: 2, conversationConcurrency: 2 });
  assert.equal(result.launches.every(item => item.status === 'held'), true);
  assert.deepEqual(cloud.counts, { up: 0, call: 0, down: 0 });
  assert.equal(paid.status().reservations.length, 0);
});
