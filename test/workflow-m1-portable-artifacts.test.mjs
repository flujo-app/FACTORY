import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, realpathSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, toNamespacedPath } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { collectCloudLiteSnapshot } from '../src/cloud-lite/collect.mjs';
import { Factory, FactoryArtifactStore, FactoryWorkflow, captureGitSource, interpretVerification, reconcileVerification, runVerification, startVerification } from '../src/public-sdk.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('SQLite snapshot backup supports deep workspace paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-deep-sqlite-'));
  const database = new DatabaseSync(toNamespacedPath(join(root, 'state.sqlite')));
  database.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('deep-workspace')");
  database.close();
  // Keep tar's working directory below MAX_PATH while the SQLite target exceeds it.
  const prefix = join(root, '.factory-export-deep-');
  const destination = prefix + 'c'.repeat(Math.max(1, 250 - prefix.length));
  assert.ok(join(destination, 'snapshot', 'state.sqlite').length > 260);
  const result = await collectCloudLiteSnapshot({ root, runId: 'deep-sqlite', destination });
  assert.equal(result.sqliteBackups, 1);
  const retained = new DatabaseSync(toNamespacedPath(join(destination, 'snapshot', 'state.sqlite')), { readOnly: true });
  assert.equal(retained.prepare('SELECT value FROM evidence').get().value, 'deep-workspace');
  retained.close();
});

