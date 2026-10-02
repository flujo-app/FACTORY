import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { FactoryControl, digest } from '../src/control.mjs';
import { executeEffect } from '../src/gateway.mjs';
import { executeOwnedRetirement } from '../src/retirement.mjs';
import { createManagedCloudAdapter } from '../src/adapters/managed-cloud.mjs';

export const PILOT_LIMITS = Object.freeze({ budgetCents: 10_000, maxWorkers: 2, maxDepth: 2,
  durationMs: 900_000, callMs: 180_000, cleanupMs: 300_000 });
export const NORMALIZATION_CASES = Object.freeze([
  [' READY ', 'ready'], ['', ''], ['MiXeD', 'mixed'], [null, 'unknown'], [42, 'unknown'], [false, 'unknown'],
]);
const WORKSPACE = 'factory-pilot', FLOW = 'factory-pilot-flow', MODEL = 'factory-pilot-model';
const TUPLE = { name: 'gpt-6-astra', provider: 'codex', adapter: 'codex-cli' };
const SPEC = 'normalizeCheckpoint(value): trim and lowercase string values; return "unknown" for every non-string value. Never coerce non-strings.';
const PICK = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = async filename => { try { await stat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const privateJson = async (filename, value, { exclusive = false } = {}) => {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) return writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
  const temporary = `${filename}.next`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, filename);
};

function optionsFor(input) {
  if (!input || typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.runId)) throw new Error('A stable runId is required.');
  if (typeof input.modulePath !== 'string' || !path.isAbsolute(input.modulePath)) throw new Error('An absolute ManagedCloud module path is required.');
  if (typeof input.source !== 'string') throw new Error('An explicit loopback source is required.');
  const url = new URL(input.source);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('A plain loopback HTTP source is required.');
  if (typeof input.outputDirectory !== 'string' || !path.isAbsolute(input.outputDirectory)) throw new Error('An absolute outputDirectory is required.');
  const prefix = `ff-${hash(input.runId).slice(0, 12)}`;
  return { ...input, source: url.origin, org: 'personal', workspace: WORKSPACE, flowId: FLOW,
    outputDirectory: path.resolve(input.outputDirectory), apps: { parent: `${prefix}-parent`, child: `${prefix}-child` } };
}

