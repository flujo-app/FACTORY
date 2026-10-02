import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { runCloudPilot, validateParentCandidate, validateChildReview, minimalFlow,
  PILOT_LIMITS, NORMALIZATION_CASES, sourceOriginFetch, createFlySpendingGate } from '../scripts/cloud-pilot.mjs';

const source = 'export function normalizeCheckpoint(value) { return typeof value === "string" ? value.trim().toLowerCase() : "unknown"; }';
const candidate = () => ({ schemaVersion: 1, functionName: 'normalizeCheckpoint', source,
  childRequest: { type: 'independent-verification', budgetCents: 1500, workers: 1, depth: 2 } });
const completion = value => ({ contentType: 'application/json', body: JSON.stringify({ object: 'chat.completion', status: 'completed',
  choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }] }) });

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-cloud-pilot-test-'));
  const outputDirectory = path.join(directory, 'output');
  const mutations = [], operations = [], protectedDirectories = [], paidAdmissions = [], cleanupCallbacks = [];
  let now = 1000;
  const state = { workspaceCreated: false, models: [], flows: [] };
  const managed = {
    async source() { return { source: 'http://127.0.0.1:4200', instanceId: 'fixture-source', appRoot: directory,
      dataRoot: directory, token: 'PRIVATE-AUTH-TOKEN' }; },
    async workspaces() { return { defaultWorkspace: 'default-workspace', workspaces: [
      { name: 'default-workspace' }, ...(state.workspaceCreated ? [{ name: 'factory-pilot' }] : []),
    ] }; },
    async json(url) {
      if (url.pathname === '/api/snapshot/info') return { workerCompatibility: { applicationVersion: '3.46.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 } };
      if (url.pathname === '/api/model') return url.searchParams.get('workspace') === 'factory-pilot' ? state.models
        : [{ id: 'owner-model', name: 'gpt-6-astra', provider: 'codex', adapter: 'codex-cli', ApiKey: 'PRIVATE-API-KEY' }];
      if (url.pathname === '/api/flow') return url.searchParams.get('workspace') === 'factory-pilot' ? state.flows
        : [{ id: 'default-agent-flujo', nodes: [{ id: 'owner-process', type: 'process', data: { properties: { boundModel: 'owner-model' } } }] }];
      throw new Error('Unexpected fake API.');
    },
    async resolveImage() { return { mode: 'official', compatibility: 'verified', image: `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`, revision: 'b'.repeat(40) }; },
    async sources() { return []; },
    async preflight(input) { operations.push(['preflight', input.app]); assert.equal(state.models.length, 1); assert.equal(state.flows.length, 1); return { readyToDeploy: true }; },
    async up(input) { operations.push(['up', input.app, input.timeoutMs]); return { worker: input.app, state: 'ready', token: 'PRIVATE-WORKER-TOKEN' }; },
    async call(id, input) {
      operations.push(['call', id, input.timeoutMs]);
      assert.equal(input.request.model, 'factory-pilot-flow');
      assert.equal(input.request.stream, false);
      return completion(id.endsWith('-parent') ? candidate() : { schemaVersion: 1, accepted: true,
        sourceSha256: createHash('sha256').update(source).digest('hex'), outputs: NORMALIZATION_CASES.map(([, output]) => output) });
    },
    async list() { return []; },
    async down(id) { operations.push(['down', id]); return { app: id, worker: id, state: 'destroyed', localOnly: false }; },
    ...overrides,
  };
  const fetchImpl = async (url, input) => {
    assert.equal(new Headers(input.headers).get('Origin'), 'http://127.0.0.1:4200');
    const endpoint = new URL(url).pathname;
    const body = JSON.parse(input.body);
    mutations.push({ endpoint, body, workspace: new Headers(input.headers).get('x-flujo-workspace') });
    if (endpoint === '/api/workspaces') state.workspaceCreated = true;
    else if (endpoint === '/api/model') state.models.push(body);
    else if (endpoint === '/api/flow') state.flows.push(body);
    else throw new Error('Unexpected mutation.');
    return new Response('{}', { status: 201 });
  };
  t.after(async () => { for (const close of cleanupCallbacks) await close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
  return { directory, mutations, operations, state, protectedDirectories, paidAdmissions,
    input: { runId: 'stable-pilot-test', outputDirectory, modulePath: path.join(directory, 'managed.mjs'), source: 'http://127.0.0.1:4200' },
    dependencies: { managed, fetchImpl, clock: () => now,
      paidAdmission: async input => { paidAdmissions.push(input); },
      protectDirectory: async value => { protectedDirectories.push(value); await mkdir(value, { recursive: true, mode: 0o700 }); } },
    advance(value) { now = value; },
    onCleanup(close) { cleanupCallbacks.push(close); },
  };
}

test('preparation stays read-only and returns only safe owner model metadata', async t => {
  const f = await fixture(t);
  const report = await runCloudPilot(f.input, f.dependencies);
  assert.equal(report.mode, 'prepare-read-only');
  assert.deepEqual(report.sourceModel, { id: 'owner-model', name: 'gpt-6-astra', provider: 'codex', adapter: 'codex-cli' });
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.operations, []); assert.deepEqual(f.protectedDirectories, []);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  assert.deepEqual(f.paidAdmissions, []);
  await assert.rejects(stat(f.input.outputDirectory), { code: 'ENOENT' });
});

test('execute requires paid admission before any source or provider activity', async t => {
  const f = await fixture(t); delete f.dependencies.paidAdmission;
  await assert.rejects(runCloudPilot({ ...f.input, execute: true }, f.dependencies), /paidAdmission/);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.operations, []);
  assert.deepEqual(f.protectedDirectories, []);
});

test('shared paid gate is lazy and fixture failure cannot start or create a reservation', async t => {
  const f = await fixture(t), ledgerPath = path.join(f.directory, 'spending.sqlite');
  const gate = createFlySpendingGate({ ledgerPath, reservationId: f.input.runId, clock: () => 1000 });
  f.onCleanup(() => gate.close());
  f.dependencies.paidAdmission = gate.paidAdmission;
  const prepared = await runCloudPilot(f.input, f.dependencies);
  assert.equal(prepared.mode, 'prepare-read-only');
  await assert.rejects(stat(ledgerPath), { code: 'ENOENT' });
  f.dependencies.fetchImpl = async () => new Response('{}', { status: 403 });
  const failed = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(failed.failureStage, 'fixture-creation');
  await assert.rejects(stat(ledgerPath), { code: 'ENOENT' });
  const observed = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(observed.mode, 'observe-existing');
  await assert.rejects(stat(ledgerPath), { code: 'ENOENT' });
  assert.deepEqual(f.operations, []);
});

test('all four actual paid Fly dispatches share one reservation and cleanup does not readmit paid work', async t => {
  const f = await fixture(t), ledgerPath = path.join(f.directory, 'spending.sqlite');
  const ledger = new SpendingLedger(ledgerPath, { clock: () => 1000 }); f.onCleanup(() => ledger.close());
  ledger.initialize({ limitCents: 10000, currency: 'USD' });
  ledger.reserve({ reservationId: 'modal-20261002', provider: 'modal', ceilingCents: 3000 });
  const gate = createFlySpendingGate({ ledgerPath, reservationId: f.input.runId, clock: () => 1000 }); f.onCleanup(() => gate.close());
  const checks = [];
  f.dependencies.paidAdmission = async input => {
    assert.equal(f.mutations.length, 3); assert.equal(f.operations[0][0], 'preflight');
    checks.push([input.operation, input.worker]);
    assert.equal(input.runId, f.input.runId); assert.equal(input.provider, 'fly'); assert.equal(input.ceilingCents, 1000);
    gate.paidAdmission();
  };
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, true);
  assert.deepEqual(checks.map(([operation]) => operation), ['provision', 'flow_call', 'provision', 'flow_call']);
  assert.deepEqual(checks.map(([, worker]) => worker), f.operations.filter(([operation]) => ['up', 'call'].includes(operation)).map(([, worker]) => worker));
  assert.equal(ledger.status().committedCents, 4000); assert.equal(ledger.status().unallocatedCents, 6000);
  const reservation = ledger.status().reservations.find(row => row.reservationId === f.input.runId);
  assert.equal(reservation.state, 'started'); // Terminated resources still require independently established retirement and final billing.
  assert.equal(ledger.status().meteredSpendCents, null);
  assert.equal(ledger.db.prepare("SELECT count(*) n FROM spending_events WHERE type='reserved' AND reservation_id=?").get(f.input.runId).n, 1);
  const prior = checks.length;
  assert.equal((await runCloudPilot({ ...f.input, execute: true }, f.dependencies)).mode, 'observe-existing');
  assert.equal(checks.length, prior);
});