test('portable snapshot preserves and verifies real evidence while excluding private paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-portable-'));
  mkdirSync(join(root, 'logs'), { recursive: true });
  mkdirSync(join(root, 'cache', '.npm'), { recursive: true });
  mkdirSync(join(root, 'safe-dir'), { recursive: true });
  const regular = Buffer.from('portable artifact bytes\n');
  writeFileSync(join(root, 'evidence.bin'), regular);
  writeFileSync(join(root, 'auth.json'), '{"token":"must-not-export"}');
  writeFileSync(join(root, 'cache', '.npm', 'index'), 'cache only');
  writeFileSync(join(root, 'safe-dir', 'inside.txt'), 'inside root');
  const jsonlPath = join(root, 'logs', 'events.jsonl');
  writeFileSync(jsonlPath, '{"event":"complete"}\n{"event":"incomplete');
  const dbPath = join(root, 'state.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES (\'snapshot-db\')');
  database.close();

  const runId = `m1-artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await collectCloudLiteSnapshot({ root, runId, includeGitObjects: false });
  assert.equal(result.sha256, sha256(readFileSync(result.archive)));
  assert.equal(result.bytes, readFileSync(result.archive).length);

  const extracted = join(root, 'inspection');
  mkdirSync(extracted);
  const unpacked = spawnSync('tar', ['-xzf', result.archive, '-C', extracted], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const snapshot = join(extracted, 'snapshot');
  const manifest = JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8'));
  assert.equal(manifest.runId, runId);
  const portablePath = value => value.replaceAll('\\', '/');
  const fileByPath = new Map(manifest.files.map(file => [portablePath(file.path), file]));
  for (const [name, bytes] of [['evidence.bin', regular], ['safe-dir/inside.txt', Buffer.from('inside root')]]) {
    assert.equal(fileByPath.get(name)?.bytes, bytes.length);
    assert.equal(fileByPath.get(name)?.sha256, sha256(bytes));
    assert.equal(sha256(readFileSync(join(snapshot, name))), fileByPath.get(name).sha256);
  }
  assert.ok(fileByPath.has('state.sqlite'));
  const backedUpDb = new DatabaseSync(join(snapshot, 'state.sqlite'), { readOnly: true });
  assert.equal(backedUpDb.prepare('SELECT value FROM evidence').get().value, 'snapshot-db');
  backedUpDb.close();
  assert.ok(manifest.sqliteBackups.includes('state.sqlite'));
  assert.equal(readFileSync(join(snapshot, 'logs', 'events.jsonl'), 'utf8'), '{"event":"complete"}\n');
  const tail = manifest.files.find(file => file.preservedFrom && portablePath(file.preservedFrom) === 'logs/events.jsonl');
  assert.ok(tail, 'partial JSONL tail should have its own manifest entry');
  assert.equal(readFileSync(join(snapshot, tail.path), 'utf8'), '{"event":"incomplete');
  assert.equal(tail.sha256, sha256(Buffer.from('{"event":"incomplete')));
  assert.equal(existsSync(join(snapshot, 'auth.json')), false);
  assert.equal(existsSync(join(snapshot, 'cache', '.npm')), false);
  assert.ok(manifest.omitted.includes('auth.json'));
  assert.ok(manifest.omitted.some(path => portablePath(path) === 'cache/.npm'));
});

test('portable snapshot retains internal directory links and omits links escaping its root', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-links-'));
  const external = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-outside-'));
  mkdirSync(join(root, 'safe-dir'));
  mkdirSync(join(external, 'outside-dir'));
  writeFileSync(join(root, 'safe-dir', 'inside.txt'), 'inside root');
  writeFileSync(join(external, 'outside-dir', 'outside-secret.txt'), 'outside root secret');
  const windows = process.platform === 'win32';
  const linkType = windows ? 'junction' : 'dir';
  const linkTarget = target => windows ? resolve(target) : relative(root, target);
  const privilegeError = error => ['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code);
  try {
    symlinkSync(linkTarget(join(root, 'safe-dir')), join(root, 'safe-link'), linkType);
    symlinkSync(linkTarget(join(external, 'outside-dir')), join(root, 'outside-link'), linkType);
  } catch (error) {
    if (windows && privilegeError(error)) return t.skip(`Symlink creation is unavailable under this Windows privilege policy (${error.code}).`);
    throw error;
  }
  const runId = `m1-links-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let result;
  try {
    result = await collectCloudLiteSnapshot({ root, runId, includeGitObjects: false });
  } catch (error) {
    if (windows && privilegeError(error) && error.syscall === 'symlink') {
      return t.skip(`Symlink export is unavailable under this Windows privilege policy (${error.code}).`);
    }
    throw error;
  }
  const extracted = join(root, 'inspection');
  mkdirSync(extracted);
  const unpacked = spawnSync('tar', ['-xzf', result.archive, '-C', extracted], { encoding: 'utf8' });
  const unpackMessage = `${unpacked.error?.message ?? ''}\n${unpacked.stderr ?? ''}`;
  if (process.platform === 'win32' && /(?:symlink|symbolic link|junction)/i.test(unpackMessage)
      && /(?:EPERM|EACCES|permission denied|operation not permitted|access is denied|privilege)/i.test(unpackMessage)) {
    return t.skip(`Archive extraction cannot recreate symlinks under this Windows privilege policy: ${unpackMessage.trim()}`);
  }
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const snapshot = join(extracted, 'snapshot');
  assert.ok(lstatSync(join(snapshot, 'safe-link')).isSymbolicLink());
  assert.equal(realpathSync(join(snapshot, 'safe-link')), realpathSync(join(snapshot, 'safe-dir')),
    'the archived internal link must resolve to archived content, not back to the source tree');
  assert.equal(readFileSync(join(snapshot, 'safe-link', 'inside.txt'), 'utf8'), 'inside root');
  assert.equal(existsSync(join(snapshot, 'outside-link')), false);
  const manifest = JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8'));
  const portablePath = value => value.replaceAll('\\', '/');
  assert.ok(manifest.omitted.some(path => portablePath(path) === 'outside-link'));
});

