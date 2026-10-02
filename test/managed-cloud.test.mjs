import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createManagedCloudAdapter } from '../src/adapters/managed-cloud.mjs';

function fakeService(overrides = {}) {
  const calls = [];
  return {
    calls,
    async sources() { this.calls.push(['sources']); return [{ source: 'http://127.0.0.1:4200', instanceId: 'source-1', token: 'SECRET' }]; },
    async preflight(input) { this.calls.push(['preflight', input]); return { workspace: input.workspace, readyToDeploy: true }; },
    async up(input) { this.calls.push(['up', input]); return { worker: 'flujo-test', state: 'ready', journal: '/private/journal', token: 'SECRET' }; },
    async call(id, input) { this.calls.push(['call', id, input]); return { contentType: 'application/json', body: '{"status":"unknown"}', token: 'SECRET' }; },
    async list() { this.calls.push(['list']); return [{ worker: 'flujo-test', state: 'ready', stateSource: 'local-journal', token: 'SECRET' }]; },
    async down(id) { this.calls.push(['down', id]); return { worker: id, state: 'destroyed', localOnly: false, credentials: 'SECRET' }; },
    ...overrides,
  };
}

test('constructing the injected adapter is inert and documents worker limitations', async () => {
  const service = fakeService();
  const adapter = await createManagedCloudAdapter({ service });
  assert.deepEqual(service.calls, []);
  assert.equal(adapter.source.kind, 'injected');
  assert.equal(adapter.capabilities.executionModel, 'delegated-workspace-copy');
  for (const key of ['nativePeerAutonomy', 'recursiveProvisioning', 'workspaceSynchronization', 'liveHealthInspection', 'automaticRetry', 'automaticCleanup']) {
    assert.equal(adapter.capabilities[key], false);
  }
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(adapter.capabilities));
});

test('maps existing ManagedCloud operations and keeps status distinct from output', async () => {
  const service = fakeService();
  const adapter = await createManagedCloudAdapter({ service });
  const input = { workspace: 'factory', flowIds: ['flow-1'] };
  assert.deepEqual(await adapter.preflight(input), { workspace: 'factory', readyToDeploy: true });
  assert.deepEqual(await adapter.provision(input), { worker: 'flujo-test', state: 'ready' });
  const call = { request: { model: 'flow-1', messages: [] }, conversationId: 'conversation-1', timeoutMs: 5000 };
  assert.deepEqual(await adapter.call('flujo-test', call), { contentType: 'application/json', body: '{"status":"unknown"}' });
  assert.deepEqual(await adapter.retire('flujo-test'), { worker: 'flujo-test', state: 'destroyed', localOnly: false });
  assert.deepEqual(service.calls, [['preflight', input], ['up', input], ['call', 'flujo-test', call], ['down', 'flujo-test']]);
});

test('sources strips authentication fields and rejects credential-bearing origins', async () => {
  const adapter = await createManagedCloudAdapter({ service: fakeService() });
  assert.deepEqual(await adapter.sources(), [{ instanceId: 'source-1', source: 'http://127.0.0.1:4200' }]);
  const bad = await createManagedCloudAdapter({ service: fakeService({ async sources() { return [{ source: 'http://user:SECRET@localhost:4200' }]; } }) });
  await assert.rejects(bad.sources(), error => error.outcome === 'unknown' && !JSON.stringify(error).includes('SECRET'));
});

test('inspect labels a ready journal as cached inventory with unobserved live health', async () => {
  const service = fakeService();
  const adapter = await createManagedCloudAdapter({ service });
  const result = await adapter.inspect('flujo-test');
  assert.equal(result.inventory.state, 'ready');
  assert.equal(result.inventory.stateSource, 'local-journal');
  assert.equal(result.inventoryEvidence, 'cached-local-records');
  assert.equal(result.liveHealth.status, 'unobserved');
  assert.equal(result.found, true);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(service.calls, [['list']]);
});

test('a missing cached deployment does not assert cloud absence', async () => {
  const adapter = await createManagedCloudAdapter({ service: fakeService({ async list() { return []; } }) });
  const result = await adapter.inspect('flujo-missing');
  assert.equal(result.found, false);
  assert.equal(result.inventory, null);
  assert.equal(result.liveHealth.status, 'unobserved');
});

test('uncertain provisioning is never retried or cleaned up and raw exceptions stay private', async () => {
  const service = fakeService({ async up() { this.calls.push(['up']); throw Object.assign(new Error('token=SECRET'), { code: 'MANAGED_BUSY', details: 'SECRET' }); } });
  const adapter = await createManagedCloudAdapter({ service });
  await assert.rejects(adapter.provision({ workspace: 'factory' }), error => {
    assert.equal(error.code, 'MANAGED_BUSY');
    assert.equal(error.operation, 'provision');
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.reconciliationRequired, true);
    assert.equal(error.cause, undefined);
    assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('SECRET'));
    return true;
  });
  assert.deepEqual(service.calls, [['up']]);
});

