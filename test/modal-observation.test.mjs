import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../src/control.mjs';
import { createModalObservationReader } from '../src/modal-observation.mjs';

const NOW = 1_800_000_000_000;
const TIME = new Date(NOW).toISOString();
const SECRET = 'never-project-private-request-response-token-or-prompt';
const SCHEMA = `CREATE TABLE modal_operations(key TEXT PRIMARY KEY, operation TEXT NOT NULL,
 request_digest TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL,
 result_json TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`;
const SUCCESS = {
  'create-volume': 'volume-created', deploy: 'deployed', prefetch: 'weights-cached',
  'create-proxy-token': 'proxy-token-created', 'direct-generation': 'generation-completed',
  'create-flujo-model': 'model-connected', 'create-flujo-flow': 'flow-connected',
  'flujo-generation': 'generation-completed', 'disable-flujo-model': 'model-disabled',
  'delete-proxy-token': 'proxy-token-deleted', 'stop-app': 'stopped',
  'delete-volume': 'volume-deleted', 'delete-flujo-flow': 'flow-removed', 'delete-flujo-model': 'model-removed',
};
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, { runId = 'run-one', wal = false } = {}) {
  const base = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, 'factory-modal-observation-'));
  const journalPath = path.join(directory, 'modal.sqlite');
  const db = new DatabaseSync(journalPath);
  if (wal) db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  let closed = false;
  const close = () => { if (!closed) { db.close(); closed = true; } };
  t.after(async () => {
    close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), base);
    assert.ok(path.basename(target).startsWith('factory-modal-observation-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const add = ({ key = 'prefetch', operation = 'prefetch', state = 'unknown', request, result, created = NOW, updated = NOW + 1 } = {}) => {
    const intent = request ?? { operation, runId, nested: { z: SECRET, a: [2, { privatePath: directory }] } };
    const outcome = result === undefined ? (state === 'unknown' ? { state: 'unknown' }
      : state === 'succeeded' ? { state: SUCCESS[operation] } : null) : result;
    db.prepare('INSERT INTO modal_operations VALUES(?,?,?,?,?,?,?,?)').run(key, operation, digest(intent), JSON.stringify(intent), state,
      outcome === null ? null : JSON.stringify(outcome), created, updated);
  };
  return { directory, journalPath, db, close, runId, add,
    reader: () => createModalObservationReader([{ runId, journalPath }]),
    read: reader => reader(TIME).runs[0] };
}
function unavailable(value) {
  assert.deepEqual(value, { runId: 'run-one', availability: 'unavailable', reason: 'MODAL_JOURNAL_UNAVAILABLE' });
}

test('unconfigured reader states its persisted-only content-hash scope', () => {
  assert.deepEqual(createModalObservationReader()(TIME), {
    availability: 'not_configured', scope: 'registered-modal-operation-journals',
    basis: 'persisted-local-operation-journal', providerFreshness: 'not_observed',
    revisionKind: 'content-sha256', observedAt: TIME, runs: [],
  });
});

test('closed bounded config rejects ambiguous identities and sanitizes errors without invoking getters', async t => {
  const f = await fixture(t);
  const entry = { runId: f.runId, journalPath: f.journalPath };
  let getterCalls = 0;
  const accessor = { journalPath: f.journalPath, get runId() { getterCalls++; return f.runId; } };
  const arrayAccessor = [];
  Object.defineProperty(arrayAccessor, 0, { get() { getterCalls++; return entry; } });
  for (const input of [null, {}, [null], [entry, entry], [{ ...entry, unknown: SECRET }],
    [{ runId: 'bad.id', journalPath: f.journalPath }], [{ runId: 'a'.repeat(65), journalPath: f.journalPath }],
    [{ runId: 'run-two', journalPath: 'relative.sqlite' }], [{ runId: 'run-two', journalPath: f.journalPath + '\0' }],
    [accessor], arrayAccessor, new Array(1), [{ ...entry, [Symbol('secret')]: SECRET }],
    [entry, { runId: 'run-two', journalPath: path.join(f.directory, 'nested', '..', 'modal.sqlite') }],
    Array.from({ length: 17 }, (_, index) => ({ runId: 'run-' + index, journalPath: path.join(f.directory, index + '.sqlite') }))]) {
    assert.throws(() => createModalObservationReader(input), error => error.code === 'MODAL_JOURNAL_CONFIG_INVALID'
      && error.status === 400 && !error.message.includes(SECRET) && !error.message.includes(f.directory));
  }
  if (process.platform === 'win32') {
    for (const journalPath of ['\\private.sqlite', 'C:private.sqlite']) {
      assert.throws(() => createModalObservationReader([{ runId: 'run-one', journalPath }]), { code: 'MODAL_JOURNAL_CONFIG_INVALID' });
    }
    assert.throws(() => createModalObservationReader([entry, { runId: 'run-two', journalPath: f.journalPath.toUpperCase() }]), { code: 'MODAL_JOURNAL_CONFIG_INVALID' });
  }
  assert.equal(getterCalls, 0);
});

