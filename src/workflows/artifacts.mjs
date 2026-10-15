import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, lstatSync, realpathSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value, ancestors = new Set()) {
  if (value === null || ['string','boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value) || Object.getOwnPropertySymbols(value).length
    || !Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new TypeError('Artifacts require an acyclic JSON-compatible value.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values=[]; for(let index=0;index<value.length;index++) { if (!Object.hasOwn(value,index)) throw new TypeError('Sparse JSON arrays are not supported.'); values.push(canonical(value[index],ancestors)); }
      return '[' + values.join(',') + ']';
    }
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key],ancestors)).join(',') + '}';
  } finally { ancestors.delete(value); }
}
export const contentDigest = value => sha256(canonical(value));

/** Immutable bytes travel independently of machine-local filenames. No implicit uploads. */
export class FactoryArtifactStore {
  constructor(directory) {
    if (!isAbsolute(directory ?? '')) throw new TypeError('Artifact directory must be absolute.');
    this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.directory = realpathSync(this.directory);
  }
  path(ref) {
    if (!/^sha256:[a-f0-9]{64}$/.test(ref ?? '')) throw new TypeError('Invalid artifact reference.');
    return resolve(this.directory, ref.slice(7));
  }
  put(bytes) {
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const ref = 'sha256:' + sha256(bytes), path = this.path(ref);
    if(!existsSync(path)) {
      const temporary=resolve(this.directory,`.pending-${randomUUID()}`);
      let fd;
      try {
        fd=openSync(temporary,'wx',0o600); writeFileSync(fd,bytes); fsyncSync(fd); closeSync(fd); fd=undefined;
        // Hard-link admission is atomic and cannot overwrite an existing digest.
        try { linkSync(temporary,path); } catch(error) { if(error.code!=='EEXIST') throw error; }
      } finally { if(fd!==undefined)closeSync(fd); if(existsSync(temporary))unlinkSync(temporary); }
    }
    if (!this.get(ref).equals(bytes)) throw new Error('Artifact hash collision or corrupted storage.');
    return { ref, size: bytes.length };
  }
  putJSON(value) { return this.put(canonical(value)); }
  importFile(path) { return this.put(readFileSync(path)); }
  get(ref) {
    const path = this.path(ref), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Artifact references must resolve to regular owned files.');
    const bytes = readFileSync(path);
    if ('sha256:' + sha256(bytes) !== ref) throw new Error('Artifact bytes no longer match their reference.');
    return bytes;
  }
  getJSON(ref) { return JSON.parse(this.get(ref).toString('utf8')); }
  describe(ref) { const bytes = this.get(ref); return { ref, size: bytes.length }; }
  readChunk(ref, { offset = 0, length = 256 * 1024 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 256 * 1024) throw new TypeError('Invalid artifact range.');
    const bytes = this.get(ref);
    if (offset > bytes.length) throw new TypeError('Artifact offset exceeds its size.');
    return { ref, offset, size: bytes.length, data: bytes.subarray(offset, offset + length).toString('base64'), done: offset + length >= bytes.length };
  }
}
