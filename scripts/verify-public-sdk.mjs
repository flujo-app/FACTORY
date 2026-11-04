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
  'FactoryControl',
  'executeEffect',
  'FactoryManagedFleet',
  'buildSaviaCasePlan',
  'observeSaviaCaseTopology',
  'createObservatoryClient',
  'liteWorkerCommand',
  'startLiteWorker',
  'FactoryCloudLiteFleet',
  'CodexSubscriptionBroker',
  'validateCloudLitePlan',
  'cloudLiteMachineConfig',
  'FactoryWorkflow',
  'FactoryArtifactStore',
  'FactoryWorkflowSupervisor',
  'captureGitSource',
  'ClaudeSubscriptionBroker',
  'captureWorkspace',
  'submitWorkspaceCandidate',
  'ContinuousEvidenceCollector',
  'createEvidenceClient',
  'startEvidenceServer',
  'restoreEvidenceCheckpoint',
  'runVerification',
  'createWorkflowClient',
  'createWorkflowComparison',
]) {
  assert.equal(typeof sdk[name], 'function', `${name} is missing`);
}
const observatory = await import(pathToFileURL(require.resolve('flujo-factory/observatory')));
const workflows = await import(pathToFileURL(require.resolve('flujo-factory/workflows')));
assert.equal(workflows.FactoryWorkflow,sdk.FactoryWorkflow);
assert.equal(workflows.listWorkflowTemplates().length,5);
assert.equal(existsSync(join(consumer,'node_modules','flujo-factory','src','workflows','index.d.mts')),true);
assert.equal(existsSync(join(consumer,'node_modules','flujo-factory','WORKFLOWS.md')),true);
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

// Cloud lite workers accept a self-hosted model provider and operator-driven jobs.
const providerPlan = sdk.validateCloudLitePlan({ runId: 'package-smoke', app: 'package-smoke-app', goal: 'Operator jobs',
  modelProvider: { id: 'selfhosted', envKey: 'SELF_HOSTED_MODEL_KEY', baseUrls: ['https://model.example/v1'], contextWindow: 262144, autoCompactTokenLimit: 80000 },
  supervision: 'operator', sandbox: 'workspace-write', boardTools: false });
assert.equal(providerPlan.modelProvider.autoCompactTokenLimit, 80000);
assert.throws(() => sdk.validateCloudLitePlan({ ...providerPlan, modelProvider: { ...providerPlan.modelProvider, baseUrls: ['http://model.example/v1'] } }), TypeError);
// One provider description maps to Codex and Claude Code.
const endpoint = { ...providerPlan.modelProvider, model: 'served-model', apis: ['responses', 'anthropic'] };
assert.deepEqual(sdk.providerPrograms(endpoint), ['codex', 'claude', 'flujo']);
assert.equal(sdk.flujoProviderModel(endpoint, { key: 'package-smoke-key' }).adapter, 'openai-responses');
assert.equal(typeof sdk.FlujoSessionDriver, 'function');
assert.equal(typeof sdk.packFactorySdk, 'function');
assert.match(sdk.cloudLiteBootstrap('a'.repeat(64), { workerProgram: 'flujo' }), /flujo-ai-\d+\.\d+\.\d+\.tgz/);
assert.match(sdk.codexProviderConfig(endpoint), /wire_api = "responses"/);
assert.equal(sdk.claudeProviderEnvironment(endpoint, { key: 'package-smoke-key' }).ANTHROPIC_BASE_URL, 'https://model.example');
// Self-hosted model serving ships its Python sources and profiles, but not its tests.
assert.deepEqual(sdk.selfHostedProfiles().map(profile => profile.id), ['nemotron', 'qwen']);
for (const file of ['app.py', 'settings.py', 'discovery.py', 'deploy.py', 'prices.json', 'profiles/qwen.json', 'profiles/nemotron.json']) {
  assert.equal(existsSync(join(sdk.SELFHOST_MODAL_DIR, file)), true, `${file} is missing`);
}
assert.equal(existsSync(join(sdk.SELFHOST_MODAL_DIR, 'test_settings.py')), false);
assert.equal(typeof sdk.ModalSelfHostedModel, 'function');
