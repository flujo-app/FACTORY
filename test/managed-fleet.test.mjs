import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { FactoryLocalFleet, FactoryManagedFleet, createManagedCloudAdapter } from '../src/public-sdk.mjs';

function plan(directory) {
  return { mission: 'Managed FLUJO fleet', budgetCents: 0, projectId: 'managed-fleet',
    baseline: 'test-source', workers: ['managed-a', 'managed-b'].map(app => ({
      id: app, app, budgetCents: 0, purpose: `Managed worker ${app}`,
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
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cloud = service();
  const adapter = await createManagedCloudAdapter({ service: cloud });
  assert.throws(() => new FactoryLocalFleet(path.join(directory, 'local.sqlite'), adapter), TypeError);
  const fleet = new FactoryManagedFleet(path.join(directory, 'managed.sqlite'), adapter);
  const work = plan(directory);
  const result = await fleet.run(work, { workerConcurrency: 2, conversationConcurrency: 2 });
  assert.equal(result.launches.every(item => item.status === 'completed'), true);
  assert.equal(result.conversations.every(item => item.status === 'completed'), true);
  assert.deepEqual(cloud.counts, { up: 2, call: 2, down: 0 });
  assert.equal(await readFile(work.workers[0].conversations[0].outputPath, 'utf8'),
    'managed-a:managed-a-conversation');
  const replay = await fleet.run(work, { workerConcurrency: 2, conversationConcurrency: 2 });
  assert.equal(replay.conversations.every(item => item.replayed), true);
  assert.deepEqual(cloud.counts, { up: 2, call: 2, down: 0 });
  const retired = await fleet.retire(work, { workerConcurrency: 2 });
  assert.equal(retired.workers.every(item => item.status === 'retired'), true);
  assert.deepEqual(cloud.counts, { up: 2, call: 2, down: 2 });
  await assert.rejects(() => fleet.closeRetired(work, { workerId: 'managed-a' }), TypeError);
});

test('managed fleet holds uncertain retirement without dispatching it twice', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-held-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cloud = service({ uncertainRetirement: true });
  const fleet = new FactoryManagedFleet(path.join(directory, 'managed.sqlite'),
    await createManagedCloudAdapter({ service: cloud }));
  const work = plan(directory);
  await fleet.run(work, { workerConcurrency: 2, conversationConcurrency: 2 });
  const first = await fleet.retire(work, { workerConcurrency: 2 });
  assert.equal(first.workers.find(item => item.workerId === 'managed-b').status, 'held');
  const repeated = await fleet.retire(work, { workerConcurrency: 2 });
  assert.equal(repeated.workers.find(item => item.workerId === 'managed-b').status, 'held');
  assert.equal(cloud.counts.down, 2);
});
