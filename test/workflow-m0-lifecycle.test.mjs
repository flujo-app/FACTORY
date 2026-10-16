import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Factory, FactoryWorkflow, captureGitSource, contentDigest, runVerification } from '../src/public-sdk.mjs';

const mcpServer = fileURLToPath(new URL('../bin/factory-mcp.mjs', import.meta.url));

function fixture({ ignoredGateInput = false } = {}) {
  const parent = resolve(process.env.FACTORY_TEST_TMP ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'factory-workflow-m0-'));
  const cwd = join(root, 'source'); mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  git('init'); git('config', 'user.email', 'workflow-test@example.invalid'); git('config', 'user.name', 'Workflow test');
  writeFileSync(join(cwd, 'source.txt'), 'frozen source\n');
  if (ignoredGateInput) writeFileSync(join(cwd, '.gitignore'), 'check.mjs\n');
  git('add', '.'); git('commit', '-m', 'Frozen workflow source');
  if (ignoredGateInput) writeFileSync(join(cwd, 'check.mjs'), 'process.stdout.write("ignored verifier input executed")\n');
  const revision = git('rev-parse', 'HEAD');
  const source = { repository: 'example/repository', baseline: revision, commit: revision, tree: git('rev-parse', 'HEAD^{tree}') };
  const database = join(root, 'control.sqlite');
  new Factory(database).createSwarm({ mission: 'Verify workflow lifecycle', agents: [
    { id: 'builder' }, { id: 'reviewer', role: 'verifier' }, { id: 'other-reviewer', role: 'verifier' },
  ] });
  const workflow = new FactoryWorkflow(database);
  const captured = captureGitSource(workflow.artifacts, cwd, { repository: source.repository, baseline: source.baseline });
  const task = (taskId, projectId = 'repo', overrides = {}) => ({ taskId, projectId, branch: `codex/${taskId}`,
    problem: 'Preserve original behavior', acceptance: 'Independent review', baseline: source.baseline,
    assignee: 'builder', reviewerId: 'reviewer', verificationPolicy: { mode: 'review-only', reason: 'Lifecycle-only test contract.' }, ...overrides });
  const submission = (submissionId, overrides = {}) => ({ submissionId, source: captured.source,
    artifacts: [captured.artifact, ...(captured.bundle ? [captured.bundle] : [])], summary: 'Frozen source', ...overrides });
  return { root, cwd, database, workflow, source: captured.source, sourceBytes: workflow.artifacts.get(captured.artifact.ref), task, submission, captured };
}

