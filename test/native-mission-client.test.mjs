import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNativeMissionClient, canonicalMissionPacket } from '../src/native-mission-client.mjs';
import { digest } from '../src/control.mjs';

const token = 'synthetic-private-token-'.repeat(3);
const workspace = 'native-mission-test';
const archiveSha256 = 'a'.repeat(64);
const compatibility = { applicationVersion: '3.46.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 };
const flow = { id: 'mission-flow', name: 'FactoryMission', nodes: [], edges: [], updatedAt: 123 };
const input = { flowId: flow.id, flowSha256: digest(flow), conversationId: 'mission_conversation',
  packet: { missionId: 'm1', requirement: 'Return the independently checked result.', attempt: 1 } };
const admitPost = operation => ({ pending: operation() });
function conversation(overrides = {}) {
  const messages = [{ id: 'original-user', role: 'user', content: canonicalMissionPacket(input.packet) },
    { id: 'answer', role: 'assistant', content: 'private native result' }];
  return { id: input.conversationId, flowId: flow.id, status: 'completed', messages,
    transcriptWindow: { truncated: false, loadedCount: messages.length, totalCount: messages.length, source: 'durable-log' },
    parentConversationId: null, rootConversationId: null, ...overrides };
}
async function fixture(t, options = {}) {
  const state = { requests: [], posts: [], dangerousGets: 0, conversationId: input.conversationId, conversation: null, flow: structuredClone(flow),
    inventory: [structuredClone(flow)], postMode: 'complete', ...options };
  let postReceived;
  state.postReceived = new Promise(resolve => { postReceived = resolve; });
  const json = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.requests.push({ method: request.method, pathname: url.pathname, workspace: url.searchParams.get('workspace'),
      workspaceHeader: request.headers['x-flujo-workspace'], authorization: request.headers.authorization });
    if (request.headers.authorization !== 'Bearer ' + token || url.searchParams.get('workspace') !== workspace
      || request.headers['x-flujo-workspace'] !== workspace) return json(response, 401, { error: 'private authentication failure' });
    if (request.method === 'GET' && url.pathname === '/v1/chat/completions') { state.dangerousGets++; return json(response, 500, {}); }
    if (state.override && await state.override(request, response, url, json)) return;
    if (request.method === 'GET' && url.pathname === '/api/worker/status') return json(response, 200,
      { mode: 'worker', state: 'ready', workspace, archiveSha256 });
    if (request.method === 'GET' && url.pathname === '/api/snapshot/info') return json(response, 200, { workerCompatibility: compatibility });
    if (request.method === 'GET' && url.pathname === '/api/flow/' + flow.id) return json(response, 200, state.flow);
    if (request.method === 'GET' && url.pathname === '/api/flow') return json(response, 200, state.inventory);
    if (request.method === 'GET' && url.pathname === '/v1/chat/conversations/' + state.conversationId)
      return state.conversation === null ? json(response, 404, { error: 'Conversation not found' }) : json(response, 200, state.conversation);
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const parts = []; for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString('utf8')); state.posts.push(body);
      if (state.postMode !== 'absent') state.conversation = conversation({ id: body.metadata.conversationId });
      postReceived();
      if (state.postMode === 'lost') { response.destroy(); return; }
      if (state.postMode === 'held') return;
      return json(response, 200, { choices: [{ message: { content: 'untrusted POST response alone' } }] });
    }
    json(response, 404, { error: 'Unknown route' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  state.origin = 'http://127.0.0.1:' + server.address().port;
  state.client = (overrides = {}) => createNativeMissionClient({ origin: state.origin, token, workspace,
    archiveSha256, compatibility, timeoutMs: 2000, ...overrides });
  return state;
}
function safeError(code) { return error => error.code === code && !String(error.stack).includes(token) && !String(error).includes('secret'); }

test('packet canonicalization matches control digest and binding excludes private routing and tokens', () => {
  const packet = { z: [null, true, 1], a: { b: 'value', a: false } };
  assert.equal(canonicalMissionPacket(packet), '{"a":{"a":false,"b":"value"},"z":[null,true,1]}');
  assert.equal(digest(JSON.parse(canonicalMissionPacket(packet))), digest(packet));
  const client = createNativeMissionClient({ origin: 'http://127.0.0.1:4999', token, workspace, archiveSha256, compatibility });
  assert.deepEqual(client.binding, { workspace, archiveSha256, compatibility });
  assert.ok(Object.isFrozen(client.binding) && Object.isFrozen(client.binding.compatibility));
  assert.ok(!JSON.stringify(client.binding).includes(token) && !JSON.stringify(client.binding).includes('4999'));
  for (const value of [{ a: undefined }, { a: NaN }, { a: [, 1] }, { get a() { throw new Error('secret'); } }])
    assert.throws(() => canonicalMissionPacket(value), safeError('NATIVE_MISSION_INVALID'));
  const cycle = {}; cycle.self = cycle; assert.throws(() => canonicalMissionPacket(cycle), safeError('NATIVE_MISSION_INVALID'));
});

test('prepare attests exact worker and Flow, unique inventory and absent conversation using only workspace-bound GETs', async t => {
  const f = await fixture(t); const result = await f.client().prepare(input);
  assert.deepEqual(result, { workspace, archiveSha256, compatibility });
  assert.deepEqual(f.requests.map(row => row.pathname), ['/api/worker/status', '/api/snapshot/info', '/api/flow/mission-flow',
    '/api/flow', '/v1/chat/conversations/mission_conversation']);
  assert.ok(f.requests.every(row => row.method === 'GET' && row.workspace === workspace && row.workspaceHeader === workspace));
  assert.equal(f.posts.length, 0); assert.equal(f.dangerousGets, 0);
});

test('dispatch repeats asynchronous checks, invokes exactly one POST under admission and confirms full private GET body', async t => {
  const f = await fixture(t); const client = f.client(); await client.prepare(input);
  let admitted = 0;
  const result = await client.dispatch(input, { admitPost(operation) {
    admitted++; assert.equal(f.requests.length, 10); assert.equal(f.posts.length, 0); return { pending: operation() };
  } });
  assert.equal(admitted, 1); assert.equal(result.state, 'completed');
  assert.equal(JSON.parse(result.body).messages[1].content, 'private native result');
  assert.deepEqual(f.posts, [{ model: 'flow-FactoryMission', stream: false,
    messages: [{ role: 'user', content: canonicalMissionPacket(input.packet) }], metadata: { conversationId: input.conversationId, flujo: 'true' } }]);
  assert.equal(f.requests.at(-1).pathname, '/v1/chat/conversations/mission_conversation');
  assert.equal(f.dangerousGets, 0);
});

test('missing, rejecting, asynchronous or deferred admission cannot initiate POST', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client().dispatch(input), safeError('NATIVE_MISSION_ADMISSION')); assert.equal(f.requests.length, 0);
  await assert.rejects(f.client().dispatch(input, { admitPost() { throw new Error('secret admission detail ' + token); } }),
    safeError('NATIVE_MISSION_ADMISSION'));
  assert.equal(f.requests.length, 5);
  await assert.rejects(f.client().dispatch(input, { admitPost: async operation => operation() }), safeError('NATIVE_MISSION_ADMISSION'));
  let retained;
  await assert.rejects(f.client().dispatch(input, { admitPost(operation) { retained = operation; } }), safeError('NATIVE_MISSION_ADMISSION'));
  assert.throws(() => retained(), safeError('NATIVE_MISSION_ADMISSION')); assert.equal(f.posts.length, 0);
});

