import path from 'node:path';
import { constants, lstatSync, openSync, fstatSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCOPE = 'registered-modal-operation-journals';
const MAX_RUNS = 16;
const MAX_ROWS = 1000;
const MAX_DB_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY = /^[a-z0-9_-]{1,80}$/;
const SHA = /^[a-f0-9]{64}$/;
const SUCCESS = Object.freeze({
  'create-volume': 'volume-created', deploy: 'deployed', prefetch: 'weights-cached',
  'create-proxy-token': 'proxy-token-created', 'direct-generation': 'generation-completed',
  'create-flujo-model': 'model-connected', 'create-flujo-flow': 'flow-connected',
  'flujo-generation': 'generation-completed', 'disable-flujo-model': 'model-disabled',
  'delete-proxy-token': 'proxy-token-deleted', 'stop-app': 'stopped',
  'delete-volume': 'volume-deleted', 'delete-flujo-flow': 'flow-removed', 'delete-flujo-model': 'model-removed',
});
const TRANSITIONS = Object.freeze({
  accepted: ['accepted', 'running', 'unknown', 'succeeded'],
  running: ['running', 'unknown', 'succeeded'], unknown: ['unknown', 'succeeded'], succeeded: ['succeeded'],
});
const FIELDS = Object.freeze(['state', 'appId', 'volumeId', 'serveFunctionId', 'prefetchFunctionId',
  'volumeFsVersion', 'runningContainers', 'observedAt', 'alreadyStopped',
  'elapsedMs', 'promptTokens', 'completionTokens', 'totalTokens', 'status']);
const OUTCOME_FIELDS = Object.freeze({
  'create-volume': ['volumeId', 'volumeFsVersion'], deploy: ['appId', 'serveFunctionId', 'prefetchFunctionId'],
  prefetch: ['volumeId', 'volumeFsVersion'], 'create-proxy-token': [],
  'direct-generation': ['promptTokens', 'completionTokens', 'totalTokens'],
  'flujo-generation': ['promptTokens', 'completionTokens', 'totalTokens'],
  'create-flujo-model': ['status'], 'create-flujo-flow': ['status'], 'disable-flujo-model': ['status'],
  'delete-flujo-model': ['status'], 'delete-flujo-flow': ['status'], 'delete-proxy-token': [],
  'stop-app': ['appId', 'volumeId', 'runningContainers', 'observedAt', 'alreadyStopped'],
  'delete-volume': ['volumeId'],
});
const SCHEMA = `CREATE TABLE modal_operations(key TEXT PRIMARY KEY, operation TEXT NOT NULL,
  request_digest TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL,
  result_json TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`;
const COLUMNS = [
  ['key', 'TEXT', 0, 1], ['operation', 'TEXT', 1, 0], ['request_digest', 'TEXT', 1, 0],
  ['request_json', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['result_json', 'TEXT', 0, 0],
  ['created', 'INTEGER', 1, 0], ['updated', 'INTEGER', 1, 0],
];

function requireValue(value) { if (!value) throw new Error('MODAL_JOURNAL_UNAVAILABLE'); }
function inputError(code) {
  return Object.assign(new Error('Modal journal observation input is invalid.'), { code, status: 400 });
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function integer(value, minimum = 0) { requireValue(Number.isSafeInteger(value) && value >= minimum); return value; }
function timestamp(value) {
  integer(value);
  const date = new Date(value);
  requireValue(Number.isFinite(date.getTime()));
  return date.toISOString();
}
function iso(value) {
  requireValue(typeof value === 'string' && value.length <= 40);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  requireValue(parts);
  const offset = parts[8] === 'Z' ? 0 : Number(parts[8].slice(1, 3)) * 60 + Number(parts[8].slice(4, 6));
  requireValue(parts[8] === 'Z' || (Number(parts[8].slice(1, 3)) <= 23 && Number(parts[8].slice(4, 6)) <= 59));
  const parsed = Date.parse(value);
  requireValue(Number.isFinite(parsed));
  const local = new Date(parsed + (parts[8][0] === '-' ? -offset : offset) * 60_000);
  const actual = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()];
  const expected = parts.slice(1, 7).map(Number).concat(Number((parts[7] ?? '').padEnd(3, '0')));
  requireValue(actual.every((part, index) => part === expected[index]));
  return new Date(parsed).toISOString();
}
function boundedJsonObject(raw) {
  requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_JSON_BYTES);
  const value = JSON.parse(raw);
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  let nodes = 0;
  function inspect(item, depth) {
    requireValue(++nodes <= 10_000 && depth <= 32);
    if (typeof item === 'number') requireValue(Number.isFinite(item));
    if (item && typeof item === 'object') for (const child of Object.values(item)) inspect(child, depth + 1);
  }
  inspect(value, 0);
  return value;
}
function configuration(input) {
  requireValue(Array.isArray(input) && input.length <= MAX_RUNS);
  const ids = new Set(), paths = new Set();
  return Array.from({ length: input.length }, (_, index) => {
    const entryDescriptor = Object.getOwnPropertyDescriptor(input, String(index));
    requireValue(entryDescriptor && Object.hasOwn(entryDescriptor, 'value'));
    const entry = entryDescriptor.value;
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry)
      && [Object.prototype, null].includes(Object.getPrototypeOf(entry)));
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
    requireValue(keys.length === 2 && keys.includes('runId') && keys.includes('journalPath')
      && keys.every(key => Object.hasOwn(descriptors[key], 'value')));
    const { runId: { value: runId }, journalPath: { value: journalPath } } = descriptors;
    requireValue(typeof runId === 'string' && RUN_ID.test(runId) && !ids.has(runId));
    requireValue(typeof journalPath === 'string' && journalPath.length <= 4096 && !journalPath.includes('\0') && path.isAbsolute(journalPath));
    if (process.platform === 'win32') requireValue(/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(journalPath));
    const absolute = path.resolve(journalPath), identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    requireValue(!paths.has(identity));
    ids.add(runId); paths.add(identity);
    return Object.freeze({ runId, journalPath: absolute });
  });
}
function safeFile(filename, optional = false) {
  let file;
  try { file = lstatSync(filename); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  requireValue(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.size <= MAX_DB_BYTES);
  return file;
}
function sameFile(first, second) { requireValue(first.dev === second.dev && first.ino === second.ino); }
function validateSchema(db) {
  requireValue(db.prepare('PRAGMA user_version').get().user_version === 0);
  const objects = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name LIMIT 4').all();
  requireValue(objects.length === 2);
  const table = objects.find(row => row.type === 'table' && row.name === 'modal_operations');
  const index = objects.find(row => row.type === 'index' && row.name === 'sqlite_autoindex_modal_operations_1');
  requireValue(table && index && index.tbl_name === 'modal_operations' && index.sql === null
    && typeof table.sql === 'string' && table.sql.replace(/\s/g, '').toLowerCase() === SCHEMA.replace(/\s/g, '').toLowerCase());
  const columns = db.prepare('PRAGMA table_xinfo(modal_operations)').all();
  requireValue(columns.length === COLUMNS.length && columns.every((column, at) => {
    const [name, type, notnull, pk] = COLUMNS[at];
    return column.cid === at && column.name === name && column.type === type && column.notnull === notnull
      && column.pk === pk && column.dflt_value === null && column.hidden === 0;
  }));
  const bytes = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
  requireValue(Number.isSafeInteger(bytes) && bytes <= MAX_DB_BYTES);
}
function outcome(row, operation, state) {
  if (row.result_bytes === null) return null;
  requireValue(row.result_valid === 1 && row.result_type === 'object');
  requireValue(row.state_type === 'text');
  if (state === 'unknown') {
    requireValue(row.state_value === 'unknown');
    return { state: 'unknown' };
  }
  const result = {};
  for (const field of FIELDS) {
    if (field !== 'state' && field !== 'elapsedMs' && !OUTCOME_FIELDS[operation].includes(field)) continue;
    const type = row[`${field}_type`], value = row[`${field}_value`];
    if (type === null) continue;
    if (field === 'state') {
      requireValue(type === 'text' && value === (state === 'unknown' ? 'unknown' : SUCCESS[operation]));
      result[field] = value;
    } else if (['appId', 'volumeId', 'serveFunctionId', 'prefetchFunctionId'].includes(field)) {
      const prefix = field === 'appId' ? 'ap' : field === 'volumeId' ? 'vo' : 'fu';
      requireValue(type === 'text' && typeof value === 'string' && new RegExp(`^${prefix}-[A-Za-z0-9]{1,64}$`).test(value));
      result[field] = value;
    } else if (field === 'alreadyStopped') {
      requireValue(type === 'true' || type === 'false'); result[field] = type === 'true';
    } else if (field === 'observedAt') {
      requireValue(type === 'integer' || type === 'text'); result[field] = type === 'integer' ? timestamp(value) : iso(value);
    } else {
      requireValue(type === 'integer');
      result[field] = integer(value, field === 'volumeFsVersion' ? 1 : 0);
      if (field === 'volumeFsVersion') requireValue(value === 1 || value === 2);
      if (field === 'status') requireValue(value >= 100 && value <= 599);
    }
  }
  if (['promptTokens', 'completionTokens', 'totalTokens'].every(field => Object.hasOwn(result, field))) {
    requireValue(Number.isSafeInteger(result.promptTokens + result.completionTokens)
      && result.totalTokens === result.promptTokens + result.completionTokens);
  }
  return Object.keys(result).length ? result : null;
}
function readRun(entry, previous) {
  let db, descriptor;
  try {
    const before = safeFile(entry.journalPath);
    const wal = safeFile(`${entry.journalPath}-wal`, true);
    safeFile(`${entry.journalPath}-shm`, true);
    requireValue(before.size + (wal?.size ?? 0) <= MAX_DB_BYTES);
    descriptor = openSync(entry.journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    sameFile(before, fstatSync(descriptor));
    db = new DatabaseSync(entry.journalPath, { readOnly: true });
    sameFile(before, safeFile(entry.journalPath));
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=200; BEGIN;');
    validateSchema(db);
    // Bound private requests/results before parsing; raw result hashes never leave the reader.
    const rows = db.prepare(`SELECT key,operation,request_digest,state,created,updated,
      typeof(request_json) AS request_storage,length(CAST(request_json AS BLOB)) AS request_bytes,
      typeof(result_json) AS result_storage,length(CAST(result_json AS BLOB)) AS result_bytes
      FROM modal_operations ORDER BY created,key LIMIT ?`).all(MAX_ROWS + 1);
    requireValue(rows.length <= MAX_ROWS);
    const seenOperations = new Set();
    for (const row of rows) {
      requireValue(typeof row.key === 'string' && KEY.test(row.key) && Object.hasOwn(SUCCESS, row.operation)
        && Object.hasOwn(TRANSITIONS, row.state) && typeof row.request_digest === 'string' && SHA.test(row.request_digest));
      requireValue(!seenOperations.has(row.operation)); seenOperations.add(row.operation);
      timestamp(row.created); timestamp(row.updated); requireValue(row.updated >= row.created);
      requireValue(row.request_storage === 'text' && row.request_bytes <= MAX_JSON_BYTES
        && (row.result_storage === 'null' || (row.result_storage === 'text' && row.result_bytes <= MAX_JSON_BYTES)));
      requireValue(!['accepted', 'running'].includes(row.state) || row.result_storage === 'null');
      requireValue(!['unknown', 'succeeded'].includes(row.state) || row.result_storage === 'text');
    }
    // Requests bind the registered run; settled raw result hashes stay private for immutability checks.
    const requests = db.prepare('SELECT key,request_json,result_json FROM modal_operations ORDER BY created,key LIMIT ?').all(MAX_ROWS + 1);
    requireValue(requests.length === rows.length);
    for (let at = 0; at < requests.length; at++) {
      const request = boundedJsonObject(requests[at].request_json), row = rows[at];
      requireValue(requests[at].key === row.key && request.runId === entry.runId && request.operation === row.operation
        && sha(canonical(request)) === row.request_digest);
      if (requests[at].result_json !== null) boundedJsonObject(requests[at].result_json);
    }
    const extraction = FIELDS.map(field => `json_type(result_json,'$.${field}') AS ${field}_type,json_extract(result_json,'$.${field}') AS ${field}_value`).join(',');
    const results = db.prepare(`SELECT key,length(CAST(result_json AS BLOB)) AS result_bytes,
      json_valid(result_json) AS result_valid,json_type(result_json) AS result_type,${extraction}
      FROM modal_operations ORDER BY created,key LIMIT ?`).all(MAX_ROWS + 1);
    requireValue(results.length === rows.length);
    const identity = new Map();
    const operations = rows.map((row, index) => {
      requireValue(results[index].key === row.key);
      const old = previous?.get(row.key);
      const rawResultDigest = requests[index].result_json === null ? null : sha(requests[index].result_json);
      if (old) requireValue(old.operation === row.operation && old.requestDigest === row.request_digest && old.created === row.created
        && row.updated >= old.updated && TRANSITIONS[old.state].includes(row.state));
      if (old && ['unknown', 'succeeded'].includes(old.state) && old.state === row.state) {
        requireValue(row.updated === old.updated && rawResultDigest === old.rawResultDigest);
      }
      identity.set(row.key, { operation: row.operation, requestDigest: row.request_digest, rawResultDigest,
        state: row.state, created: row.created, updated: row.updated });
      return { key: row.key, operation: row.operation, state: row.state, createdAt: timestamp(row.created), updatedAt: timestamp(row.updated),
        outcome: outcome(results[index], row.operation, row.state) };
    });
    if (previous) requireValue([...previous.keys()].every(key => identity.has(key)));
    db.exec('COMMIT;');
    sameFile(before, safeFile(entry.journalPath));
    return { identity, projection: { runId: entry.runId, availability: 'available', journalRevision: sha(JSON.stringify(operations)), operations } };
  } finally {
    try { db?.close(); } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
}

/** Local persisted receipts only; content hashes have no numeric or causal ordering. */
export function createModalObservationReader(modalJournals = []) {
  let entries;
  try { entries = configuration(modalJournals); } catch { throw inputError('MODAL_JOURNAL_CONFIG_INVALID'); }
  const previous = new Map();
  return function read(observedAt) {
    let time;
    try { time = iso(observedAt); } catch { throw inputError('MODAL_JOURNAL_OBSERVATION_INVALID'); }
    const runs = entries.map(entry => {
      try {
        const result = readRun(entry, previous.get(entry.runId));
        previous.set(entry.runId, result.identity);
        return result.projection;
      } catch { return { runId: entry.runId, availability: 'unavailable', reason: 'MODAL_JOURNAL_UNAVAILABLE' }; }
    });
    return { availability: entries.length ? 'available' : 'not_configured', scope: SCOPE,
      basis: 'persisted-local-operation-journal', providerFreshness: 'not_observed', revisionKind: 'content-sha256', observedAt: time, runs };
  };
}
