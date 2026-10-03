import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import * as fsModule from 'node:fs';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { startPresentationServer } from '../src/presentation.mjs';

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
const PRIVATE = 'private-modal-prompt-token-and-filesystem-sentinel';
const NOW = 1_800_000_000_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
const digest = value => hash(JSON.stringify(canonical(value)));

function makeJournal(filename, runId, rows = [{ key: 'prefetch', operation: 'prefetch', state: 'unknown', result: { state: 'unknown' } }]) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE modal_operations(
    key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_digest TEXT NOT NULL,
    request_json TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT,
    created INTEGER NOT NULL, updated INTEGER NOT NULL);`);
  const insert = db.prepare('INSERT INTO modal_operations VALUES(?,?,?,?,?,?,?,?)');
  for (const row of rows) {
    const request = { runId, operation: row.operation, prompt: PRIVATE, token: PRIVATE, runDirectory: path.dirname(filename) };
    insert.run(row.key, row.operation, digest(request), JSON.stringify(request), row.state,
      row.result === null ? null : JSON.stringify(row.result), NOW - 2000, NOW - 1000);
  }
  return db;
}

async function fixture(t, configuration = () => ({})) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-modal-http-review-'));
  const databases = [];
  const journalPath = path.join(directory, 'modal.sqlite');
  const journal = makeJournal(journalPath, 'modal-review');
  databases.push(journal);
  const context = { directory, journalPath, journal, databases };
  const extra = await configuration(context);
  const server = await startPresentationServer({ databasePath: path.join(directory, 'missing-control.sqlite'),
    modalJournals: [{ runId: 'modal-review', journalPath }], factoryId: 'flujo', token: TOKEN,
    clock: () => NOW, buildRevision: 'a'.repeat(40), port: 0, ...extra });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const db of databases) db.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('factory-modal-http-review-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request = async (route = '/v1/modal-runs', options = {}) => {
    const response = await fetch(new URL(route, origin), {
      headers: { Authorization: `Bearer ${TOKEN}` }, redirect: 'error', ...options,
    });
    return { response, body: await response.json() };
  };
  return { ...context, server, request, ...extra };
}

async function fileHash(filename) {
  try { return hash(await fs.readFile(filename)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('Modal HTTP rejects unauthorized and invalid requests before journal file access', async t => {
  const f = await fixture(t);
  let accesses = 0;
  const original = fsModule.default.lstatSync;
  fsModule.default.lstatSync = function (filename, ...args) {
    if (path.resolve(String(filename)) === f.journalPath) accesses += 1;
    return original.call(this, filename, ...args);
  };
  syncBuiltinESMExports();
  try {
    for (const route of ['/v1/modal-runs', '/v1/factories/flujo/modal-runs']) {
      const unauthorized = await f.request(route, { headers: {} });
      assert.equal(unauthorized.response.status, 401);
      assert.deepEqual(unauthorized.body, { error: { code: 'UNAUTHORIZED' } });
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      assert.equal((await f.request('/v1/modal-runs', { method })).response.status, 405);
    }
    assert.equal((await f.request('/v1/factories/another/modal-runs')).response.status, 404);
    for (const query of ['runId=modal-review', 'journalPath=C:/private.sqlite', 'after=MA', 'limit=1', 'x=1&x=2']) {
      assert.equal((await f.request(`/v1/modal-runs?${query}`)).response.status, 400);
    }
    assert.equal(accesses, 0);
    assert.equal((await f.request()).response.status, 200);
    assert.ok(accesses > 0, 'Successful reads must exercise the real registered journal');
  } finally {
    fsModule.default.lstatSync = original;
    syncBuiltinESMExports();
  }
});

test('Modal HTTP aliases share an observation envelope independent of an absent controller', async t => {
  const f = await fixture(t);
  const alias = await f.request();
  const scoped = await f.request('/v1/factories/flujo/modal-runs');
  assert.equal(alias.response.status, 200);
  assert.deepEqual(alias.body, scoped.body);
  assert.equal(alias.body.schemaVersion, 1);
  assert.equal(alias.body.factoryId, 'flujo');
  assert.equal(alias.body.scope, 'registered-modal-operation-journals');
  assert.deepEqual(alias.body.capabilities, { observation: true, commands: false });
  assert.equal(alias.body.buildRevision, 'a'.repeat(40));
  assert.equal(alias.body.observedAt, new Date(NOW).toISOString());
  assert.equal('cursor' in alias.body, false);
  assert.equal('revision' in alias.body, false);
  assert.equal(alias.body.paidBudget.availability, 'not-configured');
  assert.equal(alias.body.modalRuns.basis, 'persisted-local-operation-journal');
  assert.equal(alias.body.modalRuns.providerFreshness, 'not_observed');
  assert.equal(alias.body.modalRuns.revisionKind, 'content-sha256');
  assert.equal(alias.body.modalRuns.runs[0].operations[0].state, 'unknown');
  assert.match(alias.body.modalRuns.runs[0].journalRevision, /^[a-f0-9]{64}$/);
  assert.equal(alias.response.headers.get('cache-control'), 'no-store');
  assert.equal(alias.response.headers.get('access-control-allow-origin'), null);
  assert.equal((await f.request('/v1/snapshot')).response.status, 503);
  await assert.rejects(fs.stat(path.join(f.directory, 'missing-control.sqlite')), { code: 'ENOENT' });
});

test('Modal HTTP does not persist reads or create missing registered journals', async t => {
  const f = await fixture(t, c => ({ modalJournals: [
    { runId: 'modal-review', journalPath: c.journalPath },
    { runId: 'missing-review', journalPath: path.join(c.directory, 'missing-modal.sqlite') },
  ] }));
  const mainBefore = await fileHash(f.journalPath), walBefore = await fileHash(`${f.journalPath}-wal`);
  const rowsBefore = f.journal.prepare('SELECT * FROM modal_operations ORDER BY key').all();
  const first = await f.request(), second = await f.request();
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(first.body.modalRuns.runs.find(run => run.runId === 'modal-review').availability, 'available');
  assert.deepEqual(first.body.modalRuns.runs.find(run => run.runId === 'missing-review'), {
    runId: 'missing-review', availability: 'unavailable', reason: 'MODAL_JOURNAL_UNAVAILABLE',
  });
  assert.equal(await fileHash(f.journalPath), mainBefore);
  assert.equal(await fileHash(`${f.journalPath}-wal`), walBefore);
  assert.deepEqual(f.journal.prepare('SELECT * FROM modal_operations ORDER BY key').all(), rowsBefore);
  await assert.rejects(fs.stat(path.join(f.directory, 'missing-modal.sqlite')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(first.body).includes(f.directory), false);
});

test('Modal HTTP omits private request and result fields including reconciliation filenames', async t => {
  const f = await fixture(t, c => {
    const result = { state: 'unknown', prompt: PRIVATE, bearer: PRIVATE, endpoint: `https://${PRIVATE}.modal.run`,
      reconciliationProofFile: `${PRIVATE}.private.json`, reconciliationProofDigest: 'b'.repeat(64),
      nested: { token: PRIVATE } };
    c.journal.prepare('UPDATE modal_operations SET result_json=? WHERE key=?').run(JSON.stringify(result), 'prefetch');
    return {};
  });
  const { response, body } = await f.request();
  assert.equal(response.status, 200);
  assert.equal(body.modalRuns.runs[0].availability, 'available');
  assert.equal(body.modalRuns.runs[0].operations[0].state, 'unknown');
  const serialized = JSON.stringify(body);
  for (const forbidden of [PRIVATE, f.directory, TOKEN, 'request_json', 'request_digest', 'reconciliationProofFile',
    'reconciliationProofDigest', 'endpoint', 'prompt', 'bearer']) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('Modal observation cannot change existing controller snapshot or shared paid admission', async t => {
  const f = await fixture(t, c => {
    const databasePath = path.join(c.directory, 'control.sqlite');
    const control = new FactoryControl(databasePath, { clock: () => NOW });
    control.initialize({ mission: 'Observe owned work', budgetCents: 10000, maxCells: 3, maxDepth: 1 });
    c.databases.push(control);
    const spendingLedgerPath = path.join(c.directory, 'spending.sqlite');
    const ledger = new SpendingLedger(spendingLedgerPath, { clock: () => NOW });
    ledger.initialize({ limitCents: 10000, currency: 'USD' });
    ledger.reserve({ reservationId: 'modal-review', provider: 'modal', ceilingCents: 3000 });
    ledger.start('modal-review');
    ledger.retire('modal-review', { evidenceDigest: 'b'.repeat(64) });
    c.databases.push(ledger);
    return { databasePath, spendingLedgerPath, control, ledger };
  });
  const snapshotBefore = (await f.request('/v1/snapshot')).body;
  const paidBefore = f.ledger.db.prepare('SELECT * FROM spending_events ORDER BY seq').all();
  const modal = await f.request();
  assert.equal(modal.response.status, 200);
  assert.deepEqual(modal.body.paidBudget, snapshotBefore.snapshot.paidBudget);
  assert.equal(modal.body.paidBudget.committedCents, 3000);
  assert.equal(modal.body.paidBudget.meteredSpendCents, null);
  assert.deepEqual((await f.request('/v1/snapshot')).body, snapshotBefore);
  assert.deepEqual(f.ledger.db.prepare('SELECT * FROM spending_events ORDER BY seq').all(), paidBefore);
  f.ledger.observe('modal-review', { chargedCents: 4, observedAt: NOW, evidenceDigest: 'c'.repeat(64) });
  const later = (await f.request()).body;
  assert.ok(later.paidBudget.revision > modal.body.paidBudget.revision);
  assert.equal(later.paidBudget.committedCents, 3000);
  assert.equal(later.paidBudget.knownMeteredCents, 4);
  assert.equal(later.paidBudget.meteredSpendCents, null);
  assert.deepEqual(later.modalRuns, modal.body.modalRuns);
});

