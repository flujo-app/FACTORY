import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { FlujoClient } from '../flujo-swarm/flujo-client.mjs';
import { buildFactoryTeamSpecs, FACTORY_FLOW_NAMES } from '../flujo-swarm/template/factory-team.mjs';

const invalid = message => Object.assign(new Error(message), { code: -32600 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A conversation still owns work in any of these states. Anything else is terminal. */
const ACTIVE_STATUSES = new Set(['running', 'queued', 'pending', 'awaiting', 'awaiting_tool_approval', 'paused_debug']);
/** FLUJO refuses a run for a moment under pressure; the caller waits instead of failing the turn. */
const RETRYABLE_SUBMISSION = new Set([408, 425, 429, 503]);
/** Each bundled server is one process per workspace, so a worker keeps only what it uses. */
export const FLUJO_WORKER_SERVERS = Object.freeze(['bash', 'filesystem']);
/** The default port stays clear of the board, which uses 4200 on the coordinator Machine. */
export const FLUJO_WORKER_PORT = 4210;

/** The FLUJO environment. A model key lives in FLUJO's encrypted settings, never here: agent commands inherit all of this. */
export function flujoEnvironment({ home, port = FLUJO_WORKER_PORT, path = process.env.PATH, extra = {} } = {}) {
  return { PATH: path, HOME: '/data', FLUJO_DATA_DIR: home, FLUJO_PORT: String(port), FLUJO_EXPOSURE_MODE: 'localhost', NEXT_TELEMETRY_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...extra };
}

/** One FLUJO process, restarted a few times if it dies. A worker that keeps crashing is reported, not hidden. */
export class FlujoProgram extends EventEmitter {
  constructor({ command = 'flujo', args = [], port = FLUJO_WORKER_PORT, environment = () => process.env, onOutput, startTimeoutMs = 300000, stopGraceMs = 10000, restartLimit = 3, restartWindowMs = 600000 } = {}) {
    super();
    Object.assign(this, { command, baseArgs: args, port, environment, onOutput, startTimeoutMs, stopGraceMs, restartLimit, restartWindowMs });
    this.origin = `http://127.0.0.1:${port}`;
    this.restarts = [];
  }

  spawnProcess() {
    // On Windows an npm command is a .cmd file, which only a shell can start.
    const windows = process.platform === 'win32';
    const word = value => windows && /\s/.test(value) ? `"${value}"` : value;
    const child = spawn(word(this.command), [...this.baseArgs, '--no-open', '--port', String(this.port)].map(word), { env: this.environment(), stdio: ['ignore', 'pipe', 'pipe'], detached: !windows, windowsHide: true, shell: windows });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => this.onOutput?.(chunk.toString()));
    return child;
  }

  async waitUntilReady(child) {
    let failure;
    const failed = new Promise((_, reject) => {
      child.once('error', error => { failure = error; reject(error); });
      child.once('exit', code => { failure = new Error(`FLUJO exited before it was ready (${code}).`); reject(failure); });
    });
    failed.catch(() => {});
    const deadline = Date.now() + this.startTimeoutMs;
    const client = new FlujoClient({ origin: this.origin });
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const listed = await client.api('GET', '/api/workspaces', undefined, { workspace: null, timeoutMs: 5000 }).catch(() => null);
      if (listed?.status === 200) return;
      await Promise.race([sleep(500), failed]);
    }
    throw new Error('FLUJO did not become ready before the start deadline.');
  }

  async start() {
    const child = this.spawnProcess();
    await this.waitUntilReady(child);
    this.watch(child);
  }

  watch(child) {
    child.removeAllListeners('exit');
    child.once('exit', async (code, signal) => {
      if (this.stopping || this.child !== child) { this.emit('exit', { code, signal }); return; }
      for (;;) {
        this.restarts = [...this.restarts.filter(at => Date.now() - at < this.restartWindowMs), Date.now()];
        this.emit('restarting', { code, signal, restarts: this.restarts.length });
        if (this.restarts.length > this.restartLimit) { this.emit('exit', { code, signal }); return; }
        try {
          const next = this.spawnProcess();
          await this.waitUntilReady(next);
          this.watch(next);
          this.emit('restarted', { restarts: this.restarts.length });
          return;
        } catch { /* Counted above; the next attempt or the limit decides. */ }
      }
    });
  }

  signal(name) {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(child.pid), '/T', ...(name === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true }); return; }
    // FLUJO leads its own process group, so the server and its tool processes stop with it.
    try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* Already gone. */ } }
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.signal('SIGKILL'), this.stopGraceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.signal('SIGTERM');
    });
  }
}

