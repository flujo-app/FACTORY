import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyProviderEnvironment, claudeProviderEnvironment } from '../model-provider.mjs';

// Built-in tools a worker keeps. Automatic fanout, schedules, web access and the rest stay off, so
// every session has its own board identity and policy, as with Codex's disabled multi-agent feature.
const WRITE_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'NotebookEdit', 'Glob', 'Grep'];
const READ_TOOLS = ['Bash', 'Read', 'Glob', 'Grep'];
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const invalid = message => Object.assign(new Error(message), { code: -32600 });

/**
 * The environment of one Claude Code process. A self-hosted provider gets its mapped settings and
 * key, a subscription gets its token. `CLAUDE_CODE_SHELL_PREFIX` removes both from agent commands.
 */
export function claudeEnvironment({ plan, index = 0, home, commandWrapper, githubToken, deployKey, providerKey, oauthToken, path = process.env.PATH }) {
  const base = { PATH: path, HOME: '/data', CLAUDE_CONFIG_DIR: home, GIT_TERMINAL_PROMPT: '0',
    // The worker Machine is the disposable sandbox; Claude Code otherwise refuses full access as root.
    IS_SANDBOX: '1',
    ...(commandWrapper ? { CLAUDE_CODE_SHELL_PREFIX: commandWrapper } : {}),
    ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    ...(githubToken && !deployKey ? { GH_TOKEN: githubToken } : {}) };
  if (plan.modelProvider) return applyProviderEnvironment(base, claudeProviderEnvironment(plan.modelProvider, { index, key: providerKey, model: plan.model }));
  return { ...base, ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}) };
}

/**
 * Claude Code runs agent commands and MCP servers as `<wrapper> "<command line>"`. The wrapper drops
 * the model credentials first, and with a provider also the GitHub token, like Codex's core policy.
 */
export function claudeCommandWrapper({ provider = false } = {}) {
  const removed = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', ...(provider ? ['GH_TOKEN'] : [])];
  return `#!/bin/sh\nexec env ${removed.map(name => `-u ${name}`).join(' ')} /bin/bash -c "$1"\n`;
}

/**
 * Maps a Codex sandbox name to Claude Code. The two narrow modes rely on Claude Code's operating
 * system sandbox (bubblewrap) for commands, with no network; file tools stay inside the same folders.
 */
export function claudeSandboxPolicy({ sandbox = 'danger-full-access', directory, writableRoots = [] }) {
  if (sandbox === 'danger-full-access') return { tools: WRITE_TOOLS, args: ['--dangerously-skip-permissions'], allowed: [] };
  const base = { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true, network: { allowedDomains: [] } };
  if (sandbox === 'workspace-write') return { tools: WRITE_TOOLS, allowed: ['Bash'],
    args: ['--permission-mode', 'acceptEdits', ...writableRoots.flatMap(root => ['--add-dir', root])],
    settings: { sandbox: { ...base, filesystem: { allowWrite: writableRoots } } } };
  if (sandbox === 'read-only') return { tools: READ_TOOLS, allowed: READ_TOOLS, args: ['--permission-mode', 'dontAsk'],
    settings: { sandbox: { ...base, filesystem: { denyWrite: [directory] } } } };
  throw new TypeError(`Unsupported sandbox ${sandbox}.`);
}

/** The command line for one turn of one session. Nothing secret goes into arguments. */
export function claudeSessionArguments({ threadId, resume, model, effort, instructions, policy, mcpConfigFile, settingsFile, boardTools, partialMessages }) {
  const allowed = [...policy.allowed, ...(boardTools ? ['mcp__factory__*'] : [])];
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--strict-mcp-config', '--setting-sources', 'user', '--disable-slash-commands', '--permission-prompts', 'none',
    '--tools', policy.tools.join(','), ...policy.args,
    ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
    ...(settingsFile ? ['--settings', settingsFile] : []),
    ...(mcpConfigFile ? ['--mcp-config', mcpConfigFile] : []),
    ...(model ? ['--model', model] : []),
    ...(EFFORTS.has(effort) ? ['--effort', effort] : []),
    ...(instructions ? ['--append-system-prompt', instructions] : []),
    ...(partialMessages ? ['--include-partial-messages'] : []),
    ...(resume ? ['--resume', threadId] : ['--session-id', threadId])];
}

