import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { startPresentationServer, encodeCursor, decodeCursor, validateViewerToken, loadViewerToken } from '../src/presentation.mjs';

const runFile = promisify(execFile);
const TOKEN = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const PRIVATE = 'private-raw-prompt-and-receipt-secret';
const NOW = 1_800_000_000_000;

async function fixture(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-presentation-'));
  const databasePath = path.join(directory, 'control.sqlite');
  let now = NOW;
  const control = new FactoryControl(databasePath, { clock: () => now });
  control.initialize({ mission: 'Develop FLUJO', budgetCents: 10000, maxCells: 8, maxDepth: 2 });
  control.reserveCell({ cellId: 'developer-a', budgetCents: 3000, purpose: 'Improve developer speed' });
  control.enrollCell('developer-a');
  control.reserveCell({ cellId: 'nested-worker', parentId: 'developer-a', budgetCents: 2000, purpose: 'Alternative candidate' });
  control.reserveCell({ cellId: 'verifier', role: 'verifier', budgetCents: 0, purpose: 'Check candidate independently' });
  control.enrollCell('verifier');
  const configuration = typeof extra === 'function' ? extra({ directory, databasePath }) : extra;
  const server = await startPresentationServer({ databasePath, factoryId: 'flujo', token: TOKEN, port: 0,
    buildRevision: 'a'.repeat(40), clock: () => now, eventPageSize: 2, ...configuration });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    control.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('factory-presentation-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function request(url = '/v1/factories/flujo/snapshot', options = {}) {
    const response = await fetch(new URL(url, origin), { headers: { Authorization: `Bearer ${TOKEN}` }, redirect: 'error', ...options });
    return { response, body: await response.json() };
  }
  return { directory, databasePath, control, server, origin, request, spendingLedgerPath: configuration.spendingLedgerPath,
    setNow(value) { now = value; } };
}