test('public FactoryArtifactStore preserves content identity across relocation and rejects corruption and invalid ranges', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-store-'));
  const directory = join(root, 'store');
  const moved = join(root, 'relocated-store');
  const store = new FactoryArtifactStore(directory);
  const bytes = Buffer.alloc(600_321);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
  const sourcePath = join(root, 'payload.bin');
  writeFileSync(sourcePath, bytes);
  const imported = store.importFile(sourcePath);
  assert.equal(imported.size, bytes.length);
  assert.equal(imported.ref, `sha256:${sha256(bytes)}`);
  assert.deepEqual(store.get(imported.ref), bytes);
  assert.throws(() => store.path('../../outside'), /Invalid artifact reference/);

  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
    const chunk = store.readChunk(imported.ref, { offset, length: 256 * 1024 });
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.size, bytes.length);
    assert.equal(chunk.done, offset + 256 * 1024 >= bytes.length);
    parts.push(Buffer.from(chunk.data, 'base64'));
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
  assert.equal(store.readChunk(imported.ref, { offset: bytes.length, length: 1 }).done, true);
  assert.throws(() => store.readChunk(imported.ref, { offset: bytes.length + 1, length: 1 }), /offset exceeds its size/);
  assert.throws(() => store.readChunk(imported.ref, { offset: -1 }), /Invalid artifact range/);
  assert.throws(() => store.readChunk(imported.ref, { length: 0 }), /Invalid artifact range/);
  assert.throws(() => store.readChunk(imported.ref, { length: 256 * 1024 + 1 }), /Invalid artifact range/);

  renameSync(directory, moved);
  const relocated = new FactoryArtifactStore(moved);
  assert.deepEqual(relocated.get(imported.ref), bytes);
  assert.deepEqual(relocated.describe(imported.ref), imported);
  assert.throws(() => relocated.putJSON({ x: undefined }), /JSON-compatible/);
  assert.throws(() => relocated.putJSON([undefined]), /JSON-compatible/);
  const json = { nested: [1, 'two'], ok: true };
  assert.deepEqual(relocated.getJSON(relocated.putJSON(json).ref), json);
  writeFileSync(relocated.path(imported.ref), Buffer.from('tampered content'));
  assert.throws(() => relocated.get(imported.ref), /no longer match their reference/);
  t.diagnostic(`relocated ${imported.ref} (${imported.size} bytes) and verified corruption rejection`);
});

