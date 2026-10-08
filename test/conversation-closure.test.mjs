import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { FactoryControl, FactorySwarmEngine } from '../src/public-sdk.mjs';
import { digest } from '../src/control.mjs';

test('typed conversation closes only from its exact retained output and task attempt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-conversation-'));
  try {
    const database = path.join(directory, 'control.sqlite');
    const control = new FactoryControl(database);
    control.initialize({ mission: 'FLUJO conversation', budgetCents: 0, maxCells: 3, maxDepth: 2 });
    control.createTask({ taskId: 'launch', projectId: 'project', branch: 'codex/launch',
      specification: { problem: 'Launch', acceptance: 'Receipt', baseline: 'main' } });
    const launch = control.claimTask('launch', 'root', 60000);
    control.close();
    const engine = new FactorySwarmEngine(database, {
      async provision() { return { app: 'worker-one', worker: 'worker-one', state: 'ready' }; },
      async call() { return { body: 'original answer', contentType: 'text/plain' }; },
      async retire() { throw new Error('unused'); },
    });
    await engine.provisionWorker({ lease: launch, cellId: 'cell-one', app: 'worker-one',
      purpose: 'FLUJO worker', input: { app: 'worker-one' } });
    const input = { conversationId: 'conversation-one', request: { flowName: 'Work', prompt: 'Do work' } };
    const outputPath = path.join(directory, 'answer.txt');
    const writer = new FactoryControl(database);
    writer.createTask({ taskId: 'conversation-task', projectId: 'project', branch: 'codex/conversation-task',
      specification: { taskType: 'conversation', problem: 'Run one FLUJO flow', baseline: 'main',
        acceptance: { scope: 'recorded-controller-conversation-receipt-only' },
        operation: { kind: 'flow_call', cellId: 'cell-one', app: 'worker-one', conversationId: input.conversationId,
          provisionKey: 'provision-cell-one', inputDigest: digest(input), outputPath } } });
    const lease = writer.claimTask('conversation-task', 'cell-one', 60000);
    writer.close();
    const run = await engine.callWorker({ lease, worker: 'worker-one', input, outputPath });
    const reopened = new FactoryControl(database);
    const task = reopened.task('conversation-task');
    const closure = { closureId: 'close-conversation', expectedAttempt: task.epoch,
      expectedOwner: task.owner, expectedStatus: task.status,
      expectedTaskControlEpoch: task.control_epoch, expectedFactoryEpoch: reopened.control().epoch,
      completionEffectKey: run.effect.key };
    await writeFile(outputPath, 'tampered');
    assert.throws(() => reopened.completeConversationTask('conversation-task', closure),
      error => ['CONVERSATION_EVIDENCE', 'EVIDENCE'].includes(error.code));
    await writeFile(outputPath, 'original answer');
    assert.equal(reopened.completeConversationTask('conversation-task', closure).status, 'completed');
    assert.equal(reopened.completeConversationTask('conversation-task', closure).status, 'completed');
    assert.equal(reopened.task('conversation-task').status, 'completed');
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