test('a per-experiment paid admission rejection prevents child dispatch and still retires the parent', async t => {
  const f = await fixture(t), ledgerPath = path.join(f.directory, 'spending.sqlite');
  const gate = createFlySpendingGate({ ledgerPath, reservationId: f.input.runId, clock: () => 1000 }); f.onCleanup(() => gate.close());
  f.dependencies.paidAdmission = gate.paidAdmission;
  const originalCall = f.dependencies.managed.call;
  f.dependencies.managed.call = async (...args) => {
    const result = await originalCall(...args);
    const ledger = new SpendingLedger(ledgerPath, { clock: () => 1000 });
    try { ledger.observe(f.input.runId, { chargedCents: 1000, observedAt: 1000, evidenceDigest: 'a'.repeat(64) }); }
    finally { ledger.close(); }
    return result;
  };
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, false); assert.equal(report.failureStage, 'provision-child');
  assert.equal(f.operations.filter(([operation]) => operation === 'up').length, 1);
  assert.equal(f.operations.filter(([operation]) => operation === 'call').length, 1);
  assert.ok(f.operations.some(([operation, app]) => operation === 'down' && app.endsWith('-parent')));
  const ledger = new SpendingLedger(ledgerPath); f.onCleanup(() => ledger.close());
  assert.equal(ledger.status().unallocatedCents, 9000); assert.equal(ledger.status().reservations[0].state, 'started');
  assert.equal(ledger.status().meteredSpendCents, null);
});