test('registration is captured once and observation timestamps are validated independently', async t => {
  const f = await fixture(t); f.add();
  const entry = { runId: f.runId, journalPath: f.journalPath }, entries = [entry];
  const reader = createModalObservationReader(entries);
  entry.runId = 'another-run'; entries.length = 0;
  assert.equal(f.read(reader).runId, 'run-one');
  for (const invalid of [undefined, NOW, '2027-02-30T00:00:00Z', '2027-01-01', SECRET]) {
    assert.throws(() => reader(invalid), { code: 'MODAL_JOURNAL_OBSERVATION_INVALID', status: 400 });
  }
  assert.equal(reader('2027-01-01T01:00:00+01:00').observedAt, '2027-01-01T00:00:00.000Z');
});

test('missing or bad journals remain unavailable without creating files or hiding healthy peers', async t => {
  const f = await fixture(t); f.add();
  const missing = path.join(f.directory, 'missing.sqlite'), bad = path.join(f.directory, 'bad.sqlite');
  await fs.writeFile(bad, SECRET);
  const reader = createModalObservationReader([{ runId: 'missing', journalPath: missing },
    { runId: f.runId, journalPath: f.journalPath }, { runId: 'bad', journalPath: bad }]);
  const result = reader(TIME);
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.runs.map(row => row.availability), ['unavailable', 'available', 'unavailable']);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  assert.equal(await fs.readFile(bad, 'utf8'), SECRET);
  assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('missing.sqlite')), false);
});

test('legacy reconciliation and unknowns expose safe historical metadata without secret or billing fields', async t => {
  const f = await fixture(t);
  f.add();
  f.add({ key: 'stop-app', operation: 'stop-app', state: 'succeeded', result: {
    state: 'stopped', appId: 'ap-Ab12', volumeId: 'vo-Ab12', runningContainers: 0, observedAt: NOW + 1,
    alreadyStopped: false, elapsedMs: 37, reconciled: true, reconciliationProofDigest: 'a'.repeat(64),
    reconciliationProofFile: SECRET, rawResponse: SECRET, token: SECRET, knownMeteredCents: 50, final: true,
  } });
  const result = f.read(f.reader());
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.operations[0].outcome, { state: 'unknown' });
  assert.deepEqual(result.operations[1].outcome, { state: 'stopped', appId: 'ap-Ab12', volumeId: 'vo-Ab12',
    runningContainers: 0, observedAt: new Date(NOW + 1).toISOString(), alreadyStopped: false, elapsedMs: 37 });
  const serialized = JSON.stringify(result);
  for (const value of [SECRET, f.directory, 'request_json', 'request_digest', 'reconciliationProof', 'rawResponse', 'token', 'knownMeteredCents', 'final']) {
    assert.equal(serialized.includes(value), false, value);
  }
});

test('every actual journal operation and strict successful outcome enum is supported', async t => {
  const f = await fixture(t);
  for (const [operation, state] of Object.entries(SUCCESS)) f.add({ key: operation, operation, state: 'succeeded', result: { state } });
  const value = f.read(f.reader());
  assert.equal(value.availability, 'available');
  assert.equal(value.operations.length, Object.keys(SUCCESS).length);
  for (const op of value.operations) assert.equal(op.outcome.state, SUCCESS[op.operation]);
  assert.match(value.journalRevision, /^[a-f0-9]{64}$/);
});

