import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as privateFiles from '../deploy/private-files.mjs';
import { createManagedCloudAdapter } from '../src/adapters/managed-cloud.mjs';
import { createManagedCloudSourceBinding, validateManagedCloudSourceProfile } from '../src/adapters/managed-cloud-source.mjs';

const compatibility = { applicationVersion: '3.46.2', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 };
const invalid = { code: 'MANAGED_CLOUD_INPUT_INVALID' };
const safeUnknown = error => error.outcome === 'unknown' && error.cause === undefined;

async function fixture(t, { revision = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-private-source-'));
  await privateFiles.ensurePrivateDirectory(directory);
  const state = { token: randomBytes(32).toString('base64url'), mode: 'ready', routes: [], calls: [], reads: 0, leak: null };
  const worker = { workspace: 'fixture', archiveSha256: 'b'.repeat(64), compatibility: { ...compatibility, ...(revision ? { revision: 'c'.repeat(40) } : {}) } };
  const server = http.createServer((request, response) => {
    state.routes.push(request.url);
    if (request.headers.authorization !== 'Bearer ' + state.token) { response.writeHead(401); response.end('{}'); return; }
    if (state.mode === 'redirect') { response.writeHead(302, { location: '/api/worker/status' }); response.end(); return; }
    if (state.mode === 'oversize') { response.writeHead(200); response.end(' '.repeat(65537)); return; }
    let result;
    if (request.url === '/api/worker/status') result = { mode: 'worker', state: state.mode === 'not-ready' ? 'restoring' : 'ready',
      workspace: state.mode === 'workspace' ? 'foreign' : worker.workspace,
      archiveSha256: state.mode === 'archive' ? 'd'.repeat(64) : worker.archiveSha256 };
    else if (request.url === '/api/snapshot/info?workspace=fixture') result = {
      workspace: state.mode === 'info-workspace' ? 'foreign' : worker.workspace,
      capability: state.mode === 'busy' ? 'busy' : 'available', activeOperation: state.mode === 'active-operation' ? { state: 'capturing' } : null,
      workerCompatibility: state.mode === 'compatibility' ? { ...worker.compatibility, workerProtocolVersion: 99 } : worker.compatibility };
    else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = { schemaVersion: 1, origin: 'http://127.0.0.1:' + server.address().port,
    tokenFile: path.join(directory, 'source-token.private.json'), dataRoot: path.join(directory, 'native-data'), worker: structuredClone(worker) };
  await privateFiles.writePrivateJson(profile.tokenFile, { token: state.token }, { exclusive: true });
  const modulePath = path.join(directory, 'managed.mjs');
  await writeFile(modulePath, `export class ManagedCloud {
    constructor(options) { this.options = options; this.env = {}; this.options.trace('constructor'); }
    async sources() { this.options.trace('sources'); return this.options.discover(); }
    async preflight(input) { this.options.trace('preflight', input); await this.options.discover({source:input.source}); return {workspace:input.workspace,source:input.source,readyToDeploy:true}; }
    async up(input) { this.options.trace('up', input); await this.options.discover({source:input.source}); return {worker:input.app,app:input.app,workspace:input.workspace,state:this.options.leak()??'ready',source:input.source}; }
    async list() { this.options.trace('list'); return [{worker:'fixture-child',workspace:'fixture',state:this.options.leak()??'ready'}]; }
    async down(id) { this.options.trace('down',id); return {worker:id,state:this.options.leak()??'destroyed'}; }
    async call() { this.options.trace('call'); return {contentType:'text/plain',body:this.options.leak()??'fixture output'}; }
  }\n`, { mode: 0o600 });
  const helper = { async readPrivateJson(...args) { state.reads++; return privateFiles.readPrivateJson(...args); } };
  const options = { trace(...entry) { state.calls.push(entry); }, leak() { return state.leak; } };
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); });
  return { state, profile, server, modulePath, helper, options, async adapter(extra = {}) {
    return createManagedCloudAdapter({ modulePath, options, sourceWorkerProfile: profile, privateFiles: helper, ...extra });
  } };
}

test('private source profile is closed, preserves both compatibility formats and rejects malformed bindings', async t => {
  const f = await fixture(t);
  assert.deepEqual(validateManagedCloudSourceProfile(f.profile), f.profile);
  const official = structuredClone(f.profile); official.worker.compatibility.revision = 'c'.repeat(40);
  assert.deepEqual(validateManagedCloudSourceProfile(official), official);
  const mutations = [p => { p.extra = true; }, p => { p.schemaVersion = true; }, p => { p.origin += '/path'; },
    p => { p.origin = 'http://localhost:4200'; }, p => { p.origin = 'https://example.invalid'; },
    p => { p.tokenFile = 'relative.json'; }, p => { p.dataRoot = 'relative'; }, p => { p.worker.pid = 1; },
    p => { p.worker.workspace = 'fixture.other'; }, p => { p.worker.archiveSha256 = 'B'.repeat(64); },
    p => { p.worker.compatibility.revision = true; }, p => { p.worker.compatibility.revision = 'C'.repeat(40); },
    p => { p.worker.compatibility.revision = null; }, p => { p.worker.compatibility.workerProtocolVersion = true; },
    p => { p.worker.compatibility.futureField = 1; }];
  for (const mutate of mutations) { const p = structuredClone(f.profile); mutate(p); assert.throws(() => validateManagedCloudSourceProfile(p), invalid); }
});

