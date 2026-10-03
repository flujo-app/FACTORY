import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { ModalJournal, completionEvidence, prepareModalPilot, runModalPilot } from '../scripts/modal-pilot.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { digest } from '../src/control.mjs';

const SOURCE = { origin: 'http://127.0.0.1:4200', instanceId: 'source-instance', appRoot: 'fake-app', dataRoot: 'fake-data' };
const safeCompletion = (model, flujo = false) => JSON.stringify({ object: 'chat.completion', model, ...(flujo ? { status: 'completed' } : {}),
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"checkpoint":"ready"}' } }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } });

async function fixture(t, settings = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-modal-test-'));
  const runDirectory = path.join(directory, 'run'), sourceEvidencePath = path.join(directory, 'source.json');
  await writeFile(sourceEvidencePath, JSON.stringify({ source: SOURCE, fixtureAlreadyExists: false }));
  const options = { runId: 'offline-modal', runDirectory, sourceEvidencePath, spendingPath: path.join(directory, 'spending.sqlite') };
  const calls = [], payloads = [], httpCalls = [], notifications = [], protections = [], models = [], flows = [];
  let resourceState = {};
  const persist = async () => writeFile(path.join(runDirectory, 'resources.private.json'), JSON.stringify(resourceState));
  const source = { source: SOURCE.origin, instanceId: SOURCE.instanceId, appRoot: SOURCE.appRoot, dataRoot: SOURCE.dataRoot, token: 'owner-private-source-token' };
  const driver = async payload => {
    calls.push(payload.operation);
    payloads.push(structuredClone(payload));
    if (payload.operation === 'prepare') return { state: 'prepared', profile: 'fake-profile', workspaceName: 'factory-account', environment: 'main', credentialsAccepted: true, appAbsent: true, volumeAbsent: true };
    if (payload.operation === settings.sdkFailure || settings.sdkFailures?.includes(payload.operation)) throw new Error('private raw token diagnostic');
    resourceState = { ...resourceState, ...await readFile(path.join(runDirectory, 'resources.private.json'), 'utf8').then(JSON.parse).catch(() => ({})) };
    resourceState = { ...resourceState, runId: payload.runId, appName: payload.appName, volumeName: payload.volumeName,
      environment: payload.environment, profile: payload.profile, workspaceName: payload.workspaceName };
    switch (payload.operation) {
      case 'create-volume': resourceState.volumeId = 'vo-owned'; resourceState.volumeCreated = true; resourceState.volumeFsVersion = payload.volumeFsVersion; await persist(); return { state: 'volume-created', volumeId: 'vo-owned', volumeFsVersion: payload.volumeFsVersion };
      case 'deploy': Object.assign(resourceState, { appId: 'ap-owned', appDeployed: true, serveFunctionId: 'fu-serve', prefetchFunctionId: 'fu-prefetch', endpoint: 'https://factory--serve.modal.run' }); await persist(); return { state: 'deployed', ...resourceState };
      case 'prefetch': resourceState.weightsCached = true; await persist(); return { state: 'weights-cached' };
      case 'create-proxy-token':
        Object.assign(resourceState, { proxyTokenCreated: true, proxyTokenId: 'wk-fake' }); await persist();
        await writeFile(path.join(runDirectory, 'proxy-token.private.json'), JSON.stringify({ runId: payload.runId, profile: payload.profile, tokenId: 'wk-fake', tokenSecret: 'ws-private-proxy-token', bearer: 'wk-fake.ws-private-proxy-token' }));
        return { state: 'proxy-token-created', tokenStoredPrivately: true };
      case 'stop-app': resourceState.appStopped = true; await persist(); return { state: 'stopped', appId: 'ap-owned', runningContainers: 0 };
      case 'reconcile-stop-app': return { ...resourceState, state: settings.reconcileState ?? 'stopped',
        appId: settings.reconcileAppId ?? 'ap-owned', runningContainers: settings.reconcileContainers ?? 0,
        originalKey: payload.originalKey, originalRequestDigest: payload.originalRequestDigest, observedAt: Date.now() };
      case 'delete-volume': resourceState.volumeDeleted = true; await persist(); return { state: 'volume-deleted', volumeId: 'vo-owned' };
      case 'delete-proxy-token': resourceState.proxyTokenDeleted = true; await persist(); return { state: 'proxy-token-deleted' };
      case 'meter': return { state: settings.meteredCents === undefined ? 'billing-unavailable' : 'billing-observed',
        knownMeteredCents: settings.meteredCents ?? 0, observedAt: Date.now(), resourceRows: settings.meteredCents === undefined ? 0 : 1,
        ...(settings.meteredCents === undefined ? {} : { reportStart: '2026-01-01T00:00:00+00:00',
          reportEnd: '2026-01-01T01:00:00+00:00', matchedRowCostUsdSum: '0.03503811' }),
        meterScope: 'recorded-owned-objects-completed-hours-only', buildCostAttribution: 'unverified', final: false };
      default: throw new Error('unexpected SDK operation');
    }
  };
  const managed = { source: async () => source, workspaces: async () => ({ workspaces: [{ name: 'factory-pilot' }] }),
    json: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/model') return structuredClone(models);
      if (pathname === '/api/flow') return structuredClone(flows);
      if (pathname.startsWith('/api/model/')) return structuredClone(models.find(item => item.id === pathname.split('/').at(-1)));
      if (pathname.startsWith('/api/flow/')) return structuredClone(flows.find(item => item.id === pathname.split('/').at(-1)));
      throw new Error('unexpected local read');
    } };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    httpCalls.push({ url: parsed.href, origin: parsed.origin, pathname: parsed.pathname, method: init.method, body,
      headers: init.headers, redirect: init.redirect, signal: init.signal });
    if (parsed.hostname.endsWith('.modal.run')) {
      const expectedModel = body?.model ?? httpCalls.find(call => call.origin === parsed.origin && call.method === 'POST').body.model;
      if (settings.modalHttpResponse) return settings.modalHttpResponse({ url: parsed, init, body, expectedModel });
      if (settings.redirect) return new Response('private redirect body', { status: 303, headers: { location: 'https://factory--serve.modal.run/?result=private' } });
      return new Response(settings.directCompletion?.(JSON.parse(safeCompletion(expectedModel))) ?? safeCompletion(expectedModel), { status: 200 });
    }
    assert.equal(init.headers.Origin, SOURCE.origin);
    assert.equal(init.headers['x-flujo-workspace'], 'factory-pilot');
    if (parsed.pathname === '/api/model' && init.method === 'POST') { models.push(body); return new Response(JSON.stringify({ ...body, ApiKey: '********' }), { status: 201 }); }
    if (parsed.pathname === '/api/flow' && init.method === 'POST') { flows.push(body); return new Response(JSON.stringify(body), { status: 201 }); }
    if (parsed.pathname === '/v1/chat/completions') {
      await settings.beforeFlowCompletion?.();
      return new Response(safeCompletion(body.model, true), { status: 200 });
    }
    if (parsed.pathname.startsWith('/api/model/') && init.method === 'PUT') { const index = models.findIndex(item => item.id === body.id); models[index] = body; return new Response(JSON.stringify({ ...body, ApiKey: '' }), { status: 200 }); }
    if (init.method === 'DELETE') {
      if (settings.fixtureDeleteFailure) return new Response('private failure', { status: 500 });
      const collection = parsed.pathname.startsWith('/api/model/') ? models : flows;
      const index = collection.findIndex(item => item.id === parsed.pathname.split('/').at(-1));
      collection.splice(index, 1); return new Response(null, { status: 204 });
    }
    throw new Error('unexpected local mutation');
  };
  const dependencies = { driver, managed, fetchImpl,
    privateFiles: { ensurePrivateDirectory: async name => { protections.push(name); await mkdir(name, { recursive: true }); } },
    notify: event => { notifications.push(event); if (settings.notifyFailure) throw new Error('private diagnostic'); },
    ...(settings.checkpointFailure ? { writeFixtureOwnership: async () => { throw new Error('private checkpoint failure'); } } : {}) };
  t.after(() => {}); // Preserve tiny offline evidence if a regression fails; no cloud resources exist.
  return { directory, options, dependencies, calls, payloads, httpCalls, notifications, protections, models, flows };
}

