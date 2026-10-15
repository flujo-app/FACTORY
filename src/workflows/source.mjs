import { execFileSync } from 'node:child_process';
import { sha256 } from './artifacts.mjs';
import { sourceIdentity } from './verifier.mjs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Git archive honors export-ignore/export-subst and local attributes. Review bytes
// must still contain every tracked blob, unchanged, before they can authorize execution.
function assertCompleteArchive(cwd, commit, archive) {
  const entries = execFileSync('git', ['-c','core.longpaths=true','-C',cwd,'ls-tree','-rz',commit], {windowsHide:true,maxBuffer:128*1024*1024}).toString('utf8').split('\0').filter(Boolean);
  const expected = new Map(entries.map(entry => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== 'blob') throw new Error('Portable verification does not support unresolved submodule source.');
    return [match[4], {mode:match[1],hash:match[3]}];
  }));
  let extended = {};
  for (let offset=0; offset+512<=archive.length;) {
    const header=archive.subarray(offset,offset+512); offset+=512;
    if (header.every(byte=>byte===0)) break;
    const string=(start,length)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
    const size=parseInt(string(124,12).trim(),8),type=string(156,1);
    if (!Number.isSafeInteger(size) || size<0 || offset+size>archive.length) throw new Error('Invalid generated source archive.');
    const bytes=archive.subarray(offset,offset+size); offset+=Math.ceil(size/512)*512;
    if (type==='x' || type==='g') {
      if(type==='x') {
        extended={}; let position=0;
        while(position<bytes.length) {
          const space=bytes.indexOf(32,position),length=Number(bytes.subarray(position,space).toString());
          if(space<0 || !Number.isSafeInteger(length) || length<3 || position+length>bytes.length) throw new Error('Invalid source archive metadata.');
          const field=bytes.subarray(space+1,position+length-1).toString('utf8'),equal=field.indexOf('=');
          extended[field.slice(0,equal)]=field.slice(equal+1); position+=length;
        }
      }
      continue;
    }
    const name=extended.path??[string(345,155),string(0,100)].filter(Boolean).join('/');
    const link=extended.linkpath??string(157,100); extended={};
    if(type==='5') continue;
    const entry=expected.get(name),content=type==='2'?Buffer.from(link):bytes;
    if(!entry || !['','0','2'].includes(type) || (entry.mode==='120000')!==(type==='2')
      || createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')!==entry.hash) throw new Error('Portable source archive differs from tracked Git blobs; export attributes cannot hide or rewrite verifier inputs.');
    expected.delete(name);
  }
  if(expected.size) throw new Error('Portable source archive omits tracked Git blobs; disable export-ignore for verified source.');
}

export function gitArchive(cwd, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new TypeError('An exact source commit is required.');
  const archive=execFileSync('git', ['-c','core.longpaths=true','-c','core.autocrlf=false','-c','core.eol=lf','-C', cwd, 'archive', '--format=tar', commit], { windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  assertCompleteArchive(cwd,commit,archive); return archive;
}
/** Capture the exact tree that executable verification will check, with portable bytes for reviewers. */
export function captureGitSource(store, cwd, { repository, baseline }) {
  if (typeof repository !== 'string' || !repository || !/^[a-f0-9]{40}$/.test(baseline ?? '')) throw new TypeError('Repository and immutable baseline are required.');
  const identity = sourceIdentity(cwd);
  if (identity.dirty) throw new Error('Commit source changes before freezing a candidate.');
  const artifact = { ...store.put(gitArchive(cwd, identity.commit)), name: 'source.tar', kind: 'git-archive' };
  let bundle;
  if (identity.commit !== baseline) {
    const path = resolve(store.directory, `git-${baseline}-${identity.commit}.bundle`);
    if (!existsSync(path)) execFileSync('git', ['-c','core.longpaths=true','-C',cwd,'bundle','create',path,'HEAD',`^${baseline}`], {windowsHide:true,stdio:'pipe'});
    const heads = execFileSync('git',['-c','core.longpaths=true','bundle','list-heads',path],{encoding:'utf8',windowsHide:true});
    if (!heads.split('\n').some(line=>line === `${identity.commit} HEAD`)) throw new Error('Portable bundle head differs from the candidate.');
    bundle = { ...store.importFile(path), name: 'candidate.bundle', kind: 'git-bundle' };
  }
  return { source: { repository, baseline, commit: identity.commit, tree: identity.tree }, artifact, ...(bundle ? { bundle } : {}) };
}
export function assertCandidateSource(candidate, cwd) {
  const snapshot = candidate.artifacts.find(artifact => artifact.kind === 'git-archive');
  if (!snapshot || snapshot.ref !== 'sha256:' + sha256(gitArchive(cwd, candidate.source.commit))) throw new Error('Portable source snapshot does not match the executable candidate.');
  return snapshot.ref;
}