async function localMcp(t, f, { actor = 'builder', scopes = 'development' } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpServer, f.database, '--actor', actor, '--verification-scopes', scopes] });
  const client = new Client({ name: 'workflow-m0-adversary', version: '1.0.0' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  return client;
}

// Keep filesystem evidence in place for the invoking harness and board review.

test('workflow dependencies gate claims until the prerequisite is accepted and preserve event replay after reopen', t => {
  const f = fixture(); t.after(() => f.workflow.close());
  f.workflow.createTask(f.task('prerequisite'));
  f.workflow.createTask(f.task('dependent', 'repo', { dependencies: ['prerequisite'] }));
  assert.equal(f.workflow.getTask('dependent').status, 'waiting_dependency');
  assert.throws(() => f.workflow.claim('dependent', 'builder'), /dependency/);

  f.workflow.claim('prerequisite', 'builder');
  f.workflow.submit('prerequisite', 'builder', f.submission('candidate-prerequisite'));
  f.workflow.review('candidate-prerequisite', 'reviewer', { accepted: true, findings: [], rationale: 'Requirements satisfied.' });
  assert.equal(f.workflow.getTask('dependent').status, 'ready');
  const first = f.workflow.events({ after: 0, limit: 2 });
  assert.equal(first.events.length, 2);
  assert.ok(first.events[0].seq < first.events[1].seq);
  f.workflow.close(); f.workflow = new FactoryWorkflow(f.database);
  const replay = f.workflow.events({ after: first.cursor, limit: 500 });
  assert.match(first.cursor, /^wf1:/);
  assert.ok(replay.events.every(event => event.seq > first.events.at(-1).seq));
  assert.ok(replay.events.some(event => event.type === 'dependency_ready' && event.task === 'dependent'));
});

test('submission identity replays identical frozen bytes and rejects changed content for the same id', t => {
  const f = fixture(); t.after(() => f.workflow.close());
  f.workflow.createTask(f.task('identity'));
  f.workflow.claim('identity', 'builder');
  const original = f.submission('same-id');
  const first = f.workflow.submit('identity', 'builder', original);
  const replay = f.workflow.submit('identity', 'builder', original);
  assert.deepEqual(replay, first);
  assert.throws(() => f.workflow.submit('identity', 'builder', { ...original, summary: 'Changed after freeze' }), /conflict/i);
  assert.equal(f.workflow.getTask('identity').candidate.id, 'same-id');
});

test('only the assigned ready verifier can review and stale candidate reviews stay fenced after revision', t => {
  const f = fixture(); t.after(() => f.workflow.close());
  f.workflow.createTask(f.task('review-fence'));
  f.workflow.claim('review-fence', 'builder');
  f.workflow.submit('review-fence', 'builder', f.submission('candidate-old'));
  assert.throws(() => f.workflow.review('candidate-old', 'other-reviewer', { accepted: true, findings: [], rationale: 'Wrong verifier.' }), /assigned|reviewer/i);
  f.workflow.review('candidate-old', 'reviewer', { accepted: false, findings: [{ id: 'gap', description: 'Missing edge case', requirement: 'Preserve behavior' }], rationale: 'Needs revision.' });
  f.workflow.revise('review-fence', 'builder');
  f.workflow.claim('review-fence', 'builder');
  f.workflow.submit('review-fence', 'builder', f.submission('candidate-new', { resolvedFindings: ['gap'] }));
  assert.throws(() => f.workflow.review('candidate-old', 'reviewer', { accepted: true, findings: [], rationale: 'Late approval.' }), /superseded/i);
  assert.equal(f.workflow.getTask('review-fence').candidate.id, 'candidate-new');
  assert.equal(f.workflow.getTask('review-fence').review, null);
});

test('local stdio MCP caller cannot choose a reviewer identity to approve its own candidate', async t => {
  const f = fixture(); f.workflow.createTask(f.task('mcp-review')); f.workflow.close();
  const client = await localMcp(t, f);
  const upload = await client.callTool({ name: 'factory_artifact', arguments: { action: 'put', data: f.sourceBytes.toString('base64') } });
  assert.equal(upload.isError, undefined);
  const uploaded = JSON.parse(upload.content[0].text);
  await client.callTool({ name: 'factory_workflow', arguments: { action: 'claim', taskId: 'mcp-review' } });
  const submitted = await client.callTool({ name: 'factory_workflow', arguments: { action: 'submit', taskId: 'mcp-review', input: f.submission('mcp-candidate', { artifacts: [{ ...uploaded, name: 'source', kind: 'source' }] }) } });
  assert.equal(submitted.isError, undefined);
  const forgedReview = await client.callTool({ name: 'factory_workflow', arguments: { action: 'review', candidateId: 'mcp-candidate', actor: 'reviewer', input: { accepted: true, findings: [], rationale: 'Caller selected reviewer identity.' } } });
  assert.equal(forgedReview.isError, true, 'an untrusted local MCP caller must not choose the verifier identity');
  const state = await client.callTool({ name: 'factory_workflow', arguments: { action: 'get', taskId: 'mcp-review' } });
  assert.equal(JSON.parse(state.content[0].text).status, 'review');
});

test('local stdio MCP caller cannot self-authorize release-scope verification', async t => {
  const f = fixture();
  f.workflow.createTask(f.task('mcp-scope', 'repo', { gates: [{ id: 'release-check', command: '$node', args: ['-e', 'process.stdout.write("ok")'], adapter: 'exit-code', scope: 'release' }], verificationPolicy: { mode: 'objective' } }));
  f.workflow.claim('mcp-scope', 'builder');
  f.workflow.submit('mcp-scope', 'builder', f.submission('mcp-scope-candidate'));
  f.workflow.close();
  const client = await localMcp(t, f, { actor: 'root', scopes: 'development' });
  const forgedRun = await client.callTool({ name: 'factory_verification', arguments: { action: 'start', runId: 'mcp-release-run', candidateId: 'mcp-scope-candidate', gateId: 'release-check', cwd: f.cwd, allowedScopes: ['release'] } });
  assert.equal(forgedRun.isError, true, 'a caller-controlled scope list must not authorize release verification');
  assert.match(forgedRun.content[0].text, /actor and verification policy|explicit.*release.*authorization/i);
});

test('executable verification must run on the exact git snapshot supplied to the reviewer', async t => {
  const f = fixture(); t.after(() => f.workflow.close());
  const gate = { id: 'tests', command: '$node', args: ['-e', 'process.stdout.write("checks passed")'], adapter: 'exit-code', scope: 'development' };
  f.workflow.createTask(f.task('source-binding', 'repo', { gates: [gate], verificationPolicy: { mode: 'objective' } }));
  const other = join(f.root, 'other-source'); mkdirSync(other);
  const git = (...args) => execFileSync('git', args, { cwd: other, encoding: 'utf8', windowsHide: true }).trim();
  git('init'); git('config', 'user.email', 'workflow-test@example.invalid'); git('config', 'user.name', 'Workflow test');
  writeFileSync(join(other, 'source.txt'), 'different source bytes\n'); git('add', '.'); git('commit', '-m', 'Different reviewed source');
  const archive = execFileSync('git', ['-C', other, 'archive', '--format=tar', 'HEAD'], { windowsHide: true });
  const mismatch = f.workflow.artifacts.put(archive);
  f.workflow.claim('source-binding', 'builder');
  const candidate = f.workflow.submit('source-binding', 'builder', f.submission('source-mismatch', { artifacts: [{ ...mismatch, name: 'source.tar', kind: 'git-archive' }] }));
  f.workflow.review(candidate.id, 'reviewer', { accepted: true, findings: [], rationale: 'The submitted artifact looks acceptable.' });
  await assert.rejects(runVerification(f.workflow, { runId: 'source-mismatch-run', candidateId: candidate.id, gateId: 'tests', cwd: f.cwd }), /snapshot does not match/i);
  assert.equal(f.workflow.getTask('source-binding').status, 'verification');
});

test('gate cannot pass by reading an ignored file omitted from the reviewed git snapshot', async t => {
  const f = fixture({ ignoredGateInput: true }); t.after(() => f.workflow.close());
  const tracked = execFileSync('git', ['-C', f.cwd, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  assert.doesNotMatch(tracked, /(^|\n)check\.mjs(?:\n|$)/);
  const gate = { id: 'ignored-check', command: '$node', args: ['check.mjs'], adapter: 'exit-code', scope: 'development' };
  f.workflow.createTask(f.task('ignored-source', 'repo', { gates: [gate], verificationPolicy: { mode: 'objective' } }));
  f.workflow.claim('ignored-source', 'builder');
  const candidate = f.workflow.submit('ignored-source', 'builder', f.submission('ignored-candidate'));
  f.workflow.review(candidate.id, 'reviewer', { accepted: true, findings: [], rationale: 'Reviewed the frozen archive.' });
  const run = await runVerification(f.workflow, { runId: 'ignored-check-run', candidateId: candidate.id, gateId: gate.id, cwd: f.cwd });
  assert.equal(run.result.outcome, 'failed', 'the gate input is absent from the reviewed archive and must not run from the mutable checkout');
  assert.notEqual(f.workflow.getTask('ignored-source').status, 'accepted');
});

test('unknown verifier result can be reconciled authoritatively and then safely revised', t => {
  const f = fixture(); t.after(() => f.workflow.close());
  const gate = { id: 'tests', command: '$node', args: ['-e', 'process.stdout.write("checks passed")'], adapter: 'exit-code', scope: 'development' };
  f.workflow.createTask(f.task('unknown-recovery', 'repo', { gates: [gate], verificationPolicy: { mode: 'objective' } }));
  f.workflow.claim('unknown-recovery', 'builder');
  const candidate = f.workflow.submit('unknown-recovery', 'builder', f.submission('unknown-candidate'));
  f.workflow.review(candidate.id, 'reviewer', { accepted: true, findings: [], rationale: 'Semantic requirements are covered.' });
  const diagnosticsRef = f.workflow.artifacts.putJSON({ stdout: '', stderr: '', exitCode: null }).ref;
  const unknown = { runId: 'unknown-run', candidateRef: candidate.manifestRef, gateDigest: contentDigest(gate),
    environment: { platform: 'test' }, outcome: 'unknown', diagnosticsRef };
  f.workflow.recordVerification(candidate.id, gate.id, unknown);
  assert.equal(f.workflow.getTask('unknown-recovery').status, 'verification');
  const reconciled = f.workflow.recordVerification(candidate.id, gate.id, { ...unknown, outcome: 'failed', reason: 'Durable receipt confirms a nonzero exit.' });
  assert.equal(reconciled.status, 'revision_required');
  const event = f.workflow.events({ after: 0, limit: 500 }).events.find(value => value.type === 'verification_reconciled');
  assert.ok(event);
  assert.deepEqual(f.workflow.artifacts.getJSON(event.body.previousRef), unknown);
  assert.equal(f.workflow.revise('unknown-recovery', 'builder').status, 'ready');
});