function verifiedFixture(root, { failingGate = false, environmentCanary = false, mismatchArchive = false, ignoredGate = false } = {}) {
  const cwd = join(root, 'candidate'); mkdirSync(join(cwd, 'test'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  git('init'); git('config', 'user.email', 'workflow-m1@example.invalid'); git('config', 'user.name', 'Workflow test');
  writeFileSync(join(cwd, 'README.md'), 'Immutable verification baseline.\n');
  git('add', '.'); git('commit', '-m', 'Create immutable verification baseline');
  const baseline = git('rev-parse', 'HEAD');
  const assertion = failingGate ? 'assert.equal(1, 2);' : 'assert.equal(1, 1);';
  const body = environmentCanary
    ? "test('environment is isolated', () => { console.log(process.env.FACTORY_M1_CANARY ?? 'canary-unavailable'); });"
    : `test('candidate behavior', () => { ${assertion} });`;
  writeFileSync(join(cwd, 'test', 'candidate.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`);
  git('add', '.'); git('commit', '-m', 'Freeze actual verifier test source');
  const commit = git('rev-parse', 'HEAD');
  const source = { repository: 'example/repository', baseline, commit, tree: git('rev-parse', 'HEAD^{tree}') };
  const database = join(root, 'control.sqlite');
  new Factory(database).createSwarm({ mission: 'Verify frozen candidate', agents: [
    { id: 'builder' }, { id: 'reviewer', role: 'verifier' },
  ] });
  const workflow = new FactoryWorkflow(database);
  const captured = captureGitSource(workflow.artifacts, cwd, { repository: 'example/repository', baseline });
  const gate = ignoredGate
    ? { id: 'tests', command: '$node', args: ['check.mjs'], adapter: 'exit-code', scope: 'development', timeoutMs: 15000 }
    : { id: 'tests', command: '$node', args: ['--test', '--test-reporter=tap', 'test/candidate.test.mjs'], adapter: 'node-tap', scope: 'development', minimumTests: 1, timeoutMs: 15000 };
  const task = { taskId: 'task-m1', projectId: 'project-m1', branch: 'codex/m1-workflow', problem: 'Preserve candidate behavior',
    acceptance: 'Independent review and actual node:test execution', baseline, assignee: 'builder', reviewerId: 'reviewer',
    gates: [gate] };
  workflow.createTask(task); workflow.claim(task.taskId, 'builder');
  const submittedArchive = mismatchArchive
    ? { ...workflow.artifacts.put(Buffer.from('different archive bytes')), name: 'source.tar', kind: 'git-archive' }
    : captured.artifact;
  const candidate = workflow.submit(task.taskId, 'builder', { submissionId: 'candidate-m1', source,
    artifacts: [submittedArchive, ...(captured.bundle ? [captured.bundle] : [])], summary: 'Frozen actual Node test source.' });
  workflow.review(candidate.id, 'reviewer', { accepted: true, rationale: 'Review the frozen source against the stated requirement.' });
  return { root, cwd, database, workflow, candidate, gate: task.gates[0], source: captured.source, sourceArtifact: captured.artifact };
}

test('candidate submission carries the captured archive and verifier binds execution to it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-source-'));
  const f = verifiedFixture(root);
  t.after(() => f.workflow.close());
  assert.equal(f.candidate.source.commit, f.source.commit);
  assert.equal(f.candidate.source.tree, f.source.tree);
  const archive = f.workflow.artifacts.get(f.sourceArtifact.ref);
  assert.equal(sha256(archive), f.sourceArtifact.ref.slice('sha256:'.length));
  assert.ok(f.candidate.artifacts.some(artifact => artifact.ref === f.sourceArtifact.ref && artifact.kind === 'git-archive'));
  assert.ok(f.candidate.artifacts.some(artifact => artifact.kind === 'git-bundle'));
  const unpackDir = join(root, 'archive'); mkdirSync(unpackDir);
  const unpacked = spawnSync('tar', ['-xf', f.workflow.artifacts.path(f.sourceArtifact.ref), '-C', unpackDir], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  assert.equal(readFileSync(join(unpackDir, 'test', 'candidate.test.mjs'), 'utf8').includes("assert.equal(1, 1)"), true);
  const result = await runVerification(f.workflow, { runId: 'm1-captured-source', candidateId: f.candidate.id, gateId: f.gate.id, cwd: f.cwd });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.outcome, 'passed');
  assert.equal(result.result.sourceRef, f.sourceArtifact.ref);
  assert.equal(result.result.source.commit, f.source.commit);
  assert.equal(result.result.source.tree, f.source.tree);
  assert.equal(result.result.environment.platform, process.platform);
});

test('node-tap adapter rejects an exit-zero run with only skipped tests', () => {
  const output = '# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n';
  assert.equal(interpretVerification({ adapter: 'node-tap', minimumTests: 1 }, { exitCode: 0, stdout: output, stderr: '' }).outcome, 'failed');
});

test('verification refuses a submitted archive that differs from the gate source', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-mismatch-'));
  const f = verifiedFixture(root, { mismatchArchive: true });
  t.after(() => f.workflow.close());
  assert.throws(() => startVerification(f.workflow, { runId: 'm1-source-mismatch', candidateId: f.candidate.id,
    gateId: f.gate.id, cwd: f.cwd }), /Portable source snapshot does not match/);
});

