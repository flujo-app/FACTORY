#!/usr/bin/env node
// A small stand-in for a FLUJO server: the HTTP routes the worker driver uses, with runs a test can script.
// It behaves as the real program did in the check against FLUJO 3.48.3: a run outlives the connection that
// asked for it, a cancel is a request that takes a moment, and terminal state comes from the conversation.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const ACTIVE = new Set(['running', 'awaiting_tool_approval', 'paused_debug']);

export class FakeFlujo {
  constructor({ tools = { bash: ['run'], filesystem: ['read_file'] }, script } = {}) {
    this.tools = tools;
    // Called for each new run with (run, api); by default a run answers and ends.
    this.script = script ?? (run => { run.say('answer'); run.done(); });
    this.workspaces = new Map();
    // Like FLUJO's event bus, a stream can attach before its conversation exists.
    this.conversationStreams = new Map();
    this.requests = [];
    this.streams = new Set();
    this.refuse = [];
    this.dropAfterAccept = 0;
    this.cancelFails = 0;
    this.server = http.createServer((request, response) => { void this.route(request, response).catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }); });
  }

  async listen(port = 0) { this.server.listen(port, '127.0.0.1'); await once(this.server, 'listening'); this.origin = `http://127.0.0.1:${this.server.address().port}`; return this; }
  async close() { for (const stream of this.streams) stream.destroy(); this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
  count(method, path) { return this.requests.filter(entry => entry.method === method && entry.path.startsWith(path)).length; }
  conversationOf(id) { for (const space of this.workspaces.values()) if (space.conversations.has(id)) return space.conversations.get(id); return null; }

  space(name) {
    if (!this.workspaces.has(name)) this.workspaces.set(name, { name, roots: [], models: [], flows: [], conversations: new Map(),
      servers: [...Object.keys(this.tools), 'flujo'].map(server => ({ name: server, disabled: false, transport: 'stdio' })) });
    return this.workspaces.get(name);
  }

  json(response, status, body) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }

  async route(request, response) {
    const url = new URL(request.url, 'http://fake');
    const path = url.pathname, method = request.method;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    this.requests.push({ method, path, body, workspace: url.searchParams.get('workspace') });
    const workspace = url.searchParams.get('workspace') ?? 'default-workspace';
    if (path === '/api/workspaces') {
      if (method === 'GET') return this.json(response, 200, { workspaces: [...this.workspaces.keys()].map(name => ({ name })) });
      if (method === 'POST') { this.space(body.name); return this.json(response, 201, { workspace: { name: body.name } }); }
      if (method === 'PATCH') { this.space(body.name).roots = body.roots; return this.json(response, 200, { workspace: { name: body.name, roots: body.roots } }); }
      if (method === 'DELETE') { this.workspaces.delete(body.name); return this.json(response, 200, { deleted: body.name }); }
    }
    const space = this.space(workspace);
    if (path === '/api/init') return this.json(response, 200, { success: true });
    if (path === '/api/update') return this.json(response, 200, { currentVersion: '9.9.9' });
    if (path === '/api/model') {
      if (method === 'GET') return this.json(response, 200, space.models);
      space.models.push(body); return this.json(response, 201, { ...body, ApiKey: '********' });
    }
    if (path.startsWith('/api/model/')) { space.models = space.models.map(model => model.id === body.id ? body : model); return this.json(response, 200, body); }
    if (path === '/api/mcp/servers') {
      if (method === 'GET') return this.json(response, 200, space.servers);
      space.servers.push(body); return this.json(response, 201, body);
    }
    const toolRoute = /^\/api\/mcp\/servers\/([^/]+)\/tools$/.exec(path);
    if (toolRoute) {
      const name = decodeURIComponent(toolRoute[1]);
      if (name === 'factory' && this.boardFails) return this.json(response, 200, { tools: [], error: 'not connected' });
      return this.json(response, 200, { tools: (name === 'factory' ? ['factory_status'] : this.tools[name] ?? []).map(tool => ({ name: tool })) });
    }
    if (path.startsWith('/api/mcp/servers/')) {
      const name = decodeURIComponent(path.split('/').at(-1));
      space.servers = space.servers.map(server => server.name === name ? { ...server, ...body } : server);
      return this.json(response, 200, body);
    }
    if (path === '/api/flow') return this.json(response, 200, space.flows);
    if (path === '/api/flow/compile') {
      const flow = { id: randomUUID(), name: body.spec.name, spec: body.spec };
      space.flows.push(flow); return this.json(response, 201, { flow });
    }
    if (path.startsWith('/api/flow/')) { space.flows = space.flows.filter(flow => flow.id !== path.split('/').at(-1)); return this.json(response, 200, { success: true }); }
    if (path === '/v1/chat/completions') return this.complete(space, body, response);
    if (path === '/v1/chat/conversations') {
      const parent = url.searchParams.get('descendantsOf');
      const items = [...space.conversations.values()].filter(conversation => conversation.parentConversationId === parent).map(({ id, status, parentConversationId }) => ({ id, status, parentConversationId }));
      return this.json(response, 200, { items, total: items.length, hasMore: false });
    }
    const route = /^\/v1\/chat\/conversations\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (route) return this.conversationRoute(space, route[1], route[2], { method, body, url, response });
    return this.json(response, 404, { error: `Unknown route ${method} ${path}` });
  }

  publish(conversation, event) {
    const record = { conversationId: conversation.id, seq: conversation.nextSeq++, timestamp: Date.now(), ...event };
    conversation.events.push(record);
    for (const stream of this.conversationStreams.get(conversation.id) ?? []) stream.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
    return record;
  }

  makeRun(conversation) {
    const emit = event => this.publish(conversation, event);
    const end = (status, { error, classification } = {}) => {
      if (run.ended) return;
      run.ended = true;
      conversation.status = status;
      conversation.recovery.classification = classification ?? (status === 'completed' ? 'completed' : status === 'capped' ? 'capped' : 'permanent_failure');
      if (error) conversation.lastError = error; else delete conversation.lastError;
      emit({ type: 'run:done', status: status === 'capped' ? 'capped' : status === 'completed' ? 'completed' : 'error' });
    };
    const run = { conversation, ended: false, emit,
      say: (text, extra = {}) => { const message = { id: randomUUID(), role: 'assistant', content: text }; conversation.messages.push(message); emit({ type: 'message', message, ...extra }); },
      tool: (name, args = '{}') => { const id = randomUUID(); emit({ type: 'message', message: { id: randomUUID(), role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] } }); emit({ type: 'tool:result', toolCallId: id, name, result: 'ok', isError: false }); },
      usage: () => emit({ type: 'usage', promptTokens: 40, completionTokens: 4, totalTokens: 44, cacheReadTokens: 10 }),
      done: () => end('completed'),
      capped: () => end('capped'),
      fail: (httpStatus = 500) => end('error', { error: { message: 'failed', httpStatus } }),
      // End without the final event, as a lost stream would see it.
      endSilently: status => { run.ended = true; conversation.status = status; conversation.recovery.classification = status === 'completed' ? 'completed' : 'permanent_failure'; },
      child: status => { const id = randomUUID(); const child = { id, status, parentConversationId: conversation.id, messages: [], events: [], nextSeq: 0, recovery: {} }; conversation.space.conversations.set(id, child); return child; },
    };
    conversation.run = run;
    return run;
  }

  async complete(space, body, response) {
    const refusal = this.refuse.shift();
    if (refusal) return this.json(response, refusal, { error: { message: 'busy' } });
    const id = body.metadata.conversationId;
    const conversation = space.conversations.get(id) ?? { id, space, messages: [], events: [], nextSeq: 0, parentConversationId: null };
    space.conversations.set(id, conversation);
    conversation.messages.push({ id: randomUUID(), role: 'user', content: body.messages.at(-1).content });
    conversation.flow = body.model;
    conversation.status = 'running';
    conversation.recovery = { runId: randomUUID(), classification: 'running' };
    conversation.steered = [];
    const run = this.makeRun(conversation);
    run.emit({ type: 'run:start', flowId: body.model });
    // A dropped connection: the run was accepted, but the caller never hears so.
    if (this.dropAfterAccept > 0) { this.dropAfterAccept--; response.destroy(); }
    else { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {}\n\n'); }
    setImmediate(() => { void this.script(run, this); });
  }

  conversationRoute(space, id, action, { method, body, url, response }) {
    const conversation = space.conversations.get(id);
    if (action === 'events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 3000\n\n: connected\n\n');
      const from = Number(url.searchParams.get('fromSeq') ?? 0);
      for (const record of conversation?.events ?? []) if (record.seq >= from) response.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
      if (!this.conversationStreams.has(id)) this.conversationStreams.set(id, new Set());
      const listeners = this.conversationStreams.get(id);
      listeners.add(response);
      response.on('close', () => listeners.delete(response));
      this.streams.add(response);
      response.on('close', () => this.streams.delete(response));
      return;
    }
    if (!conversation) {
      if (action === 'inject') return this.json(response, 409, { error: 'Conversation is not running', reason: 'not_running' });
      if (action === 'cancel') return this.json(response, 200, { success: true, message: 'Conversation not found, assumed cancelled.' });
      return this.json(response, 404, { error: 'Conversation not found' });
    }
    if (action === 'inject') {
      if (!ACTIVE.has(conversation.status)) return this.json(response, 409, { error: 'Conversation is not running', reason: 'not_running' });
      const message = { id: body.id, role: 'user', content: body.content };
      conversation.steered.push(message);
      conversation.run?.onSteer?.(message);
      return this.json(response, 200, { status: 'queued', conversation_id: id, message_id: body.id });
    }
    if (action === 'cancel') {
      if (this.cancelFails > 0) { this.cancelFails--; return this.json(response, 500, { error: 'cannot stop now' }); }
      conversation.recovery.classification = 'cancelled';
      this.cancels = (this.cancels ?? 0) + 1;
      const run = conversation.run;
      if (run && !run.ended && !this.holdCancel) setTimeout(() => { if (run.ended) return; run.ended = true; conversation.status = 'error'; conversation.lastError = { code: 'cancelled' }; run.emit({ type: 'run:done', status: 'error' }); }, 5);
      return this.json(response, 200, { success: true });
    }
    if (action === 'respond') { this.responses = [...(this.responses ?? []), body]; return this.json(response, 200, { status: 'running' }); }
    if (method === 'GET') {
      const { id: identity, status, recovery, lastError, parentConversationId, messages } = conversation;
      return this.json(response, 200, { id: identity, status, recovery, ...(lastError ? { lastError } : {}), parentConversationId, messages });
    }
    return this.json(response, 404, { error: 'Unknown action' });
  }
}

// Run as a program it stands in for the `flujo` command: `fake-flujo.mjs --no-open --port <n>`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  if (process.env.FAKE_FLUJO_EXIT_AT_START) process.exit(Number(process.env.FAKE_FLUJO_EXIT_AT_START));
  const fake = await new FakeFlujo().listen(port);
  process.stdout.write(`listening ${fake.origin}\n`);
  if (process.env.FAKE_FLUJO_CRASH_AFTER) setTimeout(() => process.exit(7), Number(process.env.FAKE_FLUJO_CRASH_AFTER));
  process.on('SIGTERM', () => process.exit(0));
}
