#!/usr/bin/env node
/** Unpaid ten-team SAVIA template smoke against an isolated local FLUJO server. */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { buildSaviaCasePlan, observeSaviaCaseTopology, FactoryLocalFleet,
  createFlujoWorkspaceAdapter } from '../src/public-sdk.mjs';

const origin = process.env.FACTORY_FLUJO_ORIGIN;
if (!origin || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin))
  throw new Error('FACTORY_FLUJO_ORIGIN must be an isolated local FLUJO origin');
const root = await mkdtemp(path.join(os.tmpdir(), 'factory-savia-live-'));
const caseId = `probe-${randomBytes(3).toString('hex')}`;
let modelCalls = 0;
const spawnSpecialists = process.env.FACTORY_SAVIA_SMOKE_SPAWN === '1';
const spawnedLeads = new Set();
const model = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    modelCalls++;
    const base = { id: `savia-smoke-${modelCalls}`, created: Math.floor(Date.now() / 1000),
      model: 'factory-savia-synthetic' };
    const handoffName = body.tools?.map(tool => tool.function?.name)
      .find(name => /^handoff_to_.*agent/.test(name));
    const teamId = JSON.stringify(body.messages ?? []).match(/TEAM_ID:\s*(savia-[a-z0-9-]+-team-\d+)/)?.[1];
    const shouldSpawn = spawnSpecialists && handoffName && teamId && !spawnedLeads.has(teamId);
    if (shouldSpawn) spawnedLeads.add(teamId);
    const calls = shouldSpawn ? Array.from({ length: 9 }, (_, index) => ({
      id: `call_${modelCalls}_${index + 1}`, type: 'function',
      function: { name: handoffName, arguments: JSON.stringify({
        task: `CASE_ID: ${caseId}; AGENT_ID: ${teamId}-agent-${index + 1}; ROLE_ID: synthetic_${index + 1}; ANGLE: independent synthetic check ${index + 1}; TASK: return an evidence-labeled synthetic result; DONE_WHEN: one synthetic result is returned.` }) },
    })) : [];
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: calls.length ? { role: 'assistant',
          tool_calls: calls.map((call, index) => ({ index, ...call })) }
          : { role: 'assistant', content: 'Synthetic lead report.' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...base, object: 'chat.completion',
        choices: [{ index: 0, message: calls.length
          ? { role: 'assistant', content: null, tool_calls: calls }
          : { role: 'assistant', content: 'Synthetic lead report.' },
          finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
    }
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic model request failed' } }));
  }
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const adapter = createFlujoWorkspaceAdapter({ origin });
const fleet = new FactoryLocalFleet(path.join(root, 'factory.sqlite'), adapter);
const plan = buildSaviaCasePlan({ caseId, mission: 'Check the ten-team FLUJO template without paid inference',
  projectId: `savia-${caseId}`, baseline: 'isolated-flujo-scratch', model: 'factory-savia-synthetic',
  modelConfig: { id: 'factory-savia-synthetic', name: 'factory-savia-synthetic',
    provider: 'openai', adapter: 'openai', ApiKey: 'synthetic-local-key',
    baseUrl: `http://127.0.0.1:${model.address().port}/v1` },
  outputDirectory: root, budgetCents: 0,
  angles: Array.from({ length: 10 }, (_, index) => `Independent synthetic angle ${index + 1}`),
  timeoutMs: 180_000 });
try {
  const result = await fleet.run(plan, { workerConcurrency: 2, conversationConcurrency: 10 });
  assert.equal(result.launches.length, 10);
  assert.equal(result.launches.every(item => item.status === 'completed'), true);
  assert.equal(result.conversations.length, 10);
  assert.equal(result.conversations.every(item => item.status === 'completed'), true);
  const topology = await observeSaviaCaseTopology(plan, { origin });
  if (spawnSpecialists) assert.equal(topology.topologyObserved, true);
  const callsBeforeReplay = modelCalls;
  const replay = await fleet.run(plan, { workerConcurrency: 2, conversationConcurrency: 10 });
  assert.equal(replay.conversations.every(item => item.replayed), true);
  assert.equal(modelCalls, callsBeforeReplay);
  const retirement = await fleet.retire(plan, { workerConcurrency: 2 });
  assert.equal(retirement.workers.every(item => item.status === 'retired'), true);
  const closures = [];
  for (const worker of plan.workers) closures.push(await fleet.closeRetired(plan, { workerId: worker.id }));
  assert.equal(closures.every(item => item.cell.status === 'retired'), true);
  process.stdout.write(`${JSON.stringify({ accepted: true, origin, root, leadsCompleted: 10,
    childConversationsObserved: topology.teams.reduce((sum, team) => sum + team.observedChildren, 0),
    topologyObserved: topology.topologyObserved, spawnSpecialists, modelCalls, replayed: true,
    retiredWorkers: retirement.workers.length, closedCells: closures.length })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ accepted: false, root, error: error.message, modelCalls })}\n`);
  throw error;
} finally {
  await new Promise(resolve => model.close(resolve));
}