test('ignored host overlay absent from captured archive cannot make a gate pass', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-ignored-'));
  const f = verifiedFixture(root, { ignoredGate: true });
  t.after(() => f.workflow.close());
  writeFileSync(join(f.cwd, '.git', 'info', 'exclude'), 'check.mjs\n');
  writeFileSync(join(f.cwd, 'check.mjs'), "process.stdout.write('ignored host overlay executed\\n');\n");
  assert.equal(spawnSync('git', ['-C', f.cwd, 'check-ignore', '-q', 'check.mjs'], { windowsHide: true }).status, 0);
  assert.equal(execFileSync('git', ['-C', f.cwd, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', windowsHide: true }).trim(), '');
  const archived = f.workflow.artifacts.get(f.sourceArtifact.ref);
  assert.equal(archived.includes(Buffer.from('check.mjs')), false, 'the passing gate script is absent from frozen candidate archive');
  const result = await runVerification(f.workflow, { runId: 'm1-ignored-overlay', candidateId: f.candidate.id, gateId: f.gate.id, cwd: f.cwd });
  assert.notEqual(result.result?.outcome, 'passed', 'a host ignored file absent from the archive must not satisfy a verification gate');
});

test('empty gate sets require an explicit review-only policy', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-review-only-'));
  const f = verifiedFixture(root);
  t.after(() => f.workflow.close());
  const input = { taskId: 'review-only-m1', projectId: 'project-m1', branch: 'codex/review-only', problem: 'Review evidence',
    acceptance: 'Independent reviewer accepts the evidence', baseline: f.source.baseline, assignee: 'builder', reviewerId: 'reviewer', gates: [] };
  assert.throws(() => f.workflow.createTask(input), /Declare objective gates/);
  assert.equal(f.workflow.createTask({ ...input, verificationPolicy: { mode: 'review-only', reason: 'No executable check applies.' } }).verificationPolicy.mode, 'review-only');
});

test('runner drops inherited canary environment and diagnostics retain no secret', async t => {
  const secret = Buffer.from('synthetic bootstrap secret').toString('base64');
  const prior = process.env.FACTORY_M1_CANARY;
  process.env.FACTORY_M1_CANARY = secret;
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-env-'));
  const f = verifiedFixture(root, { environmentCanary: true });
  t.after(() => { f.workflow.close(); if (prior === undefined) delete process.env.FACTORY_M1_CANARY; else process.env.FACTORY_M1_CANARY = prior; });
  const result = await runVerification(f.workflow, { runId: 'm1-env-isolation', candidateId: f.candidate.id, gateId: f.gate.id, cwd: f.cwd });
  assert.equal(result.result.outcome, 'passed');
  const diagnostics = f.workflow.artifacts.getJSON(result.result.diagnosticsRef);
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
  assert.ok(!JSON.stringify(diagnostics).includes('synthetic bootstrap secret'));
});

test('runner receipt replay rejects a fabricated pass for an actually failing candidate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-workflow-m1-receipt-'));
  const f = verifiedFixture(root, { failingGate: true });
  t.after(() => f.workflow.close());
  const runId = 'm1-real-run';
  const admitted = startVerification(f.workflow, { runId, candidateId: f.candidate.id, gateId: f.gate.id, cwd: f.cwd });
  assert.ok(['running', 'unknown'].includes(admitted.status));
  const receiptPath = join(f.workflow.artifacts.directory, '..', 'workflow-runs', runId, 'receipt.json');
  const deadline = Date.now() + 15000;
  while (!existsSync(receiptPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(existsSync(receiptPath), 'actual verifier runner must durably write its receipt');
  const actual = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(actual.outcome, 'failed', 'real node:test failure must be reflected in the runner receipt');
  writeFileSync(receiptPath, JSON.stringify({ ...actual, outcome: 'passed', reason: null, tests: 1 }));

  let accepted;
  assert.throws(() => { accepted = reconcileVerification(f.workflow, runId); }, /authentication/);
  assert.notEqual(f.workflow.getTask('task-m1').status, 'accepted', 'tampered runner receipt must not accept a task whose real test failed');
  assert.equal(accepted, undefined, 'modified runner receipt must not be imported as a passing verification');
});
