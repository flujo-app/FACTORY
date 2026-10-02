import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { FactoryControl } from '../src/control.mjs';
import { executeEffect } from '../src/gateway.mjs';

const baseline = 'a'.repeat(40);
const candidateHead = 'b'.repeat(40);
const branch = 'codex/approach-a';
const ref = 'refs/heads/integration';

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'factory-review-regression-'));
  let now = 1000;
  const control = new FactoryControl(join(directory, 'control.sqlite'), { clock: () => now });
  control.initialize({ mission: 'Review factory effect boundaries', budgetCents: 1000, maxCells: 8 });
  for (const [cellId, role] of [['developer', 'developer'], ['verifier', 'verifier']]) {
    control.reserveCell({ cellId, role, budgetCents: 100, purpose: role });
    control.enrollCell(cellId);
  }
  const repository = join(directory, 'repository');
  control.createTask({
    taskId: 'fix', projectId: 'project', branch,
    specification: {
      problem: 'Deliver the independently reviewed candidate',
      acceptance: 'Only the reviewed head may update the pinned target',
      baseline, deliveryTarget: { repository, ref },
    },
  });
  const proof = join(directory, 'review.txt');
  writeFileSync(proof, 'Independent checks passed for the recorded candidate.');
  t.after(() => {
    control.close();
    assert.equal(dirname(directory), parent);
    assert.ok(basename(directory).startsWith('factory-review-regression-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    control, directory, repository, proof,
    advance(time) { now = time; },
    candidate(fields = {}) {
      const artifactPath = join(directory, 'candidate.json');
      writeFileSync(artifactPath, JSON.stringify({ repository, ref, baseline, candidateHead, branch, ...fields }));
      const lease = control.claimTask('fix', 'developer');
      control.submit(lease, { artifactPath });
      control.reviewTask('fix', 'verifier', { accepted: true, evidencePath: proof });
      return control.claimIntegration('project');
    },
    request(fields = {}) { return { repository, ref, expectedHead: baseline, candidateHead, ...fields }; },
  };
}

test('nested allocation conservation is enforced while fleet capacity remains available', t => {
  const f = fixture(t);
  const child = { cellId: 'child', parentId: 'developer', budgetCents: 80, purpose: 'bounded subtask' };
  f.control.reserveCell(child);
  f.control.reserveCell(child);
  assert.equal(f.control.status().cells.filter(cell => cell.id === 'child').length, 1);
  assert.throws(() => f.control.reserveCell({
    cellId: 'overspent-child', parentId: 'developer', budgetCents: 21, purpose: 'exceeds remaining allocation',
  }), { code: 'BUDGET' });
  // A grandchild consumes its parent's allocation, not a second root allocation.
  f.control.reserveCell({ cellId: 'root-extra', budgetCents: 750, purpose: 'remaining root allocation' });
  assert.throws(() => f.control.reserveCell({
    cellId: 'overspent-root', budgetCents: 51, purpose: 'exceeds remaining root allocation',
  }), { code: 'BUDGET' });
  assert.throws(() => f.control.reserveCell({ ...child, budgetCents: 81 }), { code: 'CONFLICT' });
  assert.equal(f.control.status().cells.length, 5);
});

test('delivery admission binds head, baseline and target to independently reviewed bytes', t => {
  const f = fixture(t);
  const lease = f.candidate();
  const altered = [
    { candidateHead: 'c'.repeat(40) },
    { expectedHead: 'd'.repeat(40) },
    { repository: join(f.directory, 'different-repository') },
    { ref: 'refs/heads/another-target' },
  ];
  for (const [index, fields] of altered.entries()) {
    assert.throws(() => f.control.admitEffect(lease, {
      key: `unreviewed-${index}`, kind: 'delivery', taskId: 'fix', request: f.request(fields),
    }), { code: 'DELIVERY_BINDING' });
  }
  assert.equal(f.control.status().effects.length, 0);
  const allowed = f.control.admitEffect(lease, {
    key: 'reviewed', kind: 'delivery', taskId: 'fix', request: f.request(),
  });
  assert.equal(allowed.fresh, true);
});

test('a reviewed artifact cannot declare another task branch', t => {
  const f = fixture(t);
  assert.throws(() => {
    const lease = f.candidate({ branch: 'codex/another-approach' });
    f.control.admitEffect(lease, {
      key: 'wrong-branch', kind: 'delivery', taskId: 'fix', request: f.request(),
    });
  }, { code: 'DELIVERY_BINDING' });
  assert.equal(f.control.status().effects.length, 0);
});

test('retrying a delivered task observes its matching receipt without dispatching again', async t => {
  const f = fixture(t);
  const lease = f.candidate();
  const intent = { key: 'delivered-once', kind: 'delivery', taskId: 'fix', request: f.request() };
  const receipt = { ref, previousHead: baseline, head: candidateHead };
  let calls = 0;
  const first = await executeEffect(f.control, lease, intent, async () => { calls++; return receipt; });
  assert.equal(first.effect.state, 'succeeded');
  f.control.deliverTask('fix', intent.key);
  const retried = await executeEffect(f.control, lease, intent, async () => { calls++; return receipt; });
  assert.equal(retried.dispatched, false);
  assert.equal(retried.effect.state, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(f.control.task('fix').status, 'delivered');
});

test('delivery finalization replay preserves the result without recording a second completion', t => {
  const f = fixture(t);
  const lease = f.candidate();
  f.control.admitEffect(lease, { key: 'finalized-once', kind: 'delivery', taskId: 'fix', request: f.request() });
  f.control.startEffect(lease, 'finalized-once');
  f.control.settleEffect('finalized-once', 'succeeded', { ref, previousHead: baseline, head: candidateHead });
  f.control.deliverTask('fix', 'finalized-once');
  const replayed = f.control.deliverTask('fix', 'finalized-once');
  assert.equal(replayed.status, 'delivered');
  assert.equal(f.control.db.prepare("SELECT count(*) AS count FROM events WHERE type='task_delivered'").get().count, 1);
});

test('an observation that a running effect has not yet applied cannot permit takeover', async t => {
  const f = fixture(t);
  const old = f.control.claimTask('fix', 'developer', 10);
  let release;
  let operationFinished = false;
  const waiting = new Promise(resolve => { release = resolve; });
  const pending = executeEffect(f.control, old, {
    key: 'in-flight', kind: 'flow_call', request: { conversationId: 'original' },
  }, async () => {
    await waiting;
    operationFinished = true;
    return { state: 'completed' };
  });
  try {
    assert.equal(f.control.effect('in-flight').state, 'running');
    f.advance(1011);
    assert.throws(() => f.control.reconcileEffect('in-flight', {
      applied: false, evidencePath: f.proof,
    }), { code: 'NEGATIVE_RECONCILIATION_UNSUPPORTED' });
    assert.equal(f.control.effect('in-flight').state, 'running');
    assert.throws(() => f.control.claimTask('fix', 'root'), { code: 'UNRECONCILED' });
    assert.equal(operationFinished, false);
  } finally {
    release();
    await pending;
  }
  assert.equal(operationFinished, true);
  assert.equal(f.control.effect('in-flight').state, 'succeeded');
  assert.equal(f.control.claimTask('fix', 'root').epoch, 2);
});

test('unknown dispatched effects also cannot be cleared by negative reconciliation', async t => {
  const f = fixture(t);
  const lease = f.control.claimTask('fix', 'developer', 10);
  await executeEffect(f.control, lease, {
    key: 'lost-response', kind: 'flow_call', request: { conversationId: 'original' },
  }, async () => { throw new Error('The remote outcome is unknown.'); });
  f.advance(1011);
  assert.throws(() => f.control.reconcileEffect('lost-response', {
    applied: false, evidencePath: f.proof,
  }), { code: 'NEGATIVE_RECONCILIATION_UNSUPPORTED' });
  assert.equal(f.control.effect('lost-response').state, 'unknown');
  assert.throws(() => f.control.claimTask('fix', 'root'), { code: 'UNRECONCILED' });
});

test('an accepted intent that never started can be safely cancelled before takeover', t => {
  const f = fixture(t);
  const lease = f.control.claimTask('fix', 'developer', 10);
  f.control.admitEffect(lease, { key: 'never-started', kind: 'flow_call', request: {} });
  const settled = f.control.reconcileEffect('never-started', { applied: false, evidencePath: f.proof });
  assert.equal(settled.state, 'not_applied');
  assert.throws(() => f.control.startEffect(lease, 'never-started'), { code: 'EFFECT' });
  f.advance(1011);
  assert.equal(f.control.claimTask('fix', 'root').epoch, 2);
});

test('raw Flow output without a private destination never appears in operational status', async t => {
  const f = fixture(t);
  const lease = f.control.claimTask('fix', 'developer');
  const output = 'UNTRUSTED_PRIVATE_OUTPUT_47ea6e';
  const result = await executeEffect(f.control, lease, {
    key: 'missing-output-path', kind: 'flow_call', request: {},
  }, async () => ({ contentType: 'text/plain', body: output }));
  assert.equal(result.effect.state, 'unknown');
  assert.equal(JSON.stringify(f.control.status()).includes(output), false);
  const events = f.control.db.prepare('SELECT details FROM events').all();
  assert.equal(JSON.stringify(events).includes(output), false);
});

test('Flow output is stored privately with only a path, hash and content type in its receipt', async t => {
  const f = fixture(t);
  const lease = f.control.claimTask('fix', 'developer');
  const output = 'UNTRUSTED_PRIVATE_OUTPUT_f7b3b9';
  const outputPath = join(f.directory, 'private-output.txt');
  const result = await executeEffect(f.control, lease, {
    key: 'private-output', kind: 'flow_call', request: {},
  }, async () => ({ contentType: 'text/plain', body: output }), { outputPath });
  assert.equal(result.effect.state, 'succeeded');
  assert.equal(readFileSync(outputPath, 'utf8'), output);
  assert.equal(result.effect.receipt.outputPath, outputPath);
  assert.equal(result.effect.receipt.outputSha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(result.effect.receipt.contentType, 'text/plain');
  assert.equal(JSON.stringify(f.control.status()).includes(output), false);
  const events = f.control.db.prepare('SELECT details FROM events').all();
  assert.equal(JSON.stringify(events).includes(output), false);
});

test('direct settlement also withholds arbitrary secret-bearing receipt fields', t => {
  const f = fixture(t);
  const lease = f.control.claimTask('fix', 'developer');
  f.control.admitEffect(lease, { key: 'admin-receipt', kind: 'flow_call', request: {} });
  f.control.startEffect(lease, 'admin-receipt');
  const result = f.control.settleEffect('admin-receipt', 'succeeded', {
    body: 'DO_NOT_PERSIST_MODEL_OUTPUT', token: 'DO_NOT_PERSIST_CREDENTIAL',
  });
  assert.equal(result.receipt.body, undefined);
  assert.equal(result.receipt.token, undefined);
  assert.equal(JSON.stringify(f.control.status()).includes('DO_NOT_PERSIST'), false);
});