test('private SQLite operation journal prevents replay, replacement keys and duplicate running/settlement', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-modal-journal-'));
  const journal = new ModalJournal(path.join(directory, 'modal.sqlite'));
  t.after(() => journal.close());
  assert.equal(journal.admit('deploy', 'deploy', { app: 'factory-owned' }).fresh, true);
  journal.running('deploy');
  assert.throws(() => journal.running('deploy'), { code: 'INTENT_STATE' });
  journal.settle('deploy', 'unknown', { state: 'unknown', error: 'private-token' });
  assert.equal(journal.admit('deploy', 'deploy', { app: 'factory-owned' }).fresh, false);
  assert.throws(() => journal.admit('retry-deploy', 'deploy', { app: 'factory-owned' }), { code: 'OPERATION_ALREADY_BOUND' });
  assert.throws(() => journal.admit('deploy', 'deploy', { app: 'factory-other' }), { code: 'INTENT_CONFLICT' });
  assert.throws(() => journal.settle('deploy', 'succeeded', {}), { code: 'INTENT_STATE' });
  assert.equal(journal.get('deploy').result.error, undefined);
});

test('prepare stays read-only and inventories the owned source without creating run storage', async t => {
  const f = await fixture(t);
  const prepared = await prepareModalPilot(f.options, f.dependencies);
  assert.equal(prepared.mode, 'prepare-read-only');
  assert.equal(prepared.ceilingCents, 3000);
  assert.deepEqual(f.calls, ['prepare']);
  assert.equal(f.protections.length, 0);
  assert.equal(f.httpCalls.length, 0);
  await assert.rejects(readFile(path.join(f.options.runDirectory, 'modal.sqlite')), { code: 'ENOENT' });
});

test('fresh run defaults isolate storage and reservation while explicit identities remain supported', async t => {
  const f = await fixture(t), { runDirectory, ...input } = f.options;
  const fresh = await prepareModalPilot({ ...input, runId: 'modal-next-attempt' }, f.dependencies);
  assert.equal(path.basename(fresh.options.runDirectory), 'modal-next-attempt');
  assert.equal(fresh.options.reservationId, 'modal-next-attempt');
  const explicit = await prepareModalPilot({ ...input, runId: 'modal-next-attempt', runDirectory, reservationId: 'modal-separate-envelope' }, f.dependencies);
  assert.equal(explicit.options.runDirectory, runDirectory);
  assert.equal(explicit.options.reservationId, 'modal-separate-envelope');
  const defaults = await prepareModalPilot({ ...input, runId: undefined }, f.dependencies);
  assert.equal(path.basename(defaults.options.runDirectory), 'modal-20261002');
  assert.equal(defaults.options.reservationId, 'modal-20261002');
  assert.equal(f.httpCalls.length, 0);
});

