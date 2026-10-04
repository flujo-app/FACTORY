import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FactoryControl, digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import * as privateFiles from '../deploy/private-files.mjs';

process.umask(0o077);
const cases = [];
const cliTest = (name, options, fn) => cases.push([name, options, fn]);
const CLI = fileURLToPath(new URL('../bin/native-cell.mjs', import.meta.url));
const HELPER = fileURLToPath(new URL('../deploy/private-files.mjs', import.meta.url));
const workerToken = 'synthetic-worker-token-' + 'w'.repeat(40), flyToken = 'synthetic-fly-token-' + 'f'.repeat(40);
const compatibility = { applicationVersion: '3.46.2', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 };
const origin = 'http://127.0.0.1:43871';

// Actual CLI imports and storage; only package location and HTTP transport are supplied.
// Every socket entry point is refused, so this fixture never listens or contacts a service.
const preloadSource = `
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import http from 'node:http';
import https from 'node:https'; import tls from 'node:tls'; import dns from 'node:dns';
import { createRequire, registerHooks } from 'node:module'; import { pathToFileURL } from 'node:url';
if (process.env.FACTORY_TEST_DEPENDENCY_ROOT) {
 const require = createRequire(path.join(process.env.FACTORY_TEST_DEPENDENCY_ROOT, 'package.json'));
 const locations = new Map(['@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/server/streamableHttp.js', '@modelcontextprotocol/sdk/types.js']
  .map(specifier => [specifier, pathToFileURL(require.resolve(specifier)).href]));
 registerHooks({ resolve(specifier, context, next) {
  return next(locations.get(specifier) ?? specifier, context);
 } });
}
const deny = () => { throw new Error('SOCKET_ENTRY_REFUSED'); };
net.connect = net.createConnection = net.Socket.prototype.connect = deny; net.Server.prototype.listen = deny;
http.request = http.get = https.request = https.get = tls.connect = deny;
for (const name of ['lookup','resolve','resolve4','resolve6']) { dns[name] = deny; dns.promises[name] = deny; }
globalThis.fetch = async (input, options = {}) => {
 if (options.signal?.aborted) throw new Error('ABORTED');
 const state = JSON.parse(fs.readFileSync(process.env.FACTORY_TEST_HTTP_STATE, 'utf8'));
 const url = new URL(input), method = options.method ?? 'GET', headers = new Headers(options.headers);
 const fly = url.origin === 'https://api.machines.dev';
 if ((!fly && url.origin !== state.origin) || headers.get('authorization') !== 'Bearer ' + (fly ? state.flyToken : state.workerToken)) throw new Error('AUTH_OR_ORIGIN_REFUSED');
 fs.appendFileSync(process.env.FACTORY_TEST_HTTP_CALLS, JSON.stringify({ provider: fly ? 'fly' : 'worker', method, path: url.pathname }) + '\\n');
 const save = () => fs.writeFileSync(process.env.FACTORY_TEST_HTTP_STATE, JSON.stringify(state));
 const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
 if (fly) {
  const base = '/v1/apps/' + state.app + '/machines/' + state.machine.id;
  if (method === 'GET' && url.pathname === base) return reply(state.machine);
  if (method === 'POST' && [base + '/start', base + '/stop'].includes(url.pathname)) {
   state.machine.state = url.pathname.endsWith('/start') ? 'started' : 'stopped'; save();
   if (state.losePowerResponse) throw new Error('SYNTHETIC_LOST_RESPONSE'); return reply({});
  }
  throw new Error('FLY_ROUTE_REFUSED');
 }
 if (url.searchParams.get('workspace') !== state.worker.workspace || headers.get('x-flujo-workspace') !== state.worker.workspace) throw new Error('WORKSPACE_REFUSED');
 if (state.machine.state !== 'started') return reply({}, 503);
 if (method === 'GET' && url.pathname === '/api/worker/status') return reply({ mode: 'worker', state: 'ready', ...state.worker });
 if (method === 'GET' && url.pathname === '/api/snapshot/info') return reply({ workspace: state.worker.workspace, capability: 'available', activeOperation: null, workerCompatibility: state.worker.compatibility });
 if (method === 'GET' && url.pathname === '/api/flow/' + state.flow.id) return reply(state.flow);
 if (method === 'GET' && url.pathname === '/api/flow') return reply([state.flow]);
 if (method === 'GET' && url.pathname.startsWith('/v1/chat/conversations/')) return state.conversation && url.pathname.endsWith('/' + state.conversation.id) ? reply(state.conversation) : reply({}, 404);
 if (method === 'POST' && url.pathname === '/v1/chat/completions') {
  const body = JSON.parse(options.body); state.conversation = { id: body.metadata.conversationId, flowId: state.flow.id, status: 'completed',
   messages: [{ role: 'user', content: body.messages[0].content }, { role: 'assistant', content: 'private synthetic completion' }],
   transcriptWindow: { truncated: false, loadedCount: 2, totalCount: 2 } }; save(); return reply({});
 }
 throw new Error('WORKER_ROUTE_REFUSED');
};
`;

