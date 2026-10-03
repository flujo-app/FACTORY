import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PeerStore, createPairConfigurations, wireBytes, parseWire, acknowledgementHeaders } from '../src/peer-messaging.mjs';
import { validateWatchConfig, watchBinding } from '../src/peer-watch.mjs';
import { watchFingerprint, nextWatchPayload, validateHealthProjection } from '../src/peer-watch-state.mjs';
import { HEALTH_LIMIT, healthRequestHeaders, verifyHealthRequest, healthResponseBytes, healthResponseHeaders,
  verifyHealthResponse, probePeerHealth, createLocalHealthSource } from '../src/peer-health.mjs';
import { startPeerServer } from '../src/peer-gateway.mjs';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { startPresentationServer } from '../src/presentation.mjs';

const NOW = 1800000000000;
const CLI = fileURLToPath(new URL('../bin/peer.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const errorCode = code => error => error.code === code;
const plain = row => row === undefined ? null : { ...row };
async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function eventually(operation, description, milliseconds = 15000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) { const value = await operation(); if (value) return value; await sleep(40); }
  assert.fail('Deadline: ' + description);
}
function pair(endpointA = 'http://127.0.0.1:1/v1/peer/messages', endpointB = 'http://127.0.0.1:2/v1/peer/messages', now = NOW) {
  return createPairConfigurations({ a: { identity: { factoryId: 'watch-a', cellId: 'root' }, endpoint: endpointA },
    b: { identity: { factoryId: 'watch-b', cellId: 'root' }, endpoint: endpointB }, credentialExpiresAt: now + 3600000 });
}
function configuration(directory = os.tmpdir()) {
  return { schemaVersion: 1, watchId: 'mutual-a', source: { snapshotUrl: 'http://127.0.0.1:1234/v1/snapshot',
    tokenFile: path.join(directory, 'viewer.private.json'), expectedFactoryId: 'watch-a', expectedCellId: 'root' },
  intervalMs: 1000, timeoutMs: 1000, maxAgeMs: 600000, messageTtlMs: 60000, durationMs: 60000 };
}
function projection({ controller = 7, paid = 5, time = NOW, status = 'active', known = 0 } = {}) {
  return { availability: 'available', observedAt: time,
    controller: { revision: controller, epoch: 1, status, cell: { id: 'root', role: 'coordinator', status: 'ready', heartbeat: 'fresh' },
      unresolvedEffects: 0, effectsDrained: true, workerQuiescence: 'unverified',
      logical: { limitCents: 10000, committedCents: 0, unallocatedCents: 10000, meteredSpendCents: null, basis: 'logical-allocation', currency: 'USD' } },
    paid: { availability: 'available', observedAt: time, revision: paid, limitCents: 10000, committedCents: 1000,
      unallocatedCents: 9000, knownMeteredCents: known, meteredSpendCents: null, billingIncomplete: true,
      currency: 'USD', overCommittedCents: 0, basis: 'shared-paid-admission-ledger' } };
}
function observed(source = projection(), extras = {}) {
  return { sampledAt: NOW, reachability: 'responding', authentication: 'verified', freshness: 'fresh', generation: 1,
    instanceId: '11111111-1111-4111-8111-111111111111', source,
    sourceRevisions: { controller: source.controller?.revision ?? null, paid: source.paid.availability === 'available' ? source.paid.revision : null }, failure: null, ...extras };
}
function unreachable(extras = {}) {
  return { sampledAt: NOW, reachability: 'unreachable', authentication: 'unverified', freshness: 'unobserved', generation: 1,
    instanceId: null, source: null, sourceRevisions: { controller: null, paid: null }, failure: 'CONNECTION', ...extras };
}
async function stores(t, config = pair()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-watch-unit-'));
  const time = { now: NOW }, paths = { a: path.join(directory, 'a.sqlite'), b: path.join(directory, 'b.sqlite') };
  const a = new PeerStore(paths.a, { config: config.a, clock: () => time.now });
  const b = new PeerStore(paths.b, { config: config.b, clock: () => time.now });
  t.after(async () => { a.close(); b.close(); assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('factory-watch-unit-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, paths, a, b, config, time, binding: { watchId: 'unit-watch', bindingDigest: 'a'.repeat(64) } };
}
function record(f, observation, expected = f.a.watchCheckpoint(f.binding)?.messageId ?? null) {
  const checkpoint = f.a.watchCheckpoint(f.binding);
  return f.a.recordWatchObservation({ ...f.binding, expectedMessageId: expected, expectedDigest: checkpoint?.digest ?? null, observation, messageTtlMs: 60000 });
}
function acknowledge(f, row) {
  const body = wireBytes(f.b.receiveEnvelope(row.envelope));
  f.a.acknowledge(row.messageId, body, acknowledgementHeaders(f.config.b, row.digest, body, f.time.now));
}
function readDatabase(filename, operation) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try { return operation(database); } finally { database.close(); }
}
function watchRows(filename, watchId) {
  return readDatabase(filename, database => database.prepare('SELECT * FROM peer_outbox ORDER BY rowid').all()
    .map(row => ({ ...row, envelope: JSON.parse(row.body) })).filter(row => row.envelope.payload.watchId === watchId)); }
function eventsFor(filename, messageId, type) {
  return readDatabase(filename, database => database.prepare('SELECT * FROM peer_events WHERE message_id=? AND type=? ORDER BY sequence').all(messageId, type).map(plain));
}

test('watch configuration binds fixed local source, own identity and closed bounded policy', () => {
  const config = pair().a, input = configuration(), validated = validateWatchConfig(input, config);
  assert.equal(validated.source.snapshotUrl, input.source.snapshotUrl);
  assert.equal(validateWatchConfig({ ...input, durationMs: null }, config).durationMs, null);
  for (const source of [{ ...input.source, snapshotUrl: 'http://localhost:1234/v1/snapshot' },
    { ...input.source, snapshotUrl: 'http://127.0.0.1:1234/v1/snapshot?database=elsewhere' },
    { ...input.source, snapshotUrl: 'https://remote.example/v1/snapshot' }, { ...input.source, expectedFactoryId: 'watch-b' },
    { ...input.source, expectedCellId: 'other' }, { ...input.source, tokenFile: 'relative.json' }])
    assert.throws(() => validateWatchConfig({ ...input, source }, config));
  for (const [key, value] of [['intervalMs', 999], ['timeoutMs', 30001], ['maxAgeMs', 999], ['messageTtlMs', 86400001], ['durationMs', true]])
    assert.throws(() => validateWatchConfig({ ...input, [key]: value }, config));
  assert.throws(() => validateWatchConfig({ ...input, command: 'pause' }, config));
  assert.notEqual(watchBinding(input, config).bindingDigest, watchBinding({ ...input, timeoutMs: 1001 }, config).bindingDigest);
  assert.notEqual(watchBinding(input, config).bindingDigest, watchBinding({ ...input, source: { ...input.source, snapshotUrl: 'http://127.0.0.1:1235/v1/snapshot' } }, config).bindingDigest);
});

test('signed health binds nonce, exact pair, generation and advisory capabilities', () => {
  const configs = pair(), challenge = { nonce: 'b'.repeat(64), requestedAt: NOW };
  const headers = healthRequestHeaders(configs.a, challenge, NOW);
  assert.deepEqual(verifyHealthRequest(configs.b, headers, NOW), challenge);
  assert.throws(() => verifyHealthRequest(configs.b, { ...headers, 'x-factory-health-nonce': 'c'.repeat(64) }, NOW), errorCode('AUTHENTICATION'));
  assert.throws(() => verifyHealthRequest(configs.b, headers, NOW + 30001), errorCode('AUTHENTICATION'));
  assert.throws(() => verifyHealthRequest({ ...configs.b, generation: 2 }, headers, NOW), errorCode('CREDENTIAL_GENERATION'));
  const body = healthResponseBytes(configs.b, challenge, { instanceId: randomUUID(), source: projection() }, NOW);
  const responseHeaders = healthResponseHeaders(configs.b, challenge, body, NOW);
  const wrongCell = projection(); wrongCell.controller.cell.id = 'other';
  assert.throws(() => healthResponseBytes(configs.b, challenge, { instanceId: randomUUID(), source: wrongCell }, NOW), errorCode('IDENTITY'));
  assert.equal(verifyHealthResponse(configs.a, challenge, body, responseHeaders, NOW).capabilities.commands, false);
  assert.throws(() => verifyHealthResponse(configs.a, { ...challenge, nonce: 'c'.repeat(64) }, body, responseHeaders, NOW), errorCode('AUTHENTICATION'));
  assert.throws(() => verifyHealthResponse(configs.a, challenge, body, { ...responseHeaders, 'x-factory-health-mac': '0'.repeat(64) }, NOW), errorCode('AUTHENTICATION'));
  const value = parseWire(body);
  const wrongCellBody = wireBytes({ ...value, source: { ...value.source, controller: { ...value.source.controller,
    cell: { ...value.source.controller.cell, id: 'other' } } } });
  assert.throws(() => verifyHealthResponse(configs.a, challenge, wrongCellBody,
    healthResponseHeaders(configs.b, challenge, wrongCellBody, NOW), NOW), errorCode('IDENTITY'));
  for (const malformed of [{ ...value, sender: { ...value.sender, lease: 'authority' } },
    { ...value, recipient: { factoryId: 'foreign', cellId: 'root' } },
    { ...value, source: { ...value.source, controller: { ...value.source.controller, cell: { ...value.source.controller.cell, id: 'other' } } } },
    { ...value, capabilities: { observation: true, commands: true } }, { ...value, provision: true },
    { ...value, observedAt: NOW - 30001 }, { ...value, source: { ...value.source, observedAt: NOW + 30001 } }]) {
    const bytes = wireBytes(malformed);
    assert.throws(() => verifyHealthResponse(configs.a, challenge, bytes, healthResponseHeaders(configs.b, challenge, bytes, NOW), NOW));
  }
  assert.throws(() => healthRequestHeaders({ ...configs.a, credentialExpiresAt: NOW }, challenge, NOW), errorCode('CREDENTIAL_EXPIRED'));
});

test('durable watch CAS suppresses timestamp noise and preserves the immutable pending chain across connections', async t => {
  const f = await stores(t), first = record(f, observed());
  assert.equal(first.changed, true); assert.equal(first.checkpoint.payload.episode, 1);
  const secondConnection = new PeerStore(f.paths.a, { config: f.config.a, clock: () => f.time.now });
  try {
    assert.throws(() => secondConnection.recordWatchObservation({ ...f.binding, expectedMessageId: null,
    expectedDigest: null, observation: observed(projection({ status: 'paused' })), messageTtlMs: 60000 }), errorCode('WATCH_CONFLICT'));
    assert.throws(() => secondConnection.recordWatchObservation({ ...f.binding, expectedMessageId: first.checkpoint.messageId,
      expectedDigest: '0'.repeat(64), observation: observed(projection({ status: 'paused' })), messageTtlMs: 60000 }), errorCode('WATCH_CONFLICT'));
    const noise = observed(projection({ time: NOW + 4000 }), { sampledAt: NOW + 4000 });
    assert.equal(watchFingerprint(noise), watchFingerprint(observed()));
    assert.equal(record(f, noise).changed, false); assert.equal(f.a.counts().peer_outbox, 1);
    const changed = record(f, observed(projection({ controller: 8, status: 'paused' })));
    assert.equal(changed.checkpoint.payload.previousMessageId, first.outbox.messageId);
    assert.equal(changed.checkpoint.payload.previousDigest, first.outbox.digest);
    assert.deepEqual(secondConnection.watchCheckpoint(f.binding), changed.checkpoint);
    const original = secondConnection.watchPending(f.binding)[0];
    assert.ok(original.body.equals(first.outbox.body)); assert.equal(original.endpoint, first.outbox.endpoint);
    assert.throws(() => secondConnection.watchCheckpoint({ ...f.binding, bindingDigest: 'b'.repeat(64) }), errorCode('WATCH_CONFIG_CONFLICT'));
    f.a.enqueue({ messageId: 'manual-observation', type: 'health_observation', payload: { manual: true }, createdAt: NOW, expiresAt: NOW + 60000 });
    assert.equal(f.a.watchPending(f.binding).length, 2); // Manual messages are never watch-owned automatic retries.
    assert.deepEqual(f.a.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name),
      ['peer_events', 'peer_identity', 'peer_inbox', 'peer_outbox']);
  } finally { secondConnection.close(); }
});

test('watch retry expiry, generation floors and bounded pending backpressure never replace admitted originals', async t => {
  const f = await stores(t), first = record(f, observed());
  f.time.now += 60001;
  const expired = f.a.watchPending(f.binding)[0];
  assert.equal(expired.delivery, 'expired-unconfirmed'); assert.ok(expired.body.equals(first.outbox.body));
  assert.equal(expired.digest, first.outbox.digest); assert.equal(expired.envelope.expiresAt, NOW + 60000);
  assert.equal(record(f, observed()).changed, false);
  for (let revision = 8; revision <= 38; revision++) record(f, observed(projection({ controller: revision })));
  assert.equal(f.a.watchPending(f.binding).length, 32);
  const current = f.a.watchCheckpoint(f.binding);
  assert.throws(() => record(f, observed(projection({ controller: 39 }))), errorCode('WATCH_BACKPRESSURE'));
  assert.deepEqual(f.a.watchCheckpoint(f.binding), current);
  const key = randomBytes(32).toString('base64url');
  const rotatedConfig = { ...f.config.a, generation: 2, key };
  const rotated = new PeerStore(f.paths.a, { config: rotatedConfig, rotateFromGeneration: 1, clock: () => f.time.now });
  try {
    assert.throws(() => f.a.watchCheckpoint(f.binding), errorCode('CREDENTIAL_GENERATION'));
    assert.equal(rotated.watchPending(f.binding)[0].digest, first.outbox.digest);
    assert.throws(() => rotated.recordWatchObservation({ ...f.binding, expectedMessageId: current.messageId,
      expectedDigest: current.digest, observation: observed(), messageTtlMs: 60000 }), errorCode('CREDENTIAL_GENERATION'));
  } finally { rotated.close(); }
});

test('watch chain refuses forked payloads and deleted history before appending new authority-free data', async t => {
  const f = await stores(t), first = record(f, observed()), second = record(f, observed(projection({ controller: 8 })));
  const envelope = structuredClone(second.outbox.envelope); envelope.payload.previousDigest = 'f'.repeat(64);
  const body = wireBytes(envelope), digest = sha(body);
  f.a.db.prepare('UPDATE peer_outbox SET body=?,digest=? WHERE message_id=?').run(body.toString(), digest, second.outbox.messageId);
  f.a.db.prepare("UPDATE peer_events SET digest=? WHERE type='outbox_enqueued' AND message_id=?").run(digest, second.outbox.messageId);
  assert.throws(() => f.a.watchCheckpoint(f.binding), errorCode('WATCH_CHAIN'));
  assert.throws(() => record(f, observed(projection({ controller: 9 })), second.outbox.messageId), errorCode('WATCH_CHAIN'));
  f.a.db.prepare('UPDATE peer_outbox SET body=?,digest=? WHERE message_id=?').run(second.outbox.body.toString(), second.outbox.digest, second.outbox.messageId);
  f.a.db.prepare("UPDATE peer_events SET digest=? WHERE type='outbox_enqueued' AND message_id=?").run(second.outbox.digest, second.outbox.messageId);
  f.a.db.prepare('DELETE FROM peer_outbox WHERE message_id=?').run(first.outbox.messageId);
  assert.throws(() => f.a.watchCheckpoint(f.binding), errorCode('WATCH_CHAIN'));
  assert.equal(f.a.counts().peer_outbox, 1);
});

test('health accounting keeps logical allocation, incomplete money and actual overcommit separate', () => {
  const value = projection(); assert.equal(validateHealthProjection(value), value);
  const overcommitted = structuredClone(value);
  Object.assign(overcommitted.paid, { committedCents: 10020, unallocatedCents: 0, overCommittedCents: 20, knownMeteredCents: 20 });
  assert.equal(validateHealthProjection(overcommitted).paid.overCommittedCents, 20);
  for (const mutate of [v => { v.paid.overCommittedCents = 0; }, v => { v.paid.currency = 'EUR'; },
    v => { v.controller.logical.currency = 'EUR'; }, v => { v.paid.meteredSpendCents = 20; },
    v => { v.paid.billingIncomplete = false; v.paid.meteredSpendCents = 21; },
    v => { v.controller.workerQuiescence = 'verified'; }]) {
    const malformed = structuredClone(overcommitted); mutate(malformed); assert.throws(() => validateHealthProjection(malformed));
  }
  overcommitted.paid.billingIncomplete = false; overcommitted.paid.meteredSpendCents = 20;
  assert.equal(validateHealthProjection(overcommitted).paid.meteredSpendCents, 20);
});

test('highest independent revision floors survive outages and quarantine regressed live aggregates without inventing history', async t => {
  const f = await stores(t), first = record(f, observed(projection({ controller: 10, paid: 20 })));
  const lost = record(f, unreachable());
  assert.deepEqual(lost.checkpoint.payload.revisionFloors, { controller: 10, paid: 20 });
  assert.deepEqual(lost.checkpoint.payload.lastTrustedSource, first.checkpoint.payload.lastTrustedSource);
  const oneBack = record(f, observed(projection({ controller: 9, paid: 21, known: 1 })));
  assert.equal(oneBack.checkpoint.payload.observation.failure, 'REVISION_REGRESSED');
  assert.equal(oneBack.checkpoint.payload.observation.source.availability, 'unavailable');
  assert.equal(oneBack.checkpoint.payload.observation.source.controller, null);
  assert.equal(oneBack.checkpoint.payload.observation.source.paid.knownMeteredCents, null);
  assert.deepEqual(oneBack.checkpoint.payload.observation.sourceRevisions, { controller: 9, paid: 21 });
  assert.deepEqual(oneBack.checkpoint.payload.revisionFloors, { controller: 10, paid: 21 });
  assert.deepEqual(oneBack.checkpoint.payload.lastTrustedSource, first.checkpoint.payload.lastTrustedSource);
  const otherBack = record(f, observed(projection({ controller: 11, paid: 20 })));
  assert.deepEqual(otherBack.checkpoint.payload.revisionFloors, { controller: 11, paid: 21 });
  assert.equal(otherBack.checkpoint.payload.observation.failure, 'REVISION_REGRESSED');
  assert.deepEqual(f.a.watchCheckpoint(f.binding), otherBack.checkpoint); // Recomputable persisted quarantined chain.
  const recovered = record(f, observed(projection({ controller: 11, paid: 21, known: 1 })));
  assert.equal(recovered.checkpoint.payload.observation.freshness, 'fresh');
  const missingPaid = projection({ controller: 12 });
  missingPaid.paid = { availability: 'unavailable', observedAt: null, revision: null, limitCents: null, committedCents: null,
    unallocatedCents: null, overCommittedCents: null, knownMeteredCents: null, meteredSpendCents: null, billingIncomplete: null,
    currency: 'USD', basis: 'shared-paid-admission-ledger' };
  const partial = record(f, observed(missingPaid));
  assert.equal(partial.checkpoint.payload.observation.source.paid.availability, 'unavailable');
  assert.deepEqual(partial.checkpoint.payload.revisionFloors, { controller: 12, paid: 21 });
  assert.deepEqual(partial.checkpoint.payload.lastTrustedSource.paid, recovered.checkpoint.payload.lastTrustedSource.paid);
  const stale = record(f, observed(projection({ controller: 13, paid: 22 }), { freshness: 'stale', failure: 'STALE_HEALTH' }));
  assert.deepEqual(stale.checkpoint.payload.revisionFloors, { controller: 13, paid: 22 });
  assert.deepEqual(stale.checkpoint.payload.lastTrustedSource, partial.checkpoint.payload.lastTrustedSource);
  assert.throws(() => record(f, observed(projection(), { sourceRevisions: { controller: 999, paid: 999 } })), errorCode('WATCH_SHAPE'));
});

test('complete acknowledged watch history streams beyond a thousand episodes and validates old corruption', { timeout: 120000 }, async t => {
  const f = await stores(t), prefix = 'watch.' + sha(Buffer.from(f.binding.watchId)).slice(0, 32) + '.';
  let previous = null;
  // Real enqueue/receive/authenticated ACK commits avoid quadratic setup through repeated full-history folding.
  for (let episode = 1; episode <= 1001; episode++) {
    const payload = nextWatchPayload(previous, observed(projection({ controller: episode })), f.binding);
    const row = f.a.enqueue({ messageId: prefix + episode, type: 'health_observation', payload, createdAt: NOW, expiresAt: NOW + 60000 });
    acknowledge(f, row); previous = { messageId: row.messageId, digest: row.digest, payload };
  }
  const head = f.a.watchCheckpoint(f.binding);
  assert.equal(head.payload.episode, 1001); assert.equal(f.a.watchPending(f.binding).length, 0);
  const next = record(f, observed(projection({ controller: 1002 })));
  assert.equal(next.checkpoint.payload.episode, 1002); assert.equal(next.checkpoint.payload.previousMessageId, head.messageId);
  assert.equal(f.a.counts().peer_outbox, 1002);
  const oldest = f.a.outbox(prefix + '1');
  f.a.db.prepare("UPDATE peer_events SET digest=? WHERE type='outbox_enqueued' AND message_id=?").run('0'.repeat(64), oldest.messageId);
  assert.throws(() => f.a.watchCheckpoint(f.binding), errorCode('WATCH_CHAIN'));
  assert.throws(() => f.a.watchPending(f.binding), errorCode('WATCH_CHAIN'));
});

test('real authenticated health transport rejects spoofing, stale paid clocks, redirects, overflow and deadline', async t => {
  let mode = 'valid', configs, healthRequests = 0, redirected = 0, deferred;
  const trap = http.createServer((_request, response) => { redirected++; response.end(); }); const trapPort = await listen(trap);
  const server = http.createServer((request, response) => {
    healthRequests++;
    if (mode === 'deadline') return;
    if (mode === 'redirect') { response.writeHead(307, { location: `http://127.0.0.1:${trapPort}/v1/peer/health` }); response.end(); return; }
    if (mode === 'overflow') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(Buffer.alloc(HEALTH_LIMIT + 1)); return; }
    const send = () => {
      const challenge = verifyHealthRequest(configs.b, request.headers, NOW);
      let source = projection();
      if (mode === 'unavailable') source = { availability: 'unavailable', observedAt: null, controller: null,
        paid: { availability: 'unavailable', observedAt: null, revision: null, limitCents: null, committedCents: null,
          unallocatedCents: null, overCommittedCents: null, knownMeteredCents: null, meteredSpendCents: null,
          billingIncomplete: null, currency: 'USD', basis: 'shared-paid-admission-ledger' } };
      if (mode === 'paid-stale') source.paid.observedAt = NOW - 1001;
      if (mode === 'source-stale') source.observedAt = NOW - 1001;
      if (mode === 'future') source.paid.observedAt = NOW + 30001;
      const body = healthResponseBytes(configs.b, challenge, { instanceId: '22222222-2222-4222-8222-222222222222', source }, NOW);
      const headers = healthResponseHeaders(configs.b, challenge, body, NOW);
      if (mode === 'spoof') headers['x-factory-health-mac'] = '0'.repeat(64);
      response.writeHead(200, headers); response.end(body);
    };
    if (mode === 'deferred') deferred = send; else send();
  });
  const port = await listen(server); configs = pair(undefined, `http://127.0.0.1:${port}/v1/peer/messages`);
  const f = await stores(t, configs);
  try {
    const valid = await probePeerHealth({ store: f.a, timeoutMs: 1000, maxAgeMs: 1000 });
    assert.equal(valid.authentication, 'verified'); assert.equal(valid.freshness, 'fresh');
    assert.deepEqual(valid.sourceRevisions, { controller: 7, paid: 5 });
    for (const [value, expectedFailure, expectedAuthentication] of [['unavailable', 'SOURCE_UNAVAILABLE', 'verified'], ['paid-stale', 'STALE_HEALTH', 'verified'],
      ['source-stale', 'STALE_HEALTH', 'verified'], ['future', 'STALE_HEALTH', 'unverified'], ['spoof', 'AUTHENTICATION', 'unverified'],
      ['redirect', 'HTTP_REJECTION', 'unverified'], ['overflow', 'HEALTH_LIMIT', 'unverified'], ['deadline', 'DEADLINE', 'unverified']]) {
      mode = value; const observation = await probePeerHealth({ store: f.a, timeoutMs: value === 'deadline' ? 100 : 1000, maxAgeMs: 1000 });
      assert.equal(observation.failure, expectedFailure, value); assert.equal(observation.authentication, expectedAuthentication, value);
      if (expectedAuthentication === 'unverified') { assert.equal(observation.source, null); assert.equal(observation.instanceId, null); }
    }
    assert.equal(healthRequests, 9); assert.equal(redirected, 0);
    assert.deepEqual(f.a.counts(), { peer_outbox: 0, peer_inbox: 0, peer_events: 0 });
    await assert.rejects(startPeerServer({ store: f.b, host: '0.0.0.0', port: 0 }), errorCode('BIND'));
    mode = 'deferred';
    const pendingProbe = probePeerHealth({ store: f.a, timeoutMs: 1000, maxAgeMs: 1000 });
    const rejectsAfterRead = assert.rejects(pendingProbe, errorCode('CREDENTIAL_GENERATION'));
    await eventually(() => deferred, 'real in-flight authenticated health request');
    const rotated = new PeerStore(f.paths.a, { config: { ...configs.a, generation: 2, key: randomBytes(32).toString('base64url') },
      rotateFromGeneration: 1, clock: () => NOW });
    try { deferred(); await rejectsAfterRead; assert.equal(f.a.counts().peer_outbox, 0); }
    finally { rotated.close(); }
  } finally { await closeServer(server); await closeServer(trap); }
});

test('local readonly health source checks authenticated native identity, currency and controller/paid freshness', async t => {
  const f = await stores(t), controlPath = path.join(f.directory, 'control.sqlite'), paidPath = path.join(f.directory, 'paid.sqlite');
  const control = new FactoryControl(controlPath, { clock: () => NOW }), paid = new SpendingLedger(paidPath, { clock: () => NOW });
  const token = randomBytes(32).toString('hex'); let now = NOW;
  control.initialize({ mission: 'Native local source test', budgetCents: 10000 }); paid.initialize({ limitCents: 10000, currency: 'USD' });
  const presentation = await startPresentationServer({ databasePath: controlPath, spendingLedgerPath: paidPath,
    factoryId: f.config.a.local.factoryId, token, port: 0, clock: () => now, buildRevision: 'a'.repeat(40) });
  const snapshot = await fetch(`http://127.0.0.1:${presentation.address().port}/v1/snapshot`, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' }).then(response => response.json());
  let body = snapshot, status = 200, extraRead = 0;
  const server = http.createServer((request, response) => {
    extraRead++; assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, 'Bearer ' + token);
    response.writeHead(status, { 'content-type': 'application/json', ...(status === 307 ? { location: `http://127.0.0.1:${presentation.address().port}/v1/snapshot` } : {}) });
    response.end(JSON.stringify(body));
  }); const port = await listen(server);
  const input = { ...configuration(f.directory), maxAgeMs: 1000, source: { ...configuration(f.directory).source,
    snapshotUrl: `http://127.0.0.1:${port}/v1/snapshot` } };
  const privateFiles = { async readPrivateJson(filename, options) { assert.equal(filename, input.source.tokenFile); assert.equal(options.maxBytes, 1024); return { token }; } };
  try {
    const reader = await createLocalHealthSource({ configuration: input, privateFiles, clock: () => now });
    assert.equal((await reader.read()).availability, 'available');
    for (const mutate of [v => { v.factoryId = 'wrong'; }, v => { v.snapshot.cells[0].id = 'wrong'; },
      v => { v.snapshot.budget.currency = 'EUR'; }, v => { v.snapshot.paidBudget.currency = 'EUR'; },
      v => { v.observedAt = new Date(NOW - 1001).toISOString(); }, v => { v.observedAt = new Date(NOW + 1001).toISOString(); },
      v => { v.snapshot.paidBudget.observedAt = new Date(NOW - 1001).toISOString(); },
      v => { v.snapshot.paidBudget.observedAt = new Date(NOW + 1001).toISOString(); }]) {
      body = structuredClone(snapshot); mutate(body); const unavailable = await reader.read();
      assert.equal(unavailable.availability, 'unavailable'); assert.equal(unavailable.controller, null); assert.equal(unavailable.paid.knownMeteredCents, null);
    }
    body = snapshot; status = 307; const before = extraRead;
    assert.equal((await reader.read()).availability, 'unavailable'); assert.equal(extraRead, before + 1);
    now = NOW + 1001; status = 200;
    assert.equal((await reader.read()).availability, 'unavailable');
  } finally { await closeServer(server); await closeServer(presentation); control.close(); paid.close(); }
});

// These are transport proxies, not fake watchers: production CLI processes own both stores and all health/POST handling.
async function proxy() {
  const state = { port: null, upstream: null, healthCompleted: 0, posts: [], dropped: [], selectDrop: null,
    dropId: null, allowAcknowledgement: false, committed: null, failure: null };
  const sockets = new Set(), requests = new Set();
  const server = http.createServer((request, response) => {
    const chunks = []; let count = 0;
    request.on('error', () => {});
    request.on('data', bytes => { count += bytes.length; if (count > 65536) request.destroy(); else chunks.push(bytes); });
    request.on('end', () => {
      if (state.upstream === null) { response.writeHead(503); response.end(); return; }
      const body = Buffer.concat(chunks);
      let envelope;
      try { if (request.method === 'POST') envelope = parseWire(body); } catch { state.failure = 'INVALID_PROXY_BODY'; response.destroy(); return; }
      if (envelope && state.selectDrop?.(envelope) && state.dropId === null) state.dropId = envelope.messageId;
      if (envelope) state.posts.push({ messageId: envelope.messageId, digest: sha(body), bodySha256: sha(body) });
      const upstream = http.request({ host: '127.0.0.1', port: state.upstream, method: request.method, path: request.url,
        headers: request.headers, agent: false }, incoming => {
        const output = []; let size = 0;
        incoming.on('data', bytes => { size += bytes.length; if (size > 65536) incoming.destroy(); else output.push(bytes); });
        incoming.on('error', () => response.destroy());
        incoming.on('end', () => {
          if (request.method === 'GET' && incoming.statusCode === 200) state.healthCompleted++;
          if (envelope?.messageId === state.dropId && !state.allowAcknowledgement && incoming.statusCode === 200) {
            try {
              const ack = parseWire(Buffer.concat(output));
              assert.equal(ack.messageId, envelope.messageId); assert.equal(ack.digest, sha(body));
              state.committed?.({ envelope, body, acknowledgement: ack }); state.dropped.push({ messageId: envelope.messageId, digest: sha(body) });
            } catch { state.failure = 'POST_COMMIT_WITNESS_FAILED'; }
            response.destroy(); // Real receiver response was drained after COMMIT, none of its ACK reaches the sender.
          } else if (!response.destroyed) { response.writeHead(incoming.statusCode, incoming.headers); response.end(Buffer.concat(output)); }
        });
      });
      requests.add(upstream); upstream.once('close', () => requests.delete(upstream));
      upstream.setTimeout(3000, () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent && !response.destroyed) { response.writeHead(503); response.end(); } else response.destroy(); });
      upstream.end(body);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  state.port = await listen(server);
  return { state, async close() { for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy(); await closeServer(server); } };
}
function startWatcher({ configFile, watchFile, database, privateModule }) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)));
  const child = spawn(process.execPath, [CLI, 'watch', '--private-module', privateModule, '--config', configFile,
    '--database', database, '--watch-file', watchFile, '--host', '127.0.0.1', '--port', '0'],
  { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { pid: child.pid ?? null, closeConfirmed: false, code: null, signal: null, events: [], stdout: '', stderr: '', failure: null };
  let pending = '', bytes = 0;
  const closed = new Promise(resolve => child.once('close', (code, signal) => { state.code = code; state.signal = signal; state.closeConfirmed = true; resolve(state); }));
  child.once('error', () => { state.failure = 'SPAWN_ERROR'; });
  child.stdout.on('data', chunk => {
    bytes += chunk.length; if (bytes > 65536) { state.failure = 'OUTPUT_LIMIT'; child.kill(); return; }
    state.stdout += chunk.toString(); pending += chunk.toString();
    while (pending.includes('\n')) {
      const index = pending.indexOf('\n'), line = pending.slice(0, index); pending = pending.slice(index + 1);
      try { const event = JSON.parse(line); assert.equal(event.scope, 'advisory-mutual-watch');
        assert.ok(['listening', 'observed', 'delivery', 'backpressure', 'stopped'].includes(event.state)); state.events.push(event); }
      catch { state.failure = 'CHILD_PROTOCOL'; child.kill(); }
    }
  });
  child.stderr.on('data', chunk => { bytes += chunk.length; state.stderr += chunk.toString(); if (bytes > 65536) { state.failure = 'OUTPUT_LIMIT'; child.kill(); } });
  return { child, state, closed,
    async ready() { const event = await eventually(() => { assert.equal(state.failure, null); assert.equal(state.closeConfirmed, false);
      return state.events.find(value => value.state === 'listening'); }, 'watcher readiness'); assert.ok(event.port > 0 && event.port <= 65535); return event; },
    async stop() { if (!state.closeConfirmed) child.kill('SIGTERM');
      let timer; try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned watcher failed to close')), 10000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(state.closeConfirmed, true); return state; } };
}

test('actual reciprocal watch CLI processes stay quiet, observe native changes and recover a committed lost ACK after both restart', { timeout: 120000 }, async () => {
  const privateModule = process.env.FACTORY_PRIVATE_MODULE ?? process.env.FACTORY_PEER_PRIVATE_TEST_MODULE;
  assert.ok(privateModule && path.isAbsolute(privateModule), 'Set an explicit owner-private helper; this acceptance must not silently skip.');
  const privateFiles = await import(pathToFileURL(privateModule).href);
  const preservedParent = process.env.FACTORY_PEER_WATCH_PROBE_ROOT;
  if (preservedParent) { assert.ok(path.isAbsolute(preservedParent)); await privateFiles.assertPrivateDirectory(preservedParent); }
  const parent = preservedParent ?? os.tmpdir(), directory = path.join(parent, 'factory-peer-watch-' + randomUUID());
  await privateFiles.ensurePrivateDirectory(directory);
  const resources = { children: [], sources: [], stores: [], proxies: [] };
  const evidence = { format: 'factory-native-peer-watch-acceptance', schemaVersion: 1, success: false,
    scope: 'Actual same-host production watch CLI processes; application termination and SQLite replay, no power-loss/remote-HA/native enrollment/provider/inference claim.',
    startedAt: new Date().toISOString(), children: [], quiet: null, transition: null, outage: null, replay: null, failure: null };
  let assertionError;
  try {
    const aProxy = await proxy(), bProxy = await proxy(); resources.proxies.push(aProxy, bProxy);
    const configs = pair(`http://127.0.0.1:${aProxy.state.port}/v1/peer/messages`, `http://127.0.0.1:${bProxy.state.port}/v1/peer/messages`, Date.now());
    const peers = {};
    for (const name of ['a', 'b']) {
      const owned = path.join(directory, name); await privateFiles.ensurePrivateDirectory(owned);
      const controllerPath = path.join(owned, 'source-control.sqlite'), paidPath = path.join(owned, 'source-paid.sqlite');
      const control = new FactoryControl(controllerPath); resources.stores.push(control);
      control.initialize({ mission: 'Owned local mutual-watch acceptance', budgetCents: 10000, maxCells: 8, maxDepth: 2 });
      const paid = new SpendingLedger(paidPath); resources.stores.push(paid);
      paid.initialize({ limitCents: 10000, currency: 'USD' }); paid.reserve({ reservationId: 'local-fixture', provider: 'fly', ceilingCents: 1000 }); paid.start('local-fixture');
      const token = randomBytes(32).toString('hex');
      const source = await startPresentationServer({ databasePath: controllerPath, spendingLedgerPath: paidPath,
        factoryId: configs[name].local.factoryId, token, port: 0, buildRevision: 'a'.repeat(40) }); resources.sources.push(source);
      const configFile = path.join(owned, 'pair.private.json'), watchFile = path.join(owned, 'watch.private.json'), tokenFile = path.join(owned, 'viewer.private.json'), database = path.join(owned, 'peer.sqlite');
      const watch = { ...configuration(owned), watchId: 'mutual-' + name, source: { snapshotUrl: `http://127.0.0.1:${source.address().port}/v1/snapshot`,
        tokenFile, expectedFactoryId: configs[name].local.factoryId, expectedCellId: 'root' } };
      await privateFiles.writePrivateJson(configFile, configs[name], { exclusive: true });
      await privateFiles.writePrivateJson(tokenFile, { token }, { exclusive: true });
      await privateFiles.writePrivateJson(watchFile, watch, { exclusive: true });
      peers[name] = { control, paid, configFile, watchFile, database, token, watchId: watch.watchId };
    }
    async function launch(name, transport) {
      const processHandle = startWatcher({ ...peers[name], privateModule }); resources.children.push(processHandle);
      const ready = await processHandle.ready(); transport.state.upstream = ready.port;
      return { handle: processHandle, ready };
    }
    const firstA = await launch('a', aProxy), firstB = await launch('b', bProxy);
    const latest = name => watchRows(peers[name].database, peers[name].watchId).at(-1);
    function healthy(name, expectedInstance) {
      const row = latest(name); if (!row || row.state !== 'acknowledged') return false;
      const observation = row.envelope.payload.observation;
      return observation.authentication === 'verified' && observation.freshness === 'fresh' && observation.instanceId === expectedInstance && row;
    }
    await eventually(() => healthy('a', firstB.ready.instanceId) && healthy('b', firstA.ready.instanceId), 'reciprocal automatic observations');
    for (const name of ['a', 'b']) {
      const other = name === 'a' ? 'b' : 'a', observation = latest(name).envelope.payload.observation;
      assert.deepEqual(latest(name).envelope.recipient, configs[other].local);
      assert.equal(observation.source.controller.cell.id, 'root'); assert.equal(observation.source.controller.status, 'active');
      assert.equal(observation.source.controller.revision, peers[other].control.db.prepare('SELECT max(seq) AS revision FROM events').get().revision);
      assert.equal(observation.source.paid.revision, peers[other].paid.db.prepare('SELECT max(seq) AS revision FROM spending_events').get().revision);
      assert.equal(observation.source.paid.knownMeteredCents, 0); assert.equal(observation.source.paid.meteredSpendCents, null);
      assert.equal(observation.source.controller.workerQuiescence, 'unverified');
      assert.ok(Object.values(latest(name).envelope.provenance).every(value => value === null));
    }
    const count = name => watchRows(peers[name].database, peers[name].watchId).length;
    const beforeQuiet = { a: count('a'), b: count('b'), getA: aProxy.state.healthCompleted, getB: bProxy.state.healthCompleted };
    await eventually(() => aProxy.state.healthCompleted >= beforeQuiet.getA + 3 && bProxy.state.healthCompleted >= beforeQuiet.getB + 3, 'three completed unchanged signed polls in both directions');
    assert.equal(count('a'), beforeQuiet.a); assert.equal(count('b'), beforeQuiet.b);
    evidence.quiet = { before: beforeQuiet, after: { a: count('a'), b: count('b'), getA: aProxy.state.healthCompleted, getB: bProxy.state.healthCompleted }, observedTransitions: 0 };
    let captured, mutationStarted;
    bProxy.state.selectDrop = envelope => envelope.payload.watchId === peers.a.watchId && envelope.payload.observation.source?.controller?.status === 'paused'
      && envelope.payload.observation.source?.paid?.knownMeteredCents === 3;
    bProxy.state.committed = ({ envelope, body, acknowledgement }) => {
      const row = readDatabase(peers.b.database, database => plain(database.prepare('SELECT * FROM peer_inbox WHERE message_id=?').get(envelope.messageId)));
      assert.equal(row.body, body.toString()); assert.equal(row.digest, sha(body));
      assert.equal(row.sequence, acknowledgement.sequence); assert.equal(row.accepted_at, acknowledgement.acceptedAt);
      assert.equal(eventsFor(peers.b.database, envelope.messageId, 'inbox_recorded').length, 1);
      captured ??= { messageId: envelope.messageId, digest: sha(body), body: body.toString(), receiver: row, ack: acknowledgement,
        mutationToFirstCommitMs: performance.now() - mutationStarted };
    };
    // Both real fixture mutations happen synchronously before the presentation event loop can expose an intermediate projection.
    mutationStarted = performance.now();
    peers.b.control.pause(); peers.b.paid.observe('local-fixture', { chargedCents: 3, observedAt: Date.now(), evidenceDigest: 'f'.repeat(64) });
    await eventually(() => captured && bProxy.state.dropped.length >= 1, 'production receiver COMMIT before dropped ACK');
    const target = readDatabase(peers.a.database, database => plain(database.prepare('SELECT * FROM peer_outbox WHERE message_id=?').get(captured.messageId)));
    assert.equal(target.state, 'pending'); assert.equal(target.body, captured.body); assert.equal(target.digest, captured.digest);
    assert.equal(count('a'), beforeQuiet.a + 1); assert.equal(count('b'), beforeQuiet.b);
    assert.equal(eventsFor(peers.a.database, captured.messageId, 'outbox_enqueued').length, 1);
    assert.equal(eventsFor(peers.a.database, captured.messageId, 'outbox_acknowledged').length, 0);
    evidence.transition = { messageId: captured.messageId, digest: captured.digest, bodySha256: sha(Buffer.from(captured.body)),
      admittedGeneration: target.admitted_generation, endpoint: target.endpoint, episode: JSON.parse(target.body).payload.episode,
      sourceControllerRevision: JSON.parse(target.body).payload.observation.source.controller.revision,
      sourcePaidRevision: JSON.parse(target.body).payload.observation.source.paid.revision, controllerStatus: 'paused', knownMeteredCents: 3,
      outboxAdmissions: 1, receiverCommits: 1, acknowledgedBeforeRestart: 0, receiverSequence: captured.receiver.sequence, receiverAcceptedAt: captured.receiver.accepted_at,
      mutationToFirstCommitMs: captured.mutationToFirstCommitMs };
    const previousInstances = { a: firstA.ready.instanceId, b: firstB.ready.instanceId };
    await firstB.handle.stop(); bProxy.state.upstream = null;
    const outageStarted = performance.now();
    const outage = await eventually(() => {
      const row = latest('a'), observation = row?.envelope.payload.observation;
      return observation?.authentication === 'unverified' && observation.failure === 'HTTP_REJECTION' && row;
    }, 'automatic remote-gateway outage observation while the other watcher stays running');
    assert.equal(outage.envelope.payload.observation.freshness, 'unobserved');
    assert.equal(outage.envelope.payload.observation.instanceId, null); assert.equal(outage.envelope.payload.observation.source, null);
    assert.deepEqual(outage.envelope.payload.revisionFloors, JSON.parse(target.body).payload.revisionFloors);
    assert.equal(outage.envelope.payload.lastTrustedSource.controller.status, 'paused');
    evidence.outage = { messageId: outage.message_id, digest: outage.digest, failure: 'HTTP_REJECTION', authentication: 'unverified',
      freshness: 'unobserved', source: null, respondingProxyIsNotTrustedPeer: true, revisionFloors: outage.envelope.payload.revisionFloors,
      closedPeerToOutageAdmissionMs: performance.now() - outageStarted };
    await firstA.handle.stop(); aProxy.state.upstream = null;
    assert.equal(firstA.handle.state.closeConfirmed, true); assert.equal(firstB.handle.state.closeConfirmed, true);
    bProxy.state.allowAcknowledgement = true;
    const secondA = await launch('a', aProxy), secondB = await launch('b', bProxy);
    const bothRestartedReady = performance.now();
    assert.notEqual(secondA.handle.state.pid, firstA.handle.state.pid); assert.notEqual(secondB.handle.state.pid, firstB.handle.state.pid);
    assert.notEqual(secondA.ready.instanceId, previousInstances.a); assert.notEqual(secondB.ready.instanceId, previousInstances.b);
    const replayed = await eventually(() => readDatabase(peers.a.database, database => {
      const row = plain(database.prepare('SELECT * FROM peer_outbox WHERE message_id=?').get(captured.messageId)); return row.state === 'acknowledged' && row;
    }), 'exact original pending outbox replay');
    for (const key of ['message_id', 'body', 'digest', 'endpoint', 'admitted_generation']) assert.equal(replayed[key], target[key]);
    assert.deepEqual(JSON.parse(replayed.acknowledgement), captured.ack);
    const receiverAfter = readDatabase(peers.b.database, database => plain(database.prepare('SELECT * FROM peer_inbox WHERE message_id=?').get(captured.messageId)));
    assert.deepEqual(receiverAfter, captured.receiver);
    const restartedToOriginalResolutionMs = performance.now() - bothRestartedReady;
    assert.equal(eventsFor(peers.b.database, captured.messageId, 'inbox_recorded').length, 1);
    assert.equal(eventsFor(peers.a.database, captured.messageId, 'outbox_enqueued').length, 1);
    assert.equal(eventsFor(peers.a.database, captured.messageId, 'outbox_acknowledged').length, 1);
    const repeated = bProxy.state.posts.filter(post => post.messageId === captured.messageId);
    assert.ok(repeated.length >= 2); assert.ok(repeated.every(post => post.digest === captured.digest && post.bodySha256 === captured.digest));
    await eventually(() => healthy('a', secondB.ready.instanceId) && healthy('b', secondA.ready.instanceId), 'new real process instances become reciprocal fresh observations');
    evidence.replay = { messageId: captured.messageId, digest: captured.digest, bodySha256: captured.digest, posts: repeated.length,
      outboxAdmissions: 1, inboxEvents: 1, acknowledgementEvents: 1, receiverSequence: receiverAfter.sequence, receiverAcceptedAt: receiverAfter.accepted_at,
      previousInstances, restartedInstances: { a: secondA.ready.instanceId, b: secondB.ready.instanceId }, exactOriginalTuplePreserved: true,
      bothReadyToOriginalResolutionMs: restartedToOriginalResolutionMs, bothReadyToReciprocalHealthyMs: performance.now() - bothRestartedReady };
    for (const latency of [evidence.transition.mutationToFirstCommitMs, evidence.outage.closedPeerToOutageAdmissionMs,
      evidence.replay.bothReadyToOriginalResolutionMs, evidence.replay.bothReadyToReciprocalHealthyMs]) assert.ok(Number.isFinite(latency) && latency >= 0);
    for (const transport of resources.proxies) assert.equal(transport.state.failure, null);
    for (const processHandle of resources.children) {
      assert.equal(processHandle.state.failure, null); assert.equal(processHandle.state.stderr, '');
      for (const secret of [configs.a.key, peers.a.token, peers.b.token]) {
        assert.equal(processHandle.state.stdout.includes(secret), false); assert.equal(processHandle.state.stderr.includes(secret), false);
        assert.equal(captured.body.includes(secret), false);
      }
    }
    evidence.success = true;
  } catch (error) { assertionError = error; evidence.failure = { name: error.name, messageSha256: sha(Buffer.from(String(error.message))) }; }
  finally {
    const cleanupFailures = [];
    for (const [index, processHandle] of resources.children.entries()) {
      try { await processHandle.stop(); } catch (error) { cleanupFailures.push(error.name); }
      const state = processHandle.state;
      const stdoutName = `child-${index + 1}.stdout.jsonl`, stderrName = `child-${index + 1}.stderr.log`;
      await fs.writeFile(path.join(directory, stdoutName), state.stdout, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(directory, stderrName), state.stderr, { flag: 'wx', mode: 0o600 });
      evidence.children.push({ pid: state.pid, closeConfirmed: state.closeConfirmed, exitCode: state.code, signal: state.signal,
        protocolFailure: state.failure, stdoutName, stderrName, stdoutBytes: Buffer.byteLength(state.stdout), stderrBytes: Buffer.byteLength(state.stderr),
        stdoutSha256: sha(Buffer.from(state.stdout)), stderrSha256: sha(Buffer.from(state.stderr)),
        listening: state.events.find(event => event.state === 'listening') ?? null });
    }
    for (const transport of resources.proxies) { try { await transport.close(); } catch (error) { cleanupFailures.push(error.name); } }
    for (const server of resources.sources) { try { await closeServer(server); } catch (error) { cleanupFailures.push(error.name); } }
    for (const store of resources.stores) { try { store.close(); } catch (error) { cleanupFailures.push(error.name); } }
    evidence.cleanupFailures = cleanupFailures; evidence.endedAt = new Date().toISOString();
    evidence.success &&= cleanupFailures.length === 0 && evidence.children.length === 4 && evidence.children.every(child => child.closeConfirmed && child.protocolFailure === null);
    const filename = path.join(directory, 'execution.private.json');
    await privateFiles.writePrivateJson(filename, evidence, { exclusive: true });
    assert.deepEqual(await privateFiles.readPrivateJson(filename, { maxBytes: 65536 }), evidence);
    if (!preservedParent && evidence.children.every(child => child.closeConfirmed)) {
      assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('factory-peer-watch-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  if (assertionError) throw assertionError;
  assert.equal(evidence.success, true);
});