test('bound construction is inert and refuses injected services, discovery overrides and missing private readers', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter({ service: {} }), invalid);
  await assert.rejects(f.adapter({ options: { ...f.options, discover() {} } }), invalid);
  await assert.rejects(f.adapter({ privateFiles: {} }), invalid);
  const a = await f.adapter();
  assert.equal(a.source.kind, 'module'); assert.deepEqual(f.state.calls, [['constructor']]);
  assert.equal(f.state.reads, 0); assert.deepEqual(f.state.routes, []);
});

test('authenticated native discovery carries a nonenumerable token with no synthetic desktop identity', async t => {
  const f = await fixture(t, { revision: true });
  const binding = createManagedCloudSourceBinding({ sourceWorkerProfile: f.profile, privateFiles: f.helper });
  const original = structuredClone(f.profile); f.profile.worker.workspace = 'changed-after-construction';
  const [source] = await binding.discover();
  assert.deepEqual(Object.keys(source), ['source', 'dataRoot']);
  assert.equal(source.token, f.state.token); assert.equal(Object.getOwnPropertyDescriptor(source, 'token').enumerable, false);
  assert.equal(Object.hasOwn(source, 'instanceId'), false); assert.equal(Object.hasOwn(source, 'pid'), false);
  assert.equal(JSON.stringify(source).includes(f.state.token), false); assert.ok(Object.isFrozen(source));
  f.profile.worker.workspace = original.worker.workspace;
  const a = await f.adapter();
  assert.deepEqual(await a.sources(), [{ source: original.origin, dataRoot: original.dataRoot }]);
  assert.equal(JSON.stringify(a).includes(f.state.token), false);
  const input = { workspace: 'fixture', app: 'fixture-child' };
  assert.equal((await a.preflight(input)).readyToDeploy, true);
  assert.equal((await a.provision(input)).state, 'ready');
  assert.deepEqual(input, { workspace: 'fixture', app: 'fixture-child' });
  assert.equal(f.state.calls.find(row => row[0] === 'up')[1].source, original.origin);
});

test('wrong source or workspace rejects before credentials, native HTTP or managed service calls', async t => {
  const f = await fixture(t), a = await f.adapter();
  for (const method of ['preflight', 'provision']) {
    for (const input of [{ workspace: 'foreign' }, { workspace: 'fixture', source: 'http://127.0.0.1:1' }, { source: f.profile.origin }]) {
      await assert.rejects(a[method](input), invalid);
    }
  }
  assert.equal(f.state.reads, 0); assert.deepEqual(f.state.routes, []); assert.deepEqual(f.state.calls, [['constructor']]);
});

test('unready, foreign, incompatible, redirected or oversized native proof refuses preflight and provision before service invocation', async t => {
  const f = await fixture(t), a = await f.adapter();
  for (const mode of ['not-ready', 'workspace', 'archive', 'compatibility', 'info-workspace', 'busy', 'active-operation', 'redirect', 'oversize']) {
    f.state.mode = mode;
    for (const method of ['preflight', 'provision']) await assert.rejects(a[method]({ workspace: 'fixture', app: 'fixture-child' }), safeUnknown);
  }
  assert.deepEqual(f.state.calls, [['constructor']]);
});

test('saved inventory, calls and retirement remain independent of offline source or missing source credential', async t => {
  const f = await fixture(t), a = await f.adapter();
  await new Promise(resolve => { f.server.close(resolve); f.server.closeAllConnections(); });
  await unlink(f.profile.tokenFile);
  assert.equal((await a.inspect('fixture-child')).inventory.state, 'ready');
  assert.equal((await a.call('fixture-child', { request: {} })).body, 'fixture output');
  assert.equal((await a.retire('fixture-child')).state, 'destroyed');
  assert.deepEqual(f.state.routes, []);
  await assert.rejects(a.provision({ workspace: 'fixture', app: 'fixture-child' }), safeUnknown);
  assert.deepEqual(f.state.calls.map(row => row[0]), ['constructor', 'list', 'call', 'down']);
});

test('private source token is withheld from allowed receipt fields, outputs and exceptions without environment injection', async t => {
  const f = await fixture(t), a = await f.adapter(); f.state.leak = f.state.token;
  for (const call of [() => a.provision({ workspace: 'fixture', app: 'fixture-child' }), () => a.inspect('fixture-child'),
    () => a.call('fixture-child', { request: {} }), () => a.retire('fixture-child')]) {
    await assert.rejects(call(), error => safeUnknown(error) && !`${error.stack}${JSON.stringify(error)}`.includes(f.state.token));
  }
  // A malformed credential record remains unusable for source admission, and its known token is still withheld from saved operations.
  await privateFiles.writePrivateJson(f.profile.tokenFile, { token: f.state.token, extra: true });
  await assert.rejects(a.preflight({ workspace: 'fixture' }), safeUnknown);
  await assert.rejects(a.retire('fixture-child'), error => safeUnknown(error) && !error.stack.includes(f.state.token));
});

test('private reader errors containing credentials are sanitized and cannot reach a service method', async t => {
  const f = await fixture(t);
  const a = await f.adapter({ privateFiles: { async readPrivateJson() { throw new Error(f.state.token); } } });
  await assert.rejects(a.provision({ workspace: 'fixture', app: 'fixture-child' }), error => safeUnknown(error)
    && !`${error.stack}${JSON.stringify(error)}`.includes(f.state.token));
  assert.deepEqual(f.state.calls, [['constructor']]);
});
