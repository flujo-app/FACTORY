import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyProviderEnvironment, claudeProviderEnvironment, codexProviderOverrides, flujoProviderModel, validateModelProvider } from './model-provider.mjs';
import { FlujoProgram, FlujoSessionDriver, FLUJO_WORKER_PORT } from './cloud-lite/flujo-driver.mjs';

const mcp = fileURLToPath(new URL('../bin/factory-mcp.mjs', import.meta.url));

/**
 * Build a normal provider CLI command with its native tools and only FACTORY's MCP server.
 * With `modelProvider` (and its `providerKey`) the program talks to a self-hosted model
 * instead of its vendor login: Codex through the Responses API, Claude Code through the
 * Anthropic Messages API, FLUJO through a stored model record. `providerIndex` picks one of
 * several endpoints. For FLUJO this is the command that starts its server.
 */
export function liteWorkerCommand({ provider, database, prompt, agentId, cwd = process.cwd(), modelProvider, providerKey, providerIndex = 0, env = process.env, port = FLUJO_WORKER_PORT, dataDirectory } = {}) {
  if (!['codex', 'claude', 'flujo'].includes(provider)) throw new TypeError('provider must be codex, claude or flujo');
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
  if (provider === 'flujo') return {
    command: 'flujo', cwd, server, args: ['--no-open', '--port', String(port)],
    // Its own data folder, so a worker never touches the settings of a FLUJO someone uses by hand.
    env: { ...env, FLUJO_DATA_DIR: dataDirectory ?? resolve(homedir(), '.factory', 'lite-flujo', 'data'), FLUJO_PORT: String(port) },
  };
  if (provider === 'claude') return {
    command: 'claude', cwd,
    ...(modelProvider ? { env: applyProviderEnvironment(env, claudeProviderEnvironment(modelProvider, { index: providerIndex, key: providerKey, inherited: env })) } : {}),
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

/**
 * A FLUJO worker on this computer: attaches to `origin`, or starts its own FLUJO server, then installs
 * one workspace with the generic team template and the board. The agent keeps its conversation across runs.
 */
export async function startFlujoLiteWorker({ origin, token, prompt, modelProvider, providerKey, providerIndex = 0, flujoModel, model, teamConcurrency, agentRole = 'orchestrator', servers, stateDirectory, developerInstructions, driverFactory = settings => new FlujoSessionDriver(settings), programFactory = settings => new FlujoProgram(settings), ...options } = {}) {
  const spec = liteWorkerCommand({ ...options, provider: 'flujo', prompt, modelProvider, providerKey, providerIndex });
  if (!modelProvider && !flujoModel) throw new TypeError('A FLUJO worker needs a modelProvider or a flujoModel record.');
  const state = stateDirectory ?? resolve(homedir(), '.factory', 'lite-flujo', options.agentId ?? 'default');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const program = origin ? undefined : programFactory({ port: Number(spec.env.FLUJO_PORT), environment: () => spec.env });
  const driver = driverFactory({ origin, token, program, stateDirectory: state, servers, team: { ...(teamConcurrency ? { concurrency: teamConcurrency } : {}) },
    modelRecord: name => flujoModel ?? flujoProviderModel(modelProvider, { index: providerIndex, key: providerKey, model: model ?? name }) });
  await driver.initialize();
  const settings = { cwd: spec.cwd, model, sandbox: 'danger-full-access', agentRole, developerInstructions, config: { mcp_servers: { factory: spec.server } } };
  const sessionFile = join(state, 'session.json');
  let opened;
  if (existsSync(sessionFile)) {
    try { opened = await driver.request('thread/resume', { ...settings, threadId: JSON.parse(readFileSync(sessionFile, 'utf8')).threadId }); }
    catch (error) { if (error.code !== -32600) throw error; }
  }
  opened ??= await driver.request('thread/start', settings);
  const threadId = opened.thread.id;
  writeFileSync(sessionFile, JSON.stringify({ threadId }), { mode: 0o600 });
  const conversation = text => [{ type: 'text', text }];
  const worker = { origin: driver.origin, workspace: driver.thread(threadId).workspace, threadId, driver, child: program?.child ?? null,
    /** Starts a turn, or joins the one that is running. */
    send: async text => {
      const running = driver.thread(threadId).turn;
      if (!running) return driver.request('turn/start', { threadId, input: conversation(text) });
      return driver.request('turn/steer', { threadId, expectedTurnId: running.id, input: conversation(text) });
    },
    /** Resolves when the current turn has ended, with its final status. */
    settled: () => new Promise(accept => {
      const last = driver.thread(threadId);
      if (!last.turn) { accept(last.lastTurn); return; }
      const listen = note => { if (note.method === 'turn/completed' && note.params.threadId === threadId) { driver.off('notification', listen); accept(note.params.turn); } };
      driver.on('notification', listen);
    }),
    stop: async () => {
      const running = driver.thread(threadId).turn;
      if (running) await driver.request('turn/interrupt', { threadId, turnId: running.id }).catch(() => {});
      driver.close();
      await program?.stop();
    } };
  if (prompt !== undefined) await worker.send(prompt);
  return worker;
}

/** Launch an interactive native CLI session and return its ChildProcess. FLUJO has no such session: it returns a promise of its worker handle. */
export function startLiteWorker({ stdio = 'inherit', spawnImpl = spawn, ...options } = {}) {
  if (options.provider === 'flujo') return startFlujoLiteWorker(options);
  const spec = liteWorkerCommand(options);
  if (spec.env?.CODEX_HOME) mkdirSync(spec.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  return spawnImpl(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio });
}
