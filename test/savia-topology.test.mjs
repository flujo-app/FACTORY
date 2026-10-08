import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { buildSaviaCasePlan, observeSaviaCaseTopology } from '../src/public-sdk.mjs';

const plan = buildSaviaCasePlan({ caseId: 'audit', mission: 'Observe the case',
  projectId: 'savia-audit', baseline: 'reviewed-source', model: 'installed-model',
  outputDirectory: path.join(os.tmpdir(), 'savia-observation'), budgetCents: 0,
  angles: Array.from({ length: 10 }, (_, index) => `Angle ${index + 1}`) });

async function fixture(t, change = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const worker = plan.workers.find(item => url.searchParams.get('workspace') === `swarm-${item.app}`);
    const leadId = worker?.conversations[0].input.conversationId;
    if (!worker || !leadId) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'application/json');
    if (url.pathname === `/v1/chat/conversations/${leadId}`) {
      response.end(JSON.stringify({ id: change.wrongLeadId === leadId ? 'foreign-lead' : leadId,
        status: change.leadId === leadId ? 'running' : 'completed' }));
    } else if (url.pathname === '/v1/chat/conversations' && url.searchParams.get('descendantsOf') === leadId) {
      const count = change.childLeadId === leadId ? 8 : 9;
      const items = Array.from({ length: count }, (_, index) => ({ id: `${leadId}-child-${index + 1}`,
        parentConversationId: change.foreignParentLeadId === leadId && index === 0 ? 'foreign-lead' : leadId,
        status: change.incompleteLeadId === leadId && index === 0 ? 'running' : 'completed' }));
      response.end(JSON.stringify({ items, total: count, hasMore: change.hasMoreLeadId === leadId }));
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('SAVIA observation verifies ten completed leads and ninety direct completed children', async t => {
  const origin = await fixture(t);
  const result = await observeSaviaCaseTopology(plan, { origin });
  assert.equal(result.topologyObserved, true);
  assert.equal(result.teams.length, 10);
  assert.equal(result.teams.reduce((sum, team) => sum + team.completedChildren, 0), 90);
});

test('SAVIA observation refuses missing, running and truncated child evidence', async t => {
  const leadId = plan.workers[0].conversations[0].input.conversationId;
  for (const change of [{ childLeadId: leadId }, { incompleteLeadId: leadId },
    { leadId }, { hasMoreLeadId: leadId }, { foreignParentLeadId: leadId }]) {
    const origin = await fixture(t, change);
    assert.equal((await observeSaviaCaseTopology(plan, { origin })).topologyObserved, false);
  }
});

test('SAVIA observation rejects a mismatched lead identity', async t => {
  const leadId = plan.workers[0].conversations[0].input.conversationId;
  const origin = await fixture(t, { wrongLeadId: leadId });
  await assert.rejects(() => observeSaviaCaseTopology(plan, { origin }),
    /complete conversation observation/);
});

test('SAVIA observation rejects a plan without ten distinct team leads', async () => {
  await assert.rejects(() => observeSaviaCaseTopology({ ...plan, workers: plan.workers.slice(1) },
    { origin: 'http://127.0.0.1:1' }), TypeError);
});
