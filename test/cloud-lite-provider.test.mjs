import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCloudLitePlan, secret } from '../src/cloud-lite/protocol.mjs';
import { cloudLiteBootstrap } from '../src/cloud-lite/bootstrap.mjs';
import { FactoryCloudLiteFleet } from '../src/cloud-lite/fleet.mjs';
import { codexEnvironment, isStreamingDelta, nativeAgentConfig, providerConfigToml, runPrepareHook } from '../src/cloud-lite/runtime.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'factory-cloud-lite-provider-'));
// A self-hosted model with its real context window and an earlier compaction point.
const provider = () => ({ id: 'selfhosted', name: 'Self-hosted model', envKey: 'SELF_HOSTED_MODEL_KEY', model: 'served-model',
  baseUrls: ['https://model-a.example.test/v1', 'https://model-b.example.test/v1'], contextWindow: 262144, autoCompactTokenLimit: 80000 });
const plan = (extra = {}) => validateCloudLitePlan({ runId: 'provider-test', app: 'factory-provider-test', repository: 'example/project',
  goal: 'Work on operator jobs', machines: 2, agentsPerMachine: 3, model: 'served-model', subagentModel: 'served-model', modelProvider: provider(), ...extra });
// Assembled at run time so no key-shaped literal appears in the source.
const fixtureDeployKey = () => ['-----BEGIN', 'OPENSSH PRIVATE KEY-----\nfixture-only\n-----END', 'OPENSSH PRIVATE KEY-----\n'].join(' ');

test('plan validation accepts a self-hosted provider and operator settings and rejects unsafe values', () => {
  const valid = plan({ supervision: 'operator', sandbox: 'workspace-write', boardTools: false, monitorIntervalMs: 4000, traceDeltas: false,
    agentInstructions: 'Wait for operator jobs.', prepare: { argv: ['node', 'prepare.mjs'], spec: { team: 1 }, timeoutMs: 60000 } });
  assert.equal(valid.modelProvider.contextWindow, 262144);
  assert.equal('supervision' in plan(), false, 'new settings add no defaults to existing fleet bindings');
  const rejects = [
    { modelProvider: { ...provider(), baseUrls: ['http://model.example.test/v1'] } },
    { modelProvider: { ...provider(), baseUrls: ['https://user:pass@model.example.test/v1'] } },
    { modelProvider: { ...provider(), baseUrls: ['https://model.example.test/v1?key=x'] } },
    { modelProvider: { ...provider(), baseUrls: [] } },
    { modelProvider: { ...provider(), envKey: 'PATH' } },
    { modelProvider: { ...provider(), envKey: 'lower_case' } },
    { modelProvider: { ...provider(), id: 'Bad Id' } },
    { modelProvider: { ...provider(), contextWindow: 999 } },
    { modelProvider: { ...provider(), autoCompactTokenLimit: 262144 } },
    { modelProvider: { ...provider(), requestMaxRetries: 101 } },
    { supervision: 'manual' }, { sandbox: 'none' }, { boardTools: 'no' }, { traceDeltas: 1 }, { monitorIntervalMs: 999 },
    { agentInstructions: ' ' }, { prepare: { argv: [] } }, { prepare: { argv: ['node', 7] } }, { prepare: { argv: ['node'], spec: [] } },
    { workflow: 'verified-v1', supervision: 'operator' }, { workflow: 'verified-v1', boardTools: false },
  ];
  for (const extra of rejects) assert.throws(() => plan(extra), TypeError, JSON.stringify(extra));
});

