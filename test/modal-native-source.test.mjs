import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import * as privateFiles from '../deploy/private-files.mjs';
import { digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { createManagedCloudSourceBinding, nativeManagedCloudSourceIdentity } from '../src/adapters/managed-cloud-source.mjs';
import { ModalJournal, modalSourceIdentity, modalPreparationSummary, prepareModalPilot, runModalPilot } from '../scripts/modal-pilot.mjs';

const compatibility = { applicationVersion: '3.46.2', snapshotFormatVersion: 2, layoutVersion: 2,
  workerProtocolVersion: 1, revision: 'c'.repeat(40) };
const invalid = { code: 'MANAGED_CLOUD_INPUT_INVALID' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-modal-native-source-'));
  await privateFiles.ensurePrivateDirectory(directory);
  const state = { token: randomBytes(32).toString('base64url'), archive: 'b'.repeat(64), compatibility: { ...compatibility },
    workspace: 'factory-pilot', models: [], flows: [], routes: [], driverCalls: [], mutation: null };
  const inFlight = new Set(), handlerErrors = [];
  const server = http.createServer((request, response) => {
    const work = (async () => {
    state.routes.push({ path: request.url, method: request.method });
    if (request.headers.authorization !== 'Bearer ' + state.token) { response.writeHead(401); response.end('{}'); return; }
    if (request.method !== 'GET') { response.writeHead(405); response.end('{}'); return; }
    await state.mutation?.(request.url);
    const values = {
      '/api/worker/status': { mode: 'worker', state: 'ready', workspace: state.workspace, archiveSha256: state.archive },
      '/api/snapshot/info?workspace=factory-pilot': { workspace: state.workspace, capability: 'available', activeOperation: null,
        workerCompatibility: state.compatibility },
      '/api/workspaces': { workspaces: [{ name: state.workspace }] },
      '/api/model': state.models, '/api/flow': state.flows,
    };
    response.writeHead(Object.hasOwn(values, request.url) ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(values[request.url] ?? {}));
    })();
    inFlight.add(work);
    void work.then(() => inFlight.delete(work), error => {
      handlerErrors.push(error); inFlight.delete(work); response.destroy();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = { schemaVersion: 1, origin: 'http://127.0.0.1:' + server.address().port,
    tokenFile: path.join(directory, 'token.private.json'), dataRoot: path.join(directory, 'configured-namespace'),
    worker: { workspace: state.workspace, archiveSha256: state.archive, compatibility: { ...compatibility } } };
  const profilePath = path.join(directory, 'profile.private.json'), evidencePath = path.join(directory, 'synthetic-read-only-ownership.private.json');
  await privateFiles.writePrivateJson(profile.tokenFile, { token: state.token }, { exclusive: true });
  await privateFiles.writePrivateJson(profilePath, profile, { exclusive: true });
  const binding = createManagedCloudSourceBinding({ sourceWorkerProfile: profile, privateFiles, nativeProfilePath: profilePath });
  const [source] = await binding.discover();
  const identity = modalSourceIdentity(source), sourceIdentitySha256 = digest(identity);
  // Synthetic bindings in an owned test namespace are not an initializer or
  // authority receipt. Native run is held even if this entire record matches.
  const proof = { workspace: 'factory-pilot', archiveSha256: state.archive, compatibility: { ...compatibility },
    receiptSha256: 'd'.repeat(64), sourceIdentitySha256 };
  const evidence = { format: 'factory-modal-native-source-ownership', schemaVersion: 1, source: identity,
    initializer: { kind: 'factory-pilot-native-initializer', runId: 'offline-native', workspace: 'factory-pilot',
      sourceRevision: compatibility.revision, sourceSha256: 'e'.repeat(64), receiptSha256: 'f'.repeat(64), sourceIdentitySha256,
      bootstrapArchiveSha256: '9'.repeat(64), bootstrapSourceIdentitySha256: '8'.repeat(64) },
    bootstrap: { ...proof, archiveSha256: '9'.repeat(64), sourceIdentitySha256: '8'.repeat(64) }, capture: { ...proof },
    baseline: { workspace: 'factory-pilot', models: [], flows: [], catalogSha256: digest({ models: [], flows: [] }) } };
  await privateFiles.writePrivateJson(evidencePath, evidence, { exclusive: true });
  // Exercise the frozen real service class, with only its source transport and
  // read-only Modal driver injected. No service runtime/provider is started.
  const modulePath = fileURLToPath(new URL('../deploy/managed-cloud/lib/managed.mjs', import.meta.url));
  const options = { runId: 'offline-native', modulePath, source: profile.origin, sourceWorkerProfilePath: profilePath,
    sourceEvidencePath: evidencePath, runDirectory: path.join(directory, 'run'), spendingPath: path.join(directory, 'paid.sqlite') };
  const dependencies = { privateFiles, driver: async payload => { state.driverCalls.push(payload.operation);
    assert.equal(payload.operation, 'prepare');
    return { state: 'prepared', credentialsAccepted: true, environment: 'main', profile: 'synthetic-profile', workspaceName: 'synthetic-account',
      appAbsent: true, volumeAbsent: true, modelArtifactValidation: payload.modelArtifactValidation, httpResumeValidation: payload.httpResumeValidation }; } };
  state.routes.length = 0;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await Promise.allSettled([...inFlight]); assert.deepEqual(handlerErrors, []);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('factory-modal-native-source-'));
    await rm(directory, { recursive: true, force: true }); });
  return { directory, state, profile, profilePath, evidence, evidencePath, identity, source, binding, options, dependencies };
}

test('native Modal preparation constructs raw ManagedCloud with authenticated discovery and remains read-only and held', async t => {
  const f = await fixture(t), prepared = await prepareModalPilot(f.options, f.dependencies);
  assert.equal(prepared.mode, 'prepare-read-only'); assert.deepEqual(prepared.source, f.identity);
  assert.equal(prepared.nativeOwnership.state, 'bindings-validated-read-only');
  assert.equal(prepared.nativeOwnership.initializerVerified, false); assert.equal(prepared.nativeOwnership.receiptBytesVerified, false);
  assert.equal(prepared.nativeOwnership.executionAdmission, 'HOLD');
  assert.deepEqual(modalPreparationSummary(prepared).nativeOwnership, prepared.nativeOwnership);
  assert.equal(modalPreparationSummary(prepared).nativeOwnership.required, 'qualified-owned-factory-pilot-initializer');
  assert.deepEqual(f.state.driverCalls, ['prepare']); assert.ok(f.state.routes.some(row => row.path === '/api/worker/status'));
  assert.ok(f.state.routes.every(row => row.method === 'GET'));
  assert.ok(!(await readdir(f.directory)).includes('run')); assert.ok(!(await readdir(f.directory)).includes('paid.sqlite'));
  assert.equal(JSON.stringify(prepared).includes(f.state.token), false);
});

test('native identity is explicit JSON-stable private metadata without fabricated desktop fields or credential enumeration', async t => {
  const f = await fixture(t), identity = modalSourceIdentity(f.source);
  assert.notEqual(f.evidence.bootstrap.archiveSha256, f.evidence.capture.archiveSha256);
  assert.notEqual(f.evidence.bootstrap.sourceIdentitySha256, f.evidence.capture.sourceIdentitySha256);
  assert.deepEqual(Object.keys(f.source), ['source', 'dataRoot']);
  for (const field of ['token', 'nativeIdentity']) assert.equal(Object.getOwnPropertyDescriptor(f.source, field).enumerable, false);
  for (const field of ['instanceId', 'appRoot', 'pid']) assert.equal(Object.hasOwn(f.source, field), false);
  assert.deepEqual(Object.keys(identity), ['kind', 'schemaVersion', 'origin', 'dataRoot', 'worker', 'profile', 'credential']);
  assert.deepEqual(identity.worker.compatibility, compatibility); assert.equal(identity.worker.archiveSha256, f.state.archive);
  assert.equal(identity.dataRoot, f.profile.dataRoot); // Configured namespace, not an API attestation.
  assert.equal(digest(JSON.parse(JSON.stringify(identity))), digest(identity)); assert.equal(JSON.stringify(identity).includes(f.state.token), false);
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.worker.compatibility));
  assert.equal(nativeManagedCloudSourceIdentity({ ...f.source }), null);
  const desktop = { source: 'http://127.0.0.1:4200', instanceId: 'original-instance', appRoot: 'app', dataRoot: 'data' };
  assert.equal(JSON.stringify(modalSourceIdentity(desktop)), '{"origin":"http://127.0.0.1:4200","instanceId":"original-instance","appRoot":"app","dataRoot":"data"}');
});