/**
 * One Claude Code process per running turn, behind the method and notification contract the cloud
 * runtime already uses for a Codex app-server: thread/start|resume|read and turn/start|steer|interrupt,
 * with turn and item notifications. An idle session holds no process, so idle is simple to prove.
 */
export class ClaudeSessionDriver extends EventEmitter {
  constructor({ command = 'claude', args = [], environment, configDirectory, stateDirectory, fixedModel, partialMessages = false, onStderr,
    interruptGraceMs = 10000, killGraceMs = 3000, exitGraceMs = 5000, steerGraceMs = 30000 } = {}) {
    super();
    Object.assign(this, { command, baseArgs: args, environment, configDirectory, stateDirectory, fixedModel, partialMessages, onStderr, interruptGraceMs, killGraceMs, exitGraceMs, steerGraceMs });
    this.threads = new Map();
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  }

  async initialize() {}

  async request(method, params = {}) {
    if (method === 'thread/start') return this.startThread(params);
    if (method === 'thread/resume') return this.resumeThread(params);
    if (method === 'thread/read') return this.readThread(params);
    if (method === 'turn/start') return this.startTurn(params);
    if (method === 'turn/steer') return this.steerTurn(params);
    if (method === 'turn/interrupt') return this.interruptTurn(params);
    throw invalid(`Unsupported method ${method}.`);
  }

  notify(method, params) { this.emit('notification', { method, params }); }
  stateFile(id) { return join(this.stateDirectory, `${id}.claude.json`); }

  transcriptExists(id) {
    const projects = join(this.configDirectory, 'projects');
    if (!existsSync(projects)) return false;
    return readdirSync(projects).some(name => existsSync(join(projects, name, `${id}.jsonl`)));
  }

