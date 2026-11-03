import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeProviderEnvironment, codexProviderConfig, codexProviderOverrides, liteWorkerCommand, providerPrograms, validateModelProvider } from '../src/public-sdk.mjs';
import { validateCloudLitePlan, secret } from '../src/cloud-lite/protocol.mjs';
import { providerConfigToml } from '../src/cloud-lite/runtime.mjs';

// One description of a self-hosted vLLM endpoint that serves every wire API.
const endpoint = (extra = {}) => ({ id: 'selfhosted', name: 'Self-hosted model', model: 'served-model', envKey: 'SELF_HOSTED_MODEL_KEY',
  baseUrls: ['https://model-a.example.test/v1', 'https://model-b.example.test/v1'], apis: ['responses', 'chat', 'anthropic'],
  contextWindow: 262144, autoCompactTokenLimit: 100000, ...extra });

test('one provider description states which worker programs can use it', () => {
  assert.deepEqual(providerPrograms(endpoint()), ['codex', 'claude']);
  assert.deepEqual(providerPrograms(endpoint({ apis: undefined })), ['codex'], '0.4.0 descriptions keep working for Codex');
  assert.deepEqual(providerPrograms(endpoint({ apis: ['anthropic'] })), ['claude']);
  for (const extra of [{ apis: [] }, { apis: ['grpc'] }, { envKey: 'ANTHROPIC_AUTH_TOKEN' }, { requestTimeoutMs: 10 }]) assert.throws(() => validateModelProvider(endpoint(extra)), TypeError, JSON.stringify(extra));
  assert.throws(() => validateCloudLitePlan({ runId: 'claude-only', app: 'claude-only-app', goal: 'x', modelProvider: endpoint({ apis: ['anthropic'] }) }), /responses API/);
});

test('the Codex mapping is shared by cloud and local workers and never carries the key', () => {
  const plan = validateCloudLitePlan({ runId: 'mapping-run', app: 'mapping-app', goal: 'x', model: 'ignored-plan-model', reasoningEffort: 'high', modelProvider: endpoint() });
  assert.equal(providerConfigToml(plan, 1), codexProviderConfig(endpoint(), { index: 1, reasoningEffort: 'high' }));
  const toml = codexProviderConfig(endpoint(), { index: 1, reasoningEffort: 'high' });
  assert.match(toml, /^model = "served-model"$/m);
  assert.match(toml, /^model_auto_compact_token_limit = 100000$/m);
  assert.match(toml, /^base_url = "https:\/\/model-b\.example\.test\/v1"$/m);
  const overrides = codexProviderOverrides(endpoint(), { index: 2 });
  assert.ok(overrides.includes('model_provider="selfhosted"'));
  assert.ok(overrides.includes('model_providers.selfhosted.base_url="https://model-a.example.test/v1"'));
  assert.ok(overrides.includes('model_providers.selfhosted.wire_api="responses"'));
  assert.ok(overrides.includes('shell_environment_policy.inherit="core"'));
  assert.ok(overrides.includes('model_context_window=262144'));
  assert.equal(overrides.some(entry => entry.startsWith('model_reasoning_effort')), false);
  assert.throws(() => codexProviderConfig(endpoint({ apis: ['anthropic'] })), /responses API/);
  assert.throws(() => codexProviderConfig(endpoint({ model: undefined })), /served model/);
});

test('the Claude Code mapping uses the Anthropic API at the server root with every alias on the served model', () => {
  const key = secret();
  const env = claudeProviderEnvironment(endpoint(), { index: 1, key });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://model-b.example.test');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, key);
  assert.equal(env.ANTHROPIC_API_KEY, null); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, null);
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[name], 'served-model', name);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '262144');
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '100000');
  assert.equal(env.CLAUDE_CODE_TOTAL_TOKENS_REMINDER, 'off');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.throws(() => claudeProviderEnvironment(endpoint({ apis: ['responses'] }), { key }), /anthropic API/);
  assert.throws(() => claudeProviderEnvironment(endpoint(), { key: 'short' }), /API key/);
});

test('local lite workers launch Codex and Claude Code against a self-hosted model', () => {
  const key = secret(); const inherited = { PATH: '/bin', ANTHROPIC_API_KEY: 'vendor-key-value', CLAUDE_CODE_OAUTH_TOKEN: 'vendor-login' };
  const codex = liteWorkerCommand({ provider: 'codex', database: 'board.sqlite', modelProvider: endpoint(), providerKey: key, providerIndex: 1, env: inherited });
  assert.equal(codex.env.SELF_HOSTED_MODEL_KEY, key);
  assert.match(codex.env.CODEX_HOME, /lite-codex-selfhosted$/);
  assert.ok(codex.args.includes('model_providers.selfhosted.base_url="https://model-b.example.test/v1"'));
  assert.equal(JSON.stringify(codex.args).includes(key), false);
  const claude = liteWorkerCommand({ provider: 'claude', database: 'board.sqlite', modelProvider: endpoint(), providerKey: key, env: inherited });
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'https://model-a.example.test');
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, key);
  assert.equal('ANTHROPIC_API_KEY' in claude.env, false); assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in claude.env, false);
  assert.equal(claude.env.PATH, '/bin');
  assert.equal(JSON.stringify(claude.args).includes(key), false);
  assert.equal(liteWorkerCommand({ provider: 'claude', database: 'board.sqlite' }).env, undefined, 'without a provider Claude keeps its own login');
  assert.throws(() => liteWorkerCommand({ provider: 'codex', database: 'board.sqlite', modelProvider: endpoint() }), /API key/);
  assert.throws(() => liteWorkerCommand({ provider: 'claude', database: 'board.sqlite', modelProvider: endpoint({ apis: ['responses'] }), providerKey: key }), /anthropic API/);
});

test('factory-lite reads an endpoint description and refuses to start without its key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lite-provider-'));
  const file = join(dir, 'endpoint.json'); writeFileSync(file, JSON.stringify(endpoint()));
  const cli = fileURLToPath(new URL('../bin/factory-lite.mjs', import.meta.url));
  const env = { ...process.env }; delete env.SELF_HOSTED_MODEL_KEY;
  const result = spawnSync(process.execPath, [cli, 'claude', join(dir, 'board.sqlite'), '--model-provider', file, 'hello'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set SELF_HOSTED_MODEL_KEY to the endpoint key/);
  assert.match(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout, /--model-provider/);
});
