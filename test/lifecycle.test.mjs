import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FactoryControl } from '../src/control.mjs';
import { executeGitDelivery } from '../src/git-effect.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { startPresentationServer, decodeCursor } from '../src/presentation.mjs';

function fixture(t, { clock = Date.now, maxCells = 12, budgetCents = 10000 } = {}) {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(path.join(parent, 'factory-lifecycle-'));
  const filename = path.join(dir, 'control.sqlite'), control = new FactoryControl(filename, { clock });
  const connections = [control];
  control.initialize({ mission: 'Logical lifecycle fixture', budgetCents, maxCells, maxDepth: 3 });
  t.after(() => {
    for (const connection of connections) try { connection.close(); } catch {}
    assert.equal(path.dirname(dir), parent); assert.ok(path.basename(dir).startsWith('factory-lifecycle-'));
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { control, filename, dir,
    open() { const reopened = new FactoryControl(filename, { clock }); connections.push(reopened); return reopened; },
    cell(cellId, role = 'developer', budgetCents = 1000, parentId = 'root', ready = true) {
      control.reserveCell({ cellId, role, budgetCents, parentId, purpose: cellId });
      if (ready) control.enrollCell(cellId);
      return control.db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
    },
    task(taskId = 'work', fields = {}) {
      control.createTask({ taskId, projectId: 'project', branch: `codex/${taskId}`,
        specification: { problem: 'Work', acceptance: 'Independent acceptance', baseline: 'pinned', ...fields } });
    },
  };
}
function releaseInput(control, taskId = 'work', closureId = `release-${taskId}`) {
  const task = control.task(taskId);
  return { closureId, expectedAttempt: task.epoch, expectedOwner: task.owner, expectedStatus: 'running',
    expectedTaskControlEpoch: task.control_epoch, expectedFactoryEpoch: control.control().epoch };
}
function retireInput(control, cellId, closureId = `retire-${cellId}`) {
  const cell = control.db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
  return { closureId, expectedParent: cell.parent_id, expectedStatus: cell.status,
    expectedAllocation: cell.allocation, expectedSpent: cell.spent, expectedFactoryEpoch: control.control().epoch };
}
function count(control, type) { return control.db.prepare('SELECT count(*) AS n FROM events WHERE type=?').get(type).n; }
function child(filename, code) {
  const moduleUrl = new URL('../src/control.mjs', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e',
      `import {FactoryControl} from ${JSON.stringify(moduleUrl)}; const c=new FactoryControl(${JSON.stringify(filename)}); try { ${code} } catch(e) { console.log(JSON.stringify({code:e.code})); } finally { c.close(); }`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = ''; process.stdout.on('data', value => stdout += value); process.stderr.on('data', value => stderr += value);
    process.on('error', reject); process.on('exit', code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout.trim())));
  });
}
const runGit = promisify(execFile);
async function git(repository, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return (await runGit('git', ['-c', `core.hooksPath=${devNull}`, '-C', repository, ...args],
    { env, shell: false, windowsHide: true, timeout: 30000 })).stdout.trim();
}
async function reviewedCandidate(f) {
  const repository = path.join(f.dir, 'repository'); mkdirSync(repository);
  await git(repository, 'init', '--initial-branch=integration');
  await git(repository, 'config', 'user.name', 'Lifecycle fixture'); await git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await git(repository, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repository, 'result.txt'), 'baseline\n'); await git(repository, 'add', 'result.txt'); await git(repository, 'commit', '-m', 'baseline');
  const baseline = await git(repository, 'rev-parse', 'HEAD'); await git(repository, 'checkout', '-b', 'codex/work');
  writeFileSync(path.join(repository, 'result.txt'), 'reviewed change\n'); await git(repository, 'commit', '-am', 'candidate');
  const candidateHead = await git(repository, 'rev-parse', 'HEAD'), ref = 'refs/heads/integration';
  f.task('work', { baseline, deliveryTarget: { repository, ref } });
  const artifact = path.join(f.dir, 'candidate.json'), proof = path.join(f.dir, 'review.txt');
  writeFileSync(artifact, JSON.stringify({ repository, ref, baseline, candidateHead, branch: 'codex/work' })); writeFileSync(proof, 'Independent review of exact candidate.');
  const taskLease = f.control.claimTask('work', 'dev'); f.control.submit(taskLease, { artifactPath: artifact });
  f.control.reviewTask('work', 'verify', { accepted: true, evidencePath: proof });
  return { repository, artifact, proof, taskLease, request: { repository, ref, expectedHead: baseline, candidateHead } };
}

