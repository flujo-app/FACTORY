import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, lstat, open, unlink } from 'node:fs/promises';
import { FactoryControl, digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
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
const FLY_PAID_CEILING_CENTS = 1000;
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

/** The native API's same-origin guard applies to snapshot writes as well as fixture writes. */
export function sourceOriginFetch(fetchImpl, sourceOrigin) {
  return (url, init = {}) => {
    const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
    if (target.origin !== sourceOrigin) return fetchImpl(url, init);
    const headers = new Headers(init.headers ?? (url instanceof Request ? url.headers : undefined));
    headers.set('Origin', sourceOrigin);
    return fetchImpl(url, { ...init, headers });
  };
}

/** Lazy opening keeps prepare and observe-only runs from changing the paid ledger. */
export function createFlySpendingGate({ ledgerPath, reservationId, clock = Date.now }) {
  if (typeof ledgerPath !== 'string' || !path.isAbsolute(ledgerPath)) throw new Error('Execution requires an absolute shared spending-ledger path.');
  if (typeof reservationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(reservationId)) throw new Error('A stable paid reservation identity is required.');
  let ledger;
  return {
    paidAdmission() {
      ledger ??= new SpendingLedger(ledgerPath, { clock });
      ledger.initialize({ limitCents: 10000, currency: 'USD' });
      ledger.reserve({ reservationId, provider: 'fly', ceilingCents: FLY_PAID_CEILING_CENTS });
      return ledger.start(reservationId);
    },
    close() { if (ledger) { ledger.close(); ledger = undefined; } },
  };
}

async function contextFor(options, dependencies, deadline) {
  let managed = dependencies.managed, protectDirectory = dependencies.protectDirectory;
  let fetchImpl = sourceOriginFetch(dependencies.fetchImpl ?? fetch, options.source);
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
    spendingEnforcement: 'Execution requires shared USD paid-spend admission before each provision or model call; it does not establish provider metering or a provider hard cap.',
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

const fixtureModel = () => ({ id: MODEL, ...TUPLE, displayName: 'Factory Pilot Work Model', ApiKey: '' });
function noAttachments(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, field]) => {
    if (/^(?:attachments|tools|attachedTools|MCPServers|mcpServerIds|mcpAttachments)$/i.test(key)) {
      if (field !== null && field !== undefined && field !== '' && field !== false
          && !(Array.isArray(field) && field.length === 0)
          && !(typeof field === 'object' && Object.keys(field).length === 0)) return false;
    }
    return typeof field !== 'object' || noAttachments(field);
  });
}
async function fixtureInventory(context, source) {
  const read = endpoint => {
    const url = new URL(endpoint, source.source); url.searchParams.set('workspace', WORKSPACE);
    return context.managed.json(url, { token: source.token, workspace: WORKSPACE, label: 'Owned fixture inventory' });
  };
  const [models, flows] = await Promise.all([read('/api/model'), read('/api/flow')]);
  if (!Array.isArray(models) || !Array.isArray(flows) || models.length > 1 || flows.length > 1) throw new Error('Owned fixture contains unexpected configuration.');
  if (models.length && (models[0].id !== MODEL || Object.keys(TUPLE).some(key => models[0][key] !== TUPLE[key])
      || models[0].ApiKey !== '' || !noAttachments(models[0]))) throw new Error('Existing fixture model does not match the fixed empty-key tuple.');
  if (flows.length && (!noAttachments(flows[0]) || digest(PICK(flows[0], ['id', 'name', 'nodes', 'edges'])) !== digest(minimalFlow()))) throw new Error('Existing fixture Flow differs from the fixed no-attachment Flow.');
  return { missingModel: models.length === 0, missingFlow: flows.length === 0 };
}

