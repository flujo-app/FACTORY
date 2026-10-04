import http from 'node:http';
import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { lstatSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createModalObservationReader } from './modal-observation.mjs';

const runFile = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const CAPABILITIES = Object.freeze({ snapshot: true, events: true, commands: false });
const MODAL_CAPABILITIES = Object.freeze({ observation: true, commands: false });
const OPEN_EFFECTS = new Set(['accepted', 'running', 'unknown']);
const ROW_LIMIT = 10_000;
const PAID_SCOPE = 'registered-factory-paid-reservations';
const SPENDING_COLUMNS = Object.freeze({
  spending_policy: ['id', 'limit_cents', 'currency'],
  spending_reservations: ['id', 'provider', 'ceiling_cents', 'state', 'charged_cents', 'observed_at', 'observation_digest',
    'retirement_digest', 'final_cents', 'final_digest', 'created_at', 'started_at', 'retired_at', 'settled_at', 'cancelled_at'],
  spending_events: ['seq', 'type', 'reservation_id', 'details', 'created_at'],
});

export class PresentationError extends Error {
  constructor(code, status = 503) { super('Factory presentation state is unavailable.'); this.code = code; this.status = status; }
}
function requireValue(condition, code = 'FACTORY_STATE_UNAVAILABLE', status = 503) {
  if (!condition) throw new PresentationError(code, status);
}
function integer(value, minimum = 0) { requireValue(Number.isSafeInteger(value) && value >= minimum); return value; }
function identifier(value) { requireValue(typeof value === 'string' && ID.test(value)); return value; }
function text(value, maxLength) { requireValue(typeof value === 'string'); return value.slice(0, maxLength); }
function hash(value) { requireValue(typeof value === 'string' && HASH.test(value)); return value; }
function iso(value) { integer(value); const result = new Date(value); requireValue(Number.isFinite(result.getTime())); return result.toISOString(); }
function optionalJson(value) { if (value === null) return null; const result = JSON.parse(value); requireValue(result && typeof result === 'object' && !Array.isArray(result)); return result; }
function member(value, allowed) { requireValue(allowed.includes(value)); return value; }
function sumCents(values) {
  const total = values.reduce((sum, value) => sum + BigInt(integer(value)), 0n);
  requireValue(total <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(total);
}
function nullableInteger(value) { return value === null ? null : integer(value); }
function nullableIso(value) { return value === null ? null : iso(value); }

export function validateViewerToken(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value)
    && new Set(value).size >= 8, 'VIEWER_TOKEN_INVALID', 400);
  return value;
}

