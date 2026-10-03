import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createPairConfigurations, PeerStore, wireBytes, parseWire, requestHeaders, acknowledgementHeaders, validateEndpoint } from '../src/peer-messaging.mjs';
import { startPeerServer, dispatchPeerMessage } from '../src/peer-gateway.mjs';
import { FactoryControl } from '../src/control.mjs';

const NOW = 1800000000000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function closeServer(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function vacantPort() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await closeServer(server); return port; }
async function fixture(t, network = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-peer-test-'));
  const port = await vacantPort(); const time = { now: NOW };
  const configurations = createPairConfigurations({
    a: { identity: { factoryId: 'alpha', cellId: 'dev' }, endpoint: 'http://127.0.0.1:1/v1/peer/messages' },
    b: { identity: { factoryId: 'beta', cellId: 'watch' }, endpoint: `http://127.0.0.1:${port}/v1/peer/messages` }, credentialExpiresAt: NOW + 3600000,
  });
  const paths = { a: path.join(directory, 'a.sqlite'), b: path.join(directory, 'b.sqlite') };
  const a = new PeerStore(paths.a, { config: configurations.a, clock: () => time.now });
  const b = new PeerStore(paths.b, { config: configurations.b, clock: () => time.now });
  const server = network ? await startPeerServer({ store: b, port }) : null;
  t.after(async () => {
    if (server?.listening) await closeServer(server);
    a.close(); b.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'factory-peer-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, configurations, paths, a, b, server, port, time };
}
function message(overrides = {}) { return { messageId: 'observation-1', type: 'health_observation', payload: { state: 'suspected' }, createdAt: NOW, expiresAt: NOW + 60000, ...overrides }; }
async function post(port, body, headers, route = '/v1/peer/messages') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { ...headers, 'content-length': body.length }, agent: false }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks), headers: response.headers }));
    }); request.on('error', reject); request.end(body);
  });
}

test('durable intent binds pair, exact bytes and fixed endpoint across restart', async t => {
  const f = await fixture(t); const row = f.a.enqueue(message());
  assert.equal(f.a.enqueue(message()).digest, row.digest);
  assert.throws(() => f.a.enqueue(message({ payload: { state: 'healthy' } })), error => error.code === 'CONFLICT');
  assert.equal(f.a.counts().peer_outbox, 1); assert.equal(f.a.events().length, 1);
  const reopened = new PeerStore(f.paths.a, { config: f.configurations.a, clock: () => NOW });
  assert.deepEqual(reopened.outbox(row.messageId).body, row.body); reopened.close();
  assert.throws(() => new PeerStore(f.paths.a, { config: { ...f.configurations.a, endpoint: 'http://127.0.0.1:2/v1/peer/messages' } }), error => error.code === 'CONFIG_CONFLICT');
  assert.throws(() => new PeerStore(f.paths.a, { config: { ...f.configurations.a, key: randomBytes(32).toString('base64url') } }), error => error.code === 'CREDENTIAL_GENERATION');
});

test('genuine HTTP acceptance persists one usable observation and exact authenticated ack', async t => {
  const f = await fixture(t, true), row = f.a.enqueue(message());
  assert.equal((await dispatchPeerMessage({ store: f.a, messageId: row.messageId })).state, 'acknowledged');
  assert.equal(f.a.outbox(row.messageId).digest, row.digest);
  assert.deepEqual(f.b.readInbox(row.messageId), row.envelope);
  const replay = await post(f.port, row.body, requestHeaders(f.configurations.a, row.body, NOW));
  assert.equal(replay.status, 200); assert.equal(f.b.inbox().length, 1);
  assert.equal(f.b.events().filter(event => event.type === 'inbox_recorded').length, 1);
  assert.equal(f.a.events().filter(event => event.type === 'outbox_acknowledged').length, 1);
  assert.equal((await dispatchPeerMessage({ store: f.a, messageId: row.messageId })).dispatched, false);
});

