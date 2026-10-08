import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createFlujoWorkspaceAdapter } from '../src/adapters/flujo-workspace.mjs';
import { CASE_SPECIALISTS_V1 } from '../src/flujo-swarm/template/factory-team.mjs';

test('workspace adapter creates one owned workspace and runs an exact conversation', async () => {
  const actions = [];
  const adapter = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200', token: 'private',
    clientFactory(settings) {
      assert.deepEqual(settings, { origin: 'http://127.0.0.1:4200', token: 'private', workspace: 'swarm-worker-one' });
      return { workspace: settings.workspace,
        async workspaces() { return []; },
        async ensureWorkspace() { actions.push('create'); },
        async saveFlowSpec(spec) { actions.push('flow'); return { id: 'flow-one', name: spec.name }; },
        async runFlow(input) { actions.push('call'); return { conversationId: input.conversationId, status: 'completed', output: 'done' }; },
        async deleteWorkspace(name) { actions.push(`retire:${name}`); },
      };
    } });
  assert.equal((await adapter.provision({ app: 'worker-one', flowSpec: { name: 'Work' } })).state, 'ready');
  assert.deepEqual(await adapter.call('worker-one', { conversationId: 'conversation-one',
    request: { flowName: 'Work', prompt: 'Do the work' } }), { body: 'done', contentType: 'text/plain' });
  assert.equal((await adapter.retire('worker-one')).state, 'destroyed');
  assert.deepEqual(actions, ['create', 'flow', 'call', 'retire:swarm-worker-one']);
});

test('occupied workspace and uncertain conversation do not claim success', async () => {
  let created = 0;
  const adapter = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200', clientFactory: settings => ({
    workspace: settings.workspace,
    async workspaces() { return ['swarm-worker-one']; },
    async ensureWorkspace() { created++; },
    async runFlow(input) { return { conversationId: input.conversationId, status: 'unknown', output: '' }; },
  }) });
  await assert.rejects(adapter.provision({ app: 'worker-one', flowSpec: { name: 'Work' } }), /occupied/);
  assert.equal(created, 0);
  await assert.rejects(adapter.call('worker-one', { conversationId: 'conversation-one',
    request: { flowName: 'Work', prompt: 'Do the work' } }), /unconfirmed/);
});

test('workspace steering keeps the exact caller message identity', async () => {
  const messageId = '946bc0d7-2f70-4bd8-9ab7-a91bb14d86c7';
  const observed = [];
  const adapter = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200', clientFactory: () => ({
    async inject(conversationId, content, id) {
      observed.push({ conversationId, content, id });
      return { status: 'queued', conversation_id: conversationId, message_id: id };
    },
  }) });
  assert.deepEqual(await adapter.message('worker-one', { conversationId: 'conversation-one', messageId,
    content: 'Use the revised plan' }), { messageId, state: 'queued' });
  assert.deepEqual(observed, [{ conversationId: 'conversation-one', content: 'Use the revised plan', id: messageId }]);
});

test('workspace adapter installs a paired agent and team flow before readiness', async () => {
  const installed = [];
  const adapter = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200', clientFactory: settings => ({
    workspace: settings.workspace, async workspaces() { return []; }, async ensureWorkspace() {},
    async upsertModel(model) { installed.push(`model:${model.id}`); },
    async saveFlowSpec(spec) { installed.push(spec.name); return { id: spec.name, name: spec.name }; },
  }) });
  const result = await adapter.provision({ app: 'worker-two', modelConfig: { id: 'installed-model' },
    flowSpecs: [{ name: 'swarm_agent' }, { name: 'swarm_team' }] });
  assert.equal(result.state, 'ready');
  assert.deepEqual(installed, ['model:installed-model', 'swarm_agent', 'swarm_team']);
  await assert.rejects(adapter.provision({ app: 'worker-three', flowSpecs: [{ name: 'same' }, { name: 'same' }] }), TypeError);
});

test('workspace template uses observed tools and rejects an unavailable required server', async () => {
  const installed = [];
  const adapter = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200', clientFactory: settings => ({
    workspace: settings.workspace, async workspaces() { return []; }, async ensureWorkspace() {},
    async upsertModel() {},
    async servers() { return [{ name: 'filesystem', disabled: false }, { name: 'fleet', disabled: false }]; },
    async serverTools(name) { assert.equal(name, 'filesystem'); return { tools: [{ name: 'read_file' }] }; },
    async saveFlowSpec(spec) { installed.push(spec); return { id: spec.name, name: spec.name }; },
  }) });
  assert.equal((await adapter.provision({ app: 'worker-three', modelConfig: { id: 'installed-model' },
    teamTemplate: { model: 'installed-model', specialists: CASE_SPECIALISTS_V1 } })).state, 'ready');
  assert.deepEqual(installed.map(spec => spec.name), ['swarm_agent', 'swarm_team']);
  assert.deepEqual(installed[0].nodes.find(node => node.key === 'agent').servers,
    [{ name: 'filesystem', tools: ['read_file'] }]);
  assert.equal(installed[1].nodes.find(node => node.key === 'agents').concurrencyLimit, 9);
  const missing = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200', clientFactory: settings => ({
    workspace: settings.workspace, async workspaces() { return []; }, async ensureWorkspace() {},
    async servers() { return []; },
  }) });
  await assert.rejects(missing.provision({ app: 'worker-four',
    teamTemplate: { model: 'installed-model', specialists: CASE_SPECIALISTS_V1 } }), /requires connected/);
});

test('copied FLUJO client sends workspace and fixed conversation identity over HTTP', async t => {
  const observed = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const url = new URL(request.url, 'http://127.0.0.1');
    observed.push({ method: request.method, path: url.pathname, workspace: url.searchParams.get('workspace'),
      header: request.headers['x-flujo-workspace'], body });
    let payload = {};
    if (url.pathname === '/api/workspaces' && request.method === 'GET') payload = { workspaces: [] };
    else if (url.pathname === '/api/flow' && request.method === 'GET') payload = [];
    else if (url.pathname === '/api/flow/compile') {
      response.statusCode = 201; payload = { flow: { id: 'flow-one', name: body.spec.name } };
    } else if (url.pathname === '/v1/chat/completions') payload = { choices: [{ message: { content: 'completed answer' } }] };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adapter = createFlujoWorkspaceAdapter({ origin });
  assert.equal((await adapter.provision({ app: 'worker-http', flowSpec: { name: 'Work' } })).state, 'ready');
  assert.equal((await adapter.call('worker-http', { conversationId: 'conversation-http',
    request: { flowName: 'Work', prompt: 'Do work' }, timeoutMs: 5000 })).body, 'completed answer');
  assert.equal(observed.find(item => item.path === '/api/flow/compile').workspace, 'swarm-worker-http');
  const submission = observed.find(item => item.path === '/v1/chat/completions');
  assert.equal(submission.header, 'swarm-worker-http');
  assert.equal(submission.body.metadata.conversationId, 'conversation-http');
});
