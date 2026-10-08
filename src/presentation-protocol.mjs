export class PresentationError extends Error {
  constructor(code, status = 503) { super('Factory presentation state is unavailable.'); this.code = code; this.status = status; }
}

export function requireValue(condition, code = 'FACTORY_STATE_UNAVAILABLE', status = 503) {
  if (!condition) throw new PresentationError(code, status);
}

export function integer(value, minimum = 0) {
  requireValue(Number.isSafeInteger(value) && value >= minimum);
  return value;
}

export function validateViewerToken(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value)
    && new Set(value).size >= 8, 'VIEWER_TOKEN_INVALID', 400);
  return value;
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
