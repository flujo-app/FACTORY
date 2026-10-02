import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const DIGEST = /^[a-fA-F0-9]{64}$/;
const FINAL = new Set(['settled', 'cancelled']);

export class SpendingError extends Error {
  constructor(code, message) { super(message); this.name = 'SpendingError'; this.code = code; }
}
function fail(code, message) { throw new SpendingError(code, message); }
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID', 'Invalid reservation identifier.'); return value; }
function integer(value, name) { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID', `${name} must be a nonnegative safe integer.`); return value; }
function hash(value) { if (typeof value !== 'string' || !DIGEST.test(value)) fail('INVALID', 'Evidence must be a SHA-256 digest.'); return value.toLowerCase(); }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID', 'Unexpected ledger fields.');
  return value;
}
function sum(values) {
  const total = values.reduce((acc, value) => acc + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('OVERFLOW', 'Total cents exceed the supported integer range.');
  return Number(total);
}
function reservation(row) {
  return {
    reservationId: row.id, provider: row.provider, ceilingCents: row.ceiling_cents,
    state: row.state, chargedCents: row.charged_cents, observedAt: row.observed_at,
    evidenceDigest: row.observation_digest, retirementEvidenceDigest: row.retirement_digest,
    finalCents: row.final_cents, finalEvidenceDigest: row.final_digest,
    createdAt: row.created_at, startedAt: row.started_at, retiredAt: row.retired_at,
    settledAt: row.settled_at, cancelledAt: row.cancelled_at,
  };
}
function held(row) {
  if (row.state === 'cancelled') return 0;
  if (row.state === 'settled') return row.final_cents;
  return Math.max(row.ceiling_cents, row.charged_cents ?? 0);
}

/** Trusted-local accounting, separate from cell allocations and provider operation journals. */
export class SpendingLedger {
  constructor(path, { clock = Date.now } = {}) {
    if (typeof path !== 'string' || !isAbsolute(path) || typeof clock !== 'function') fail('INVALID', 'An absolute database path and clock are required.');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.clock = clock;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version !== 0 && version !== 1) fail('SCHEMA', 'Unsupported spending schema.');
        // A different pilot database must never be silently adopted as the paid ledger.
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
        if (tables.some(name => !['spending_policy', 'spending_reservations', 'spending_events'].includes(name))) fail('SCHEMA', 'Database is not a spending ledger.');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS spending_policy(id INTEGER PRIMARY KEY CHECK(id=1), limit_cents INTEGER NOT NULL CHECK(limit_cents>=0), currency TEXT NOT NULL CHECK(currency='USD'));
          CREATE TABLE IF NOT EXISTS spending_reservations(
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, ceiling_cents INTEGER NOT NULL CHECK(ceiling_cents>=0),
            state TEXT NOT NULL CHECK(state IN ('reserved','started','retired-meter-pending','settled','cancelled')),
            charged_cents INTEGER CHECK(charged_cents>=0), observed_at INTEGER, observation_digest TEXT,
            retirement_digest TEXT, final_cents INTEGER CHECK(final_cents>=0), final_digest TEXT,
            created_at INTEGER NOT NULL, started_at INTEGER, retired_at INTEGER, settled_at INTEGER, cancelled_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS spending_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, reservation_id TEXT, details TEXT NOT NULL, created_at INTEGER NOT NULL);
          PRAGMA user_version=1;
        `);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  now() { return integer(this.clock(), 'clock'); }
  policy() {
    const row = this.db.prepare('SELECT * FROM spending_policy WHERE id=1').get();
    if (!row) fail('UNINITIALIZED', 'Initialize the paid-spend ledger.');
    return row;
  }
  row(id) {
    const row = this.db.prepare('SELECT * FROM spending_reservations WHERE id=?').get(identifier(id));
    if (!row) fail('NOT_FOUND', 'Reservation not found.');
    return row;
  }
  rows() { return this.db.prepare('SELECT * FROM spending_reservations ORDER BY created_at,id').all(); }
  event(type, id, details) {
    this.db.prepare('INSERT INTO spending_events(type,reservation_id,details,created_at) VALUES(?,?,?,?)').run(type, id, JSON.stringify(details), this.now());
  }
  initialize(input) {
    const { limitCents, currency } = fields(input, ['limitCents', 'currency']);
    integer(limitCents, 'limitCents');
    if (currency !== 'USD') fail('INVALID', 'Only USD accounting is supported.');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM spending_policy WHERE id=1').get();
      if (previous) {
        if (previous.limit_cents !== limitCents || previous.currency !== currency) fail('CONFLICT', 'Paid-spend policy is already fixed.');
      } else {
        this.db.prepare('INSERT INTO spending_policy VALUES(1,?,?)').run(limitCents, currency);
        this.event('initialized', null, { limitCents, currency });
      }
      return this.snapshot();
    });
  }
  reserve(input) {
    const { reservationId, provider, ceilingCents } = fields(input, ['reservationId', 'provider', 'ceilingCents']);
    identifier(reservationId); integer(ceilingCents, 'ceilingCents');
    if (typeof provider !== 'string' || !PROVIDER.test(provider)) fail('INVALID', 'Provider must be a lowercase identifier.');
    return this.transaction(() => {
      const policy = this.policy();
      const previous = this.db.prepare('SELECT * FROM spending_reservations WHERE id=?').get(reservationId);
      if (previous) {
        if (previous.provider !== provider || previous.ceiling_cents !== ceilingCents) fail('CONFLICT', 'Reservation identity is already bound to different inputs.');
        return reservation(previous);
      }
      const committed = sum(this.rows().map(held));
      if (BigInt(committed) + BigInt(ceilingCents) > BigInt(policy.limit_cents)) fail('BUDGET', 'Paid-spend allowance is already committed.');
      this.db.prepare('INSERT INTO spending_reservations(id,provider,ceiling_cents,state,created_at) VALUES(?,?,?,?,?)').run(reservationId, provider, ceilingCents, 'reserved', this.now());
      this.event('reserved', reservationId, { provider, ceilingCents });
      return reservation(this.row(reservationId));
    });
  }
  start(reservationId) {
    identifier(reservationId);
    return this.transaction(() => {
      const policy = this.policy(), row = this.row(reservationId);
      if (!['reserved', 'started'].includes(row.state)) fail('STATE', 'Only a reserved or started reservation can authorize paid work.');
      if (row.ceiling_cents === 0 || (row.charged_cents !== null && row.charged_cents >= row.ceiling_cents)) fail('BUDGET', 'This reservation has exhausted its paid allowance.');
      if (sum(this.rows().map(held)) > policy.limit_cents) fail('BUDGET', 'Observed spend has exhausted the paid allowance.');
      if (row.state === 'started') return reservation(row);
      this.db.prepare('UPDATE spending_reservations SET state=?,started_at=? WHERE id=?').run('started', this.now(), reservationId);
      this.event('started', reservationId, {});
      return reservation(this.row(reservationId));
    });
  }
  observe(reservationId, input) {
    identifier(reservationId);
    const { chargedCents, observedAt, evidenceDigest } = fields(input, ['chargedCents', 'observedAt', 'evidenceDigest']);
    integer(chargedCents, 'chargedCents'); integer(observedAt, 'observedAt'); const proof = hash(evidenceDigest);
    return this.transaction(() => {
      this.policy(); const row = this.row(reservationId);
      if (row.charged_cents === chargedCents && row.observed_at === observedAt && row.observation_digest === proof) return reservation(row);
      if (!['started', 'retired-meter-pending'].includes(row.state)) fail('STATE', 'Only an unfinalized paid reservation can be observed.');
      if (row.charged_cents !== null && (chargedCents < row.charged_cents || observedAt < row.observed_at)) fail('METER_REGRESSION', 'Cumulative observed spend and observation time cannot decrease.');
      if (row.observed_at === observedAt) fail('CONFLICT', 'Observation time is already bound to different evidence.');
      sum(this.rows().map(item => item.id === reservationId ? Math.max(item.ceiling_cents, chargedCents) : held(item)));
      this.db.prepare('UPDATE spending_reservations SET charged_cents=?,observed_at=?,observation_digest=? WHERE id=?').run(chargedCents, observedAt, proof, reservationId);
      this.event('observed', reservationId, { chargedCents, observedAt, evidenceDigest: proof });
      return reservation(this.row(reservationId));
    });
  }
  retire(reservationId, input) {
    identifier(reservationId); const { evidenceDigest } = fields(input, ['evidenceDigest']); const proof = hash(evidenceDigest);
    return this.transaction(() => {
      this.policy(); const row = this.row(reservationId);
      if (row.retirement_digest !== null) {
        if (row.retirement_digest !== proof) fail('CONFLICT', 'Retirement evidence is already fixed.');
        return reservation(row);
      }
      if (row.state !== 'started') fail('STATE', 'Only a started reservation can retire.');
      this.db.prepare('UPDATE spending_reservations SET state=?,retirement_digest=?,retired_at=? WHERE id=?').run('retired-meter-pending', proof, this.now(), reservationId);
      this.event('retired', reservationId, { evidenceDigest: proof });
      return reservation(this.row(reservationId));
    });
  }
  settle(reservationId, input) {
    identifier(reservationId); const { finalCents, evidenceDigest } = fields(input, ['finalCents', 'evidenceDigest']);
    integer(finalCents, 'finalCents'); const proof = hash(evidenceDigest);
    return this.transaction(() => {
      this.policy(); const row = this.row(reservationId);
      if (row.state === 'settled') {
        if (row.final_cents !== finalCents || row.final_digest !== proof) fail('CONFLICT', 'Final billing is already fixed.');
        return reservation(row);
      }
      if (row.state !== 'retired-meter-pending') fail('STATE', 'Retirement evidence is required before final billing.');
      if (finalCents < (row.charged_cents ?? 0)) fail('METER_REGRESSION', 'Final billing cannot be less than observed spend.');
      sum(this.rows().map(item => item.id === reservationId ? finalCents : held(item)));
      this.db.prepare('UPDATE spending_reservations SET state=?,final_cents=?,final_digest=?,settled_at=? WHERE id=?').run('settled', finalCents, proof, this.now(), reservationId);
      this.event('settled', reservationId, { finalCents, evidenceDigest: proof });
      return reservation(this.row(reservationId));
    });
  }
  cancel(reservationId) {
    identifier(reservationId);
    return this.transaction(() => {
      this.policy(); const row = this.row(reservationId);
      if (row.state === 'cancelled') return reservation(row);
      if (row.state !== 'reserved') fail('STATE', 'Only a never-started reservation can be cancelled.');
      this.db.prepare('UPDATE spending_reservations SET state=?,cancelled_at=? WHERE id=?').run('cancelled', this.now(), reservationId);
      this.event('cancelled', reservationId, {});
      return reservation(this.row(reservationId));
    });
  }
  snapshot() {
    const policy = this.policy(), rows = this.rows();
    const committedCents = sum(rows.map(held));
    const knownMeteredCents = sum(rows.map(row => row.state === 'settled' ? row.final_cents : row.charged_cents ?? 0));
    const billingIncomplete = rows.some(row => ['started', 'retired-meter-pending'].includes(row.state));
    return {
      limitCents: policy.limit_cents, currency: policy.currency, committedCents,
      unallocatedCents: Math.max(0, policy.limit_cents - committedCents),
      overCommittedCents: Math.max(0, committedCents - policy.limit_cents),
      meteredSpendCents: billingIncomplete ? null : knownMeteredCents,
      knownMeteredCents, unsettledReservations: rows.filter(row => !FINAL.has(row.state)).map(reservation),
      reservations: rows.map(reservation),
    };
  }
  status() { return this.transaction(() => this.snapshot()); }
}