test('Fly spending gate rejects relative or absent paid-ledger paths before opening any database', () => {
  for (const ledgerPath of [undefined, 'spending.sqlite']) {
    assert.throws(() => createFlySpendingGate({ ledgerPath, reservationId: 'stable' }), /absolute/);
  }
});

async function failedOwnedFixture(t) {
  const f = await fixture(t);
  const normalFetch = f.dependencies.fetchImpl;
  f.dependencies.fetchImpl = async (url, input) => {
    f.mutations.push({ endpoint: new URL(url).pathname, origin: new Headers(input.headers).get('Origin') });
    return new Response('PRIVATE_VALIDATION_DETAILS', { status: 403 });
  };
  const original = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(original.failureStage, 'fixture-creation');
  assert.equal(original.passed, false);
  assert.deepEqual(f.operations, []);
  const responsePath = path.join(f.input.outputDirectory, 'workspace-created.private.json');
  const response = JSON.stringify({ workspace: { name: 'factory-pilot', isDefault: false, roots: [] } });
  await writeFile(responsePath, response, { mode: 0o600, flag: 'wx' });
  const proof = {
    format: 'factory-fixture-reconciliation', version: 1, runId: f.input.runId,
    sourceInstanceId: 'fixture-source', workspace: 'factory-pilot',
    workspaceCreation: { status: 201, responsePath, sha256: createHash('sha256').update(response).digest('hex') },
    missingModel: true, missingFlow: true,
  };
  const proofPath = path.join(f.input.outputDirectory, 'fixture-reconciliation.json');
  await writeFile(proofPath, JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
  f.state.workspaceCreated = true; // Simulates the operator's independently recorded HTTP 201.
  f.dependencies.fetchImpl = normalFetch;
  f.advance(5000);
  return { ...f, original, proof, proofPath };
}

test('non-201 fixture status is recorded without response bodies or credentials', async t => {
  const f = await failedOwnedFixture(t);
  const status = JSON.parse(await readFile(path.join(f.input.outputDirectory, 'fixture-http-workspaces.json'), 'utf8'));
  assert.equal(status.status, 403);
  assert.equal(status.endpoint, '/api/workspaces');
  assert.equal(status.sourceInstanceId, 'fixture-source');
  assert.equal(f.mutations[0].origin, 'http://127.0.0.1:4200');
  assert.equal(JSON.stringify(status).includes('PRIVATE'), false);
});

test('native source fetch adds Origin to snapshot writes without exporting it to other origins', async () => {
  const calls = [];
  const wrapped = sourceOriginFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('{}'); }, 'http://127.0.0.1:4200');
  await wrapped(new URL('http://127.0.0.1:4200/api/snapshot/begin'), {
    method: 'POST', headers: { Authorization: 'Bearer private-source', 'Content-Type': 'application/json' }, body: '{}',
  });
  const sourceHeaders = new Headers(calls[0].init.headers);
  assert.equal(sourceHeaders.get('Origin'), 'http://127.0.0.1:4200');
  assert.equal(sourceHeaders.get('Authorization'), 'Bearer private-source');
  for (const url of ['https://ghcr.io/v2/flujo/manifests/latest', 'https://factory.modal.run/v1/chat/completions', 'http://127.0.0.1:5000/api/worker/status']) {
    const init = { method: 'GET', headers: { Accept: 'application/json' } };
    await wrapped(url, init);
    assert.equal(calls.at(-1).init, init);
    assert.equal(new Headers(calls.at(-1).init.headers).has('Origin'), false);
    assert.equal(new Headers(calls.at(-1).init.headers).has('Authorization'), false);
  }
});