test('network rejects spoofed MAC, wrong identity pair, changed same-ID payload and wrong route', async t => {
  const f = await fixture(t, true), row = f.a.enqueue(message());
  const good = requestHeaders(f.configurations.a, row.body, NOW);
  assert.equal((await post(f.port, row.body, { ...good, 'x-factory-peer-mac': '0'.repeat(64) })).status, 401);
  const foreign = { ...f.configurations.a, local: { factoryId: 'foreign', cellId: 'dev' } };
  const foreignBody = wireBytes({ ...row.envelope, sender: foreign.local });
  assert.equal((await post(f.port, foreignBody, requestHeaders(foreign, foreignBody, NOW))).status, 401);
  const wrong = { ...f.configurations.a, peer: { factoryId: 'wrong', cellId: 'watch' } };
  const wrongBody = wireBytes({ ...row.envelope, recipient: wrong.peer });
  assert.equal((await post(f.port, wrongBody, requestHeaders(wrong, wrongBody, NOW))).status, 401);
  assert.equal((await post(f.port, row.body, good, '/v1/peer/messages?recipient=wrong')).status, 404);
  assert.equal((await post(f.port, row.body, good)).status, 200);
  const changed = wireBytes({ ...row.envelope, payload: { state: 'healthy' } });
  assert.equal((await post(f.port, changed, requestHeaders(f.configurations.a, changed, NOW))).status, 409);
  assert.equal(f.b.inbox().length, 1);
});

test('canonical wire rejects duplicate fields, invalid UTF8, unknown fields and bounds', async t => {
  const f = await fixture(t, true), row = f.a.enqueue(message());
  assert.throws(() => parseWire(Buffer.from('{"a":1,"a":2}')), error => error.code === 'NONCANONICAL_WIRE');
  assert.throws(() => parseWire(Buffer.from([0x7b, 0xff, 0x7d])), error => error.code === 'INVALID_WIRE');
  assert.throws(() => requestHeaders(f.configurations.a, wireBytes({ ...row.envelope, command: 'pause' }), NOW), error => error.code === 'INVALID');
  assert.throws(() => f.a.enqueue(message({ payload: 'x'.repeat(65536) })), error => error.code === 'BODY_LIMIT');
  const noncanonical = Buffer.from(' ' + row.body.toString('utf8'));
  assert.ok(!noncanonical.equals(row.body));
  assert.equal((await post(f.port, noncanonical, requestHeaders(f.configurations.a, row.body, NOW))).status, 401);
  assert.equal(f.b.counts().peer_inbox, 0);
});

test('expired committed replay is observable under active auth; fresh expiry and revoked credentials reject', async t => {
  const f = await fixture(t, true), row = f.a.enqueue(message({ expiresAt: NOW + 1000 }));
  assert.equal((await post(f.port, row.body, requestHeaders(f.configurations.a, row.body, NOW))).status, 200);
  f.time.now += 2000;
  assert.equal((await post(f.port, row.body, requestHeaders(f.configurations.a, row.body, f.time.now))).status, 200);
  const unseen = wireBytes({ ...row.envelope, messageId: 'never-committed' });
  assert.equal((await post(f.port, unseen, requestHeaders(f.configurations.a, unseen, f.time.now))).status, 400);
  const key = randomBytes(32).toString('base64url');
  const rotated = { ...f.configurations.b, generation: 2, key };
  const current = new PeerStore(f.paths.b, { config: rotated, rotateFromGeneration: 1, clock: () => f.time.now });
  assert.throws(() => f.b.assertCurrentCredential(), error => error.code === 'CREDENTIAL_GENERATION');
  assert.equal((await post(f.port, row.body, requestHeaders(f.configurations.a, row.body, f.time.now))).status, 401);
  assert.throws(() => new PeerStore(f.paths.b, { config: f.configurations.b }), error => error.code === 'CREDENTIAL_GENERATION');
  await closeServer(f.server);
  const restarted = await startPeerServer({ store: current, port: f.port });
  const currentSender = { ...f.configurations.a, generation: 2, key };
  assert.equal((await post(f.port, row.body, requestHeaders(currentSender, row.body, f.time.now))).status, 200);
  assert.equal((await post(f.port, row.body, requestHeaders(f.configurations.a, row.body, f.time.now))).status, 401);
  await closeServer(restarted);
  current.close();
  f.time.now = NOW + 3600001;
  assert.throws(() => f.a.assertCurrentCredential(), error => error.code === 'CREDENTIAL_EXPIRED');
  assert.equal(f.b.counts().peer_inbox, 1);
});