async function contextFor(options, dependencies, deadline) {
  let managed = dependencies.managed, protectDirectory = dependencies.protectDirectory;
  let fetchImpl = dependencies.fetchImpl ?? fetch;
  if (!managed) {
    const lib = path.dirname(options.modulePath);
    const [{ ManagedCloud }, { createFlyRunner }, privateFiles] = await Promise.all([
      import(pathToFileURL(options.modulePath).href), import(pathToFileURL(path.join(lib, 'process.mjs')).href),
      import(pathToFileURL(path.join(lib, 'private-files.mjs')).href),
    ]);
    const clock = dependencies.clock ?? Date.now;
    const remaining = () => Math.max(1, deadline.value - clock());
    const baseFetch = fetchImpl;
    fetchImpl = (url, init = {}) => baseFetch(url, { ...init, signal: AbortSignal.any([
      ...(init.signal ? [init.signal] : []), AbortSignal.timeout(remaining()),
    ]) });
    const conventional = path.join(os.homedir(), '.fly', 'bin', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
    const binary = process.env.FLYCTL_PATH ?? (await exists(conventional) ? conventional : 'flyctl');
    const native = createFlyRunner({ binary, env: process.env });
    const fly = { ...native, run: (args, input = {}) => native.run(args,
      { ...input, timeoutMs: Math.min(input.timeoutMs ?? 300_000, remaining()) }) };
    managed = new ManagedCloud({ directory: path.join(options.outputDirectory, 'managed-cloud'),
      fetchImpl, fly, progress: () => {} });
    protectDirectory = privateFiles.ensurePrivateDirectory;
  }
  protectDirectory ??= directory => mkdir(directory, { recursive: true, mode: 0o700 });
  const adapter = await createManagedCloudAdapter({ service: managed });
  return { managed, adapter, protectDirectory, fetchImpl };
}

async function sourceEvidence(context, options) {
  const source = await context.managed.source({ source: options.source });
  const relative = path.relative(path.join(source.dataRoot, 'workspaces'), options.outputDirectory);
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('Pilot evidence must remain outside source workspace storage.');
  const inventory = await context.managed.workspaces({ source: options.source });
  const read = async endpoint => {
    const url = new URL(endpoint, source.source); url.searchParams.set('workspace', inventory.defaultWorkspace);
    return context.managed.json(url, { token: source.token, workspace: inventory.defaultWorkspace, label: 'Pilot source metadata' });
  };
  const [models, flows, snapshot] = await Promise.all([read('/api/model'), read('/api/flow'), read('/api/snapshot/info')]);
  if (!Array.isArray(models) || !Array.isArray(flows)) throw new Error('Invalid source inventories.');
  const defaultFlow = flows.find(flow => flow.id === 'default-agent-flujo');
  const binding = defaultFlow?.nodes?.find(node => node.type === 'process' && typeof node.data?.properties?.boundModel === 'string')?.data.properties.boundModel;
  const model = models.find(item => item.id === binding);
  if (!model || Object.keys(TUPLE).some(key => model[key] !== TUPLE[key])) throw new Error('The owner-configured default model does not match the approved work-model tuple.');
  const image = await context.managed.resolveImage({ source: snapshot.workerCompatibility, fetchImpl: context.managed.fetch });
  if (image.mode !== 'official' || image.compatibility !== 'verified') throw new Error('A verified official worker image is required.');
  return { source, evidence: {
    source: { origin: source.source, instanceId: source.instanceId, appRoot: source.appRoot, dataRoot: source.dataRoot },
    sourceModel: PICK(model, ['id', 'name', 'provider', 'adapter']),
    compatibility: PICK(snapshot.workerCompatibility, ['applicationVersion', 'snapshotFormatVersion', 'layoutVersion', 'workerProtocolVersion', 'revision']),
    image: PICK(image, ['image', 'mode', 'compatibility', 'applicationVersion', 'revision', 'selectedTag']),
    fixtureAlreadyExists: inventory.workspaces.some(item => item.name === WORKSPACE),
  } };
}

export async function prepareCloudPilot(input, dependencies = {}) {
  const options = optionsFor(input), clock = dependencies.clock ?? Date.now;
  const context = await contextFor(options, dependencies, { value: clock() + PILOT_LIMITS.durationMs });
  const { evidence } = await sourceEvidence(context, options);
  return { mode: 'prepare-read-only', runId: options.runId, ...evidence, apps: options.apps,
    limits: PILOT_LIMITS, executionRequiresFlag: '--execute',
    spendingEnforcement: 'Delegated budget accounting only; provider/infrastructure charges are not metered or hard-capped here.',
    peerAutonomy: 'Child creation is a coordinator-mediated delegation; cloud workers do not gain native peer autonomy.' };
}

export function minimalFlow() {
  const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: type, properties } });
  const nodes = [node('start', 'start'), node('process', 'process', {
    boundModel: MODEL, promptTemplate: 'Produce only the JSON object requested by the user. Do not use tools or ask questions.',
    inputMode: 'full-history', allowQuestion: false,
  }), node('finish', 'finish')];
  const edge = (from, to) => ({ id: `${from.id}-${to.id}`, source: from.id, target: to.id,
    sourceHandle: `${from.type}-bottom`, targetHandle: `${to.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
  return { id: FLOW, name: 'FactoryPilot', nodes, edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])] };
}

function completionObject(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 1_048_576) throw new Error('Invalid bounded completion.');
  const completion = JSON.parse(body);
  if (completion.object !== 'chat.completion' || completion.status !== 'completed'
      || completion.choices?.[0]?.finish_reason !== 'stop' || typeof completion.choices[0].message?.content !== 'string') throw new Error('Completion is not terminal.');
  // Strict JSON only: no fence stripping, executable modules or tool outputs.
  return JSON.parse(completion.choices[0].message.content);
}

export function validateParentCandidate(value) {
  if (value?.schemaVersion !== 1 || value.functionName !== 'normalizeCheckpoint' || typeof value.source !== 'string' || value.source.length > 1500) throw new Error('Invalid candidate.');
  // This deliberately narrow grammar proves a pure function without executing generated code.
  const ternary = /^\s*export\s+function\s+normalizeCheckpoint\(\s*value\s*\)\s*\{\s*return\s+typeof\s+value\s*===\s*(["'])string\1\s*\?\s*value\.trim\(\)\.toLowerCase\(\)\s*:\s*(["'])unknown\2\s*;?\s*\}\s*$/;
  const guarded = /^\s*export\s+function\s+normalizeCheckpoint\(\s*value\s*\)\s*\{\s*if\s*\(\s*typeof\s+value\s*!==\s*(["'])string\1\s*\)\s*return\s+(["'])unknown\2\s*;\s*return\s+value\.trim\(\)\.toLowerCase\(\)\s*;?\s*\}\s*$/;
  if (!ternary.test(value.source) && !guarded.test(value.source)) throw new Error('Candidate is outside the approved pure-function grammar.');
  const proposal = value.childRequest;
  if (proposal?.type !== 'independent-verification' || proposal.budgetCents !== 1500 || proposal.workers !== 1 || proposal.depth !== 2
      || Object.keys(proposal).some(key => !['type', 'budgetCents', 'workers', 'depth'].includes(key))) throw new Error('Child proposal exceeds the approved boundary.');
  return { schemaVersion: 1, functionName: value.functionName, source: value.source,
    sourceSha256: hash(value.source), childRequest: PICK(proposal, ['type', 'budgetCents', 'workers', 'depth']) };
}

export function validateChildReview(value, candidate) {
  if (value?.schemaVersion !== 1 || value.accepted !== true || value.sourceSha256 !== candidate.sourceSha256
      || !Array.isArray(value.outputs) || value.outputs.length !== NORMALIZATION_CASES.length
      || value.outputs.some((output, index) => output !== NORMALIZATION_CASES[index][1])) throw new Error('Independent child review did not match the pinned acceptance cases.');
  return { schemaVersion: 1, accepted: true, sourceSha256: value.sourceSha256,
    cases: NORMALIZATION_CASES.map(([input, expected], index) => ({ input, expected, observed: value.outputs[index], passed: true })),
    method: 'Independent generated review plus local exact source grammar and static acceptance table; generated code was never executed.' };
}

async function createFixture(context, options, source, directory) {
  await privateJson(path.join(directory, 'fixture-intent.json'), { workspace: WORKSPACE, modelId: MODEL, flowId: FLOW, state: 'accepted' }, { exclusive: true });
  const post = async (endpoint, value, workspace) => {
    const url = new URL(endpoint, source.source);
    const response = await context.fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${source.token}`, 'Content-Type': 'application/json', ...(workspace ? { 'x-flujo-workspace': workspace } : {}) }, body: JSON.stringify(value) });
    if (response.status !== 201) { await response.body?.cancel().catch(() => {}); throw new Error('Fixture creation requires reconciliation.'); }
    // Do not persist or print response configurations, credentials or error bodies.
    await response.body?.cancel().catch(() => {});
  };
  await post('/api/workspaces', { name: WORKSPACE });
  await post('/api/model', { id: MODEL, ...TUPLE, displayName: 'Factory Pilot Work Model', ApiKey: '' }, WORKSPACE);
  await post('/api/flow', minimalFlow(), WORKSPACE);
  await privateJson(path.join(directory, 'fixture-created.json'), { workspace: WORKSPACE, modelId: MODEL, flowId: FLOW, modelTuple: TUPLE, noAttachments: true });
}