// The token file is checked without placing its contents in process arguments or output.
const windowsTokenCheck = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $p = [Environment]::GetEnvironmentVariable('FACTORY_VIEWER_FILE')
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = [IO.File]::GetAccessControl($p)
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'unsafe' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { throw 'unsafe' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $identity.User.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'unsafe' }
  }
  [Console]::Out.Write('private')
} catch { [Environment]::Exit(1) }
`;

export async function loadViewerToken({ tokenFile, env = process.env } = {}) {
  if (tokenFile === undefined) return validateViewerToken(env.FACTORY_VIEWER_TOKEN);
  requireValue(typeof tokenFile === 'string' && path.isAbsolute(tokenFile), 'VIEWER_TOKEN_FILE_INVALID', 400);
  let handle;
  try {
    const before = await fs.lstat(tokenFile);
    requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 1024,
      'VIEWER_TOKEN_FILE_UNSAFE', 400);
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const { stdout } = await runFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsTokenCheck, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15_000, maxBuffer: 1024,
          env: { SystemRoot: systemRoot, WINDIR: systemRoot, FACTORY_VIEWER_FILE: tokenFile } });
      requireValue(stdout === 'private', 'VIEWER_TOKEN_FILE_UNSAFE', 400);
    } else requireValue(before.uid === process.getuid() && (before.mode & 0o077) === 0, 'VIEWER_TOKEN_FILE_UNSAFE', 400);
    handle = await fs.open(tokenFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    requireValue(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size && opened.mtimeMs === before.mtimeMs,
      'VIEWER_TOKEN_FILE_UNSAFE', 400);
    const content = await handle.readFile('utf8');
    const after = await handle.stat();
    requireValue(after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size && after.mtimeMs === opened.mtimeMs,
      'VIEWER_TOKEN_FILE_UNSAFE', 400);
    // Plain text is the preferred format; a private JSON {token} is also accepted.
    const trimmed = content.trim();
    return validateViewerToken(trimmed.startsWith('{') ? JSON.parse(trimmed).token : trimmed);
  } catch { throw new PresentationError('VIEWER_TOKEN_FILE_UNSAFE', 400); }
  finally { await handle?.close(); }
}

/** Cursors are opaque to clients, bounded sequence bookmarks rather than execution authority. */
export function encodeCursor(sequence) { integer(sequence); return Buffer.from(String(sequence)).toString('base64url'); }
export function decodeCursor(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value), 'INVALID_CURSOR', 400);
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  requireValue(/^(0|[1-9][0-9]{0,15})$/.test(decoded), 'INVALID_CURSOR', 400);
  const result = Number(decoded);
  requireValue(Number.isSafeInteger(result) && encodeCursor(result) === value, 'INVALID_CURSOR', 400);
  return result;
}

function readTransaction(databasePath, operation) {
  const file = lstatSync(databasePath);
  requireValue(file.isFile() && !file.isSymbolicLink());
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN;');
    requireValue(db.prepare('PRAGMA user_version').get().user_version === 1, 'FACTORY_SCHEMA_UNSUPPORTED');
    const authority = db.prepare('SELECT epoch,status FROM control WHERE id=1').get();
    const root = db.prepare('SELECT role FROM cells WHERE id=?').get('root');
    requireValue(authority && Number.isSafeInteger(authority.epoch) && authority.epoch >= 1
      && ['active', 'paused'].includes(authority.status) && root?.role === 'coordinator');
    const revision = integer(db.prepare('SELECT coalesce(max(seq),0) AS sequence FROM events').get().sequence);
    const result = operation(db, revision);
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}

function readSnapshot(db) {
  const control = db.prepare('SELECT epoch,status,policy FROM control WHERE id=1').get();
  requireValue(control);
  const policy = optionalJson(control.policy);
  requireValue(policy && typeof policy.mission === 'string');
  const cellRows = db.prepare('SELECT id,parent_id,depth,role,status,heartbeat,allocation,spent,purpose FROM cells ORDER BY id LIMIT ?').all(ROW_LIMIT + 1);
  const taskRows = db.prepare('SELECT id,project_id,branch,status,epoch,owner,expires,spec_digest,candidate,review FROM tasks ORDER BY id LIMIT ?').all(ROW_LIMIT + 1);
  const effectRows = db.prepare('SELECT key,kind,state,scope,scope_id,task_id,owner,owner_epoch,control_epoch,created,updated,request_digest FROM effects ORDER BY created,key LIMIT ?').all(ROW_LIMIT + 1);
  requireValue([cellRows, taskRows, effectRows].every(rows => rows.length <= ROW_LIMIT));
  const root = cellRows.find(cell => cell.id === 'root');
  requireValue(root?.role === 'coordinator');
  const limitCents = integer(policy.budgetCents), rootSpent = integer(root.spent);
  const rootCommittedCents = integer(rootSpent + cellRows.filter(cell => cell.parent_id === 'root' && cell.status !== 'retired')
    .reduce((sum, cell) => sum + integer(cell.allocation), 0));
  requireValue(rootCommittedCents <= limitCents && root.allocation === limitCents);
  const cells = cellRows.map(cell => ({ id: identifier(cell.id), parentId: cell.parent_id === null ? null : identifier(cell.parent_id),
    depth: integer(cell.depth), role: member(cell.role, ['developer', 'verifier', 'watcher', 'coordinator']),
    status: member(cell.status, ['reserved', 'ready', 'retired']), heartbeat: iso(cell.heartbeat),
    purpose: text(cell.purpose, 512), allocationCents: integer(cell.allocation), budgetBasis: 'logical-allocation' }));
  const tasks = taskRows.map(task => {
    const candidate = optionalJson(task.candidate), review = optionalJson(task.review);
    return { id: identifier(task.id), projectId: identifier(task.project_id), branch: text(task.branch, 256),
      status: member(task.status, ['ready', 'running', 'review', 'verified', 'rejected', 'delivered', 'completed', 'cancelled']),
      attempt: integer(task.epoch), owner: task.owner === null ? null : identifier(task.owner),
      leaseExpiry: task.expires === null ? null : iso(task.expires), specDigest: hash(task.spec_digest),
      candidate: candidate ? { sha256: hash(candidate.sha256) } : null,
      review: review ? { accepted: member(review.accepted, [true, false]), reviewerId: identifier(review.reviewerId),
        evidenceDigest: hash(review.sha256), candidateDigest: hash(review.candidateDigest), specDigest: hash(review.specDigest),
        attempt: integer(review.attempt) } : null };
  });
  const effects = effectRows.map(effect => ({ key: identifier(effect.key), kind: member(effect.kind, ['provision', 'flow_call', 'retire', 'delivery', 'worker_wake', 'worker_sleep']),
    state: member(effect.state, ['accepted', 'running', 'unknown', 'succeeded', 'not_applied']),
    scope: member(effect.scope, ['task', 'project', 'cleanup', 'worker']), scopeId: identifier(effect.scope_id),
    taskId: effect.task_id === null ? null : identifier(effect.task_id), owner: identifier(effect.owner),
    ownerEpoch: integer(effect.owner_epoch), controlEpoch: integer(effect.control_epoch),
    createdAt: iso(effect.created), updatedAt: iso(effect.updated), requestDigest: hash(effect.request_digest) }));
  const unresolvedEffects = effects.filter(effect => OPEN_EFFECTS.has(effect.state)).length;
  return { control: { mission: text(policy.mission, 2048), epoch: integer(control.epoch, 1), status: member(control.status, ['active', 'paused']) },
    cells, tasks, effects, budget: { limitCents, rootCommittedCents, unallocatedCents: limitCents - rootCommittedCents,
      meteredSpendCents: null, currency: 'USD', basis: 'logical-allocation' },
    unresolvedEffects, effectsDrained: unresolvedEffects === 0, workerQuiescence: 'unverified' };
}

// This reader deliberately does not import the writable ledger or accept client-selected paths.
function readPaidBudget(databasePath, observedAt, minimumRevision) {
  const unavailable = availability => ({ availability, scope: PAID_SCOPE, observedAt });
  if (databasePath === undefined) return unavailable('not-configured');
  let db;
  try {
    const file = lstatSync(databasePath);
    requireValue(file.isFile() && !file.isSymbolicLink());
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN;');
    requireValue(db.prepare('PRAGMA user_version').get().user_version === 1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    requireValue(tables.length === 3 && tables.every(row => Object.hasOwn(SPENDING_COLUMNS, row.name)));
    for (const [table, columns] of Object.entries(SPENDING_COLUMNS)) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      requireValue(actual.length === columns.length && actual.every((name, index) => name === columns[index]));
    }
    const policies = db.prepare('SELECT id,limit_cents,currency FROM spending_policy LIMIT 2').all();
    requireValue(policies.length === 1 && policies[0].id === 1 && policies[0].currency === 'USD');
    const limitCents = integer(policies[0].limit_cents);
    const revision = integer(db.prepare('SELECT coalesce(max(seq),0) AS sequence FROM spending_events').get().sequence, 1);
    requireValue(revision >= minimumRevision);
    const rows = db.prepare(`SELECT id,provider,ceiling_cents,state,charged_cents,observed_at,final_cents,
      created_at,started_at,retired_at,settled_at,cancelled_at
      FROM spending_reservations ORDER BY created_at,id LIMIT ?`).all(ROW_LIMIT + 1);
    requireValue(rows.length <= ROW_LIMIT);
    const reservations = rows.map(row => {
      const state = member(row.state, ['reserved', 'started', 'retired-meter-pending', 'settled', 'cancelled']);
      const chargedCents = nullableInteger(row.charged_cents), finalCents = nullableInteger(row.final_cents);
      const ceilingCents = integer(row.ceiling_cents);
      requireValue(typeof row.provider === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(row.provider));
      requireValue((chargedCents === null) === (row.observed_at === null));
      const hasStarted = ['started', 'retired-meter-pending', 'settled'].includes(state);
      const hasRetired = ['retired-meter-pending', 'settled'].includes(state);
      requireValue((row.started_at !== null) === hasStarted && (row.retired_at !== null) === hasRetired
        && (row.settled_at !== null) === (state === 'settled') && (row.cancelled_at !== null) === (state === 'cancelled')
        && (finalCents !== null) === (state === 'settled'));
      requireValue(hasStarted || chargedCents === null);
      requireValue(state !== 'settled' || finalCents >= (chargedCents ?? 0));
      const heldCents = state === 'cancelled' ? 0 : state === 'settled' ? finalCents : Math.max(ceilingCents, chargedCents ?? 0);
      return { reservationId: identifier(row.id), provider: row.provider, state, ceilingCents, heldCents, chargedCents, finalCents,
        overCeilingCents: Math.max(0, (finalCents ?? chargedCents ?? 0) - ceilingCents),
        createdAt: iso(row.created_at), startedAt: nullableIso(row.started_at), retiredAt: nullableIso(row.retired_at),
        settledAt: nullableIso(row.settled_at), cancelledAt: nullableIso(row.cancelled_at), observedAt: nullableIso(row.observed_at) };
    });
    const committedCents = sumCents(reservations.map(row => row.heldCents));
    const knownMeteredCents = sumCents(reservations.map(row => row.finalCents ?? row.chargedCents ?? 0));
    const billingIncomplete = reservations.some(row => ['started', 'retired-meter-pending'].includes(row.state));
    db.exec('COMMIT');
    return { availability: 'available', schemaVersion: 1, scope: PAID_SCOPE, basis: 'shared-paid-admission-ledger',
      currency: 'USD', limitCents, committedCents, unallocatedCents: Math.max(0, limitCents - committedCents),
      overCommittedCents: Math.max(0, committedCents - limitCents), knownMeteredCents,
      meteredSpendCents: billingIncomplete ? null : knownMeteredCents, billingIncomplete, revision, observedAt, reservations };
  } catch { return unavailable('unavailable'); }
  finally { db?.close(); }
}

function envelope({ factoryId, observedAt, revision, buildRevision }, payload) {
  return { schemaVersion: 1, factoryId, observedAt, revision, buildRevision, cursor: encodeCursor(revision),
    scope: 'local-coordinator', capabilities: CAPABILITIES, ...payload };
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", ...(status === 405 ? { Allow: 'GET' } : {}),
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) });
  response.end(`${JSON.stringify(payload)}\n`);
}

/** Operator-only single-authority projection. No command endpoint, tenancy or customer isolation claim. */
export function createPresentationServer({ databasePath, spendingLedgerPath, modalJournals = [], factoryId, token, buildRevision = 'unknown', clock = Date.now, eventPageSize = 100 } = {}) {
  requireValue(typeof databasePath === 'string' && path.isAbsolute(databasePath), 'PRESENTATION_INPUT_INVALID', 400);
  requireValue(spendingLedgerPath === undefined || (typeof spendingLedgerPath === 'string' && path.isAbsolute(spendingLedgerPath)), 'PRESENTATION_INPUT_INVALID', 400);
  identifier(factoryId); validateViewerToken(token);
  requireValue(buildRevision === 'unknown' || /^[a-f0-9]{40}$/.test(buildRevision), 'PRESENTATION_INPUT_INVALID', 400);
  requireValue(Number.isSafeInteger(eventPageSize) && eventPageSize >= 1 && eventPageSize <= 500, 'PRESENTATION_INPUT_INVALID', 400);
  let readModalObservation;
  try { readModalObservation = createModalObservationReader(modalJournals); }
  catch { throw new PresentationError('MODAL_JOURNAL_CONFIG_INVALID', 400); }
  const tokenDigest = createHash('sha256').update(token).digest();
  let highestRevision = 0;
  let highestPaidRevision = 0;
  const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    try {
      const authorization = request.headers.authorization;
      const credentials = typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)
        ? authorization.slice(7) : '';
      const givenDigest = createHash('sha256').update(credentials).digest();
      if (!timingSafeEqual(tokenDigest, givenDigest)) return jsonResponse(response, 401, { error: { code: 'UNAUTHORIZED' } });
      if (request.method !== 'GET') return jsonResponse(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      const url = new URL(request.url, 'http://127.0.0.1');
      const alias = /^\/v1\/(snapshot|events|modal-runs)$/.exec(url.pathname);
      const scoped = /^\/v1\/factories\/([^/]+)\/(snapshot|events|modal-runs)$/.exec(url.pathname);
      if (!alias && (!scoped || decodeURIComponent(scoped[1]) !== factoryId)) return jsonResponse(response, 404, { error: { code: 'FACTORY_NOT_FOUND' } });
      const operation = alias?.[1] ?? scoped[2];
      const allowedQuery = operation === 'events' ? ['after', 'limit'] : [];
      requireValue([...url.searchParams.keys()].every(key => allowedQuery.includes(key))
        && allowedQuery.every(key => url.searchParams.getAll(key).length <= 1), 'INVALID_QUERY', 400);
      if (operation === 'modal-runs') {
        const observedAt = iso(clock());
        const paidBudget = readPaidBudget(spendingLedgerPath, observedAt, highestPaidRevision);
        const payload = { schemaVersion: 1, factoryId, observedAt, buildRevision,
          scope: 'registered-modal-operation-journals', capabilities: MODAL_CAPABILITIES,
          modalRuns: readModalObservation(observedAt), paidBudget };
        requireValue(!JSON.stringify(payload).includes(token));
        if (paidBudget.availability === 'available') highestPaidRevision = Math.max(highestPaidRevision, paidBudget.revision);
        return jsonResponse(response, 200, payload);
      }
      const after = operation === 'events' && url.searchParams.has('after') ? decodeCursor(url.searchParams.get('after')) : 0;
      const limitText = url.searchParams.get('limit');
      requireValue(limitText === null || /^(?:[1-9][0-9]{0,2})$/.test(limitText), 'INVALID_QUERY', 400);
      const limit = limitText === null ? eventPageSize : Number(limitText);
      requireValue(limit >= 1 && limit <= 500, 'INVALID_QUERY', 400);
      const payload = readTransaction(databasePath, (db, revision) => {
        requireValue(revision >= highestRevision, 'FACTORY_REVISION_REGRESSED');
        const common = { factoryId, observedAt: iso(clock()), revision, buildRevision };
        if (operation === 'snapshot') return envelope(common, { snapshot: readSnapshot(db) });
        requireValue(after <= revision, 'INVALID_CURSOR', 400);
        const rows = db.prepare('SELECT seq,type,subject,observed FROM events WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?').all(after, revision, limit + 1);
        const events = rows.slice(0, limit).map(row => {
          requireValue(typeof row.type === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(row.type));
          return { seq: integer(row.seq, 1), type: row.type, subject: identifier(row.subject), observedAt: iso(row.observed) };
        });
        return envelope(common, { events, cursor: encodeCursor(events.at(-1)?.seq ?? after), latestCursor: encodeCursor(revision), hasMore: rows.length > limit });
      });
      if (operation === 'snapshot') {
        const paidBudget = readPaidBudget(spendingLedgerPath, iso(clock()), highestPaidRevision);
        payload.snapshot.paidBudget = paidBudget;
        if (paidBudget.availability === 'available') highestPaidRevision = Math.max(highestPaidRevision, paidBudget.revision);
      }
      requireValue(!JSON.stringify(payload).includes(token));
      highestRevision = Math.max(highestRevision, payload.revision);
      jsonResponse(response, 200, payload);
    } catch (error) {
      const status = error instanceof PresentationError ? error.status : 503;
      const code = error instanceof PresentationError ? error.code : 'FACTORY_STATE_UNAVAILABLE';
      jsonResponse(response, status, { error: { code } });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return server;
}

export async function startPresentationServer(options = {}) {
  const host = options.host ?? '127.0.0.1', port = options.port ?? 4343;
  requireValue(host === '127.0.0.1' && Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'PRESENTATION_BIND_INVALID', 400);
  const server = createPresentationServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}