test('provider Codex configuration spreads machines over endpoints and never contains the key', () => {
  const p = plan({ reasoningEffort: 'high' }); const key = secret();
  const first = providerConfigToml(p, 0); const second = providerConfigToml(p, 1); const third = providerConfigToml(p, 2);
  assert.match(first, /^model = "served-model"$/m);
  assert.match(first, /^model_provider = "selfhosted"$/m);
  assert.match(first, /^model_reasoning_effort = "high"$/m);
  assert.match(first, /^model_context_window = 262144$/m);
  assert.match(first, /^model_auto_compact_token_limit = 80000$/m);
  assert.match(first, /^\[model_providers\.selfhosted\]$/m);
  assert.match(first, /^env_key = "SELF_HOSTED_MODEL_KEY"$/m);
  assert.match(first, /^wire_api = "responses"$/m);
  assert.match(first, /^\[shell_environment_policy\]\ninherit = "core"$/m);
  assert.doesNotMatch(first, /forced_login_method|chatgpt/);
  assert.match(first, /base_url = "https:\/\/model-a\.example\.test\/v1"/);
  assert.match(second, /base_url = "https:\/\/model-b\.example\.test\/v1"/);
  assert.match(third, /base_url = "https:\/\/model-a\.example\.test\/v1"/);
  assert.equal(first.includes(key), false);
  const env = codexEnvironment({ plan: p, home: '/data/codex', providerKey: key, path: '/usr/bin' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/data', CODEX_HOME: '/data/codex', GIT_TERMINAL_PROMPT: '0', SELF_HOSTED_MODEL_KEY: key });
  const githubToken = secret();
  assert.equal(codexEnvironment({ plan: plan({ modelProvider: undefined }), home: '/h', githubToken }).GH_TOKEN, githubToken);
  assert.equal('GH_TOKEN' in codexEnvironment({ plan: p, home: '/h', githubToken, deployKey: fixtureDeployKey(), providerKey: key }), false);
});

test('agent sessions keep board tools and full access by default and narrow them on request', () => {
  const board = { command: 'node', args: ['proxy.mjs'], env: { FACTORY_BOARD_URL: 'http://board', FACTORY_BOARD_TOKEN: 'agent-token' } };
  const standard = nativeAgentConfig({ plan: plan({ modelProvider: undefined }), directory: '/data/worktrees/m0-a1', board });
  assert.equal(standard.sandbox, 'danger-full-access');
  assert.deepEqual(standard.config.mcp_servers.factory, { ...board, env: { ...board.env, FACTORY_WORKTREE: '/data/worktrees/m0-a1' }, required: true });
  assert.equal('sandbox_workspace_write.writable_roots' in standard.config, false);
  const narrowed = nativeAgentConfig({ plan: plan({ supervision: 'operator', sandbox: 'workspace-write', boardTools: false }),
    slot: { cwd: '/data/work/a1', writableRoots: ['/data/scratch'] }, directory: '/data/work/a1', board });
  assert.equal(narrowed.sandbox, 'workspace-write');
  assert.equal('mcp_servers' in narrowed.config, false);
  assert.deepEqual(narrowed.config['sandbox_workspace_write.writable_roots'], ['/data/scratch']);
  assert.equal(narrowed.config['sandbox_workspace_write.network_access'], false);
  assert.equal(narrowed.config['features.multi_agent'], false);
});

test('streaming deltas are recognized so traces keep only state-bearing notifications', () => {
  for (const method of ['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta', 'account/rateLimits/updated']) assert.equal(isStreamingDelta(method), true, method);
  for (const method of ['item/completed', 'turn/completed', 'thread/started', 'thread/tokenUsage/updated', undefined]) assert.equal(isStreamingDelta(method), false, String(method));
});

test('prepare hook receives its spec and machine index and must return an absolute workspace per agent', async () => {
  const stateDirectory = fresh(); const repositoryDirectory = fresh();
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FACTORY_CLOUD_BOOTSTRAP_B64: 'must-not-reach-the-hook' };
  const script = `const fs=require('node:fs');const spec=JSON.parse(fs.readFileSync(process.env.FACTORY_PREPARE_SPEC,'utf8'));
console.log('preparing', process.env.FACTORY_BOOTSTRAP_PROBE ?? process.env.FACTORY_CLOUD_BOOTSTRAP_B64 ?? 'clean');
console.log(JSON.stringify({agents:Array.from({length:spec.slots},(_,i)=>({cwd:'/work/m'+process.env.FACTORY_MACHINE_INDEX+'/a'+i,writableRoots:['/scratch'],instructions:spec.team+' member '+i}))}));`;
  const p = plan({ prepare: { argv: [process.execPath, '-e', script], spec: { slots: 3, team: 'blue' } } });
  const result = await runPrepareHook({ plan: p, index: 1, repositoryDirectory, env, stateDirectory });
  assert.deepEqual(result.agents.map(agent => agent.cwd), ['/work/m1/a0', '/work/m1/a1', '/work/m1/a2']);
  assert.equal(result.agents[2].instructions, 'blue member 2');
  assert.deepEqual(JSON.parse(readFileSync(join(stateDirectory, 'prepare-spec.json'), 'utf8')), { slots: 3, team: 'blue' });
  assert.match(readFileSync(join(stateDirectory, 'prepare.log'), 'utf8'), /preparing clean/);
  const wrongCount = plan({ prepare: { argv: [process.execPath, '-e', script], spec: { slots: 2, team: 'blue' } } });
  await assert.rejects(runPrepareHook({ plan: wrongCount, index: 0, repositoryDirectory, env, stateDirectory }), /absolute cwd for every agent slot/);
  const relative = plan({ prepare: { argv: [process.execPath, '-e', 'console.log(JSON.stringify({agents:[{cwd:"a"},{cwd:"b"},{cwd:"c"}]}))'] } });
  await assert.rejects(runPrepareHook({ plan: relative, index: 0, repositoryDirectory, env, stateDirectory }), /absolute cwd/);
  const failing = plan({ prepare: { argv: [process.execPath, '-e', 'console.error("broken input"); process.exit(3)'] } });
  await assert.rejects(runPrepareHook({ plan: failing, index: 0, repositoryDirectory, env, stateDirectory }), /Prepare hook failed/);
  assert.match(readFileSync(join(stateDirectory, 'prepare.log'), 'utf8'), /broken input/);
});

function providerInfrastructure(calls, { failVolumes } = {}) {
  const machines = [];
  return {
    run: async (args, options = {}) => {
      calls.push({ args, input: options.input });
      if (args[0] === 'volumes') { if (failVolumes) throw new Error(failVolumes()); return JSON.stringify({ id: `vol_${machines.length}` }); }
      if (args[0] === 'machine') return JSON.stringify(machines);
      return '';
    },
    buildMachineConfig: () => ({ init: { cmd: ['upstream-runtime'] }, services: [] }),
    createMachine: async ({ name, config }) => { const machine = { id: `machine-${machines.length}`, name, config }; machines.push(machine); return machine; },
  };
}
const image = 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64);