test('commit failure after POST invocation stays unknown, with an observed rejection and GET-only recovery', async t => {
  const f = await fixture(t, { postMode: 'lost' }); const client = f.client();
  await assert.rejects(client.dispatch(input, { admitPost(operation) {
    const pending = operation(); assert.equal(typeof pending.then, 'function'); throw new Error('secret COMMIT error ' + token);
  } }), safeError('NATIVE_MISSION_DISPATCH_UNKNOWN'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('FIXTURE_POST_DEADLINE')), 2000);
    f.postReceived.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
  assert.equal((await client.observe(input)).state, 'completed');
  await assert.rejects(client.dispatch(input, { admitPost }), safeError('NATIVE_MISSION_ALREADY_ATTEMPTED'));
  assert.equal(f.posts.length, 1); assert.equal(f.dangerousGets, 0);
});

test('lost POST response recovers the original conversation without a duplicate POST even with a new client', async t => {
  const f = await fixture(t, { postMode: 'lost' }); const client = f.client();
  await assert.rejects(client.dispatch(input, { admitPost }), safeError('NATIVE_MISSION_DISPATCH_UNKNOWN'));
  assert.equal((await f.client().observe(input)).state, 'completed');
  await assert.rejects(client.dispatch(input, { admitPost }), safeError('NATIVE_MISSION_ALREADY_ATTEMPTED'));
  await assert.rejects(f.client().dispatch(input, { admitPost }), safeError('NATIVE_MISSION_CONFLICT'));
  assert.equal(f.posts.length, 1); assert.equal(f.dangerousGets, 0);
});