async function fixture(t, { enroll = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-native-power-cli-'));
  await privateFiles.ensurePrivateDirectory(directory);
  const p = name => path.join(directory, name), worker = { workspace: 'power-cli', archiveSha256: 'a'.repeat(64), compatibility };
  const control = new FactoryControl(p('control.sqlite')), paid = new SpendingLedger(p('paid.sqlite'));
  control.initialize({ mission: 'Private CLI queue fixture', budgetCents: 10000, maxCells: 4, maxDepth: 2 });
  paid.initialize({ limitCents: 10000, currency: 'USD' });
  control.reserveCell({ cellId: 'child', role: 'developer', budgetCents: 1000, purpose: 'Owned queue fixture' });
  control.createTask({ taskId: 'manage', projectId: 'fixture', branch: 'codex/manage', specification: {
    problem: 'Manage existing fixture worker', acceptance: ['safe power'], baseline: 'fixture' } });
  const lease = control.claimTask('manage', 'root', 600000);
  control.admitEffect(lease, { key: 'provision', kind: 'provision', request: { cellId: 'child', app: 'power-cli-child' } });
  control.startEffect(lease, 'provision'); control.settleEffect('provision', 'succeeded', { worker: 'power-cli-child', app: 'power-cli-child', state: 'ready' });
  control.enrollCell('child');
  const machine = { id: 'owned-machine', instance_id: 'owned-instance', name: 'owned-name', state: 'started', image_ref: { digest: 'sha256:' + 'b'.repeat(64) },
    config: { metadata: { flujo_cloud_owner: '01234567-89ab-cdef-0123-456789abcdef' }, env: { FLUJO_WORKER_SNAPSHOT_SHA256: worker.archiveSha256 }, services: [], mounts: [{ path: '/data', volume: 'owned-volume' }] } };
  const binding = { schemaVersion: 1, cellId: 'child', app: 'power-cli-child', provisionKey: 'provision', machineId: machine.id,
    instanceId: machine.instance_id, machineName: machine.name, owner: machine.config.metadata.flujo_cloud_owner,
    imageDigest: machine.image_ref.digest, configSha256: digest(machine.config), worker };
  if (enroll) control.enrollWorkerPower(lease, binding);
  control.close(); paid.close();
  const flow = { id: 'power-flow', name: 'PowerFixtureFlow', nodes: [], edges: [] };
  const state = { origin, flyToken, workerToken, app: binding.app, machine, worker, flow, conversation: null, losePowerResponse: false };
  const profile = { controlDatabase: p('control.sqlite'), spendingDatabase: p('paid.sqlite'),
    client: { origin, tokenFile: p('worker-token.private.json'), worker, timeoutMs: 1000 },
    cell: { cellId: 'child', app: binding.app, provisionKey: 'provision', worker, outputDirectory: p('outputs'), ttlMs: 1000, pollMs: 100 },
    powerScheduling: { flyTokenFile: p('fly-token.private.json'), managementLeaseFile: p('management-lease.private.json'), wakeCeilingCents: 100, timeoutMs: 1000 } };
  await fs.writeFile(p('preload.mjs'), preloadSource); await fs.writeFile(p('http-state.json'), JSON.stringify(state));
  await privateFiles.writePrivateJson(profile.client.tokenFile, { token: workerToken }, { exclusive: true });
  await privateFiles.writePrivateJson(profile.powerScheduling.flyTokenFile, { token: flyToken }, { exclusive: true });
  await privateFiles.writePrivateJson(profile.powerScheduling.managementLeaseFile, lease, { exclusive: true });
  await privateFiles.writePrivateJson(p('profile.private.json'), profile, { exclusive: true });
  const changeControl = fn => { const value = new FactoryControl(p('control.sqlite')); try { return fn(value); } finally { value.close(); } };
  const changePaid = fn => { const value = new SpendingLedger(p('paid.sqlite')); try { return fn(value); } finally { value.close(); } };
  const writeProfile = () => privateFiles.writePrivateJson(p('profile.private.json'), profile);
  async function invoke() {
    const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath), NODE_NO_WARNINGS: '1',
      FACTORY_TEST_HTTP_STATE: p('http-state.json'), FACTORY_TEST_HTTP_CALLS: p('calls.jsonl'),
      ...(process.env.FACTORY_TEST_DEPENDENCY_ROOT ? { FACTORY_TEST_DEPENDENCY_ROOT: process.env.FACTORY_TEST_DEPENDENCY_ROOT } : {}) };
    const child = spawn(process.execPath, ['--import', pathToFileURL(p('preload.mjs')).href, CLI, 'once', '--private-module', HELPER, '--profile', p('profile.private.json')],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', limited = false;
    const timer = setTimeout(() => { limited = true; child.kill(); }, 30000);
    child.stdout.on('data', b => { stdout += b; if (Buffer.byteLength(stdout) > 65536) { limited = true; child.kill(); } });
    child.stderr.on('data', b => { stderr += b; if (Buffer.byteLength(stderr) > 65536) { limited = true; child.kill(); } });
    const closed = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, pid: child.pid })); });
    clearTimeout(timer); assert.equal(limited, false); assert.equal(closed.signal, null);
    const text = stdout + stderr;
    for (const secret of [workerToken, flyToken, lease.token, binding.machineId, binding.owner, 'private synthetic completion']) assert.equal(text.includes(secret), false);
    await fs.writeFile(p('cli-' + closed.pid + '.close.json'), JSON.stringify(closed), { flag: 'wx', mode: 0o600 });
    return { ...closed, status: stdout ? JSON.parse(stdout.trim()) : null, error: stderr ? JSON.parse(stderr.trim()) : null };
  }
  async function calls() { return (await fs.readFile(p('calls.jsonl'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })).trim().split('\n').filter(Boolean).map(JSON.parse); }
  function addTask() { return changeControl(c => c.createTask({ taskId: 'develop', projectId: 'fixture', branch: 'codex/develop', specification: {
    problem: 'private source task', acceptance: ['independent review'], baseline: 'fixture', nativeMission: {
      schemaVersion: 1, missionId: 'c'.repeat(32), cellId: 'child', app: binding.app, provisionKey: 'provision', worker,
      flowId: flow.id, flowSha256: digest(flow), paid: { provider: 'fly', ceilingCents: 500 } } } })); }
  return { directory, p, profile, lease, binding, worker, state, invoke, calls, writeProfile, changeControl, changePaid, addTask };
}

