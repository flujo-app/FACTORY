import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { buildSaviaCasePlan, CASE_SPECIALISTS_V1, FactoryLocalFleet } from '../src/public-sdk.mjs';

const angles = Array.from({ length: 10 }, (_, index) => `Independent angle ${index + 1}`);
const input = outputDirectory => ({ caseId: 'case-42', mission: 'Investigate the disputed transfer',
  projectId: 'savia-case-42', baseline: 'reviewed-source', model: 'installed-model',
  outputDirectory, angles, budgetCents: 0 });

test('Savia case plan creates ten distinct team leads and a bounded 100-conversation target', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-savia-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = buildSaviaCasePlan(input(directory));
  assert.equal(plan.workers.length, 10);
  assert.equal(CASE_SPECIALISTS_V1.topologyTarget.specialistSubflowsPerWorker, 9);
  assert.equal(plan.workers.length * (1 + CASE_SPECIALISTS_V1.topologyTarget.specialistSubflowsPerWorker), 100);
  assert.equal(new Set(plan.workers.map(worker => worker.app)).size, 10);
  assert.equal(new Set(plan.workers.flatMap(worker => worker.conversations.map(job => job.outputPath))).size, 10);
  assert.ok(plan.workers.every(worker => worker.provisionInput.teamTemplate.specialists === CASE_SPECIALISTS_V1));
  assert.ok(plan.workers.every(worker => worker.conversations[0].input.request.flowName === 'swarm_team'));

  let provisions = 0, calls = 0;
  const fleet = new FactoryLocalFleet(path.join(directory, 'control.sqlite'), {
    capabilities: { adapter: 'flujo-workspace' },
    async provision(request) { provisions++; return { worker: request.app, app: request.app, state: 'ready' }; },
    async call(_worker, request) { calls++; return { body: request.conversationId, contentType: 'text/plain' }; },
    async retire() { throw new Error('unused'); },
  });
  const result = await fleet.run(plan);
  assert.equal(result.launches.every(item => item.status === 'completed'), true);
  assert.equal(result.conversations.every(item => item.status === 'completed'), true);
  assert.equal(provisions, 10);
  assert.equal(calls, 10);
  const replay = await fleet.run(plan);
  assert.equal(replay.conversations.every(item => item.replayed), true);
  assert.equal(calls, 10);
  assert.equal(await readFile(plan.workers[0].conversations[0].outputPath, 'utf8'),
    plan.workers[0].conversations[0].input.conversationId);
});

test('Savia case plan rejects ambiguous, overbudget or unbound inputs before admission', () => {
  const base = input(path.join(os.tmpdir(), 'savia-private-output'));
  for (const invalid of [
    { ...base, angles: angles.slice(1) },
    { ...base, angles: [...angles.slice(0, 9), angles[0]] },
    { ...base, outputDirectory: 'relative-output' },
    { ...base, modelConfig: { id: 'other-model' } },
    { ...base, budgetCents: undefined },
    { ...base, budgetCents: 1, teamBudgetCents: [2, ...Array(9).fill(0)] },
  ]) assert.throws(() => buildSaviaCasePlan(invalid), TypeError);
});

test('Savia case plan distributes the logical case budget exactly across ten teams', () => {
  const plan = buildSaviaCasePlan({ ...input(path.join(os.tmpdir(), 'savia-private-output')),
    budgetCents: 103 });
  assert.deepEqual(plan.workers.map(worker => worker.budgetCents),
    [11, 11, 11, 10, 10, 10, 10, 10, 10, 10]);
});
