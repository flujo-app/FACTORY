import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryControl } from '../src/control.mjs';
import { FixtureModelStepLedger, fixtureParentKey, fixtureParentRequest } from './fixtures/native-model-step-ledger.mjs';

const SHA = value => createHash('sha256').update(value).digest('hex');
const childFile = fileURLToPath(new URL('./fixtures/native-model-step-claim-child.mjs', import.meta.url));

async function fixture(t, { clock = Date.now } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-model-step-fixture-'));
  const database = path.join(directory, 'control.sqlite');
  let control = new FactoryControl(database, { clock });
  t.after(() => control.close());
  control.initialize({ mission: 'fixture', budgetCents: 1000, maxCells: 2, maxDepth: 1 });
  const specification = { problem: 'Synthetic original Flow', acceptance: ['fixture only'], baseline: 'fixture',
    fixtureOriginalFlow: { schemaVersion: 2, confidentialityClass: 'ordinary', flowSha256: SHA('flow'),
      stepPlan: [{ stepId: 'model-1', selectedManifestSha256: SHA('selected manifest'),
        roleGraphSha256: SHA('role graph') }] } };
  control.createTask({ taskId: 'original', projectId: 'fixture', branch: 'codex/original', specification });
  const lease = control.claimTask('original', 'root', 600000);
  const task = control.task('original');
  const parentRequest = fixtureParentRequest(task, lease), parentKey = fixtureParentKey(parentRequest);
  control.admitEffect(lease, { key: parentKey, kind: 'flow_call', request: parentRequest });
  control.startEffect(lease, parentKey);
  const ledger = new FixtureModelStepLedger(control);
  ledger.initialize();
  const input = { stepId: 'model-1', requestIdSha256: SHA('private request id'), bodySha256: SHA('private prompt') };
  return { directory, database, lease, parentKey, input, get control() { return control; },
    get ledger() { return new FixtureModelStepLedger(control); },
    reopen() { control.close(); control = new FactoryControl(database, { clock }); } };
}

