import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { applyProviderEnvironment, claudeProviderEnvironment, codexProviderOverrides, validateModelProvider } from './model-provider.mjs';

const mcp = fileURLToPath(new URL('../bin/factory-mcp.mjs', import.meta.url));

/**
 * Build a normal provider CLI command with its native tools and only FACTORY's MCP server.
 * With `modelProvider` (and its `providerKey`) the program talks to a self-hosted model
 * instead of its vendor login: Codex through the Responses API, Claude Code through the
 * Anthropic Messages API. `providerIndex` picks one of several endpoints.
 */
export function liteWorkerCommand({ provider, database, prompt, agentId, cwd = process.cwd(), modelProvider, providerKey, providerIndex = 0, env = process.env } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new TypeError('provider must be codex or claude');
  if (typeof database !== 'string' || !database.trim()) throw new TypeError('database path is required');
  if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim())) throw new TypeError('prompt must be nonempty');
  const db = resolve(database);
  if(agentId!==undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(agentId)) throw new TypeError('Invalid bound agent identity.');
  if (modelProvider !== undefined) {
    validateModelProvider(modelProvider);
    if (typeof providerKey !== 'string' || providerKey.length < 8) throw new TypeError('A model provider needs its API key.');
    if (!Number.isSafeInteger(providerIndex) || providerIndex < 0) throw new TypeError('providerIndex must be a nonnegative integer.');
  }
  const server = { command: process.execPath, args: [mcp, db, ...(agentId ? ['--actor',agentId] : [])] };
  if (provider === 'claude') return {
    command: 'claude', cwd,
    ...(modelProvider ? { env: applyProviderEnvironment(env, claudeProviderEnvironment(modelProvider, { index: providerIndex, key: providerKey })) } : {}),
    args: ['--dangerously-skip-permissions', '--strict-mcp-config',
      '--mcp-config', JSON.stringify({ mcpServers: { factory: server } }), ...(prompt === undefined ? [] : [prompt])],
  };
  const toml = value => JSON.stringify(value);
  const config = `mcp_servers={factory={command=${toml(server.command)},args=[${server.args.map(toml).join(',')}]}}`;
  // A provider gets its own Codex home, so no vendor login or earlier settings apply.
  const home = resolve(homedir(), '.factory', modelProvider ? `lite-codex-${modelProvider.id}` : 'lite-codex');
  return { command: 'codex', cwd, env: { ...env, CODEX_HOME: home, ...(modelProvider ? { [modelProvider.envKey]: providerKey } : {}) },
    args: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never',
    '--config', config,
    ...(modelProvider ? codexProviderOverrides(modelProvider, { index: providerIndex }).flatMap(entry => ['--config', entry]) : []),
    ...(prompt === undefined ? [] : [prompt])] };
}

/** Launch an interactive native CLI session and return its ChildProcess. */
export function startLiteWorker({ stdio = 'inherit', spawnImpl = spawn, ...options } = {}) {
  const spec = liteWorkerCommand(options);
  if (spec.env?.CODEX_HOME) mkdirSync(spec.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  return spawnImpl(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio });
}