test('explicit fixture recovery preserves the original run, app names and failure evidence', async t => {
  const f = await failedOwnedFixture(t);
  const originalReport = await readFile(path.join(f.input.outputDirectory, 'report.json'));
  const originalSource = await readFile(path.join(f.input.outputDirectory, 'source-evidence.json'));
  const priorManifest = JSON.parse(await readFile(path.join(f.input.outputDirectory, 'manifest.json'), 'utf8'));
  const before = f.mutations.length;
  const resumed = await runCloudPilot({ ...f.input, execute: true, resumeFixture: true }, f.dependencies);
  assert.equal(resumed.passed, true);
  assert.equal(resumed.resumedFixture, true);
  assert.equal(resumed.resumeAttempt, 1);
  assert.deepEqual(f.mutations.slice(before).map(item => item.endpoint), ['/api/model', '/api/flow']);
  assert.deepEqual(await readFile(path.join(f.input.outputDirectory, 'report.json')), originalReport);
  assert.deepEqual(await readFile(path.join(f.input.outputDirectory, 'source-evidence.json')), originalSource);
  assert.equal(JSON.parse(await readFile(path.join(f.input.outputDirectory, 'report-resumed.json'), 'utf8')).passed, true);
  const manifest = JSON.parse(await readFile(path.join(f.input.outputDirectory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.workers, priorManifest.workers);
  assert.equal(manifest.databasePath, priorManifest.databasePath);
  assert.equal(manifest.originalStartedAt, priorManifest.startedAt);
  assert.equal(manifest.startedAt, 5000);
  assert.equal(manifest.deadline - manifest.startedAt, PILOT_LIMITS.durationMs);
  const control = new FactoryControl(manifest.databasePath);
  try {
    assert.equal(control.db.prepare("SELECT count(*) AS n FROM events WHERE type='fixture_recovery_resumed'").get().n, 1);
    assert.equal(control.control().epoch, 4); // Original pause, guarded resume, final pause.
  } finally { control.close(); }
  await assert.rejects(stat(path.join(f.input.outputDirectory, 'fixture-resume.lock')), { code: 'ENOENT' });
});

test('recovery validates an existing exact model and creates only the missing fixed Flow', async t => {
  const f = await failedOwnedFixture(t);
  f.state.models.push({ id: 'factory-pilot-model', name: 'gpt-6-astra', provider: 'codex', adapter: 'codex-cli', ApiKey: '' });
  const before = f.mutations.length;
  const report = await runCloudPilot({ ...f.input, execute: true, resumeFixture: true }, f.dependencies);
  assert.equal(report.passed, true);
  assert.deepEqual(f.mutations.slice(before).map(item => item.endpoint), ['/api/flow']);
});

test('recovery refuses historical effects even when they are terminal and does not resume', async t => {
  const f = await failedOwnedFixture(t);
  const control = new FactoryControl(path.join(f.input.outputDirectory, 'control.sqlite'));
  let epoch;
  try {
    control.resume();
    control.createTask({ taskId: 'historical', projectId: 'project', branch: 'codex/historical', specification: { problem: 'prior work', acceptance: 'prior evidence', baseline: 'prior' } });
    const lease = control.claimTask('historical', 'root');
    control.admitEffect(lease, { key: 'prior-effect', kind: 'flow_call', request: {} });
    control.settleEffect('prior-effect', 'not_applied');
    control.pause(); epoch = control.control().epoch;
  } finally { control.close(); }
  const before = f.mutations.length;
  await assert.rejects(runCloudPilot({ ...f.input, execute: true, resumeFixture: true }, f.dependencies), /zero effects/);
  assert.equal(f.mutations.length, before); assert.deepEqual(f.operations, []);
  const reopened = new FactoryControl(path.join(f.input.outputDirectory, 'control.sqlite'));
  try { assert.equal(reopened.control().status, 'paused'); assert.equal(reopened.control().epoch, epoch); }
  finally { reopened.close(); }
});

test('missing or mismatched creation proof cannot adopt a workspace or mutate configuration', async t => {
  for (const [name, change] of [
    ['missing', async f => rm(f.proofPath)],
    ['other-source', async f => writeFile(f.proofPath, JSON.stringify({ ...f.proof, sourceInstanceId: 'different-source' }))],
    ['bad-hash', async f => writeFile(f.proofPath, JSON.stringify({ ...f.proof, workspaceCreation: { ...f.proof.workspaceCreation, sha256: 'f'.repeat(64) } }))],
    ['changed-run', async f => writeFile(f.proofPath, JSON.stringify({ ...f.proof, runId: 'different-run' }))],
  ]) await t.test(name, async subtest => {
    const f = await failedOwnedFixture(subtest); await change(f);
    const before = f.mutations.length;
    await assert.rejects(runCloudPilot({ ...f.input, execute: true, resumeFixture: true }, f.dependencies));
    assert.equal(f.mutations.length, before); assert.deepEqual(f.operations, []);
    const control = new FactoryControl(path.join(f.input.outputDirectory, 'control.sqlite'));
    try { assert.equal(control.control().status, 'paused'); assert.equal(control.control().epoch, 2); }
    finally { control.close(); }
  });
});

test('recovery refuses altered model credentials, tools and Flow structure before resuming', async t => {
  for (const [name, alter] of [
    ['credential', f => f.state.models.push({ id: 'factory-pilot-model', name: 'gpt-6-astra', provider: 'codex', adapter: 'codex-cli', ApiKey: 'PRIVATE_NEW_KEY' })],
    ['tools', f => f.state.models.push({ id: 'factory-pilot-model', name: 'gpt-6-astra', provider: 'codex', adapter: 'codex-cli', ApiKey: '', tools: ['unapproved'] })],
    ['flow', f => { const flow = minimalFlow(); flow.nodes[1].data.properties.boundModel = 'unapproved-model'; f.state.flows.push(flow); }],
  ]) await t.test(name, async subtest => {
    const f = await failedOwnedFixture(subtest); alter(f);
    const before = f.mutations.length;
    await assert.rejects(runCloudPilot({ ...f.input, execute: true, resumeFixture: true }, f.dependencies));
    assert.equal(f.mutations.length, before); assert.deepEqual(f.operations, []);
    const control = new FactoryControl(path.join(f.input.outputDirectory, 'control.sqlite'));
    try { assert.equal(control.control().epoch, 2); assert.equal(control.control().status, 'paused'); }
    finally { control.close(); }
  });
});

test('bounded live path uses two workers, delegated child request, durable effects and targeted retirement', async t => {
  const f = await fixture(t);
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, true); assert.equal(report.candidateVerified, true);
  assert.equal(f.operations.filter(([kind]) => kind === 'up').length, 2);
  assert.equal(f.operations.filter(([kind]) => kind === 'call').length, 2);
  assert.equal(f.operations.filter(([kind]) => kind === 'down').length, 2);
  assert.ok(f.operations.filter(([kind]) => kind === 'call').every(([, , timeout]) => timeout <= PILOT_LIMITS.callMs));
  assert.equal(f.mutations.length, 3);
  assert.deepEqual(f.mutations[0].body, { name: 'factory-pilot' });
  assert.equal(f.mutations[1].body.ApiKey, '');
  assert.equal(f.mutations[1].body.name, 'gpt-6-astra');
  assert.equal(f.mutations[1].workspace, 'factory-pilot');
  assert.deepEqual(f.mutations[2].body, minimalFlow());
  assert.ok(f.protectedDirectories.includes(path.join(f.input.outputDirectory, 'managed-cloud')));
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  assert.ok(report.retirement.every(item => item.localOnly === false && item.retirementScope === 'managed-cloud-confirmed'));
  const manifest = JSON.parse(await readFile(path.join(f.input.outputDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.desiredState, 'retired'); assert.equal(manifest.workers.length, 2);
  assert.equal(manifest.workers[1].depth, 2); assert.equal(manifest.stage, 'retired');
  const control = new FactoryControl(manifest.databasePath);
  try {
    const snapshot = control.status();
    assert.equal(snapshot.control.policy.budgetCents, 10_000);
    const parent = snapshot.cells.find(item => item.id === 'parent-worker');
    const child = snapshot.cells.find(item => item.id === 'child-worker');
    assert.equal(parent.allocation, 6000); assert.equal(child.allocation, 1500); assert.equal(child.parent_id, parent.id);
    assert.equal(control.inbox('root')[0].payload.type, 'independent-verification');
    assert.equal(snapshot.effects.length, 6); assert.ok(snapshot.effects.every(effect => effect.state === 'succeeded'));
  } finally { control.close(); }
});

test('reopening a recorded run observes existing intent without replaying resources or calls', async t => {
  const f = await fixture(t);
  await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  const operations = f.operations.length, mutations = f.mutations.length;
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.mode, 'observe-existing'); assert.equal(report.requiresReconciliation, true);
  assert.equal(f.operations.length, operations); assert.equal(f.mutations.length, mutations);
});

test('existing dedicated workspace is not adopted or overwritten', async t => {
  const f = await fixture(t, { async workspaces() { return { defaultWorkspace: 'default-workspace', workspaces: [{ name: 'factory-pilot' }] }; } });
  await assert.rejects(runCloudPilot({ ...f.input, execute: true }, f.dependencies));
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.operations, []);
});

test('unknown provisioning is preserved and exact original identity is retired without recreation', async t => {
  const f = await fixture(t, { async up(input) { f.operations.push(['up', input.app]); throw new Error('PRIVATE-ERROR'); } });
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, false); assert.equal(report.unresolvedEffects, 1);
  assert.deepEqual(f.operations.filter(([kind]) => kind === 'up').length, 1);
  assert.deepEqual(f.operations.filter(([kind]) => kind === 'call').length, 0);
  const original = f.operations.find(([kind]) => kind === 'up')[1];
  assert.deepEqual(f.operations.filter(([kind]) => kind === 'down'), [['down', original]]);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});

