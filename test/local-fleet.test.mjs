import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { FactoryControl, FactoryLocalFleet, conversationMessageKey } from '../src/public-sdk.mjs';

test('local fleet records mid-run FLUJO steering once and closes after acknowledgement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-local-steer-'));
  try {
    let started, finish;
    const entered = new Promise(resolve => { started = resolve; });
    const released = new Promise(resolve => { finish = resolve; });
    const messages = [];
    const fleet = new FactoryLocalFleet(path.join(directory, 'control.sqlite'), {
      capabilities: { adapter: 'flujo-workspace' },
      async provision(input) { return { worker: input.app, state: 'ready' }; },
      async call() { started(); await released; return { body: 'answer', contentType: 'text/plain' }; },
      async message(worker, input) { messages.push([worker, input]); return { messageId: input.messageId, state: 'queued' }; },
      async retire() { throw new Error('unused'); },
    });
    const plan = { mission: 'Steer one FLUJO conversation', budgetCents: 0, projectId: 'swarm', baseline: 'source',
      workers: [{ id: 'lead', app: 'worker-lead', budgetCents: 0, purpose: 'Lead',
        provisionInput: { app: 'worker-lead' }, conversations: [{ id: 'job-one',
          input: { conversationId: 'conversation-one', request: { flowName: 'Work', prompt: 'Start' } },
          outputPath: path.join(directory, 'output.txt') }] }] };
    const running = fleet.run(plan);
    await entered;
    const messageId = 'b37a3330-3e88-44e5-8888-a9f5e782ade6';
    const first = await fleet.message({ jobId: 'job-one', messageId, content: 'Change direction' });
    const second = await fleet.message({ jobId: 'job-one', messageId, content: 'Change direction' });
    assert.equal(first.dispatched, true);
    assert.equal(second.dispatched, false);
    assert.equal(messages.length, 1);
    assert.equal(first.effect.receipt.state, 'queued');
    assert.equal(first.effect.key, conversationMessageKey('worker-lead', 'conversation-one', messageId));
    finish();
    assert.equal((await running).conversations[0].status, 'completed');
    const control = new FactoryControl(fleet.database);
    assert.equal(control.effect(first.effect.key).state, 'succeeded');
    control.close();
    await assert.rejects(fleet.message({ jobId: 'job-one', messageId, content: 'Late' }), { code: 'NOT_RUNNING' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uncertain steering remains a held effect and prevents conversation closure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-local-steer-unknown-'));
  try {
    let started, finish, submissions = 0;
    const entered = new Promise(resolve => { started = resolve; });
    const released = new Promise(resolve => { finish = resolve; });
    const fleet = new FactoryLocalFleet(path.join(directory, 'control.sqlite'), {
      capabilities: { adapter: 'flujo-workspace' },
      async provision(input) { return { worker: input.app, state: 'ready' }; },
      async call() { started(); await released; return { body: 'answer', contentType: 'text/plain' }; },
      async message() { submissions++; throw new Error('connection lost after submission'); },
      async retire() { throw new Error('unused'); },
    });
    const plan = { mission: 'Retain uncertain steering', budgetCents: 0, projectId: 'swarm', baseline: 'source',
      workers: [{ id: 'lead', app: 'worker-lead', budgetCents: 0, purpose: 'Lead',
        provisionInput: { app: 'worker-lead' }, conversations: [{ id: 'job-one',
          input: { conversationId: 'conversation-one', request: { flowName: 'Work', prompt: 'Start' } },
          outputPath: path.join(directory, 'output.txt') }] }] };
    const running = fleet.run(plan);
    await entered;
    const intent = { jobId: 'job-one', messageId: '19d5e734-5dfd-48aa-a78f-fc655610b363', content: 'Steer' };
    assert.equal((await fleet.message(intent)).effect.state, 'unknown');
    assert.equal((await fleet.message(intent)).dispatched, false);
    assert.equal(submissions, 1);
    finish();
    assert.equal((await running).conversations[0].status, 'held');
    const control = new FactoryControl(fleet.database);
    assert.equal(control.task('run-job-one').status, 'running');
    assert.equal(control.effect(conversationMessageKey('worker-lead', 'conversation-one', intent.messageId)).state, 'unknown');
    control.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local fleet renews leases while provisioning and running long FLUJO calls', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-local-renew-'));
  try {
    let entered;
    const runningCall = new Promise(resolve => { entered = resolve; });
    const fleet = new FactoryLocalFleet(path.join(directory, 'control.sqlite'), {
      capabilities: { adapter: 'flujo-workspace' },
      async provision(input) { await new Promise(resolve => setTimeout(resolve, 280));
        return { worker: input.app, state: 'ready' }; },
      async call() { entered(); await new Promise(resolve => setTimeout(resolve, 300));
        return { body: 'answer', contentType: 'text/plain' }; },
      async message(_worker, input) { return { messageId: input.messageId, state: 'queued' }; },
      async retire() { throw new Error('unused'); },
    }, { leaseTtlMs: 200, renewEveryMs: 20 });
    const plan = { mission: 'Long FLUJO conversation', budgetCents: 0, projectId: 'swarm', baseline: 'source',
      workers: [{ id: 'lead', app: 'worker-lead', budgetCents: 0, purpose: 'Lead',
        provisionInput: { app: 'worker-lead' }, conversations: [{ id: 'job-one',
          input: { conversationId: 'conversation-one', request: { flowName: 'Work', prompt: 'Start' } },
          outputPath: path.join(directory, 'output.txt') }] }] };
    const resultPromise = fleet.run(plan);
    await runningCall;
    await new Promise(resolve => setTimeout(resolve, 230));
    assert.equal((await fleet.message({ jobId: 'job-one',
      messageId: '13a6e3bb-c5e7-4c7d-a521-e6a7a6c9e1eb', content: 'Keep going' })).effect.state, 'succeeded');
    const result = await resultPromise;
    assert.deepEqual(result.launches.map(item => item.status), ['completed']);
    assert.deepEqual(result.conversations.map(item => item.status), ['completed']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