test('release while paused clears authority and replays exactly across later factory epochs and reopen', t => {
  const f = fixture(t); f.cell('dev'); f.task(); const lease = f.control.claimTask('work', 'dev');
  f.control.pause(); const input = releaseInput(f.control), before = f.control.task('work');
  const released = f.control.releaseTask('work', input); assert.equal(released.status, 'ready');
  const task = f.control.task('work');
  assert.equal(task.owner, null); assert.equal(task.control_epoch, null); assert.equal(task.expires, null); assert.equal(task.epoch, before.epoch);
  assert.deepEqual(task.specification, before.specification); assert.equal(task.branch, before.branch);
  assert.equal(f.control.db.prepare('SELECT token_hash FROM tasks WHERE id=?').get('work').token_hash, null);
  f.control.resume(); f.control.pause(); assert.deepEqual(f.open().releaseTask('work', input), released);
  assert.equal(count(f.control, 'task_released'), 1); f.control.resume();
  assert.throws(() => f.control.renew(lease), { code: 'STALE' });
  const successor = f.control.claimTask('work', 'root'); assert.equal(successor.epoch, lease.epoch + 1);
  assert.throws(() => f.control.releaseTask('work', input), { code: 'STALE' }); assert.equal(f.control.task('work').owner, 'root');
});

test('release requires every recorded CAS field and rejects serializable trust or evidence', t => {
  const f = fixture(t); f.cell('dev'); f.task(); f.control.claimTask('work', 'dev'); const input = releaseInput(f.control);
  for (const changed of [{ expectedAttempt: 2 }, { expectedOwner: 'root' }, { expectedTaskControlEpoch: 2 }, { expectedFactoryEpoch: 2 }])
    assert.throws(() => f.control.releaseTask('work', { ...input, ...changed }), { code: 'STALE' });
  for (const changed of [{ expectedStatus: 'ready' }, { trusted: true }, { retirementEvidence: { state: 'destroyed' } }])
    assert.throws(() => f.control.releaseTask('work', { ...input, ...changed }), { code: 'INVALID' });
  assert.equal(f.control.task('work').status, 'running'); assert.equal(count(f.control, 'task_released'), 0);
});

test('accepted, running and unknown task effects each prevent release', t => {
  for (const state of ['accepted', 'running', 'unknown']) {
    const f = fixture(t); f.cell('dev'); f.task(); const lease = f.control.claimTask('work', 'dev');
    f.control.admitEffect(lease, { key: 'effect', kind: 'flow_call', request: {} });
    if (state !== 'accepted') f.control.startEffect(lease, 'effect');
    if (state === 'unknown') f.control.settleEffect('effect', 'unknown', {});
    assert.throws(() => f.control.releaseTask('work', releaseInput(f.control)), { code: 'UNRECONCILED' });
    assert.equal(f.control.effect('effect').state, state); assert.equal(f.control.task('work').status, 'running');
  }
});

test('release checks task-associated project effects rather than only its task lane', t => {
  const f = fixture(t); f.cell('dev'); f.task(); f.control.claimTask('work', 'dev');
  // The schema admits project effects with task_id. Exercise that causal identity independently of task status.
  f.control.db.prepare('INSERT INTO effects(key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('project-open', 'project', 'project', 'work', 'root', 1, 1, 'delivery', 'a'.repeat(64), 'unknown', 1, 1);
  assert.equal(f.control.openEffects('task', 'work').length, 0);
  assert.throws(() => f.control.releaseTask('work', releaseInput(f.control)), { code: 'UNRECONCILED' });
});

test('task release includes cleanup for its terminal parent-owned provisioning binding', t => {
  const f = fixture(t); f.cell('cloud', 'developer', 1000, 'root', false); f.task(); const lease = f.control.claimTask('work', 'root');
  f.control.admitEffect(lease, { key: 'up', kind: 'provision', request: { cellId: 'cloud', app: 'factory-cleanup' } });
  f.control.startEffect(lease, 'up'); f.control.settleEffect('up', 'succeeded', {});
  f.control.admitOwnedRetirement({ key: 'down', app: 'factory-cleanup' });
  assert.throws(() => f.control.releaseTask('work', releaseInput(f.control)), { code: 'UNRECONCILED' });
  f.control.startOwnedRetirement('down'); f.control.settleEffect('down', 'succeeded', { app: 'factory-cleanup', state: 'destroyed' });
  assert.equal(f.control.releaseTask('work', releaseInput(f.control)).status, 'ready');
});

test('two independent processes release once and reopen observes the exact receipt', async t => {
  const f = fixture(t); f.cell('dev'); f.task(); f.control.claimTask('work', 'dev'); const input = releaseInput(f.control);
  const command = `console.log(JSON.stringify(c.releaseTask('work',${JSON.stringify(input)})))`;
  const results = await Promise.all([child(f.filename, command), child(f.filename, command)]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].status, 'ready'); assert.equal(count(f.control, 'task_released'), 1);
  assert.deepEqual(f.open().releaseTask('work', input), results[0]);
  assert.throws(() => f.control.releaseTask('work', { ...input, expectedOwner: 'root' }), { code: 'CONFLICT' });
});

