import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FactoryControl } from '../src/control.mjs';
import { runCloudPilot, validateParentCandidate, validateChildReview, minimalFlow,
  PILOT_LIMITS, NORMALIZATION_CASES } from '../scripts/cloud-pilot.mjs';

const source = 'export function normalizeCheckpoint(value) { return typeof value === "string" ? value.trim().toLowerCase() : "unknown"; }';
const candidate = () => ({ schemaVersion: 1, functionName: 'normalizeCheckpoint', source,
  childRequest: { type: 'independent-verification', budgetCents: 1500, workers: 1, depth: 2 } });
const completion = value => ({ contentType: 'application/json', body: JSON.stringify({ object: 'chat.completion', status: 'completed',
  choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }] }) });

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-cloud-pilot-test-'));
  const outputDirectory = path.join(directory, 'output');
  const mutations = [], operations = [], protectedDirectories = [];
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
      if (url.pathname === '/api/model') return [{ id: 'owner-model', name: 'gpt-6-astra', provider: 'codex', adapter: 'codex-cli', ApiKey: 'PRIVATE-API-KEY' }];
      if (url.pathname === '/api/flow') return [{ id: 'default-agent-flujo', nodes: [{ id: 'owner-process', type: 'process', data: { properties: { boundModel: 'owner-model' } } }] }];
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
    const endpoint = new URL(url).pathname;
    const body = JSON.parse(input.body);
    mutations.push({ endpoint, body, workspace: input.headers['x-flujo-workspace'] });
    if (endpoint === '/api/workspaces') state.workspaceCreated = true;
    else if (endpoint === '/api/model') state.models.push(body);
    else if (endpoint === '/api/flow') state.flows.push(body);
    else throw new Error('Unexpected mutation.');
    return new Response('{}', { status: 201 });
  };
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  return { directory, mutations, operations, state, protectedDirectories,
    input: { runId: 'stable-pilot-test', outputDirectory, modulePath: path.join(directory, 'managed.mjs'), source: 'http://127.0.0.1:4200' },
    dependencies: { managed, fetchImpl, clock: () => now,
      protectDirectory: async value => { protectedDirectories.push(value); await mkdir(value, { recursive: true, mode: 0o700 }); } },
    advance(value) { now = value; },
  };
}

test('preparation stays read-only and returns only safe owner model metadata', async t => {
  const f = await fixture(t);
  const report = await runCloudPilot(f.input, f.dependencies);
  assert.equal(report.mode, 'prepare-read-only');
  assert.deepEqual(report.sourceModel, { id: 'owner-model', name: 'gpt-6-astra', provider: 'codex', adapter: 'codex-cli' });
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.operations, []); assert.deepEqual(f.protectedDirectories, []);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  await assert.rejects(stat(f.input.outputDirectory), { code: 'ENOENT' });
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