async function createFixture(context, options, source, directory, recovery = null) {
  if (!recovery) await privateJson(path.join(directory, 'fixture-intent.json'), { workspace: WORKSPACE, modelId: MODEL, flowId: FLOW, state: 'accepted' }, { exclusive: true });
  const post = async (endpoint, value, workspace) => {
    const url = new URL(endpoint, source.source);
    const response = await context.fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${source.token}`, Origin: source.source, 'Content-Type': 'application/json', ...(workspace ? { 'x-flujo-workspace': workspace } : {}) }, body: JSON.stringify(value) });
    const tag = endpoint.slice('/api/'.length);
    await privateJson(path.join(directory, `fixture-http-${tag}${recovery ? `-resumed-${recovery.attempt}` : ''}.json`),
      { endpoint, status: response.status, runId: options.runId, sourceInstanceId: source.instanceId, workspace: WORKSPACE }, { exclusive: true });
    if (response.status !== 201) { await response.body?.cancel().catch(() => {}); throw new Error('Fixture creation requires reconciliation.'); }
    // Do not persist or print response configurations, credentials or error bodies.
    await response.body?.cancel().catch(() => {});
  };
  if (!recovery) await post('/api/workspaces', { name: WORKSPACE });
  const inventory = recovery ? recovery.inventory : { missingModel: true, missingFlow: true };
  if (inventory.missingModel) await post('/api/model', fixtureModel(), WORKSPACE);
  if (inventory.missingFlow) await post('/api/flow', minimalFlow(), WORKSPACE);
  await privateJson(path.join(directory, recovery ? `fixture-created-resumed-${recovery.attempt}.json` : 'fixture-created.json'),
    { workspace: WORKSPACE, modelId: MODEL, flowId: FLOW, modelTuple: TUPLE, noAttachments: true }, { exclusive: true });
}

async function privateBytes(filename, limit = 1024 * 1024) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw new Error('Recovery requires regular private evidence files.');
  return readFile(filename);
}
const privateRecord = async filename => JSON.parse((await privateBytes(filename, 128 * 1024)).toString('utf8'));

async function resumeOwnedFixture(context, options, fresh, deadline, clock) {
  const directory = options.outputDirectory, manifestPath = path.join(directory, 'manifest.json');
  const manifest = await privateRecord(manifestPath);
  const databasePath = path.join(directory, 'control.sqlite');
  const expectedWorkers = [
    { cellId: 'parent-worker', worker: options.apps.parent, parentId: 'root', depth: 1 },
    { cellId: 'child-worker', worker: options.apps.child, parentId: 'parent-worker', depth: 2 },
  ];
  if (manifest.format !== 'factory-cloud-pilot' || manifest.version !== 1 || manifest.runId !== options.runId
      || manifest.databasePath !== databasePath || manifest.managedDirectory !== path.join(directory, 'managed-cloud')
      || manifest.managedModulePath !== options.modulePath || manifest.org !== options.org
      || manifest.workspace !== WORKSPACE || manifest.flowId !== FLOW || manifest.desiredState !== 'retired'
      || digest(manifest.workers) !== digest(expectedWorkers) || digest(manifest.source) !== digest(fresh.evidence.source)) throw new Error('Recovery manifest does not identify the original run and source.');
  const fixtureIntent = await privateRecord(path.join(directory, 'fixture-intent.json'));
  if (digest(fixtureIntent) !== digest({ workspace: WORKSPACE, modelId: MODEL, flowId: FLOW, state: 'accepted' })) throw new Error('Original fixture intent is missing or changed.');
  const originalEvidence = await privateRecord(path.join(directory, 'source-evidence.json'));
  if (originalEvidence.fixtureAlreadyExists !== false || digest(originalEvidence.source) !== digest(fresh.evidence.source)
      || digest(originalEvidence.image) !== digest(fresh.evidence.image)
      || digest(originalEvidence.compatibility) !== digest(fresh.evidence.compatibility)
      || digest(originalEvidence.sourceModel) !== digest(fresh.evidence.sourceModel)) throw new Error('Original source evidence no longer matches the selected source and image.');
  const originalReport = await privateRecord(path.join(directory, 'report.json'));
  if (originalReport.runId !== options.runId || originalReport.passed !== false || originalReport.failureStage !== 'fixture-creation'
      || !Array.isArray(originalReport.outcomes) || originalReport.outcomes.length !== 0) throw new Error('Only an original pre-cloud fixture failure can be resumed.');
  const proofPath = path.join(directory, 'fixture-reconciliation.json');
  const proofBytes = await privateBytes(proofPath, 128 * 1024), proof = JSON.parse(proofBytes.toString('utf8'));
  if (proof.format !== 'factory-fixture-reconciliation' || proof.version !== 1 || proof.runId !== options.runId
      || proof.sourceInstanceId !== fresh.source.instanceId || proof.workspace !== WORKSPACE
      || proof.workspaceCreation?.status !== 201 || !/^[a-f0-9]{64}$/.test(proof.workspaceCreation?.sha256 ?? '')
      || proof.missingModel !== true || proof.missingFlow !== true || !fresh.evidence.fixtureAlreadyExists
      || typeof proof.workspaceCreation.responsePath !== 'string' || !path.isAbsolute(proof.workspaceCreation.responsePath)) throw new Error('An explicit original-workspace creation proof is required.');
  const relative = path.relative(directory, proof.workspaceCreation.responsePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Creation response evidence must remain inside the original private run directory.');
  const responseBytes = await privateBytes(proof.workspaceCreation.responsePath);
  const workspace = JSON.parse(responseBytes.toString('utf8')).workspace;
  if (hash(responseBytes) !== proof.workspaceCreation.sha256 || workspace?.name !== WORKSPACE
      || workspace.isDefault !== false || !Array.isArray(workspace.roots) || workspace.roots.length !== 0) throw new Error('Creation response does not prove the owned empty fixture workspace.');
  const inventory = await fixtureInventory(context, fresh.source);
  const control = new FactoryControl(databasePath, { clock });
  let lock, lockId, didResume = false;
  const lockPath = path.join(directory, 'fixture-resume.lock');
  const release = async () => {
    if (!lock) return;
    await lock.close(); lock = null;
    if ((await privateRecord(lockPath)).lockId !== lockId) throw new Error('Recovery lock identity changed.');
    await unlink(lockPath);
  };
  try {
    if (control.control().status !== 'paused' || control.status().effects.length !== 0) throw new Error('Recovery requires a paused original controller with zero effects.');
    lockId = randomUUID(); lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ runId: options.runId, lockId, runnerPid: process.pid })); await lock.sync();
    const attempt = control.db.prepare("SELECT count(*) AS count FROM events WHERE type='fixture_recovery_resumed'").get().count + 1;
    await privateJson(path.join(directory, `manifest-before-resume-${attempt}.json`), manifest, { exclusive: true });
    await privateJson(path.join(directory, `source-evidence-resumed-${attempt}.json`), fresh.evidence, { exclusive: true });
    const resumedAt = clock(); deadline.value = resumedAt + PILOT_LIMITS.durationMs;
    const priorEpoch = control.control().epoch;
    const resumed = { attempt, inventory, proofSha256: hash(proofBytes), resumedAt, release };
    await privateJson(path.join(directory, `fixture-resume-intent-${attempt}.json`),
      { runId: options.runId, sourceInstanceId: fresh.source.instanceId, proofSha256: resumed.proofSha256, priorEpoch, attempt, resumedAt }, { exclusive: true });
    control.transaction(() => {
      if (control.control().status !== 'paused' || control.db.prepare('SELECT count(*) AS count FROM effects').get().count !== 0) throw new Error('Recovery eligibility changed.');
      control.db.prepare("UPDATE control SET status='active',epoch=epoch+1 WHERE id=1").run();
      control.event('fixture_recovery_resumed', options.runId, { attempt, proofSha256: resumed.proofSha256, sourceInstanceId: fresh.source.instanceId, priorEpoch, controlEpoch: priorEpoch + 1 });
    });
    didResume = true;
    manifest.originalStartedAt ??= manifest.startedAt; manifest.originalDeadline ??= manifest.deadline;
    Object.assign(manifest, { startedAt: resumedAt, deadline: deadline.value, resumedAt, resumeAttempt: attempt, runnerPid: process.pid, stage: 'fixture-recovery-validated' });
    await privateJson(manifestPath, manifest);
    return { manifest, source: fresh.source, evidence: originalEvidence, control, ...resumed };
  } catch (error) {
    try { if (didResume && control.control().status === 'active') control.pause(); } catch {}
    control.close(); await release(); throw error;
  }
}

/** Opt-in live pilot. All cloud changes pass durable admission; unknown effects are never replayed. */
export async function runCloudPilot(input, dependencies = {}) {
  if (input?.resumeFixture === true && input?.execute !== true) throw new Error('Fixture recovery requires explicit execution.');
  if (input?.execute !== true) return prepareCloudPilot(input, dependencies);
  if (typeof dependencies.paidAdmission !== 'function') throw new Error('Execution requires a shared paidAdmission callback.');
  const options = optionsFor(input), clock = dependencies.clock ?? Date.now;
  let startedAt = clock(); const deadline = { value: startedAt + PILOT_LIMITS.durationMs };
  const context = await contextFor(options, dependencies, deadline);
  const manifestPath = path.join(options.outputDirectory, 'manifest.json');
  const manifestExists = await exists(manifestPath);
  if (manifestExists && options.resumeFixture !== true) return { mode: 'observe-existing', requiresReconciliation: true,
    reason: 'A durable pilot intent already exists. No resources, configuration or model calls were replayed.', manifestPath };
  if (options.resumeFixture === true && !manifestExists) throw new Error('Fixture recovery requires the original manifest.');
  const fresh = await sourceEvidence(context, options);
  if (fresh.evidence.fixtureAlreadyExists && options.resumeFixture !== true) throw new Error('An existing factory-pilot workspace must not be adopted or overwritten.');
  await context.protectDirectory(options.outputDirectory);
  await context.protectDirectory(path.join(options.outputDirectory, 'responses'));
  await context.protectDirectory(path.join(options.outputDirectory, 'managed-cloud'));
  const databasePath = path.join(options.outputDirectory, 'control.sqlite');
  if (options.resumeFixture !== true && await exists(databasePath)) throw new Error('An existing control ledger must not be adopted.');
  const recovery = options.resumeFixture === true ? await resumeOwnedFixture(context, options, fresh, deadline, clock) : null;
  const source = recovery?.source ?? fresh.source, evidence = recovery?.evidence ?? fresh.evidence;
  if (recovery) startedAt = recovery.resumedAt;
  const manifest = recovery?.manifest ?? { format: 'factory-cloud-pilot', version: 1, runId: options.runId, databasePath,
    managedDirectory: path.join(options.outputDirectory, 'managed-cloud'), managedModulePath: options.modulePath,
    org: 'personal', workspace: WORKSPACE, flowId: FLOW, source: evidence.source,
    startedAt, deadline: deadline.value, desiredState: 'retired', stage: 'accepted', runnerPid: process.pid,
    watcherId: 'live-watcher', heartbeatMaxAgeMs: 60_000,
    workers: [
      { cellId: 'parent-worker', worker: options.apps.parent, parentId: 'root', depth: 1 },
      { cellId: 'child-worker', worker: options.apps.child, parentId: 'parent-worker', depth: 2 },
    ] };
  if (!recovery) {
    await privateJson(manifestPath, manifest, { exclusive: true });
    await privateJson(path.join(options.outputDirectory, 'source-evidence.json'), evidence, { exclusive: true });
  }
  const control = recovery?.control ?? new FactoryControl(databasePath, { clock });
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
    remaining(); await stage('fixture-creation'); await createFixture(context, options, source, options.outputDirectory, recovery);
    if (recovery) await fixtureInventory(context, source);
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
        async () => {
          await dependencies.paidAdmission({ runId: options.runId, provider: 'fly', operation: 'provision', worker: app, ceilingCents: FLY_PAID_CEILING_CENTS });
          return context.adapter.provision(deploymentInput(app));
        });
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
      async () => {
        await dependencies.paidAdmission({ runId: options.runId, provider: 'fly', operation: 'flow_call', worker: options.apps[slot], ceilingCents: FLY_PAID_CEILING_CENTS });
        return context.adapter.call(options.apps[slot], input);
      }, { outputPath });
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
    ...(recovery ? { resumedFixture: true, resumeAttempt: recovery.attempt, reconciliationProofSha256: recovery.proofSha256 } : {}),
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
    const reportName = recovery ? recovery.attempt === 1 ? 'report-resumed.json' : `report-resumed-${recovery.attempt}.json` : 'report.json';
    await privateJson(path.join(options.outputDirectory, reportName), report, { exclusive: !!recovery });
    await stage(allRetired ? 'retired' : 'retirement-unconfirmed', { bestEffort: true });
  } finally { control.close(); if (recovery) await recovery.release(); }
  return report;
}

function parseArguments(values) {
  const map = { '--run-id': 'runId', '--output': 'outputDirectory', '--module-path': 'modulePath', '--source': 'source', '--spending-ledger': 'spendingLedger' };
  const options = {};
  for (let index = 0; index < values.length; index++) {
    if (values[index] === '--execute' && options.execute === undefined) { options.execute = true; continue; }
    if (values[index] === '--resume-fixture' && options.resumeFixture === undefined) { options.resumeFixture = true; continue; }
    const key = map[values[index]];
    if (!key || options[key] !== undefined || !values[index + 1] || values[index + 1].startsWith('--')) throw new Error('Invalid pilot arguments.');
    options[key] = values[++index];
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let paidGate;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.execute) paidGate = createFlySpendingGate({ ledgerPath: options.spendingLedger, reservationId: options.runId });
    const report = await runCloudPilot(options, {
      ...(paidGate ? { paidAdmission: paidGate.paidAdmission } : {}),
      notify: value => process.stdout.write(`${JSON.stringify({ type: 'pilot-stage', ...value })}\n`),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.mode === 'live-pilot' && !report.passed || report.requiresReconciliation) process.exitCode = 2;
  } catch {
    process.stderr.write('Cloud pilot could not proceed. Preserve its private ledger and reconcile recorded attempts before retrying.\n');
    process.exitCode = 1;
  } finally { paidGate?.close(); }
}