cliTest('actual CLI power profile sleeps idle, wakes queued demand and dispatches one native Flow after restart', { concurrency: true }, async t => {
  const f = await fixture(t);
  const sleep = await f.invoke(); assert.equal(sleep.code, 0); assert.equal(sleep.status.state, 'power_transition');
  assert.equal((await f.invoke()).status.state, 'sleeping'); f.addTask();
  const wake = await f.invoke(); assert.equal(wake.code, 0); assert.equal(wake.status.state, 'power_transition'); assert.notEqual(wake.status.key, sleep.status.key);
  const flow = await f.invoke(); assert.equal(flow.code, 0); assert.equal(flow.status.state, 'dispatched'); assert.equal(flow.status.effectState, 'succeeded');
  assert.equal((await f.invoke()).status.state, 'awaiting_review');
  const calls = await f.calls(); assert.equal(calls.filter(c => c.provider === 'fly' && c.method === 'POST').length, 2);
  assert.equal(calls.filter(c => c.path === '/v1/chat/completions' && c.method === 'POST').length, 1);
  f.changePaid(p => { assert.equal(p.row('power.' + wake.status.key).state, 'started'); assert.equal(p.rows().length, 2); });
});

cliTest('omitted power profile stays inert; missing or mismatched enrollment refuses before HTTP', { concurrency: true }, async t => {
  const f = await fixture(t, { enroll: false }); const power = f.profile.powerScheduling;
  delete f.profile.powerScheduling; await f.writeProfile(); const idle = await f.invoke();
  assert.equal(idle.code, 0); assert.deepEqual(idle.status, { state: 'idle' }); assert.deepEqual(await f.calls(), []);
  f.profile.powerScheduling = power; await f.writeProfile(); const missing = await f.invoke();
  assert.equal(missing.code, 1); assert.deepEqual(missing.error, { error: 'WORKER_POWER_ENROLLMENT' }); assert.deepEqual(await f.calls(), []);
  f.changeControl(c => c.enrollWorkerPower(f.lease, f.binding));
  f.profile.cell.worker = f.profile.client.worker = { ...f.worker, archiveSha256: 'd'.repeat(64) }; await f.writeProfile();
  const mismatch = await f.invoke(); assert.equal(mismatch.code, 1); assert.deepEqual(mismatch.error, { error: 'WORKER_POWER_BINDING' }); assert.deepEqual(await f.calls(), []);
});

