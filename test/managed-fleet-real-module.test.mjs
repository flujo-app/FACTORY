import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Journal } from '../deploy/managed-cloud/lib/journal.mjs';
import { createManagedCloudAdapter, FactoryManagedFleet, SpendingLedger } from '../src/public-sdk.mjs';

const modulePath = fileURLToPath(new URL('../deploy/managed-cloud/lib/managed.mjs', import.meta.url));
const origin = 'http://127.0.0.1:43451';
const image = `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`;
const compatibility = { applicationVersion: '3.45.0', snapshotFormatVersion: 2,
  layoutVersion: 2, workerProtocolVersion: 1 };

test('paid FACTORY fleet drives the real ManagedCloud journal with synthetic provider operations', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-module-'));
  const paid = new SpendingLedger(path.join(directory, 'spending.sqlite'));
  paid.initialize({ limitCents: 100, currency: 'USD' });
  t.after(async () => { paid.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = [];
  const sourceToken = 'synthetic_source_private_01234567890123456789';
  const bridge = {
    async up(options, env) {
      calls.push(['up', options.app]);
      assert.equal(env.FLUJO_SNAPSHOT_CONTROL_TOKEN, sourceToken);
      await new Journal(options.journal).create({ format: 'flujo-cloud-journal', version: 1,
        owner: randomUUID(), app: options.app, org: options.org, region: options.region,
        workspace: options.workspace, image: options.image, flowIds: options.flowIds,
        state: 'ready', stage: 'ready', appCreated: true, appId: options.app,
        machineId: 'synthetic-machine' });
      return { app: options.app, state: 'ready', machineId: 'synthetic-machine' };
    },
    async call(options) {
      calls.push(['call', options.conversationId]);
      return { contentType: 'text/plain', body: 'synthetic managed answer' };
    },
    async down({ journal }) {
      calls.push(['down', journal]);
      const store = new Journal(journal), record = await store.read();
      await store.save({ ...record, state: 'destroyed', stage: 'destroyed' });
      return { app: record.app, state: 'destroyed' };
    },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${sourceToken}`);
    const request = new URL(url);
    assert.equal(request.origin, origin);
    if (request.pathname === '/api/workspaces')
      return Response.json({ workspaces: [{ name: 'test-cloud' }], defaultWorkspace: 'test-cloud' });
    if (request.pathname === '/api/snapshot/info')
      return Response.json({ workspace: 'test-cloud', capability: 'available', workerCompatibility: compatibility });
    if (request.pathname === '/api/flow')
      return Response.json([{ id: 'default-agent-flujo', name: 'FLUJO' }]);
    throw new Error('Unexpected synthetic source request');
  };
  const adapter = await createManagedCloudAdapter({ modulePath, options: {
    directory: path.join(directory, 'cloud'), env: {}, bridge, fetchImpl,
    fly: { async run() { return JSON.stringify({ personal: 'Synthetic account' }); } },
    discover: async () => [{ source: origin, instanceId: 'synthetic-instance', token: sourceToken,
      appRoot: directory, dataRoot: directory }],
    resolveImage: async () => ({ image, mode: 'official', applicationVersion: '3.45.0', revision: 'b'.repeat(40) }),
  } });
  const fleet = new FactoryManagedFleet(path.join(directory, 'factory.sqlite'), adapter,
    { paidAdmission: paid, provider: 'fly' });
  const plan = { mission: 'Synthetic managed module integration', budgetCents: 0,
    projectId: 'managed-module', baseline: 'vendored-managed-source', workers: [{
      id: 'managed-fixture', app: 'managed-fixture', budgetCents: 0, paidCeilingCents: 100,
      purpose: 'Verify actual ManagedCloud application service',
      provisionInput: { app: 'managed-fixture', workspace: 'test-cloud', flowIds: ['default-agent-flujo'] },
      conversations: [{ id: 'managed-job', input: { conversationId: 'managed-conversation',
        request: { model: 'default-agent-flujo', messages: [{ role: 'user', content: 'Synthetic task' }] } },
        outputPath: path.join(directory, 'answer.txt') }],
    }] };
  const result = await fleet.run(plan);
  assert.equal(result.launches[0].status, 'completed');
  assert.equal(result.conversations[0].status, 'completed');
  assert.equal(await readFile(plan.workers[0].conversations[0].outputPath, 'utf8'), 'synthetic managed answer');
  assert.deepEqual(calls.map(([kind]) => kind), ['up', 'call']);
  assert.equal(paid.status().reservations[0].state, 'started');
  const replay = await fleet.run(plan);
  assert.equal(replay.conversations[0].replayed, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['up', 'call']);
  const retirement = await fleet.retire(plan);
  assert.equal(retirement.workers[0].status, 'retired');
  assert.deepEqual(calls.map(([kind]) => kind), ['up', 'call', 'down']);
  assert.equal(paid.status().reservations[0].state, 'retired-meter-pending');
  assert.equal((await fleet.retire(plan)).workers[0].replayed, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['up', 'call', 'down']);
});