test('profile-only native preparation derives the strict profile origin rather than the legacy desktop default', async t => {
  const f = await fixture(t), prepared = await prepareModalPilot({ ...f.options, source: undefined }, f.dependencies);
  assert.equal(prepared.options.source, f.profile.origin); assert.equal(prepared.source.origin, f.profile.origin);
  assert.deepEqual(f.state.driverCalls, ['prepare']); assert.equal(prepared.nativeOwnership.executionAdmission, 'HOLD');
});

test('native pilot requires explicit strict private profile, full revision and factory-pilot instead of service-smoke or injected thin service', async t => {
  const f = await fixture(t), missing = structuredClone(f.profile); delete missing.worker.compatibility.revision;
  assert.throws(() => createManagedCloudSourceBinding({ sourceWorkerProfile: missing, privateFiles, nativeProfilePath: f.profilePath }), invalid);
  const wrong = { ...f.profile, worker: { ...f.profile.worker, workspace: 'factory-service-smoke' } };
  await privateFiles.writePrivateJson(f.profilePath, wrong);
  await assert.rejects(prepareModalPilot(f.options, f.dependencies), { code: 'NATIVE_FACTORY_PILOT_PROFILE_REQUIRED' });
  await assert.rejects(prepareModalPilot(f.options, { ...f.dependencies, managed: {} }), { code: 'NATIVE_RAW_MANAGED_CONSTRUCTION_REQUIRED' });
  await assert.rejects(prepareModalPilot({ ...f.options, sourceWorkerProfilePath: 'relative' }, f.dependencies), { code: 'NATIVE_SOURCE_PROFILE_REQUIRED' });
  assert.deepEqual(f.state.routes, []); assert.deepEqual(f.state.driverCalls, []);
});

