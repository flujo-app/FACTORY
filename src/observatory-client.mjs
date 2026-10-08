import { decodeCursor, validateViewerToken } from './presentation.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const STATUSES = new Set(['reserved', 'ready', 'retired']);

/** Read one local FACTORY authority for a server-side Observatory integration. */
export function createObservatoryClient({ snapshotUrl, token, expectedFactoryId, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (typeof expectedFactoryId !== 'string' || !ID.test(expectedFactoryId)) throw new TypeError('expectedFactoryId is invalid');
  validateViewerToken(token);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('timeoutMs is invalid');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  let url;
  try { url = new URL(snapshotUrl); } catch { throw new TypeError('snapshotUrl is invalid'); }
  const expectedPath = `/v1/factories/${expectedFactoryId}/snapshot`;
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.search || url.hash || !['/v1/snapshot', expectedPath].includes(url.pathname)) {
    throw new TypeError('snapshotUrl must name a local FACTORY snapshot endpoint');
  }
  async function read(endpoint, operation) {
    const response = await fetchImpl(endpoint.href, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`FACTORY ${operation} unavailable (HTTP ${response.status})`);
    if (!response.body) throw new Error(`FACTORY ${operation} has no body`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 2_000_000) throw new Error(`FACTORY ${operation} exceeds size limit`);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error(`FACTORY ${operation} is invalid JSON`); }
  }
  return Object.freeze({
    async snapshot() {
      const value = await read(url, 'snapshot');
      if (!validSnapshot(value, expectedFactoryId)) throw new Error('FACTORY snapshot identity or schema is invalid');
      return value;
    },
    async events({ after, limit = 100 } = {}) {
      if (typeof after !== 'string') throw new TypeError('after must be a FACTORY cursor');
      let afterSeq;
      try { afterSeq = decodeCursor(after); } catch { throw new TypeError('after must be a FACTORY cursor'); }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be between 1 and 500');
      const endpoint = new URL(url.href);
      endpoint.pathname = endpoint.pathname.replace(/\/snapshot$/, '/events');
      endpoint.searchParams.set('after', after);
      endpoint.searchParams.set('limit', String(limit));
      const value = await read(endpoint, 'events');
      if (!validEvents(value, expectedFactoryId, afterSeq, limit)) throw new Error('FACTORY events identity or schema is invalid');
      return value;
    },
  });
}

function validEnvelope(value, expectedFactoryId) {
  return value && value.schemaVersion === 1 && value.factoryId === expectedFactoryId
    && value.scope === 'local-coordinator' && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))
    && value.capabilities?.snapshot === true && value.capabilities?.events === true
    && value.capabilities?.commands === false;
}

function validSnapshot(value, expectedFactoryId) {
  if (!validEnvelope(value, expectedFactoryId) || !value.snapshot || typeof value.snapshot !== 'object') return false;
  try { if (decodeCursor(value.cursor) !== value.revision) return false; }
  catch { return false; }
  const { control, cells, tasks, effects, budget } = value.snapshot;
  if (!control || typeof control.mission !== 'string' || !['active', 'paused'].includes(control.status)
    || !Array.isArray(cells) || !Array.isArray(tasks) || !Array.isArray(effects) || !budget) return false;
  const ids = new Map();
  for (const cell of cells) {
    if (!cell || typeof cell.id !== 'string' || !ID.test(cell.id) || ids.has(cell.id)
      || !STATUSES.has(cell.status) || !Number.isSafeInteger(cell.depth) || cell.depth < 0
      || (cell.parentId !== null && (typeof cell.parentId !== 'string' || !ID.test(cell.parentId)))) return false;
    ids.set(cell.id, cell);
  }
  if (!ids.has('root')) return false;
  for (const cell of cells) {
    if (cell.id === 'root' ? cell.parentId !== null || cell.depth !== 0
      : !ids.has(cell.parentId) || cell.parentId === cell.id || cell.depth !== ids.get(cell.parentId).depth + 1) return false;
  }
  return true;
}

function validEvents(value, expectedFactoryId, afterSeq, limit) {
  if (!validEnvelope(value, expectedFactoryId) || !Array.isArray(value.events) || value.events.length > limit
    || typeof value.hasMore !== 'boolean' || (value.hasMore && value.events.length !== limit)) return false;
  let cursor, latestCursor;
  try { cursor = decodeCursor(value.cursor); latestCursor = decodeCursor(value.latestCursor); }
  catch { return false; }
  if (latestCursor !== value.revision || cursor < afterSeq || cursor > latestCursor) return false;
  let lastSeq = afterSeq;
  for (const event of value.events) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq <= lastSeq || event.seq > value.revision
      || typeof event.type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(event.type)
      || typeof event.subject !== 'string' || !ID.test(event.subject)
      || typeof event.observedAt !== 'string' || !Number.isFinite(Date.parse(event.observedAt))) return false;
    lastSeq = event.seq;
  }
  return cursor === lastSeq;
}
