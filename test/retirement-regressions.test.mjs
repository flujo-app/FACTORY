import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { FactoryControl } from '../src/control.mjs';
import { executeOwnedRetirement } from '../src/retirement.mjs';

const app = 'factory-recorded-worker';

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'factory-retirement-regression-'));
  const control = new FactoryControl(join(directory, 'control.sqlite'));
  control.initialize({ mission: 'Bounded owned retirement', budgetCents: 1000, maxCells: 2 });
  control.reserveCell({ cellId: 'cloud', budgetCents: 500, purpose: 'Explicit cloud worker' });
  control.createTask({
    taskId: 'provision', projectId: 'project', branch: 'codex/provision',
    specification: { problem: 'Create one worker', acceptance: 'Owned worker available', baseline: 'pinned' },
  });
  const lease = control.claimTask('provision', 'root');
  control.admitEffect(lease, { key: 'recorded-provision', kind: 'provision', request: { cellId: 'cloud', app } });
  control.startEffect(lease, 'recorded-provision');
  t.after(() => {
    control.close();
    assert.equal(dirname(directory), parent);
    assert.ok(basename(directory).startsWith('factory-retirement-regression-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return { control, lease };
}

test('pause permits narrow recorded-app retirement while preserving unresolved work', async t => {
  const { control, lease } = fixture(t);
  control.pause();
  let calls = 0;
  const result = await executeOwnedRetirement(control, { key: 'retire-recorded', app }, async () => {
    calls++;
    return { app, state: 'destroyed', retirement: 'cloud-confirmed', body: 'PRIVATE_UNRELATED_BODY' };
  });
  assert.equal(result.effect.state, 'succeeded');
  assert.equal(result.effect.scope, 'cleanup');
  assert.equal(result.effect.scope_id, app);
  assert.equal(result.effect.kind, 'retire');
  assert.equal(result.effect.receipt.app, app);
  assert.equal(result.effect.receipt.state, 'destroyed');
  assert.equal(calls, 1);
  assert.equal(control.effect('recorded-provision').state, 'running');
  assert.equal(control.status().control.status, 'paused');
  assert.equal(control.status().effectsDrained, false);
  assert.equal(JSON.stringify(control.status()).includes('PRIVATE_UNRELATED_BODY'), false);
  assert.throws(() => control.admitEffect(lease, {
    key: 'new-work', kind: 'flow_call', request: {},
  }), { code: 'PAUSED' });
});

test('an unbound app cannot invoke retirement or acquire cleanup authority', async t => {
  const { control } = fixture(t);
  control.pause();
  let calls = 0;
  await assert.rejects(executeOwnedRetirement(control, {
    key: 'unbound-retirement', app: 'factory-unbound-worker',
  }, async () => { calls++; return { app: 'factory-unbound-worker', state: 'destroyed' }; }), { code: 'RESERVATION' });
  assert.equal(calls, 0);
  assert.equal(control.status().effects.filter(effect => effect.kind === 'retire').length, 0);
});

test('completed cleanup intent replays its receipt across control epochs without dispatch', async t => {
  const { control } = fixture(t);
  control.pause();
  let calls = 0;
  const operation = async () => { calls++; return { app, state: 'destroyed' }; };
  const intent = { key: 'stable-retirement', app };
  const first = await executeOwnedRetirement(control, intent, operation);
  control.resume();
  control.pause();
  const replayed = await executeOwnedRetirement(control, intent, operation);
  assert.equal(first.dispatched, true);
  assert.equal(replayed.dispatched, false);
  assert.equal(replayed.effect.state, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(control.status().effects.filter(effect => effect.scope === 'cleanup').length, 1);
});

test('wrong app identity and nonterminal provider receipts remain unknown', async t => {
  for (const [name, receipt] of [
    ['wrong-app', { app: 'factory-different-worker', state: 'destroyed' }],
    ['not-destroyed', { app, state: 'ready' }],
  ]) {
    await t.test(name, async subtest => {
      const { control } = fixture(subtest);
      control.pause();
      const result = await executeOwnedRetirement(control, { key: 'unconfirmed-retirement', app }, async () => receipt);
      assert.equal(result.effect.state, 'unknown');
      assert.equal(result.effect.receipt.app, undefined);
      assert.equal(control.effect('recorded-provision').state, 'running');
    });
  }
});

test('unknown cleanup is never blindly retried under its own or a new key', async t => {
  const { control } = fixture(t);
  control.pause();
  let calls = 0;
  const operation = async () => { calls++; throw new Error('Lost retirement acknowledgement with PRIVATE_EXCEPTION'); };
  const intent = { key: 'uncertain-retirement', app };
  const first = await executeOwnedRetirement(control, intent, operation);
  const replayed = await executeOwnedRetirement(control, intent, operation);
  assert.equal(first.effect.state, 'unknown');
  assert.equal(replayed.dispatched, false);
  await assert.rejects(executeOwnedRetirement(control, { key: 'replacement-retirement', app }, operation), { code: 'UNRECONCILED' });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(control.status()).includes('PRIVATE_EXCEPTION'), false);
});

test('retirement authority cannot be repurposed into general dispatch through extra fields', t => {
  const { control } = fixture(t);
  control.pause();
  const admitted = control.admitOwnedRetirement({
    key: 'fixed-cleanup-kind', app, kind: 'flow_call', scope: 'task', request: { arbitrary: true },
  });
  assert.equal(admitted.effect.kind, 'retire');
  assert.equal(admitted.effect.scope, 'cleanup');
  assert.equal(admitted.effect.scope_id, app);
  assert.throws(() => control.startOwnedRetirement('recorded-provision'), { code: 'EFFECT' });
});