test('desktop false-ownership and altered initializer/bootstrap/capture bindings do not become native ownership', async t => {
  const f = await fixture(t);
  for (const evidence of [{ source: f.identity, fixtureAlreadyExists: false },
    { ...f.evidence, initializer: { ...f.evidence.initializer, kind: 'factory-service-smoke' } },
    { ...f.evidence, bootstrap: { ...f.evidence.bootstrap, archiveSha256: 'a'.repeat(64) } },
    { ...f.evidence, capture: { ...f.evidence.capture, sourceIdentitySha256: 'a'.repeat(64) } }]) {
    await privateFiles.writePrivateJson(f.evidencePath, evidence);
    await assert.rejects(prepareModalPilot(f.options, f.dependencies), { code: 'NATIVE_WORKSPACE_OWNERSHIP_REQUIRED' });
  }
  assert.deepEqual(f.state.driverCalls, []); assert.ok(f.state.routes.every(row => row.method === 'GET'));
});

test('native claimed and current catalogs must both be empty before even read-only driver preparation', async t => {
  const f = await fixture(t);
  await privateFiles.writePrivateJson(f.evidencePath, { ...f.evidence, baseline: { ...f.evidence.baseline, models: [{ id: 'original' }] } });
  await assert.rejects(prepareModalPilot(f.options, f.dependencies), { code: 'NATIVE_EMPTY_BASELINE_REQUIRED' });
  await privateFiles.writePrivateJson(f.evidencePath, f.evidence); f.state.models = [{ id: 'factory-pilot-model' }];
  await assert.rejects(prepareModalPilot(f.options, f.dependencies), { code: 'NATIVE_EMPTY_BASELINE_REQUIRED' });
  assert.deepEqual(f.state.driverCalls, []);
});