cliTest('CLI queue profile keeps expired management and OFF fences without inventing lease renewal', { concurrency: true }, async t => {
  const f = await fixture(t);
  f.changeControl(c => c.db.prepare('UPDATE tasks SET expires=? WHERE id=?').run(Date.now() - 1, 'manage'));
  const expired = await f.invoke(); assert.equal(expired.code, 0); assert.deepEqual(expired.status, { state: 'blocked', reason: 'assignment_changed' });
  f.changeControl(c => c.pause()); const paused = await f.invoke(); assert.equal(paused.code, 0); assert.deepEqual(paused.status, { state: 'paused' });
  assert.deepEqual(await f.calls(), []); f.changePaid(p => assert.equal(p.rows().length, 0));
});

cliTest('accepted power intent is reported safely and remains observation-only across actual CLI restarts', { concurrency: true }, async t => {
  const f = await fixture(t); const plan = f.changeControl(c => {
    const value = c.workerQueuePowerPlan(f.binding.app, { wakeCeilingCents: 100 }); c.admitWorkerPower(f.lease, { key: value.key, request: value.request, queue: value.queue }); return value;
  });
  f.addTask(); f.changeControl(c => c.pause()); f.changePaid(p => p.pauseAdmission());
  for (let i = 0; i < 2; i++) {
    const result = await f.invoke(); assert.equal(result.code, 0); assert.deepEqual(result.status, { state: 'blocked', key: plan.key, effectState: 'accepted', reason: 'power_reconciliation_required' });
  }
  assert.deepEqual(await f.calls(), []); f.changePaid(p => assert.equal(p.rows().length, 0));
});

cliTest('CLI power profile refuses extra fields and malformed explicit lease before transport', { concurrency: true }, async t => {
  const f = await fixture(t); f.profile.powerScheduling.enroll = true; await f.writeProfile();
  const extra = await f.invoke(); assert.equal(extra.code, 1); assert.deepEqual(extra.error, { error: 'NATIVE_CELL_PROFILE' });
  delete f.profile.powerScheduling.enroll; await f.writeProfile();
  await privateFiles.writePrivateJson(f.profile.powerScheduling.managementLeaseFile, { ...f.lease, renew: true });
  const lease = await f.invoke(); assert.equal(lease.code, 1); assert.deepEqual(lease.error, { error: 'NATIVE_CELL_PROFILE' }); assert.deepEqual(await f.calls(), []);
});

cliTest('unknown power remains held for identity drift and resolves by observation only while OFF and paid-paused', { concurrency: true }, async t => {
  const f = await fixture(t); f.state.losePowerResponse = true; await fs.writeFile(f.p('http-state.json'), JSON.stringify(f.state));
  const entered = await f.invoke(); assert.equal(entered.code, 0); assert.equal(entered.status.state, 'blocked'); assert.equal(entered.status.effectState, 'unknown');
  f.changeControl(c => c.pause()); f.changePaid(p => p.pauseAdmission());
  const state = JSON.parse(await fs.readFile(f.p('http-state.json'), 'utf8')); state.machine.instance_id = 'foreign-instance';
  await fs.writeFile(f.p('http-state.json'), JSON.stringify(state));
  const held = await f.invoke(); assert.equal(held.code, 0); assert.equal(held.status.key, entered.status.key); assert.equal(held.status.effectState, 'unknown');
  state.machine.instance_id = f.binding.instanceId; await fs.writeFile(f.p('http-state.json'), JSON.stringify(state));
  const observed = await f.invoke(); assert.equal(observed.code, 0);
  assert.deepEqual(observed.status, { state: 'power_observed', key: entered.status.key, effectState: 'succeeded' });
  assert.equal((await f.calls()).filter(c => c.provider === 'fly' && c.method === 'POST').length, 1);
  f.changePaid(p => assert.equal(p.rows().length, 0));
});

cliTest('CLI paid-zero and paid-paused statuses leave demand ready without another power POST', { concurrency: true }, async t => {
  const f = await fixture(t); assert.equal((await f.invoke()).status.state, 'power_transition'); f.addTask();
  f.changePaid(p => { p.reserve({ reservationId: 'held', provider: 'modal', ceilingCents: 10000 }); p.start('held'); });
  const budget = await f.invoke(); assert.equal(budget.code, 0); assert.deepEqual(budget.status, { state: 'budget', taskId: 'develop', unallocatedCents: 0 });
  f.changePaid(p => p.pauseAdmission()); const paused = await f.invoke(); assert.equal(paused.code, 0); assert.deepEqual(paused.status, { state: 'paid_paused' });
  f.changeControl(c => { assert.equal(c.task('develop').status, 'ready'); assert.equal(c.task('develop').epoch, 0); });
  assert.equal((await f.calls()).filter(c => c.provider === 'fly' && c.method === 'POST').length, 1);
});


test('private native-cell power CLI integration', { concurrency: 7 }, async t => {
  await Promise.all(cases.map(([name, options, fn]) => t.test(name, options, fn)));
});
