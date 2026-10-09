import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run against a fresh install of an npm pack tarball, outside this checkout.
const consumer = process.env.FACTORY_CONSUMER;
assert.ok(consumer && isAbsolute(consumer), 'FACTORY_CONSUMER must be an absolute consumer directory');
const require = createRequire(join(consumer, 'index.mjs'));
const sdk = await import(pathToFileURL(require.resolve('flujo-factory')));
for (const name of [
  'Factory',
  'FactoryManagedFleet',
  'buildSaviaCasePlan',
  'observeSaviaCaseTopology',
  'createObservatoryClient',
  'liteWorkerCommand',
  'startLiteWorker',
]) {
  assert.equal(typeof sdk[name], 'function', `${name} is missing`);
}
const observatory = await import(pathToFileURL(require.resolve('flujo-factory/observatory')));
assert.equal(typeof observatory.createObservatoryClient, 'function');
assert.equal(existsSync(join(consumer, 'node_modules', 'flujo-factory', 'src', 'observatory-client.d.mts')), true);

const factory = new sdk.Factory(join(consumer, 'control.sqlite'));
factory.createSwarm({ mission: 'package smoke', budgetCents: 0, agents: [{ id: 'agent-a' }] });
assert.equal(factory.status().cells.length, 2);
const child = { pid: 7 };
let launched;
assert.equal(factory.startLiteWorker({
  provider: 'claude',
  spawnImpl(command, args, options) {
    launched = { command, args, options };
    return child;
  },
}), child);
assert.equal(launched.command, 'claude');
assert.equal(JSON.parse(launched.args[launched.args.indexOf('--mcp-config') + 1]).mcpServers.factory.args[1], factory.database);

assert.deepEqual(factory.listTemplates().map(template => template.name), ['generic']);
const created = factory.createTemplate({
  name: 'package-smoke',
  goalContext: 'Deliver a synthetic customer case',
  environment: { channel: 'synthetic' },
  limits: { concurrency: 2 },
});
assert.equal(created.revision, 1);
assert.equal(factory.getTemplate('package-smoke').goalContext, 'Deliver a synthetic customer case');
const specs = factory.buildTemplate('package-smoke', {
  model: 'installed-model', availableServers: [], availableTools: {},
});
assert.deepEqual(specs.map(spec => spec.name), ['swarm_agent', 'swarm_team']);
assert.equal(specs[1].nodes.find(node => node.key === 'agents').concurrencyLimit, 2);
assert.match(specs[1].nodes[0].prompt, /synthetic customer case/);
const updated = factory.updateTemplate('package-smoke', {
  expectedRevision: created.revision,
  goalContext: 'Deliver a synthetic case status',
});
assert.equal(updated.revision, 2);
assert.equal(factory.getTemplate('package-smoke').goalContext, 'Deliver a synthetic case status');
assert.equal(factory.deleteTemplate('package-smoke', { expectedRevision: updated.revision }).deleted, true);
assert.equal(factory.getTemplate('package-smoke'), null);
