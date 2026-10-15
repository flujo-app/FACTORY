import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export const contentDigest = value => sha256(canonical(value));

/** Immutable bytes travel independently of machine-local filenames. No implicit uploads. */
export class FactoryArtifactStore {
  constructor(directory) {
    if (!isAbsolute(directory ?? '')) throw new TypeError('Artifact directory must be absolute.');
    this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  path(ref) {
    if (!/^sha256:[a-f0-9]{64}$/.test(ref ?? '')) throw new TypeError('Invalid artifact reference.');
    return resolve(this.directory, ref.slice(7));
  }
  put(bytes) {
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const ref = 'sha256:' + sha256(bytes), path = this.path(ref);
    let fd;
    try { fd = openSync(path, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    if (!this.get(ref).equals(bytes)) throw new Error('Artifact hash collision or corrupted storage.');
    return { ref, size: bytes.length };
  }
  putJSON(value) { return this.put(canonical(value)); }
  importFile(path) { return this.put(readFileSync(path)); }
  get(ref) {
    const bytes = readFileSync(this.path(ref));
    if ('sha256:' + sha256(bytes) !== ref) throw new Error('Artifact bytes no longer match their reference.');
    return bytes;
  }
  getJSON(ref) { return JSON.parse(this.get(ref).toString('utf8')); }
  describe(ref) { const bytes = this.get(ref); return { ref, size: bytes.length }; }
  readChunk(ref, { offset = 0, length = 256 * 1024 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 256 * 1024) throw new TypeError('Invalid artifact range.');
    const bytes = this.get(ref);
    return { ref, offset, size: bytes.length, data: bytes.subarray(offset, offset + length).toString('base64'), done: offset + length >= bytes.length };
  }
}
