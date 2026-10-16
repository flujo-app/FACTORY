import { readdirSync, lstatSync, statSync, realpathSync, mkdirSync, openSync, readSync, writeSync, closeSync, fsyncSync, chmodSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute, dirname } from 'node:path';
import { contentDigest } from './artifacts.mjs';

export const WORKSPACE_CHUNK_BYTES = 256 * 1024;
const refPattern = /^sha256:[a-f0-9]{64}$/;
export function workspacePath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new TypeError('Use a portable relative workspace path.');
  const target = resolve(root, name);
  if (!target.startsWith(resolve(root) + sep)) throw new Error('Workspace path escaped its root.');
  return target;
}
export function readWorkspaceManifest(store, ref) {
  const manifest = store.getJSON(ref);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'workspace-snapshot' || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) throw new Error('Invalid workspace manifest.');
  const names = new Set();
  for (const name of [...manifest.directories, ...manifest.files.map(file => file.path)]) {
    workspacePath(store.directory, name);
    if (names.has(name)) throw new Error('Duplicate workspace path.');
    names.add(name);
  }
  const ordered=[...names].sort(),fileNames=new Set(manifest.files.map(file=>file.path));
  for(let index=0;index<ordered.length-1;index++)if(fileNames.has(ordered[index]) && ordered[index+1].startsWith(ordered[index]+'/'))throw new Error('A file cannot contain another workspace entry.');
  for (const file of manifest.files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || ![0o644, 0o755].includes(file.mode) || !Array.isArray(file.chunks)
      || file.chunks.some(c => !refPattern.test(c.ref) || !Number.isSafeInteger(c.size) || c.size < 1 || c.size > WORKSPACE_CHUNK_BYTES)
      || file.chunks.reduce((sum, c) => sum + c.size, 0) !== file.size) throw new Error('Invalid workspace file.');
  }
  return manifest;
}

