import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, open, unlink, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { minimalFlow as astraFlow } from './cloud-pilot.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG_PATH = path.join(ROOT, 'modal', 'config.json');
const WORKSPACE = 'factory-pilot';
const SAFE_FIELDS = ['state', 'operation', 'appId', 'volumeId', 'volumeFsVersion', 'serveFunctionId', 'prefetchFunctionId',
  'elapsedMs', 'status', 'promptTokens', 'completionTokens', 'totalTokens', 'runningContainers', 'observedAt',
  'knownMeteredCents', 'resourceRows', 'ownedObjectCount', 'final', 'tokenStoredPrivately', 'alreadyStopped'];
const select = (value, fields = SAFE_FIELDS) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function exists(filename) { try { await lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function privateRead(filename, maxBytes = 2 * 1024 * 1024) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) fail('UNSAFE_PRIVATE_FILE');
  return readFile(filename, 'utf8');
}
async function privateJson(filename, value, exclusive = false) {
  if (exclusive) return writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, filename);
}

export class ModalJournal {
  constructor(filename, { clock = Date.now } = {}) {
    if (!path.isAbsolute(filename)) fail('ABSOLUTE_JOURNAL_REQUIRED');
    this.clock = clock;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS modal_operations(key TEXT PRIMARY KEY, operation TEXT NOT NULL,
        request_digest TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL,
        result_json TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  get(key) { const row = this.db.prepare('SELECT * FROM modal_operations WHERE key=?').get(key); return row ? { ...row, result: row.result_json ? JSON.parse(row.result_json) : null } : null; }
  list() { return this.db.prepare('SELECT key,operation,state FROM modal_operations ORDER BY created,key').all(); }
  admit(key, operation, request) {
    if (!/^[a-z0-9_-]{1,80}$/.test(key)) fail('INVALID_EFFECT_ID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get(key), hash = digest(request);
      if (previous) {
        if (previous.operation !== operation || previous.request_digest !== hash) fail('INTENT_CONFLICT');
        this.db.exec('COMMIT');
        return { fresh: false, effect: previous };
      }
      if (this.db.prepare('SELECT key FROM modal_operations WHERE operation=?').get(operation)) fail('OPERATION_ALREADY_BOUND');
      this.db.prepare('INSERT INTO modal_operations VALUES(?,?,?,?,?,NULL,?,?)').run(
        key, operation, hash, JSON.stringify(request), 'accepted', this.clock(), this.clock());
      this.db.exec('COMMIT');
      return { fresh: true, effect: this.get(key) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  running(key) {
    const result = this.db.prepare("UPDATE modal_operations SET state='running',updated=? WHERE key=? AND state='accepted'").run(this.clock(), key);
    if (result.changes !== 1) fail('INTENT_STATE');
  }
  settle(key, state, result) {
    if (!['succeeded', 'unknown'].includes(state)) fail('INTENT_STATE');
    const changed = this.db.prepare("UPDATE modal_operations SET state=?,result_json=?,updated=? WHERE key=? AND state IN ('accepted','running')").run(state, JSON.stringify(select(result)), this.clock(), key);
    if (changed.changes !== 1) fail('INTENT_STATE');
    return this.get(key);
  }
}

function optionsFor(input = {}) {
  const runId = input.runId ?? 'modal-20261002';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) fail('STABLE_RUN_ID_REQUIRED');
  const source = new URL(input.source ?? 'http://127.0.0.1:4200');
  if (source.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)
      || source.username || source.password || source.pathname !== '/' || source.search || source.hash) fail('LOOPBACK_SOURCE_REQUIRED');
  const result = { runId, source: source.origin, environment: 'main', workspace: WORKSPACE,
    runDirectory: input.runDirectory ?? path.join(ROOT, '.factory', runId),
    modulePath: input.modulePath ?? 'C:/Users/Moe/Documents/GitHub/flujo-cloud/lib/managed.mjs',
    sourceEvidencePath: input.sourceEvidencePath ?? path.join(ROOT, '.factory', 'federation-20261002', 'source-evidence.json'),
    spendingPath: input.spendingPath ?? path.join(ROOT, '.factory', 'spending.sqlite'),
    pythonPath: input.pythonPath ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    through: input.through ?? 'flow', cleanupOnly: input.cleanupOnly === true,
    reservationId: input.reservationId ?? runId, ceilingCents: 3000 };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result.reservationId)) fail('STABLE_RESERVATION_ID_REQUIRED');
  for (const key of ['runDirectory', 'modulePath', 'sourceEvidencePath', 'spendingPath', 'pythonPath']) if (!path.isAbsolute(result[key])) fail('ABSOLUTE_PATHS_REQUIRED');
  if (!['infra', 'direct', 'connect', 'flow'].includes(result.through)) fail('INVALID_STAGE');
  const prefix = `factory-${sha(runId).slice(0, 12)}`;
  return { ...result, appName: `${prefix}-model`, volumeName: `${prefix}-weights`,
    modelId: `${prefix}-model`, flowId: `${prefix}-flow`, flowName: `FactoryModal-${sha(runId).slice(0, 12)}` };
}

export function modalFlow(options) {
  const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: type, properties } });
  const nodes = [node('start', 'start'), node('process', 'process', {
    boundModel: options.modelId, promptTemplate: 'Return only the requested JSON. Use no tools or questions.',
    inputMode: 'full-history', allowQuestion: false, maxTokens: 64,
  }), node('finish', 'finish')];
  const edge = (from, to) => ({ id: `${from.id}-${to.id}`, source: from.id, target: to.id,
    sourceHandle: `${from.type}-bottom`, targetHandle: `${to.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
  return { id: options.flowId, name: options.flowName, nodes, edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])] };
}

function fixtureModel(options, config, endpoint, bearer) {
  return { id: options.modelId, name: config.servedModel, displayName: 'Factory Modal Coder',
    provider: 'openai', adapter: 'openai', ApiKey: bearer, baseUrl: `${new URL(endpoint).origin}/v1`,
    contextWindow: config.maxModelLength, maxTokens: config.maxOutputTokens, supportsTools: false,
    inputModalities: ['text'], outputModalities: ['text'] };
}
const modelProjection = value => select(value, ['id', 'name', 'displayName', 'provider', 'adapter', 'baseUrl',
  'contextWindow', 'maxTokens', 'supportsTools', 'inputModalities', 'outputModalities']);

function noAttachments(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, field]) => {
    if (/^(attachments|tools|attachedTools|MCPServers|mcpServerIds|mcpAttachments)$/i.test(key)) {
      if (field && !(Array.isArray(field) && !field.length) && !(typeof field === 'object' && !Object.keys(field).length)) return false;
    }
    return typeof field !== 'object' || noAttachments(field);
  });
}

async function contextFor(options, dependencies) {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  let managed = dependencies.managed, privateFiles = dependencies.privateFiles;
  if (!managed || !privateFiles) {
    const directory = path.dirname(options.modulePath);
    const loaded = await import(pathToFileURL(options.modulePath).href);
    privateFiles ??= await import(pathToFileURL(path.join(directory, 'private-files.mjs')).href);
    managed ??= new loaded.ManagedCloud({ progress: () => {} });
  }
  return { config, managed, privateFiles, fetchImpl: dependencies.fetchImpl ?? fetch,
    clock: dependencies.clock ?? Date.now, driver: dependencies.driver ?? pythonDriver(options, config) };
}

export function modalBridgeTimeoutMs(operation, config) {
  if (operation === 'prefetch') {
    const download = config?.prefetchTimeoutSeconds, margin = config?.startupTimeoutSeconds;
    if (!Number.isSafeInteger(download) || download < 60 || download > 3600
        || !Number.isSafeInteger(margin) || margin < 1 || margin > 1200) fail('INVALID_PREFETCH_RUNTIME_BOUNDS');
    return (download + margin) * 1000;
  }
  return operation === 'deploy' ? 1_800_000 : 180_000;
}

function pythonDriver(options, config) {
  return async payload => {
    const timeoutMs = modalBridgeTimeoutMs(payload.operation, config);
    const mutating = !['prepare', 'inspect', 'meter', 'reconcile-stop-app'].includes(payload.operation);
    const args = ['-B', path.join(ROOT, 'modal', 'run_pilot.py'), ...(mutating ? ['--execute'] : [])];
    return new Promise((resolve, reject) => {
      const childEnvironment = { ...process.env };
      for (const name of ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'MODAL_SERVER_URL']) delete childEnvironment[name];
      const child = spawn(options.pythonPath, args, { windowsHide: true, env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', oversized = false;
      const timer = setTimeout(() => child.kill(), timeoutMs);
      const capture = target => data => {
        if ((stdout.length + stderr.length + data.length) > 4 * 1024 * 1024) { oversized = true; child.kill(); return; }
        if (target === 'stdout') stdout += data; else stderr += data;
      };
      child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
      child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('SDK_BRIDGE_UNKNOWN'), { code: 'SDK_BRIDGE_UNKNOWN' })); });
      child.on('close', async code => {
        clearTimeout(timer);
        try {
          if (payload.operation !== 'prepare') {
            await writeFile(path.join(options.runDirectory, `bridge-${payload.effectKey ?? payload.operation}-${randomUUID()}.stdout.private.txt`), stdout, { flag: 'wx', mode: 0o600 });
            await writeFile(path.join(options.runDirectory, `bridge-${payload.effectKey ?? payload.operation}-${randomUUID()}.stderr.private.txt`), stderr, { flag: 'wx', mode: 0o600 });
          }
          const result = JSON.parse(stdout.trim());
          if (code !== 0 || oversized || result.state === 'unknown') fail('SDK_BRIDGE_UNKNOWN');
          resolve(result);
        } catch { reject(Object.assign(new Error('SDK_BRIDGE_UNKNOWN'), { code: 'SDK_BRIDGE_UNKNOWN' })); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    });
  };
}

function identityOf(source) { return { origin: source.source, instanceId: source.instanceId, appRoot: source.appRoot, dataRoot: source.dataRoot }; }
async function sourceContext(options, context, { allowOwn = false, resources = {}, ownedFlow } = {}) {
  const evidence = JSON.parse(await privateRead(options.sourceEvidencePath));
  if (evidence.fixtureAlreadyExists !== false) fail('ORIGINAL_WORKSPACE_OWNERSHIP_REQUIRED');
  const source = await context.managed.source({ source: options.source });
  if (digest(identityOf(source)) !== digest(evidence.source)) fail('SOURCE_IDENTITY_CHANGED');
  const inventory = await context.managed.workspaces({ source: options.source });
  if (!inventory.workspaces.some(item => item.name === WORKSPACE)) fail('OWNED_WORKSPACE_REQUIRED');
  const read = endpoint => context.managed.json(new URL(endpoint, source.source), { token: source.token, workspace: WORKSPACE, label: 'Factory Modal fixture' });
  const [models, flows] = await Promise.all([read('/api/model'), read('/api/flow')]);
  if (!Array.isArray(models) || !Array.isArray(flows)) fail('INVALID_FIXTURE_INVENTORY');
  for (const model of models) {
    if (model.id === 'factory-pilot-model') {
      if (model.name !== 'gpt-6-astra' || model.provider !== 'codex' || model.adapter !== 'codex-cli' || model.ApiKey !== '' || !noAttachments(model)) fail('ORIGINAL_ASTRA_MODEL_CHANGED');
    } else if (allowOwn && model.id === options.modelId && resources.endpoint) {
      const expected = fixtureModel(options, context.config, resources.endpoint, '');
      const retired = { ...expected, displayName: 'Factory Modal Coder (retired)' };
      if (![digest(modelProjection(expected)), digest(modelProjection(retired))].includes(digest(modelProjection(model))) || !noAttachments(model)) fail('OWNED_MODAL_MODEL_CHANGED');
    } else fail('UNEXPECTED_FIXTURE_MODEL');
  }
  for (const flow of flows) {
    const expected = flow.id === 'factory-pilot-flow' ? astraFlow() : allowOwn && flow.id === options.flowId ? ownedFlow : null;
    if (!expected || digest(select(flow, ['id', 'name', 'nodes', 'edges'])) !== digest(expected) || !noAttachments(flow)) fail('FIXTURE_FLOW_CHANGED');
  }
  return { source, models, flows, identity: identityOf(source), originalModelCount: models.filter(item => item.id === 'factory-pilot-model').length,
    originalFlowCount: flows.filter(item => item.id === 'factory-pilot-flow').length };
}

export async function prepareModalPilot(input = {}, dependencies = {}) {
  const options = optionsFor(input), context = await contextFor(options, dependencies);
  if (context.config.volumeFsVersion !== 2) fail('INVALID_VOLUME_FS_VERSION');
  if (!context.config.prefetchDownload || digest(context.config.prefetchDownload) !== digest({ transport: 'http', maxWorkers: 1, hubVersion: '0.36.0' })) fail('INVALID_DOWNLOAD_PROFILE');
  modalBridgeTimeoutMs('prefetch', context.config);
  const local = await sourceContext(options, context);
  const modal = await context.driver({ operation: 'prepare', ...select(options, ['runId', 'appName', 'volumeName', 'environment']), volumeFsVersion: context.config.volumeFsVersion });
  if (modal.state !== 'prepared' || !modal.credentialsAccepted || modal.environment !== 'main' || !modal.profile || !modal.workspaceName) fail('MODAL_PROFILE_UNVERIFIED');
  return { mode: 'prepare-read-only', options, config: context.config, profile: modal.profile, workspaceName: modal.workspaceName, source: local.identity,
    originalModelCount: local.originalModelCount, originalFlowCount: local.originalFlowCount,
    appAbsent: modal.appAbsent, volumeAbsent: modal.volumeAbsent, ceilingCents: 3000,
    plannedConnection: 'Transient direct and actual FLUJO Flow smoke, then owned retirement and fixture removal.',
    enforcement: 'Shared durable reservation/admission; no App-specific provider spending cap or final meter claim.' };
}

function readWithSignal(reader, signal) {
  if (!signal) return reader.read();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

async function boundedText(response, maximum = 1024 * 1024, signal) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let bytes = 0, cancel = false;
  try {
    while (true) { const value = await readWithSignal(reader, signal); if (value.done) break; bytes += value.value.length; if (bytes > maximum) fail('OVERSIZED_PRIVATE_RESPONSE'); chunks.push(value.value); }
    signal?.throwIfAborted();
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  } catch (error) { cancel = true; throw error; }
  finally { if (cancel) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function modalResultUrl(location, original) {
  if (typeof location !== 'string' || !location) fail('INVALID_RESULT_URL');
  let result;
  try { result = new URL(location, original); } catch { fail('INVALID_RESULT_URL'); }
  if (result.protocol !== 'https:' || result.origin !== original.origin || result.pathname !== original.pathname
      || !result.search || result.username || result.password || result.href.includes('#')) fail('INVALID_RESULT_URL');
  return result;
}
export function completionEvidence(body, { flujo = false, expectedModel } = {}) {
  const value = JSON.parse(body), choice = value.choices?.[0];
  if (value.object !== 'chat.completion' || !Array.isArray(value.choices) || value.choices.length !== 1
      || choice.index !== 0 || choice.finish_reason !== 'stop' || choice.message?.role !== 'assistant'
      || typeof choice.message.content !== 'string' || typeof expectedModel !== 'string' || !expectedModel
      || value.model !== expectedModel || choice.message.function_call != null
      || (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length !== 0))
      || (flujo && value.status !== 'completed')) fail('NONTERMINAL_COMPLETION');
  const answer = JSON.parse(choice.message.content);
  if (!answer || Array.isArray(answer) || typeof answer !== 'object' || Object.keys(answer).length !== 1
      || answer.checkpoint !== 'ready') fail('SMOKE_ACCEPTANCE_FAILED');
  const tokens = value.usage ?? {};
  return { state: 'generation-completed', promptTokens: Number.isSafeInteger(tokens.prompt_tokens) ? tokens.prompt_tokens : undefined,
    completionTokens: Number.isSafeInteger(tokens.completion_tokens) ? tokens.completion_tokens : undefined,
    totalTokens: Number.isSafeInteger(tokens.total_tokens) ? tokens.total_tokens : undefined };
}

export async function runModalPilot(input = {}, dependencies = {}) {
  const options = optionsFor(input), context = await contextFor(options, dependencies);
  await context.privateFiles.ensurePrivateDirectory(path.dirname(options.runDirectory));
  await context.privateFiles.ensurePrivateDirectory(options.runDirectory);
  const lockPath = path.join(options.runDirectory, 'modal-pilot.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => fail('RUN_LOCKED'));
  let journal, spending, ownsSpending = false, startedAt = context.clock(), failure = null, prepared, source, finalReport;
  let runVolumeFsVersion = context.config.volumeFsVersion;
  let runDownloadProfile = context.config.prefetchDownload === undefined ? undefined : Object.freeze({ ...context.config.prefetchDownload });
  let runFlow = modalFlow(options);
  const attemptId = randomUUID();
  const events = [], cleanup = [], privateEvents = path.join(options.runDirectory, 'events.private.jsonl');
  const notify = async (operation, result = {}) => {
    const event = { operation, ...select(result), observedAt: context.clock() };
    events.push(event);
    await writeFile(privateEvents, `${JSON.stringify(event)}\n`, { flag: 'a', mode: 0o600 }).catch(() => {});
    try { dependencies.notify?.(event); } catch { /* Reporting must not block owned teardown. */ }
  };
  const resources = async () => await exists(path.join(options.runDirectory, 'resources.private.json'))
    ? JSON.parse(await privateRead(path.join(options.runDirectory, 'resources.private.json'))) : {};
  const requestFor = operation => ({ operation, runId: options.runId, appName: options.appName, volumeName: options.volumeName,
    environment: options.environment, profile: prepared.profile, workspaceName: prepared.workspaceName, runDirectory: options.runDirectory,
    ...(runVolumeFsVersion === undefined ? {} : { volumeFsVersion: runVolumeFsVersion }),
    ...(['deploy', 'prefetch'].includes(operation) && runDownloadProfile !== undefined ? { prefetchDownload: runDownloadProfile } : {}) });
  const perform = async (key, operation, operationRequest, action, { paid = false } = {}) => {
    const request = { ...requestFor(operation), ...operationRequest };
    const admission = journal.admit(key, operation, request);
    if (!admission.fresh) { if (admission.effect.state === 'succeeded') return admission.effect.result; fail('OPERATION_REQUIRES_RECONCILIATION'); }
    try {
      if (paid) spending.start(options.reservationId);
      journal.running(key);
      await notify(operation, { state: 'running' });
      const result = await action(request, key);
      const effect = journal.settle(key, 'succeeded', result);
      await notify(operation, effect.result);
      return result;
    } catch {
      if (['accepted', 'running'].includes(journal.get(key)?.state)) journal.settle(key, 'unknown', { state: 'unknown' });
      await notify(operation, { state: 'unknown' }).catch(() => {});
      fail('OPERATION_REQUIRES_RECONCILIATION');
    }
  };
  const sdk = (key, operation, paid = false) => perform(key, operation, {}, (request, effectKey) => context.driver({ ...request, request,
    effectKey, journalPath: path.join(options.runDirectory, 'modal.sqlite') }), { paid });
  const reconcileOwnedStop = async () => {
    const original = journal.get('stop-app'), owned = await resources();
    if (!original || original.operation !== 'stop-app' || !owned.appDeployed || !owned.appId) return;
    const repairingCheckpoint = original.state === 'succeeded' && original.result?.reconciled === true && !owned.appStopped;
    if (original.state !== 'unknown' && !repairingCheckpoint) return;
    const request = requestFor('stop-app');
    if (original.request_digest !== digest(request) || digest(JSON.parse(original.request_json)) !== original.request_digest
        || !['runId', 'appName', 'volumeName', 'environment', 'profile', 'workspaceName'].every(key => owned[key] === request[key])) fail('STOP_RECONCILIATION_OWNERSHIP_CONFLICT');
    const observed = await context.driver({ ...requestFor('reconcile-stop-app'), originalKey: original.key,
      originalRequestDigest: original.request_digest, recordedAppId: owned.appId, recordedVolumeId: owned.volumeId });
    if (observed.state !== 'stopped' || observed.runningContainers !== 0 || observed.appId !== owned.appId
        || observed.volumeId !== owned.volumeId || observed.originalKey !== original.key
        || observed.originalRequestDigest !== original.request_digest || !Number.isSafeInteger(observed.observedAt)
        || !['runId', 'appName', 'volumeName', 'environment', 'profile', 'workspaceName'].every(key => observed[key] === request[key])) fail('STOP_RECONCILIATION_PROOF_REJECTED');
    const proof = { format: 'factory-modal-owned-stop-reconciliation', version: 1,
      originalKey: original.key, originalRequestDigest: original.request_digest, originalState: original.state,
      observed, purpose: repairingCheckpoint ? 'repair-confirmed-local-checkpoint' : 'settle-original-unknown-stop' };
    const proofPath = path.join(options.runDirectory, `stop-reconciliation-${randomUUID()}.private.json`);
    const proofHandle = await open(proofPath, 'wx', 0o600);
    try {
      await proofHandle.writeFile(`${JSON.stringify(proof, null, 2)}\n`);
      await proofHandle.sync();
    } finally { await proofHandle.close(); }
    const proofDigest = digest(proof);
    journal.db.exec('BEGIN IMMEDIATE');
    try {
      const current = journal.get(original.key);
      if (current?.operation !== 'stop-app' || current.request_digest !== original.request_digest || current.state !== original.state) fail('STOP_RECONCILIATION_RACE');
      if (!repairingCheckpoint) {
        const settled = { ...select(observed), reconciled: true, reconciliationProofDigest: proofDigest,
          reconciliationProofFile: path.basename(proofPath) };
        const changed = journal.db.prepare("UPDATE modal_operations SET state='succeeded',result_json=?,updated=? WHERE key=? AND operation='stop-app' AND request_digest=? AND state='unknown'")
          .run(JSON.stringify(settled), context.clock(), original.key, original.request_digest);
        if (changed.changes !== 1) fail('STOP_RECONCILIATION_RACE');
      }
      journal.db.exec('COMMIT');
    } catch (error) { journal.db.exec('ROLLBACK'); throw error; }
    await privateJson(path.join(options.runDirectory, 'resources.private.json'), { ...owned, appStopped: true });
    await notify('reconcile-stop-app', observed);
  };
  const sourceRequest = async (method, endpoint, body, responseName) => {
    // Recheck the registered instance immediately before each local mutation/call.
    const current = await context.managed.source({ source: options.source });
    if (digest(identityOf(current)) !== digest(prepared.source)) fail('SOURCE_IDENTITY_CHANGED');
    const response = await context.fetchImpl(new URL(endpoint, current.source), { method, redirect: 'manual',
      signal: AbortSignal.timeout(endpoint === '/v1/chat/completions' ? 180_000 : 30_000),
      headers: { Authorization: `Bearer ${current.token}`, Origin: current.source, 'x-flujo-workspace': WORKSPACE,
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const projection = endpoint === '/api/model' || endpoint.startsWith('/api/model/') ? modelProjection(body) : body;
    await privateJson(path.join(options.runDirectory, `${responseName}.http.private.json`), {
      method, endpoint, status: response.status, source: identityOf(current), resourceId: body?.id,
      ...(body ? { bodyDigest: digest(projection) } : {}), observedAt: context.clock(),
    }, true);
    const raw = await boundedText(response);
    await writeFile(path.join(options.runDirectory, responseName), raw, { flag: 'wx', mode: 0o600 });
    if (![200, 201, 204].includes(response.status)) fail('LOCAL_HTTP_REQUIRES_RECONCILIATION');
    return { status: response.status, raw };
  };
  try {
    const manifestPath = path.join(options.runDirectory, 'manifest.private.json');
    if (options.cleanupOnly) {
      const manifest = JSON.parse(await privateRead(manifestPath));
      runVolumeFsVersion = manifest.volumeFsVersion;
      runDownloadProfile = manifest.prefetchDownload;
      if (runVolumeFsVersion !== undefined && ![1, 2].includes(runVolumeFsVersion)) fail('CLEANUP_OWNERSHIP_CONFLICT');
      const originalOptions = { ...manifest.options, cleanupOnly: true, through: options.through };
      if (manifest.format !== 'factory-modal-pilot' || manifest.runId !== options.runId
          || digest(originalOptions) !== digest(options) || manifest.desiredState !== 'retired') fail('CLEANUP_OWNERSHIP_CONFLICT');
      prepared = { profile: manifest.profile, workspaceName: manifest.workspaceName, source: manifest.source };
      const authored = await privateRead(path.join(options.runDirectory, 'redeployable-fixture.private.json')).then(JSON.parse).catch(() => null);
      // Damaged local Flow evidence fences its fixture cleanup, while exact
      // recorded provider retirement remains independent and available.
      runFlow = authored?.flow?.id === options.flowId && authored.flow.name === options.flowName ? authored.flow : null;
      const current = await context.managed.source({ source: options.source });
      if (digest(identityOf(current)) !== digest(prepared.source)) fail('SOURCE_IDENTITY_CHANGED');
      source = current; startedAt = manifest.startedAt;
      journal = new ModalJournal(path.join(options.runDirectory, 'modal.sqlite'), { clock: context.clock });
      spending = dependencies.spending ?? new SpendingLedger(options.spendingPath, { clock: context.clock });
      ownsSpending = !dependencies.spending;
      await reconcileOwnedStop();
      failure = 'CLEANUP_ONLY_ORIGINAL_WORK_RESULTS_PRESERVED';
      fail('CLEANUP_ONLY_ORIGINAL_WORK_RESULTS_PRESERVED');
    }
    if (await exists(manifestPath)) fail('EXISTING_RUN_REQUIRES_CLEANUP_OR_RECONCILIATION');
    prepared = await prepareModalPilot(options, { ...dependencies, ...context });
    if (!prepared.appAbsent || !prepared.volumeAbsent) fail('RESOURCE_IDENTITY_ALREADY_EXISTS');
    source = (await sourceContext(options, context)).source;
    await privateJson(manifestPath, { format: 'factory-modal-pilot', version: 1, runId: options.runId,
      startedAt, options, volumeFsVersion: runVolumeFsVersion, prefetchDownload: runDownloadProfile, profile: prepared.profile, workspaceName: prepared.workspaceName, source: prepared.source, desiredState: 'retired',
      model: select(context.config, ['model', 'revision', 'servedModel', 'license']), state: 'admitted' }, true);
    await privateJson(path.join(options.runDirectory, 'redeployable-fixture.private.json'), {
      model: { ...fixtureModel(options, context.config, 'https://replace-with-owned-endpoint.modal.run', ''), displayName: 'Factory Modal Coder (retired)' },
      flow: runFlow, state: 'not-active', credentialSource: 'new-run-owned-private-proxy-token',
    }, true);
    journal = new ModalJournal(path.join(options.runDirectory, 'modal.sqlite'), { clock: context.clock });
    spending = dependencies.spending ?? new SpendingLedger(options.spendingPath, { clock: context.clock });
    ownsSpending = !dependencies.spending;
    if (!spending.db || !spending.db.prepare('SELECT id FROM spending_policy WHERE id=1').get()) spending.initialize({ limitCents: 10000, currency: 'USD' });
    spending.reserve({ reservationId: options.reservationId, provider: 'modal', ceilingCents: 3000 });
    await sdk('create-volume', 'create-volume', true);
    await sdk('deploy', 'deploy', true);
    await sdk('prefetch', 'prefetch', true);
    await sdk('create-proxy-token', 'create-proxy-token');
    const owned = await resources();
    const endpoint = new URL(owned.endpoint);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.modal.run') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('UNEXPECTED_ENDPOINT');
    const token = JSON.parse(await privateRead(path.join(options.runDirectory, 'proxy-token.private.json')));
    if (token.runId !== options.runId || token.profile !== prepared.profile || !/^wk-[^.]+\.ws-.+$/.test(token.bearer)) fail('PRIVATE_PROXY_TOKEN_MISMATCH');
    const prompt = 'Return exactly this JSON object and nothing else: {"checkpoint":"ready"}';
    if (options.through !== 'infra') {
      await perform('direct-generation', 'direct-generation', { endpointHash: sha(endpoint.origin), maxTokens: 64, model: context.config.servedModel,
        deadlineMs: 600_000, resultGetLimit: 3 }, async (request, effectKey) => {
        const began = context.clock();
        const originalUrl = new URL('/v1/chat/completions', endpoint), signal = AbortSignal.timeout(request.deadlineMs);
        const binding = { format: 'factory-modal-direct-http', version: 1, effectKey, requestDigest: digest(request),
          ownedEndpoint: endpoint.href, originalUrl: originalUrl.href, appId: owned.appId };
        let target = originalUrl;
        for (let hop = 0; ; hop += 1) {
          signal.throwIfAborted();
          const method = hop === 0 ? 'POST' : 'GET';
          const response = await context.fetchImpl(target, { method, redirect: 'manual', signal,
            headers: { Authorization: `Bearer ${token.bearer}`, ...(hop === 0 ? { 'Content-Type': 'application/json' } : {}) },
            ...(hop === 0 ? { body: JSON.stringify({ model: context.config.servedModel, messages: [{ role: 'user', content: prompt }],
              max_tokens: 64, temperature: 0, stream: false }) } : {}) });
          const location = response.headers.get('location');
          const receipt = { ...binding, hop, method, requestedUrl: target.href, status: response.status,
            ...(location === null ? {} : { location }), observedAt: context.clock() };
          await privateJson(path.join(options.runDirectory, `direct-http-${hop}.private.json`), receipt, true);
          if (hop === 0 && response.status === 303 && location !== null) {
            await privateJson(path.join(options.runDirectory, 'direct-result-url.private.json'),
              { ...receipt, state: 'original-post-not-replayed' }, true);
          }
          const raw = await boundedText(response, 1024 * 1024, signal);
          await writeFile(path.join(options.runDirectory, `direct-http-${hop}.body.private.txt`), raw, { flag: 'wx', mode: 0o600 });
          if (response.status === 200) {
            await writeFile(path.join(options.runDirectory, 'direct-response.private.json'), raw, { flag: 'wx', mode: 0o600 });
            signal.throwIfAborted();
            return { ...completionEvidence(raw, { expectedModel: context.config.servedModel }), elapsedMs: context.clock() - began, status: 200 };
          }
          if (response.status !== 303 || hop >= request.resultGetLimit) fail('DIRECT_HTTP_REQUIRES_RECONCILIATION');
          target = modalResultUrl(location, originalUrl);
        }
      }, { paid: true });
    }
    if (['connect', 'flow'].includes(options.through)) {
      await sourceContext(options, context);
      const model = fixtureModel(options, context.config, endpoint.origin, token.bearer), flow = runFlow;
      await perform('create-flujo-model', 'create-flujo-model', { modelDigest: digest(modelProjection(model)), workspace: WORKSPACE }, async () => {
        const response = await sourceRequest('POST', '/api/model', model, 'create-model-response.private.json');
        if (response.status !== 201) fail('MODEL_CREATION_UNCONFIRMED');
        await (dependencies.writeFixtureOwnership ?? privateJson)(path.join(options.runDirectory, 'fixture-ownership.private.json'), { modelCreated: true, modelId: options.modelId, flowId: options.flowId,
          modelDigest: digest(modelProjection(model)), flowDigest: digest(flow), source: prepared.source }, true);
        return { state: 'model-connected', status: response.status };
      });
      await perform('create-flujo-flow', 'create-flujo-flow', { flowDigest: digest(flow), workspace: WORKSPACE }, async () => {
        const response = await sourceRequest('POST', '/api/flow', flow, 'create-flow-response.private.json');
        if (response.status !== 201) fail('FLOW_CREATION_UNCONFIRMED');
        const fixture = JSON.parse(await privateRead(path.join(options.runDirectory, 'fixture-ownership.private.json')));
        await (dependencies.writeFixtureOwnership ?? privateJson)(path.join(options.runDirectory, 'fixture-ownership.private.json'), { ...fixture, flowCreated: true });
        return { state: 'flow-connected', status: response.status };
      });
      await sourceContext(options, context, { allowOwn: true, resources: owned, ownedFlow: flow });
      if (options.through === 'flow') {
        await perform('flujo-generation', 'flujo-generation', { flowId: options.flowId, flowDigest: digest(flow), maxTokens: 64, workspace: WORKSPACE }, async () => {
          const began = context.clock();
          const response = await sourceRequest('POST', '/v1/chat/completions', { model: options.flowName, stream: false, max_tokens: 64,
            metadata: { flujo: 'true', appendMessages: 'true' }, messages: [{ role: 'user', content: prompt }] }, 'flujo-response.private.json');
          return { ...completionEvidence(response.raw, { flujo: true, expectedModel: options.flowName }), elapsedMs: context.clock() - began, status: response.status };
        }, { paid: true });
      }
    }
  } catch (error) { failure = typeof error.code === 'string' ? error.code : 'PILOT_REQUIRES_RECONCILIATION'; }
  finally {
    if (journal && prepared) {
      // Every cleanup candidate is attempted independently. A stage/evidence
      // failure cannot prevent the subsequent provider retirement attempts.
      const attempt = async (key, operation, action) => {
        try { const result = await action(); cleanup.push({ operation, ...select(result) }); }
        catch { cleanup.push({ operation, state: 'unknown' }); }
      };
      const owned = await resources().catch(() => ({}));
      const fixturePath = path.join(options.runDirectory, 'fixture-ownership.private.json');
      let fixture = await privateRead(fixturePath).then(JSON.parse).catch(() => ({}));
      // A confirmed201 header receipt can survive a later private checkpoint
      // failure. It proves the exact original creation; do not replay the POST.
      const modelHttp = await privateRead(path.join(options.runDirectory, 'create-model-response.private.json.http.private.json')).then(JSON.parse).catch(() => ({}));
      const expectedModel = owned.endpoint ? fixtureModel(options, context.config, owned.endpoint, '') : null;
      const authoredFlowDigest = digest(runFlow), flowIntent = journal.get('create-flujo-flow');
      const boundAuthoredFlow = (() => {
        try {
          return flowIntent?.operation === 'create-flujo-flow'
            && flowIntent.request_digest === digest(JSON.parse(flowIntent.request_json))
            && flowIntent.request_digest === digest({ ...requestFor('create-flujo-flow'), flowDigest: authoredFlowDigest, workspace: WORKSPACE });
        } catch { return false; }
      })();
      if (!fixture.modelCreated && expectedModel && modelHttp.status === 201 && modelHttp.method === 'POST' && modelHttp.endpoint === '/api/model'
          && modelHttp.resourceId === options.modelId && digest(modelHttp.source) === digest(prepared.source)
          && modelHttp.bodyDigest === digest(modelProjection(expectedModel))
          && journal.get('create-flujo-model')?.request_digest === digest({ ...requestFor('create-flujo-model'), modelDigest: digest(modelProjection(expectedModel)), workspace: WORKSPACE })) {
        fixture = { modelCreated: true, modelId: options.modelId, flowId: options.flowId, source: prepared.source,
          modelDigest: digest(modelProjection(expectedModel)), flowDigest: authoredFlowDigest, recoveredFromConfirmedHttp: true };
      }
      const flowHttp = await privateRead(path.join(options.runDirectory, 'create-flow-response.private.json.http.private.json')).then(JSON.parse).catch(() => ({}));
      if (!fixture.flowCreated && fixture.modelCreated && flowHttp.status === 201 && flowHttp.method === 'POST' && flowHttp.endpoint === '/api/flow'
          && flowHttp.resourceId === options.flowId && digest(flowHttp.source) === digest(prepared.source)
          && flowHttp.bodyDigest === authoredFlowDigest && boundAuthoredFlow) fixture.flowCreated = true;
      if (fixture.modelCreated) {
        await attempt('disable-flujo-model', 'disable-flujo-model', () => perform('disable-flujo-model', 'disable-flujo-model', { modelId: options.modelId }, async () => {
          if (fixture.flowCreated && (!boundAuthoredFlow || fixture.flowDigest !== authoredFlowDigest)) fail('OWNED_FLOW_CHANGED');
          await sourceContext(options, context, { allowOwn: true, resources: owned, ownedFlow: runFlow });
          const disabled = { ...fixtureModel(options, context.config, owned.endpoint, ''), displayName: 'Factory Modal Coder (retired)' };
          const result = await sourceRequest('PUT', `/api/model/${options.modelId}`, disabled, 'disable-model-response.private.json');
          return { state: 'model-disabled', status: result.status };
        }));
      }
      if (owned.proxyTokenCreated) await attempt('delete-proxy-token', 'delete-proxy-token', () => sdk('delete-proxy-token', 'delete-proxy-token'));
      if (owned.appDeployed) await attempt('stop-app', 'stop-app', () => sdk('stop-app', 'stop-app'));
      const afterStop = await resources().catch(() => ({}));
      if (afterStop.volumeCreated && (afterStop.appStopped || !afterStop.appDeployed)) await attempt('delete-volume', 'delete-volume', () => sdk('delete-volume', 'delete-volume'));
      if (fixture.flowCreated) await attempt('delete-flujo-flow', 'delete-flujo-flow', () => perform('delete-flujo-flow', 'delete-flujo-flow', { flowId: options.flowId }, async () => {
        if (!boundAuthoredFlow || fixture.flowDigest !== authoredFlowDigest) fail('OWNED_FLOW_CHANGED');
        const current = await context.managed.json(new URL(`/api/flow/${options.flowId}`, source.source), { token: source.token, workspace: WORKSPACE });
        if (digest(select(current, ['id', 'name', 'nodes', 'edges'])) !== fixture.flowDigest) fail('OWNED_FLOW_CHANGED');
        const response = await sourceRequest('DELETE', `/api/flow/${options.flowId}`, null, 'delete-flow-response.private.json');
        if (response.status !== 204) fail('FLOW_RETIREMENT_UNCONFIRMED');
        return { state: 'flow-removed', status: response.status };
      }));
      if (fixture.modelCreated && (!fixture.flowCreated || journal.get('delete-flujo-flow')?.state === 'succeeded')) await attempt('delete-flujo-model', 'delete-flujo-model', () => perform('delete-flujo-model', 'delete-flujo-model', { modelId: options.modelId }, async () => {
        const current = await context.managed.json(new URL(`/api/model/${options.modelId}`, source.source), { token: source.token, workspace: WORKSPACE });
        const expected = { ...fixtureModel(options, context.config, owned.endpoint, ''), displayName: 'Factory Modal Coder (retired)' };
        if (digest(modelProjection(current)) !== digest(modelProjection(expected))) fail('OWNED_MODEL_CHANGED');
        const response = await sourceRequest('DELETE', `/api/model/${options.modelId}`, null, 'delete-model-response.private.json');
        if (response.status !== 204) fail('MODEL_RETIREMENT_UNCONFIRMED');
        return { state: 'model-removed', status: response.status };
      }));
      const finalResources = await resources().catch(() => ({}));
      const unknownPaid = journal.list().some(row => ['accepted', 'running', 'unknown'].includes(row.state)
        && ['create-volume', 'deploy', 'prefetch', 'direct-generation', 'flujo-generation'].includes(row.operation));
      const knownRetired = (!finalResources.appDeployed || finalResources.appStopped)
        && (!finalResources.volumeCreated || finalResources.volumeDeleted)
        && (!finalResources.proxyTokenCreated || finalResources.proxyTokenDeleted);
      const unknownResource = journal.list().some(row => ['accepted', 'running', 'unknown'].includes(row.state)
        && ((row.operation === 'create-volume' && !finalResources.volumeDeleted)
          || (row.operation === 'deploy' && !finalResources.appStopped)
          || (row.operation === 'create-proxy-token' && !finalResources.proxyTokenDeleted)));
      const fixtureRemoved = (!fixture.flowCreated || journal.get('delete-flujo-flow')?.state === 'succeeded')
        && (!fixture.modelCreated || journal.get('delete-flujo-model')?.state === 'succeeded');
      if (!knownRetired || unknownPaid || unknownResource || !fixtureRemoved || cleanup.some(item => item.state === 'unknown')) {
        failure ??= 'OWNED_CLEANUP_REQUIRES_RECONCILIATION';
      }
      const retirementEvidence = { runId: options.runId, knownRetired, unknownPaid, cleanup,
        unknownResource, fixtureRemoved,
        resources: select(finalResources, ['appId', 'volumeId', 'serveFunctionId', 'prefetchFunctionId', 'appStopped', 'volumeDeleted', 'proxyTokenDeleted']),
        observedAt: context.clock() };
      const retirementPath = path.join(options.runDirectory, options.cleanupOnly ? `cleanup-retirement-${attemptId}.private.json` : 'retirement.private.json');
      await privateJson(retirementPath, retirementEvidence).catch(() => {});
      if (knownRetired && !unknownResource) {
        try {
          const reservation = spending.status().reservations.find(item => item.reservationId === options.reservationId);
          if (!['retired-meter-pending', 'settled'].includes(reservation?.state)) spending.retire(options.reservationId, { evidenceDigest: digest(retirementEvidence) });
        }
        catch { cleanup.push({ operation: 'spending-retire', state: 'unknown' }); }
      }
      try {
        const meter = await context.driver({ ...requestFor('meter'), startedAt });
        await privateJson(path.join(options.runDirectory, options.cleanupOnly ? `cleanup-meter-${attemptId}.private.json` : 'meter.private.json'), meter, true);
        if (meter.state === 'billing-observed') spending.observe(options.reservationId, {
          chargedCents: meter.knownMeteredCents, observedAt: meter.observedAt, evidenceDigest: digest(meter) });
        await notify('meter', meter);
      } catch { await notify('meter', { state: 'billing-unavailable' }).catch(() => {}); }
    }
    let spendingStatus;
    try { spendingStatus = spending?.status(); } catch { spendingStatus = { state: 'unavailable' }; failure ??= 'SPENDING_STATUS_UNAVAILABLE'; }
    const report = { format: 'factory-modal-pilot', version: 1, runId: options.runId, state: failure ? 'requires-reconciliation' : 'smoke-complete',
      failureCode: failure, desiredState: 'retired', connection: options.through === 'flow' && !failure ? 'actual-flujo-flow-tested-and-retired' : 'transient-stage-retired-or-unknown',
      events, cleanup, spending: spendingStatus, privateRunDirectory: options.runDirectory,
      providerHardCap: false, finalMeterKnown: false };
    finalReport = report;
    const reportPath = options.cleanupOnly ? path.join(options.runDirectory, `cleanup-report-${attemptId}.private.json`)
      : !journal && await exists(path.join(options.runDirectory, 'manifest.private.json')).catch(() => false)
      ? path.join(options.runDirectory, `rejected-attempt-${randomUUID()}.private.json`) : path.join(options.runDirectory, 'report.private.json');
    await privateJson(reportPath, report).catch(() => {});
    try { journal?.close(); } catch {} if (ownsSpending) try { spending?.close(); } catch {}
    await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {});
  }
  return finalReport;
}

function cliOptions(argv) {
  const input = {}, names = { '--run-id': 'runId', '--out': 'runDirectory', '--module-path': 'modulePath', '--source-evidence': 'sourceEvidencePath',
    '--source': 'source', '--python': 'pythonPath', '--spending': 'spendingPath', '--through': 'through', '--reservation-id': 'reservationId' };
  let execute = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--execute') execute = true;
    else if (argv[index] === '--cleanup') input.cleanupOnly = true;
    else if (names[argv[index]] && argv[index + 1]) input[names[argv[index]]] = argv[++index];
    else fail('UNKNOWN_ARGUMENT');
  }
  return { input, execute };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { input, execute } = cliOptions(process.argv.slice(2));
    if (execute) {
      const report = await runModalPilot(input, { notify: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
      process.stdout.write(`${JSON.stringify({ state: report.state, runId: report.runId, connection: report.connection,
        desiredState: report.desiredState, providerHardCap: false, finalMeterKnown: false })}\n`);
      if (report.state !== 'smoke-complete') process.exitCode = 1;
    } else {
      const prepared = await prepareModalPilot(input);
      process.stdout.write(`${JSON.stringify({ state: 'prepared-read-only', runId: prepared.options.runId, environment: 'main', workspace: WORKSPACE,
        appName: prepared.options.appName, volumeName: prepared.options.volumeName, model: prepared.config.model, revision: prepared.config.revision,
        appAbsent: prepared.appAbsent, volumeAbsent: prepared.volumeAbsent, originalModelCount: prepared.originalModelCount,
        originalFlowCount: prepared.originalFlowCount, ceilingCents: 3000, executionRequiresFlag: '--execute' })}\n`);
    }
  } catch { process.stdout.write(`${JSON.stringify({ state: 'requires-reconciliation', code: 'MODAL_PILOT_STOPPED' })}\n`); process.exitCode = 1; }
}
