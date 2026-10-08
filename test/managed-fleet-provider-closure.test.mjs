import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { FactoryControl, FactoryManagedFleet, SpendingLedger, createManagedCloudAdapter } from '../src/public-sdk.mjs';

for (const { uncertainDown, paidPreRetired } of [
  { uncertainDown: false, paidPreRetired: false },
  { uncertainDown: true, paidPreRetired: false },
  { uncertainDown: true, paidPreRetired: true },
]) test(
  paidPreRetired ? 'managed fleet recovers an unknown teardown after the paid hold retired'
    : uncertainDown ? 'managed fleet reconciles an unknown cloud teardown before cell closure'
    : 'managed fleet closes a paid worker cell only after trusted live provider absence', async t => {
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
  const paidPath = path.join(directory, 'paid.sqlite');
  let paid = new SpendingLedger(paidPath);
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
  let downCalls = 0;
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
      downCalls++;
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      await writePrivate(metadataPath, { ...metadata, phase: 'destroyed', retirement: 'cloud-confirmed' });
      await writePrivate(journalPath, { ...journal, state: 'destroyed', stage: 'destroyed',
        updatedAt: new Date().toISOString() });
      if (uncertainDown) throw new Error('Provider acknowledgement was lost after confirmed teardown');
      return { app, worker: app, state: 'destroyed', localOnly: false };
    },
  };
  const database = path.join(directory, 'control.sqlite');
  const adapter = await createManagedCloudAdapter({ service });
  const fleet = new FactoryManagedFleet(database, adapter,
    { paidAdmission: paid, provider: 'fly' });
  const plan = { mission: 'Managed closure', budgetCents: 0, projectId: 'managed-closure',
    baseline: 'fixture', workers: [{ id: app, app, budgetCents: 0, paidCeilingCents: 100,
      purpose: 'Provider proof', provisionInput: { app },
      conversations: [{ id: 'job', input: { conversationId: 'conversation', request: { flowName: 'team' } },
        outputPath: path.join(directory, 'output.txt') }] }] };
  assert.equal((await fleet.run(plan)).conversations[0].status, 'completed');
  assert.equal((await fleet.retire(plan)).workers[0].status, uncertainDown ? 'held' : 'retired');
  if (paidPreRetired) paid.retire(fleet.paidReservationId(app),
    { evidenceDigest: 'e'.repeat(64) });
  if (!uncertainDown) paid.settle(fleet.paidReservationId(app),
    { finalCents: 12, evidenceDigest: 'd'.repeat(64) });
  const options = { workerId: app, flyPath: process.execPath, managedDirectory,
    org: 'personal', workspace: 'test-cloud' };
  if (uncertainDown && !paidPreRetired) {
    const inFlight = new FactoryControl(database);
    inFlight.db.prepare("UPDATE effects SET state='running' WHERE key=?").run(`retire-${app}`);
    inFlight.close();
    await assert.rejects(() => fleet.reconcileRetired(plan, options), { code: 'WORKER' });
    const retained = new FactoryControl(database);
    retained.db.prepare("UPDATE effects SET state='unknown' WHERE key=?").run(`retire-${app}`);
    retained.close();
  }
  const originalJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  await writePrivate(journalPath, { ...originalJournal, machineId: 'another-machine' });
  const inspect = () => uncertainDown ? fleet.reconcileRetired(plan, options) : fleet.closeRetired(plan, options);
  await assert.rejects(inspect,
    { code: 'PROVIDER_RETIREMENT_REQUEST_BINDING' });
  await assert.rejects(() => readFile(calls, 'utf8'), { code: 'ENOENT' });
  await writePrivate(journalPath, originalJournal);
  await assert.rejects(inspect,
    { code: 'PROVIDER_RETIREMENT_PRESENT' });
  let control = new FactoryControl(database);
  assert.equal(control.db.prepare('SELECT status FROM cells WHERE id=?').get(app).status, 'ready');
  control.close();
  await writeFile(inventory, '[]');
  paid.close();
  paid = new SpendingLedger(paidPath);
  const restarted = new FactoryManagedFleet(database, adapter,
    { paidAdmission: paid, provider: 'fly' });
  if (uncertainDown) {
    const reconciliation = await restarted.reconcileRetired(plan, options);
    assert.equal(reconciliation.reconciled, true);
    assert.equal(reconciliation.effect.state, 'succeeded');
    assert.equal((await restarted.reconcileRetired(plan, options)).reconciled, false);
    assert.equal(paid.row(restarted.paidReservationId(app)).state, 'retired-meter-pending');
  }
  const result = await restarted.closeRetired(plan, options);
  assert.equal(result.status, 'retired');
  assert.equal(result.cell.resourceEvidence.resourceScope,
    'owned-fly-teardown-recorded-and-app-not-returned-by-configured-inventory');
  assert.equal((await restarted.closeRetired(plan, options)).replayed, true);
  control = new FactoryControl(database);
  assert.equal(control.db.prepare('SELECT status FROM cells WHERE id=?').get(app).status, 'retired');
  control.close();
  assert.equal(paid.row(fleet.paidReservationId(app)).state,
    uncertainDown ? 'retired-meter-pending' : 'settled');
  assert.equal(downCalls, 1);
});