test('only exact closed MAC-bound acknowledgement resolves pending intent', async t => {
  const f = await fixture(t), row = f.a.enqueue(message());
  const ack = f.b.receiveEnvelope(row.envelope), validBody = wireBytes(ack);
  for (const value of [{ ...ack, messageId: 'another' }, { ...ack, recipient: { factoryId: 'wrong', cellId: 'watch' } }, { ...ack, sender: { ...ack.sender, command: 'pause' } }, { ...ack, lease: 'authority' }, { ...ack, sequence: 0 }]) {
    const body = wireBytes(value);
    assert.throws(() => f.a.acknowledge(row.messageId, body, acknowledgementHeaders(f.configurations.b, row.digest, body, NOW)));
    assert.equal(f.a.outbox(row.messageId).state, 'pending');
  }
  const tampered = { ...acknowledgementHeaders(f.configurations.b, row.digest, validBody, NOW), 'x-factory-peer-mac': '0'.repeat(64) };
  assert.throws(() => f.a.acknowledge(row.messageId, validBody, tampered), error => error.code === 'AUTHENTICATION');
  f.a.acknowledge(row.messageId, validBody, acknowledgementHeaders(f.configurations.b, row.digest, validBody, NOW));
  assert.equal(f.a.outbox(row.messageId).state, 'acknowledged');
  f.a.db.prepare('UPDATE peer_outbox SET acknowledgement=? WHERE message_id=?').run('{}', row.messageId);
  assert.throws(() => f.a.outbox(row.messageId), error => error.code === 'INVALID');
  const reopened = new PeerStore(f.paths.a, { config: f.configurations.a });
  assert.throws(() => reopened.outbox(row.messageId), error => error.code === 'INVALID'); reopened.close();
});

test('actual client keeps malformed, oversized and forged HTTP replies pending', async t => {
  const f = await fixture(t), row = f.a.enqueue(message());
  const ack = f.b.receiveEnvelope(row.envelope); let mode = 'forged';
  const server = http.createServer((_request, response) => {
    const body = mode === 'oversized' ? Buffer.alloc(4096, 0x78)
      : mode === 'extra' ? wireBytes({ ...ack, lease: 'authority' }) : wireBytes(ack);
    const headers = acknowledgementHeaders(f.configurations.b, row.digest, body, NOW);
    if (mode === 'forged') headers['x-factory-peer-mac'] = '0'.repeat(64);
    response.writeHead(200, { ...headers, 'content-length': body.length }); response.end(body);
  });
  await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
  try {
    for (const value of ['forged', 'oversized', 'extra']) {
      mode = value;
      assert.equal((await dispatchPeerMessage({ store: f.a, messageId: row.messageId })).state, 'pending');
      assert.equal(f.a.outbox(row.messageId).digest, row.digest); assert.equal(f.a.events().length, 1);
    }
    mode = 'valid';
    assert.equal((await dispatchPeerMessage({ store: f.a, messageId: row.messageId })).state, 'acknowledged');
    assert.equal(f.a.events().length, 2);
  } finally { await closeServer(server); }
});

test('refuses unrelated SQLite before changing main/WAL files', async t => {
  const f = await fixture(t), filename = path.join(f.directory, 'unrelated-factory.sqlite');
  const unrelated = new FactoryControl(filename); unrelated.initialize({ mission: 'Preserve this state', budgetCents: 0 });
  const rows = async () => Promise.all(['', '-wal', '-shm'].map(async suffix => {
    try { return { suffix, hash: sha(await fs.readFile(filename + suffix)) }; } catch (error) { if (error.code === 'ENOENT') return { suffix, absent: true }; throw error; }
  }));
  const before = await rows();
  assert.throws(() => new PeerStore(filename, { config: f.configurations.a }), error => error.code === 'FOREIGN_DATABASE');
  assert.deepEqual(await rows(), before); assert.equal(unrelated.control().policy.mission, 'Preserve this state'); unrelated.close();
});

test('transport rejects redirects and bounded deadline preserves pending intent', async t => {
  const f = await fixture(t), row = f.a.enqueue(message());
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.writeHead(307, { location: 'http://127.0.0.1:1/v1/peer/messages' }); response.end(); });
  await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
  assert.equal((await dispatchPeerMessage({ store: f.a, messageId: row.messageId })).failure, 'REMOTE_REJECTION');
  assert.equal(requests, 1); assert.equal(f.a.outbox(row.messageId).state, 'pending'); await closeServer(server);
  const hanging = http.createServer(() => {}); await new Promise(resolve => hanging.listen(f.port, '127.0.0.1', resolve));
  const started = performance.now();
  assert.equal((await dispatchPeerMessage({ store: f.a, messageId: row.messageId, timeoutMs: 100 })).failure, 'DEADLINE');
  assert.ok(performance.now() - started < 2000); await closeServer(hanging);
  assert.equal(f.a.outbox(row.messageId).digest, row.digest); assert.equal(f.a.events().length, 1);
  assert.throws(() => validateEndpoint('http://localhost:1/v1/peer/messages'), error => error.code === 'ENDPOINT');
  await assert.rejects(startPeerServer({ store: f.b, host: '0.0.0.0', port: 0 }), error => error.code === 'BIND');
});