test('field types and meaning stay tied to their actual producing operation', async t => {
  const f = await fixture(t);
  f.add({ key: 'direct-generation', operation: 'direct-generation', state: 'succeeded', result: {
    state: 'generation-completed', promptTokens: 12, completionTokens: 3, totalTokens: 15,
    runningContainers: 0, appId: 'ap-SECRET', status: 200, final: true, knownMeteredCents: 0,
  } });
  f.add({ key: 'create-flujo-model', operation: 'create-flujo-model', state: 'succeeded', result: { state: 'model-connected', status: 201, completionTokens: SECRET } });
  const ops = f.read(f.reader()).operations;
  assert.deepEqual(ops.find(row => row.operation === 'direct-generation').outcome,
    { state: 'generation-completed', promptTokens: 12, completionTokens: 3, totalTokens: 15 });
  assert.deepEqual(ops.find(row => row.operation === 'create-flujo-model').outcome, { state: 'model-connected', status: 201 });
});

test('accepted and running intents have null outcomes and stable content revisions ignore capture time', async t => {
  const f = await fixture(t);
  f.add({ key: 'deploy', operation: 'deploy', state: 'accepted' });
  f.add({ key: 'prefetch', operation: 'prefetch', state: 'running' });
  const reader = f.reader(), first = f.read(reader);
  assert.deepEqual(first.operations.map(row => row.outcome), [null, null]);
  assert.equal(reader(new Date(NOW + 1000).toISOString()).runs[0].journalRevision, first.journalRevision);
  first.operations[0].state = 'succeeded'; first.operations.pop();
  assert.equal(f.read(reader).operations.length, 2);
  assert.equal(f.read(reader).operations[0].state, 'accepted');
});

