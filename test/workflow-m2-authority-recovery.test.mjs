import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkflowClient, createWorkflowComparison, launchWorkflowComparison, summarizeWorkflowComparison } from '../src/public-sdk.mjs';
import { contentDigest } from '../src/workflows/artifacts.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';
import { agentInventory, secret } from '../src/cloud-lite/protocol.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'factory-workflow-m2-authority-'));

function sourceFixture(root) {
  const cwd = join(root, 'source'); mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  git('init'); git('config', 'user.email', 'workflow-test@example.invalid'); git('config', 'user.name', 'Workflow regression');
  writeFileSync(join(cwd, 'source.txt'), 'committed candidate input\n');
  git('add', '.'); git('commit', '-m', 'Frozen workflow candidate');
  return { repository: 'example/FACTORY', baseline: git('rev-parse', 'HEAD'), commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

test('agent cannot import verifier authority or transition a verified-v1 task', async t => {
  const root = fresh(); const source = sourceFixture(root);
  const plan = { runId: 'm2-auth-check', app: 'm2-auth-check', repository: 'example/FACTORY', goal: 'Verify workflow authority',
    machines: 1, agentsPerMachine: 3, workflow: 'verified-v1' };
  const credentials = Object.fromEntries(agentInventory(plan).map(agent => [agent.id, secret()]));
  const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(root, 'board.sqlite'), plan, credentials, operatorToken,
    auth: { accessToken: 'subscription-test', chatgptAccountId: 'test-account' }, githubToken: 'test-github', host: '127.0.0.1', port: 0 });
  t.after(() => coordinator.close());
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const operator = createWorkflowClient({ url, token: operatorToken, operator: true });
  const developer = createWorkflowClient({ url, token: credentials['m0-a1'] });
  const verifier = createWorkflowClient({ url, token: credentials['m0-a2'] });

  const taskInput = { taskId: 'authority-task', projectId: 'factory', branch: 'codex/authority', problem: 'Keep review and gate outcomes authoritative',
    acceptance: 'A verifier result must be imported by the trusted supervisor and independently reviewed', baseline: source.baseline,
    assignee: 'm0-a1', reviewerId: 'm0-a2', gates: [{ id: 'tests', command: 'node', args: ['--version'], adapter: 'exit-code', scope: 'development' }] };
  await operator.createTask(taskInput);
  await developer.call('factory_workflow', { action: 'claim', taskId: taskInput.taskId });
  const artifact = await developer.upload(Buffer.from('frozen source bundle bytes'));
  const candidate = await developer.call('factory_workflow', { action: 'submit', taskId: taskInput.taskId,
    input: { submissionId: 'authority-candidate', source, artifacts: [{ ...artifact, name: 'source', kind: 'source' }], summary: 'Frozen candidate' } });
  const task = await operator.task(taskInput.taskId);
  const diagnostics = await operator.upload(Buffer.from('runner did not return a durable receipt'));
  const unknown = { runId: 'unknown-run', candidateRef: candidate.manifestRef, gateDigest: contentDigest(task.gates[0]),
    environment: { platform: 'test' }, diagnosticsRef: diagnostics.ref, outcome: 'unknown', reason: 'Outcome requires reconciliation.' };

  const forgedImport = await fetch(`${url}/operator/workflow/verification`, { method: 'POST', headers: {
    Authorization: `Bearer ${credentials['m0-a1']}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: candidate.id, gateId: 'tests', result: unknown }) });
  assert.equal(forgedImport.status, 404, 'agent credentials cannot reach the operator-only verifier import route');
  assert.throws(() => developer.recordVerification(candidate.id, 'tests', unknown), /Operator credential required/);
  await assert.rejects(developer.call('factory_workflow', { action: 'deliver', taskId: taskInput.taskId }), /Unknown workflow|REJECTED|Board returned/);
  assert.equal((await operator.task(taskInput.taskId)).status, 'review');

  await verifier.call('factory_workflow', { action: 'review', candidateId: candidate.id,
    input: { accepted: true, findings: [], rationale: 'Candidate matches the frozen requirements.' } });
  assert.equal((await operator.task(taskInput.taskId)).status, 'verification', 'independent review alone cannot bypass a configured gate');
  await operator.recordVerification(candidate.id, 'tests', unknown);
  assert.equal((await operator.task(taskInput.taskId)).status, 'verification', 'unknown gate outcome remains held');

  await assert.rejects(operator.recordVerification(candidate.id, 'tests', { ...unknown, runId: 'different-run' }), /immutable/,
    'a reconciliation must retain the original runner identity');
  const final = await operator.task(taskInput.taskId);
  assert.equal(final.status, 'verification');
  assert.equal(final.verifications.length, 1);
  assert.equal(final.verifications[0].outcome, 'unknown');
});

test('a lost supervisor command response is surfaced as unknown and is reconciled by the same identity', async t => {
  const root = fresh();
  const plan = { runId: 'm2-command-check', app: 'm2-command-check', repository: 'example/FACTORY', goal: 'Exercise stable command recovery',
    machines: 1, agentsPerMachine: 2 };
  const credentials = Object.fromEntries(agentInventory(plan).map(agent => [agent.id, secret()]));
  const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(root, 'board.sqlite'), plan, credentials, operatorToken,
    auth: { accessToken: 'subscription-test', chatgptAccountId: 'test-account' }, githubToken: 'test-github', host: '127.0.0.1', port: 0 });
  t.after(() => coordinator.close());
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  let sends = 0;
  const interruptedTransport = async (input, init) => {
    const response = await fetch(input, init);
    sends++;
    if (sends === 1) throw new Error('Coordinator committed command; response was lost.');
    return response;
  };
  const uncertain = createWorkflowClient({ url, token: operatorToken, operator: true, fetch: interruptedTransport });
  const confirmed = createWorkflowClient({ url, token: operatorToken, operator: true });
  const command = { id: 'stable-reconcile-1', action: 'message', message: 'Review pending durable work.' };

  await assert.rejects(uncertain.command('m0-a1', command), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(sends, 1, 'public client must not blindly replay a possibly committed effect');
  const pending = await fetch(`${url}/commands`, { headers: { Authorization: `Bearer ${credentials['m0-a1']}` } }).then(response => response.json());
  assert.deepEqual(pending.commands.map(value => value.id), [command.id], 'the agent command read reconciles the committed effect');
  assert.equal(coordinator.board.db.prepare('SELECT count(*) AS n FROM cloud_lite_commands WHERE id=?').get(command.id).n, 1);

  await confirmed.command('m0-a1', command);
  assert.equal(coordinator.board.db.prepare('SELECT count(*) AS n FROM cloud_lite_commands WHERE id=?').get(command.id).n, 1,
    'an explicit same-identity retry is idempotent after reconciliation');
  const afterRetry = await fetch(`${url}/commands`, { headers: { Authorization: `Bearer ${credentials['m0-a1']}` } }).then(response => response.json());
  assert.deepEqual(afterRetry.commands.map(value => value.id), [command.id]);
});

test('filtered workflow pages advance by scanned sequence and include later arrivals without duplication', async t => {
  const root = fresh();
  const plan = { runId: 'm2-events-check', app: 'm2-events-check', repository: 'example/FACTORY', goal: 'Exercise workflow event cursors',
    machines: 1, agentsPerMachine: 3, workflow: 'verified-v1' };
  const credentials = Object.fromEntries(agentInventory(plan).map(agent => [agent.id, secret()]));
  const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(root, 'board.sqlite'), plan, credentials, operatorToken,
    auth: { accessToken: 'subscription-test', chatgptAccountId: 'test-account' }, githubToken: 'test-github', host: '127.0.0.1', port: 0 });
  t.after(() => coordinator.close());
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const operator = createWorkflowClient({ url, token: operatorToken, operator: true });
  const worker = createWorkflowClient({ url, token: credentials['m0-a1'] });
  const create = taskId => operator.createTask({ taskId, projectId: 'factory', branch: `codex/${taskId}`, problem: 'Read cursor pages',
    acceptance: 'Filtered events are returned exactly once', baseline: 'pinned-baseline', assignee: 'm0-a1', reviewerId: 'm0-a2', gates: [],
    verificationPolicy: { mode: 'review-only', reason: 'This test exercises event pagination, not a verification gate.' } });

  await create('noise-before'); await create('target-task');
  const first = await worker.events({ after: 0, limit: 1, taskId: 'target-task', actor: 'm0-a0' });
  assert.deepEqual(first.events, []);
  assert.match(first.cursor, /^wf1:/);
  assert.equal(first.sequence, 1);
  assert.equal(first.hasMore, true);

  await create('noise-arrived-during-pagination');
  const second = await worker.events({ after: first.cursor, limit: 1, taskId: 'target-task', actor: 'm0-a0' });
  assert.deepEqual(second.events.map(event => event.task), ['target-task']);
  assert.deepEqual(second.events.map(event => event.actor), ['m0-a1'], 'caller cannot spoof the event actor filter');
  assert.ok(second.through > first.through, 'new arrivals are visible on subsequent cursor pages');
  assert.equal(second.hasMore, true);

  const third = await worker.events({ after: second.cursor, limit: 1, taskId: 'target-task', actor: 'm0-a0' });
  assert.deepEqual(third.events, []);
  assert.equal(third.sequence, third.through);
  assert.equal(third.hasMore, false);
  await assert.rejects(worker.events({ after: '0' }), /integer|number|type|cursor/i);
});

test('operator can pause and resume a workflow task through the authenticated coordinator route', async t => {
  const root = fresh();
  const plan = { runId: 'm2-pause-check', app: 'm2-pause-check', repository: 'example/FACTORY', goal: 'Exercise supervisor pause',
    machines: 1, agentsPerMachine: 3, workflow: 'verified-v1' };
  const credentials = Object.fromEntries(agentInventory(plan).map(agent => [agent.id, secret()]));
  const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(root, 'board.sqlite'), plan, credentials, operatorToken,
    auth: { accessToken: 'subscription-test', chatgptAccountId: 'test-account' }, githubToken: 'test-github', host: '127.0.0.1', port: 0 });
  t.after(() => coordinator.close());
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const operator = createWorkflowClient({ url, token: operatorToken, operator: true });
  await operator.createTask({ taskId: 'pause-task', projectId: 'factory', branch: 'codex/pause-task', problem: 'Pause safely',
    acceptance: 'Operator can pause and resume', baseline: 'pinned-baseline', assignee: 'm0-a1', reviewerId: 'm0-a2', gates: [],
    verificationPolicy: { mode: 'review-only', reason: 'This test exercises operator pause controls.' } });

  const paused = await operator.call('factory_workflow', { action: 'pause', taskId: 'pause-task', paused: true });
  assert.equal(paused.paused, true);
  const resumed = await operator.call('factory_workflow', { action: 'pause', taskId: 'pause-task', paused: false });
  assert.equal(resumed.paused, false);
});

test('a committed supervisor write followed by HTTP 500 remains outcome-unknown', async t => {
  const root = fresh();
  const plan = { runId: 'm2-http500-check', app: 'm2-http500-check', repository: 'example/FACTORY', goal: 'Exercise ambiguous HTTP outcomes',
    machines: 1, agentsPerMachine: 2 };
  const credentials = Object.fromEntries(agentInventory(plan).map(agent => [agent.id, secret()]));
  const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(root, 'board.sqlite'), plan, credentials, operatorToken,
    auth: { accessToken: 'subscription-test', chatgptAccountId: 'test-account' }, githubToken: 'test-github', host: '127.0.0.1', port: 0 });
  t.after(() => coordinator.close());
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  let requests = 0;
  const postCommit500 = async (input, init) => {
    const committed = await fetch(input, init);
    requests++;
    assert.equal(committed.status, 200);
    await committed.arrayBuffer();
    return new Response(JSON.stringify({ error: 'Gateway lost the committed response.' }), {
      status: 500, headers: { 'Content-Type': 'application/json' } });
  };
  const operator = createWorkflowClient({ url, token: operatorToken, operator: true, fetch: postCommit500 });
  const command = { id: 'http500-stable-command', action: 'message', message: 'Reconcile after ambiguous HTTP status.' };

  const observed = await operator.command('m0-a1', command).then(() => null, error => error);
  assert.equal(requests, 1, 'client does not replay the command');
  assert.equal(coordinator.board.db.prepare('SELECT count(*) AS n FROM cloud_lite_commands WHERE id=?').get(command.id).n, 1,
    'the receiver committed the write before the client observed 500');
  assert.equal(observed?.code, 'OUTCOME_UNKNOWN', 'a 5xx after a potentially committed mutation must require reconciliation, not classify the write as rejected');
});

test('comparison manifest requires paired task identities and isolated per-arm repository credentials', async () => {
  const revision = 'a'.repeat(40);
  const manifest = createWorkflowComparison({ id: 'm2-paired-check', taskIds: ['original-task-A'], baseline: { revision, bundleSha256: 'b'.repeat(64) },
    improved: { revision: 'c'.repeat(40), bundleSha256: 'd'.repeat(64) }, task: { repository: 'example/FACTORY', revision,
      goal: 'Repair original task', acceptance: 'Same evaluator criteria' },
    armRepositories: { baseline: 'example/m2-baseline', improved: 'example/m2-improved' },
    model: 'gpt-6-luna', validationPolicy: 'Local only', evaluatorRevision: revision });
  assert.notEqual(manifest.isolation.repositories.baseline, manifest.isolation.repositories.improved);
  assert.notEqual(manifest.arms[0].plan.repository, manifest.arms[1].plan.repository);
  assert.equal(manifest.arms[0].plan.repositoryRevision, manifest.arms[1].plan.repositoryRevision);
  assert.throws(() => createWorkflowComparison({ id: 'm2-shared-repo', baseline: manifest.arms[0].runtime, improved: manifest.arms[1].runtime,
    task: manifest.shared.task, armRepositories: { baseline: 'example/shared', improved: 'example/shared' }, model: 'gpt-6-luna',
    validationPolicy: 'Local only', evaluatorRevision: revision }), /isolated comparison repositories/);
  await assert.rejects(launchWorkflowComparison(manifest, { directory: '/unused', bundlePaths: {}, image: 'unused',
    githubTokens: { baseline: 'same-token', improved: 'same-token' } }), /distinct credentials/);
  assert.throws(() => summarizeWorkflowComparison(manifest, [
    { arm: 'baseline', taskId: 'original-task-A', outcome: 'interrupted' },
    { arm: 'improved', taskId: 'different-task-B', outcome: 'accepted', evidenceRef: 'sha256:evidence',
      evaluatorRevision: revision, inputDigest: manifest.sharedInputDigest },
  ]), /same original tasks/);
  const report = summarizeWorkflowComparison(manifest, [
    { arm: 'baseline', taskId: 'original-task-A', outcome: 'interrupted' },
    { arm: 'improved', taskId: 'original-task-A', outcome: 'pending' },
  ]);
  assert.equal(report.results.baseline.interrupted, 1);
});

test('comparison summary rejects both arms with no assigned task outcomes', () => {
  const revision = 'e'.repeat(40);
  const manifest = createWorkflowComparison({ id: 'm2-empty-pair-check', baseline: { revision, bundleSha256: 'f'.repeat(64) },
    improved: { revision: '1'.repeat(40), bundleSha256: '2'.repeat(64) }, task: { repository: 'example/FACTORY', revision,
      goal: 'Repair original task', acceptance: 'Same evaluator criteria' },
    armRepositories: { baseline: 'example/m2-empty-baseline', improved: 'example/m2-empty-improved' },
    model: 'gpt-6-luna', validationPolicy: 'Local only', evaluatorRevision: revision });
  assert.throws(() => summarizeWorkflowComparison(manifest, []), /task|assigned|empty|incomplete/i,
    'an empty task set cannot produce a comparison summary');
});

test('workflow event cursors are opaque and bound to their stream, actor and filter', async t => {
  const root = fresh();
  const plan = { runId: 'm2-future-cursor', app: 'm2-future-cursor', repository: 'example/FACTORY', goal: 'Reject unsafe future event cursors',
    machines: 1, agentsPerMachine: 3, workflow: 'verified-v1' };
  const credentials = Object.fromEntries(agentInventory(plan).map(agent => [agent.id, secret()]));
  const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(root, 'board.sqlite'), plan, credentials, operatorToken,
    auth: { accessToken: 'subscription-test', chatgptAccountId: 'test-account' }, githubToken: 'test-github', host: '127.0.0.1', port: 0 });
  t.after(() => coordinator.close());
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const operator = createWorkflowClient({ url, token: operatorToken, operator: true });
  const worker = createWorkflowClient({ url, token: credentials['m0-a1'] });
  const verifier = createWorkflowClient({ url, token: credentials['m0-a2'] });
  const create = taskId => operator.createTask({ taskId, projectId: 'factory', branch: `codex/${taskId}`, problem: 'Keep event recovery live',
    acceptance: 'A later event remains readable', baseline: 'pinned-baseline', assignee: 'm0-a1', reviewerId: 'm0-a2', gates: [],
    verificationPolicy: { mode: 'review-only', reason: 'This test exercises event cursor validation.' } });
  await create('cursor-seed');

  const first = await worker.events({ after: 0 });
  assert.match(first.cursor, /^wf1:/, 'initial page returns the opaque stream cursor');
  await assert.rejects(worker.events({ after: 999 }), error => error.status === 400 || error.code === 'REJECTED',
    'raw positive numeric and ahead cursors are rejected');
  await assert.rejects(verifier.events({ after: first.cursor }), error => error.status === 400 || error.code === 'REJECTED',
    'a cursor bound to one actor cannot be replayed by another actor');
  await assert.rejects(worker.events({ after: first.cursor, taskId: 'different-filter' }), error => error.status === 400 || error.code === 'REJECTED',
    'a cursor bound to one filter cannot be replayed under another filter');
  await create('cursor-arrival');
  const recovered = await worker.events({ after: first.cursor });
  assert.ok(recovered.events.some(event => event.task === 'cursor-arrival'), 'valid opaque cursor still recovers later events');

  const other = await startCloudLiteCoordinator({ database: join(root, 'other-board.sqlite'), plan, credentials, operatorToken,
    auth: { accessToken: 'subscription-test', chatgptAccountId: 'test-account' }, githubToken: 'test-github', host: '127.0.0.1', port: 0 });
  t.after(() => other.close());
  const otherWorker = createWorkflowClient({ url: `http://127.0.0.1:${other.server.address().port}`, token: credentials['m0-a1'] });
  await assert.rejects(otherWorker.events({ after: first.cursor }), error => error.status === 400 || error.code === 'REJECTED',
    'a cursor from another coordinator stream is rejected even for the same actor and filter');
});