test('release versus a new claim serializes and cannot release the successor attempt', async t => {
  const f = fixture(t); f.cell('dev'); f.task(); const old = f.control.claimTask('work', 'dev'); const input = releaseInput(f.control);
  const [released, claimed] = await Promise.all([
    child(f.filename, `console.log(JSON.stringify(c.releaseTask('work',${JSON.stringify(input)})))`),
    child(f.filename, "const lease=c.claimTask('work','root');console.log(JSON.stringify({epoch:lease.epoch}))"),
  ]);
  assert.equal(released.status, 'ready'); assert.ok(claimed.code === 'BUSY' || claimed.epoch === old.epoch + 1);
  if (claimed.code === 'BUSY') f.control.claimTask('work', 'root');
  assert.throws(() => f.control.releaseTask('work', input), { code: 'STALE' }); assert.equal(f.control.task('work').owner, 'root');
});

test('unused reserved cell retires without a provider claim and cannot be recreated or enrolled', t => {
  const f = fixture(t, { maxCells: 2 }); f.cell('unused', 'developer', 10000, 'root', false);
  const input = retireInput(f.control, 'unused'), result = f.control.retireCell('unused', input);
  assert.equal(result.resourceScope, 'no-recorded-provisioning-logical-only'); assert.equal(result.workerQuiescence, 'unverified');
  assert.equal(result.releasedLogicalCents, 10000); assert.equal(result.transferredLogicalCents, 0);
  assert.equal(f.control.reserveCell({ cellId: 'unused', role: 'developer', budgetCents: 10000, purpose: 'unused' }).status, 'retired');
  assert.throws(() => f.control.enrollCell('unused'), { code: 'CELL' });
  f.cell('replacement', 'developer', 10000, 'root', false); assert.equal(f.control.status().cells.filter(c => c.status !== 'retired').length, 2);
  f.control.pause(); f.control.resume(); assert.deepEqual(f.open().retireCell('unused', input), result); assert.equal(count(f.control, 'cell_retired'), 1);
});

test('root, non-leaf and running task owners cannot retire', t => {
  const f = fixture(t); f.cell('parent'); f.cell('leaf', 'developer', 500, 'parent');
  assert.throws(() => f.control.retireCell('root', { ...retireInput(f.control, 'parent'), expectedParent: 'root' }), { code: 'CELL' });
  assert.throws(() => f.control.retireCell('parent', retireInput(f.control, 'parent')), { code: 'CHILDREN' });
  f.task(); f.control.claimTask('work', 'leaf'); assert.throws(() => f.control.retireCell('leaf', retireInput(f.control, 'leaf')), { code: 'TASK' });
  f.control.releaseTask('work', releaseInput(f.control)); assert.equal(f.control.retireCell('leaf', retireInput(f.control, 'leaf')).status, 'retired');
});

