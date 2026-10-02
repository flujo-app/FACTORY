import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import { FactoryControl, digest } from '../src/control.mjs';
import { executeEffect } from '../src/gateway.mjs';
import { executeGitDelivery, consumeGitRefusalProof } from '../src/git-effect.mjs';
import { inspectIntegrationRef, updateIntegrationRef, takeGitCasRefusal } from '../src/adapters/git-delivery.mjs';

const runFile = promisify(execFile);
const REF = 'refs/heads/integration';
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
async function git(repository, args, input = '') {
  const operation = runFile('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'user.name=Factory effect fixture',
    '-c', 'user.email=fixture@example.invalid', '-C', repository, ...args],
  { env: ENV, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
  operation.child.stdin.end(input);
  return (await operation).stdout.trim();
}
async function fixture(t) {
  const base = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(base, 'factory-git-effect-'));
  const repository = path.join(directory, 'repository');
  await mkdir(repository);
  await git(repository, ['init', '--bare']);
  const tree = await git(repository, ['mktree']);
  const baseline = await git(repository, ['commit-tree', tree, '-m', 'baseline']);
  const candidateA = await git(repository, ['commit-tree', tree, '-p', baseline, '-m', 'candidate A']);
  const candidateB = await git(repository, ['commit-tree', tree, '-p', baseline, '-m', 'candidate B']);
  await git(repository, ['update-ref', REF, baseline]);
  let now = 1000;
  const databasePath = path.join(directory, 'control.sqlite');
  const control = new FactoryControl(databasePath, { clock: () => now });
  const connections = [control];
  control.initialize({ mission: 'Qualified local Git delivery', budgetCents: 10000, maxCells: 4 });
  for (const [cellId, role] of [['developer', 'developer'], ['verifier', 'verifier']]) {
    control.reserveCell({ cellId, role, budgetCents: 0, purpose: role });
    control.enrollCell(cellId);
  }
  t.after(async () => {
    for (const connection of connections) connection.close();
    assert.equal(path.dirname(directory), base);
    assert.ok(path.basename(directory).startsWith('factory-git-effect-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  async function reviewed(taskId = 'first', expectedHead = baseline, candidateHead = candidateB, projectId = 'project') {
    const branch = `codex/${taskId}`;
    control.createTask({ taskId, projectId, branch, specification: {
      problem: 'Apply the pinned candidate', acceptance: 'Reviewed Git head reaches only the pinned integration ref',
      baseline: expectedHead, deliveryTarget: { repository, ref: REF },
    } });
    const artifactPath = path.join(directory, `${taskId}-candidate.json`);
    const reviewPath = path.join(directory, `${taskId}-review.json`);
    await writeFile(artifactPath, JSON.stringify({ repository, ref: REF, baseline: expectedHead, candidateHead, branch }));
    await writeFile(reviewPath, JSON.stringify({ candidateHead, independentFixtureCheck: true }));
    const lease = control.claimTask(taskId, 'developer');
    control.submit(lease, { artifactPath });
    control.reviewTask(taskId, 'verifier', { accepted: true, evidencePath: reviewPath });
    return { key: `deliver-${taskId}`, kind: 'delivery', taskId,
      request: { repository, ref: REF, expectedHead, candidateHead } };
  }
  return { control, directory, repository, databasePath, baseline, candidateA, candidateB, reviewed,
    setNow(value) { now = value; },
    connection() { const connection = new FactoryControl(databasePath, { clock: () => now }); connections.push(connection); return connection; },
    async commit(parent, label) { return git(repository, ['commit-tree', tree, '-p', parent, '-m', label]); } };
}

test('real stale-head refusal clears only its effect; exact observation and a fresh delivery remain safe', async t => {
  const f = await fixture(t);
  const intent = await f.reviewed();
  const lease = f.control.claimIntegration('project');
  const candidateHash = f.control.task('first').candidate.sha256;
  await updateIntegrationRef({ repository: f.repository, ref: REF, expectedHead: f.baseline, candidateHead: f.candidateA });
  const refused = await executeGitDelivery(f.control, lease, intent);
  assert.equal(refused.dispatched, true);
  assert.equal(refused.effect.state, 'not_applied');
  assert.equal(refused.effect.receipt.head, f.candidateA);
  assert.equal(f.control.task('first').status, 'verified');
  assert.equal(f.control.task('first').candidate.sha256, candidateHash);
  assert.throws(() => f.control.deliverTask('first', intent.key), { code: 'DELIVERY' });
  const events = f.control.db.prepare('SELECT count(*) AS n FROM events').get().n;
  f.control.pause();
  const observed = await executeGitDelivery(f.control, lease, intent);
  assert.equal(observed.dispatched, false);
  assert.equal(observed.effect.state, 'not_applied');
  assert.equal(f.control.db.prepare("SELECT count(*) AS n FROM events WHERE type='effect_settled' AND subject=?").get(intent.key).n, 1);
  assert.equal(f.control.db.prepare('SELECT count(*) AS n FROM events').get().n, events + 1);
  await assert.rejects(executeGitDelivery(f.control, lease, { ...intent, request: { ...intent.request, candidateHead: f.candidateA } }), { code: 'CONFLICT' });
  await assert.rejects(executeGitDelivery(f.control, lease, { ...intent, key: 'fresh-during-pause' }), { code: 'PAUSED' });
  f.control.resume();
  const nextHead = await f.commit(f.candidateA, 'independently reviewed follow-up');
  const nextIntent = await f.reviewed('second', f.candidateA, nextHead);
  const freshLease = f.control.claimIntegration('project');
  await assert.rejects(executeGitDelivery(f.control, freshLease, intent), { code: 'CONFLICT' });
  const delivered = await executeGitDelivery(f.control, freshLease, nextIntent);
  assert.equal(delivered.effect.state, 'succeeded');
  assert.equal(f.control.deliverTask('second', nextIntent.key).status, 'delivered');
  assert.equal(await inspectIntegrationRef({ repository: f.repository, ref: REF }), nextHead);
});

test('two actual Git writers yield one update and one request-bound nonapplication proof', async t => {
  const f = await fixture(t);
  const requests = [f.candidateA, f.candidateB].map(candidateHead => ({ repository: f.repository, ref: REF, expectedHead: f.baseline, candidateHead }));
  const outcomes = await Promise.allSettled(requests.map(request => updateIntegrationRef(request)));
  const accepted = outcomes.filter(row => row.status === 'fulfilled');
  const refusedIndex = outcomes.findIndex(row => row.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.ok(refusedIndex >= 0);
  const error = outcomes[refusedIndex].reason;
  assert.equal(error.code, 'CAS_CONFLICT');
  const request = requests[refusedIndex];
  for (const other of [{ ...request, candidateHead: requests[1 - refusedIndex].candidateHead },
    { ...request, expectedHead: f.candidateA }, { ...request, ref: 'refs/heads/other' }, { ...request, repository: f.directory }]) {
    assert.equal(takeGitCasRefusal(error, other), null);
  }
  const proof = takeGitCasRefusal(error, request);
  assert.ok(['preflight-head-mismatch', 'atomic-cas-refusal'].includes(proof.phase));
  assert.equal(proof.observedHead, accepted[0].value.head);
  assert.equal(proof.resolvedRepository, await realpath(f.repository));
  assert.equal(takeGitCasRefusal(error, request), null);
  assert.equal(await inspectIntegrationRef({ repository: f.repository, ref: REF }), accepted[0].value.head);
});

test('CAS arguments, intent and lease are captured before asynchronous Git checks', async t => {
  const f = await fixture(t);
  const intent = await f.reviewed('first', f.baseline, f.candidateA);
  const lease = f.control.claimIntegration('project');
  const expectedDigest = digest(intent.request);
  const pending = executeGitDelivery(f.control, lease, intent);
  intent.request.candidateHead = f.candidateB;
  intent.request.expectedHead = 'f'.repeat(40);
  intent.request.ref = 'refs/heads/other';
  intent.request.repository = f.directory;
  intent.key = 'mutated-key'; intent.taskId = 'mutated-task';
  lease.cellId = 'mutated-owner'; lease.epoch += 1; lease.controlEpoch += 1;
  const result = await pending;
  assert.equal(result.effect.key, 'deliver-first');
  assert.equal(result.effect.request_digest, expectedDigest);
  assert.equal(result.effect.state, 'succeeded');
  assert.equal(await inspectIntegrationRef({ repository: f.repository, ref: REF }), f.candidateA);
  assert.equal(f.control.status().effects.length, 1);
});

test('opaque refusal proofs reject fabricated values, foreign controllers and changed effect identities', async t => {
  const f = await fixture(t);
  const intent = await f.reviewed();
  const lease = f.control.claimIntegration('project');
  await updateIntegrationRef({ repository: f.repository, ref: REF, expectedHead: f.baseline, candidateHead: f.candidateA });
  const settle = f.control.settleGitRefusal;
  let proof;
  f.control.settleGitRefusal = (_key, value) => { proof = value; throw new Error('Simulated lost durable receipt.'); };
  const lost = await executeGitDelivery(f.control, lease, intent);
  f.control.settleGitRefusal = settle;
  assert.equal(lost.effect.state, 'unknown');
  assert.ok(proof);
  for (const forged of [{ trusted: true, state: 'not_applied' }, JSON.parse(JSON.stringify(proof)),
    Object.assign(new Error('forged'), { code: 'CAS_CONFLICT' }), null]) {
    assert.throws(() => f.control.settleGitRefusal(intent.key, forged), { code: 'GIT_REFUSAL_PROOF' });
  }
  const foreign = f.connection();
  assert.throws(() => foreign.settleGitRefusal(intent.key, proof), { code: 'GIT_REFUSAL_PROOF' });
  f.control.db.prepare('UPDATE effects SET request_digest=? WHERE key=?').run('f'.repeat(64), intent.key);
  assert.throws(() => f.control.settleGitRefusal(intent.key, proof), { code: 'GIT_REFUSAL_PROOF' });
  f.control.db.prepare('UPDATE effects SET request_digest=? WHERE key=?').run(digest(intent.request), intent.key);
  f.control.db.prepare('UPDATE effects SET owner_epoch=owner_epoch+1 WHERE key=?').run(intent.key);
  assert.throws(() => f.control.settleGitRefusal(intent.key, proof), { code: 'GIT_REFUSAL_PROOF' });
  f.control.db.prepare('UPDATE effects SET owner_epoch=owner_epoch-1 WHERE key=?').run(intent.key);
  f.control.pause();
  f.setNow(100_000);
  assert.equal(f.control.settleGitRefusal(intent.key, proof).state, 'not_applied');
  assert.equal(consumeGitRefusalProof(proof, f.control, f.control.effect(intent.key)), null);
  assert.equal(f.control.task('first').status, 'verified');
});

test('lost proof persistence leaves an unknown project fence and never redispatches', async t => {
  const f = await fixture(t);
  const intent = await f.reviewed();
  const lease = f.control.claimIntegration('project');
  await updateIntegrationRef({ repository: f.repository, ref: REF, expectedHead: f.baseline, candidateHead: f.candidateA });
  f.control.settleGitRefusal = () => { throw new Error('Receipt unavailable after proven refusal.'); };
  assert.equal((await executeGitDelivery(f.control, lease, intent)).effect.state, 'unknown');
  f.setNow(100_000);
  assert.throws(() => f.control.claimIntegration('project'), { code: 'UNRECONCILED' });
  assert.throws(() => f.control.settleEffect(intent.key, 'not_applied'), { code: 'NEGATIVE_RECONCILIATION_UNSUPPORTED' });
  assert.throws(() => f.control.reconcileEffect(intent.key, { applied: false, evidencePath: path.join(f.directory, 'first-review.json') }),
    { code: 'NEGATIVE_RECONCILIATION_UNSUPPORTED' });
  const replay = await executeGitDelivery(f.control, lease, intent);
  assert.equal(replay.dispatched, false);
  assert.equal(replay.effect.state, 'unknown');
  assert.equal(await inspectIntegrationRef({ repository: f.repository, ref: REF }), f.candidateA);
});

test('ordinary Git uncertainty retains the project fence and cannot acquire refusal provenance', async t => {
  const f = await fixture(t);
  const intent = await f.reviewed('first', f.baseline, f.candidateA);
  const lease = f.control.claimIntegration('project');
  const lock = path.join(f.repository, 'refs', 'heads', 'integration.lock');
  await writeFile(lock, 'owned fixture lock');
  const result = await executeGitDelivery(f.control, lease, intent);
  assert.equal(result.effect.state, 'unknown');
  f.setNow(100_000);
  assert.throws(() => f.control.claimIntegration('project'), { code: 'UNRECONCILED' });
  assert.equal(await inspectIntegrationRef({ repository: f.repository, ref: REF }), f.baseline);
  await assert.rejects(updateIntegrationRef(intent.request), error => error.code === 'DELIVERY_UNCERTAIN'
    && takeGitCasRefusal(error, intent.request) === null);
  await rm(lock);
});

test('generic gateway keeps genuine or forged CAS errors and killed executors unknown', async t => {
  const f = await fixture(t);
  const intent = await f.reviewed();
  const lease = f.control.claimIntegration('project');
  await updateIntegrationRef({ repository: f.repository, ref: REF, expectedHead: f.baseline, candidateHead: f.candidateA });
  const genuine = await executeEffect(f.control, lease, intent, () => updateIntegrationRef(intent.request));
  assert.equal(genuine.effect.state, 'unknown');
  assert.equal(takeGitCasRefusal(Object.assign(new Error('forged'), { code: 'CAS_CONFLICT', killed: false, signal: null,
    stderr: `cannot lock ref '${REF}': is at ${f.candidateA} but expected ${f.baseline}` }), intent.request), null);
  for (const [index, error] of [Object.assign(new Error('forged CAS refusal'), { code: 'CAS_CONFLICT' }),
    Object.assign(new Error('uncertain response'), { code: 'DELIVERY_UNCERTAIN' })].entries()) {
    const project = `project-${index}`;
    const next = await f.reviewed(`error-${index}`, f.baseline, f.candidateB, project);
    const nextLease = f.control.claimIntegration(project);
    assert.equal((await executeEffect(f.control, nextLease, next, async () => { throw error; })).effect.state, 'unknown');
  }
  const killed = await f.reviewed('killed', f.candidateA, f.candidateB, 'killed-project');
  const killedLease = f.control.claimIntegration('killed-project');
  const lock = path.join(f.repository, 'refs', 'heads', 'integration.lock');
  await writeFile(lock, 'owned fixture lock');
  let killedError;
  const result = await executeEffect(f.control, killedLease, killed, async () => {
    try { await runFile('git', ['-c', 'core.filesRefLockTimeout=30000', '-C', f.repository,
      'update-ref', '--no-deref', REF, f.candidateB, f.candidateA], { env: ENV, timeout: 150, windowsHide: true }); }
    catch (error) {
      killedError = error;
      error.code = 'CAS_CONFLICT';
      error.stderr = `cannot lock ref '${REF}': is at ${f.candidateB} but expected ${f.candidateA}`;
      throw error;
    }
  });
  assert.equal(killedError.killed, true);
  assert.equal(result.effect.state, 'unknown');
  assert.equal(takeGitCasRefusal(killedError, killed.request), null);
  f.setNow(100_000);
  assert.throws(() => f.control.claimIntegration('killed-project'), { code: 'UNRECONCILED' });
  assert.equal(await inspectIntegrationRef({ repository: f.repository, ref: REF }), f.candidateA);
  await rm(lock);
});

test('runtime executors, operation callbacks and manufactured result flags are never worker request fields', async t => {
  const f = await fixture(t);
  const intent = await f.reviewed();
  const lease = f.control.claimIntegration('project');
  await assert.rejects(executeGitDelivery(f.control, lease, { ...intent, request: { ...intent.request, gitPath: 'untrusted-worker-executor' } }),
    { code: 'GIT_DELIVERY_INVALID' });
  await assert.rejects(executeGitDelivery(f.control, lease, intent, { operation: async () => ({ trusted: true, state: 'not_applied' }) }),
    { code: 'GIT_DELIVERY_INVALID' });
  assert.equal(f.control.status().effects.length, 0);
  assert.equal(await inspectIntegrationRef({ repository: f.repository, ref: REF }), f.baseline);
  assert.match(await readFile(path.join(f.directory, 'first-candidate.json'), 'utf8'), /candidateHead/);
});