test('invalid child proposal admits no child and still retires parent', async t => {
  const f = await fixture(t, { async call(id) { f.operations.push(['call', id]); const value = candidate(); value.childRequest.budgetCents = 9000; return completion(value); } });
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, false); assert.equal(report.candidateVerified, false);
  assert.equal(f.operations.filter(([kind]) => kind === 'up').length, 1);
  assert.equal(f.operations.filter(([kind]) => kind === 'down').length, 1);
});

test('first retirement failure does not prevent second retirement attempt', async t => {
  const f = await fixture(t, { async down(id) { f.operations.push(['down', id]); if (id.endsWith('-child')) throw new Error('PRIVATE-ERROR'); return { app: id, worker: id, state: 'destroyed', localOnly: false }; } });
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, false); assert.equal(report.candidateVerified, true);
  assert.equal(f.operations.filter(([kind]) => kind === 'down').length, 2);
  assert.equal(report.retirement[0].state, 'unknown'); assert.equal(report.retirement[1].state, 'succeeded');
});

test('work deadline prevents child admission after a late parent result', async t => {
  const f = await fixture(t, { async call(id) { f.operations.push(['call', id]); f.advance(1000 + PILOT_LIMITS.durationMs); return completion(candidate()); } });
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, false);
  assert.equal(f.operations.filter(([kind]) => kind === 'up').length, 1);
  assert.equal(f.operations.filter(([kind]) => kind === 'down').length, 1);
});