/** Send a run and return once FLUJO has taken it. The run does not depend on this connection. */
function submitDetached(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url), payload = Buffer.from(JSON.stringify(body));
    const request = (target.protocol === 'https:' ? https : http).request(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers } }, response => {
      if (response.statusCode === 200) { resolve({ status: 200, text: '' }); response.destroy(); return; }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8').slice(0, 2000) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(payload);
  });
}

/** Follow one conversation's durable event stream until it closes. Resolves; a dropped stream is not an error here. */
function followEvents(url, { headers, onEvent, onControl, signal }) {
  return new Promise(resolve => {
    const target = new URL(url);
    let buffer = '';
    const done = () => resolve();
    const request = (target.protocol === 'https:' ? https : http).request(target, { headers: { Accept: 'text/event-stream', ...headers }, signal }, response => {
      if (response.statusCode !== 200) { response.resume(); response.on('end', done); response.on('error', done); return; }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const lines = frame.split('\n');
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let value; try { value = JSON.parse(data); } catch { continue; }
          if (lines.some(line => line.startsWith('event:'))) onControl?.(value); else onEvent(value);
        }
      });
      response.on('end', done); response.on('error', done); response.on('close', done);
    });
    request.on('error', done);
    request.end();
  });
}

/**
 * One FLUJO conversation per agent, behind the method and notification contract the cloud runtime
 * already uses for a Codex app-server: thread/start|resume|read and turn/start|steer|interrupt, with
 * turn and item notifications. Each agent gets its own workspace, so its board identity, model record
 * and tools stay apart, and retiring it removes exactly those. A run belongs to FLUJO, not to this
 * connection: a dropped stream is followed again, and an uncertain submission is read back, never sent twice.
 */
export class FlujoSessionDriver extends EventEmitter {
  constructor({ origin, token, program, stateDirectory, privateDirectory = stateDirectory, modelRecord, team = {}, servers = FLUJO_WORKER_SERVERS, partialMessages = false, onStderr, clientFactory = settings => new FlujoClient(settings), version,
    pollMs = 5000, interruptResendMs = 10000, submitTimeoutMs = 300000, toolsTimeoutMs = 120000, reconnectMs = 1000, drainMs = 3000 } = {}) {
    super();
    if (!origin && !program) throw new TypeError('A FLUJO origin or program is required.');
    Object.assign(this, { program, token, stateDirectory, privateDirectory, modelRecord, team, servers, partialMessages, onStderr, clientFactory, knownVersion: version, pollMs, interruptResendMs, submitTimeoutMs, toolsTimeoutMs, reconnectMs, drainMs });
    this.origin = (program?.origin ?? origin).replace(/\/$/, '');
    this.threads = new Map();
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  }

  client(workspace) { return this.clientFactory({ origin: this.origin, token: this.token, workspace }); }
  headers() { return this.token ? { Authorization: `Bearer ${this.token}` } : {}; }
  notify(method, params) { this.emit('notification', { method, params }); }
  stateFile(id) { return join(this.stateDirectory, `${id}.flujo.json`); }

  async initialize() {
    if (!this.program) return;
    this.program.on('exit', result => this.emit('exit', result));
    this.program.on('restarting', result => this.onStderr?.(`FLUJO stopped unexpectedly (${result.code ?? result.signal}); restarting it.`));
    await this.program.start();
    // This instance is ours alone: nothing runs in its default workspace.
    const home = this.client(null);
    for (const server of await home.servers().catch(() => [])) {
      if (!server.disabled) await home.api('PUT', `/api/mcp/servers/${encodeURIComponent(server.name)}`, { ...server, disabled: true }).catch(() => {});
    }
  }

  async version() {
    if (this.knownVersion) return this.knownVersion;
    const read = await this.client(null).api('GET', '/api/update', undefined, { timeoutMs: 15000 }).catch(() => null);
    return this.knownVersion = read?.body?.currentVersion ?? 'unknown';
  }

