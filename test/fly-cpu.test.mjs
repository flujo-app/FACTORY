import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CloudBridge, buildMachineConfig, validateOptions } from '../deploy/managed-cloud/lib/bridge.mjs';
import { createManagedCloudAdapter } from '../src/public-sdk.mjs';

const input = { app: 'cpu-fixture', org: 'personal', region: 'iad', workspace: 'cpu-test',
  image: `registry.example/worker@sha256:${'a'.repeat(64)}`, journal: '/unused/journal' };

test('invalid CPU kinds fail bridge validation before provisioning', () => {
  for (const cpuKind of ['dedicated', '', null, 2]) {
    assert.throws(() => validateOptions({ ...input, cpuKind }), /cpuKind/);
  }
});

test('memory follows the CPU kind and stays within what Fly accepts for two CPUs', () => {
  assert.equal(validateOptions(input).memoryMb, 4096);
  assert.equal(validateOptions({ ...input, cpuKind: 'performance' }).memoryMb, 4096);
  assert.equal(validateOptions({ ...input, cpuKind: 'shared' }).memoryMb, 2048);
  for (const [cpuKind, memoryMb] of [['performance', 4096], ['performance', 8192], ['performance', 16384],
    ['shared', 1024], ['shared', 2304], ['shared', 4096]]) {
    assert.equal(validateOptions({ ...input, cpuKind, memoryMb }).memoryMb, memoryMb);
  }
  // 2048 MB was the default before the CPU kind could be chosen; it only fits shared CPUs.
  assert.throws(() => validateOptions({ ...input, memoryMb: 2048 }), /memoryMb must be 4096 to 16384 in steps of 2048 with cpuKind performance; cpuKind shared takes 1024 to 4096/);
  for (const [cpuKind, memoryMb] of [['performance', 2048], ['performance', 5120], ['performance', 18432],
    ['shared', 512], ['shared', 1100], ['shared', 8192]]) {
    assert.throws(() => validateOptions({ ...input, cpuKind, memoryMb }), /memoryMb/);
  }
});

test('a machine configuration built without a memory size takes the default of its CPU kind', () => {
  const record = { image: input.image, volumeId: 'fixture-volume', owner: 'fixture-owner', archiveSha256: 'a'.repeat(64) };
  assert.deepEqual(buildMachineConfig(record, { idle: true }).guest, { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 });
  assert.deepEqual(buildMachineConfig(record, { idle: true, cpuKind: 'shared' }).guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 });
  assert.deepEqual(buildMachineConfig(record, { idle: false, cpuKind: 'shared', memoryMb: 4096 }).guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 });
  assert.throws(() => buildMachineConfig(record, { idle: true, cpuKind: 'dedicated' }), /cpuKind/);
});

for (const cpuKind of [undefined, 'performance', 'shared']) {
  test(`SDK to Fly creation and bootstrap preserves ${cpuKind ?? 'default performance'} CPU`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'factory-fly-cpu-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const journal = path.join(directory, 'worker.json');
    const bytes = Buffer.from('synthetic workspace snapshot');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sessionId = randomUUID();
    const configs = [];
    let machine, marker;
    const fly = {
      async run(args, options) {
        const command = args.slice(0, 2).join(' ');
        if (command === 'apps list') return '[]';
        if (command === 'apps create') return JSON.stringify({ Name: input.app, ID: input.app, Organization: { Slug: input.org } });
        if (command === 'secrets import') { marker = options.input.split('=')[0]; return ''; }
        if (command === 'secrets list') return JSON.stringify([{ Name: marker }]);
        if (command === 'volumes create') return JSON.stringify({ Name: args[2], ID: 'fixture-volume' });
        if (command === 'machine list') return JSON.stringify([machine]);
        if (command === 'machine exec') return '{}';
        if (command === 'ssh sftp') return '';
        if (command === 'machine update') {
          machine.config = JSON.parse(await readFile(args[args.indexOf('--machine-config') + 1], 'utf8'));
          configs.push(machine.config);
          return '';
        }
        throw new Error(`Unexpected Fly command: ${command}`);
      },
      async proxy() { return { origin: 'http://127.0.0.1:49999', check() {}, async stop() {} }; },
    };
    const fetchImpl = async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/machines')) {
        const request = JSON.parse(options.body);
        machine = { id: 'fixture-machine', name: request.name, state: 'started', config: request.config,
          image_ref: { digest: `sha256:${'a'.repeat(64)}` } };
        configs.push(request.config);
        return Response.json(machine);
      }
      if (pathname === '/api/snapshot/begin') return Response.json({ sessionId }, { status: 202 });
      if (pathname === '/api/snapshot/status') return Response.json({ sessionId, workspace: input.workspace, state: 'ready', sha256 });
      if (pathname === '/api/snapshot/download') return new Response(bytes, { headers: { 'x-flujo-snapshot-sha256': sha256 } });
      if (pathname === '/api/snapshot/finalize') return Response.json({});
      if (pathname === '/api/worker/status') return Response.json({ mode: 'worker', state: 'ready',
        workspace: input.workspace, archiveSha256: machine.config.env.FLUJO_WORKER_SNAPSHOT_SHA256 });
      throw new Error(`Unexpected request: ${pathname}`);
    };
    const bridge = new CloudBridge({ fly, fetchImpl, port: async () => 49999 });
    const env = { FLY_API_TOKEN: 'synthetic_fly_token_01234567890123456789',
      FLUJO_SNAPSHOT_CONTROL_TOKEN: 'synthetic_source_token_01234567890123456789',
      FLUJO_CLOUD_CONTROL_TOKEN: 'synthetic_worker_token_01234567890123456789' };
    const adapter = await createManagedCloudAdapter({ service: {
      async sources() { return []; }, async preflight(value) { return validateOptions(value); },
      async up(value) { return bridge.up(value, env); }, async call() {}, async list() { return []; }, async down() {},
    } });
    const options = { ...input, journal, ...(cpuKind === undefined ? {} : { cpuKind }) };
    assert.equal((await adapter.preflight(options)).cpuKind, cpuKind ?? 'performance');
    await adapter.provision(options);
    assert.equal(configs.length, 2);
    for (const config of configs) assert.deepEqual(config.guest,
      { cpu_kind: cpuKind ?? 'performance', cpus: 2, memory_mb: cpuKind === 'shared' ? 2048 : 4096 });
    assert.deepEqual(configs[0].init.cmd, ['sleep', 'infinity']);
    assert.equal(configs[1].init.cmd[0], 'node');
    assert.equal(JSON.parse(await readFile(journal, 'utf8')).cpuKind, cpuKind ?? 'performance');
  });
}