test('Flow mutation, duplicate name or duplicate ID refuses dispatch before admission', async t => {
  const f = await fixture(t); const client = f.client(); await client.prepare(input);
  f.flow = { ...flow, updatedAt: 124 };
  let admissions = 0; const gate = () => { admissions++; };
  await assert.rejects(client.dispatch(input, { admitPost: gate }), safeError('NATIVE_MISSION_CONFLICT'));
  f.flow = structuredClone(flow); f.inventory = [flow, { ...flow, id: 'other-flow' }];
  await assert.rejects(client.dispatch(input, { admitPost: gate }), safeError('NATIVE_MISSION_CONFLICT'));
  f.inventory = [flow, { ...flow, name: 'OtherName' }];
  await assert.rejects(client.dispatch(input, { admitPost: gate }), safeError('NATIVE_MISSION_CONFLICT'));
  assert.equal(admissions, 0); assert.equal(f.posts.length, 0);
});

test('an existing conversation always blocks fresh preparation, including an apparently completed matching mission', async t => {
  const f = await fixture(t, { conversation: conversation() });
  await assert.rejects(f.client().prepare(input), safeError('NATIVE_MISSION_CONFLICT'));
  assert.equal(f.posts.length, 0);
});

test('storage-safe deterministic conversation IDs dispatch exactly while the 72-character form is refused before HTTP', async t => {
  const conversationId = 'factory-' + 'b'.repeat(56);
  assert.equal(conversationId.length, 64);
  const f = await fixture(t, { conversationId });
  const result = await f.client().dispatch({ ...input, conversationId }, { admitPost });
  assert.equal(result.state, 'completed'); assert.equal(JSON.parse(result.body).id, conversationId);
  assert.equal(f.posts[0].metadata.conversationId, conversationId); assert.equal(f.posts.length, 1);
  const before = f.requests.length, invalid = { ...input, conversationId: 'factory-' + 'b'.repeat(64) };
  await assert.rejects(f.client().prepare(invalid), safeError('NATIVE_MISSION_INVALID'));
  await assert.rejects(f.client().dispatch(invalid, { admitPost }), safeError('NATIVE_MISSION_INVALID'));
  assert.equal(f.requests.length, before); assert.equal(f.posts.length, 1);
});

test('observation distinguishes absent, matching nonterminal and exact terminal conversations', async t => {
  const f = await fixture(t); const client = f.client();
  assert.deepEqual(await client.observe(input), { state: 'absent', body: null });
  for (const status of ['running', 'waiting', 'error', 'cancelled', undefined]) {
    f.conversation = conversation({ status }); const result = await client.observe(input);
    assert.equal(result.state, 'pending'); assert.equal(JSON.parse(result.body).id, input.conversationId);
  }
  f.conversation = conversation(); assert.equal((await client.observe(input)).state, 'completed'); assert.equal(f.posts.length, 0);
});