/** Opt-in live pilot. All cloud changes pass durable admission; unknown effects are never replayed. */
export async function runCloudPilot(input, dependencies = {}) {
  if (input?.execute !== true) return prepareCloudPilot(input, dependencies);
  const options = optionsFor(input), clock = dependencies.clock ?? Date.now;
  const startedAt = clock(), deadline = { value: startedAt + PILOT_LIMITS.durationMs };
  const context = await contextFor(options, dependencies, deadline);
  const manifestPath = path.join(options.outputDirectory, 'manifest.json');
  if (await exists(manifestPath)) return { mode: 'observe-existing', requiresReconciliation: true,
    reason: 'A durable pilot intent already exists. No resources, configuration or model calls were replayed.', manifestPath };
  const { source, evidence } = await sourceEvidence(context, options);
  if (evidence.fixtureAlreadyExists) throw new Error('An existing factory-pilot workspace must not be adopted or overwritten.');
  await context.protectDirectory(options.outputDirectory);
  await context.protectDirectory(path.join(options.outputDirectory, 'responses'));
  await context.protectDirectory(path.join(options.outputDirectory, 'managed-cloud'));
  const databasePath = path.join(options.outputDirectory, 'control.sqlite');
  if (await exists(databasePath)) throw new Error('An existing control ledger must not be adopted.');
  const manifest = { format: 'factory-cloud-pilot', version: 1, runId: options.runId, databasePath,
    managedDirectory: path.join(options.outputDirectory, 'managed-cloud'), managedModulePath: options.modulePath,
    org: 'personal', workspace: WORKSPACE, flowId: FLOW, source: evidence.source,
    startedAt, deadline: deadline.value, desiredState: 'retired', stage: 'accepted', runnerPid: process.pid,
    watcherId: 'live-watcher', heartbeatMaxAgeMs: 60_000,
    workers: [
      { cellId: 'parent-worker', worker: options.apps.parent, parentId: 'root', depth: 1 },
      { cellId: 'child-worker', worker: options.apps.child, parentId: 'parent-worker', depth: 2 },
    ] };
  await privateJson(manifestPath, manifest, { exclusive: true });
  await privateJson(path.join(options.outputDirectory, 'source-evidence.json'), evidence, { exclusive: true });
  const control = new FactoryControl(databasePath, { clock });
  const notifications = dependencies.notify ?? (() => {});
  const stage = async (name, { bestEffort = false } = {}) => {
    manifest.stage = name; manifest.observedAt = clock();
    try { await privateJson(manifestPath, manifest); }
    catch (error) { if (!bestEffort) throw error; }
    // Notifications are projections; their failure must not prevent owned retirement.
    try { notifications({ stage: name, elapsedMs: clock() - startedAt }); }
    catch (error) { if (!bestEffort) throw error; }
  };
  const remaining = () => { const value = deadline.value - clock(); if (value < 1000) throw new Error('The pilot admission deadline elapsed.'); return Math.min(PILOT_LIMITS.callMs, value); };
  const makeTask = (taskId, owner, purpose) => {
    control.createTask({ taskId, projectId: options.runId, branch: `codex/${options.runId}/${taskId}`,
      specification: { problem: purpose, acceptance: SPEC, baseline: digest(evidence), scope: 'bounded-live-cloud-pilot' } });
    return control.claimTask(taskId, owner, Math.max(1000, deadline.value - clock()));
  };
  const outcomes = [], cleanup = [];
  let timer, candidate, reviewed, passed = false, failureStage;
  try {
    control.initialize({ mission: 'Bounded live FLUJO delegated development pilot', budgetCents: 10_000, maxCells: 5, maxDepth: 2 });
    for (const [cellId, role, budgetCents, purpose] of [
      ['parent-worker', 'developer', 6000, 'Develop candidate and delegate bounded independent verification'],
      ['local-verifier', 'verifier', 0, 'Check exact source grammar and fixed acceptance table'],
      ['live-watcher', 'watcher', 0, 'Separate process observes runtime and provider state'],
    ]) { control.reserveCell({ cellId, role, budgetCents, purpose }); if (cellId !== 'parent-worker') control.enrollCell(cellId); }
    timer = setInterval(() => {
      try { for (const cell of control.status().cells.filter(cell => cell.status === 'ready' && cell.role !== 'watcher')) control.heartbeat(cell.id); } catch {}
    }, 10_000); timer.unref();
    remaining(); await stage('fixture-creation'); await createFixture(context, options, source, options.outputDirectory);
    await stage('source-preflight');
    const deploymentInput = app => ({ source: options.source, workspace: WORKSPACE, flowIds: [FLOW], org: 'personal',
      region: 'iad', app, memoryMb: 2048, volumeGb: 1, timeoutMs: remaining(), maxSnapshotBytes: 32 * 1024 * 1024,
      image: evidence.image.image });
    // Check the exact dedicated workspace and selected Flow before recording provision intent.
    await context.adapter.preflight(deploymentInput(options.apps.parent));
    const provision = async (slot, lease) => {
      const app = options.apps[slot], cellId = `${slot}-worker`;
      const request = { cellId, app, source: options.source, workspace: WORKSPACE, image: evidence.image.image };
      await stage(`provision-${slot}`);
      const result = await executeEffect(control, lease, { key: `provision-${slot}`, kind: 'provision', request },
        () => context.adapter.provision(deploymentInput(app)));
      outcomes.push({ key: result.effect.key, state: result.effect.state, receipt: result.effect.receipt });
      if (result.effect.state !== 'succeeded' || result.effect.receipt?.worker !== app || result.effect.receipt?.state !== 'ready') throw new Error('Provisioning is unconfirmed.');
      control.enrollCell(cellId);
    };
    const call = async (slot, lease, prompt) => {
      const outputPath = path.join(options.outputDirectory, 'responses', `${slot}.json`);
      const conversationId = `factory-${hash(options.runId).slice(0, 12)}-${slot}`;
      const input = { request: { model: FLOW, stream: false, metadata: { appendMessages: 'true' }, messages: [{ role: 'user', content: prompt }] }, conversationId, timeoutMs: remaining() };
      await stage(`call-${slot}`);
      const result = await executeEffect(control, lease, { key: `call-${slot}`, kind: 'flow_call',
        request: { worker: options.apps[slot], flowId: FLOW, conversationId, promptSha256: hash(prompt), timeoutMs: input.timeoutMs } },
      () => context.adapter.call(options.apps[slot], input), { outputPath });
      outcomes.push({ key: result.effect.key, state: result.effect.state, receipt: result.effect.receipt });
      if (result.effect.state !== 'succeeded') throw new Error('Flow call is unconfirmed.');
      return completionObject(await readFile(outputPath, 'utf8'));
    };
    const rootLease = makeTask('launch-parent', 'root', 'Create one explicitly owned temporary worker');
    await provision('parent', rootLease);
    const parentLease = makeTask('parent-candidate', 'parent-worker', SPEC);
    const parentValue = await call('parent', parentLease,
      `${SPEC}\nReturn strict JSON with schemaVersion:1,functionName:"normalizeCheckpoint",source: an exported function in this accepted grammar: export function normalizeCheckpoint(value) { return typeof value === "string" ? value.trim().toLowerCase() : "unknown"; }, and childRequest:{type:"independent-verification",budgetCents:1500,workers:1,depth:2}. Whitespace and quote style may vary; do not add statements. This is a proposal to the coordinator, not permission or a native cloud provisioning capability. No code fences, imports, tools or extra text.`);
    candidate = validateParentCandidate(parentValue);
    await privateJson(path.join(options.outputDirectory, 'parent-candidate.json'), candidate, { exclusive: true });
    await writeFile(path.join(options.outputDirectory, 'normalize-checkpoint.mjs'), candidate.source, { flag: 'wx', mode: 0o600 });
    await stage('validated-child-proposal');
    control.sendMessage({ sender: 'parent-worker', recipient: 'root', messageId: 'bounded-child-request',
      taskId: 'parent-candidate', attempt: parentLease.epoch, payload: candidate.childRequest });
    remaining();
    control.reserveCell({ cellId: 'child-worker', parentId: 'parent-worker', role: 'developer',
      budgetCents: candidate.childRequest.budgetCents, purpose: 'Independent verification of the pinned parent candidate' });
    await provision('child', parentLease);
    const childLease = makeTask('child-review', 'child-worker', 'Independently check the parent normalization candidate');
    const childValue = await call('child', childLease,
      `${SPEC}\nIndependently inspect this pure candidate without running tools: ${JSON.stringify(candidate.source)}\nReturn strict JSON only: {"schemaVersion":1,"accepted":true,"sourceSha256":"${candidate.sourceSha256}","outputs":[...]} . outputs must contain the results for these inputs in this exact order: ${JSON.stringify(NORMALIZATION_CASES.map(([input]) => input))}. Set accepted:false if incorrect. No further child request, code fences or extra text.`);
    reviewed = validateChildReview(childValue, candidate);
    const reviewPath = path.join(options.outputDirectory, 'child-review.json');
    await privateJson(reviewPath, reviewed, { exclusive: true });
    control.submit(parentLease, { artifactPath: path.join(options.outputDirectory, 'parent-candidate.json') });
    control.reviewTask('parent-candidate', 'local-verifier', { accepted: true, evidencePath: reviewPath });
    control.submit(childLease, { artifactPath: reviewPath });
    control.reviewTask('child-review', 'local-verifier', { accepted: true, evidencePath: reviewPath });
    passed = true; await stage('candidate-verified');
  } catch {
    failureStage = manifest.stage;
    await stage('reconciliation-required', { bestEffort: true });
  } finally {
    if (timer) clearInterval(timer);
    // Desired retirement was durable before provisioning. The dedicated gateway permits owned
    // retirement while paused without granting fresh dispatch. ManagedCloud verifies ownership.
    deadline.value = clock() + PILOT_LIMITS.cleanupMs;
    for (const slot of ['child', 'parent']) {
      let provisionEffect;
      try { provisionEffect = control.effect(`provision-${slot}`); } catch { continue; }
      if (!['accepted', 'running', 'succeeded', 'unknown'].includes(provisionEffect.state)) {
        cleanup.push({ worker: options.apps[slot], state: 'reconciliation-required' }); continue;
      }
      try {
        await stage(`retire-${slot}`, { bestEffort: true });
        let retired;
        const result = await executeOwnedRetirement(control, { key: `retire-${slot}`, app: options.apps[slot] },
          async () => { retired = await context.adapter.retire(options.apps[slot]); return retired; });
        cleanup.push({ worker: options.apps[slot], state: result.effect.state, receipt: result.effect.receipt,
          ...(typeof retired?.localOnly === 'boolean' ? { localOnly: retired.localOnly,
            retirementScope: retired.localOnly ? 'local-only' : 'managed-cloud-confirmed' } : {}) });
      } catch { cleanup.push({ worker: options.apps[slot], state: 'reconciliation-required' }); }
    }
  }
  const allRetired = cleanup.length > 0 && cleanup.every(item => item.state === 'succeeded' && item.receipt?.state === 'destroyed');
  const state = control.pause();
  const report = { schemaVersion: 1, mode: 'live-pilot', runId: options.runId, passed: passed && allRetired,
    source: evidence, outcomes, retirement: cleanup, allRecordedWorkersRetired: allRetired,
    candidateVerified: passed, ...(failureStage ? { failureStage } : {}), elapsedMs: clock() - startedAt,
    limits: PILOT_LIMITS, unresolvedEffects: state.unresolvedEffects,
    evidenceScope: 'Real cloud execution and coordinator-mediated bounded child provisioning; exact pure-function grammar and static acceptance verification.',
    limitations: ['No generated code was executed on the host.', 'Budget reservations do not meter charges or enforce a hard $100 provider cap.',
      '15-minute work deadline bounds new admission and individual HTTP/Fly commands; it is not a guaranteed global cancellation or shutdown timer. Cleanup has a separate five-minute command deadline.',
      'Retirement receipts are ManagedCloud operational evidence; a separate watcher must independently observe live provider terminal state.',
      'No native peer autonomy, cross-host takeover or synchronization is claimed.'],
    directory: options.outputDirectory };
  try {
    await privateJson(path.join(options.outputDirectory, 'report.json'), report);
    await stage(allRetired ? 'retired' : 'retirement-unconfirmed', { bestEffort: true });
  } finally { control.close(); }
  return report;
}

function parseArguments(values) {
  const map = { '--run-id': 'runId', '--output': 'outputDirectory', '--module-path': 'modulePath', '--source': 'source' };
  const options = {};
  for (let index = 0; index < values.length; index++) {
    if (values[index] === '--execute' && options.execute === undefined) { options.execute = true; continue; }
    const key = map[values[index]];
    if (!key || options[key] !== undefined || !values[index + 1] || values[index + 1].startsWith('--')) throw new Error('Invalid pilot arguments.');
    options[key] = values[++index];
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const report = await runCloudPilot(parseArguments(process.argv.slice(2)), {
      notify: value => process.stdout.write(`${JSON.stringify({ type: 'pilot-stage', ...value })}\n`),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.mode === 'live-pilot' && !report.passed || report.requiresReconciliation) process.exitCode = 2;
  } catch {
    process.stderr.write('Cloud pilot could not proceed. Preserve its private ledger and reconcile recorded attempts before retrying.\n');
    process.exitCode = 1;
  }
}
