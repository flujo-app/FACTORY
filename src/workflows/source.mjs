import { execFileSync } from 'node:child_process';
import { sha256 } from './artifacts.mjs';
import { sourceIdentity } from './verifier.mjs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function gitArchive(cwd, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new TypeError('An exact source commit is required.');
  return execFileSync('git', ['-C', cwd, 'archive', '--format=tar', commit], { windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
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
    if (!existsSync(path)) execFileSync('git', ['-C',cwd,'bundle','create',path,'HEAD',`^${baseline}`], {windowsHide:true,stdio:'pipe'});
    const heads = execFileSync('git',['bundle','list-heads',path],{encoding:'utf8',windowsHide:true});
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
