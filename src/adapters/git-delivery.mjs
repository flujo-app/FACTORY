import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[a-fA-F0-9]{40}$/;
const casRefusals = new WeakMap();

function provenRefusal(binding, resolvedRepository, observedHead, phase, cause) {
  const error = failure('CAS_CONFLICT', 'The completed Git executor refused the expected integration head.', cause);
  casRefusals.set(error, Object.freeze({ ...binding, resolvedRepository, observedHead, phase }));
  return error;
}

/** In-process provenance only: a code, stderr string, copied object or serialized error is insufficient. */
export function takeGitCasRefusal(error, binding) {
  const record = casRefusals.get(error);
  if (!record || !binding || ['repository', 'ref', 'expectedHead', 'candidateHead']
    .some(key => record[key] !== binding[key])) return null;
  casRefusals.delete(error);
  return record;
}

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validateInput({ repository, ref, gitPath }) {
  if (typeof repository !== 'string' || !path.isAbsolute(repository)) {
    throw failure('INVALID_INPUT', 'repository must be an absolute repository path.');
  }
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')
    || ref.length === 'refs/heads/'.length || /[\x00-\x20\x7f]/.test(ref)) {
    throw failure('INVALID_REF', 'ref must explicitly name a branch under refs/heads/.');
  }
  if (typeof gitPath !== 'string' || !gitPath.trim() || gitPath.includes('\0')) {
    throw failure('INVALID_INPUT', 'gitPath must name a Git executable.');
  }
}

function commitId(value, label) {
  if (typeof value !== 'string' || !FULL_SHA.test(value)) {
    throw failure('INVALID_INPUT', `${label} must be a full 40-character hexadecimal commit ID.`);
  }
  return value.toLowerCase();
}

async function git(repository, gitPath, args) {
  // Ambient GIT_DIR / GIT_WORK_TREE must not redirect the explicit repository.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  const result = await execFileAsync(gitPath, [
    '-c', `core.hooksPath=${devNull}`, '-C', repository, ...args,
  ], { env, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function checkedRepository(repository, gitPath) {
  let resolved;
  try {
    resolved = await realpath(repository);
    if (!(await stat(resolved)).isDirectory()) throw new Error('Not a directory.');
    const bare = await git(resolved, gitPath, ['rev-parse', '--is-bare-repository']);
    const root = await realpath(await git(resolved, gitPath, [
      'rev-parse', bare === 'true' ? '--absolute-git-dir' : '--show-toplevel',
    ]));
    const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (comparable(root) !== comparable(resolved)) {
      throw new Error('The path is not the repository root.');
    }
  } catch (cause) {
    throw failure('INVALID_INPUT', 'repository must be the absolute root of an existing Git repository.', cause);
  }
  return resolved;
}

async function checkedRef(repository, ref, gitPath) {
  try {
    await git(repository, gitPath, ['check-ref-format', ref]);
  } catch (cause) {
    throw failure('INVALID_REF', 'ref is not a valid Git branch reference.', cause);
  }
  let symbolic = false;
  try {
    await git(repository, gitPath, ['symbolic-ref', '--quiet', ref]);
    symbolic = true;
  } catch (cause) {
    if (cause.code !== 1) {
      throw failure('INVALID_REF', 'Unable to verify the branch reference.', cause);
    }
  }
  if (symbolic) throw failure('INVALID_REF', 'The integration reference must be a direct branch reference.');
  let head;
  try {
    head = await git(repository, gitPath, ['show-ref', '--verify', '--hash', ref]);
  } catch (cause) {
    throw failure('INVALID_REF', 'The integration branch does not exist.', cause);
  }
  return commitId(head, 'currentHead');
}

async function checkedCommit(repository, sha, label, gitPath) {
  try {
    if (await git(repository, gitPath, ['cat-file', '-t', sha]) !== 'commit') {
      throw new Error('Object is not a commit.');
    }
  } catch (cause) {
    throw failure('INVALID_COMMIT', `${label} must identify an existing commit.`, cause);
  }
}

export async function inspectIntegrationRef({ repository, ref, gitPath = 'git' } = {}) {
  validateInput({ repository, ref, gitPath });
  const resolved = await checkedRepository(repository, gitPath);
  const currentHead = await checkedRef(resolved, ref, gitPath);
  await checkedCommit(resolved, currentHead, 'currentHead', gitPath);
  return currentHead;
}

export async function updateIntegrationRef({
  repository, ref, expectedHead, candidateHead, gitPath = 'git',
} = {}) {
  validateInput({ repository, ref, gitPath });
  const previousHead = commitId(expectedHead, 'expectedHead');
  const head = commitId(candidateHead, 'candidateHead');
  const binding = Object.freeze({ repository, ref, expectedHead: previousHead, candidateHead: head });
  const resolved = await checkedRepository(repository, gitPath);
  const currentHead = await checkedRef(resolved, ref, gitPath);
  await checkedCommit(resolved, previousHead, 'expectedHead', gitPath);
  await checkedCommit(resolved, head, 'candidateHead', gitPath);
  if (currentHead !== previousHead) {
    throw provenRefusal(binding, resolved, currentHead, 'preflight-head-mismatch');
  }
  try {
    // Git checks the old head while holding its ref lock. The prior read is only
    // diagnostic; this compare-and-swap prevents concurrent writers from winning.
    // --no-deref also prevents a changed symbolic ref from redirecting the write.
    await git(resolved, gitPath, ['update-ref', '--no-deref', ref, head, previousHead]);
  } catch (cause) {
    const completedFailure = Number.isInteger(cause.code) && cause.code > 0 && cause.code <= 255
      && cause.killed === false && cause.signal === null;
    const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mismatch = completedFailure && new RegExp(`cannot lock ref '${escapedRef}': is at ([a-f0-9]{40}) but expected ${previousHead}(?:\\s|$)`, 'i')
      .exec(typeof cause.stderr === 'string' ? cause.stderr : '');
    if (mismatch && mismatch[1].toLowerCase() !== previousHead) {
      throw provenRefusal(binding, resolved, mismatch[1].toLowerCase(), 'atomic-cas-refusal', cause);
    }
    throw failure('DELIVERY_UNCERTAIN',
      'The atomic integration update did not confirm success; inspect the reference before retrying.', cause);
  }
  return { ref, previousHead, head };
}
