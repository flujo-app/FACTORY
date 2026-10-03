import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WATCH_FORMAT, WATCH_PAGE_LIMIT, nextWatchPayload, validateWatchPayload } from './peer-watch-state.mjs';

export const PEER_PATH = '/v1/peer/messages';
export const PEER_PROTOCOL = 'factory-peer-advisory-v1';
export const BODY_LIMIT = 64 * 1024;
export const ACK_LIMIT = 2048;
export const PEER_APPLICATION_ID = 0x46505031;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const TYPES = ['health_observation', 'checkpoint', 'review_result', 'work_offer', 'recovery_request', 'capacity_request'];
export class PeerError extends Error {
  constructor(code) { super(code); this.name = 'PeerError'; this.code = code; }
}
export function requirePeer(condition, code = 'INVALID') { if (!condition) throw new PeerError(code); }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function exact(value, keys) {
  requirePeer(value !== null && typeof value === 'object' && !Array.isArray(value));
  requirePeer(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function identifier(value) { requirePeer(typeof value === 'string' && ID.test(value)); return value; }
function integer(value, minimum = 0) { requirePeer(Number.isSafeInteger(value) && value >= minimum); return value; }
function identity(value) { exact(value, ['factoryId', 'cellId']); identifier(value.factoryId); identifier(value.cellId); return value; }
const sameIdentity = (a, b) => a.factoryId === b.factoryId && a.cellId === b.cellId;
function jsonValue(value, depth = 0, counter = { nodes: 0 }) {
  requirePeer(depth <= 16 && ++counter.nodes <= 8192);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { requirePeer(Number.isFinite(value)); return; }
  requirePeer(typeof value === 'object');
  if (Array.isArray(value)) {
    requirePeer(value.length <= 1024 && Object.keys(value).length === value.length);
    for (const item of value) jsonValue(item, depth + 1, counter);
  } else {
    requirePeer([Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length <= 128);
    for (const item of Object.values(value)) jsonValue(item, depth + 1, counter);
  }
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export function wireBytes(value, limit = BODY_LIMIT) {
  jsonValue(value);
  const bytes = Buffer.from(canonical(value), 'utf8');
  requirePeer(bytes.length > 0 && bytes.length <= limit, 'BODY_LIMIT');
  return bytes;
}
export function parseWire(bytes, limit = BODY_LIMIT) {
  requirePeer(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit, 'BODY_LIMIT');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw new PeerError('INVALID_WIRE'); }
  requirePeer(wireBytes(value, limit).equals(bytes), 'NONCANONICAL_WIRE');
  return value;
}
export function validateEndpoint(value) {
  requirePeer(typeof value === 'string');
  let url; try { url = new URL(value); } catch { throw new PeerError('ENDPOINT'); }
  requirePeer(!url.username && !url.password && !url.search && !url.hash && url.pathname === PEER_PATH, 'ENDPOINT');
  requirePeer(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)), 'ENDPOINT');
  requirePeer(url.port !== '0', 'ENDPOINT');
  return url.href;
}
export function validatePeerConfig(input) {
  exact(input, ['schemaVersion', 'local', 'peer', 'generation', 'key', 'credentialExpiresAt', 'endpoint']);
  requirePeer(input.schemaVersion === 1); identity(input.local); identity(input.peer);
  requirePeer(!sameIdentity(input.local, input.peer)); integer(input.generation, 1); integer(input.credentialExpiresAt, 1);
  requirePeer(typeof input.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.key));
  const key = Buffer.from(input.key, 'base64url'); requirePeer(key.length === 32 && key.toString('base64url') === input.key);
  const value = structuredClone(input); value.endpoint = validateEndpoint(value.endpoint);
  Object.freeze(value.local); Object.freeze(value.peer); return Object.freeze(value);
}
export function createPairConfigurations({ a, b, generation = 1, credentialExpiresAt }) {
  exact(a, ['identity', 'endpoint']); exact(b, ['identity', 'endpoint']);
  const key = randomBytes(32).toString('base64url');
  return {
    a: validatePeerConfig({ schemaVersion: 1, local: a.identity, peer: b.identity, generation, key, credentialExpiresAt, endpoint: b.endpoint }),
    b: validatePeerConfig({ schemaVersion: 1, local: b.identity, peer: a.identity, generation, key, credentialExpiresAt, endpoint: a.endpoint }),
  };
}
function provenance(value) {
  exact(value, ['taskId', 'attempt', 'ownerEpoch', 'policyRevision', 'observedAt', 'causalParent']);
  for (const key of ['taskId', 'policyRevision', 'causalParent']) if (value[key] !== null) identifier(value[key]);
  for (const key of ['attempt', 'ownerEpoch', 'observedAt']) if (value[key] !== null) integer(value[key]);
}
export function validateEnvelope(value) {
  exact(value, ['schemaVersion', 'protocol', 'messageId', 'sender', 'recipient', 'type', 'createdAt', 'expiresAt', 'provenance', 'payload']);
  requirePeer(value.schemaVersion === 1 && value.protocol === PEER_PROTOCOL);
  identifier(value.messageId); identity(value.sender); identity(value.recipient); requirePeer(TYPES.includes(value.type));
  integer(value.createdAt); integer(value.expiresAt, 1);
  requirePeer(value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= 86400000);
  provenance(value.provenance); wireBytes(value); return value;
}
function active(config, now) { requirePeer(config.credentialExpiresAt > now, 'CREDENTIAL_EXPIRED'); }
function mac(config, direction, digest, body) {
  const pair = [config.local, config.peer].sort((a, b) => canonical(a) < canonical(b) ? -1 : 1);
  return createHmac('sha256', Buffer.from(config.key, 'base64url')).update(wireBytes({
    domain: PEER_PROTOCOL, direction, pair, generation: config.generation,
    method: 'POST', path: PEER_PATH, messageDigest: digest, bodySha256: hash(body),
  })).digest('hex');
}
function headers(config, direction, digest, body) {
  return { 'content-type': 'application/json', 'x-factory-peer-generation': String(config.generation),
    'x-factory-peer-digest': digest, 'x-factory-peer-mac': mac(config, direction, digest, body) };
}
function verifyMac(config, direction, digest, body, supplied, now) {
  active(config, now);
  requirePeer(supplied['content-type'] === 'application/json', 'AUTHENTICATION');
  requirePeer(supplied['x-factory-peer-generation'] === String(config.generation), 'CREDENTIAL_GENERATION');
  requirePeer(supplied['x-factory-peer-digest'] === digest && HASH.test(digest), 'AUTHENTICATION');
  const given = supplied['x-factory-peer-mac']; requirePeer(typeof given === 'string' && HASH.test(given), 'AUTHENTICATION');
  requirePeer(timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(mac(config, direction, digest, body), 'hex')), 'AUTHENTICATION');
}
export function requestHeaders(config, body, now = Date.now()) {
  active(config, now); const envelope = validateEnvelope(parseWire(body));
  requirePeer(sameIdentity(envelope.sender, config.local) && sameIdentity(envelope.recipient, config.peer), 'IDENTITY');
  return headers(config, 'request', hash(body), body);
}
export function verifyRequest(config, body, supplied, now = Date.now()) {
  verifyMac(config, 'request', hash(body), body, supplied, now);
  const envelope = validateEnvelope(parseWire(body));
  requirePeer(sameIdentity(envelope.sender, config.peer) && sameIdentity(envelope.recipient, config.local), 'IDENTITY');
  return envelope;
}
export function acknowledgementHeaders(config, digest, body, now = Date.now()) {
  active(config, now); return headers(config, 'acknowledgement', digest, body);
}
export function verifyAcknowledgement(config, outbox, body, supplied, now = Date.now()) {
  verifyMac(config, 'acknowledgement', outbox.digest, body, supplied, now);
  const ack = parseWire(body, ACK_LIMIT);
  return validateAcknowledgement(config, outbox, ack);
}
function validateAcknowledgement(config, outbox, ack) {
  exact(ack, ['schemaVersion', 'protocol', 'messageId', 'sender', 'recipient', 'digest', 'acceptedAt', 'sequence']);
  requirePeer(ack.schemaVersion === 1 && ack.protocol === PEER_PROTOCOL);
  identity(ack.sender); identity(ack.recipient);
  requirePeer(ack.messageId === outbox.messageId && ack.digest === outbox.digest, 'ACK_IDENTITY');
  requirePeer(sameIdentity(ack.sender, config.local) && sameIdentity(ack.recipient, config.peer), 'ACK_IDENTITY');
  integer(ack.acceptedAt); integer(ack.sequence, 1); return ack;
}
function plainFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  requirePeer(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'STORAGE');
}
function existingPeerDatabase(filename) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'r');
    const header = Buffer.alloc(100);
    requirePeer(fs.readSync(descriptor, header, 0, 100, 0) === 100
      && header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))
      && header.readUInt32BE(68) === PEER_APPLICATION_ID, 'FOREIGN_DATABASE');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  const inspected = new DatabaseSync(filename, { readOnly: true });
  try {
    requirePeer(inspected.prepare('PRAGMA application_id').get().application_id === PEER_APPLICATION_ID
      && inspected.prepare('PRAGMA user_version').get().user_version === 1, 'FOREIGN_DATABASE');
    const names = inspected.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    requirePeer(canonical(names) === canonical(['peer_events', 'peer_identity', 'peer_inbox', 'peer_outbox']), 'FOREIGN_DATABASE');
    requirePeer(inspected.prepare('SELECT count(*) AS total FROM peer_identity').get().total === 1, 'FOREIGN_DATABASE');
  } finally { inspected.close(); }
}
/** Separate advisory ledger. No access to FactoryControl, effects, budgets or ownership. */
export class PeerStore {
  constructor(filename, { config, clock = Date.now, rotateFromGeneration = null } = {}) {
    requirePeer(path.isAbsolute(filename), 'STORAGE'); this.config = validatePeerConfig(config); this.clock = clock;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    for (let current = path.dirname(filename); current !== path.parse(current).root; current = path.dirname(current))
      requirePeer(!fs.lstatSync(current).isSymbolicLink(), 'STORAGE');
    for (const suffix of ['', '-wal', '-shm']) plainFile(filename + suffix);
    const existing = fs.existsSync(filename);
    if (existing) existingPeerDatabase(filename);
    this.db = new DatabaseSync(filename);
    try {
      // Publish the distinctive header while using SQLite's initial DELETE journal.
      // Existing unrelated databases are rejected before opening them for writes.
      if (!existing) this.db.exec(`PRAGMA application_id=${PEER_APPLICATION_ID};`);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      requirePeer([0, 1].includes(this.db.prepare('PRAGMA user_version').get().user_version), 'SCHEMA');
      this.db.exec(`CREATE TABLE IF NOT EXISTS peer_identity(id INTEGER PRIMARY KEY CHECK(id=1), local TEXT NOT NULL, peer TEXT NOT NULL, endpoint TEXT NOT NULL, generation INTEGER NOT NULL, key_digest TEXT NOT NULL, credential_expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS peer_outbox(message_id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, endpoint TEXT NOT NULL, admitted_generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','acknowledged')), acknowledgement TEXT, acknowledged_generation INTEGER);
        CREATE TABLE IF NOT EXISTS peer_inbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, digest TEXT NOT NULL, accepted_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS peer_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, message_id TEXT NOT NULL, digest TEXT NOT NULL, observed_at INTEGER NOT NULL);
        PRAGMA user_version=1;`);
      this.transaction(() => {
        const old = this.db.prepare('SELECT * FROM peer_identity WHERE id=1').get(), c = this.config;
        const keyDigest = hash(Buffer.from(c.key, 'base64url'));
        if (!old) {
          requirePeer(rotateFromGeneration === null, 'CREDENTIAL_GENERATION');
          this.db.prepare('INSERT INTO peer_identity VALUES(1,?,?,?,?,?,?)').run(canonical(c.local), canonical(c.peer), c.endpoint, c.generation, keyDigest, c.credentialExpiresAt);
        } else {
          requirePeer(old.local === canonical(c.local) && old.peer === canonical(c.peer) && old.endpoint === c.endpoint, 'CONFIG_CONFLICT');
          if (rotateFromGeneration !== null) {
            requirePeer(old.generation === rotateFromGeneration && c.generation === old.generation + 1 && c.credentialExpiresAt > this.clock(), 'CREDENTIAL_GENERATION');
            requirePeer(keyDigest !== old.key_digest, 'CONFIG_CONFLICT');
            this.db.prepare('UPDATE peer_identity SET generation=?,key_digest=?,credential_expires=? WHERE id=1').run(c.generation, keyDigest, c.credentialExpiresAt);
          } else requirePeer(old.generation === c.generation && old.key_digest === keyDigest && old.credential_expires === c.credentialExpiresAt, 'CREDENTIAL_GENERATION');
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assertCurrentCredential() {
    const row = this.db.prepare('SELECT generation,key_digest,credential_expires FROM peer_identity WHERE id=1').get();
    requirePeer(row?.generation === this.config.generation && row.key_digest === hash(Buffer.from(this.config.key, 'base64url'))
      && row.credential_expires === this.config.credentialExpiresAt, 'CREDENTIAL_GENERATION');
    active(this.config, this.clock());
  }
  enqueue(input) {
    return this.transaction(() => this.#enqueueInsideTransaction(input));
  }
  #enqueueInsideTransaction(input) {
    requirePeer(input && Object.keys(input).every(key => ['messageId', 'type', 'payload', 'createdAt', 'expiresAt', 'provenance'].includes(key)));
    identifier(input.messageId);
      this.assertCurrentCredential(); const old = this.outbox(input.messageId);
      const createdAt = input.createdAt ?? old?.envelope.createdAt ?? this.clock();
      const envelope = validateEnvelope({ schemaVersion: 1, protocol: PEER_PROTOCOL, messageId: input.messageId,
        sender: this.config.local, recipient: this.config.peer, type: input.type, createdAt, expiresAt: input.expiresAt,
        provenance: input.provenance ?? { taskId: null, attempt: null, ownerEpoch: null, policyRevision: null, observedAt: null, causalParent: null }, payload: input.payload });
      const body = wireBytes(envelope), digest = hash(body);
      if (old) { requirePeer(old.digest === digest && old.endpoint === this.config.endpoint, 'CONFLICT'); return old; }
      requirePeer(envelope.createdAt <= this.clock() + 30000 && envelope.expiresAt > this.clock(), 'MESSAGE_EXPIRED');
      this.db.prepare("INSERT INTO peer_outbox VALUES(?,?,?,?,?,'pending',NULL,NULL)").run(envelope.messageId, body.toString('utf8'), digest, this.config.endpoint, this.config.generation);
      this.db.prepare('INSERT INTO peer_events(type,message_id,digest,observed_at) VALUES(?,?,?,?)').run('outbox_enqueued', envelope.messageId, digest, this.clock());
      return this.outbox(envelope.messageId);
  }
  #watchHistory({ watchId, bindingDigest }) {
    identifier(watchId); requirePeer(typeof bindingDigest === 'string' && HASH.test(bindingDigest), 'WATCH_SHAPE');
    const prefix = 'watch.' + hash(Buffer.from(watchId)).slice(0, 32) + '.';
    // Full retained chain, read in bounded pages. There is no lifetime cutoff or wall-clock order.
    const count = this.db.prepare(`SELECT count(*) AS total FROM peer_outbox o
      WHERE substr(o.message_id,1,?)=? OR json_extract(o.body,'$.payload.watchId')=?`).get(prefix.length,prefix,watchId).total;
    const eventsCount = this.db.prepare("SELECT count(*) AS total FROM peer_events WHERE type='outbox_enqueued' AND substr(message_id,1,?)=?").get(prefix.length,prefix).total;
    requirePeer(count===eventsCount,'WATCH_CHAIN');
    const page = this.db.prepare(`SELECT o.message_id,e.sequence FROM peer_outbox o JOIN peer_events e
      ON e.message_id=o.message_id AND e.type='outbox_enqueued'
      WHERE (substr(o.message_id,1,?)=? OR json_extract(o.body,'$.payload.watchId')=?) AND e.sequence>?
      ORDER BY e.sequence LIMIT ?`);
    let previous=null,after=0,seen=0,pendingCount=0;const pending=[];
    while(true) {
      const rows=page.all(prefix.length,prefix,watchId,after,WATCH_PAGE_LIMIT);if(!rows.length)break;
      for(const row of rows) {
      const outbox = this.outbox(row.message_id), envelope = outbox.envelope;
      const events = this.db.prepare("SELECT sequence,digest FROM peer_events WHERE type='outbox_enqueued' AND message_id=? ORDER BY sequence LIMIT 2").all(outbox.messageId);
      requirePeer(events.length === 1 && events[0].digest === outbox.digest, 'WATCH_CHAIN');
      requirePeer(envelope.type === 'health_observation' && envelope.payload?.format === WATCH_FORMAT
        && envelope.payload.watchId === watchId && envelope.payload.bindingDigest === bindingDigest, 'WATCH_CONFIG_CONFLICT');
      requirePeer(envelope.payload.observation?.generation === outbox.admittedGeneration
        && Object.values(envelope.provenance).every(value => value === null), 'WATCH_CHAIN');
      const node={...outbox,sequence:events[0].sequence,payload:envelope.payload};
      validateWatchPayload(node.payload, previous, { watchId, bindingDigest });
      requirePeer(node.messageId === prefix + node.payload.episode
        && (!previous || (node.payload.semanticDigest !== previous.payload.semanticDigest
          && node.admittedGeneration >= previous.admittedGeneration)), 'WATCH_CHAIN');
      previous=node;after=row.sequence;seen++;
      if(node.state==='pending'){pendingCount++;if(pending.length<32)pending.push(node);}
      }
    }
    requirePeer(seen===count,'WATCH_CHAIN');return {checkpoint:previous,pending,pendingCount};
  }
  watchCheckpoint(binding) {
    return this.transaction(() => {
      this.assertCurrentCredential(); const row = this.#watchHistory(binding).checkpoint;
      return row ? { messageId: row.messageId, digest: row.digest, sequence: row.sequence, payload: structuredClone(row.payload) } : null;
    });
  }
  recordWatchObservation({ watchId, bindingDigest, expectedMessageId, expectedDigest, observation, messageTtlMs }) {
    requirePeer(expectedMessageId === null || typeof expectedMessageId === 'string', 'WATCH_SHAPE');
    requirePeer(expectedDigest === null || (typeof expectedDigest === 'string' && HASH.test(expectedDigest)), 'WATCH_SHAPE');
    requirePeer((expectedMessageId === null) === (expectedDigest === null), 'WATCH_SHAPE');
    requirePeer(Number.isSafeInteger(messageTtlMs) && messageTtlMs >= 1000 && messageTtlMs <= 86400000, 'WATCH_SHAPE');
    return this.transaction(() => {
      this.assertCurrentCredential(); const history = this.#watchHistory({ watchId, bindingDigest }), previous = history.checkpoint;
      requirePeer((previous?.messageId ?? null) === expectedMessageId && (previous?.digest ?? null) === expectedDigest, 'WATCH_CONFLICT');
      requirePeer(observation?.generation === this.config.generation, 'CREDENTIAL_GENERATION');
      requirePeer(observation?.source?.controller === null || observation?.source === null
        || observation?.source?.controller?.cell?.id === this.config.peer.cellId, 'IDENTITY');
      const payload = nextWatchPayload(previous, observation, { watchId, bindingDigest });
      const checkpoint = row => row ? { messageId: row.messageId, digest: row.digest, sequence: row.sequence, payload: structuredClone(row.payload) } : null;
      if (previous?.payload.semanticDigest === payload.semanticDigest) return { changed: false, checkpoint: checkpoint(previous), outbox: null };
      requirePeer(history.pendingCount < 32, 'WATCH_BACKPRESSURE');
      const createdAt = integer(this.clock()), messageId = 'watch.' + hash(Buffer.from(watchId)).slice(0,32) + '.' + payload.episode;
      const outbox = this.#enqueueInsideTransaction({ messageId, type: 'health_observation', payload, createdAt, expiresAt: createdAt + messageTtlMs });
      const sequence = this.db.prepare("SELECT sequence FROM peer_events WHERE type='outbox_enqueued' AND message_id=?").get(messageId).sequence;
      return { changed: true, checkpoint: checkpoint({ ...outbox, payload, sequence }), outbox };
    });
  }
  watchPending({ watchId, bindingDigest, limit = 32 }) {
    requirePeer(Number.isSafeInteger(limit) && limit >= 1 && limit <= 32, 'WATCH_SHAPE');
    return this.transaction(() => {
      this.assertCurrentCredential(); const history = this.#watchHistory({ watchId, bindingDigest });
      requirePeer(history.pendingCount <= limit, 'WATCH_BACKPRESSURE');
      return history.pending.map(row => ({ ...row, delivery: row.envelope.expiresAt <= this.clock() ? 'expired-unconfirmed' : 'pending' }));
    });
  }
  outbox(messageId) {
    identifier(messageId); const row = this.db.prepare('SELECT * FROM peer_outbox WHERE message_id=?').get(messageId);
    if (!row) return null;
    const body = Buffer.from(row.body, 'utf8'), envelope = validateEnvelope(parseWire(body));
    requirePeer(hash(body) === row.digest && envelope.messageId === row.message_id && row.endpoint === this.config.endpoint, 'STORAGE');
    requirePeer(sameIdentity(envelope.sender, this.config.local) && sameIdentity(envelope.recipient, this.config.peer), 'STORAGE');
    integer(row.admitted_generation, 1); requirePeer(row.admitted_generation <= this.config.generation, 'STORAGE');
    requirePeer(['pending', 'acknowledged'].includes(row.state), 'STORAGE');
    let acknowledgement = null;
    if (row.state === 'pending') requirePeer(row.acknowledgement === null && row.acknowledged_generation === null, 'STORAGE');
    else {
      requirePeer(typeof row.acknowledgement === 'string', 'STORAGE'); integer(row.acknowledged_generation, 1);
      requirePeer(row.acknowledged_generation >= row.admitted_generation && row.acknowledged_generation <= this.config.generation, 'STORAGE');
      acknowledgement = validateAcknowledgement(this.config, { messageId: row.message_id, digest: row.digest }, parseWire(Buffer.from(row.acknowledgement), ACK_LIMIT));
    }
    return { messageId: row.message_id, envelope, body, digest: row.digest, endpoint: row.endpoint, admittedGeneration: row.admitted_generation,
      state: row.state, acknowledgement, acknowledgedGeneration: row.acknowledged_generation };
  }
  receiveEnvelope(envelope) {
    validateEnvelope(envelope);
    requirePeer(sameIdentity(envelope.sender, this.config.peer) && sameIdentity(envelope.recipient, this.config.local), 'IDENTITY');
    return this.transaction(() => {
      this.assertCurrentCredential(); const body = wireBytes(envelope), digest = hash(body);
      let row = this.db.prepare('SELECT * FROM peer_inbox WHERE message_id=?').get(envelope.messageId);
      if (row) requirePeer(row.digest === digest && row.body === body.toString('utf8'), 'CONFLICT');
      else {
        requirePeer(envelope.createdAt <= this.clock() + 30000 && envelope.expiresAt > this.clock(), 'MESSAGE_EXPIRED');
        const now = integer(this.clock());
        this.db.prepare('INSERT INTO peer_inbox(message_id,body,digest,accepted_at) VALUES(?,?,?,?)').run(envelope.messageId, body.toString('utf8'), digest, now);
        this.db.prepare('INSERT INTO peer_events(type,message_id,digest,observed_at) VALUES(?,?,?,?)').run('inbox_recorded', envelope.messageId, digest, now);
        row = this.db.prepare('SELECT * FROM peer_inbox WHERE message_id=?').get(envelope.messageId);
      }
      return { schemaVersion: 1, protocol: PEER_PROTOCOL, messageId: envelope.messageId,
        sender: envelope.sender, recipient: envelope.recipient, digest, acceptedAt: row.accepted_at, sequence: row.sequence };
    });
  }
  acknowledge(messageId, body, headers) {
    return this.transaction(() => {
      this.assertCurrentCredential(); const old = this.outbox(messageId); requirePeer(old !== null, 'OUTBOX');
      const ack = verifyAcknowledgement(this.config, old, body, headers, this.clock());
      const bytes = wireBytes(ack, ACK_LIMIT);
      requirePeer(ack.messageId === old.messageId && ack.digest === old.digest && sameIdentity(ack.sender, this.config.local) && sameIdentity(ack.recipient, this.config.peer), 'ACK_IDENTITY');
      if (old.state === 'acknowledged') { requirePeer(wireBytes(old.acknowledgement, ACK_LIMIT).equals(bytes), 'CONFLICT'); return old; }
      this.db.prepare("UPDATE peer_outbox SET state='acknowledged',acknowledgement=?,acknowledged_generation=? WHERE message_id=? AND state='pending'").run(bytes.toString('utf8'), this.config.generation, messageId);
      this.db.prepare('INSERT INTO peer_events(type,message_id,digest,observed_at) VALUES(?,?,?,?)').run('outbox_acknowledged', messageId, old.digest, this.clock());
      return this.outbox(messageId);
    });
  }
  readInbox(messageId) {
    identifier(messageId); const row = this.db.prepare('SELECT body,digest FROM peer_inbox WHERE message_id=?').get(messageId);
    if (!row) return null;
    const body = Buffer.from(row.body); requirePeer(hash(body) === row.digest, 'STORAGE');
    const envelope = validateEnvelope(parseWire(body));
    requirePeer(envelope.messageId === messageId && sameIdentity(envelope.sender, this.config.peer) && sameIdentity(envelope.recipient, this.config.local), 'STORAGE');
    return envelope;
  }
  inbox({ after = 0, limit = 100 } = {}) { integer(after); integer(limit, 1); requirePeer(limit <= 500); return this.db.prepare('SELECT sequence,message_id,digest,accepted_at FROM peer_inbox WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit).map(row => ({ ...row })); }
  events({ after = 0, limit = 100 } = {}) { integer(after); integer(limit, 1); requirePeer(limit <= 500); return this.db.prepare('SELECT sequence,type,message_id,digest,observed_at FROM peer_events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit).map(row => ({ ...row })); }
  counts() { return Object.fromEntries(['peer_outbox', 'peer_inbox', 'peer_events'].map(name => [name, this.db.prepare(`SELECT count(*) AS total FROM ${name}`).get().total])); }
}