  /** Session files carry the board credential, so they are private and outside the arguments. */
  addThread(id, { cwd, config, sandbox, model, developerInstructions, lastTurn = null }) {
    const server = config?.mcp_servers?.factory;
    const directory = this.stateDirectory;
    const policy = claudeSandboxPolicy({ sandbox, directory: cwd, writableRoots: config?.['sandbox_workspace_write.writable_roots'] ?? [] });
    let mcpConfigFile, settingsFile;
    if (server) {
      mcpConfigFile = join(directory, `${id}.claude-mcp.json`);
      writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { factory: { command: server.command, args: server.args, env: server.env } } }), { mode: 0o600 });
    }
    if (policy.settings) {
      settingsFile = join(directory, `${id}.claude-settings.json`);
      writeFileSync(settingsFile, JSON.stringify(policy.settings), { mode: 0o600 });
    }
    const thread = { id, cwd, policy, mcpConfigFile, settingsFile, boardTools: Boolean(server), model: this.fixedModel ?? model, instructions: developerInstructions, lastTurn, turn: null, child: null, totals: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
    this.threads.set(id, thread);
    this.save(thread);
    return thread;
  }

  save(thread) {
    const file = this.stateFile(thread.id), next = `${file}.next`;
    writeFileSync(next, JSON.stringify({ threadId: thread.id, lastTurn: thread.lastTurn }), { mode: 0o600 });
    renameSync(next, file);
  }

  describe(thread, includeTurns) {
    return { id: thread.id, status: { type: thread.child ? 'active' : 'idle' }, ...(includeTurns ? { turns: thread.lastTurn ? [thread.lastTurn] : [] } : {}) };
  }

  thread(id) {
    const thread = this.threads.get(id);
    if (!thread) throw invalid(`Unknown thread ${id}.`);
    return thread;
  }

  startThread(params) {
    const thread = this.addThread(randomUUID(), params);
    this.notify('thread/started', { threadId: thread.id, thread: { id: thread.id } });
    return { thread: this.describe(thread) };
  }

  resumeThread(params) {
    const id = params.threadId;
    const unavailable = () => invalid(`no rollout found for thread id ${id}`);
    if (!existsSync(this.stateFile(id))) throw unavailable();
    const { lastTurn } = JSON.parse(readFileSync(this.stateFile(id), 'utf8'));
    // A session without a turn has no history to lose; one with a turn must still have its history.
    if (lastTurn && !this.transcriptExists(id)) throw unavailable();
    // Any process died with the old Machine, so a turn left in progress did not finish.
    const recovered = lastTurn?.status === 'inProgress' ? { ...lastTurn, status: 'interrupted' } : lastTurn;
    const thread = this.addThread(id, { ...params, lastTurn: recovered });
    this.notify('thread/resumed', { threadId: id, thread: { id } });
    return { thread: this.describe(thread), ...(lastTurn?.status === 'inProgress' ? { recoveredTurn: recovered } : {}) };
  }

  readThread({ threadId, includeTurns }) {
    return { thread: this.describe(this.thread(threadId), includeTurns) };
  }

  startTurn({ threadId, input, effort }) {
    const thread = this.thread(threadId);
    if (thread.child) throw invalid('This thread already has a running turn.');
    const turn = { id: randomUUID(), written: 0, replayed: 0 };
    const args = [...this.baseArgs, ...claudeSessionArguments({ threadId, resume: this.transcriptExists(threadId), model: thread.model, effort, instructions: thread.instructions,
      policy: thread.policy, mcpConfigFile: thread.mcpConfigFile, settingsFile: thread.settingsFile, boardTools: thread.boardTools, partialMessages: this.partialMessages })];
    thread.lastTurn = { id: turn.id, status: 'inProgress' };
    this.save(thread);
    const child = spawn(this.command, args, { cwd: thread.cwd, env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    thread.child = child; thread.turn = turn;
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => this.onStderr?.(chunk.toString()));
    createInterface({ input: child.stdout }).on('line', line => this.receive(thread, turn, line));
    child.on('error', () => this.finish(thread, turn));
    // A command the agent left running can hold the output pipes open after the program itself ended.
    child.on('exit', () => { turn.exitTimer = setTimeout(() => this.finish(thread, turn), 1000); });
    child.on('close', () => this.finish(thread, turn));
    this.notify('thread/status/changed', { threadId, status: { type: 'active' } });
    this.notify('turn/started', { threadId, turn: { id: turn.id, status: 'inProgress' } });
    this.write(thread, turn, input);
    return { turn: { id: turn.id, status: 'inProgress' } };
  }

  write(thread, turn, input) {
    turn.written++;
    const content = (input ?? []).filter(item => item.type === 'text').map(item => ({ type: 'text', text: item.text }));
    thread.child.stdin.write(JSON.stringify({ type: 'user', session_id: thread.id, parent_tool_use_id: null, message: { role: 'user', content } }) + '\n');
  }

  /** Claude Code takes a message written during a turn into that turn, or runs it straight after. */
  steerTurn({ threadId, expectedTurnId, input }) {
    const thread = this.thread(threadId), turn = thread.turn;
    if (!turn || turn.closing || turn.interrupting) throw new Error('no active turn to steer');
    if (expectedTurnId && expectedTurnId !== turn.id) throw invalid('The expected turn is not the running turn.');
    this.write(thread, turn, input);
    return { turnId: turn.id };
  }

  interruptTurn({ threadId, turnId }) {
    const thread = this.thread(threadId), turn = thread.turn;
    if (!turn || turn.id !== turnId) {
      if (thread.lastTurn?.id === turnId) return {};
      throw invalid('The expected turn is not the running turn.');
    }
    if (turn.closing || turn.interrupting) return {};
    turn.interrupting = true;
    clearTimeout(turn.steerTimer);
    thread.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }) + '\n');
    // A session that does not answer is ended outright: a stopped process is the strongest proof.
    turn.interruptTimer = setTimeout(() => this.kill(thread, turn), this.interruptGraceMs);
    return {};
  }

  receive(thread, turn, line) {
    let value;
    try { value = JSON.parse(line); } catch { this.emit('protocolError', { bytes: line.length }); return; }
    const threadId = thread.id, turnId = turn.id;
    const item = body => this.notify('item/completed', { threadId, turnId, item: body });
    if (value.type === 'system' && value.subtype === 'init') {
      // The same promise Codex gets from a required MCP server: a worker never runs without its board.
      const boardFailed = thread.boardTools && value.mcp_servers?.some(server => server.name === 'factory' && server.status === 'failed');
      if (value.session_id !== threadId || boardFailed) {
        this.onStderr?.(boardFailed ? 'The board MCP server did not connect; ending the turn.' : 'Claude Code opened a different session than requested; ending the turn.');
        turn.outcome = { status: 'failed' }; this.kill(thread, turn);
      }
    } else if (value.type === 'system' && value.subtype === 'api_retry') {
      this.notify('model/retry', { threadId, turnId, attempt: value.attempt, status: value.error_status, error: value.error });
      if (value.error === 'authentication_failed') this.emit('authFailed', { threadId });
    } else if (value.type === 'assistant') {
      for (const block of value.message?.content ?? []) {
        if (block.type === 'text') item({ type: 'agentMessage', text: block.text });
        else if (block.type === 'thinking') item({ type: 'reasoning', text: block.thinking });
        else if (block.type === 'tool_use') item({ type: 'toolCall', id: block.id, tool: block.name, arguments: block.input });
      }
    } else if (value.type === 'user') {
      if (value.isReplay) { turn.replayed++; return; }
      for (const block of Array.isArray(value.message?.content) ? value.message.content : []) {
        if (block.type === 'tool_result') item({ type: 'toolResult', id: block.tool_use_id, isError: block.is_error === true, content: block.content });
      }
    } else if (value.type === 'stream_event') {
      this.notify('item/stream/delta', { threadId, turnId, event: value.event });
    } else if (value.type === 'result') this.receiveResult(thread, turn, value);
  }

  receiveResult(thread, turn, value) {
    const usage = value.usage ?? {};
    const last = { inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), cachedInputTokens: usage.cache_read_input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
    for (const name of Object.keys(last)) thread.totals[name] += last[name];
    this.notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: turn.id, tokenUsage: { last, total: { ...thread.totals } } });
    if (turn.interrupting) {
      // Stop wins over a queued message, which would otherwise start running now.
      clearTimeout(turn.interruptTimer);
      turn.outcome = { status: 'interrupted' };
      this.kill(thread, turn);
      return;
    }
    turn.outcome = value.is_error ? { status: 'failed', ...(Number.isSafeInteger(value.api_error_status) ? { code: value.api_error_status } : {}) } : { status: 'completed' };
    clearTimeout(turn.steerTimer);
    // A message that has not come back yet is still queued, so this turn goes on with it.
    // Without more input the process ends by itself once anything it did take has run.
    if (turn.replayed < turn.written) turn.steerTimer = setTimeout(() => { turn.closing = true; thread.child?.stdin.end(); }, this.steerGraceMs);
    else this.closeInput(thread, turn);
  }

  closeInput(thread, turn) {
    turn.closing = true;
    thread.child?.stdin.end();
    turn.exitTimer2 = setTimeout(() => this.kill(thread, turn), this.exitGraceMs);
  }

  signal(child, name) {
    // Claude Code leads its own process group, so commands it started stop with it.
    try { if (child.pid && process.platform !== 'win32') { process.kill(-child.pid, name); return; } } catch { /* Falls back to the process itself. */ }
    try { child.kill(name); } catch { /* Already gone. */ }
  }

  kill(thread, turn) {
    if (thread.turn !== turn || turn.killing) return;
    turn.killing = true;
    const child = thread.child;
    child.stdin.end();
    this.signal(child, 'SIGTERM');
    turn.killTimer = setTimeout(() => this.signal(child, 'SIGKILL'), this.killGraceMs);
  }

  finish(thread, turn) {
    if (turn.finished) return;
    turn.finished = true;
    for (const timer of ['steerTimer', 'interruptTimer', 'exitTimer', 'exitTimer2', 'killTimer']) clearTimeout(turn[timer]);
    const { status, code } = turn.outcome ?? { status: turn.interrupting ? 'interrupted' : 'failed' };
    thread.child = null; thread.turn = null; thread.lastTurn = { id: turn.id, status };
    this.save(thread);
    this.notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, status, ...(status === 'completed' ? {} : { error: code === undefined ? {} : { code } }) } });
    this.notify('thread/status/changed', { threadId: thread.id, status: { type: 'idle' } });
    if (this.closed && ![...this.threads.values()].some(other => other.child)) this.emit('exit', { code: 0, signal: null });
  }

  close() {
    this.closed = true;
    for (const thread of this.threads.values()) if (thread.child) this.kill(thread, thread.turn);
  }
}