function claimant() {
  const child = spawn(process.execPath, [childFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.startsWith('READY\n')) readyResolve(); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', readyReject);
  const done = new Promise((resolve, reject) => child.on('close', code => {
    if (code !== 0) reject(new Error(`claim child exited ${code}: ${stderr}`));
    else {
      const lines = stdout.trim().split(/\r?\n/);
      try { assert.equal(lines[0], 'READY'); assert.equal(lines.length, 2); resolve(JSON.parse(lines[1])); }
      catch (error) { reject(error); }
    }
  }));
  return { ready, done, send: input => { child.stdin.end(JSON.stringify(input) + '\n'); } };
}

test('fixture registration binds one immutable ordinary step without storing private model data', async t => {
  const f = await fixture(t);
  const first = f.ledger.register(f.lease, f.parentKey, f.input);
  assert.equal(first.fresh, true);
  assert.deepEqual(f.ledger.register(f.lease, f.parentKey, f.input), { ...first, fresh: false });
  assert.throws(() => f.ledger.register(f.lease, f.parentKey, { ...f.input, bodySha256: SHA('changed body') }),
    { code: 'FIXTURE_CONFLICT' });
  assert.throws(() => f.ledger.register(f.lease, f.parentKey, { ...f.input, requestIdSha256: SHA('changed request id') }),
    { code: 'FIXTURE_CONFLICT' });
  assert.throws(() => f.ledger.register(f.lease, f.parentKey, { ...f.input, stepId: 'unplanned' }),
    { code: 'FIXTURE_STEP' });
  const recorded = f.ledger.record(first.key);
  assert.equal(recorded.state, 'registered');
  assert.equal(recorded.body_sha256, f.input.bodySha256);
  assert.equal(recorded.request_id_sha256, f.input.requestIdSha256);
  assert.equal(JSON.stringify(recorded).includes('private prompt'), false);
  assert.equal(JSON.stringify(recorded).includes('private request id'), false);
  assert.equal(f.control.db.prepare('SELECT COUNT(*) AS count FROM fixture_model_steps').get().count, 1);
});

test('fixture refuses v1 native history, changed lease, paused epoch and settled parent', async t => {
  const f = await fixture(t);
  const registered = f.ledger.register(f.lease, f.parentKey, f.input);
  assert.throws(() => f.ledger.claim({ ...f.lease, token: 'forged' }, registered.key), { code: 'STALE' });
  f.control.pause();
  assert.throws(() => f.ledger.register(f.lease, f.parentKey, f.input), { code: 'PAUSED' });
  assert.throws(() => f.ledger.claim(f.lease, registered.key), { code: 'PAUSED' });
  assert.equal(f.ledger.record(registered.key).state, 'registered');

  const other = await fixture(t);
  const step = other.ledger.register(other.lease, other.parentKey, other.input);
  other.control.settleEffect(other.parentKey, 'succeeded', { fixture: true });
  assert.throws(() => other.ledger.register(other.lease, other.parentKey, other.input), { code: 'FIXTURE_PARENT' });
  assert.throws(() => other.ledger.claim(other.lease, step.key), { code: 'FIXTURE_PARENT' });

  const legacy = await fixture(t);
  const oldSpec = { problem: 'Legacy task', acceptance: ['fixture'], baseline: 'fixture',
    nativeMission: { schemaVersion: 1, missionId: 'a'.repeat(32), cellId: 'root', app: 'fixture-app',
      provisionKey: 'old-provision', worker: { workspace: 'fixture', archiveSha256: SHA('archive'),
        compatibility: { applicationVersion: '3.46.0', snapshotFormatVersion: 2,
          layoutVersion: 2, workerProtocolVersion: 1 } }, flowId: 'old', flowSha256: SHA('old'),
      paid: { provider: 'fixture', ceilingCents: 1 } } };
  legacy.control.createTask({ taskId: 'legacy', projectId: 'fixture', branch: 'codex/legacy', specification: oldSpec });
  const oldLease = legacy.control.claimTask('legacy', 'root', 600000);
  assert.throws(() => fixtureParentRequest(legacy.control.task('legacy'), oldLease), { code: 'FIXTURE_ORIGINAL_V2' });
});

test('two actual processes serialize one conditional claim; restart and lost ACK never reissue it', { timeout: 30000 }, async t => {
  const f = await fixture(t), registered = f.ledger.register(f.lease, f.parentKey, f.input);
  const one = claimant(), two = claimant();
  await Promise.all([one.ready, two.ready]);
  const message = { database: f.database, lease: f.lease, key: registered.key };
  one.send(message); two.send(message);
  const outcomes = await Promise.all([one.done, two.done]);
  assert.deepEqual(outcomes.map(item => item.result?.claimed).sort(), [false, true]);
  assert.equal(f.ledger.record(registered.key).state, 'claimed');
  f.reopen();
  assert.deepEqual(f.ledger.claim(f.lease, registered.key), { key: registered.key, claimed: false, state: 'claimed' });
  assert.equal(f.ledger.markUnknown(registered.key).state, 'unknown');
  assert.deepEqual(f.ledger.claim(f.lease, registered.key), { key: registered.key, claimed: false, state: 'unknown' });
});

test('the unintegrated controller still allows parent success and task submission after child claim', async t => {
  const f = await fixture(t), step = f.ledger.register(f.lease, f.parentKey, f.input);
  assert.equal(f.ledger.claim(f.lease, step.key).claimed, true);
  f.control.settleEffect(f.parentKey, 'succeeded', { fixture: true });
  const artifactPath = path.join(f.directory, 'candidate.txt');
  await fs.writeFile(artifactPath, 'fixture candidate');
  assert.equal(f.control.submit(f.lease, { artifactPath }).status, 'review');
  assert.equal(f.ledger.record(step.key).state, 'claimed');
});
