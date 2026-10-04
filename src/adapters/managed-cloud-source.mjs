import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createNativeWorkerReader } from '../capacity-mcp.mjs';

const nativeSources = new WeakMap();
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const sha = value => createHash('sha256').update(value).digest('hex');
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Explicit private evidence projection; unbound or copied source objects have no native identity. */
export function nativeManagedCloudSourceIdentity(source) { return nativeSources.get(source) ?? null; }

function invalid() {
  return Object.assign(new TypeError('The private managed source binding is invalid.'), {
    code: 'MANAGED_CLOUD_INPUT_INVALID',
  });
}
function check(value) { if (!value) throw invalid(); }
function closed(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function absolute(value) {
  check(typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value));
}

/** Trusted deployment configuration; dataRoot is a configured namespace, not a native API attestation. */
export function validateManagedCloudSourceProfile(value) {
  closed(value, ['schemaVersion', 'origin', 'tokenFile', 'dataRoot', 'worker']);
  check(value.schemaVersion === 1);
  let url;
  try { url = new URL(value.origin); } catch { throw invalid(); }
  check(url.origin === value.origin && ['http:', 'https:'].includes(url.protocol)
    && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/'
    && !url.username && !url.password && !url.search && !url.hash);
  absolute(value.tokenFile); absolute(value.dataRoot);
  closed(value.worker, ['workspace', 'archiveSha256', 'compatibility']);
  check(typeof value.worker.workspace === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.worker.workspace)
    && typeof value.worker.archiveSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.worker.archiveSha256));
  const c = value.worker.compatibility;
  closed(c, ['applicationVersion', 'snapshotFormatVersion', 'layoutVersion', 'workerProtocolVersion'], ['revision']);
  check(typeof c.applicationVersion === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(c.applicationVersion)
    && ['snapshotFormatVersion', 'layoutVersion', 'workerProtocolVersion'].every(key => Number.isSafeInteger(c[key]) && c[key] > 0)
    && (!Object.hasOwn(c, 'revision') || typeof c.revision === 'string' && /^[a-f0-9]{40}$/.test(c.revision)));
  return structuredClone(value);
}

export function createManagedCloudSourceBinding({ sourceWorkerProfile, privateFiles, nativeProfilePath, fetchImpl = fetch }) {
  const profile = validateManagedCloudSourceProfile(sourceWorkerProfile);
  check(typeof privateFiles?.readPrivateJson === 'function');
  const native = nativeProfilePath !== undefined;
  if (native) {
    absolute(nativeProfilePath);
    check(Object.hasOwn(profile.worker.compatibility, 'revision'));
  }
  check(typeof fetchImpl === 'function');
  const secrets = new Set();
  const originalPins = new Map();
  async function nativeRecord(filename) {
    try {
      const before = await lstat(filename, { bigint: true });
      check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= 4096n);
      // The trusted reader checks ownership/ACLs. A separately bounded descriptor
      // binds its exact bytes and generation across that awaited private read.
      const record = await privateFiles.readPrivateJson(filename, { maxBytes: 4096 });
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        const opened = await handle.stat({ bigint: true });
        const same = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every(key => stat[key] === before[key])
          && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
        check(same(opened));
        const buffer = Buffer.alloc(Number(before.size) + 1); let offset = 0;
        while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        check(offset === Number(before.size)); bytes = buffer.subarray(0, offset);
        check(same(await handle.stat({ bigint: true })) && same(await lstat(filename, { bigint: true })));
        check(canonical(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) === canonical(record));
      } finally { await handle.close(); }
      const pin = freeze({ filename: path.resolve(filename), bytes: bytes.length, sha256: sha(bytes),
        dev: String(before.dev), ino: String(before.ino), birthtimeNs: String(before.birthtimeNs),
        mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) });
      if (originalPins.has(filename)) check(canonical(originalPins.get(filename)) === canonical(pin));
      else originalPins.set(filename, pin);
      return { record, pin };
    } catch { throw invalid(); }
  }
  async function token() {
    let record;
    let pin;
    try {
      if (native) ({ record, pin } = await nativeRecord(profile.tokenFile));
      else record = await privateFiles.readPrivateJson(profile.tokenFile, { maxBytes: 4096 });
    }
    catch { throw invalid(); }
    if (typeof record?.token === 'string' && record.token.length >= 8) secrets.add(record.token);
    closed(record, ['token']);
    check(typeof record.token === 'string' && /^[A-Za-z0-9._~+/=-]{32,2048}$/.test(record.token));
    return { credential: record.token, pin };
  }
  function input(value) {
    // This check is synchronous and precedes source reads or any service invocation.
    check(value.workspace === profile.worker.workspace
      && (value.source === undefined || value.source === profile.origin));
    return { ...value, source: profile.origin };
  }
  async function discover({ source, fetchImpl: transport = fetchImpl } = {}) {
    check(source === undefined || source === profile.origin);
    check(typeof transport === 'function');
    let profilePin;
    if (native) {
      const current = await nativeRecord(nativeProfilePath);
      check(canonical(validateManagedCloudSourceProfile(current.record)) === canonical(profile));
      profilePin = current.pin;
    }
    const { credential, pin: credentialPin } = await token();
    const infoUrl = profile.origin + '/api/snapshot/info?workspace=' + encodeURIComponent(profile.worker.workspace);
    const reader = createNativeWorkerReader({ origin: profile.origin, token: credential, ...profile.worker,
      async fetchImpl(url, options) {
        const response = await transport(url, options);
        if (url !== infoUrl || !response.ok) return response;
        // Validate the very same authenticated response the existing Reader uses for compatibility.
        const chunks = []; let bytes = 0;
        try {
          check(Number(response.headers.get('content-length')) <= 65536);
          for await (const chunk of response.body ?? []) {
            bytes += chunk.length; check(bytes <= 65536); chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
          check(info?.workspace === profile.worker.workspace && info.capability === 'available' && info.activeOperation === null);
          return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } });
        } catch {
          await response.body?.cancel().catch(() => undefined);
          throw invalid();
        }
      },
    });
    const worker = await reader.read();
    const result = { source: profile.origin, dataRoot: profile.dataRoot };
    Object.defineProperty(result, 'token', { value: credential, enumerable: false });
    if (native) {
      const identity = freeze({ kind: 'native-worker', schemaVersion: 1, origin: profile.origin,
        dataRoot: profile.dataRoot, worker, profile: profilePin, credential: credentialPin });
      nativeSources.set(result, identity);
      Object.defineProperty(result, 'nativeIdentity', { value: identity, enumerable: false });
    }
    // No desktop instance ID or PID is fabricated for a container source.
    return [Object.freeze(result)];
  }
  return Object.freeze({
    input, discover,
    // Saved deployment operations must remain possible when this source is absent.
    async refreshSecrets() { try { await token(); } catch { /* No source readiness dependency. */ } },
    secrets() { return [...secrets]; },
  });
}
