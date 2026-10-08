#!/usr/bin/env node
/** An unpaid, loopback-model end-to-end FACTORY/FLUJO smoke. Start FLUJO separately. */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { FactoryControl, FactoryLocalFleet, createFlujoWorkspaceAdapter } from '../src/public-sdk.mjs';
import { FlujoClient } from '../src/flujo-swarm/flujo-client.mjs';

const origin = process.env.FACTORY_FLUJO_ORIGIN;
if (!origin || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin)) {
  throw new Error('FACTORY_FLUJO_ORIGIN must be an isolated http://127.0.0.1:<port> instance');
}
const bounded = (name, fallback, max) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be from 1 to ${max}`);
  return value;
};
const workers = bounded('FACTORY_SMOKE_WORKERS', 1, 10);
const perWorker = bounded('FACTORY_SMOKE_CONVERSATIONS_PER_WORKER', 1, 30);
const workerConcurrency = bounded('FACTORY_SMOKE_WORKER_CONCURRENCY', Math.min(2, workers), 10);
const conversationConcurrency = bounded('FACTORY_SMOKE_CONVERSATION_CONCURRENCY', Math.min(20, workers * perWorker), 100);

const root = await mkdtemp(path.join(os.tmpdir(), 'factory-flujo-live-'));
const suffix = randomBytes(5).toString('hex');
const answer = `factory-live-${suffix}-complete`;
let modelCalls = 0;
const model = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    modelCalls++;
    const base = { id: `smoke-${modelCalls}`, created: Math.floor(Date.now() / 1000),
      model: 'factory-synthetic-model' };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...base, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
    }
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic model rejected the request' } }));
  }
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');

const adapter = createFlujoWorkspaceAdapter({ origin });
const fleet = new FactoryLocalFleet(path.join(root, 'factory.sqlite'), adapter);
const modelConfig = { id: 'factory-synthetic', name: 'factory-synthetic-model',
  provider: 'openai', adapter: 'openai', ApiKey: 'synthetic-local-key',
  baseUrl: `http://127.0.0.1:${model.address().port}/v1` };
const flowSpec = { name: 'factory_live_smoke', nodes: [
  { key: 'start', type: 'start', prompt: 'Run one local synthetic check.' },
  { key: 'work', type: 'process', label: 'Work', model: modelConfig.id,
    prompt: 'Return the synthetic answer.', servers: [], maxTurns: 1 },
  { key: 'finish', type: 'finish' },
], edges: [{ from: 'start', to: 'work' }, { from: 'work', to: 'finish' }] };
const plan = { mission: 'Unpaid local FLUJO SDK smoke', budgetCents: 0,
  projectId: `smoke-${suffix}`, baseline: 'isolated-flujo-3.46.1',
  workers: Array.from({ length: workers }, (_, workerIndex) => {
    const app = `worker-live-${suffix}-${workerIndex}`;
    return { id: `live-${suffix}-${workerIndex}`, app, budgetCents: 0,
      purpose: 'Synthetic FLUJO worker', provisionInput: { app, modelConfig, flowSpec },
      conversations: Array.from({ length: perWorker }, (_, conversationIndex) => ({
        id: `job-${suffix}-${workerIndex}-${conversationIndex}`,
        input: { conversationId: `conversation-live-${suffix}-${workerIndex}-${conversationIndex}`,
          request: { flowName: flowSpec.name, prompt: 'Run the smoke.' }, timeoutMs: 180000 },
        outputPath: path.join(root, `answer-${workerIndex}-${conversationIndex}.txt`),
      })) };
  }) };
const options = { workerConcurrency, conversationConcurrency };
const retired = new Set();
let accepted = false;
try {
  const result = await fleet.run(plan, options);
  assert.equal(result.launches.length, workers);
  assert.equal(result.launches.every(item => item.status === 'completed'), true);
  assert.equal(result.conversations.length, workers * perWorker);
  assert.equal(result.conversations.every(item => item.status === 'completed'), true);
  for (const worker of plan.workers) for (const job of worker.conversations)
    assert.equal((await readFile(job.outputPath, 'utf8')).trim(), answer);
  assert.ok(modelCalls >= workers * perWorker);
  const replay = await fleet.run(plan, options);
  assert.equal(replay.conversations.every(item => item.replayed), true);
  const control = new FactoryControl(fleet.database);
  const effects = control.status().effects.map(effect => ({ kind: effect.kind, state: effect.state }));
  control.close();
  const retirement = await fleet.retire(plan, { workerConcurrency });
  assert.equal(retirement.workers.every(worker => worker.status === 'retired'), true);
  for (const worker of plan.workers) retired.add(worker.app);
  const closures = [];
  for (const worker of plan.workers) closures.push(await fleet.closeRetired(plan, { workerId: worker.id }));
  assert.equal(closures.every(item => item.cell.status === 'retired'), true);
  for (const worker of plan.workers)
    assert.equal((await fleet.closeRetired(plan, { workerId: worker.id })).replayed, true);
  const client = new FlujoClient({ origin, workspace: `swarm-${plan.workers[0].app}` });
  const remaining = await client.workspaces();
  assert.equal(plan.workers.some(worker => remaining.includes(`swarm-${worker.app}`)), false);
  accepted = true;
  process.stdout.write(`${JSON.stringify({ accepted: true, flujoOrigin: origin,
    workers, conversations: workers * perWorker, workspaceAbsent: true,
    cellsRetired: closures.length,
    modelCalls, replayed: true, effectCounts: {
      provision: effects.filter(effect => effect.kind === 'provision' && effect.state === 'succeeded').length,
      flowCall: effects.filter(effect => effect.kind === 'flow_call' && effect.state === 'succeeded').length,
    } })}\n`);
} catch (error) {
  const control = new FactoryControl(fleet.database);
  const status = control.status();
  control.close();
  const effectCounts = status.effects.reduce((counts, effect) => {
    const identity = `${effect.kind}:${effect.state}`;
    counts[identity] = (counts[identity] ?? 0) + 1;
    return counts;
  }, {});
  process.stderr.write(`${JSON.stringify({ accepted: false, error: error.message,
    workers, conversations: workers * perWorker,
    launches: status.tasks.filter(task => task.id.startsWith('launch-')).map(task => ({ id: task.id, status: task.status })),
    effectCounts, unresolvedKeys: status.effects.filter(effect => ['accepted', 'running', 'unknown'].includes(effect.state))
      .map(effect => effect.key),
    unresolvedEffects: status.unresolvedEffects })}\n`);
  throw error;
} finally {
  for (const worker of plan.workers) if (!retired.has(worker.app)) {
    try { await adapter.retire(worker.app); } catch {}
  }
  await new Promise(resolve => model.close(resolve));
  if (accepted) await rm(root, { recursive: true, force: true });
  else process.stderr.write(`Smoke evidence retained at ${root}\n`);
}