  async request(method, params = {}) {
    if (method === 'thread/start') return this.startThread(params);
    if (method === 'thread/resume') return this.resumeThread(params);
    if (method === 'thread/read') return this.readThread(params);
    if (method === 'turn/start') return this.startTurn(params);
    if (method === 'turn/steer') return this.steerTurn(params);
    if (method === 'turn/interrupt') return this.interruptTurn(params);
    throw invalid(`Unsupported method ${method}.`);
  }

  /** The board server reads its credential from a private file, so no secret enters FLUJO's server settings. */
  boardConfig(thread, server) {
    const settings = { name: 'factory', transport: 'stdio', command: server.command, args: server.args ?? [], env: server.env ?? {}, cwd: thread.cwd, rootPath: thread.cwd, disabled: false, exposeAsMcpServer: false, enableMcpApps: false };
    if (!server.env?.FACTORY_BOARD_TOKEN) return settings;
    const file = join(this.privateDirectory, `${thread.id}.board.json`);
    writeFileSync(file, JSON.stringify({ url: server.env.FACTORY_BOARD_URL, token: server.env.FACTORY_BOARD_TOKEN }), { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(server.env).filter(([name]) => !['FACTORY_BOARD_URL', 'FACTORY_BOARD_TOKEN'].includes(name)));
    return { ...settings, args: [...settings.args, '--config', file], env };
  }

  async inventory(client, names) {
    const tools = {}, deadline = Date.now() + this.toolsTimeoutMs;
    for (const name of names) {
      for (;;) {
        const observed = await client.serverTools(name).catch(error => ({ tools: [], error: error.message }));
        if (!observed.error && observed.tools.length) { tools[name] = observed.tools.map(tool => tool.name); break; }
        // A worker never runs without its board or its tools: the same promise Codex gets from a required server.
        if (Date.now() >= deadline) throw new Error(`The ${name} server did not connect in FLUJO.`);
        await sleep(1000);
      }
    }
    return tools;
  }

  /** Idempotent, so a restarted Machine repairs its workspace before it resumes the conversation. */
  async install(thread, { server }) {
    const client = this.client(thread.workspace);
    await client.ensureWorkspace();
    await client.setWorkspaceRoots(thread.roots);
    const wanted = new Set([...this.servers, ...(server ? ['factory'] : [])]);
    for (const existing of await client.servers()) {
      if (Boolean(existing.disabled) === wanted.has(existing.name)) {
        await client.expect('PUT', `/api/mcp/servers/${encodeURIComponent(existing.name)}`, { ...existing, disabled: !wanted.has(existing.name) });
      }
    }
    const model = this.modelRecord(thread.model);
    await client.upsertModel(model);
    if (server) await client.upsertServer(this.boardConfig(thread, server));
    const availableServers = [...wanted];
    const availableTools = await this.inventory(client, availableServers);
    const concurrency = this.team.concurrency;
    const specs = buildFactoryTeamSpecs({ model: model.id, availableServers, availableTools, specialists: this.team.specialists,
      // FLUJO's shell and file tools start in its own data folder unless told otherwise.
      instructions: `Your working folder is ${thread.cwd}. Pass it as cwd on every shell command and use absolute paths under it for file tools.${thread.instructions ? `\n${thread.instructions}` : ''}`,
      limits: { ...(this.team.agentTurns ? { agentTurns: this.team.agentTurns } : {}), ...(this.team.leadTurns ? { leadTurns: this.team.leadTurns } : {}), ...(concurrency ? { concurrency } : {}) },
      environment: { workingFolder: thread.cwd } }).filter(spec => concurrency || spec.name === FACTORY_FLOW_NAMES.agent);
    const digest = createHash('sha256').update(JSON.stringify(specs)).digest('hex');
    // Saving a flow gives it a new identity, so an unchanged flow is left alone for the conversation that uses it.
    const installed = new Set((await client.flows()).map(flow => flow.name));
    if (thread.flowDigest !== digest || specs.some(spec => !installed.has(spec.name))) {
      for (const spec of specs) {
        const flow = await client.saveFlowSpec(spec);
        if (flow?.name !== spec.name) throw new Error('FLUJO did not confirm the installed flow.');
      }
      thread.flowDigest = digest;
    }
  }

  save(thread) {
    const file = this.stateFile(thread.id), next = `${file}.next`;
    writeFileSync(next, JSON.stringify({ threadId: thread.id, workspace: thread.workspace, lastTurn: thread.lastTurn, nextSeq: thread.nextSeq, flowDigest: thread.flowDigest }), { mode: 0o600 });
    renameSync(next, file);
  }

  addThread(id, { cwd, config, sandbox, model, developerInstructions, agentRole }, saved = {}) {
    if ((sandbox ?? 'danger-full-access') !== 'danger-full-access') throw invalid('FLUJO workers run with full access on their Machine.');
    const thread = { id, workspace: saved.workspace ?? `factory-${id}`, cwd, model, instructions: developerInstructions, roots: [cwd, ...(config?.['sandbox_workspace_write.writable_roots'] ?? []), ...(this.team.roots ?? [])],
      flow: agentRole === 'orchestrator' && this.team.concurrency ? FACTORY_FLOW_NAMES.team : FACTORY_FLOW_NAMES.agent,
      lastTurn: saved.lastTurn ?? null, nextSeq: saved.nextSeq ?? 0, flowDigest: saved.flowDigest, turn: null, totals: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
    this.threads.set(id, thread);
    return thread;
  }

  thread(id) {
    const thread = this.threads.get(id);
    if (!thread) throw invalid(`Unknown thread ${id}.`);
    return thread;
  }

  async startThread(params) {
    const thread = this.addThread(randomUUID(), params);
    await this.install(thread, { server: params.config?.mcp_servers?.factory });
    this.save(thread);
    this.notify('thread/started', { threadId: thread.id, thread: { id: thread.id } });
    return { thread: { id: thread.id, status: { type: 'idle' } } };
  }

  async resumeThread(params) {
    const id = params.threadId;
    const unavailable = () => invalid(`no rollout found for thread id ${id}`);
    if (!existsSync(this.stateFile(id))) throw unavailable();
    const saved = JSON.parse(readFileSync(this.stateFile(id), 'utf8'));
    const thread = this.addThread(id, params, saved);
    await this.install(thread, { server: params.config?.mcp_servers?.factory });
    // A conversation without a turn has no history to lose; one with a turn must still have its history.
    let status = 'idle', recoveredTurn;
    if (thread.lastTurn) {
      const read = await this.client(thread.workspace).conversation(id, { messageLimit: 1 });
      if (read.status === 404) throw unavailable();
      if (read.status !== 200) throw new Error(`FLUJO could not read the retained conversation (HTTP ${read.status}).`);
      if (thread.lastTurn.status === 'inProgress') {
        if (ACTIVE_STATUSES.has(read.body.status)) {
          // Still running in FLUJO: observe it, never replay it.
          status = 'active';
          this.adoptTurn(thread, thread.lastTurn.id);
        } else recoveredTurn = thread.lastTurn = { ...thread.lastTurn, status: this.outcome(read.body).status === 'completed' ? 'completed' : 'interrupted' };
      }
    }
    this.save(thread);
    this.notify('thread/resumed', { threadId: id, thread: { id } });
    return { thread: { id, status: { type: status } }, ...(recoveredTurn ? { recoveredTurn } : {}) };
  }

  /** A real readback: the thread is idle only when FLUJO agrees that the conversation and its children have ended. */
  async readThread({ threadId, includeTurns }) {
    const thread = this.thread(threadId);
    let active = Boolean(thread.turn);
    if (!active && thread.lastTurn) {
      const read = await this.client(thread.workspace).conversation(threadId, { messageLimit: 1 });
      // A turn FLUJO never took has no conversation, so nothing can be running.
      if (read.status !== 200 && read.status !== 404) throw new Error(`FLUJO could not read the conversation (HTTP ${read.status}).`);
      active = read.status === 200 && (ACTIVE_STATUSES.has(read.body.status) || await this.childrenActive(thread));
    }
    return { thread: { id: thread.id, status: { type: active ? 'active' : 'idle' }, ...(includeTurns ? { turns: thread.lastTurn ? [thread.lastTurn] : [] } : {}) } };
  }

  /** Children keep working after a parent's run ends, and a stop must wait for them too. */
  async childrenActive(thread) {
    const client = this.client(thread.workspace);
    for (let cursor, page = 0; page < 100; page++) {
      const read = await client.descendants(thread.id, cursor);
      if (read.status !== 200 || !Array.isArray(read.body?.items)) throw new Error(`FLUJO could not list the conversation's children (HTTP ${read.status}).`);
      if (read.body.items.some(item => ACTIVE_STATUSES.has(item.status))) return true;
      if (!read.body.hasMore) return false;
      cursor = read.body.nextCursor;
      if (!cursor) return true;
    }
    return true;
  }

  outcome(conversation) {
    const classification = conversation.recovery?.classification;
    if (classification === 'cancelled' || conversation.lastError?.code === 'cancelled') return { status: 'interrupted' };
    if (conversation.status === 'completed' || conversation.status === 'capped') return { status: 'completed' };
    const code = conversation.lastError?.httpStatus;
    return { status: 'failed', ...(Number.isSafeInteger(code) ? { code } : {}) };
  }

  startTurn({ threadId, input }) {
    const thread = this.thread(threadId);
    if (thread.turn) throw invalid('This thread already has a running turn.');
    const id = randomUUID();
    const turn = this.beginTurn(thread, id);
    thread.lastTurn = { id, status: 'inProgress' };
    this.save(thread);
    this.notify('thread/status/changed', { threadId, status: { type: 'active' } });
    this.notify('turn/started', { threadId, turn: { id, status: 'inProgress' } });
    turn.submission = this.submit(thread, turn, textOf(input)).catch(error => { this.onStderr?.(`FLUJO did not take the turn: ${error.message}`); this.finish(thread, turn, { status: 'failed' }); });
    this.watch(thread, turn);
    return { turn: { id, status: 'inProgress' } };
  }

  beginTurn(thread, id) {
    const turn = { id, steers: new Map(), runSeen: false, finished: false, abort: new AbortController() };
    thread.turn = turn;
    return turn;
  }

  /** A run found still going after a restart. Its turn keeps its identity. */
  adoptTurn(thread, id) {
    const turn = this.beginTurn(thread, id);
    turn.runSeen = true;
    this.watch(thread, turn);
  }

  async submit(thread, turn, text) {
    const url = `${this.origin}/v1/chat/completions?workspace=${encodeURIComponent(thread.workspace)}`;
    const body = { model: `flow-${thread.flow}`, stream: true, metadata: { flujo: 'true', requireApproval: 'false', conversationId: thread.id }, messages: [{ role: 'user', content: text }] };
    const deadline = Date.now() + this.submitTimeoutMs;
    // The run this turn is waiting for is whichever one is not already recorded.
    const before = await this.client(thread.workspace).conversation(thread.id, { messageLimit: 1 });
    if (before.status !== 200 && before.status !== 404) throw new Error(`FLUJO could not read the conversation (HTTP ${before.status}).`);
    turn.baselineRun = before.body?.recovery?.runId ?? null;
    turn.runSeen = false;
    for (let attempt = 0; ; attempt++) {
      let response;
      try { response = await submitDetached(url, { headers: { ...this.headers(), 'x-flujo-workspace': thread.workspace }, body }); }
      catch (error) {
        // The request may have arrived. Read it back rather than send the task a second time.
        this.onStderr?.(`FLUJO submission outcome is being read back: ${error.message}`);
        break;
      }
      if (response.status === 200) break;
      if (turn.interrupting) { this.finish(thread, turn, { status: 'interrupted' }); return; }
      if (!RETRYABLE_SUBMISSION.has(response.status) || Date.now() >= deadline || turn.finished) throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 300)}`);
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
    turn.submittedAt = Date.now();
  }

  /** Follows the event stream and also reads the state on a timer, so a lost stream cannot leave a turn open. */
  watch(thread, turn) {
    const settle = () => { void this.settle(thread, turn).catch(error => this.onStderr?.(`FLUJO state read is pending: ${error.message}`)); };
    turn.settle = settle;
    turn.pollTimer = setInterval(settle, this.pollMs);
    void (async () => {
      while (!turn.finished && !this.closed) {
        await followEvents(`${this.origin}/v1/chat/conversations/${encodeURIComponent(thread.id)}/events?workspace=${encodeURIComponent(thread.workspace)}&fromSeq=${thread.nextSeq}`, {
          headers: { ...this.headers(), 'x-flujo-workspace': thread.workspace }, signal: turn.abort.signal,
          onEvent: event => this.receive(thread, turn, event),
          // FLUJO skipped ahead, for example past an event too large to send.
          onControl: control => { if (Number.isSafeInteger(control?.nextSeq)) thread.nextSeq = Math.max(thread.nextSeq, control.nextSeq); },
        });
        if (turn.finished || this.closed) return;
        settle();
        await sleep(this.reconnectMs);
      }
    })();
  }

  receive(thread, turn, event) {
    if (Number.isSafeInteger(event.seq)) {
      if (event.seq < thread.nextSeq) return;
      thread.nextSeq = event.seq + 1;
    }
    const threadId = thread.id, turnId = turn.id;
    const nesting = { ...(event.depth ? { depth: event.depth } : {}), ...(Number.isSafeInteger(event.laneIndex) ? { lane: event.laneIndex } : {}) };
    const item = body => this.notify('item/completed', { threadId, turnId, item: { ...body, ...nesting } });
    switch (event.type) {
      case 'run:start': if (!event.depth) turn.runSeen = true; break;
      case 'run:done': if (!event.depth) { turn.doneSeen = true; turn.settle?.(); } break;
      case 'message': {
        const { role, id, content, tool_calls: calls } = event.message ?? {};
        if (role === 'user') { turn.steers.delete(id); break; }
        if (role !== 'assistant') break;
        if (typeof content === 'string' && content) item({ type: 'agentMessage', text: content });
        for (const call of calls ?? []) item({ type: 'toolCall', id: call.id, tool: call.function?.name, arguments: call.function?.arguments });
        break;
      }
      case 'tool:result': item({ type: 'toolResult', id: event.toolCallId, tool: event.name, isError: event.isError === true, content: event.result }); break;
      case 'usage': {
        const last = { inputTokens: event.promptTokens ?? 0, cachedInputTokens: event.cacheReadTokens ?? 0, outputTokens: event.completionTokens ?? 0 };
        for (const name of Object.keys(last)) thread.totals[name] += last[name];
        this.notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last, total: { ...thread.totals } } });
        break;
      }
      case 'model:delta': if (this.partialMessages) this.notify('item/stream/delta', { threadId, turnId, delta: event.delta, ...nesting }); break;
      case 'recovery:retry': this.notify('model/retry', { threadId, turnId, attempt: event.attempt, retryAt: event.retryAt, error: event.failure?.category }); break;
      case 'subflow:start': case 'subflow:done': item({ type: 'subflow', phase: event.type.slice(8), subflow: event.subflowId, conversationId: event.laneConversationId, status: event.status }); break;
      case 'error': this.notify('flujo/error', { threadId, turnId, message: event.message, code: event.error?.code, ...nesting }); break;
      // Nobody answers on an unattended worker, so a question or form never parks the run.
      case 'run:awaiting_question': void this.respond(thread, { action: 'question-decline', questionId: event.questionId }); break;
      case 'run:awaiting_elicitation': void this.respond(thread, { action: 'elicitation-cancel', elicitationId: event.elicitationId }); break;
      default: break;
    }
    // Streaming tokens are most events and change nothing a restart needs; it just reads them again.
    if (event.type !== 'model:delta' && event.type !== 'tool:progress') this.save(thread);
  }

  async respond(thread, body) {
    await this.client(thread.workspace).api('POST', `/v1/chat/conversations/${encodeURIComponent(thread.id)}/respond`, body).catch(error => this.onStderr?.(`FLUJO did not take the answer: ${error.message}`));
  }

  /** Ends the turn only after FLUJO itself says this run has ended, along with any children. */
  async settle(thread, turn) {
    if (turn.finished || turn.settling) return;
    turn.settling = true;
    try {
      await turn.submission;
      if (turn.finished) return;
      const read = await this.client(thread.workspace).conversation(thread.id, { messageLimit: turn.steers.size ? 200 : 1 });
      const conversation = read.status === 200 ? read.body : null;
      if (read.status !== 200 && read.status !== 404) return;
      const runId = conversation?.recovery?.runId;
      if (runId && runId !== turn.baselineRun) turn.runSeen = true;
      if (!turn.runSeen) {
        // The previous run's end is not this turn's end. A run that never starts is not sent again; the turn ends unfinished.
        if (Date.now() - (turn.submittedAt ?? Date.now()) >= this.submitTimeoutMs) this.finish(thread, turn, { status: 'failed' });
        return;
      }
      if (!conversation || ACTIVE_STATUSES.has(conversation.status)) return;
      if (await this.childrenActive(thread)) return;
      if (turn.finished) return;
      // The state can be ahead of the stream. Wait for the run's last event so the trace is complete; a lost stream only delays this.
      if (!turn.doneSeen) {
        turn.terminalSince ??= Date.now();
        if (Date.now() - turn.terminalSince < this.drainMs) { setTimeout(() => turn.settle?.(), Math.min(this.drainMs, 200)); return; }
      }
      if (turn.steers.size && !turn.interrupting) {
        const seen = new Set((conversation.messages ?? []).map(message => message.id));
        for (const id of [...turn.steers.keys()]) if (seen.has(id)) turn.steers.delete(id);
        if (turn.steers.size) {
          // A message that arrived as the run ended is still owed: this turn goes on with it.
          const text = [...turn.steers.values()].join('\n\n');
          turn.steers.clear(); turn.doneSeen = false; turn.terminalSince = undefined;
          turn.submission = this.submit(thread, turn, text).catch(error => { this.onStderr?.(`FLUJO did not take the queued message: ${error.message}`); this.finish(thread, turn, { status: 'failed' }); });
          return;
        }
      }
      this.finish(thread, turn, this.outcome(conversation));
    } finally { turn.settling = false; }
  }

  async steerTurn({ threadId, expectedTurnId, input }) {
    const thread = this.thread(threadId), turn = thread.turn;
    if (!turn || turn.interrupting) throw new Error('no active turn to steer');
    if (expectedTurnId && expectedTurnId !== turn.id) throw invalid('The expected turn is not the running turn.');
    await turn.submission;
    const id = randomUUID(), text = textOf(input);
    const response = await this.client(thread.workspace).api('POST', `/v1/chat/conversations/${encodeURIComponent(threadId)}/inject`, { content: text, id });
    if (response.status === 409) throw new Error('no active turn to steer');
    if (response.status !== 200 || response.body?.message_id !== id) throw new Error(`FLUJO did not confirm the queued message (HTTP ${response.status}).`);
    if (thread.turn === turn) turn.steers.set(id, text);
    return { turnId: turn.id };
  }

  async sendCancel(thread) {
    const response = await this.client(thread.workspace).cancel(thread.id, 15000);
    if (![200, 202].includes(response.status)) throw new Error(`FLUJO did not accept the stop (HTTP ${response.status}).`);
  }

  async interruptTurn({ threadId, turnId }) {
    const thread = this.thread(threadId), turn = thread.turn;
    if (!turn || turn.id !== turnId) {
      if (thread.lastTurn?.id === turnId) return {};
      throw invalid('The expected turn is not the running turn.');
    }
    if (turn.interrupting) return {};
    turn.interrupting = true;
    await turn.submission;
    if (turn.finished) return {};
    try { await this.sendCancel(thread); }
    catch (error) { turn.interrupting = false; throw error; }
    // A cancel is a request; keep asking until FLUJO has actually stopped, children included.
    turn.interruptTimer = setInterval(() => { void this.sendCancel(thread).catch(error => this.onStderr?.(`FLUJO stop is pending: ${error.message}`)); }, this.interruptResendMs);
    turn.settle?.();
    return {};
  }

  finish(thread, turn, { status, code }) {
    if (turn.finished) return;
    turn.finished = true;
    clearInterval(turn.pollTimer); clearInterval(turn.interruptTimer);
    turn.abort.abort();
    thread.turn = null; thread.lastTurn = { id: turn.id, status };
    this.save(thread);
    this.notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, status, ...(status === 'completed' ? {} : { error: code === undefined ? {} : { code } }) } });
    this.notify('thread/status/changed', { threadId: thread.id, status: { type: 'idle' } });
  }

  close() {
    this.closed = true;
    for (const thread of this.threads.values()) {
      if (!thread.turn) continue;
      clearInterval(thread.turn.pollTimer); clearInterval(thread.turn.interruptTimer);
      thread.turn.abort.abort();
    }
    if (this.program) void this.program.stop();
    else this.emit('exit', { code: 0, signal: null });
  }
}

const textOf = input => (input ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n\n');