test('pause during a call blocks child admission while targeted retirement remains available', async t => {
  const f = await fixture(t, { async call(id) {
    f.operations.push(['call', id]);
    const control = new FactoryControl(path.join(f.input.outputDirectory, 'control.sqlite'));
    try { control.pause(); } finally { control.close(); }
    return completion(candidate());
  } });
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, false);
  assert.equal(f.operations.filter(([kind]) => kind === 'up').length, 1);
  assert.equal(f.operations.filter(([kind]) => kind === 'down').length, 1);
  assert.equal(report.retirement[0].state, 'succeeded');
  const control = new FactoryControl(path.join(f.input.outputDirectory, 'control.sqlite'));
  try { assert.equal(control.control().status, 'paused'); assert.equal(control.control().epoch, 2); }
  finally { control.close(); }
});

test('a stale manifest staging file cannot prevent already-owned resources from retiring', async t => {
  const f = await fixture(t, { async call(id) {
    f.operations.push(['call', id]);
    await writeFile(path.join(f.input.outputDirectory, 'manifest.json.next'), 'Interrupted projection.', { flag: 'wx' });
    return completion(candidate());
  } });
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, false);
  assert.equal(f.operations.filter(([kind]) => kind === 'up').length, 1);
  assert.equal(f.operations.filter(([kind]) => kind === 'down').length, 1);
  assert.equal(report.retirement[0].state, 'succeeded');
});