test('Historical stop reconciliation changes only that outcome and leaves prefetch unknown', async t => {
  const f = await fixture(t, c => {
    const request = { runId: 'modal-review', operation: 'stop-app', privateProfile: PRIVATE };
    c.journal.prepare('INSERT INTO modal_operations VALUES(?,?,?,?,?,?,?,?)').run('stop-app', 'stop-app',
      digest(request), JSON.stringify(request), 'unknown', JSON.stringify({ state: 'unknown' }), NOW - 900, NOW - 800);
    return {};
  });
  const first = (await f.request()).body;
  f.journal.prepare('UPDATE modal_operations SET state=?,result_json=?,updated=? WHERE key=?').run('succeeded',
    JSON.stringify({ state: 'stopped', appId: `ap-${'A'.repeat(22)}`, runningContainers: 0,
      reconciled: true, reconciliationProofDigest: 'd'.repeat(64), reconciliationProofFile: `${PRIVATE}.private.json` }), NOW, 'stop-app');
  const second = (await f.request()).body;
  assert.equal(second.modalRuns.runs[0].availability, 'available');
  assert.notEqual(second.modalRuns.runs[0].journalRevision, first.modalRuns.runs[0].journalRevision);
  assert.equal(second.modalRuns.runs[0].operations.find(row => row.key === 'prefetch').state, 'unknown');
  const stopped = second.modalRuns.runs[0].operations.find(row => row.key === 'stop-app');
  assert.equal(stopped.state, 'succeeded');
  assert.equal(stopped.outcome.state, 'stopped');
  assert.equal(second.modalRuns.providerFreshness, 'not_observed');
  for (const field of ['reconciliationProofDigest', 'reconciliationProofFile', 'providerAbsent', 'inferenceProven']) {
    assert.equal(JSON.stringify(second.body ?? second).includes(field), false, field);
  }
});

test('A foreign run binding is unavailable without suppressing the valid registered run', async t => {
  const f = await fixture(t, c => {
    const foreign = path.join(c.directory, 'foreign.sqlite');
    c.databases.push(makeJournal(foreign, 'another-original-run'));
    return { modalJournals: [{ runId: 'modal-review', journalPath: c.journalPath }, { runId: 'claimed-run', journalPath: foreign }] };
  });
  const { response, body } = await f.request();
  assert.equal(response.status, 200);
  assert.equal(body.modalRuns.runs.find(run => run.runId === 'modal-review').availability, 'available');
  assert.deepEqual(body.modalRuns.runs.find(run => run.runId === 'claimed-run'), {
    runId: 'claimed-run', availability: 'unavailable', reason: 'MODAL_JOURNAL_UNAVAILABLE',
  });
  assert.equal(JSON.stringify(body).includes('another-original-run'), false);
});
