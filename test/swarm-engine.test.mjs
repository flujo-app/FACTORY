import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { FactoryControl, FactorySwarmEngine } from '../src/public-sdk.mjs';

test('Factory owns worker dispatch and does not replay provision, call or retirement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-swarm-'));
  try {
    const database = path.join(directory, 'control.sqlite');
    const control = new FactoryControl(database);
    control.initialize({ mission: 'Run FLUJO workers', budgetCents: 1000, maxCells: 4, maxDepth: 2 });
    control.createTask({ taskId: 'job', projectId: 'project', branch: 'codex/job',
      specification: { problem: 'Run one worker', acceptance: 'Receipt retained', baseline: 'main' } });
    const lease = control.claimTask('job', 'root', 60000);
    control.close();
    const counts = { provision: 0, call: 0, retire: 0 };
    const engine = new FactorySwarmEngine(database, {
      async provision() { counts.provision++; return { app: 'worker-one', worker: 'worker-one', state: 'ready' }; },
      async call() { counts.call++; return { body: 'worker answer', contentType: 'text/plain' }; },
      async retire() { counts.retire++; return { app: 'worker-one', worker: 'worker-one', state: 'destroyed' }; },
    });
    const provision = { lease, cellId: 'cell-one', app: 'worker-one', purpose: 'FLUJO worker', input: { workspace: 'one' } };
    await assert.rejects(engine.provisionWorker({ ...provision, app: 'INVALID' }), TypeError);
    assert.equal((await engine.provisionWorker(provision)).effect.state, 'succeeded');
    assert.equal((await engine.provisionWorker(provision)).dispatched, false);
    const call = { lease, worker: 'worker-one',
      input: { conversationId: 'conversation-one', request: { flowId: 'flow-one' } }, outputPath: path.join(directory, 'output.txt') };
    await assert.rejects(engine.callWorker({ ...call, outputPath: undefined }), TypeError);
    assert.equal((await engine.callWorker(call)).effect.state, 'succeeded');
    assert.equal((await engine.callWorker(call)).dispatched, false);
    assert.equal(await readFile(call.outputPath, 'utf8'), 'worker answer');
    await assert.rejects(engine.callWorker({ ...call, worker: 'foreign-worker' }), { code: 'WORKER' });
    assert.equal((await engine.retireWorker({ app: 'worker-one' })).effect.state, 'succeeded');
    assert.equal((await engine.retireWorker({ app: 'worker-one' })).dispatched, false);
    await assert.rejects(engine.callWorker({ ...call, input: { ...call.input, conversationId: 'late-conversation' } }), { code: 'WORKER' });
    assert.deepEqual(counts, { provision: 1, call: 1, retire: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conversation fanout is bounded and each call is retained under its own task', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-fanout-'));
  try {
    const database = path.join(directory, 'control.sqlite');
    const control = new FactoryControl(database);
    control.initialize({ mission: 'Run conversations', budgetCents: 0, maxCells: 4, maxDepth: 2 });
    control.reserveCell({ cellId: 'cell-one', parentId: 'root', role: 'developer', budgetCents: 0, purpose: 'FLUJO worker' });
    control.createTask({ taskId: 'launch', projectId: 'project', branch: 'codex/launch',
      specification: { problem: 'Launch', acceptance: 'Receipt retained', baseline: 'main' } });
    const launch = control.claimTask('launch', 'root', 60000);
    control.close();
    let active = 0, peak = 0, calls = 0;
    const engine = new FactorySwarmEngine(database, {
      async provision() { return { worker: 'worker-one', state: 'ready' }; },
      async call(_worker, input) {
        calls++; peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 15));
        active--;
        return { body: input.conversationId, contentType: 'text/plain' };
      },
      async retire() { return { worker: 'worker-one', state: 'destroyed' }; },
    });
    await engine.provisionWorker({ lease: launch, cellId: 'cell-one', app: 'worker-one', purpose: 'FLUJO worker', input: {} });
    const writer = new FactoryControl(database);
    const jobs = Array.from({ length: 300 }, (_, index) => {
      const id = `job-${index}`;
      writer.createTask({ taskId: id, projectId: 'project', branch: `codex/${id}`,
        specification: { problem: id, acceptance: 'Receipt retained', baseline: 'main' } });
      return { lease: writer.claimTask(id, 'cell-one', 60000), worker: 'worker-one',
        input: { conversationId: `conversation-${index}`, request: { model: 'flow-one' } },
        outputPath: path.join(directory, `${id}.txt`) };
    });
    writer.close();
    assert.equal((await engine.runConversations(jobs, { concurrency: 30 })).filter(result => result.status === 'fulfilled').length, 300);
    assert.equal(peak, 30);
    assert.equal((await engine.runConversations(jobs, { concurrency: 30 })).every(result => result.value?.dispatched === false), true);
    assert.equal(calls, 300);
    await assert.rejects(engine.runConversations([jobs[0], jobs[0]]), TypeError);
    const again = new FactoryControl(database);
    again.createTask({ taskId: 'duplicate', projectId: 'project', branch: 'codex/duplicate',
      specification: { problem: 'duplicate', acceptance: 'Receipt retained', baseline: 'main' } });
    const duplicateLease = again.claimTask('duplicate', 'cell-one', 60000);
    again.close();
    await assert.rejects(engine.callWorker({ ...jobs[0], lease: duplicateLease,
      outputPath: path.join(directory, 'duplicate.txt') }), { code: 'CONFLICT' });
    assert.equal(calls, 300);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uncertain provider result keeps the reserved cell and blocks replay', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-swarm-unknown-'));
  try {
    const database = path.join(directory, 'control.sqlite');
    const control = new FactoryControl(database);
    control.initialize({ mission: 'Hold an uncertain worker', budgetCents: 0, maxCells: 3, maxDepth: 2 });
    control.createTask({ taskId: 'job', projectId: 'project', branch: 'codex/job',
      specification: { problem: 'Run one worker', acceptance: 'Receipt retained', baseline: 'main' } });
    const lease = control.claimTask('job', 'root', 60000);
    control.close();
    let calls = 0;
    const engine = new FactorySwarmEngine(database, {
      async provision() { calls++; return { worker: 'other-worker', state: 'ready' }; },
      async call() { throw new Error('unused'); }, async retire() { throw new Error('unused'); },
    });
    const request = { lease, cellId: 'cell-one', app: 'worker-one', purpose: 'FLUJO worker', input: { workspace: 'one' } };
    assert.equal((await engine.provisionWorker(request)).effect.state, 'unknown');
    assert.equal((await engine.provisionWorker(request)).dispatched, false);
    assert.equal(calls, 1);
    const reopened = new FactoryControl(database);
    assert.equal(reopened.status().cells.find(cell => cell.id === 'cell-one').status, 'reserved');
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a child FACTORY lease can provision its own child in the same budget-only tree', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-recursive-'));
  try {
    const database = path.join(directory, 'control.sqlite');
    const control = new FactoryControl(database);
    control.initialize({ mission: 'Recursive FLUJO swarm', budgetCents: 100,
      growthMode: 'budget-only' });
    control.createTask({ taskId: 'root-task', projectId: 'project', branch: 'codex/root-task',
      specification: { problem: 'Start child', acceptance: 'Receipt', baseline: 'main' } });
    const root = control.claimTask('root-task', 'root', 60000);
    control.close();
    const engine = new FactorySwarmEngine(database, {
      async provision(input) { return { app: input.app, worker: input.app, state: 'ready' }; },
      async call() { throw new Error('unused'); }, async retire() { throw new Error('unused'); },
    });
    assert.equal((await engine.provisionWorker({ lease: root, cellId: 'child', app: 'worker-child',
      budgetCents: 70, purpose: 'Child coordinator', role: 'coordinator', input: { app: 'worker-child' } })).effect.state, 'succeeded');
    const childControl = new FactoryControl(database);
    childControl.createTask({ taskId: 'child-task', projectId: 'project', branch: 'codex/child-task',
      specification: { problem: 'Start grandchild', acceptance: 'Receipt', baseline: 'main' } });
    const child = childControl.claimTask('child-task', 'child', 60000);
    childControl.close();
    assert.equal((await engine.provisionWorker({ lease: child, cellId: 'grandchild', app: 'worker-grandchild',
      budgetCents: 40, purpose: 'Grandchild worker', input: { app: 'worker-grandchild' } })).effect.state, 'succeeded');
    const observed = new FactoryControl(database);
    assert.deepEqual(observed.status().cells.map(cell => [cell.id, cell.parent_id, cell.status]), [
      ['child', 'root', 'ready'], ['grandchild', 'child', 'ready'], ['root', null, 'ready'],
    ]);
    observed.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