test('nested logical spent rolls upward once while allocation stays committed at the direct parent', t => {
  const f = fixture(t); f.cell('parent', 'coordinator', 4000); f.cell('a', 'developer', 1500, 'parent'); f.cell('b', 'developer', 800, 'parent');
  // Valid durable logical spend fixture; this patch introduces no spend meter or paid-ledger coupling.
  for (const [id, spent] of [['parent', 300], ['a', 600], ['b', 100]]) f.control.db.prepare('UPDATE cells SET spent=? WHERE id=?').run(spent, id);
  const a = retireInput(f.control, 'a'), b = retireInput(f.control, 'b'); f.control.retireCell('a', a); f.control.retireCell('b', b);
  assert.equal(f.control.db.prepare('SELECT spent FROM cells WHERE id=?').get('parent').spent, 1000);
  assert.equal(f.control.db.prepare('SELECT spent FROM cells WHERE id=?').get('root').spent, 0);
  assert.throws(() => f.cell('too-much', 'developer', 6001), { code: 'BUDGET' });
  const parent = retireInput(f.control, 'parent'), result = f.control.retireCell('parent', parent);
  assert.equal(result.transferredLogicalCents, 1000); assert.equal(result.releasedLogicalCents, 3000);
  assert.equal(f.control.db.prepare('SELECT spent FROM cells WHERE id=?').get('root').spent, 1000);
  f.control.retireCell('a', a); f.control.retireCell('b', b); f.control.retireCell('parent', parent);
  assert.equal(f.control.db.prepare('SELECT spent FROM cells WHERE id=?').get('root').spent, 1000);
  f.cell('remaining', 'developer', 9000); assert.throws(() => f.cell('excess', 'developer', 1), { code: 'BUDGET' });
});

test('concurrent leaf retirement transfers spent and emits one event across processes', async t => {
  const f = fixture(t); f.cell('leaf'); f.control.db.prepare('UPDATE cells SET spent=125 WHERE id=?').run('leaf');
  const input = retireInput(f.control, 'leaf'), command = `console.log(JSON.stringify(c.retireCell('leaf',${JSON.stringify(input)})))`;
  const [first, second] = await Promise.all([child(f.filename, command), child(f.filename, command)]);
  assert.deepEqual(first, second); assert.equal(first.transferredLogicalCents, 125); assert.equal(count(f.control, 'cell_retired'), 1);
  assert.equal(f.control.db.prepare('SELECT spent FROM cells WHERE id=?').get('root').spent, 125);
  f.control.pause(); f.control.resume(); assert.deepEqual(f.open().retireCell('leaf', input), first);
  assert.throws(() => f.control.retireCell('leaf', { ...input, expectedSpent: 126 }), { code: 'CONFLICT' });
});

test('retirement checks parent-owned provision and root-owned cleanup while unrelated unknown work does not block', t => {
  const f = fixture(t); f.cell('bound', 'developer', 1000, 'root', false); f.cell('clean', 'developer', 1000, 'root', false); f.task();
  const lease = f.control.claimTask('work', 'root'); f.control.admitEffect(lease, { key: 'up', kind: 'provision', request: { cellId: 'bound', app: 'factory-bound' } });
  f.control.startEffect(lease, 'up'); f.control.settleEffect('up', 'unknown', {});
  f.control.admitOwnedRetirement({ key: 'down', app: 'factory-bound' }); f.control.startOwnedRetirement('down'); f.control.settleEffect('down', 'unknown', {});
  assert.throws(() => f.control.retireCell('bound', retireInput(f.control, 'bound')), { code: 'UNRECONCILED' });
  assert.equal(f.control.retireCell('clean', retireInput(f.control, 'clean')).status, 'retired');
  assert.equal(f.control.effect('up').state, 'unknown'); assert.equal(f.control.effect('down').state, 'unknown');
});

test('all provision-bound identities stay outside this patch, including cancelled never-started intents', t => {
  for (const state of ['succeeded', 'not_applied']) {
    const f = fixture(t); f.cell('bound', 'developer', 1000, 'root', false); f.task(); const lease = f.control.claimTask('work', 'root');
    f.control.admitEffect(lease, { key: 'up', kind: 'provision', request: { cellId: 'bound', app: 'factory-bound' } });
    if (state === 'succeeded') f.control.startEffect(lease, 'up');
    f.control.settleEffect('up', state, {});
    assert.throws(() => f.control.retireCell('bound', retireInput(f.control, 'bound')), { code: 'PROVISIONED_CELL' });
    assert.equal(f.control.effect('up').state, state); assert.equal(f.control.status().cells.find(c => c.id === 'bound').status, 'reserved');
  }
});

