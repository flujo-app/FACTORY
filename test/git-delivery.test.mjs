import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { inspectIntegrationRef, updateIntegrationRef } from '../src/adapters/git-delivery.mjs';

const execFileAsync = promisify(execFile);
const ref = 'refs/heads/integration';
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));

async function git(repository, ...args) {
  const { stdout } = await execFileAsync('git', [
    '-c', `core.hooksPath=${devNull}`, '-C', repository, ...args,
  ], { env: gitEnv, shell: false, windowsHide: true, timeout: 30_000 });
  return stdout.trim();
}

async function fixture(t) {
  const temporaryRoot = await realpath(tmpdir());
  const temporary = await mkdtemp(path.join(temporaryRoot, 'factory-git-delivery-'));
  t.after(async () => {
    // Only remove the explicitly created fixture beneath the temporary root.
    assert.equal(path.dirname(temporary), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith('factory-git-delivery-'));
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  });
  const repository = path.join(temporary, 'repository');
  await mkdir(repository);
  await git(repository, 'init', '--initial-branch=integration');
  await git(repository, 'config', 'user.name', 'Factory delivery fixture');
  await git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await git(repository, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(repository, 'result.txt'), 'baseline\n');
  await git(repository, 'add', 'result.txt');
  await git(repository, 'commit', '-m', 'baseline');
  const baseline = await git(repository, 'rev-parse', 'HEAD');

  await git(repository, 'checkout', '-b', 'candidate-a');
  await writeFile(path.join(repository, 'result.txt'), 'approach A\n');
  await git(repository, 'commit', '-am', 'approach A');
  const candidateA = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'checkout', '-b', 'candidate-b', baseline);
  await writeFile(path.join(repository, 'result.txt'), 'approach B\n');
  await git(repository, 'commit', '-am', 'approach B');
  const candidateB = await git(repository, 'rev-parse', 'HEAD');
  return { repository, baseline, candidateA, candidateB };
}

test('updates exactly the integration ref and returns an observable receipt', async t => {
  const { repository, baseline, candidateA, candidateB } = await fixture(t);
  assert.equal(await inspectIntegrationRef({ repository, ref }), baseline);
  const receipt = await updateIntegrationRef({
    repository, ref, expectedHead: baseline, candidateHead: candidateA,
  });
  assert.deepEqual(receipt, { ref, previousHead: baseline, head: candidateA });
  assert.equal(await inspectIntegrationRef({ repository, ref }), candidateA);
  assert.equal(await git(repository, 'rev-parse', 'refs/heads/candidate-b'), candidateB);
  assert.equal(await git(repository, 'show', `${ref}:result.txt`), 'approach A');
});

test('a stale expected head cannot replace the selected candidate', async t => {
  const { repository, baseline, candidateA, candidateB } = await fixture(t);
  await updateIntegrationRef({ repository, ref, expectedHead: baseline, candidateHead: candidateA });
  await assert.rejects(updateIntegrationRef({
    repository, ref, expectedHead: baseline, candidateHead: candidateB,
  }), { code: 'CAS_CONFLICT' });
  assert.equal(await inspectIntegrationRef({ repository, ref }), candidateA);
});

test('concurrent competing candidates have exactly one successful CAS', async t => {
  const { repository, baseline, candidateA, candidateB } = await fixture(t);
  const outcomes = await Promise.allSettled([candidateA, candidateB].map(candidateHead =>
    updateIntegrationRef({ repository, ref, expectedHead: baseline, candidateHead })));
  const accepted = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'CAS_CONFLICT');
  assert.equal(await inspectIntegrationRef({ repository, ref }), accepted[0].value.head);
});

test('invalid references, repository paths and abbreviated IDs cause no mutation', async t => {
  const { repository, baseline, candidateA } = await fixture(t);
  const valid = { repository, ref, expectedHead: baseline, candidateHead: candidateA };
  for (const replacement of [
    { repository: 'relative-repository' },
    { ref: 'integration' },
    { ref: 'refs/tags/integration' },
    { ref: 'refs/heads/bad..name' },
    { ref: 'refs/heads/integration\n' },
    { expectedHead: baseline.slice(0, 12) },
    { candidateHead: 'x'.repeat(40) },
    { candidateHead: `${candidateA};echo unsafe` },
  ]) {
    await assert.rejects(updateIntegrationRef({ ...valid, ...replacement }), error =>
      ['INVALID_INPUT', 'INVALID_REF'].includes(error.code));
  }
  await assert.rejects(inspectIntegrationRef({ repository, ref: 'refs/heads/missing' }), { code: 'INVALID_REF' });
  assert.equal(await inspectIntegrationRef({ repository, ref }), baseline);
});

test('missing and non-commit objects cannot be integrated', async t => {
  const { repository, baseline } = await fixture(t);
  const blob = await git(repository, 'rev-parse', `${baseline}:result.txt`);
  for (const candidateHead of ['f'.repeat(40), blob]) {
    await assert.rejects(updateIntegrationRef({
      repository, ref, expectedHead: baseline, candidateHead,
    }), { code: 'INVALID_COMMIT' });
  }
  assert.equal(await inspectIntegrationRef({ repository, ref }), baseline);
});

test('symbolic integration refs cannot redirect a mutation to another branch', async t => {
  const { repository, baseline, candidateA, candidateB } = await fixture(t);
  await git(repository, 'symbolic-ref', ref, 'refs/heads/candidate-a');
  await assert.rejects(updateIntegrationRef({
    repository, ref, expectedHead: candidateA, candidateHead: candidateB,
  }), { code: 'INVALID_REF' });
  await assert.rejects(inspectIntegrationRef({ repository, ref }), { code: 'INVALID_REF' });
  assert.equal(await git(repository, 'rev-parse', 'refs/heads/candidate-a'), candidateA);
  assert.equal(await git(repository, 'rev-parse', 'refs/heads/candidate-b'), candidateB);
  assert.equal(await git(repository, 'rev-parse', 'refs/heads/candidate-a^'), baseline);
});
