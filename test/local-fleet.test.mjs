import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { FactoryControl, FactoryLocalFleet } from '../src/public-sdk.mjs';

test('local fleet provisions recursively, closes exact conversations and replays from one ledger', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-local-fleet-'));
  try {
    const database = path.join(directory, 'control.sqlite');
    const calls = { provision: [], conversation: [] };
    const adapter = { capabilities: { adapter: 'flujo-workspace' },
      async provision(input) { calls.provision.push(input.app); return { app: input.app, worker: input.app, state: 'ready' }; },
      async call(app, input) { calls.conversation.push([app,input.conversationId]);
        return { body: input.conversationId, contentType: 'text/plain' }; },
      async retire() { throw new Error('unused'); },
    };
    const fleet = new FactoryLocalFleet(database, adapter);
    const plan = { mission: 'Run two FLUJO teams', budgetCents: 100, projectId: 'swarm', baseline: 'source-revision',
      workers: [
        { id: 'parent', app: 'worker-parent', budgetCents: 70, purpose: 'Lead team',
          provisionInput: { app: 'worker-parent', flowSpecs: [{ name: 'swarm_team' }] },
          conversations: [{ id: 'lead', input: { conversationId: 'lead-conversation',
            request: { flowName: 'swarm_team', prompt: 'Lead' } }, outputPath: path.join(directory, 'lead.txt') }] },
        { id: 'child', parentId: 'parent', app: 'worker-child', budgetCents: 40, purpose: 'Child team',
          provisionInput: { app: 'worker-child', flowSpecs: [{ name: 'swarm_team' }] },
          conversations: [{ id: 'child-lead', input: { conversationId: 'child-conversation',
            request: { flowName: 'swarm_team', prompt: 'Child' } }, outputPath: path.join(directory, 'child.txt') }] },
      ] };
    const first = await fleet.run(plan);
    assert.deepEqual(first.launches.map(result => result.status), ['completed','completed']);
    assert.deepEqual(first.conversations.map(result => result.status), ['completed','completed']);
    assert.equal(first.skippedConversations, 0);
    assert.equal(await readFile(path.join(directory, 'child.txt'), 'utf8'), 'child-conversation');
    const control = new FactoryControl(database);
    assert.equal(control.status().tasks.every(task => task.status === 'completed'), true);
    assert.equal(control.status().effects.length, 4);
    control.close();
    const replay = await fleet.run(plan);
    assert.equal(replay.conversations.every(result => result.replayed), true);
    assert.deepEqual(calls.provision, ['worker-parent','worker-child']);
    assert.deepEqual(calls.conversation, [['worker-parent','lead-conversation'],['worker-child','child-conversation']]);
    await writeFile(path.join(directory, 'lead.txt'), 'changed');
    const changed = await fleet.run(plan);
    assert.equal(changed.conversations[0].code, 'OUTPUT');
    assert.deepEqual(calls.conversation, [['worker-parent','lead-conversation'],['worker-child','child-conversation']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local fleet rejects overallocated and cyclic plans before creating state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-local-plan-'));
  try {
    const database = path.join(directory, 'control.sqlite');
    const fleet = new FactoryLocalFleet(database, { capabilities: { adapter: 'flujo-workspace' },
      provision() {}, call() {}, retire() {} });
    const worker = { id: 'one', app: 'worker-one', budgetCents: 2, purpose: 'Worker',
      provisionInput: { app: 'worker-one' }, conversations: [] };
    const plan = { mission: 'Invalid', budgetCents: 1, projectId: 'swarm', baseline: 'source', workers: [worker] };
    assert.throws(() => fleet.prepare(plan), /allocations exceed/);
    assert.throws(() => fleet.prepare({ ...plan, budgetCents: 2,
      workers: [{ ...worker, parentId: 'one' }] }), /cycle/);
    assert.throws(() => fleet.prepare({ ...plan, budgetCents: 2,
      workers: [{ ...worker, conversations: [
        { id: 'first', input: { conversationId: 'same' }, outputPath: path.join(directory, 'same.txt') },
        { id: 'second', input: { conversationId: 'same' }, outputPath: path.join(directory, 'second.txt') },
      ] }] }), /distinct/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one FACTORY local plan coordinates ten workers and one hundred retained calls', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-local-hundred-'));
  try {
    const database = path.join(directory, 'control.sqlite');
    let provisions = 0, conversations = 0, active = 0, peak = 0;
    const fleet = new FactoryLocalFleet(database, { capabilities: { adapter: 'flujo-workspace' },
      async provision(input) { provisions++; return { app: input.app, worker: input.app, state: 'ready' }; },
      async call(_worker, input) { conversations++; peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 2)); active--;
        return { body: input.conversationId, contentType: 'text/plain' }; },
      async retire() { throw new Error('unused'); },
    });
    const plan = { mission: 'Hundred local conversations', budgetCents: 0,
      projectId: 'swarm', baseline: 'reviewed-source',
      workers: Array.from({ length: 10 }, (_, workerIndex) => ({
        id: `team-${workerIndex}`, app: `worker-team-${workerIndex}`,
        budgetCents: 0, purpose: 'Local FLUJO team', provisionInput: { app: `worker-team-${workerIndex}` },
        conversations: Array.from({ length: 10 }, (_, jobIndex) => ({
          id: `team-${workerIndex}-job-${jobIndex}`,
          input: { conversationId: `conversation-${workerIndex}-${jobIndex}`,
            request: { flowName: 'Work', prompt: 'Do work' } },
          outputPath: path.join(directory, `output-${workerIndex}-${jobIndex}.txt`),
        })),
      })) };
    const result = await fleet.run(plan, { workerConcurrency: 5, conversationConcurrency: 20 });
    assert.equal(result.launches.filter(item => item.status === 'completed').length, 10);
    assert.equal(result.conversations.filter(item => item.status === 'completed').length, 100);
    assert.equal(peak, 20);
    const replay = await fleet.run(plan);
    assert.equal(replay.conversations.every(item => item.replayed), true);
    assert.equal(provisions, 10);
    assert.equal(conversations, 100);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
