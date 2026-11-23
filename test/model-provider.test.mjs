import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeProviderEnvironment, codexProviderConfig, codexProviderOverrides, flujoProviderModel, liteWorkerCommand, providerPrograms, validateModelProvider, LOCAL_MODEL_HOSTS } from '../src/public-sdk.mjs';
import { validateCloudLitePlan, secret } from '../src/cloud-lite/protocol.mjs';
import { providerConfigToml } from '../src/cloud-lite/runtime.mjs';
import { applyProviderEnvironment, plainHttpHosts } from '../src/model-provider.mjs';
import { tempDir } from './support/temp-dir.mjs';

// One description of a self-hosted vLLM endpoint that serves every wire API.
const endpoint = (extra = {}) => ({ id: 'selfhosted', name: 'Self-hosted model', model: 'served-model', envKey: 'SELF_HOSTED_MODEL_KEY',
  baseUrls: ['https://model-a.example.test/v1', 'https://model-b.example.test/v1'], apis: ['responses', 'chat', 'anthropic'],
  contextWindow: 262144, autoCompactTokenLimit: 100000, ...extra });

test('one provider description states which worker programs can use it', () => {
  assert.deepEqual(providerPrograms(endpoint()), ['codex', 'claude', 'flujo']);
  assert.deepEqual(providerPrograms(endpoint({ apis: undefined })), ['codex', 'flujo'], '0.4.0 descriptions keep working for Codex');
  assert.deepEqual(providerPrograms(endpoint({ apis: ['anthropic'] })), ['claude', 'flujo']);
  assert.deepEqual(providerPrograms(endpoint({ apis: ['chat'] })), ['flujo']);
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

test('a Claude Code child started from inside a Claude session inherits none of that session\'s variables', () => {
  const key = secret();
  const inherited = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', USE_STAGING_OAUTH: '1', ANTHROPIC_CUSTOM_HEADERS: 'x' };
  const env = claudeProviderEnvironment(endpoint(), { key, inherited });
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'USE_STAGING_OAUTH', 'ANTHROPIC_CUSTOM_HEADERS']) assert.equal(env[name], null, name);
  assert.equal('PATH' in env, false);
  // its own settings still win over a cleared name
  assert.equal(claudeProviderEnvironment(endpoint(), { key, inherited: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' } }).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(applyProviderEnvironment(inherited, env).CLAUDE_CODE_ENTRYPOINT, undefined);
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
  const dir = tempDir('factory-lite-provider-');
  const file = join(dir, 'endpoint.json'); writeFileSync(file, JSON.stringify(endpoint()));
  const cli = fileURLToPath(new URL('../bin/factory-lite.mjs', import.meta.url));
  const env = { ...process.env }; delete env.SELF_HOSTED_MODEL_KEY;
  const result = spawnSync(process.execPath, [cli, 'claude', join(dir, 'board.sqlite'), '--model-provider', file, 'hello'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set SELF_HOSTED_MODEL_KEY to the endpoint key/);
  assert.match(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout, /--model-provider/);
});

test('a model server on this computer may be plain http; every other address stays https', () => {
  assert.deepEqual(LOCAL_MODEL_HOSTS, ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);
  for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8000/v1', 'http://host.docker.internal:11434/v1'])
    assert.equal(validateModelProvider(endpoint({ baseUrls: [url] })).baseUrls[0], url);
  // Anything that leaves the computer, or only looks local, still needs https.
  for (const url of ['http://model.example.test/v1', 'http://192.168.1.20:11434/v1', 'http://localhost.example.test/v1', 'http://host.docker.internal.example.test/v1',
    'http://user:secret@localhost:11434/v1', 'http://localhost:11434/v1?key=x', 'ftp://localhost/v1'])
    assert.throws(() => validateModelProvider(endpoint({ baseUrls: [url] })), /plain http only for this computer/, url);
  assert.deepEqual(plainHttpHosts(endpoint()), []);
  assert.deepEqual(plainHttpHosts(endpoint({ baseUrls: ['https://model.example.test/v1', 'http://host.docker.internal:11434/v1', 'http://[::1]:8000/v1'] })), ['host.docker.internal', '[::1]']);
  // Each worker program gets the plain address as it is.
  const local = endpoint({ baseUrls: ['http://host.docker.internal:11434/v1'] });
  assert.match(codexProviderConfig(local), /^base_url = "http:\/\/host\.docker\.internal:11434\/v1"$/m);
  assert.equal(claudeProviderEnvironment(local, { key: 'local-key-0001' }).ANTHROPIC_BASE_URL, 'http://host.docker.internal:11434');
  assert.equal(flujoProviderModel(local, { key: 'local-key-0001', model: 'served-model' }).baseUrl, 'http://host.docker.internal:11434/v1');
  // A local lite worker on this computer may use a loopback address.
  const command = liteWorkerCommand({ provider: 'codex', database: 'board.sqlite', modelProvider: endpoint({ baseUrls: ['http://127.0.0.1:11434/v1'] }), providerKey: 'local-key-0001', env: {} });
  assert.ok(command.args.includes('model_providers.selfhosted.base_url="http://127.0.0.1:11434/v1"'));
});
