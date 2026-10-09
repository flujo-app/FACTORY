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

test('generic team keeps observed connected tools and one aggregate native gate', () => {
  const inventory = {
    filesystem: ['read_file', 'write_file', 'search'],
    bash: ['run', 'start'],
    browser: ['browser_open', 'browser_snapshot', 'browser_new_capability'],
    flujo: ['read_flow', 'update_flow', 'create_flow', 'future_authoring_tool'],
    github: ['get_issue', 'create_pull_request'],
  };
  const [agent, team] = buildFactoryTeamSpecs({ model: 'installed-model',
    availableServers: Object.keys(inventory), availableTools: inventory,
    limits: { concurrency: 3 }, goalContext: 'Ship one usable product change.',
    environment: { repo: '/workspace/repo', board: 'https://example.test/issues/1' } });
  for (const process of [agent.nodes.find(node => node.key === 'agent'), team.nodes.find(node => node.key === 'lead')]) {
    assert.deepEqual(process.servers, Object.entries(inventory).map(([name, tools]) => ({ name, tools })));
  }
  assert.equal(team.nodes.filter(node => node.type === 'subflow').length, 1);
  assert.equal(team.nodes.find(node => node.type === 'subflow').concurrencyLimit, 3);
  assert.match(team.nodes[0].prompt, /usable product change/);
  assert.match(agent.nodes[0].prompt, /workspace\/repo/);
  assert.throws(() => buildFactoryTeamSpecs({ model: 'installed-model',
    environment: { token: 42 } }), /environment/);
  assert.throws(() => buildFactoryTeamSpecs({ model: 'installed-model',
    availableTools: { github: ['get_issue', 'get_issue'] } }), /Invalid observed tool names/);
});