test('missing cell binding cannot make an associated App look never provisioned', t => {
  const f = fixture(t); f.cell('bound', 'developer', 1000, 'root', false); f.task(); const lease = f.control.claimTask('work', 'root');
  f.control.admitEffect(lease, { key: 'up', kind: 'provision', request: { cellId: 'bound', app: 'factory-bound' } }); f.control.settleEffect('up', 'not_applied', {});
  f.control.db.prepare('DELETE FROM effect_bindings WHERE target=?').run('cell:bound');
  assert.throws(() => f.control.retireCell('bound', retireInput(f.control, 'bound')), { code: 'PROVISION_BINDING' });
  assert.equal(f.control.db.prepare('SELECT spent FROM cells WHERE id=?').get('root').spent, 0);
});

test('retirement requires exact identity, valid conservation and no supplied provider trust', t => {
  const f = fixture(t); f.cell('leaf'); const input = retireInput(f.control, 'leaf');
  for (const changed of [{ expectedParent: 'other' }, { expectedAllocation: 999 }, { expectedSpent: 1 }, { expectedFactoryEpoch: 2 }, { expectedStatus: 'reserved' }])
    assert.throws(() => f.control.retireCell('leaf', { ...input, ...changed }), { code: 'STALE' });
  assert.throws(() => f.control.retireCell('leaf', { ...input, retirementEvidence: { trusted: true, state: 'destroyed' } }), { code: 'INVALID' });
  f.control.db.prepare('UPDATE cells SET spent=1001 WHERE id=?').run('leaf');
  assert.throws(() => f.control.retireCell('leaf', retireInput(f.control, 'leaf')), { code: 'BUDGET' });
  f.control.db.prepare('UPDATE cells SET spent=0 WHERE id=?').run('leaf'); f.control.db.prepare('UPDATE cells SET spent=9500 WHERE id=?').run('root');
  assert.throws(() => f.control.retireCell('leaf', input), { code: 'BUDGET' }); assert.equal(count(f.control, 'cell_retired'), 0);
});