test('uncertain fixture creation is never retried and unrelated workers are untouched', async t => {
  const f = await fixture(t);
  f.dependencies.fetchImpl = async () => { f.mutations.push({ unknown: true }); throw new Error('PRIVATE-ERROR'); };
  const report = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(report.passed, false); assert.equal(f.mutations.length, 1);
  assert.equal(f.operations.length, 0); assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  const observed = await runCloudPilot({ ...f.input, execute: true }, f.dependencies);
  assert.equal(observed.mode, 'observe-existing'); assert.equal(f.mutations.length, 1);
});

test('pure source grammar rejects executable or coercing candidates and child review requires every pinned result', () => {
  const parent = validateParentCandidate(candidate());
  for (const code of [
    'export function normalizeCheckpoint(value) { return String(value).trim().toLowerCase(); }',
    source + '\nprocess.exit(0);',
    source.replace('value.trim()', '(globalThis.secret(),value.trim())'),
  ]) assert.throws(() => validateParentCandidate({ ...candidate(), source: code }));
  const review = { schemaVersion: 1, accepted: true, sourceSha256: parent.sourceSha256, outputs: NORMALIZATION_CASES.map(([, output]) => output) };
  assert.equal(validateChildReview(review, parent).cases.length, NORMALIZATION_CASES.length);
  assert.throws(() => validateChildReview({ ...review, outputs: [] }, parent));
  assert.throws(() => validateChildReview({ ...review, sourceSha256: 'wrong' }, parent));
});