/** Generic, bounded-memory immutable inputs. No Git executable, repository or commit is required. */
export function captureWorkspace(store, cwd, { paths = ['.'], exclude = ['.git', 'node_modules'], baseline = 'initial', cache = new Map() } = {}) {
  if (!isAbsolute(cwd ?? '') || !Array.isArray(paths) || !paths.length || typeof baseline !== 'string' || !baseline) throw new TypeError('Select an absolute workspace, paths and baseline identity.');
  const root = realpathSync(cwd), files = [], directories = [], omitted = [], seen = new Set();
  if(store.directory===root)throw new Error('Keep artifact storage outside the captured workspace.');
  const privatePath=relative(root,store.directory).split(sep).join('/');
  if(privatePath && !privatePath.startsWith('../') && !isAbsolute(privatePath))exclude=[...exclude,privatePath];
  const ignored = name => exclude.some(value => name === value || name.startsWith(value + '/') || !value.includes('/') && name.split('/').includes(value));
  function visit(path) {
    const name = relative(root, path).split(sep).join('/');
    if (name && ignored(name)) { omitted.push(name); return; }
    if (seen.has(name)) return; seen.add(name);
    const before = lstatSync(path);
    // Never follow links into secrets or a different owner's workspace.
    if (before.isSymbolicLink()) throw new Error(`Snapshot requires a regular file/directory, not a symbolic link: ${name}`);
    // Check every ancestor too: a selected nested path must not traverse a link.
    let ancestor=path;while(ancestor!==root){if(lstatSync(ancestor).isSymbolicLink())throw new Error('Snapshot path traverses a symbolic link.');ancestor=dirname(ancestor);}
    if (before.isDirectory()) {
      if (name) directories.push(name);
      for (const child of readdirSync(path).sort()) visit(resolve(path, child));
    } else if (before.isFile()) {
      const fingerprint=[before.ino,before.size,before.mtimeMs,before.ctimeMs,before.mode].join(':');
      if(cache.get(name)?.fingerprint===fingerprint){files.push(cache.get(name).file);return;}
      const fd = openSync(path, 'r'), chunks = []; let size = 0;
      try {
        const buffer = Buffer.alloc(WORKSPACE_CHUNK_BYTES);
        for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; chunks.push(store.put(buffer.subarray(0, count))); size += count; }
      } finally { closeSync(fd); }
      const after = statSync(path);
      if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error(`File changed during snapshot: ${name}`);
      const file={ path: name, size, mode: before.mode & 0o111 ? 0o755 : 0o644, chunks };files.push(file);cache.set(name,{fingerprint,file});
    } else throw new Error(`Unsupported workspace entry: ${name}`);
  }
  for (const path of paths) visit(path === '.' ? root : workspacePath(root, path));
  const directorySet=new Set(directories);
  for(const name of [...directories,...files.map(file=>file.path)]){const parts=name.split('/');while(parts.length>1){parts.pop();directorySet.add(parts.join('/'));}}
  directories.splice(0,directories.length,...directorySet);
  files.sort((a,b) => a.path<b.path?-1:a.path>b.path?1:0); directories.sort(); omitted.sort();
  const manifest = { schemaVersion: 1, kind: 'workspace-snapshot', files, directories, omitted };
  const artifact = { ...store.putJSON(manifest), name: 'workspace.json', kind: 'workspace-snapshot' };
  return { source: { kind: 'workspace', baseline, snapshot: artifact.ref }, artifact,
    artifacts: [artifact], objects: [...new Map(files.flatMap(file => file.chunks).map(chunk => [chunk.ref, chunk])).values()] };
}
export function verifyWorkspaceArtifacts(store, ref) {
  const manifest = readWorkspaceManifest(store, ref);
  const checked=new Map();
  for (const file of manifest.files) for (const chunk of file.chunks) {
    if(!checked.has(chunk.ref))checked.set(chunk.ref,store.describe(chunk.ref).size);
    if(checked.get(chunk.ref)!==chunk.size)throw new Error('Workspace chunk length differs.');
  }
  return manifest;
}
export function materializeWorkspace(store, ref, cwd) {
  if (!isAbsolute(cwd ?? '')) throw new TypeError('Materialization requires an absolute empty directory.');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (readdirSync(cwd).length) throw new Error('Materialize into an empty private directory.');
  const manifest = verifyWorkspaceArtifacts(store, ref);
  for (const name of manifest.directories) mkdirSync(workspacePath(cwd, name), { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    const path = workspacePath(cwd, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'wx', file.mode);
    try { for (const chunk of file.chunks) { const bytes = store.get(chunk.ref); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); } fsyncSync(fd); }
    finally { closeSync(fd); }
    chmodSync(path, file.mode);
  }
  return manifest;
}
export function assertWorkspaceSource(store, ref, cwd, {writablePaths=[]}={}) {
  const expected = verifyWorkspaceArtifacts(store, ref);
  for(const path of writablePaths){
    workspacePath(cwd,path);
    if([...expected.directories,...expected.files.map(file=>file.path)].some(name=>name===path||name.startsWith(path+'/')))throw new Error('Writable output paths overlap reviewed inputs.');
  }
  const captured = captureWorkspace(store, cwd, { exclude: writablePaths });
  const actual = readWorkspaceManifest(store, captured.source.snapshot);
  // Omitted paths describe capture policy, not inputs materialized for execution.
  const identity = manifest => ({ files: manifest.files.map(file => ({ ...file, ...(process.platform === 'win32' ? { mode: 0o644 } : {}) })), directories: manifest.directories });
  if (contentDigest(identity(expected)) !== contentDigest(identity(actual))) throw new Error('Workspace bytes differ from the reviewed candidate.');
  return { kind: 'workspace', snapshot: ref, dirty: false };
}

export function readWorkspaceFile(store, ref, path, {offset=0,length=65536}={}) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>65536)throw new TypeError('Read at most 65536 bytes at a nonnegative offset.');
  const file=readWorkspaceManifest(store,ref).files.find(file=>file.path===path);
  if(!file || offset>file.size)throw new Error('Unknown candidate file or invalid offset.');
  let position=0;const buffers=[];
  for(const chunk of file.chunks){
    if(position+chunk.size>offset && position<offset+length){const bytes=store.get(chunk.ref);buffers.push(bytes.subarray(Math.max(0,offset-position),Math.min(chunk.size,offset+length-position)));}
    position+=chunk.size;if(position>=offset+length)break;
  }
  const bytes=Buffer.concat(buffers);return{snapshot:ref,path,offset,size:file.size,nextOffset:offset+bytes.length,done:offset+bytes.length===file.size,text:bytes.toString('utf8'),base64:bytes.toString('base64')};
}