test('safe-integer child allocations use exact sums rather than overflow or clamping', t => {
  const f = fixture(t, { budgetCents: Number.MAX_SAFE_INTEGER }); f.cell('a'); f.cell('b');
  f.control.db.prepare('UPDATE cells SET allocation=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, 'a');
  assert.throws(() => f.control.retireCell('a', retireInput(f.control, 'a')), { code: 'BUDGET' });
  assert.equal(f.control.status().cells.find(c => c.id === 'a').status, 'ready'); assert.equal(count(f.control, 'cell_retired'), 0);
});

test('paused logical retirement uses current factory CAS and rejects a corrupted root budget', t => {
  const f = fixture(t); f.cell('leaf'); const stale = retireInput(f.control, 'leaf'); f.control.pause();
  assert.throws(() => f.control.retireCell('leaf', stale), { code: 'STALE' });
  f.control.db.prepare('UPDATE cells SET allocation=10001 WHERE id=?').run('root');
  assert.throws(() => f.control.retireCell('leaf', retireInput(f.control, 'leaf')), { code: 'BUDGET' });
  f.control.db.prepare('UPDATE cells SET allocation=10000 WHERE id=?').run('root');
  assert.equal(f.control.retireCell('leaf', retireInput(f.control, 'leaf')).status, 'retired');
  assert.equal(f.control.control().status, 'paused'); assert.equal(count(f.control, 'cell_retired'), 1);
});

test('leaf retirement and child reservation cannot race into an orphan or double-released allocation', async t => {
  const f = fixture(t); f.cell('parent', 'coordinator', 2000); const input = retireInput(f.control, 'parent');
  const [retirement, reservation] = await Promise.all([
    child(f.filename, `console.log(JSON.stringify(c.retireCell('parent',${JSON.stringify(input)})))`),
    child(f.filename, "const result=c.reserveCell({cellId:'child',parentId:'parent',budgetCents:500,purpose:'child'});console.log(JSON.stringify({status:result.status}))"),
  ]);
  if (retirement.status === 'retired') {
    assert.equal(reservation.code, 'PARENT'); assert.equal(f.control.status().cells.some(c => c.id === 'child'), false);
  } else {
    assert.equal(retirement.code, 'CHILDREN'); assert.equal(reservation.status, 'reserved');
    assert.equal(f.control.status().cells.find(c => c.id === 'parent').status, 'ready'); assert.equal(count(f.control, 'cell_retired'), 0);
  }
});

test('task and project tokens require a currently ready owner even if identity and expiry still match', t => {
  const f = fixture(t); f.cell('dev'); f.cell('coordinator', 'coordinator'); f.task(); const task = f.control.claimTask('work', 'dev');
  f.control.admitEffect(task, { key: 'accepted', kind: 'flow_call', request: {} }); const project = f.control.claimIntegration('project', 'coordinator');
  f.control.db.prepare("UPDATE cells SET status='reserved' WHERE id IN (?,?)").run('dev', 'coordinator');
  for (const lease of [task, project]) assert.throws(() => f.control.renew(lease), { code: 'STALE' });
  assert.throws(() => f.control.startEffect(task, 'accepted'), { code: 'STALE' });
  assert.throws(() => f.control.admitEffect(task, { key: 'fresh', kind: 'flow_call', request: {} }), { code: 'STALE' });
  const artifact = path.join(f.dir, 'artifact'); writeFileSync(artifact, 'content'); assert.throws(() => f.control.submit(task, { artifactPath: artifact }), { code: 'STALE' });
});

test('retired coordinator loses its integration lease and fresh ownership is immediately available', t => {
  const f = fixture(t); f.cell('coordinator', 'coordinator'); const old = f.control.claimIntegration('project', 'coordinator');
  f.control.retireCell('coordinator', retireInput(f.control, 'coordinator'));
  assert.throws(() => f.control.renew(old), { code: 'STALE' }); const fresh = f.control.claimIntegration('project', 'root');
  assert.equal(fresh.epoch, old.epoch + 1); assert.equal(fresh.cellId, 'root');
});

test('verified producer retirement retains exact candidate/review history and fresh real Git delivery works', async t => {
  const f = fixture(t); f.cell('dev'); f.cell('verify', 'verifier'); const candidate = await reviewedCandidate(f), before = f.control.task('work');
  const artifactBytes = readFileSync(candidate.artifact), proofBytes = readFileSync(candidate.proof);
  f.control.retireCell('dev', retireInput(f.control, 'dev')); f.control.retireCell('verify', retireInput(f.control, 'verify'));
  const after = f.control.task('work'); assert.equal(after.status, 'verified'); assert.equal(after.owner, 'dev'); assert.equal(after.epoch, before.epoch);
  assert.deepEqual(after.candidate, before.candidate); assert.deepEqual(after.review, before.review); assert.equal(after.spec_digest, before.spec_digest);
  assert.deepEqual(readFileSync(candidate.artifact), artifactBytes); assert.deepEqual(readFileSync(candidate.proof), proofBytes);
  f.control.pause(); f.control.resume(); const integration = f.control.claimIntegration('project');
  const result = await executeGitDelivery(f.control, integration, { key: 'delivery', kind: 'delivery', taskId: 'work', request: candidate.request });
  assert.equal(result.effect.state, 'succeeded'); f.control.deliverTask('work', 'delivery');
  assert.equal(await git(candidate.repository, 'rev-parse', candidate.request.ref), candidate.request.candidateHead);
  assert.equal(f.control.task('work').status, 'delivered'); assert.equal(f.control.status().workerQuiescence, 'unverified');
});

test('project delivery attached to verified producer blocks its retirement until terminal', async t => {
  const f = fixture(t); f.cell('dev'); f.cell('verify', 'verifier'); const candidate = await reviewedCandidate(f);
  const integration = f.control.claimIntegration('project'); f.control.admitEffect(integration, { key: 'delivery', kind: 'delivery', taskId: 'work', request: candidate.request });
  assert.equal(f.control.openEffects('task', 'work').length, 0); assert.throws(() => f.control.retireCell('dev', retireInput(f.control, 'dev')), { code: 'UNRECONCILED' });
  f.control.startEffect(integration, 'delivery'); f.control.settleEffect('delivery', 'unknown', {});
  assert.throws(() => f.control.retireCell('dev', retireInput(f.control, 'dev')), { code: 'UNRECONCILED' });
  assert.equal(f.control.task('work').status, 'verified');
});

test('concurrent real project admission and coordinator retirement serialize without stale dispatch authority', async t => {
  const f = fixture(t); f.cell('dev'); f.cell('verify', 'verifier'); f.cell('coordinator', 'coordinator'); const candidate = await reviewedCandidate(f);
  const integration = f.control.claimIntegration('project', 'coordinator'), input = retireInput(f.control, 'coordinator');
  const [retired, admission] = await Promise.all([
    child(f.filename, `console.log(JSON.stringify(c.retireCell('coordinator',${JSON.stringify(input)})))`),
    child(f.filename, `const result=c.admitEffect(${JSON.stringify(integration)},${JSON.stringify({ key: 'delivery', kind: 'delivery', taskId: 'work', request: candidate.request })});console.log(JSON.stringify({fresh:result.fresh}))`),
  ]);
  if (retired.status === 'retired') {
    assert.equal(admission.code, 'STALE'); assert.equal(f.control.status().effects.length, 0);
  } else {
    assert.equal(retired.code, 'UNRECONCILED'); assert.equal(admission.fresh, true); assert.equal(f.control.effect('delivery').state, 'accepted');
  }
});

test('existing DTO stays atomic and private during closure while paid holds and revision remain independent', async t => {
  const f = fixture(t); f.cell('dev'); f.task(); const lease = f.control.claimTask('work', 'dev');
  f.control.db.prepare('UPDATE cells SET spent=125 WHERE id=?').run('dev');
  const spendingPath = path.join(f.dir, 'paid.sqlite'), ledger = new SpendingLedger(spendingPath);
  ledger.initialize({ limitCents: 10000, currency: 'USD' }); ledger.reserve({ reservationId: 'paid', provider: 'modal', ceilingCents: 3000 });
  ledger.start('paid'); ledger.observe('paid', { chargedCents: 4, observedAt: Date.now(), evidenceDigest: 'a'.repeat(64) });
  const paidBefore = ledger.status(), paidRevision = ledger.db.prepare('SELECT MAX(seq) AS n FROM spending_events').get().n;
  const token = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
  const server = await startPresentationServer({ databasePath: f.filename, spendingLedgerPath: spendingPath, factoryId: 'fixture', token, port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async route => {
    const response = await fetch(`${origin}${route}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    assert.equal(response.status, 200); return response.json();
  };
  try {
    const before = await read('/v1/snapshot');
    f.control.releaseTask('work', releaseInput(f.control, 'work', 'private-release-identity'));
    const input = retireInput(f.control, 'dev', 'private-retirement-identity');
    const reads = [read('/v1/snapshot'), read('/v1/snapshot'), read('/v1/snapshot')];
    const retired = child(f.filename, `console.log(JSON.stringify(c.retireCell('dev',${JSON.stringify(input)})))`);
    const snapshots = await Promise.all(reads); assert.equal((await retired).status, 'retired'); snapshots.push(await read('/v1/snapshot'));
    for (const body of snapshots) {
      assert.equal(decodeCursor(body.cursor), body.revision);
      const cell = body.snapshot.cells.find(row => row.id === 'dev');
      assert.equal(body.snapshot.budget.rootCommittedCents, cell.status === 'retired' ? 125 : 1000);
      const task = body.snapshot.tasks.find(row => row.id === 'work'); assert.equal(task.status, 'ready'); assert.equal(task.owner, null); assert.equal(task.leaseExpiry, null);
      assert.equal(body.snapshot.workerQuiescence, 'unverified'); assert.equal(body.snapshot.paidBudget.revision, paidRevision);
      assert.equal(body.snapshot.paidBudget.committedCents, 3000); assert.equal(body.snapshot.paidBudget.knownMeteredCents, 4); assert.equal(body.snapshot.paidBudget.meteredSpendCents, null);
      for (const privateValue of [lease.token, token, f.dir, 'private-release-identity', 'private-retirement-identity', 'token_hash', 'expectedFactoryEpoch'])
        assert.equal(JSON.stringify(body).includes(privateValue), false);
    }
    assert.ok(snapshots.at(-1).revision > before.revision); assert.equal(snapshots.at(-1).snapshot.cells.find(row => row.id === 'dev').status, 'retired');
    const events = await read('/v1/events'); assert.ok(events.events.some(row => row.type === 'task_released')); assert.ok(events.events.some(row => row.type === 'cell_retired'));
    assert.equal(JSON.stringify(events).includes('private-release-identity'), false); assert.equal(JSON.stringify(events).includes('private-retirement-identity'), false);
    assert.deepEqual(ledger.status(), paidBefore); assert.equal(ledger.db.prepare('SELECT MAX(seq) AS n FROM spending_events').get().n, paidRevision);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); ledger.close();
  }
});