test('direct and actual FLUJO Flow complete before independently verified fixture/provider retirement', async t => {
  const f = await fixture(t);
  const report = await runModalPilot(f.options, f.dependencies);
  assert.equal(report.state, 'smoke-complete');
  assert.equal(report.connection, 'actual-flujo-flow-tested-and-retired');
  assert.equal(report.finalMeterKnown, false);
  assert.equal(f.models.length, 0); assert.equal(f.flows.length, 0);
  assert.ok(f.calls.includes('stop-app') && f.calls.includes('delete-volume') && f.calls.includes('delete-proxy-token'));
  const generations = f.httpCalls.filter(item => item.pathname === '/v1/chat/completions');
  assert.equal(generations.length, 2);
  assert.equal(generations[1].body.metadata.flujo, 'true');
  assert.equal(generations[0].redirect, 'manual');
  const createdFlow = f.httpCalls.find(item => item.pathname === '/api/flow' && item.method === 'POST').body;
  assert.equal(createdFlow.nodes.find(node => node.data.type === 'process').data.properties.maxTokens, 64);
  assert.ok(f.protections.includes(f.options.runDirectory));
  assert.ok(!JSON.stringify(f.notifications).includes('private'));
  assert.ok(!JSON.stringify(report).includes('owner-private-source-token'));
  const ledger = new SpendingLedger(f.options.spendingPath); t.after(() => ledger.close());
  const status = ledger.status();
  assert.equal(status.meteredSpendCents, null);
  assert.equal(status.committedCents, 3000);
  assert.equal(status.reservations[0].state, 'retired-meter-pending');
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  assert.equal(JSON.parse(journal.get('create-flujo-flow').request_json).flowDigest, digest(createdFlow));
  assert.equal(JSON.parse(journal.get('flujo-generation').request_json).flowDigest, digest(createdFlow));
});

test('completion acceptance requires one terminal assistant, exact ready JSON and the expected direct or Flow model', () => {
  const valid = JSON.parse(safeCompletion('factory-coder'));
  assert.equal(completionEvidence(JSON.stringify(valid), { expectedModel: 'factory-coder' }).state, 'generation-completed');
  const mutations = [
    value => { value.choices[0].finish_reason = 'length'; },
    value => { value.choices[0].message.tool_calls = [{ id: 'x', type: 'function', function: { name: 'external', arguments: '{}' } }]; },
    value => { value.choices[0].message.tool_calls = {}; },
    value => { value.choices[0].message.function_call = { name: 'external', arguments: '{}' }; },
    value => { value.choices[0].message.content = '{"checkpoint":"ready","unexpected":"accepted"}'; },
    value => { value.choices[0].message.content = '[{"checkpoint":"ready"}]'; },
    value => { value.choices[0].message.content = 'null'; },
    value => { value.choices[0].message.role = 'user'; },
    value => { value.choices[0].index = 1; },
    value => { value.choices.push(structuredClone(value.choices[0])); },
    value => { value.choices = []; },
    value => { value.model = 'other-model'; },
    value => { delete value.model; },
  ];
  for (const mutate of mutations) {
    const rejected = structuredClone(valid); mutate(rejected);
    assert.throws(() => completionEvidence(JSON.stringify(rejected), { expectedModel: 'factory-coder' }));
  }
  assert.throws(() => completionEvidence(JSON.stringify(valid)));
  assert.throws(() => completionEvidence(safeCompletion('factory-flow'), { expectedModel: 'factory-flow', flujo: true }));
  assert.equal(completionEvidence(safeCompletion('factory-flow', true), { expectedModel: 'factory-flow', flujo: true }).state, 'generation-completed');
});

test('tool-call or truncated direct response stays unknown, is never retried, and still retires owned resources', async t => {
  for (const change of [value => { value.choices[0].finish_reason = 'length'; },
    value => { value.choices[0].message.tool_calls = [{ id: 'x', type: 'function', function: { name: 'external', arguments: '{}' } }]; }]) {
    const f = await fixture(t, { directCompletion: value => { change(value); return JSON.stringify(value); } });
    const result = await runModalPilot(f.options, f.dependencies);
    assert.equal(result.state, 'requires-reconciliation');
    assert.equal(f.httpCalls.filter(item => item.origin.includes('modal.run')).length, 1);
    assert.equal(f.httpCalls.filter(item => item.pathname === '/api/flow' && item.method === 'POST').length, 0);
    const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite'));
    assert.equal(journal.get('direct-generation').state, 'unknown');
    assert.equal(journal.get('stop-app').state, 'succeeded');
    assert.equal(journal.get('delete-volume').state, 'succeeded');
    journal.close();
  }
});

test('new run pins VolumeFS v2 in manifest, checkpoint and every admitted provider request', async t => {
  const f = await fixture(t);
  await runModalPilot(f.options, f.dependencies);
  const manifest = JSON.parse(await readFile(path.join(f.options.runDirectory, 'manifest.private.json'), 'utf8'));
  const resources = JSON.parse(await readFile(path.join(f.options.runDirectory, 'resources.private.json'), 'utf8'));
  assert.equal(manifest.volumeFsVersion, 2);
  assert.equal(resources.volumeFsVersion, 2);
  assert.equal(resources.volumeId, 'vo-owned');
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  for (const payload of f.payloads) {
    assert.equal(payload.volumeFsVersion, 2);
    if (payload.request) {
      assert.equal(payload.request.volumeFsVersion, 2);
      assert.equal(journal.get(payload.effectKey).request_digest, digest(payload.request));
    }
  }
});

