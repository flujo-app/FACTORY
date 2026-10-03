import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const MAX_BYTES = 64 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EMPTY = Object.freeze([]);

export class ModalJournalConfigError extends Error {
  constructor(code = 'MODAL_JOURNALS_CONFIG_INVALID') {
    super('Modal journal configuration is unavailable.');
    this.code = code;
  }
}

function requireValue(condition, code = 'MODAL_JOURNALS_CONFIG_INVALID') {
  if (!condition) throw new ModalJournalConfigError(code);
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function absolutePath(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) return false;
  // Windows root-relative paths depend on the current drive despite isAbsolute.
  return process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(value);
}

export function parseModalJournalConfig(value) {
  requireValue(exactObject(value, ['schemaVersion', 'journals']) && value.schemaVersion === 1
    && Array.isArray(value.journals) && value.journals.length <= 16);
  const runIds = new Set(), paths = new Set();
  const entries = value.journals.map(entry => {
    requireValue(exactObject(entry, ['runId', 'journalPath']) && typeof entry.runId === 'string'
      && RUN_ID.test(entry.runId) && absolutePath(entry.journalPath));
    const journalPath = path.normalize(entry.journalPath);
    const identity = process.platform === 'win32' ? journalPath.toLowerCase() : journalPath;
    requireValue(!runIds.has(entry.runId) && !paths.has(identity));
    runIds.add(entry.runId); paths.add(identity);
    return Object.freeze({ runId: entry.runId, journalPath });
  });
  return Object.freeze(entries);
}

// Same SID/Allow-only assurance as loadViewerToken; keep it independent of the
// presentation module so CLI configuration cannot cause a presentation cycle.
const windowsPrivateCheck = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $p = [Environment]::GetEnvironmentVariable('FACTORY_MODAL_JOURNAL_CONFIG')
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

async function privateFile(file, stat) {
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
    && stat.size >= 0n && stat.size <= BigInt(MAX_BYTES), 'MODAL_JOURNALS_CONFIG_UNSAFE');
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const { stdout } = await runFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsPrivateCheck, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15_000, maxBuffer: 1024,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, FACTORY_MODAL_JOURNAL_CONFIG: file } })
      .catch(() => { throw new ModalJournalConfigError('MODAL_JOURNALS_CONFIG_UNSAFE'); });
    requireValue(stdout === 'private', 'MODAL_JOURNALS_CONFIG_UNSAFE');
  } else {
    requireValue(stat.uid === BigInt(process.getuid()) && (stat.mode & 0o077n) === 0n,
      'MODAL_JOURNALS_CONFIG_UNSAFE');
  }
}

function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].every(key => left[key] === right[key]);
}

/** Read only an explicit owner-private config; journal files are not opened here. */
export async function loadModalJournalConfig(configFile) {
  if (configFile === undefined) return EMPTY;
  requireValue(absolutePath(configFile));
  let handle;
  try {
    const before = await fs.lstat(configFile, { bigint: true });
    await privateFile(configFile, before);
    handle = await fs.open(configFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat({ bigint: true });
    requireValue(sameFile(before, opened), 'MODAL_JOURNALS_CONFIG_UNSAFE');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    requireValue(size <= MAX_BYTES && BigInt(size) === opened.size && sameFile(opened, after),
      'MODAL_JOURNALS_CONFIG_UNSAFE');
    const namedAfter = await fs.lstat(configFile, { bigint: true });
    requireValue(sameFile(after, namedAfter), 'MODAL_JOURNALS_CONFIG_UNSAFE');
    await privateFile(configFile, namedAfter);
    requireValue(sameFile(namedAfter, await fs.lstat(configFile, { bigint: true })), 'MODAL_JOURNALS_CONFIG_UNSAFE');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    return parseModalJournalConfig(JSON.parse(content));
  } catch (error) {
    if (error instanceof ModalJournalConfigError) throw error;
    throw new ModalJournalConfigError('MODAL_JOURNALS_CONFIG_UNAVAILABLE');
  } finally {
    try { await handle?.close(); } catch { throw new ModalJournalConfigError('MODAL_JOURNALS_CONFIG_UNAVAILABLE'); }
  }
}
