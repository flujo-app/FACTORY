import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FactoryControl } from '../src/control.mjs';
import { validateManifest, observePilot, runWatcher, readOnlyFlyRunner } from '../scripts/watch-pilot.mjs';

const runFile = promisify(execFile);
const NOW = 1_800_000_000_000;
const OWNER = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const IMAGE = `ghcr.io/example/worker@sha256:${'a'.repeat(64)}`;
const PRIVATE = 'secret-token-output-must-never-be-in-evidence';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-watcher-'));
  const databasePath = path.join(directory, 'control.sqlite');
  const control = new FactoryControl(databasePath, { clock: () => NOW });
  control.initialize({ mission: 'Watcher fixture', budgetCents: 10000, maxCells: 5, maxDepth: 2 });
  control.reserveCell({ cellId: 'live-watcher', role: 'watcher', budgetCents: 0, purpose: 'Independent process witness' });
  control.enrollCell('live-watcher');
  control.reserveCell({ cellId: 'parent-worker', role: 'developer', budgetCents: 5000, purpose: 'Parent fixture' });
  const raw = { format: 'factory-cloud-pilot', version: 1, runId: 'watch-fixture', databasePath,
    managedDirectory: path.join(directory, 'managed'), workspace: 'factory-pilot', org: 'personal',
    startedAt: NOW, deadline: NOW + 60_000, desiredState: 'retired', watcherId: 'live-watcher',
    workers: [{ worker: 'ff-fixture-parent', cellId: 'parent-worker', parentId: 'root', depth: 1 },
      { worker: 'ff-fixture-child', cellId: 'child-worker', parentId: 'parent-worker', depth: 2 }] };
  const manifestPath = path.join(directory, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(raw));
  const manifest = validateManifest(raw, manifestPath);
  t.after(async () => {
    control.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('factory-watcher-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, control, raw, manifest, manifestPath };
}

function provision(control) {
  control.createTask({ taskId: 'parent-task', projectId: 'pilot', branch: 'codex/watcher-fixture',
    specification: { problem: 'Fixture', acceptance: 'Observe', baseline: 'fixture' } });
  const lease = control.claimTask('parent-task', 'root');
  control.admitEffect(lease, { key: 'provision-parent', kind: 'provision', request: { cellId: 'parent-worker', app: 'ff-fixture-parent' } });
  control.startEffect(lease, 'provision-parent');
  return lease;
}

function inspector({ absent = false, state = 'started', wrongOwner = false, failure = false } = {}) {
  const journal = { app: 'ff-fixture-parent', org: 'personal', workspace: 'factory-pilot', owner: OWNER,
    appCreated: true, appId: 'ff-fixture-parent', ownershipConfirmed: true, image: IMAGE,
    machineId: 'machine-123', machineName: 'worker-fixture' };
  return {
    async deployment() { return { metadata: { id: journal.app, org: journal.org, workspace: journal.workspace,
      attemptId: ATTEMPT, image: IMAGE, journalOwner: OWNER, phase: 'ready', token: PRIVATE }, journal }; },
    async ownedApp() {
      if (failure) throw new Error(`Provider error ${PRIVATE}`);
      return absent ? null : { ID: journal.appId, Name: journal.app, Organization: { Slug: journal.org }, token: PRIVATE };
    },
    async machines() { return [{ id: journal.machineId, name: journal.machineName, state,
      image_ref: { digest: `sha256:${'a'.repeat(64)}` },
      config: { metadata: { flujo_cloud_owner: wrongOwner ? ATTEMPT : OWNER }, services: [], env: { TOKEN: PRIVATE } } }]; },
  };
}

test('watcher validates bounded exact manifest identities and desired retirement', async t => {
  const f = await fixture(t);
  assert.equal(f.manifest.workers.length, 2);
  for (const raw of [
    { ...f.raw, workers: [...f.raw.workers, { ...f.raw.workers[0] }] },
    { ...f.raw, workers: [f.raw.workers[0], { ...f.raw.workers[1], worker: f.raw.workers[0].worker }] },
    { ...f.raw, deadline: NOW + 900_001 },
    { ...f.raw, desiredState: 'running' },
    { ...f.raw, workers: [{ ...f.raw.workers[0], parentId: 'other-factory' }] },
  ]) assert.throws(() => validateManifest(raw, f.manifestPath), { code: 'WATCH_INPUT_INVALID' });
});

test('watcher never polls cloud slots before durable provisioning intent', async t => {
  const f = await fixture(t);
  const observed = await observePilot(f.manifest, { clock: () => NOW, inspector: {
    deployment() { throw new Error('Unadmitted cloud slot was polled.'); },
  } });
  assert.equal(observed.workers.every(worker => worker.provisionIntent === 'not-admitted'), true);
  assert.equal(observed.liveRetirementObserved, false);
  assert.equal(observed.scope, 'same-host-process-witness');
});

test('watcher independently records missed heartbeat, unresolved effect and deadline', async t => {
  const f = await fixture(t);
  provision(f.control);
  const observed = await observePilot(f.manifest, { clock: () => NOW + 120_000, inspector: inspector() });
  assert.deepEqual(observed.alerts, ['coordinator-heartbeat-missed', 'effects-unresolved', 'pilot-deadline-elapsed']);
  assert.deepEqual(observed.workers[0].provider, { source: 'fly-provider-live', status: 'owned-machines',
    machines: [{ machineId: 'machine-123', state: 'started' }] });
  assert.equal(observed.workerQuiescence, 'unverified');
  assert.equal(JSON.stringify(observed).includes(PRIVATE), false);
});

test('provider absence is live evidence and cached retirement alone never proves it', async t => {
  const f = await fixture(t);
  provision(f.control);
  const absent = await observePilot(f.manifest, { clock: () => NOW, inspector: inspector({ absent: true }) });
  assert.equal(absent.liveRetirementObserved, true);
  assert.equal(absent.workers[0].cached.phase, 'ready');
  assert.equal(absent.workers[0].provider.status, 'app-absent');
  assert.equal(absent.coordinator.unresolvedEffects.length, 1);
  const failed = await observePilot(f.manifest, { clock: () => NOW, inspector: inspector({ failure: true }) });
  assert.equal(failed.liveRetirementObserved, false);
  assert.equal(failed.workers[0].provider.status, 'unobserved');
  assert.equal(JSON.stringify(failed).includes(PRIVATE), false);
});

test('changed live machine identity and stopped machine do not imply retirement', async t => {
  const f = await fixture(t);
  provision(f.control);
  const changed = await observePilot(f.manifest, { clock: () => NOW, inspector: inspector({ wrongOwner: true }) });
  assert.equal(changed.workers[0].provider.status, 'identity-mismatch');
  assert.ok(changed.alerts.includes('worker-identity-mismatch'));
  const stopped = await observePilot(f.manifest, { clock: () => NOW, inspector: inspector({ state: 'stopped' }) });
  assert.equal(stopped.liveRetirementObserved, false);
  assert.equal(stopped.workers[0].provider.machines[0].state, 'stopped');
});

test('once watcher appends sanitized evidence and only its registered messages', async t => {
  const f = await fixture(t);
  provision(f.control);
  f.control.db.prepare('UPDATE effects SET receipt=? WHERE key=?').run(JSON.stringify({ body: PRIVATE }), 'provision-parent');
  const before = f.control.db.prepare('SELECT heartbeat FROM cells WHERE id=?').get('root').heartbeat;
  const options = { manifestPath: f.manifestPath, once: true, inspector: inspector(), clock: () => NOW };
  await runWatcher(options);
  await runWatcher({ ...options, clock: () => NOW + 1 });
  const lines = (await fs.readFile(f.manifest.evidencePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.match(lines[0].evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(lines).includes(PRIVATE), false);
  const messages = f.control.inbox('root');
  assert.equal(messages.length, 2);
  assert.equal(messages.every(message => message.sender === 'live-watcher' && message.payload.type === 'watcher_observation'), true);
  assert.equal(f.control.effect('provision-parent').state, 'running');
  assert.equal(f.control.db.prepare('SELECT heartbeat FROM cells WHERE id=?').get('root').heartbeat, before);
  await assert.rejects(fs.stat(path.join(f.directory, 'watch-pilot.lock')), { code: 'ENOENT' });
});

test('read-only Fly command guard rejects mutations and extra arguments before spawning', async () => {
  const fly = readOnlyFlyRunner(process.execPath, { allowedApps: ['ff-fixture-parent'] });
  for (const args of [['apps', 'destroy', 'ff-fixture-parent'], ['machine', 'stop', 'machine-123', '--app', 'ff-fixture-parent'],
    ['apps', 'list', '--org', 'personal', '--json', '--yes'], ['secrets', 'set', '--app', 'ff-fixture-parent', PRIVATE],
    ['machine', 'list', '--app', 'ff-other-parent', '--json'], ['apps', 'list', '--org', 'another-org', '--json']]) {
    await assert.rejects(fly.run(args), { code: 'WATCH_MUTATION_DENIED' });
  }
});

test('unavailable control state is appendable evidence and never prompts cloud guesses', async t => {
  const f = await fixture(t);
  const observation = await observePilot({ ...f.manifest, databasePath: path.join(f.directory, 'missing.sqlite') }, {
    clock: () => NOW + 120_000, inspector: { deployment() { throw new Error(`Unsafe guess ${PRIVATE}`); } },
  });
  assert.deepEqual(observation.alerts, ['control-state-unobserved', 'pilot-deadline-elapsed']);
  assert.equal(observation.liveRetirementObserved, false);
  assert.equal(observation.coordinator.unresolvedEffects, null);
  assert.equal(JSON.stringify(observation).includes(PRIVATE), false);
});

test('bounded watcher never sleeps over 60 seconds or permits over 15 minutes', async t => {
  const f = await fixture(t);
  let now = NOW, sleeps = [];
  await runWatcher({ manifestPath: f.manifestPath, durationMs: 2000, intervalMs: 1000,
    inspector: inspector(), clock: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  assert.deepEqual(sleeps, [1000, 1000]);
  await assert.rejects(runWatcher({ manifestPath: f.manifestPath, durationMs: 900_001, inspector: inspector() }), { code: 'WATCH_INPUT_INVALID' });
});

test('watcher CLI runs as a separate process without reaching cloud for unadmitted slots', async t => {
  const f = await fixture(t);
  const modulePath = path.join(f.directory, 'fake-managed.mjs');
  await fs.writeFile(modulePath, 'export class ManagedCloud { async runtime() { return {}; } async deployment() { throw new Error("Unexpected cloud read"); } }');
  const { stdout } = await runFile(process.execPath, [path.resolve('scripts/watch-pilot.mjs'), '--manifest', f.manifestPath,
    '--module-path', modulePath, '--fly-path', process.execPath, '--once', '--no-messages'], { timeout: 10_000, windowsHide: true });
  const output = JSON.parse(stdout.trim());
  assert.equal(output.scope, 'same-host-process-witness');
  assert.equal(output.workers.every(worker => worker.provisionIntent === 'not-admitted'), true);
  assert.equal(output.workerQuiescence, 'unverified');
  assert.equal(JSON.stringify(output).includes(PRIVATE), false);
});
