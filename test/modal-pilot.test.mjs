import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { ModalJournal, prepareModalPilot, runModalPilot } from '../scripts/modal-pilot.mjs';
import { SpendingLedger } from '../src/spending.mjs';

const SOURCE = { origin: 'http://127.0.0.1:4200', instanceId: 'source-instance', appRoot: 'fake-app', dataRoot: 'fake-data' };
const safeCompletion = (flujo = false) => JSON.stringify({ object: 'chat.completion', ...(flujo ? { status: 'completed' } : {}),
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"checkpoint":"ready"}' } }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } });

async function fixture(t, settings = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-modal-test-'));
  const runDirectory = path.join(directory, 'run'), sourceEvidencePath = path.join(directory, 'source.json');
  await writeFile(sourceEvidencePath, JSON.stringify({ source: SOURCE, fixtureAlreadyExists: false }));
  const options = { runId: 'offline-modal', runDirectory, sourceEvidencePath, spendingPath: path.join(directory, 'spending.sqlite') };
  const calls = [], httpCalls = [], notifications = [], protections = [], models = [], flows = [];
  let resourceState = {};
  const persist = async () => writeFile(path.join(runDirectory, 'resources.private.json'), JSON.stringify(resourceState));
  const source = { source: SOURCE.origin, instanceId: SOURCE.instanceId, appRoot: SOURCE.appRoot, dataRoot: SOURCE.dataRoot, token: 'owner-private-source-token' };
  const driver = async payload => {
    calls.push(payload.operation);
    if (payload.operation === 'prepare') return { state: 'prepared', profile: 'fake-profile', workspaceName: 'factory-account', environment: 'main', credentialsAccepted: true, appAbsent: true, volumeAbsent: true };
    if (payload.operation === settings.sdkFailure) throw new Error('private raw token diagnostic');
    resourceState = { ...resourceState, runId: payload.runId, appName: payload.appName, volumeName: payload.volumeName,
      environment: payload.environment, profile: payload.profile, workspaceName: payload.workspaceName };
    switch (payload.operation) {
      case 'create-volume': resourceState.volumeId = 'vo-owned'; resourceState.volumeCreated = true; await persist(); return { state: 'volume-created', volumeId: 'vo-owned' };
      case 'deploy': Object.assign(resourceState, { appId: 'ap-owned', appDeployed: true, serveFunctionId: 'fu-serve', prefetchFunctionId: 'fu-prefetch', endpoint: 'https://factory--serve.modal.run' }); await persist(); return { state: 'deployed', ...resourceState };
      case 'prefetch': resourceState.weightsCached = true; await persist(); return { state: 'weights-cached' };
      case 'create-proxy-token':
        Object.assign(resourceState, { proxyTokenCreated: true, proxyTokenId: 'wk-fake' }); await persist();
        await writeFile(path.join(runDirectory, 'proxy-token.private.json'), JSON.stringify({ runId: payload.runId, profile: payload.profile, tokenId: 'wk-fake', tokenSecret: 'ws-private-proxy-token', bearer: 'wk-fake.ws-private-proxy-token' }));
        return { state: 'proxy-token-created', tokenStoredPrivately: true };
      case 'stop-app': resourceState.appStopped = true; await persist(); return { state: 'stopped', appId: 'ap-owned', runningContainers: 0 };
      case 'delete-volume': resourceState.volumeDeleted = true; await persist(); return { state: 'volume-deleted', volumeId: 'vo-owned' };
      case 'delete-proxy-token': resourceState.proxyTokenDeleted = true; await persist(); return { state: 'proxy-token-deleted' };
      case 'meter': return { state: 'billing-unavailable', knownMeteredCents: 0, observedAt: Date.now(), resourceRows: 0, final: false };
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
    httpCalls.push({ origin: parsed.origin, pathname: parsed.pathname, method: init.method, body, headers: init.headers, redirect: init.redirect });
    if (parsed.hostname.endsWith('.modal.run')) {
      if (settings.redirect) return new Response('private redirect body', { status: 303, headers: { location: 'https://factory--serve.modal.run/?result=private' } });
      return new Response(safeCompletion(), { status: 200 });
    }
    assert.equal(init.headers.Origin, SOURCE.origin);
    assert.equal(init.headers['x-flujo-workspace'], 'factory-pilot');
    if (parsed.pathname === '/api/model' && init.method === 'POST') { models.push(body); return new Response(JSON.stringify({ ...body, ApiKey: '********' }), { status: 201 }); }
    if (parsed.pathname === '/api/flow' && init.method === 'POST') { flows.push(body); return new Response(JSON.stringify(body), { status: 201 }); }
    if (parsed.pathname === '/v1/chat/completions') return new Response(safeCompletion(true), { status: 200 });
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
  return { directory, options, dependencies, calls, httpCalls, notifications, protections, models, flows };
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
  assert.ok(f.protections.includes(f.options.runDirectory));
  assert.ok(!JSON.stringify(f.notifications).includes('private'));
  assert.ok(!JSON.stringify(report).includes('owner-private-source-token'));
  const ledger = new SpendingLedger(f.options.spendingPath); t.after(() => ledger.close());
  const status = ledger.status();
  assert.equal(status.meteredSpendCents, null);
  assert.equal(status.committedCents, 3000);
  assert.equal(status.reservations[0].state, 'retired-meter-pending');
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

test('a started common budget over ceiling blocks a fresh provider dispatch while preserving conservative reservation', async t => {
  const f = await fixture(t);
  const ledger = new SpendingLedger(f.options.spendingPath); t.after(() => ledger.close());
  ledger.initialize({ limitCents: 10000, currency: 'USD' });
  ledger.reserve({ reservationId: 'modal-20261002', provider: 'modal', ceilingCents: 3000 });
  ledger.start('modal-20261002');
  ledger.observe('modal-20261002', { chargedCents: 3000, observedAt: Date.now(), evidenceDigest: 'a'.repeat(64) });
  const report = await runModalPilot(f.options, { ...f.dependencies, spending: ledger });
  assert.equal(report.state, 'requires-reconciliation');
  assert.equal(f.calls.filter(item => item !== 'prepare' && item !== 'meter').length, 0);
  assert.equal(ledger.status().committedCents, 3000);
});
