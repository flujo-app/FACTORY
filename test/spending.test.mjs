import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SpendingLedger } from '../src/spending.mjs';

const PROOF = 'a'.repeat(64), FINAL_PROOF = 'b'.repeat(64);
function fixture(t) {
  const base = resolve(tmpdir()), dir = mkdtempSync(join(base, 'factory-spending-')), path = join(dir, 'spending.sqlite');
  let now = 1000;
  const connections = [], ledger = new SpendingLedger(path, { clock: () => now }); connections.push(ledger);
  ledger.initialize({ limitCents: 10000, currency: 'USD' });
  t.after(() => {
    for (const connection of connections) { try { connection.close(); } catch {} }
    assert.ok(resolve(dir).startsWith(base + sep) && dir !== base);
    rmSync(dir, { recursive: true, force: true });
  });
  return { ledger, path, dir, advance() { now++; }, reopen() { const reopened = new SpendingLedger(path, { clock: () => now }); connections.push(reopened); return reopened; } };
}
function synchronizedChild(path, input, operation = 'reserve') {
  const moduleUrl = new URL('../src/spending.mjs', import.meta.url).href;
  const code = `import {SpendingLedger} from ${JSON.stringify(moduleUrl)};
    const ledger=new SpendingLedger(${JSON.stringify(path)});
    process.send({ready:true});
    process.once('message',()=>{try{process.send({result:ledger[${JSON.stringify(operation)}](${JSON.stringify(input)})});}
      catch(error){process.send({result:{code:error.code}});}finally{ledger.close();process.disconnect();}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', answer;
  child.stderr.on('data', data => stderr += data);
  let readyResolve, resultResolve, reject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; reject = rejectReady; });
  const result = new Promise(resolveResult => { resultResolve = resolveResult; });
  child.on('message', value => { if (value.ready) readyResolve(); else answer = value.result; });
  child.on('error', error => { reject(error); resultResolve({ failure: String(error) }); });
  child.on('exit', code => {
    if (code !== 0) { reject(new Error(stderr)); resultResolve({ failure: stderr }); }
    else resultResolve(answer);
  });
  return { ready, result, run() { child.send('go'); } };
}

test('concurrent process reservations conserve the one $100 allowance', async t => {
  const { ledger, path } = fixture(t);
  const children = ['fly-a', 'modal-b'].map((reservationId, index) => synchronizedChild(path, { reservationId, provider: index ? 'modal' : 'fly', ceilingCents: 7000 }));
  await Promise.all(children.map(child => child.ready)); children.forEach(child => child.run());
  const results = await Promise.all(children.map(child => child.result));
  assert.equal(results.filter(result => result.state === 'reserved').length, 1);
  assert.equal(results.filter(result => result.code === 'BUDGET').length, 1);
  assert.equal(ledger.status().committedCents, 7000);
  assert.equal(ledger.status().unallocatedCents, 3000);
});

test('concurrent exact duplicate identities reserve once; conflicts never repurpose a key', async t => {
  const { ledger, path } = fixture(t);
  const input = { reservationId: 'modal-20261002', provider: 'modal', ceilingCents: 3000 };
  const children = [synchronizedChild(path, input), synchronizedChild(path, input)];
  await Promise.all(children.map(child => child.ready)); children.forEach(child => child.run());
  const results = await Promise.all(children.map(child => child.result));
  assert.deepEqual(results[0], results[1]);
  assert.equal(ledger.status().committedCents, 3000);
  assert.equal(ledger.db.prepare("SELECT count(*) n FROM spending_events WHERE type='reserved'").get().n, 1);
  for (const change of [{ provider: 'fly' }, { ceilingCents: 3001 }]) {
    assert.throws(() => ledger.reserve({ ...input, ...change }), error => error.code === 'CONFLICT');
  }
});

test('Fly and Modal allocations share one durable balance independently of cell budgets', t => {
  const { ledger, reopen } = fixture(t);
  ledger.reserve({ reservationId: 'federation-20261002', provider: 'fly', ceilingCents: 1000 });
  ledger.reserve({ reservationId: 'modal-20261002', provider: 'modal', ceilingCents: 3000 });
  const status = reopen().status();
  assert.equal(status.limitCents, 10000); assert.equal(status.currency, 'USD');
  assert.equal(status.committedCents, 4000); assert.equal(status.unallocatedCents, 6000);
  assert.equal(status.knownMeteredCents, 0); assert.equal(status.meteredSpendCents, 0);
  assert.equal(status.unsettledReservations.length, 2);
});

test('retirement preserves the whole ceiling until final billing, then retains actual spend', t => {
  const { ledger, reopen, advance } = fixture(t);
  ledger.reserve({ reservationId: 'worker', provider: 'fly', ceilingCents: 1000 });
  ledger.start('worker'); advance();
  ledger.observe('worker', { chargedCents: 250, observedAt: 1000, evidenceDigest: PROOF });
  const retired = ledger.retire('worker', { evidenceDigest: PROOF });
  assert.equal(retired.state, 'retired-meter-pending');
  const reopened = reopen();
  assert.equal(reopened.status().committedCents, 1000); assert.equal(reopened.status().unallocatedCents, 9000);
  assert.equal(reopened.status().meteredSpendCents, null); assert.equal(reopened.status().knownMeteredCents, 250);
  reopened.observe('worker', { chargedCents: 275, observedAt: 1001, evidenceDigest: FINAL_PROOF });
  assert.throws(() => reopened.settle('worker', { finalCents: 274, evidenceDigest: FINAL_PROOF }), error => error.code === 'METER_REGRESSION');
  const settled = reopened.settle('worker', { finalCents: 300, evidenceDigest: FINAL_PROOF });
  assert.equal(settled.state, 'settled'); assert.equal(reopened.status().committedCents, 300);
  assert.equal(reopened.status().unallocatedCents, 9700); assert.equal(reopened.status().meteredSpendCents, 300);
  assert.equal(reopened.status().knownMeteredCents, 300); assert.equal(reopened.status().unsettledReservations.length, 0);
  assert.deepEqual(reopened.settle('worker', { finalCents: 300, evidenceDigest: FINAL_PROOF }), settled);
  assert.throws(() => reopened.settle('worker', { finalCents: 301, evidenceDigest: FINAL_PROOF }), error => error.code === 'CONFLICT');
  assert.throws(() => reopened.start('worker'), error => error.code === 'STATE');
});

test('cancellation releases only a never-started reservation and duplicate keys remain retired', t => {
  const { ledger } = fixture(t);
  const unused = { reservationId: 'unused', provider: 'fly', ceilingCents: 1000 };
  ledger.reserve(unused); const cancelled = ledger.cancel('unused');
  assert.equal(ledger.status().committedCents, 0); assert.deepEqual(ledger.cancel('unused'), cancelled);
  assert.deepEqual(ledger.reserve(unused), cancelled);
  assert.throws(() => ledger.start('unused'), error => error.code === 'STATE');
  ledger.reserve({ reservationId: 'started', provider: 'modal', ceilingCents: 3000 }); ledger.start('started');
  assert.throws(() => ledger.cancel('started'), error => error.code === 'STATE');
  assert.throws(() => ledger.settle('started', { finalCents: 0, evidenceDigest: PROOF }), error => error.code === 'STATE');
  ledger.retire('started', { evidenceDigest: PROOF });
  assert.throws(() => ledger.cancel('started'), error => error.code === 'STATE');
  assert.throws(() => ledger.retire('started', { evidenceDigest: FINAL_PROOF }), error => error.code === 'CONFLICT');
  assert.equal(ledger.status().committedCents, 3000);
});

test('cumulative meters are monotonic and active observations remain incomplete billing', t => {
  const { ledger } = fixture(t);
  ledger.reserve({ reservationId: 'worker', provider: 'modal', ceilingCents: 3000 });
  assert.throws(() => ledger.observe('worker', { chargedCents: 0, observedAt: 1000, evidenceDigest: PROOF }), error => error.code === 'STATE');
  assert.equal(ledger.start('worker').chargedCents, null); assert.equal(ledger.status().meteredSpendCents, null);
  const observation = { chargedCents: 250, observedAt: 1000, evidenceDigest: PROOF };
  const first = ledger.observe('worker', observation);
  assert.deepEqual(ledger.observe('worker', observation), first);
  assert.throws(() => ledger.observe('worker', { ...observation, chargedCents: 249, observedAt: 1001 }), error => error.code === 'METER_REGRESSION');
  assert.throws(() => ledger.observe('worker', { ...observation, observedAt: 999 }), error => error.code === 'METER_REGRESSION');
  assert.throws(() => ledger.observe('worker', { ...observation, evidenceDigest: FINAL_PROOF }), error => error.code === 'CONFLICT');
  assert.equal(ledger.status().knownMeteredCents, 250); assert.equal(ledger.status().meteredSpendCents, null);
  assert.equal(ledger.db.prepare("SELECT count(*) n FROM spending_events WHERE type='observed'").get().n, 1);
});

test('spend above a ceiling is recorded and blocks both new reservations and fresh paid admission', t => {
  const { ledger, reopen } = fixture(t);
  ledger.reserve({ reservationId: 'fly', provider: 'fly', ceilingCents: 1000 });
  ledger.reserve({ reservationId: 'pending-modal', provider: 'modal', ceilingCents: 7000 });
  ledger.start('fly'); ledger.observe('fly', { chargedCents: 4000, observedAt: 1000, evidenceDigest: PROOF });
  const status = reopen().status();
  assert.equal(status.committedCents, 11000); assert.equal(status.knownMeteredCents, 4000);
  assert.equal(status.unallocatedCents, 0); assert.equal(status.overCommittedCents, 1000);
  assert.throws(() => ledger.reserve({ reservationId: 'new', provider: 'fly', ceilingCents: 1 }), error => error.code === 'BUDGET');
  assert.throws(() => ledger.start('pending-modal'), error => error.code === 'BUDGET');
  assert.throws(() => ledger.start('fly'), error => error.code === 'BUDGET');
  // Cleanup remains possible after an overage; final spend is never written off as unused allocation.
  ledger.retire('fly', { evidenceDigest: PROOF }); ledger.settle('fly', { finalCents: 4200, evidenceDigest: FINAL_PROOF });
  assert.equal(ledger.status().committedCents, 11200);
  ledger.cancel('pending-modal'); assert.equal(ledger.status().committedCents, 4200);
  assert.equal(ledger.status().meteredSpendCents, 4200);
});

test('inputs and evidence accept only cents, USD and digests; raw provider data never enters the database', t => {
  const { ledger, path } = fixture(t), secret = 'private-provider-token-do-not-store';
  for (const value of [-1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ledger.reserve({ reservationId: 'invalid', provider: 'fly', ceilingCents: value }), error => error.code === 'INVALID');
  }
  assert.throws(() => ledger.initialize({ limitCents: 10000, currency: 'EUR' }), error => error.code === 'INVALID');
  assert.throws(() => ledger.initialize({ limitCents: 10001, currency: 'USD' }), error => error.code === 'CONFLICT');
  assert.throws(() => ledger.reserve({ reservationId: 'invalid', provider: 'https://api.fly.io', ceilingCents: 10 }), error => error.code === 'INVALID');
  assert.throws(() => ledger.reserve({ reservationId: 'invalid', provider: 'fly', ceilingCents: 10, token: secret }), error => error.code === 'INVALID');
  ledger.reserve({ reservationId: 'worker', provider: 'fly', ceilingCents: 10 }); ledger.start('worker');
  for (const input of [
    { chargedCents: 0, observedAt: 0, evidenceDigest: 'C:/secret/provider.json' },
    { chargedCents: 0, observedAt: 0, evidenceDigest: secret },
    { chargedCents: 0, observedAt: 0, evidenceDigest: PROOF, response: secret },
  ]) assert.throws(() => ledger.observe('worker', input), error => error.code === 'INVALID');
  assert.equal(JSON.stringify(ledger.status()).includes(secret), false);
  assert.equal(JSON.stringify(ledger.db.prepare('SELECT * FROM spending_events').all()).includes(secret), false);
  assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
  assert.equal(readFileSync(path + '-wal').includes(Buffer.from(secret)), false);
});

test('an exhausted experiment cannot spend unused global allowance; cleanup and observation still work', t => {
  const { ledger } = fixture(t);
  ledger.reserve({ reservationId: 'modal', provider: 'modal', ceilingCents: 3000 }); ledger.start('modal');
  ledger.observe('modal', { chargedCents: 3000, observedAt: 1000, evidenceDigest: PROOF });
  assert.equal(ledger.status().unallocatedCents, 7000);
  assert.throws(() => ledger.start('modal'), error => error.code === 'BUDGET');
  ledger.observe('modal', { chargedCents: 3100, observedAt: 1001, evidenceDigest: FINAL_PROOF });
  assert.throws(() => ledger.start('modal'), error => error.code === 'BUDGET');
  ledger.retire('modal', { evidenceDigest: PROOF }); ledger.settle('modal', { finalCents: 3200, evidenceDigest: FINAL_PROOF });
  assert.equal(ledger.status().committedCents, 3200);
  ledger.reserve({ reservationId: 'zero', provider: 'fly', ceilingCents: 0 });
  assert.throws(() => ledger.start('zero'), error => error.code === 'BUDGET'); ledger.cancel('zero');
});

test('schema refuses another controller database; policy initialization and starts are idempotent', t => {
  const { ledger, dir } = fixture(t);
  const before = ledger.db.prepare('SELECT count(*) n FROM spending_events').get().n;
  ledger.initialize({ limitCents: 10000, currency: 'USD' }); assert.equal(ledger.db.prepare('SELECT count(*) n FROM spending_events').get().n, before);
  ledger.reserve({ reservationId: 'worker', provider: 'fly', ceilingCents: 1000 }); const started = ledger.start('worker');
  assert.deepEqual(ledger.start('worker'), started);
  assert.equal(ledger.db.prepare("SELECT count(*) n FROM spending_events WHERE type='started'").get().n, 1);
  assert.throws(() => new SpendingLedger('relative.sqlite'), error => error.code === 'INVALID');
  const foreignPath = join(dir, 'control.sqlite'), database = new DatabaseSync(foreignPath);
  database.exec('CREATE TABLE control(id INTEGER PRIMARY KEY); PRAGMA user_version=1;'); database.close();
  assert.throws(() => new SpendingLedger(foreignPath), error => error.code === 'SCHEMA');
});

test('durable pause fences fresh and replayed admissions across connections and preserves existing O markers', t => {
  const { ledger, reopen } = fixture(t), other = reopen();
  const pending = { reservationId: 'pending', provider: 'fly', ceilingCents: 1000 };
  const active = { reservationId: 'active', provider: 'modal', ceilingCents: 3000 };
  ledger.reserve(pending); ledger.reserve(active); ledger.start('active');
  other.transaction(() => other.event('admission_paused', null, { source: 'existing-O-marker' }));
  const markers = other.db.prepare("SELECT * FROM spending_events WHERE type LIKE 'admission_%' ORDER BY seq").all();
  assert.deepEqual(ledger.pauseAdmission(), { admissionPaused: true });
  assert.deepEqual(other.db.prepare("SELECT * FROM spending_events WHERE type LIKE 'admission_%' ORDER BY seq").all(), markers);
  const before = JSON.stringify(ledger.rows()), count = ledger.db.prepare('SELECT count(*) n FROM spending_events').get().n;
  for (const connection of [ledger, other, reopen()]) {
    for (const admission of [
      () => connection.reserve({ reservationId: 'fresh', provider: 'fly', ceilingCents: 100 }),
      () => connection.reserve(pending), () => connection.reserve(active),
      () => connection.start('pending'), () => connection.start('active'),
    ]) assert.throws(admission, error => error.code === 'PAUSED' && error.message === 'Paid admission is paused.');
  }
  assert.equal(JSON.stringify(ledger.rows()), before);
  assert.equal(ledger.db.prepare('SELECT count(*) n FROM spending_events').get().n, count);
  assert.deepEqual(other.resumeAdmission(), { admissionPaused: false });
  const afterResume = other.db.prepare('SELECT count(*) n FROM spending_events').get().n;
  assert.deepEqual(ledger.resumeAdmission(), { admissionPaused: false });
  assert.equal(other.db.prepare('SELECT count(*) n FROM spending_events').get().n, afterResume);
  assert.equal(ledger.start('pending').state, 'started');
  assert.equal(ledger.start('active').state, 'started');
  assert.equal(ledger.status().limitCents, 10000);
  assert.equal(ledger.status().committedCents, 4000);
  ledger.pauseAdmission(); other.event('unrelated-observation', null, {});
  assert.throws(() => other.start('active'), error => error.code === 'PAUSED');
});

test('paused accounting and cleanup retain billing holds; resume never replenishes caps or revives terminal reservations', t => {
  const { ledger, reopen, advance } = fixture(t), other = reopen();
  ledger.reserve({ reservationId: 'exhausted', provider: 'modal', ceilingCents: 3000 }); ledger.start('exhausted');
  ledger.observe('exhausted', { chargedCents: 3000, observedAt: 1000, evidenceDigest: PROOF });
  ledger.reserve({ reservationId: 'cleanup', provider: 'fly', ceilingCents: 1000 }); ledger.start('cleanup');
  ledger.reserve({ reservationId: 'never-started', provider: 'fly', ceilingCents: 500 });
  const originalPolicy = ledger.policy(); other.pauseAdmission(); advance();
  ledger.observe('cleanup', { chargedCents: 250, observedAt: 1001, evidenceDigest: PROOF });
  ledger.retire('cleanup', { evidenceDigest: PROOF });
  assert.equal(ledger.status().committedCents, 4500);
  assert.equal(ledger.status().meteredSpendCents, null);
  ledger.settle('cleanup', { finalCents: 300, evidenceDigest: FINAL_PROOF });
  ledger.cancel('never-started');
  assert.equal(ledger.status().committedCents, 3300);
  assert.throws(() => ledger.start('exhausted'), error => error.code === 'PAUSED');
  other.resumeAdmission();
  assert.throws(() => ledger.start('exhausted'), error => error.code === 'BUDGET');
  assert.throws(() => ledger.start('cleanup'), error => error.code === 'STATE');
  assert.throws(() => ledger.start('never-started'), error => error.code === 'STATE');
  assert.throws(() => ledger.reserve({ reservationId: 'too-much', provider: 'fly', ceilingCents: 6701 }), error => error.code === 'BUDGET');
  ledger.reserve({ reservationId: 'remaining', provider: 'fly', ceilingCents: 6700 }); ledger.start('remaining');
  assert.equal(ledger.status().committedCents, 10000);
  assert.deepEqual(ledger.policy(), originalPolicy);
});

test('concurrent process pause and resume transitions append one compatible marker each without resetting shared policy', async t => {
  const { ledger, path } = fixture(t);
  ledger.reserve({ reservationId: 'unchanged', provider: 'fly', ceilingCents: 1000 });
  const before = ledger.status();
  for (const [operation, type, admissionPaused] of [
    ['pauseAdmission', 'admission_paused', true], ['resumeAdmission', 'admission_resumed', false],
  ]) {
    const children = [synchronizedChild(path, undefined, operation), synchronizedChild(path, undefined, operation)];
    await Promise.all(children.map(child => child.ready)); children.forEach(child => child.run());
    assert.deepEqual(await Promise.all(children.map(child => child.result)), [{ admissionPaused }, { admissionPaused }]);
    assert.equal(ledger.db.prepare('SELECT count(*) n FROM spending_events WHERE type=?').get(type).n, 1);
    assert.deepEqual(ledger.status(), before);
  }
});

test('an admission pause can protect an uninitialized ledger and survives later fixed-policy initialization', t => {
  const { dir } = fixture(t), ledger = new SpendingLedger(join(dir, 'not-initialized.sqlite'));
  try {
    assert.deepEqual(ledger.pauseAdmission(), { admissionPaused: true });
    assert.equal(ledger.db.prepare('SELECT count(*) n FROM spending_policy').get().n, 0);
    assert.equal(ledger.db.prepare('SELECT count(*) n FROM spending_reservations').get().n, 0);
    ledger.initialize({ limitCents: 999, currency: 'USD' });
    assert.throws(() => ledger.reserve({ reservationId: 'paid', provider: 'fly', ceilingCents: 1000 }), error => error.code === 'PAUSED');
    ledger.resumeAdmission();
    assert.throws(() => ledger.reserve({ reservationId: 'paid', provider: 'fly', ceilingCents: 1000 }), error => error.code === 'BUDGET');
    assert.equal(ledger.status().limitCents, 999);
  } finally { ledger.close(); }
});
