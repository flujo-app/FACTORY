// Found in a real Greenswarm run (Nov 12, flujo-app/FACTORY#36): a caller's status read that arrived while the fleet was being
// stopped opened a new private proxy, and nothing closed it after retire; the `fly proxy` process then kept the caller alive.
// A fleet being stopped or retired opens no new connection, and stop and retire close the one that is open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryCloudLiteFleet } from '../src/cloud-lite/fleet.mjs';
import { validateCloudLitePlan } from '../src/cloud-lite/protocol.mjs';
import { tempDir } from './support/temp-dir.mjs';

const plan = () => validateCloudLitePlan({ runId: 'lite-conn', app: 'factory-lite-conn', repository: 'mario-andreschak/FLUJO', goal: 'Close what you open', machines: 1, agentsPerMachine: 1 });

/** A fleet with one started coordinator Machine, a stand-in for fly and for the private proxy that counts what it opens. */
function fleetWithProxy({ onMachineStop = async () => {}, slowProxy = null } = {}) {
  const fleet = new FactoryCloudLiteFleet({ directory: tempDir('factory-cloud-lite-conn-') });
  fleet.state = { plan: plan(), status: 'provisioned', machines: [{ id: 'm-1', name: 'factory-lite-conn-m0', volumeId: 'v-1' }], operations: {} };
  fleet.save();
  const proxies = { opened: 0, stopped: 0 };
  fleet.execute = async (_bin, args) => {
    if (args[0] === 'machine' && args[1] === 'list') return JSON.stringify([{ id: 'm-1', name: 'factory-lite-conn-m0', state: 'started', config: { metadata: { 'factory.run': 'lite-conn', 'factory.machine': 'm0' } } }]);
    if (args[0] === 'machine' && args[1] === 'stop') { await onMachineStop(); return ''; }
    return '';
  };
  fleet.infrastructure = {
    unusedLoopbackPort: async () => 1,
    proxy: async () => {
      if (slowProxy) await slowProxy();
      proxies.opened++;
      return { origin: 'http://127.0.0.1:1', check() {}, stop: async () => { proxies.stopped++; } };
    },
  };
  return { fleet, proxies };
}

test('a status read that arrives while the fleet is being stopped opens no proxy', async () => {
  let late = null;
  const { fleet, proxies } = fleetWithProxy({ onMachineStop: async () => { late = fleet.request('/operator/status'); } });
  await fleet.stop();
  await assert.rejects(late, /being stopped/);
  assert.equal(proxies.opened, 0);
  assert.ok(!fleet.connection);
});

test('stop closes the connection that is open, and retire leaves none behind', async () => {
  const { fleet, proxies } = fleetWithProxy();
  fleet.connection = { origin: 'http://127.0.0.1:1', check() {}, stop: async () => { proxies.stopped++; } };
  await fleet.stop();
  assert.equal(proxies.stopped, 1);
  assert.ok(!fleet.connection);
  // a retire whose app removal was already done (journal) still ends without a connection, and after it nothing reconnects
  fleet.state.operations['app.retire'] = { state: 'succeeded', result: { app: 'factory-lite-conn', retired: true } };
  fleet.save();
  fleet.connection = { origin: 'http://127.0.0.1:1', check() {}, stop: async () => { proxies.stopped++; } };
  await fleet.retire();
  assert.equal(fleet.state.status, 'retired');
  assert.ok(!fleet.connection);
  await assert.rejects(fleet.request('/operator/status'), /retired/);
  assert.equal(proxies.opened, 0);
});

test('a proxy that was being opened when the stop began is closed again at once', async () => {
  let release;
  const { fleet, proxies } = fleetWithProxy({ slowProxy: () => new Promise((r) => { release = r; }) });
  const opening = fleet.request('/operator/status');
  while (!release) await new Promise((r) => setImmediate(r));
  const stopping = fleet.stop();
  release();
  await assert.rejects(opening, /stopped while its connection was being opened/);
  await stopping;
  assert.equal(proxies.opened, 1);
  assert.equal(proxies.stopped, 1);
  assert.ok(!fleet.connection);
});

test('a fleet started again after a stop connects as before', async () => {
  const { fleet } = fleetWithProxy();
  await fleet.stop();
  fleet.state.operations = {};
  fleet.save();
  await fleet.start({ attempt: 'again-1' }).catch(() => {});
  assert.equal(fleet.closed(), false);
});
