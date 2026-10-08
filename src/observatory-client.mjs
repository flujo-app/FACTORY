import { validateViewerToken } from './presentation.mjs';

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
  return Object.freeze({
    async snapshot() {
      const response = await fetchImpl(url.href, {
        method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`FACTORY snapshot unavailable (HTTP ${response.status})`);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 2_000_000) {
          throw new Error('FACTORY snapshot exceeds size limit');
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let value;
      try { value = JSON.parse(body); } catch { throw new Error('FACTORY snapshot is invalid JSON'); }
      if (!validSnapshot(value, expectedFactoryId)) throw new Error('FACTORY snapshot identity or schema is invalid');
      return value;
    },
  });
}

function validSnapshot(value, expectedFactoryId) {
  if (!value || value.schemaVersion !== 1 || value.factoryId !== expectedFactoryId
    || value.scope !== 'local-coordinator' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isFinite(Date.parse(value.observedAt)) || value.capabilities?.snapshot !== true
    || value.capabilities?.commands !== false || !value.snapshot || typeof value.snapshot !== 'object') return false;
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