test('read-only projection preserves main DB bytes, schema, version, mode and rows', async t => {
  const f = await fixture(t); f.add(); f.close();
  const before = await fs.readFile(f.journalPath), names = await fs.readdir(f.directory);
  const reader = f.reader(); assert.equal(f.read(reader).availability, 'available'); assert.equal(f.read(reader).availability, 'available');
  assert.equal(hash(await fs.readFile(f.journalPath)), hash(before));
  assert.deepEqual(await fs.readdir(f.directory), names);
  const inspect = new DatabaseSync(f.journalPath, { readOnly: true });
  try {
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(inspect.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(inspect.prepare('SELECT count(*) AS n FROM modal_operations').get().n, 1);
    assert.equal(inspect.prepare("SELECT sql FROM sqlite_schema WHERE name='modal_operations'").get().sql.replace(/\s/g, ''), SCHEMA.replace(/\s/g, ''));
  } finally { inspect.close(); }
});

test('coherent WAL snapshots never expose an uncommitted transition', async t => {
  const f = await fixture(t, { wal: true }); f.add({ state: 'accepted' });
  const reader = f.reader();
  f.db.exec('BEGIN IMMEDIATE;');
  f.db.prepare("UPDATE modal_operations SET state='running',updated=?").run(NOW + 2);
  assert.equal(f.read(reader).operations[0].state, 'accepted');
  f.db.exec('COMMIT;');
  const after = f.read(reader);
  assert.equal(after.operations[0].state, 'running');
  assert.equal(after.operations[0].updatedAt, new Date(NOW + 2).toISOString());
  assert.equal(after.operations[0].outcome, null);
});

test('exclusive locks fail closed within the bounded busy timeout', async t => {
  const f = await fixture(t); f.add(); f.db.exec('BEGIN EXCLUSIVE;');
  const start = Date.now(); unavailable(f.read(f.reader()));
  assert.ok(Date.now() - start < 1200);
  f.db.exec('ROLLBACK;');
});

test('only the exact original schema and user version are accepted', async t => {
  for (const mutation of ['PRAGMA user_version=1', 'CREATE TABLE extra(secret TEXT)',
    'CREATE VIEW extra AS SELECT * FROM modal_operations', 'CREATE INDEX extra ON modal_operations(operation)',
    'CREATE TRIGGER extra AFTER INSERT ON modal_operations BEGIN SELECT 1; END',
    'ALTER TABLE modal_operations ADD COLUMN extra TEXT']) {
    await t.test(mutation.split(' ').slice(0, 3).join(' '), async inner => {
      const f = await fixture(inner); f.add(); f.db.exec(mutation); unavailable(f.read(f.reader()));
    });
  }
});

test('private request identity, canonical digest, depth and size are validated', async t => {
  const mutations = [
    db => db.prepare("UPDATE modal_operations SET request_digest=?").run(SECRET),
    db => db.prepare("UPDATE modal_operations SET request_digest=?").run('0'.repeat(64)),
    db => { const request = { operation: 'prefetch', runId: 'wrong-run' }; db.prepare('UPDATE modal_operations SET request_json=?,request_digest=?').run(JSON.stringify(request), digest(request)); },
    db => { const request = { operation: 'deploy', runId: 'run-one' }; db.prepare('UPDATE modal_operations SET request_json=?,request_digest=?').run(JSON.stringify(request), digest(request)); },
    db => db.prepare('UPDATE modal_operations SET request_json=?').run('not-json'),
    db => db.prepare('UPDATE modal_operations SET request_json=?').run('[]'),
    db => { let nested = {}; for (let at = 0; at < 35; at++) nested = { nested }; const request = { operation: 'prefetch', runId: 'run-one', nested }; db.prepare('UPDATE modal_operations SET request_json=?,request_digest=?').run(JSON.stringify(request), digest(request)); },
    db => { const request = { operation: 'prefetch', runId: 'run-one', secret: 's'.repeat(65_536) }; db.prepare('UPDATE modal_operations SET request_json=?,request_digest=?').run(JSON.stringify(request), digest(request)); },
  ];
  for (let at = 0; at < mutations.length; at++) await t.test('malformed private request ' + at, async inner => {
    const f = await fixture(inner); f.add(); mutations[at](f.db); unavailable(f.read(f.reader()));
  });
});

test('settled results require a bounded object and their operation-specific state', async t => {
  for (const result of [null, [], {}, { state: SECRET }, { state: 'deployed' },
    { state: 'stopped', runningContainers: true }, { state: 'stopped', runningContainers: -1 },
    { state: 'stopped', appId: 'vo-wrong' }, { state: 'stopped', appId: SECRET },
    { state: 'stopped', observedAt: '2027-02-30T00:00:00Z' }, { state: 'stopped', alreadyStopped: 1 },
    { state: 'stopped', elapsedMs: 1.5 }, { state: 'stopped', observedAt: null },
    { state: 'stopped', private: 's'.repeat(65_536) }]) {
    await t.test('invalid result ' + JSON.stringify(result).slice(0, 60), async inner => {
      const f = await fixture(inner); f.add({ key: 'stop-app', operation: 'stop-app', state: 'succeeded', result }); unavailable(f.read(f.reader()));
    });
  }
  const f = await fixture(t); f.add(); f.db.prepare('UPDATE modal_operations SET result_json=?').run('not-json'); unavailable(f.read(f.reader()));
});

test('invalid token totals, HTTP status and Volume version refuse the affected run', async t => {
  for (const row of [
    { key: 'direct-generation', operation: 'direct-generation', result: { state: 'generation-completed', promptTokens: 2, completionTokens: 3, totalTokens: 8 } },
    { key: 'create-flujo-model', operation: 'create-flujo-model', result: { state: 'model-connected', status: 0 } },
    { key: 'create-volume', operation: 'create-volume', result: { state: 'volume-created', volumeFsVersion: 3 } },
  ]) await t.test(row.operation, async inner => { const f = await fixture(inner); f.add({ ...row, state: 'succeeded' }); unavailable(f.read(f.reader())); });
});

test('impossible duplicate operations, unsupported operations and excess rows are refused', async t => {
  const duplicate = await fixture(t); duplicate.add(); duplicate.add({ key: 'second-prefetch' }); unavailable(duplicate.read(duplicate.reader()));
  const unsupported = await fixture(t); unsupported.add({ operation: 'meter' }); unavailable(unsupported.read(unsupported.reader()));
  const excess = await fixture(t); excess.db.exec('BEGIN;');
  for (let at = 0; at < 1001; at++) excess.add({ key: 'row-' + at, state: 'accepted' });
  excess.db.exec('COMMIT;'); unavailable(excess.read(excess.reader()));
});

test('hard-linked, oversized and symbolic-link paths are never adopted', async t => {
  const f = await fixture(t); f.add(); f.close();
  const linked = path.join(f.directory, 'hardlink.sqlite'); await fs.link(f.journalPath, linked);
  unavailable(f.read(f.reader())); await fs.unlink(linked);
  assert.equal(f.read(f.reader()).availability, 'available');
  const oversized = path.join(f.directory, 'oversized.sqlite'); await fs.writeFile(oversized, ''); await fs.truncate(oversized, 32 * 1024 * 1024 + 1);
  const value = createModalObservationReader([{ runId: 'run-one', journalPath: oversized }])(TIME).runs[0]; unavailable(value);
  try {
    const symbolic = path.join(f.directory, 'symbolic.sqlite'); await fs.symlink(f.journalPath, symbolic);
    unavailable(createModalObservationReader([{ runId: 'run-one', journalPath: symbolic }])(TIME).runs[0]);
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
});

test('prior identity and monotonic states refuse disappearing, relabelled and regressing intents', async t => {
  const mutations = [
    db => db.exec('DELETE FROM modal_operations'),
    db => { const request = { operation: 'prefetch', runId: 'run-one', newIdentity: true }; db.prepare('UPDATE modal_operations SET request_json=?,request_digest=?').run(JSON.stringify(request), digest(request)); },
    db => { const request = { operation: 'deploy', runId: 'run-one' }; db.prepare("UPDATE modal_operations SET operation='deploy',request_json=?,request_digest=?").run(JSON.stringify(request), digest(request)); },
    db => db.prepare('UPDATE modal_operations SET created=?').run(NOW - 1),
    db => db.prepare('UPDATE modal_operations SET updated=?').run(NOW),
    db => db.prepare("UPDATE modal_operations SET state='running',result_json=NULL,updated=?").run(NOW + 2),
  ];
  for (let at = 0; at < mutations.length; at++) await t.test('identity regression ' + at, async inner => {
    const f = await fixture(inner); f.add(); const reader = f.reader(); assert.equal(f.read(reader).availability, 'available');
    mutations[at](f.db); unavailable(f.read(reader));
  });
});

test('settled unknown and succeeded repeats freeze raw receipts and timestamps including omitted fields', async t => {
  for (const state of ['unknown', 'succeeded']) for (const mutation of ['updated', 'projected', 'private', 'rollback']) {
    await t.test(state + ' ' + mutation, async inner => {
      const f = await fixture(inner); const original = { state: state === 'unknown' ? 'unknown' : 'stopped', appId: 'ap-Ab12', privateProof: SECRET };
      f.add({ key: 'stop-app', operation: 'stop-app', state, result: original }); const reader = f.reader(); assert.equal(f.read(reader).availability, 'available');
      if (mutation === 'updated') f.db.prepare('UPDATE modal_operations SET updated=?').run(NOW + 2);
      else if (mutation === 'rollback') f.db.prepare("UPDATE modal_operations SET state='running',result_json=NULL,updated=?").run(NOW + 2);
      else f.db.prepare('UPDATE modal_operations SET result_json=?').run(JSON.stringify({ ...original, [mutation === 'private' ? 'privateProof' : 'appId']: mutation === 'private' ? 'changed-private-proof' : 'ap-Changed' }));
      unavailable(f.read(reader));
    });
  }
});

test('unknown to succeeded reconciliation is visible without inferring fresh provider state', async t => {
  const f = await fixture(t); f.add({ key: 'stop-app', operation: 'stop-app' });
  const reader = f.reader(), first = f.read(reader);
  f.db.prepare("UPDATE modal_operations SET state='succeeded',updated=?,result_json=?").run(NOW + 2,
    JSON.stringify({ state: 'stopped', appId: 'ap-Ab12', runningContainers: 0, reconciled: true, reconciliationProofFile: SECRET }));
  const complete = reader(TIME);
  assert.equal(complete.providerFreshness, 'not_observed');
  assert.equal(complete.runs[0].availability, 'available');
  assert.equal(complete.runs[0].operations[0].state, 'succeeded');
  assert.notEqual(complete.runs[0].journalRevision, first.journalRevision);
  assert.equal(f.read(reader).journalRevision, complete.runs[0].journalRevision);
});
