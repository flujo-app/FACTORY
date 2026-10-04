import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FactoryControl, digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { ModalJournal } from '../scripts/modal-pilot.mjs';
import { createCommunityAiModalSupervisor, COMMUNITYAI_ROLES, prepareCommunityAiModelLaunchInput } from '../scripts/communityai-modal-supervisor.mjs';

async function fixture(t, { failed = null, cap = 10000 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-communityai-host-'));
  const now = 1791118800000;
  const control = new FactoryControl(path.join(directory, 'control.sqlite'), { clock: () => now });
  const paid = new SpendingLedger(path.join(directory, 'paid.sqlite'), { clock: () => now });
  const journal = new ModalJournal(path.join(directory, 'modal.sqlite'), { clock: () => now });
  t.after(() => { journal.close(); paid.close(); control.close(); });
  control.initialize({ mission: 'Offline distributed supervisor fixture', budgetCents: 10000, maxCells: 4, maxDepth: 2 });
  control.createTask({ taskId: 'manage', projectId: 'factory', branch: 'codex/manage',
    specification: { problem: 'Own explicit distributed role resources', acceptance: ['record owned roles'], baseline: 'fixture' } });
  const managementLease = control.claimTask('manage', 'root', 600000);
  paid.initialize({ limitCents: cap, currency: 'USD' });
  paid.reserveFresh({ reservationId: 'roles-budget', provider: 'modal', ceilingCents: 1000 });
  const spec = { runId: 'factory-distributed-test', appName: 'factory-owned-app', appId: 'ap-owned',
    imageRef: 'registry.example/factory@sha256:' + 'a'.repeat(64), imageId: 'im-owned', volumeId: 'vo-owned',
    volumeEvidenceSha256: 'b'.repeat(64), manifestDigest: 'sha256:aef22f8678f9c5dcc5315913cf1cf584fa9e6c2fba8d064f715d78d823c9f056',
    modelRevision: '70d244cc86ccca08cf5af4e1e306ecf908b1ad5e', expiresAtUnix: now / 1000 + 300,
    reservationId: 'roles-budget', ceilingCents: 1000, gpu: 'T4' };
  const calls = [], gateCalls = [], processes = new Map();
  let deny = false;
  const resourceFile = role => path.join(directory, `${role}-resource.private.json`);
  const driver = async payload => {
    const { request, key } = payload, { role, operation } = request;
    calls.push(snapshot(payload));
    const effect = journal.get(key);
    assert.equal(effect.state, operation === 'observe-role' ? 'succeeded' : 'running');
    assert.equal(effect.request_digest, digest(operation === 'observe-role'
      ? { ...request, operation: 'create-role', input: null } : request));
    if (failed === operation) throw new Error('synthetic-private-SDK-diagnostic');
    const index = COMMUNITYAI_ROLES.indexOf(role), resourceId = `sb-owned-${index}`;
    let record;
    if (operation === 'create-role') {
      record = { role, spec: request.spec, resourceId, createRequestSha256: digest(request),
        endpoint: { resource_id: resourceId, ipv4: `8.8.8.${index + 1}`, public_port: 42000 + index,
          listen_port: 31330, transport: 'modal-raw-tcp', application_tls: true },
        tcpSocket: [`r${index}.modal.test`, 42000 + index], launch: 'not_requested', retirement: 'unverified', admission: 'NO_ADMISSION' };
    } else record = JSON.parse(await fs.readFile(resourceFile(role), 'utf8'));
    let state, process;
    if (operation === 'create-role') state = 'sandbox_created_tunnel_observed';
    if (operation === 'launch-role') {
      state = 'exec_handle_returned_readiness_unverified'; record.launch = state;
      process = Object.freeze({ role, fixtureHandle: true }); processes.set(role, process);
    }
    if (operation === 'terminate-role') { state = 'terminate_pending'; record.retirement = state; }
    if (operation === 'observe-role') { state = 'sandbox_terminal_observed'; record.returncode = 137; record.retirement = state; }
    await fs.writeFile(resourceFile(role), JSON.stringify(record), { mode: 0o600 });
    return { state, resourceId, process, returncode: record.returncode, admission: 'NO_ADMISSION' };
  };
  const options = { control, paidAdmission: paid, managementLease, journal, runDirectory: directory,
    privateFiles: { assertPrivateDirectory: async value => assert.equal(value, directory) }, driver, clock: () => now,
    hostResourceAdmission: request => { gateCalls.push(request); return !deny; }, spec };
  const make = () => createCommunityAiModalSupervisor(options);
  return { directory, control, paid, journal, spec, calls, gateCalls, processes, make, resourceFile,
    setDeny: value => { deny = value; } };
}
const snapshot = value => JSON.parse(JSON.stringify(value));

test('pure model index carrier retains exact bounded metadata and synthetic formation without admission', async () => {
  const bytes = await fs.readFile(new URL('../modal/fixtures/communityai-qwen3-model-index.json', import.meta.url));
  const formation = { run_id: 'factory-carrier-config', manifest_digest: 'sha256:aef22f8678f9c5dcc5315913cf1cf584fa9e6c2fba8d064f715d78d823c9f056',
    expires_at_unix: 1791119100, endpoints: {}, bootstrap_peers: [] };
  for (const role of ['worker_0', 'worker_1', 'text_peer']) {
    formation.endpoints[role] = { resource_id: `sb-synthetic-${role}` };
    const input = { resourceId: `sb-synthetic-${role}`, formation, indexBase64: bytes.toString('base64') };
    const prepared = prepareCommunityAiModelLaunchInput(role, input);
    assert.deepEqual(Object.keys(prepared).sort(), ['formation', 'indexBase64', 'resourceId']);
    assert.equal(Buffer.from(prepared.indexBase64, 'base64').length, 25605);
    assert.deepEqual(Buffer.from(prepared.indexBase64, 'base64'), bytes);
    assert.ok(Object.isFrozen(prepared)); assert.ok(Object.isFrozen(prepared.formation));
    formation.run_id = 'factory-mutated-source';
    assert.notEqual(prepared.formation.run_id, formation.run_id);
    formation.run_id = 'factory-carrier-config';
  }
});

test('pure model carrier validates and returns one exact snapshot of getter-backed configuration', async () => {
  const bytes = await fs.readFile(new URL('../modal/fixtures/communityai-qwen3-model-index.json', import.meta.url));
  const encoded = bytes.toString('base64');
  const changed = Buffer.from(bytes); changed[0] ^= 1;
  const manifest = 'sha256:aef22f8678f9c5dcc5315913cf1cf584fa9e6c2fba8d064f715d78d823c9f056';
  let indexReads = 0, formationReads = 0, manifestReads = 0;
  const formation = { run_id: 'factory-carrier-config', expires_at_unix: 1791119100,
    endpoints: { worker_0: { resource_id: 'sb-synthetic-worker' } }, bootstrap_peers: [] };
  Object.defineProperty(formation, 'manifest_digest', { enumerable: true,
    get: () => ++manifestReads === 1 ? manifest : 'sha256:' + 'f'.repeat(64) });
  const input = { resourceId: 'sb-synthetic-worker' };
  Object.defineProperty(input, 'formation', { enumerable: true,
    get: () => ++formationReads === 1 ? formation : null });
  Object.defineProperty(input, 'indexBase64', { enumerable: true,
    get: () => ++indexReads === 1 ? encoded : changed.toString('base64') });
  const prepared = prepareCommunityAiModelLaunchInput('worker_0', input);
  assert.deepEqual([indexReads, formationReads, manifestReads], [1, 1, 1]);
  assert.equal(prepared.indexBase64, encoded);
  assert.equal(prepared.formation.manifest_digest, manifest);
  assert.equal(Object.getOwnPropertyDescriptor(prepared, 'indexBase64').get, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(prepared.formation, 'manifest_digest').get, undefined);
  assert.ok(Object.isFrozen(prepared.formation.endpoints.worker_0));
});

test('pure model carrier rejects absent, oversized, noncanonical or altered bytes with no fallback', async () => {
  const bytes = await fs.readFile(new URL('../modal/fixtures/communityai-qwen3-model-index.json', import.meta.url));
  const input = { resourceId: 'sb-synthetic-worker', formation: { run_id: 'factory-carrier-config',
    manifest_digest: 'sha256:aef22f8678f9c5dcc5315913cf1cf584fa9e6c2fba8d064f715d78d823c9f056', expires_at_unix: 1791119100,
    endpoints: { worker_0: { resource_id: 'sb-synthetic-worker' } }, bootstrap_peers: [] }, indexBase64: bytes.toString('base64') };
  const altered = Buffer.from(bytes); altered[0] ^= 1;
  for (const encoded of [null, '', bytes, input.indexBase64 + '=', input.indexBase64 + '\n', '_'.repeat(34140), altered.toString('base64')]) {
    assert.throws(() => prepareCommunityAiModelLaunchInput('worker_0', { ...input, indexBase64: encoded }),
      { code: 'COMMUNITYAI_INDEX_CARRIER' });
  }
  assert.throws(() => prepareCommunityAiModelLaunchInput('worker_0', { ...input, indexBase64: undefined }),
    { code: 'COMMUNITYAI_HOST_BINDING' });
  assert.throws(() => prepareCommunityAiModelLaunchInput('worker_0', { ...input, extra: true }));
});

test('standalone bootstrap journals owned lifecycle and retains its live handle without inference admission', async t => {
  const f = await fixture(t), supervisor = f.make();
  await supervisor.createRole('bootstrap');
  const result = await supervisor.launchRole('bootstrap');
  assert.equal(result.state, 'exec_handle_returned_readiness_unverified');
  assert.equal(result.admission, 'NO_ADMISSION'); assert.equal(result.inferenceQualified, false);
  assert.equal(f.calls.length, 2); assert.equal(f.journal.list().length, 2);
  assert.equal(f.paid.row('roles-budget').state, 'started');
  assert.equal(f.paid.row('roles-budget').final_cents, null);
  assert.equal(supervisor.liveHandle('bootstrap'), f.processes.get('bootstrap'));
  assert.equal(f.journal.get('create-role-bootstrap').result.resourceId, undefined);
  const restarted = f.make();
  assert.equal(restarted.liveHandle('bootstrap'), null);
  assert.equal((await restarted.createRole('bootstrap')).state, 'observation_required');
  assert.equal((await restarted.launchRole('bootstrap')).state, 'observation_required');
  assert.equal(f.calls.length, 2);
});

test('known unqualified model runtime holds the batch and model roles before any paid creation or driver work', async t => {
  const f = await fixture(t), supervisor = f.make();
  let observations = 0;
  await assert.rejects(supervisor.launchFourRoles({ observeBootstrap: async () => { observations++; } }),
    { code: 'COMMUNITYAI_MODEL_RUNTIME_UNQUALIFIED' });
  for (const role of ['worker_0', 'worker_1', 'text_peer']) {
    await assert.rejects(supervisor.launchRole(role, {}, 'invalid-carrier'), { code: 'COMMUNITYAI_MODEL_RUNTIME_UNQUALIFIED' });
    assert.equal(supervisor.liveHandle(role), null);
  }
  assert.equal(observations, 0); assert.equal(f.calls.length, 0); assert.equal(f.gateCalls.length, 0);
  assert.equal(f.journal.list().length, 0);
  assert.equal(f.paid.row('roles-budget').state, 'reserved');
});

test('retirement markers refuse bootstrap launch before journal intent or driver config and exec', async t => {
  const f = await fixture(t), supervisor = f.make();
  await supervisor.createRole('bootstrap');
  await supervisor.retireRole('bootstrap');
  const record = JSON.parse(await fs.readFile(f.resourceFile('bootstrap'), 'utf8'));
  for (const retirement of ['terminate_requested_unverified', 'terminate_pending', 'sandbox_terminal_observed']) {
    await fs.writeFile(f.resourceFile('bootstrap'), JSON.stringify({ ...record, retirement }));
    await assert.rejects(supervisor.launchRole('bootstrap'), { code: 'COMMUNITYAI_RETIRED_TARGET' });
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.journal.get('launch-role-bootstrap'), null);
  assert.equal(supervisor.liveHandle('bootstrap'), null);
});

test('paused controller, paused spending, free-zero and explicit owner denial make zero driver calls', async t => {
  for (const condition of ['controller', 'spending', 'free-zero', 'owner']) await t.test(condition, async t => {
    const f = await fixture(t, { cap: condition === 'free-zero' ? 1000 : 10000 });
    const supervisor = f.make();
    if (condition === 'controller') f.control.pause();
    if (condition === 'spending') f.paid.pauseAdmission();
    if (condition === 'owner') f.setDeny(true);
    await assert.rejects(supervisor.createRole('bootstrap'));
    assert.equal(f.calls.length, 0); assert.equal(f.journal.list().length, 0);
  });
});

test('lost create result remains UNKNOWN and the same resource intent is never replayed', async t => {
  const f = await fixture(t, { failed: 'create-role' });
  assert.equal((await f.make().createRole('bootstrap')).effectState, 'unknown');
  assert.equal((await f.make().createRole('bootstrap')).state, 'observation_required');
  assert.equal(f.calls.length, 1);
  assert.equal(f.journal.get('create-role-bootstrap').state, 'unknown');
  assert.equal(f.paid.row('roles-budget').state, 'started');
  assert.equal(f.paid.row('roles-budget').final_cents, null);
});

test('pending termination is observation-only on restart and terminal Sandbox observation never settles spending', async t => {
  const f = await fixture(t), supervisor = f.make();
  await supervisor.createRole('bootstrap');
  f.control.pause(); f.paid.pauseAdmission();
  assert.equal((await supervisor.retireRole('bootstrap')).state, 'terminate_pending');
  assert.equal((await f.make().retireRole('bootstrap')).state, 'observation_required');
  assert.equal(f.calls.filter(value => value.request.operation === 'terminate-role').length, 1);
  const observed = await f.make().observeRole('bootstrap');
  assert.equal(observed.returncode, 137); assert.equal(observed.billingFinal, false);
  assert.equal(f.journal.get('terminate-role-bootstrap').state, 'unknown');
  assert.equal(f.paid.row('roles-budget').state, 'started');
});

test('foreign checkpoint refuses before bootstrap launch and no default owner adapter exists', async t => {
  const f = await fixture(t), supervisor = f.make();
  await supervisor.createRole('bootstrap');
  const record = JSON.parse(await fs.readFile(f.resourceFile('bootstrap'), 'utf8'));
  record.spec.volumeId = 'vo-foreign';
  await fs.writeFile(f.resourceFile('bootstrap'), JSON.stringify(record));
  await assert.rejects(supervisor.launchRole('bootstrap'), { code: 'COMMUNITYAI_RESOURCE_CHECKPOINT' });
  assert.equal(f.calls.length, 1);
  assert.throws(() => createCommunityAiModalSupervisor({}), { code: 'COMMUNITYAI_HOST_REQUIRED' });
});
