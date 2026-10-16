import { readdirSync, statSync, lstatSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, openSync, readSync, closeSync, truncateSync, readlinkSync, symlinkSync, createReadStream, linkSync, chmodSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep, toNamespacedPath } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';

/** A private evidence snapshot; native histories may contain confidential source. */
export async function collectCloudLiteSnapshot({ root = '/data', runId, destination = join(root, `.factory-export-${runId}-${randomBytes(6).toString('hex')}`), includeGitObjects = true }) {
  if (typeof includeGitObjects !== 'boolean') throw new Error('Select whether to include Git object stores.');
  if (!isAbsolute(root) || !/^[a-z0-9-]{3,64}$/.test(runId ?? '') || !resolve(destination).startsWith(resolve(root) + sep)) throw new Error('Select an owned data root and run identity.');
  mkdirSync(destination, { mode: 0o700 });
  const output = join(destination, 'snapshot'); mkdirSync(output, { recursive: true, mode: 0o700 });
  const manifest = { runId, includeGitObjects, startedAt: new Date().toISOString(), files: [], omitted: [], changedDuringCopy: [], sqliteBackups: [] };
  const excluded = new Set(['node_modules', '.next', '.npm', '.cache', '__pycache__', '.pytest_cache', 'auth.json', 'lost+found']);
  const digest = async file => { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); };
  const identicalFiles = new Map(); let hardLinkedFiles = 0;
  async function visit(source) {
    const name = relative(root, source); const target = join(output, name); const details = lstatSync(source);
    if (!includeGitObjects && /(?:^|[\\/])\.git[\\/]objects(?:[\\/]|$)/.test(name)) { manifest.omitted.push(name); return; }
    if (excluded.has(source.split(/[\\/]/).at(-1)) || name.split(/[\\/]/).some(part => part.startsWith('.factory-export-') || /(?:^|-)npm-cache$/.test(part)) || /^factory-artifacts.*\.tgz$/.test(name) || /(?:-wal|-shm)$/.test(name)) { manifest.omitted.push(name); return; }
    if (details.isSymbolicLink()) {
      const link = readlinkSync(source); const resolved = resolve(source, '..', link);
      if (!resolved.startsWith(resolve(root) + sep)) { manifest.omitted.push(name); return; }
      // Absolute internal targets (including Windows junctions) must not point
      // back to the original machine after the archive is relocated.
      const portable = relative(resolve(target,'..'),join(output,relative(root,resolved)));
      mkdirSync(resolve(target, '..'), { recursive: true }); symlinkSync(portable, target, statSync(resolved).isDirectory()?'dir':'file'); return;
    }
    if (details.isDirectory()) { mkdirSync(target, { recursive: true, mode: 0o700 }); for (const child of readdirSync(source).sort()) await visit(join(source, child)); return; }
    if (!details.isFile()) { manifest.omitted.push(name); return; }
    mkdirSync(resolve(target, '..'), { recursive: true });
    const fd = openSync(source, 'r'); const header = Buffer.alloc(16); try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
    if (header.toString() === 'SQLite format 3\0') {
      // SQLite's Windows VFS needs the extended path form for deep snapshot destinations.
      const database = new DatabaseSync(toNamespacedPath(source), { readOnly: true });
      try { await backup(database, toNamespacedPath(target)); } finally { database.close(); }
      manifest.sqliteBackups.push(name);
    } else {
      let identical;
      if (!name.endsWith('.jsonl')) {
        const sourceDigest = await digest(source); const observed = statSync(source);
        if (observed.size === details.size && observed.mtimeMs === details.mtimeMs) identical = identicalFiles.get(`${sourceDigest}:${details.mode & 0o777}:${details.size}`);
      }
      if (identical) { linkSync(identical, target); hardLinkedFiles++; }
      else { copyFileSync(source, target); chmodSync(target, details.mode & 0o777); }
      // A capture of a live JSONL file ends at a complete record. Original bytes
      // remain on the volume until collection has been verified and retired.
      if (name.endsWith('.jsonl')) {
        const size = statSync(target).size; const tail = Buffer.alloc(Math.min(size, 1024 * 1024)); const handle = openSync(target, 'r');
        try { readSync(handle, tail, 0, tail.length, size - tail.length); } finally { closeSync(handle); }
        if (size && tail.at(-1) !== 10) {
          const newline = tail.lastIndexOf(10); if (newline < 0) throw new Error(`No complete JSONL boundary in ${name}.`);
          const fragment = tail.subarray(newline + 1); const preserved = `${target}.preserved-tail-${randomBytes(12).toString('hex')}.raw`;
          writeFileSync(preserved, fragment, { mode: 0o600, flag: 'wx' });
          manifest.files.push({ path: relative(output, preserved), bytes: fragment.length, sha256: await digest(preserved), preservedFrom: name });
          truncateSync(target, size - tail.length + newline + 1);
        }
      }
    }
    const after = statSync(source); if (after.size !== details.size || after.mtimeMs !== details.mtimeMs) manifest.changedDuringCopy.push(name);
    const captured = { path: name, bytes: statSync(target).size, sha256: await digest(target) };
    manifest.files.push(captured); identicalFiles.set(`${captured.sha256}:${details.mode & 0o777}:${captured.bytes}`, target);
  }
  for (const child of readdirSync(root).sort()) await visit(join(root, child));
  manifest.finishedAt = new Date().toISOString(); writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const archive = join(root, `factory-artifacts-${runId}-${randomBytes(12).toString('hex')}.tgz`);
  const packed = spawnSync('tar', ['-czf', archive, '-C', destination, 'snapshot', 'manifest.json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (packed.status !== 0) throw new Error(`Evidence archive failed (${packed.status}): ${(packed.error?.message ?? packed.stderr ?? '').slice(0,1000)}`);
  return { archive, sha256: await digest(archive), bytes: statSync(archive).size, files: manifest.files.length, hardLinkedFiles, sqliteBackups: manifest.sqliteBackups.length, changedDuringCopy: manifest.changedDuringCopy };
}