test('arbitrary exception codes are withheld and call timeout remains uncertain', async () => {
  const service = fakeService({ async call() { this.calls.push(['call']); throw Object.assign(new Error('SECRET'), { code: 'SECRET' }); } });
  const adapter = await createManagedCloudAdapter({ service });
  await assert.rejects(adapter.call('flujo-test', { request: {} }), error => error.code === 'MANAGED_CLOUD_OPERATION_UNCONFIRMED' && error.outcome === 'unknown');
  assert.deepEqual(service.calls, [['call']]);
});

test('uncertain returned states survive as returned states', async () => {
  const adapter = await createManagedCloudAdapter({ service: fakeService({ async up() { return { worker: 'flujo-test', state: 'failed', phase: 'provisioning' }; } }) });
  assert.deepEqual(await adapter.provision({ workspace: 'factory' }), { worker: 'flujo-test', state: 'failed', phase: 'provisioning' });
});

test('known environment credentials are withheld even inside allowed fields or worker output', async () => {
  const secret = 'private-secret-value';
  const service = fakeService({
    env: { FLY_API_TOKEN: secret },
    async up() { this.calls.push(['up']); return { worker: 'flujo-test', state: secret }; },
    async call() { this.calls.push(['call']); return { contentType: 'text/plain', body: secret }; },
  });
  const adapter = await createManagedCloudAdapter({ service });
  for (const task of [() => adapter.provision({ workspace: 'factory' }), () => adapter.call('flujo-test', { request: {} })]) {
    await assert.rejects(task(), error => error.outcome === 'unknown' && !`${error.stack}${JSON.stringify(error)}`.includes(secret));
  }
  assert.deepEqual(service.calls, [['up'], ['call']]);
});

test('nested arbitrary receipt fields are not copied into operational evidence', async () => {
  const adapter = await createManagedCloudAdapter({ service: fakeService({ async up() { return { worker: 'flujo-test', state: { token: 'SECRET' } }; } }) });
  await assert.rejects(adapter.provision({ workspace: 'factory' }), error => error.outcome === 'unknown' && !JSON.stringify(error).includes('SECRET'));
});

test('invalid inputs are rejected before service side effects', async () => {
  const service = fakeService();
  const adapter = await createManagedCloudAdapter({ service });
  for (const task of [
    () => adapter.preflight([]), () => adapter.provision(null),
    () => adapter.inspect('../worker'), () => adapter.retire('bad/id'),
    () => adapter.call('flujo-test', { request: [] }),
    () => adapter.call('flujo-test', { request: {}, timeoutMs: 0 }),
    () => adapter.call('flujo-test', { request: {}, conversationId: '' }),
  ]) await assert.rejects(task(), { code: 'MANAGED_CLOUD_INPUT_INVALID' });
  assert.deepEqual(service.calls, []);
});

test('relative modules and incomplete services fail before import', async () => {
  await assert.rejects(createManagedCloudAdapter({ modulePath: './managed.mjs' }), { code: 'MANAGED_CLOUD_INPUT_INVALID' });
  await assert.rejects(createManagedCloudAdapter({ service: {} }), { code: 'MANAGED_CLOUD_INPUT_INVALID' });
});

test('duplicate inventory and invalid delegated outputs stay unconfirmed', async () => {
  const service = fakeService({ async list() { return [{ worker: 'flujo-test' }, { worker: 'flujo-test' }]; }, async call() { return { body: null }; } });
  const adapter = await createManagedCloudAdapter({ service });
  await assert.rejects(adapter.inspect('flujo-test'), error => error.outcome === 'unknown');
  await assert.rejects(adapter.call('flujo-test', { request: {} }), error => error.outcome === 'unknown');
});

test('loads an explicit module without invoking operations and exposes package metadata', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'lib'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'flujo-cloud', version: '0.1.0' }));
  const modulePath = path.join(directory, 'lib', 'managed.mjs');
  await writeFile(modulePath, `export class ManagedCloud {
    constructor(options) { this.options = options; options.progress('must stay quiet'); }
    async sources() { return []; } async preflight() { return {}; } async up() { return {}; }
    async call() { return {contentType: null, body: ''}; } async list() { return []; } async down() { return {}; }
  }`);
  let logged = false;
  const adapter = await createManagedCloudAdapter({ modulePath, options: { progress() { logged = true; } } });
  assert.equal(logged, false);
  assert.equal(adapter.source.packageVersion, '0.1.0');
  assert.equal(adapter.source.modulePath, modulePath);
  assert.deepEqual(await adapter.sources(), []);
});

test('failed module imports do not expose module error messages', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = path.join(directory, 'broken.mjs');
  await writeFile(modulePath, "throw new Error('SECRET');");
  await assert.rejects(createManagedCloudAdapter({ modulePath }), error => error.operation === 'load' && !error.stack.includes('SECRET'));
});