test('partial owned App billing updates known cents without releasing the reservation or claiming final spend', async t => {
  const f = await fixture(t, { meteredCents: 4 });
  const result = await runModalPilot(f.options, f.dependencies);
  const ledger = new SpendingLedger(f.options.spendingPath); t.after(() => ledger.close());
  const status = ledger.status();
  assert.equal(status.knownMeteredCents, 4);
  assert.equal(status.meteredSpendCents, null);
  assert.equal(status.committedCents, 3000);
  assert.equal(status.reservations[0].state, 'retired-meter-pending');
  assert.equal(result.finalMeterKnown, false);
  const meter = JSON.parse(await readFile(path.join(f.options.runDirectory, 'meter.private.json'), 'utf8'));
  assert.equal(meter.final, false);
  assert.equal(meter.buildCostAttribution, 'unverified');
  assert.equal(meter.matchedRowCostUsdSum, '0.03503811');
  assert.ok(!JSON.stringify(f.notifications).includes('0.03503811'));
  assert.ok(!JSON.stringify(result.events).includes('reportStart'));
  assert.ok(!JSON.stringify(result.events).includes('reportEnd'));
  assert.ok(!JSON.stringify(result.events).includes('matchedRowCostUsdSum'));
});

test('legacy v1 cleanup preserves version-free original request bytes and never redeploys or refills budget', async t => {
  const settings = { sdkFailures: ['prefetch', 'stop-app'] }, f = await fixture(t, settings);
  await runModalPilot(f.options, f.dependencies);
  // Materialize the exact version-free persisted format from pre-v2 runs.
  // Only this offline fixture is rewritten; actual old journals stay immutable.
  const manifestPath = path.join(f.options.runDirectory, 'manifest.private.json');
  const resourcePath = path.join(f.options.runDirectory, 'resources.private.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.volumeFsVersion;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const owned = JSON.parse(await readFile(resourcePath, 'utf8'));
  await writeFile(resourcePath, JSON.stringify({ ...owned, volumeFsVersion: 1 }));
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  for (const row of journal.db.prepare('SELECT key,request_json FROM modal_operations').all()) {
    const request = JSON.parse(row.request_json); delete request.volumeFsVersion;
    journal.db.prepare('UPDATE modal_operations SET request_json=?,request_digest=? WHERE key=?')
      .run(JSON.stringify(request), digest(request), row.key);
  }
  const originalStop = journal.get('stop-app');
  const ledger = new SpendingLedger(f.options.spendingPath); t.after(() => ledger.close());
  const originalCommitment = ledger.status().committedCents;
  const callsBefore = f.calls.length;
  settings.sdkFailures = ['prefetch'];
  await runModalPilot({ ...f.options, cleanupOnly: true }, f.dependencies);
  const completedStop = journal.get('stop-app');
  assert.equal(completedStop.state, 'succeeded');
  assert.equal(completedStop.request_json, originalStop.request_json);
  assert.equal(completedStop.request_digest, originalStop.request_digest);
  assert.equal(journal.get('prefetch').state, 'unknown');
  assert.equal(journal.get('delete-volume').state, 'succeeded');
  const cleanupPayloads = f.payloads.slice(callsBefore);
  assert.ok(cleanupPayloads.some(payload => payload.operation === 'reconcile-stop-app'));
  assert.ok(cleanupPayloads.some(payload => payload.operation === 'delete-volume'));
  assert.ok(cleanupPayloads.every(payload => !('volumeFsVersion' in payload)
    && (!payload.request || !('volumeFsVersion' in payload.request))));
  assert.equal(f.calls.filter(operation => operation === 'deploy').length, 1);
  assert.equal(f.calls.filter(operation => operation === 'prefetch').length, 1);
  assert.equal(ledger.status().committedCents, originalCommitment);
  assert.equal(ledger.status().reservations[0].state, 'retired-meter-pending');
  const retired = JSON.parse(await readFile(resourcePath, 'utf8'));
  assert.equal(retired.volumeId, 'vo-owned');
  assert.equal(retired.volumeFsVersion, 1);
});

test('legacy uncapped Flow cleanup uses original authored digest and201 proof with unknown generation preserved', async t => {
  const settings = {}, f = await fixture(t, settings);
  const names = ['manifest.private.json', 'resources.private.json', 'redeployable-fixture.private.json',
    'fixture-ownership.private.json', 'create-flow-response.private.json', 'create-flow-response.private.json.http.private.json'];
  let snapshot;
  settings.beforeFlowCompletion = async () => {
    const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite'));
    const rows = journal.db.prepare('SELECT * FROM modal_operations').all(); journal.close();
    snapshot = { rows, files: Object.fromEntries(await Promise.all(names.map(async name =>
      [name, await readFile(path.join(f.options.runDirectory, name))]))), models: structuredClone(f.models), flows: structuredClone(f.flows) };
  };
  await runModalPilot(f.options, f.dependencies);
  settings.beforeFlowCompletion = undefined;
  assert.ok(snapshot.flows.length === 1, 'The offline runner actually created its Flow before the crash snapshot');
  // Restore the captured pre-cleanup fixture state, then represent the exact
  // uncapped authored bytes/version-free journal format of an old v1 run.
  for (const stem of ['disable-model-response.private.json', 'delete-flow-response.private.json', 'delete-model-response.private.json']) {
    await unlink(path.join(f.options.runDirectory, stem));
    await unlink(path.join(f.options.runDirectory, `${stem}.http.private.json`));
  }
  for (const [name, bytes] of Object.entries(snapshot.files)) await writeFile(path.join(f.options.runDirectory, name), bytes);
  const legacyFlow = structuredClone(snapshot.flows[0]);
  delete legacyFlow.nodes.find(node => node.data.type === 'process').data.properties.maxTokens;
  const legacyFlowDigest = digest(legacyFlow);
  const manifest = JSON.parse(snapshot.files['manifest.private.json']); delete manifest.volumeFsVersion;
  await writeFile(path.join(f.options.runDirectory, 'manifest.private.json'), JSON.stringify(manifest));
  const owned = JSON.parse(snapshot.files['resources.private.json']); owned.volumeFsVersion = 1;
  await writeFile(path.join(f.options.runDirectory, 'resources.private.json'), JSON.stringify(owned));
  const authored = JSON.parse(snapshot.files['redeployable-fixture.private.json']); authored.flow = legacyFlow;
  await writeFile(path.join(f.options.runDirectory, 'redeployable-fixture.private.json'), JSON.stringify(authored));
  const ownership = JSON.parse(snapshot.files['fixture-ownership.private.json']);
  ownership.flowDigest = legacyFlowDigest; delete ownership.flowCreated; //201 survived the lost checkpoint.
  await writeFile(path.join(f.options.runDirectory, 'fixture-ownership.private.json'), JSON.stringify(ownership));
  const flowHttp = JSON.parse(snapshot.files['create-flow-response.private.json.http.private.json']);
  flowHttp.bodyDigest = legacyFlowDigest;
  await writeFile(path.join(f.options.runDirectory, 'create-flow-response.private.json.http.private.json'), JSON.stringify(flowHttp));
  await writeFile(path.join(f.options.runDirectory, 'create-flow-response.private.json'), JSON.stringify(legacyFlow));
  f.models.push(...snapshot.models); f.flows.push(legacyFlow);
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  journal.db.exec('BEGIN IMMEDIATE');
  try {
    journal.db.exec('DELETE FROM modal_operations');
    for (const row of snapshot.rows) {
      const request = JSON.parse(row.request_json); delete request.volumeFsVersion;
      if ('flowDigest' in request) request.flowDigest = legacyFlowDigest;
      journal.db.prepare('INSERT INTO modal_operations VALUES(?,?,?,?,?,?,?,?)').run(row.key, row.operation,
        digest(request), JSON.stringify(request), row.state, row.result_json, row.created, row.updated);
    }
    journal.db.exec('COMMIT');
  } catch (error) { journal.db.exec('ROLLBACK'); throw error; }
  journal.settle('flujo-generation', 'unknown', { state: 'unknown' });
  const originalFlowIntent = journal.get('create-flujo-flow');
  const ledger = new SpendingLedger(f.options.spendingPath); t.after(() => ledger.close());
  const beforeBudget = ledger.status(), callsBefore = f.calls.length, httpBefore = f.httpCalls.length;
  await runModalPilot({ ...f.options, cleanupOnly: true }, f.dependencies);
  assert.equal(journal.get('create-flujo-flow').request_json, originalFlowIntent.request_json);
  assert.equal(journal.get('create-flujo-flow').request_digest, originalFlowIntent.request_digest);
  assert.equal(journal.get('flujo-generation').state, 'unknown');
  assert.equal(journal.get('disable-flujo-model').state, 'succeeded');
  assert.equal(journal.get('delete-flujo-flow').state, 'succeeded');
  assert.equal(journal.get('delete-flujo-model').state, 'succeeded');
  assert.equal(f.flows.length, 0); assert.equal(f.models.length, 0);
  const cleanupHttp = f.httpCalls.slice(httpBefore);
  assert.ok(cleanupHttp.findIndex(call => call.method === 'PUT') < cleanupHttp.findIndex(call => call.method === 'DELETE' && call.pathname.startsWith('/api/flow/')));
  assert.ok(cleanupHttp.every(call => call.method !== 'POST'));
  assert.ok(f.calls.slice(callsBefore).every(operation => !['create-volume', 'deploy', 'prefetch', 'create-proxy-token'].includes(operation)));
  assert.equal(ledger.status().committedCents, beforeBudget.committedCents);
  assert.equal(ledger.status().limitCents, beforeBudget.limitCents);
});

test('proxy cleanup failure cannot claim retired completion and cannot suppress App/Volume cleanup', async t => {
  const f = await fixture(t, { sdkFailure: 'delete-proxy-token' });
  const report = await runModalPilot(f.options, f.dependencies);
  assert.equal(report.state, 'requires-reconciliation');
  assert.notEqual(report.connection, 'actual-flujo-flow-tested-and-retired');
  assert.ok(f.calls.includes('stop-app') && f.calls.includes('delete-volume'));
  assert.equal(report.cleanup.find(item => item.operation === 'delete-proxy-token').state, 'unknown');
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  assert.equal(journal.get('delete-proxy-token').state, 'unknown');
});

test('fixture deletion failure leaves an explicitly disabled model and prevents a complete/retired claim', async t => {
  const f = await fixture(t, { fixtureDeleteFailure: true });
  const report = await runModalPilot(f.options, f.dependencies);
  assert.equal(report.state, 'requires-reconciliation');
  assert.equal(f.models[0].ApiKey, '');
  assert.match(f.models[0].displayName, /retired/);
  assert.ok(f.calls.includes('stop-app') && f.calls.includes('delete-volume'));
});

test('confirmed model201 survives private ownership checkpoint failure without replaying creation', async t => {
  const f = await fixture(t, { checkpointFailure: true });
  const report = await runModalPilot(f.options, f.dependencies);
  assert.equal(report.state, 'requires-reconciliation');
  assert.equal(f.httpCalls.filter(item => item.pathname === '/api/model' && item.method === 'POST').length, 1);
  assert.equal(f.models.length, 0);
  assert.ok(f.calls.includes('stop-app') && f.calls.includes('delete-volume') && f.calls.includes('delete-proxy-token'));
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  assert.equal(journal.get('create-flujo-model').state, 'unknown');
  assert.equal(journal.get('delete-flujo-model').state, 'succeeded');
});

test('unknown generation redirects are retained privately, never replayed, and owned resources retire', async t => {
  const f = await fixture(t, { redirect: true, notifyFailure: true });
  const report = await runModalPilot(f.options, f.dependencies);
  assert.equal(report.state, 'requires-reconciliation');
  assert.equal(f.httpCalls.filter(item => item.origin.includes('modal.run')).length, 1);
  assert.ok(f.calls.includes('stop-app') && f.calls.includes('delete-volume'));
  assert.ok(!JSON.stringify(f.notifications).includes('private'));
  const location = JSON.parse(await readFile(path.join(f.options.runDirectory, 'direct-result-url.private.json'), 'utf8'));
  assert.match(location.location, /result=private/);
});

test('one POST303 followed by validated GET200 preserves opaque query, original intent and absolute signal', async t => {
  const query = '?__modal_result=opaque%2f+%2B&x=1&x=2';
  const f = await fixture(t, { modalHttpResponse: ({ init, expectedModel }) => init.method === 'POST'
    ? new Response('private pending result', { status: 303, headers: { location: query } })
    : new Response(safeCompletion(expectedModel), { status: 200 }) });
  const result = await runModalPilot(f.options, f.dependencies);
  assert.equal(result.state, 'smoke-complete');
  const requests = f.httpCalls.filter(call => call.origin.includes('modal.run'));
  assert.deepEqual(requests.map(call => call.method), ['POST', 'GET']);
  assert.equal(new URL(requests[1].url).search, query);
  assert.equal(requests[1].body, null);
  assert.equal(requests[1].headers['Content-Type'], undefined);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.ok(requests.every(call => call.redirect === 'manual'));
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  const intent = journal.get('direct-generation');
  assert.equal(intent.state, 'succeeded');
  assert.equal(JSON.parse(intent.request_json).deadlineMs, 600_000);
  assert.equal(JSON.parse(intent.request_json).resultGetLimit, 3);
  for (const hop of [0, 1]) {
    const receipt = JSON.parse(await readFile(path.join(f.options.runDirectory, `direct-http-${hop}.private.json`), 'utf8'));
    assert.equal(receipt.effectKey, 'direct-generation');
    assert.equal(receipt.requestDigest, intent.request_digest);
    assert.equal(receipt.originalUrl, requests[0].url);
    assert.equal(receipt.appId, 'ap-owned');
    assert.equal(receipt.status, hop === 0 ? 303 : 200);
  }
  const final = JSON.parse(await readFile(path.join(f.options.runDirectory, 'direct-response.private.json'), 'utf8'));
  assert.equal(final.choices[0].message.content, '{"checkpoint":"ready"}');
  assert.ok(!JSON.stringify(f.notifications).includes('opaque'));
  assert.ok(!JSON.stringify(result).includes('opaque'));
});

test('repeated303 stops after three GETs without repeating POST and retains original unknown work', async t => {
  const f = await fixture(t, { modalHttpResponse: () => new Response('pending', { status: 303,
    headers: { location: '?__modal_result=private' } }) });
  const result = await runModalPilot(f.options, f.dependencies);
  const requests = f.httpCalls.filter(call => call.origin.includes('modal.run'));
  assert.deepEqual(requests.map(call => call.method), ['POST', 'GET', 'GET', 'GET']);
  assert.ok(requests.every(call => call.signal === requests[0].signal));
  assert.equal(result.state, 'requires-reconciliation');
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  assert.equal(journal.get('direct-generation').state, 'unknown');
  assert.equal(journal.get('stop-app').state, 'succeeded');
  assert.equal(journal.get('delete-volume').state, 'succeeded');
  assert.equal((await readdir(f.options.runDirectory)).filter(name => /^direct-http-\d\.private\.json$/.test(name)).length, 4);
});

test('unsafe303 result URLs never receive GET or bearer transmission', async t => {
  const locations = ['https://other.modal.run/v1/chat/completions?private=1',
    'https://factory--serve.modal.run:444/v1/chat/completions?private=1',
    'https://factory--serve.modal.run/wrong-path?private=1',
    'http://factory--serve.modal.run/v1/chat/completions?private=1',
    'https://user:pass@factory--serve.modal.run/v1/chat/completions?private=1',
    '/v1/chat/completions?private=1#fragment', '/v1/chat/completions?private=1#',
    '/v1/chat/completions', '/v1/chat/completions?', '', null];
  for (const location of locations) {
    const f = await fixture(t, { modalHttpResponse: () => new Response('private redirect', { status: 303,
      headers: location === null ? {} : { location } }) });
    const result = await runModalPilot(f.options, f.dependencies);
    assert.equal(result.state, 'requires-reconciliation');
    assert.equal(f.httpCalls.filter(call => call.origin.includes('modal.run')).length, 1);
    assert.equal(f.httpCalls.filter(call => call.method === 'GET').length, 0);
    assert.ok(f.calls.includes('stop-app') && f.calls.includes('delete-volume'));
  }
});

test('non303 HTTP status never authorizes a result request or another POST', async t => {
  for (const status of [307, 503]) {
    const f = await fixture(t, { modalHttpResponse: () => new Response('private error', { status,
      headers: { location: '?__modal_result=private' } }) });
    const result = await runModalPilot(f.options, f.dependencies);
    assert.equal(result.state, 'requires-reconciliation');
    assert.deepEqual(f.httpCalls.filter(call => call.origin.includes('modal.run')).map(call => call.method), ['POST']);
  }
});

test('result GET still rejects truncated completion and oversized body while resources retire', async t => {
  for (const oversized of [false, true]) {
    const f = await fixture(t, { modalHttpResponse: ({ init, expectedModel }) => {
      if (init.method === 'POST') return new Response('pending', { status: 303, headers: { location: '?__modal_result=private' } });
      const value = JSON.parse(safeCompletion(expectedModel)); value.choices[0].finish_reason = 'length';
      return new Response(oversized ? 'x'.repeat(1024 * 1024 + 1) : JSON.stringify(value), { status: 200 });
    } });
    const result = await runModalPilot(f.options, f.dependencies);
    assert.equal(result.state, 'requires-reconciliation');
    assert.deepEqual(f.httpCalls.filter(call => call.origin.includes('modal.run')).map(call => call.method), ['POST', 'GET']);
    const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite'));
    assert.equal(journal.get('direct-generation').state, 'unknown');
    assert.equal(journal.get('stop-app').state, 'succeeded');
    assert.equal(journal.get('delete-volume').state, 'succeeded'); journal.close();
  }
});

test('single600-second absolute signal cancels pending result body and still permits cleanup', async t => {
  const nativeTimeout = AbortSignal.timeout, controller = new AbortController();
  let deadlineCreations = 0, bodyCancelled = false;
  AbortSignal.timeout = milliseconds => {
    if (milliseconds === 600_000) { deadlineCreations += 1; return controller.signal; }
    return nativeTimeout(milliseconds);
  };
  try {
    const f = await fixture(t, { modalHttpResponse: ({ init }) => {
      if (init.method === 'POST') return new Response('pending', { status: 303, headers: { location: '?__modal_result=private' } });
      const body = new ReadableStream({ pull() { queueMicrotask(() => controller.abort(new DOMException('private timeout', 'TimeoutError'))); },
        cancel() { bodyCancelled = true; } }, { highWaterMark: 0 });
      return new Response(body, { status: 200 });
    } });
    const result = await runModalPilot(f.options, f.dependencies);
    const requests = f.httpCalls.filter(call => call.origin.includes('modal.run'));
    assert.equal(deadlineCreations, 1);
    assert.deepEqual(requests.map(call => call.method), ['POST', 'GET']);
    assert.ok(requests.every(call => call.signal === controller.signal));
    assert.equal(bodyCancelled, true);
    assert.equal(result.state, 'requires-reconciliation');
    assert.ok(f.calls.includes('stop-app') && f.calls.includes('delete-volume'));
    assert.ok(!JSON.stringify(result).includes('private timeout'));
  } finally { AbortSignal.timeout = nativeTimeout; }
});

test('refused rerun preserves original report and never creates another provider effect', async t => {
  const f = await fixture(t);
  const original = await runModalPilot(f.options, f.dependencies);
  assert.equal(original.state, 'smoke-complete');
  const reportPath = path.join(f.options.runDirectory, 'report.private.json');
  const bytes = await readFile(reportPath, 'utf8'), count = f.calls.length;
  const refused = await runModalPilot(f.options, f.dependencies);
  assert.equal(refused.state, 'requires-reconciliation');
  assert.equal(f.calls.length, count);
  assert.equal(await readFile(reportPath, 'utf8'), bytes);
});

test('cleanup-only observation preserves original report/retirement proof and never restarts a retired budget', async t => {
  const f = await fixture(t);
  await runModalPilot(f.options, f.dependencies);
  const reportPath = path.join(f.options.runDirectory, 'report.private.json'), retirementPath = path.join(f.options.runDirectory, 'retirement.private.json');
  const reportBytes = await readFile(reportPath, 'utf8'), retirementBytes = await readFile(retirementPath, 'utf8');
  const effectsBefore = f.calls.filter(item => item !== 'prepare' && item !== 'meter').length;
  const observed = await runModalPilot({ ...f.options, cleanupOnly: true }, f.dependencies);
  assert.equal(observed.state, 'requires-reconciliation');
  assert.equal(await readFile(reportPath, 'utf8'), reportBytes);
  assert.equal(await readFile(retirementPath, 'utf8'), retirementBytes);
  assert.equal(f.calls.filter(item => item !== 'prepare' && item !== 'meter').length, effectsBefore);
  assert.ok(!observed.cleanup.some(item => item.operation === 'spending-retire' && item.state === 'unknown'));
});

test('owned fresh stop reconciliation permits only undispatched volume cleanup and preserves original unknown work', async t => {
  const settings = { sdkFailures: ['prefetch', 'stop-app'] }, f = await fixture(t, settings);
  await runModalPilot(f.options, f.dependencies);
  const reportPath = path.join(f.options.runDirectory, 'report.private.json'), retirementPath = path.join(f.options.runDirectory, 'retirement.private.json');
  const originalReport = await readFile(reportPath, 'utf8'), originalRetirement = await readFile(retirementPath, 'utf8');
  settings.sdkFailures = ['prefetch'];
  const report = await runModalPilot({ ...f.options, cleanupOnly: true }, f.dependencies);
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  assert.equal(journal.get('stop-app').state, 'succeeded');
  assert.equal(journal.get('stop-app').result.reconciled, true);
  assert.match(journal.get('stop-app').result.reconciliationProofDigest, /^[a-f0-9]{64}$/);
  assert.equal(journal.get('prefetch').state, 'unknown');
  assert.equal(journal.get('delete-volume').state, 'succeeded');
  assert.equal(f.calls.filter(item => item === 'stop-app').length, 1);
  assert.equal(f.calls.filter(item => item === 'prefetch').length, 1);
  assert.equal(f.calls.filter(item => item === 'reconcile-stop-app').length, 1);
  assert.equal(f.calls.filter(item => item === 'delete-volume').length, 1);
  assert.equal(report.state, 'requires-reconciliation');
  assert.equal(await readFile(reportPath, 'utf8'), originalReport);
  assert.equal(await readFile(retirementPath, 'utf8'), originalRetirement);
  const proofNames = (await readdir(f.options.runDirectory)).filter(name => /^stop-reconciliation-.*\.private\.json$/.test(name));
  assert.equal(proofNames.length, 1);
  const proof = JSON.parse(await readFile(path.join(f.options.runDirectory, proofNames[0]), 'utf8'));
  assert.equal(proof.originalKey, 'stop-app');
  assert.equal(proof.originalRequestDigest, journal.get('stop-app').request_digest);
  const ledger = new SpendingLedger(f.options.spendingPath); t.after(() => ledger.close());
  assert.equal(ledger.status().reservations[0].state, 'retired-meter-pending');
  assert.equal(ledger.status().committedCents, 3000);
});

test('damaged authored Flow evidence cannot block independently owned provider retirement', async t => {
  const settings = { sdkFailures: ['prefetch', 'stop-app'] }, f = await fixture(t, settings);
  await runModalPilot(f.options, f.dependencies);
  await writeFile(path.join(f.options.runDirectory, 'redeployable-fixture.private.json'), 'invalid fixture JSON');
  settings.sdkFailures = ['prefetch'];
  const result = await runModalPilot({ ...f.options, cleanupOnly: true }, f.dependencies);
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite')); t.after(() => journal.close());
  assert.equal(result.state, 'requires-reconciliation');
  assert.equal(journal.get('stop-app').state, 'succeeded');
  assert.equal(journal.get('delete-volume').state, 'succeeded');
  assert.equal(journal.get('prefetch').state, 'unknown');
  assert.equal(f.calls.filter(operation => operation === 'deploy').length, 1);
  assert.equal(f.calls.filter(operation => operation === 'prefetch').length, 1);
});

test('fabricated or live stop proof cannot settle the original intent or unlock volume deletion', async t => {
  for (const badProof of [{ reconcileAppId: 'ap-other' }, { reconcileState: 'stopping...' }, { reconcileContainers: 1 }, { reconcileContainers: false }]) {
    const settings = { sdkFailures: ['prefetch', 'stop-app'], ...badProof }, f = await fixture(t, settings);
    await runModalPilot(f.options, f.dependencies);
    settings.sdkFailures = ['prefetch'];
    await runModalPilot({ ...f.options, cleanupOnly: true }, f.dependencies);
    const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite'));
    assert.equal(journal.get('stop-app').state, 'unknown');
    assert.equal(journal.get('prefetch').state, 'unknown');
    assert.equal(journal.get('delete-volume'), null);
    assert.equal(f.calls.filter(item => item === 'stop-app').length, 1);
    assert.equal(f.calls.filter(item => item === 'delete-volume').length, 0);
    journal.close();
  }
});

test('changed original stop digest rejects reconciliation before any fresh provider inspection', async t => {
  const settings = { sdkFailures: ['prefetch', 'stop-app'] }, f = await fixture(t, settings);
  await runModalPilot(f.options, f.dependencies);
  const journal = new ModalJournal(path.join(f.options.runDirectory, 'modal.sqlite'));
  journal.db.prepare("UPDATE modal_operations SET request_digest=? WHERE key='stop-app'").run('b'.repeat(64));
  journal.close();
  settings.sdkFailures = ['prefetch'];
  await runModalPilot({ ...f.options, cleanupOnly: true }, f.dependencies);
  assert.equal(f.calls.filter(item => item === 'reconcile-stop-app').length, 0);
  assert.equal(f.calls.filter(item => item === 'stop-app').length, 1);
  assert.equal(f.calls.filter(item => item === 'delete-volume').length, 0);
});

test('a started common budget over ceiling blocks a fresh provider dispatch while preserving conservative reservation', async t => {
  const f = await fixture(t);
  const ledger = new SpendingLedger(f.options.spendingPath); t.after(() => ledger.close());
  ledger.initialize({ limitCents: 10000, currency: 'USD' });
  ledger.reserve({ reservationId: f.options.runId, provider: 'modal', ceilingCents: 3000 });
  ledger.start(f.options.runId);
  ledger.observe(f.options.runId, { chargedCents: 3000, observedAt: Date.now(), evidenceDigest: 'a'.repeat(64) });
  const report = await runModalPilot(f.options, { ...f.dependencies, spending: ledger });
  assert.equal(report.state, 'requires-reconciliation');
  assert.equal(f.calls.filter(item => item !== 'prepare' && item !== 'meter').length, 0);
  assert.equal(ledger.status().committedCents, 3000);
});