test('a model provider replaces the subscription broker and a deploy key replaces the GitHub token', async () => {
  const calls = []; const providerKey = secret(); const deployKey = fixtureDeployKey();
  const fleet = new FactoryCloudLiteFleet({ directory: fresh(), infrastructure: providerInfrastructure(calls) });
  await assert.rejects(fleet.deploy(plan(), { image, deployKey }), /needs its API key/);
  await assert.rejects(new FactoryCloudLiteFleet({ directory: fresh(), infrastructure: providerInfrastructure([]) })
    .deploy(plan({ modelProvider: undefined }), { image, deployKey }), /subscription auth broker/);
  await assert.rejects(fleet.deploy(plan(), { image, providerKey, deployKey: 'not a key' }), /private SSH key/);
  await assert.rejects(fleet.deploy(plan({ repository: undefined }), { image, providerKey, deployKey }), /private SSH key/);
  const result = await fleet.deploy(plan(), { image, providerKey, deployKey });
  assert.equal(result.machines.length, 2);
  const staged = calls.find(call => call.args[0] === 'secrets');
  const config = JSON.parse(Buffer.from(staged.input.trim().split('=').slice(1).join('='), 'base64').toString());
  assert.deepEqual(config.initialAuth, {});
  assert.equal(config.githubToken, undefined);
  assert.equal(config.providerKey, providerKey);
  assert.equal(config.deployKey, deployKey);
  assert.equal(config.plan.modelProvider.envKey, 'SELF_HOSTED_MODEL_KEY');
  const journal = readFileSync(join(fleet.directory, 'fleet.json'), 'utf8');
  assert.equal(journal.includes(providerKey), false); assert.equal(journal.includes('fixture-only'), false);
  const bootstrap = cloudLiteBootstrap('b'.repeat(64));
  assert.match(bootstrap, /openssh-client/);
  assert.match(bootstrap, /repositoryRevision && !config\.deployKey/);
});

test('provider and deploy keys are redacted from uncertain provider outcomes', async () => {
  const providerKey = secret(); const deployKey = fixtureDeployKey(); const directory = fresh();
  const fleet = new FactoryCloudLiteFleet({ directory, infrastructure: providerInfrastructure([], { failVolumes: () => `volume failed near ${providerKey} and ${deployKey}` }) });
  await assert.rejects(fleet.deploy(plan(), { image, providerKey, deployKey }));
  const journal = readFileSync(join(directory, 'fleet.json'), 'utf8');
  assert.match(journal, /\[REDACTED\]/);
  assert.equal(journal.includes(providerKey), false); assert.equal(journal.includes('fixture-only'), false);
});

test('a provider fleet observes without a subscription refresh', async () => {
  const directory = fresh();
  const fleet = new FactoryCloudLiteFleet({ directory }); fleet.state = { plan: plan(), machines: [], operations: {} }; fleet.save();
  writeFileSync(join(directory, 'observation.json'), '{broken');
  const order = [];
  fleet.request = async path => { order.push(path); if (path === '/operator/status') return { traceSequence: 0, agents: [], refreshRequested: true }; throw new Error(`Unexpected ${path}`); };
  await assert.rejects(fleet.observe(), SyntaxError);
  assert.deepEqual(order, ['/operator/status']);
});