for (const changed of ['credential', 'profile', 'revision', 'archive', 'workspace']) {
  test(`native ${changed} change after original source proof refuses before driver or dispatch`, async t => {
    const f = await fixture(t); let changedOnce = false;
    f.state.mutation = async route => {
      if (changedOnce || route !== '/api/flow') return; changedOnce = true;
      if (changed === 'credential') {
        f.state.token = randomBytes(32).toString('base64url'); await privateFiles.writePrivateJson(f.profile.tokenFile, { token: f.state.token });
      } else if (changed === 'profile') await privateFiles.writePrivateJson(f.profilePath, { ...f.profile, dataRoot: path.join(f.directory, 'other-namespace') });
      else if (changed === 'revision') f.state.compatibility.revision = 'a'.repeat(40);
      else if (changed === 'archive') f.state.archive = 'a'.repeat(64);
      else f.state.workspace = 'foreign';
    };
    await assert.rejects(prepareModalPilot(f.options, f.dependencies));
    assert.equal(changedOnce, true); assert.deepEqual(f.state.driverCalls, []);
    assert.ok(f.state.routes.every(row => row.method === 'GET'));
  });
}

test('replacement of an unchanged native credential generation refuses rather than trusting matching bytes', async t => {
  const f = await fixture(t);
  await privateFiles.writePrivateJson(f.profile.tokenFile, { token: f.state.token });
  await assert.rejects(f.binding.discover(), invalid); assert.deepEqual(f.state.routes, []);
});

test('in-place native credential rewrite refuses after restoring its original modification time', async t => {
  const f = await fixture(t), original = await stat(f.profile.tokenFile), bytes = await readFile(f.profile.tokenFile);
  await writeFile(f.profile.tokenFile, bytes);
  await utimes(f.profile.tokenFile, original.atime, original.mtime);
  await assert.rejects(f.binding.discover(), invalid); assert.deepEqual(f.state.routes, []);
});

test('matching synthetic native ownership cannot mutate an original unknown journal or paid hold, including cleanup mode', async t => {
  const f = await fixture(t);
  await privateFiles.ensurePrivateDirectory(f.options.runDirectory);
  const journalPath = path.join(f.options.runDirectory, 'modal.sqlite'), journal = new ModalJournal(journalPath);
  journal.admit('deploy', 'deploy', { original: true }); journal.running('deploy'); journal.settle('deploy', 'unknown', { state: 'unknown' }); journal.close();
  const spending = new SpendingLedger(f.options.spendingPath); spending.initialize({ limitCents: 10000, currency: 'USD' });
  spending.reserve({ reservationId: 'original-reservation', provider: 'modal', ceilingCents: 3000 }); spending.start('original-reservation'); spending.close();
  const originals = await Promise.all([journalPath, f.options.spendingPath].map(async filename => ({ filename, sha256: hash(await readFile(filename)) })));
  for (const cleanupOnly of [false, true]) await assert.rejects(runModalPilot({ ...f.options, cleanupOnly }, {
    ...f.dependencies, notify() { assert.fail('Native run notified'); },
  }), { code: 'NATIVE_WORKSPACE_INITIALIZER_REQUIRED' });
  for (const row of originals) assert.equal(hash(await readFile(row.filename)), row.sha256);
  assert.deepEqual(f.state.routes, []); assert.deepEqual(f.state.driverCalls, []);
  assert.deepEqual((await readdir(f.options.runDirectory)).sort(), ['modal.sqlite']);
});
