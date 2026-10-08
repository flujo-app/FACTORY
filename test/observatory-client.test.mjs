import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactoryControl } from '../src/control.mjs';
import { startPresentationServer } from '../src/presentation.mjs';
import { createObservatoryClient } from 'flujo-factory/observatory';

const TOKEN = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

test('SDK Observatory client reads real FACTORY topology and keeps bearer server-side', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-observatory-client-'));
  const databasePath = path.join(directory, 'control.sqlite');
  const control = new FactoryControl(databasePath);
  control.initialize({ mission: 'Run FLUJO swarm', budgetCents: 1000, maxCells: 4, maxDepth: 2 });
  control.reserveCell({ cellId: 'lead', role: 'coordinator', budgetCents: 500, purpose: 'Lead' });
  control.enrollCell('lead');
  control.reserveCell({ cellId: 'specialist', parentId: 'lead', budgetCents: 100, purpose: 'Specialist' });
  const server = await startPresentationServer({ databasePath, factoryId: 'world-swarm', token: TOKEN, port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    control.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^factory-observatory-client-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const snapshotUrl = `http://127.0.0.1:${server.address().port}/v1/snapshot`;
  const client = createObservatoryClient({ snapshotUrl, token: TOKEN, expectedFactoryId: 'world-swarm' });
  const observed = await client.snapshot();
  assert.equal(observed.factoryId, 'world-swarm');
  assert.deepEqual(observed.snapshot.cells.map(({ id, parentId }) => [id, parentId]),
    [['lead', 'root'], ['root', null], ['specialist', 'lead']]);
  assert.equal(JSON.stringify(observed).includes(TOKEN), false);
  control.reserveCell({ cellId: 'late-worker', parentId: 'lead', budgetCents: 100, purpose: 'Later task' });
  const events = await client.events({ after: observed.cursor, limit: 2 });
  assert.equal(events.factoryId, 'world-swarm');
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].subject, 'late-worker');
  assert.equal(JSON.stringify(events).includes(TOKEN), false);
  const empty = await client.events({ after: events.cursor });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.cursor, events.cursor);
  await assert.rejects(createObservatoryClient({ snapshotUrl, token: TOKEN, expectedFactoryId: 'another-swarm' }).snapshot(),
    /identity or schema/);
});

test('SDK Observatory client rejects remote endpoints, redirects and false topology', async () => {
  for (const snapshotUrl of [
    'https://example.com/v1/snapshot', 'http://localhost:4343/v1/snapshot',
    'http://127.0.0.1:4343/v1/snapshot?token=secret', 'http://127.0.0.1:4343/other',
  ]) assert.throws(() => createObservatoryClient({ snapshotUrl, token: TOKEN, expectedFactoryId: 'world-swarm' }), TypeError);
  const snapshotUrl = 'http://127.0.0.1:4343/v1/snapshot';
  const client = createObservatoryClient({ snapshotUrl, token: TOKEN, expectedFactoryId: 'world-swarm',
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      return new Response(JSON.stringify({ schemaVersion: 1, factoryId: 'world-swarm', scope: 'local-coordinator',
        revision: 1, observedAt: new Date().toISOString(), capabilities: { snapshot: true, events: true, commands: false },
        snapshot: { control: { mission: 'bad', status: 'active' }, cells: [{ id: 'root', parentId: 'missing', depth: 0, status: 'ready' }],
          tasks: [], effects: [], budget: {} } }), { status: 200 });
    } });
  await assert.rejects(client.snapshot(), /identity or schema/);
});

test('SDK Observatory event reader rejects malformed cursors and false event sequences before exposing them', async () => {
  let calls = 0;
  const client = createObservatoryClient({ snapshotUrl: 'http://127.0.0.1:4343/v1/snapshot', token: TOKEN,
    expectedFactoryId: 'world-swarm', fetchImpl: async (address, options) => {
      calls++;
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(new URL(address).pathname, '/v1/events');
      return Response.json({ schemaVersion: 1, factoryId: 'world-swarm', scope: 'local-coordinator',
        revision: 2, observedAt: new Date().toISOString(), capabilities: { snapshot: true, events: true, commands: false },
        events: [{ seq: 1, type: 'cell_reserved', subject: 'root', observedAt: new Date().toISOString() }],
        cursor: 'MQ', latestCursor: 'Mg', hasMore: false });
    } });
  await assert.rejects(client.events({ after: 'bad!' }), TypeError);
  await assert.rejects(client.events({ after: 'MA', limit: 501 }), TypeError);
  assert.equal(calls, 0);
  await assert.rejects(client.events({ after: 'MQ' }), /identity or schema/);
  assert.equal(calls, 1);
});