test('wrong identity, packet, Persona ownership, continuations and truncated transcripts are conflicts', async t => {
  const f = await fixture(t); const client = f.client(); const original = conversation();
  const variants = [{ id: 'other' }, { flowId: 'other' }, { personaId: 'persona' }, { personaArchived: false },
    { parentConversationId: 'parent' }, { rootConversationId: 'other-root' },
    { messages: [{ ...original.messages[0], content: 'changed original packet' }, original.messages[1]] },
    { messages: [...original.messages, { id: 'continued', role: 'user', content: canonicalMissionPacket(input.packet) }] },
    { transcriptWindow: { ...original.transcriptWindow, truncated: true } }, { transcriptWindow: undefined }];
  for (const variant of variants) {
    f.conversation = conversation(variant); assert.equal((await client.observe(input)).state, 'conflict');
  }
  assert.equal(f.posts.length, 0); assert.equal(f.dangerousGets, 0);
});

test('a successful POST followed by absent GET stays pending and cannot repeat execution', async t => {
  const f = await fixture(t, { postMode: 'absent' }); const client = f.client();
  assert.deepEqual(await client.dispatch(input, { admitPost }), { state: 'pending', body: null });
  await assert.rejects(client.dispatch(input, { admitPost }), safeError('NATIVE_MISSION_ALREADY_ATTEMPTED'));
  assert.deepEqual(await client.observe(input), { state: 'absent', body: null }); assert.equal(f.posts.length, 1);
});

test('real redirect response is not followed and withholds credentials from its target', async t => {
  let redirected = 0;
  const target = http.createServer((_request, response) => { redirected++; response.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { target.close(resolve); target.closeAllConnections(); }));
  const f = await fixture(t, { override(_request, response, url) {
    if (url.pathname !== '/api/flow/mission-flow') return false;
    response.writeHead(307, { location: 'http://127.0.0.1:' + target.address().port + '/capture' }); response.end(); return true;
  } });
  await assert.rejects(f.client().prepare(input), safeError('NATIVE_MISSION_UNAVAILABLE'));
  assert.equal(redirected, 0); assert.equal(f.posts.length, 0);
});

test('oversized JSON, invalid UTF-8 and network errors disclose no private response or token', async t => {
  const f = await fixture(t); let mode = 'oversized';
  f.override = (_request, response, url, json) => {
    if (url.pathname !== '/api/flow/mission-flow') return false;
    if (mode === 'oversized') json(response, 200, { ...flow, privateBody: 'x'.repeat(1024 * 1024) });
    else if (mode === 'utf8') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])); }
    else json(response, 500, { secret: token });
    return true;
  };
  for (mode of ['oversized', 'utf8', 'server']) await assert.rejects(f.client().prepare(input), safeError('NATIVE_MISSION_UNAVAILABLE'));
  const client = f.client({ fetchImpl() { throw new Error('secret network URL ' + token); } });
  await assert.rejects(client.prepare(input), safeError('NATIVE_MISSION_UNAVAILABLE')); assert.equal(f.posts.length, 0);
});

test('bounded actual HTTP timeout aborts unavailable readiness without POST', { timeout: 3000 }, async t => {
  const f = await fixture(t, { override(_request, _response, url) { return url.pathname === '/api/worker/status'; } });
  const started = Date.now(); await assert.rejects(f.client({ timeoutMs: 100 }).prepare(input), safeError('NATIVE_MISSION_UNAVAILABLE'));
  assert.ok(Date.now() - started < 2000); assert.equal(f.posts.length, 0);
});

test('concurrent calls through one client cannot dispatch the same conversation twice', async t => {
  const f = await fixture(t); const client = f.client();
  const results = await Promise.allSettled([client.dispatch(input, { admitPost }), client.dispatch(input, { admitPost })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1); assert.equal(f.posts.length, 1);
});
