import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { FactoryControl, FactoryManagedFleet, SpendingLedger, createManagedCloudAdapter } from '../src/public-sdk.mjs';

test('managed fleet closes a paid worker cell only after trusted live provider absence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-managed-closure-'));
  const managedDirectory = path.join(directory, 'managed');
  const workers = path.join(managedDirectory, 'workers');
  await mkdir(workers, { recursive: true });
  const inventory = path.join(directory, 'inventory.json');
  const preload = path.join(directory, 'fake-fly.mjs');
  const calls = path.join(directory, 'calls.jsonl');
  await writeFile(inventory, JSON.stringify([{ Name: 'managed-fixture', ID: 'managed-fixture',
    Organization: { Slug: 'personal' } }]));
  await writeFile(preload, `import {readFileSync,appendFileSync} from 'node:fs';import path from 'node:path';
const args=process.argv.slice(1);args[0]=path.basename(args[0]);
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.join(' ')!=='apps list --org personal --json')process.exit(71);
process.stdout.write(readFileSync(${JSON.stringify(inventory)},'utf8'));process.exit(0);
`);
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previousOptions ? `${previousOptions} ` : ''}--import=${pathToFileURL(preload).href}`;
  const paid = new SpendingLedger(path.join(directory, 'paid.sqlite'));
  paid.initialize({ limitCents: 100, currency: 'USD' });
  t.after(async () => {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
    paid.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('factory-managed-closure-'));
    await rm(directory, { recursive: true, force: true });
  });

  const app = 'managed-fixture', owner = randomUUID();
  const image = `ghcr.io/example/flujo@sha256:${'a'.repeat(64)}`;
  const metadataPath = path.join(workers, `${app}.deployment.json`);
  const journalPath = path.join(workers, `${app}.journal.json`);
  const writePrivate = async (filename, value) => writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  const service = {
    async sources() { return []; },
    async preflight() { return { readyToDeploy: true }; },
    async up() {
      const now = new Date().toISOString();
      await writePrivate(metadataPath, { format: 'flujo-managed-deployment', version: 1,
        id: app, attemptId: randomUUID(), phase: 'ready', source: 'http://127.0.0.1:4200',
        workspace: 'test-cloud', org: 'personal', region: 'iad', image, createdAt: now,
        journalOwner: owner });
      await writePrivate(journalPath, { format: 'flujo-cloud-journal', version: 1,
        owner, app, appId: app, org: 'personal', region: 'iad', workspace: 'test-cloud', image,
        state: 'ready', stage: 'ready', appCreated: true, ownershipConfirmed: true,
        authState: 'copied-workspace', machineId: 'machine-fixture', volumeId: 'volume-fixture',
        machineName: `worker-${owner.replaceAll('-', '').slice(0, 12)}`,
        volumeName: `worker_${owner.replaceAll('-', '').slice(0, 12)}`,
        archiveSha256: 'b'.repeat(64), createdAt: now, updatedAt: now });
      return { app, worker: app, workspace: 'test-cloud', org: 'personal', region: 'iad',
        machineId: 'machine-fixture', state: 'ready' };
    },
    async call() { return { body: 'synthetic', contentType: 'text/plain' }; },
    async list() { return []; },
    async down() {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      await writePrivate(metadataPath, { ...metadata, phase: 'destroyed', retirement: 'cloud-confirmed' });
      await writePrivate(journalPath, { ...journal, state: 'destroyed', stage: 'destroyed',
        updatedAt: new Date().toISOString() });
      return { app, worker: app, state: 'destroyed', localOnly: false };
    },
  };
  const database = path.join(directory, 'control.sqlite');
  const fleet = new FactoryManagedFleet(database, await createManagedCloudAdapter({ service }),
    { paidAdmission: paid, provider: 'fly' });
  const plan = { mission: 'Managed closure', budgetCents: 0, projectId: 'managed-closure',
    baseline: 'fixture', workers: [{ id: app, app, budgetCents: 0, paidCeilingCents: 100,
      purpose: 'Provider proof', provisionInput: { app },
      conversations: [{ id: 'job', input: { conversationId: 'conversation', request: { flowName: 'team' } },
        outputPath: path.join(directory, 'output.txt') }] }] };
  assert.equal((await fleet.run(plan)).conversations[0].status, 'completed');
  assert.equal((await fleet.retire(plan)).workers[0].status, 'retired');
  paid.settle(fleet.paidReservationId(app), { finalCents: 12, evidenceDigest: 'd'.repeat(64) });
  const options = { workerId: app, flyPath: process.execPath, managedDirectory,
    org: 'personal', workspace: 'test-cloud' };
  const originalJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  await writePrivate(journalPath, { ...originalJournal, machineId: 'another-machine' });
  await assert.rejects(() => fleet.closeRetired(plan, options),
    { code: 'PROVIDER_RETIREMENT_REQUEST_BINDING' });
  await assert.rejects(() => readFile(calls, 'utf8'), { code: 'ENOENT' });
  await writePrivate(journalPath, originalJournal);
  await assert.rejects(() => fleet.closeRetired(plan, options),
    { code: 'PROVIDER_RETIREMENT_PRESENT' });
  let control = new FactoryControl(database);
  assert.equal(control.db.prepare('SELECT status FROM cells WHERE id=?').get(app).status, 'ready');
  control.close();
  await writeFile(inventory, '[]');
  const result = await fleet.closeRetired(plan, options);
  assert.equal(result.status, 'retired');
  assert.equal(result.cell.resourceEvidence.resourceScope,
    'owned-fly-teardown-recorded-and-app-not-returned-by-configured-inventory');
  assert.equal((await fleet.closeRetired(plan, options)).replayed, true);
  control = new FactoryControl(database);
  assert.equal(control.db.prepare('SELECT status FROM cells WHERE id=?').get(app).status, 'retired');
  control.close();
  assert.equal(paid.row(fleet.paidReservationId(app)).state, 'settled');
});
