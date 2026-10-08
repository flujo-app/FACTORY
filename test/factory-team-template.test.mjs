import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFactoryTeamSpecs, CASE_SPECIALISTS_V1, FACTORY_FLOW_NAMES } from '../src/public-sdk.mjs';

test('SAVIA profile builds one lead plus nine local specialist slots without fleet authority claims', () => {
  const specs = buildFactoryTeamSpecs({ model: 'installed-model',
    availableServers: ['filesystem', 'flujo', 'fleet'], specialists: CASE_SPECIALISTS_V1 });
  assert.deepEqual(specs.map(spec => spec.name), [FACTORY_FLOW_NAMES.agent, FACTORY_FLOW_NAMES.team]);
  const agent = specs[0].nodes.find(node => node.key === 'agent');
  const team = specs[1].nodes.find(node => node.key === 'agents');
  assert.equal(team.concurrencyLimit, 9);
  assert.equal(CASE_SPECIALISTS_V1.topologyTarget.workers * (team.concurrencyLimit + 1), 100);
  assert.equal(agent.servers.some(server => server.name === 'fleet'), false);
  assert.equal(JSON.stringify(specs).includes('fleet_delegate'), false);
  assert.match(specs[1].nodes[0].prompt, /independent_verifier/);
});

test('missing required specialist tools and invalid concurrency refuse before installation', () => {
  assert.throws(() => buildFactoryTeamSpecs({ model: 'installed-model',
    availableServers: ['flujo'], specialists: CASE_SPECIALISTS_V1 }), /requires connected/);
  assert.throws(() => buildFactoryTeamSpecs({ model: 'installed-model', availableServers: [],
    limits: { concurrency: 10 } }), /concurrency/);
});