test('presentation authenticates reads, rejects commands and exposes no CORS contract', async t => {
  const f = await fixture(t);
  for (const route of ['/v1/snapshot', '/v1/events', '/v1/factories/flujo/snapshot']) {
    const { response, body } = await f.request(route, { headers: {} });
    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: { code: 'UNAUTHORIZED' } });
  }
  assert.equal((await f.request('/v1/snapshot', { headers: { Authorization: `Bearer ${TOKEN.slice(0, -1)}0` } })).response.status, 401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const { response } = await f.request('/v1/snapshot', { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('presentation binds one factory and never accepts client filesystem paths', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/factories/another/snapshot')).response.status, 404);
  assert.equal((await f.request('/v1/factories/flujo/mutate')).response.status, 404);
  assert.equal((await f.request('/v1/snapshot?database=C:/private.sqlite')).response.status, 400);
  assert.equal((await f.request('/v1/events?after=MA&after=MA')).response.status, 400);
  await assert.rejects(startPresentationServer({ databasePath: f.databasePath, factoryId: 'flujo', token: TOKEN,
    host: '0.0.0.0', port: 0 }), { code: 'PRESENTATION_BIND_INVALID' });
});

test('snapshot omits specifications, credentials, private paths, event details and receipts', async t => {
  const f = await fixture(t);
  f.control.createTask({ taskId: 'code-task', projectId: 'flujo', branch: 'codex/private-candidate',
    specification: { problem: PRIVATE, acceptance: PRIVATE, baseline: PRIVATE, privatePath: f.directory } });
  const lease = f.control.claimTask('code-task', 'developer-a');
  f.control.admitEffect(lease, { key: 'model-call', kind: 'flow_call', request: { prompt: PRIVATE, token: PRIVATE } });
  f.control.startEffect(lease, 'model-call');
  f.control.settleEffect('model-call', 'succeeded');
  f.control.db.prepare('UPDATE effects SET receipt=? WHERE key=?').run(JSON.stringify({ body: PRIVATE, outputPath: f.directory }), 'model-call');
  const candidatePath = path.join(f.directory, 'candidate.json'), reviewPath = path.join(f.directory, 'review.json');
  await fs.writeFile(candidatePath, JSON.stringify({ rawOutput: PRIVATE }));
  await fs.writeFile(reviewPath, JSON.stringify({ rawOutput: PRIVATE }));
  f.control.submit(lease, { artifactPath: candidatePath });
  f.control.reviewTask('code-task', 'verifier', { accepted: true, evidencePath: reviewPath });
  f.control.event('private_details', 'code-task', { token: PRIVATE, path: f.directory });
  const { response, body } = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(body.capabilities, { snapshot: true, events: true, commands: false });
  assert.equal(body.scope, 'local-coordinator');
  assert.equal(body.revision, f.control.db.prepare('SELECT max(seq) AS n FROM events').get().n);
  assert.equal(decodeCursor(body.cursor), body.revision);
  assert.equal(body.buildRevision, 'a'.repeat(40));
  const serialized = JSON.stringify(body);
  for (const value of [PRIVATE, f.directory, lease.token, TOKEN, 'token_hash', 'specification', 'outputPath', 'artifactPath', 'receipt']) assert.equal(serialized.includes(value), false, value);
  assert.deepEqual(body.snapshot.budget, { limitCents: 10000, rootCommittedCents: 3000, unallocatedCents: 7000,
    meteredSpendCents: null, currency: 'USD', basis: 'logical-allocation' });
  assert.equal(body.snapshot.tasks[0].review.accepted, true);
  assert.match(body.snapshot.tasks[0].candidate.sha256, /^[a-f0-9]{64}$/);
  assert.equal(body.snapshot.workerQuiescence, 'unverified');
  assert.equal(body.snapshot.effectsDrained, true);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unknown and cleanup effects remain visible without declaring worker quiescence', async t => {
  const f = await fixture(t);
  f.control.createTask({ taskId: 'boot', projectId: 'pilot', branch: 'codex/presentation-boot',
    specification: { problem: 'Boot', acceptance: 'Observe', baseline: 'fixture' } });
  const lease = f.control.claimTask('boot', 'developer-a');
  f.control.admitEffect(lease, { key: 'provision-child', kind: 'provision', request: { cellId: 'nested-worker', app: 'ff-presentation-child' } });
  f.control.startEffect(lease, 'provision-child');
  f.control.settleEffect('provision-child', 'unknown');
  f.control.admitOwnedRetirement({ key: 'retire-child', app: 'ff-presentation-child' });
  const { body, response } = await f.request('/v1/snapshot');
  assert.equal(response.status, 200);
  assert.equal(body.snapshot.unresolvedEffects, 2);
  assert.equal(body.snapshot.effectsDrained, false);
  assert.equal(body.snapshot.effects.some(effect => effect.scope === 'cleanup' && effect.kind === 'retire'), true);
  assert.equal(body.snapshot.workerQuiescence, 'unverified');
  f.control.pause();
  f.control.startOwnedRetirement('retire-child');
  f.control.settleEffect('retire-child', 'succeeded', { app: 'ff-presentation-child', state: 'destroyed' });
  const completed = await f.request('/v1/snapshot');
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.snapshot.control.status, 'paused');
  assert.equal(completed.body.snapshot.effects.find(effect => effect.key === 'retire-child').scope, 'cleanup');
  assert.equal(completed.body.snapshot.effects.find(effect => effect.key === 'retire-child').state, 'succeeded');
  assert.equal(completed.body.snapshot.unresolvedEffects, 1);
  assert.equal(completed.body.snapshot.effectsDrained, false);
  assert.equal(completed.body.snapshot.workerQuiescence, 'unverified');
});

test('events paginate with replayable opaque cursors and no details', async t => {
  const f = await fixture(t);
  f.control.event('private_details', 'root', { output: PRIVATE });
  const first = await f.request('/v1/events?limit=2');
  assert.equal(first.response.status, 200);
  assert.equal(first.body.events.length, 2);
  assert.equal(first.body.hasMore, true);
  assert.equal(decodeCursor(first.body.cursor), first.body.events.at(-1).seq);
  assert.equal(decodeCursor(first.body.latestCursor), first.body.revision);
  const nextUrl = `/v1/factories/flujo/events?after=${first.body.cursor}&limit=2`;
  const next = await f.request(nextUrl), replay = await f.request(nextUrl);
  assert.deepEqual(next.body.events, replay.body.events);
  assert.equal(next.body.events[0].seq, first.body.events.at(-1).seq + 1);
  assert.deepEqual(Object.keys(next.body.events[0]), ['seq', 'type', 'subject', 'observedAt']);
  assert.equal(JSON.stringify(next.body).includes(PRIVATE), false);
  const caughtUp = await f.request(`/v1/events?after=${first.body.latestCursor}`);
  assert.deepEqual(caughtUp.body.events, []);
  assert.equal(caughtUp.body.hasMore, false);
  assert.equal(caughtUp.body.cursor, first.body.latestCursor);
  for (const cursor of ['-1', 'garbage', encodeCursor(first.body.revision + 1)]) {
    assert.equal((await f.request(`/v1/events?after=${cursor}`)).response.status, 400);
  }
});

test('heartbeat changes appear even when event revision is unchanged and reads do not mutate', async t => {
  const f = await fixture(t);
  const first = (await f.request()).body;
  const eventCount = f.control.db.prepare('SELECT count(*) AS n FROM events').get().n;
  f.setNow(NOW + 1000);
  f.control.heartbeat('root');
  const next = (await f.request('/v1/snapshot')).body;
  assert.equal(next.revision, first.revision);
  assert.notEqual(next.observedAt, first.observedAt);
  assert.notEqual(next.snapshot.cells.find(cell => cell.id === 'root').heartbeat,
    first.snapshot.cells.find(cell => cell.id === 'root').heartbeat);
  assert.equal(f.control.db.prepare('SELECT count(*) AS n FROM events').get().n, eventCount);
});

test('optional paid budget stays separate and observes independent ledger writes at unchanged controller revision', async t => {
  const f = await fixture(t, ({ directory }) => ({ spendingLedgerPath: path.join(directory, 'spending.sqlite') }));
  const ledger = new SpendingLedger(f.spendingLedgerPath, { clock: () => NOW });
  try {
    ledger.initialize({ limitCents: 10000, currency: 'USD' });
    ledger.reserve({ reservationId: 'fly-run', provider: 'fly', ceilingCents: 1000 });
    ledger.reserve({ reservationId: 'modal-run', provider: 'modal', ceilingCents: 3000 });
    ledger.start('fly-run');
    ledger.observe('fly-run', { chargedCents: 250, observedAt: NOW, evidenceDigest: 'f'.repeat(64) });
    ledger.retire('fly-run', { evidenceDigest: 'e'.repeat(64) });
    const first = (await f.request()).body;
    const firstPaid = first.snapshot.paidBudget;
    assert.equal(firstPaid.availability, 'available');
    assert.equal(firstPaid.scope, 'registered-factory-paid-reservations');
    assert.equal(firstPaid.basis, 'shared-paid-admission-ledger');
    assert.equal(firstPaid.committedCents, 4000);
    assert.equal(firstPaid.knownMeteredCents, 250);
    assert.equal(firstPaid.meteredSpendCents, null);
    assert.equal(firstPaid.billingIncomplete, true);
    assert.equal(firstPaid.reservations.find(row => row.reservationId === 'fly-run').state, 'retired-meter-pending');
    const script = `import { SpendingLedger } from ${JSON.stringify(new URL('../src/spending.mjs', import.meta.url).href)};
      const ledger=new SpendingLedger(process.argv[1]);
      try { ledger.settle('fly-run',{finalCents:300,evidenceDigest:'d'.repeat(64)});
        ledger.start('modal-run'); ledger.observe('modal-run',{chargedCents:4000,observedAt:${NOW + 1},evidenceDigest:'c'.repeat(64)});
        ledger.db.prepare('INSERT INTO spending_events(type,reservation_id,details,created_at) VALUES(?,?,?,?)')
          .run('private_record','modal-run',JSON.stringify({body:${JSON.stringify(PRIVATE)},path:process.argv[1]}),${NOW + 1});
      } finally { ledger.close(); }`;
    await runFile(process.execPath, ['--input-type=module', '-e', script, f.spendingLedgerPath], { windowsHide: true, timeout: 10_000 });
    f.setNow(NOW + 2);
    const next = (await f.request()).body;
    assert.equal(next.revision, first.revision);
    assert.equal(next.cursor, first.cursor);
    assert.deepEqual(next.snapshot.budget, first.snapshot.budget);
    assert.ok(next.snapshot.paidBudget.revision > firstPaid.revision);
    assert.notEqual(next.snapshot.paidBudget.observedAt, firstPaid.observedAt);
    assert.equal(next.snapshot.paidBudget.committedCents, 4300);
    assert.equal(next.snapshot.paidBudget.knownMeteredCents, 4300);
    assert.equal(next.snapshot.paidBudget.meteredSpendCents, null);
    assert.equal(next.snapshot.paidBudget.reservations.find(row => row.reservationId === 'modal-run').overCeilingCents, 1000);
    for (const value of [PRIVATE, f.spendingLedgerPath, 'f'.repeat(64), 'retirementEvidenceDigest', 'details']) {
      assert.equal(JSON.stringify(next.snapshot.paidBudget).includes(value), false, value);
    }
  } finally { ledger.close(); }
});

test('unconfigured or unavailable paid ledgers do not fabricate totals or create databases', async t => {
  const unconfigured = await fixture(t);
  assert.deepEqual((await unconfigured.request()).body.snapshot.paidBudget,
    { availability: 'not-configured', scope: 'registered-factory-paid-reservations', observedAt: new Date(NOW).toISOString() });
  const f = await fixture(t, ({ directory }) => ({ spendingLedgerPath: path.join(directory, 'never-created.sqlite') }));
  assert.equal((await f.request('/v1/snapshot', { headers: {} })).response.status, 401);
  const unavailable = await f.request();
  assert.equal(unavailable.response.status, 200);
  assert.deepEqual(unavailable.body.snapshot.paidBudget,
    { availability: 'unavailable', scope: 'registered-factory-paid-reservations', observedAt: new Date(NOW).toISOString() });
  await assert.rejects(fs.stat(f.spendingLedgerPath), { code: 'ENOENT' });
  assert.equal((await f.request('/v1/snapshot?spending-ledger=C:/private.sqlite')).response.status, 400);
  await assert.rejects(startPresentationServer({ databasePath: f.databasePath, spendingLedgerPath: 'relative.sqlite',
    factoryId: 'flujo', token: TOKEN, port: 0 }), { code: 'PRESENTATION_INPUT_INVALID' });
});

test('paid figures and their independent revision are atomic during external ledger admission', async t => {
  const f = await fixture(t, ({ directory }) => ({ spendingLedgerPath: path.join(directory, 'spending.sqlite') }));
  const ledger = new SpendingLedger(f.spendingLedgerPath);
  ledger.initialize({ limitCents: 10000, currency: 'USD' });
  ledger.close();
  const script = `import { SpendingLedger } from ${JSON.stringify(new URL('../src/spending.mjs', import.meta.url).href)};
    const ledger=new SpendingLedger(process.argv[1]);
    try { for(let i=0;i<30;i++) { ledger.reserve({reservationId:'run-'+i,provider:'fly',ceilingCents:10});
      await new Promise(resolve=>setTimeout(resolve,2)); } } finally { ledger.close(); }`;
  const writer = runFile(process.execPath, ['--input-type=module', '-e', script, f.spendingLedgerPath], { windowsHide: true, timeout: 10_000 });
  for (let i = 0; i < 30; i++) {
    const { response, body } = await f.request();
    assert.equal(response.status, 200);
    const paid = body.snapshot.paidBudget;
    assert.equal(paid.availability, 'available');
    assert.equal(paid.revision, 1 + paid.reservations.length);
    assert.equal(paid.committedCents, paid.reservations.length * 10);
  }
  await writer;
  const completed = (await f.request()).body.snapshot.paidBudget;
  assert.equal(completed.revision, 31);
  assert.equal(completed.reservations.length, 30);
});

test('paid projection validates schema and row state, detects revision regressions and writes no ledger data', async t => {
  const f = await fixture(t, ({ directory }) => ({ spendingLedgerPath: path.join(directory, 'spending.sqlite') }));
  const ledger = new SpendingLedger(f.spendingLedgerPath, { clock: () => NOW });
  try {
    ledger.initialize({ limitCents: 10000, currency: 'USD' });
    ledger.reserve({ reservationId: 'pending', provider: 'fly', ceilingCents: 1000 });
    const events = ledger.db.prepare('SELECT * FROM spending_events').all();
    const reservations = ledger.db.prepare('SELECT * FROM spending_reservations').all();
    const mainBefore = await fs.readFile(f.spendingLedgerPath), walBefore = await fs.readFile(`${f.spendingLedgerPath}-wal`);
    const good = await f.request();
    assert.equal(good.response.status, 200);
    assert.equal(good.body.snapshot.paidBudget.availability, 'available');
    assert.deepEqual(ledger.db.prepare('SELECT * FROM spending_events').all(), events);
    assert.deepEqual(ledger.db.prepare('SELECT * FROM spending_reservations').all(), reservations);
    assert.deepEqual(await fs.readFile(f.spendingLedgerPath), mainBefore);
    assert.deepEqual(await fs.readFile(`${f.spendingLedgerPath}-wal`), walBefore);
    ledger.db.exec('PRAGMA user_version=2');
    assert.equal((await f.request()).body.snapshot.paidBudget.availability, 'unavailable');
    ledger.db.exec('PRAGMA user_version=1; CREATE TABLE unexpected(secret TEXT)');
    assert.equal((await f.request()).body.snapshot.paidBudget.availability, 'unavailable');
    ledger.db.exec('DROP TABLE unexpected');
    ledger.db.prepare('UPDATE spending_reservations SET provider=? WHERE id=?').run('C:/private-account', 'pending');
    const malformed = await f.request();
    assert.equal(malformed.response.status, 200);
    assert.equal(malformed.body.snapshot.paidBudget.availability, 'unavailable');
    assert.equal(JSON.stringify(malformed.body).includes('private-account'), false);
    ledger.db.prepare('UPDATE spending_reservations SET provider=? WHERE id=?').run('fly', 'pending');
    ledger.db.prepare('UPDATE spending_reservations SET started_at=? WHERE id=?').run(NOW, 'pending');
    assert.equal((await f.request()).body.snapshot.paidBudget.availability, 'unavailable');
    ledger.db.prepare('UPDATE spending_reservations SET started_at=NULL WHERE id=?').run('pending');
    ledger.db.exec('DELETE FROM spending_events WHERE seq>1');
    assert.equal((await f.request()).body.snapshot.paidBudget.availability, 'unavailable');
  } finally { ledger.close(); }
  const foreign = await fixture(t, ({ databasePath }) => ({ spendingLedgerPath: databasePath }));
  assert.equal((await foreign.request()).body.snapshot.paidBudget.availability, 'unavailable');
});

test('missing or unsupported database returns unavailable without creating an empty database', async t => {
  const f = await fixture(t);
  f.control.db.exec('PRAGMA user_version=2');
  for (const route of ['/v1/snapshot', '/v1/events']) {
    const result = await f.request(route);
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, { error: { code: 'FACTORY_SCHEMA_UNSUPPORTED' } });
    assert.equal(JSON.stringify(result.body).includes(f.directory), false);
  }
  f.control.db.exec('PRAGMA user_version=1');
  const missingPath = path.join(f.directory, 'never-created.sqlite');
  const server = await startPresentationServer({ databasePath: missingPath, factoryId: 'flujo', token: TOKEN, port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 503);
    await assert.rejects(fs.stat(missingPath), { code: 'ENOENT' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('snapshots keep event cursor consistent with atomic external controller writes', async t => {
  const f = await fixture(t);
  const script = `import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=2000');
    for(let i=0;i<30;i++) { db.exec('BEGIN IMMEDIATE');
      const seq=db.prepare('INSERT INTO events(type,subject,details,observed) VALUES(?,?,?,?)').run('atomic_marker','root','{}',${NOW}).lastInsertRowid;
      const policy=JSON.parse(db.prepare('SELECT policy FROM control WHERE id=1').get().policy);
      policy.mission='marker-'+seq; db.prepare('UPDATE control SET policy=? WHERE id=1').run(JSON.stringify(policy)); db.exec('COMMIT');
      await new Promise(resolve=>setTimeout(resolve,2)); }
    db.close();`;
  const child = runFile(process.execPath, ['--input-type=module', '-e', script, f.databasePath], { timeout: 10_000, windowsHide: true });
  for (let i = 0; i < 30; i++) {
    const { body, response } = await f.request();
    assert.equal(response.status, 200);
    if (body.snapshot.control.mission.startsWith('marker-')) assert.equal(Number(body.snapshot.control.mission.slice(7)), body.revision);
    assert.equal(decodeCursor(body.cursor), body.revision);
  }
  await child;
  const final = (await f.request()).body;
  assert.equal(Number(final.snapshot.control.mission.slice(7)), final.revision);
});

test('token validation withholds unsafe credentials and uses environment without disclosure', async () => {
  assert.equal(validateViewerToken(TOKEN), TOKEN);
  assert.equal(await loadViewerToken({ env: { FACTORY_VIEWER_TOKEN: TOKEN } }), TOKEN);
  for (const token of ['', 'a'.repeat(64), `${TOKEN}\n`, 'too-short']) assert.throws(() => validateViewerToken(token), { code: 'VIEWER_TOKEN_INVALID' });
  await assert.rejects(loadViewerToken({ env: {} }), { code: 'VIEWER_TOKEN_INVALID' });
});

test('private token files require owner-only permissions and reject hard links', async t => {
  const f = await fixture(t);
  const tokenFile = path.join(f.directory, 'viewer.token');
  await fs.writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o644 });
  await assert.rejects(loadViewerToken({ tokenFile }), { code: 'VIEWER_TOKEN_FILE_UNSAFE' });
  if (process.platform === 'win32') {
    const script = String.raw`
      $ErrorActionPreference = 'Stop'
      $p = [Environment]::GetEnvironmentVariable('FACTORY_TEST_VIEWER_FILE')
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = New-Object Security.AccessControl.FileSecurity
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $p -AclObject $acl
    `;
    const systemRoot = process.env.SystemRoot;
    await runFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15_000, env: { SystemRoot: systemRoot, WINDIR: systemRoot, FACTORY_TEST_VIEWER_FILE: tokenFile } });
  } else await fs.chmod(tokenFile, 0o600);
  assert.equal(await loadViewerToken({ tokenFile }), TOKEN);
  const linkedFile = path.join(f.directory, 'viewer-linked.token');
  await fs.link(tokenFile, linkedFile);
  await assert.rejects(loadViewerToken({ tokenFile }), { code: 'VIEWER_TOKEN_FILE_UNSAFE' });
});

test('CLI listens only on loopback and prints neither credentials nor database paths', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [path.resolve('bin/serve.mjs'), '--database', f.databasePath,
    '--spending-ledger', path.join(f.directory, 'missing-paid.sqlite'), '--factory-id', 'flujo', '--port', '0'], { env: { ...process.env, FACTORY_VIEWER_TOKEN: TOKEN }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI startup timed out.')), 5000);
        child.stdout.on('data', () => { if (stdout.includes('\n')) { clearTimeout(timer); resolve(); } });
        child.on('error', reject);
      }),
      once(child, 'exit').then(() => { throw new Error('CLI exited before listening.'); }),
    ]);
    const announcement = JSON.parse(stdout.trim());
    assert.equal(announcement.listening.host, '127.0.0.1');
    assert.equal(announcement.capabilities.commands, false);
    const response = await fetch(`http://127.0.0.1:${announcement.listening.port}/v1/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).snapshot.paidBudget.availability, 'unavailable');
    assert.equal((stdout + stderr).includes(TOKEN), false);
    assert.equal((stdout + stderr).includes(f.directory), false);
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
});
