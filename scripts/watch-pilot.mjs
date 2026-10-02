import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../src/control.mjs';

const runFile = promisify(execFile);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const APP = /^[a-z][a-z0-9-]{2,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MACHINE = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const STATES = new Set(['created', 'starting', 'started', 'stopping', 'stopped', 'suspended', 'destroying', 'destroyed', 'replacing', 'migrating']);
const MAX_DURATION = 15 * 60 * 1000;
const LOG_LIMIT = 2 * 1024 * 1024;
const OPEN = new Set(['accepted', 'running', 'unknown']);
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const pick = (value, key) => value?.[key] ?? value?.[key.toLowerCase()];
const safeFailure = code => Object.assign(new Error('Pilot watcher could not confirm an observation. Details are withheld.'), { code });
function requireValue(condition, code = 'WATCH_INPUT_INVALID') { if (!condition) throw safeFailure(code); }
function validTime(value) { const result = timestamp(value); requireValue(Number.isSafeInteger(result) && result > 0); return result; }
function within(parent, child) { const relative = path.relative(parent, child); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }

/** The manifest is local operator input, never a worker-returned authority document. */
export function validateManifest(value, manifestPath) {
  requireValue(value?.format === 'factory-cloud-pilot' && value.version === 1 && ID.test(value.runId ?? ''));
  for (const key of ['databasePath', 'managedDirectory']) requireValue(typeof value[key] === 'string' && path.isAbsolute(value[key]));
  requireValue(Array.isArray(value.workers) && value.workers.length > 0 && value.workers.length <= 2);
  requireValue(value.workspace === 'factory-pilot' && value.desiredState === 'retired');
  const workers = value.workers.map(worker => {
    requireValue(APP.test(worker.worker ?? '') && ID.test(worker.cellId ?? '') && ID.test(worker.parentId ?? ''));
    requireValue(['parent-worker', 'child-worker'].includes(worker.cellId) && [1, 2].includes(worker.depth));
    requireValue((worker.cellId === 'parent-worker' && worker.parentId === 'root' && worker.depth === 1)
      || (worker.cellId === 'child-worker' && worker.parentId === 'parent-worker' && worker.depth === 2));
    return { worker: worker.worker, cellId: worker.cellId, parentId: worker.parentId, depth: worker.depth,
      effectKey: worker.cellId === 'parent-worker' ? 'provision-parent' : 'provision-child' };
  });
  requireValue(new Set(workers.map(worker => worker.worker)).size === workers.length
    && new Set(workers.map(worker => worker.cellId)).size === workers.length);
  const startedAt = validTime(value.startedAt), deadline = validTime(value.deadline);
  requireValue(deadline > startedAt && deadline - startedAt <= MAX_DURATION);
  const heartbeatMaxAgeMs = value.heartbeatMaxAgeMs ?? 60_000;
  requireValue(Number.isSafeInteger(heartbeatMaxAgeMs) && heartbeatMaxAgeMs >= 1000 && heartbeatMaxAgeMs <= 120_000);
  requireValue(value.watcherId === undefined || (ID.test(value.watcherId) && value.watcherId !== 'root'));
  requireValue(value.org === undefined || /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.org));
  requireValue(path.isAbsolute(manifestPath));
  return { runId: value.runId, databasePath: value.databasePath, managedDirectory: value.managedDirectory,
    workspace: value.workspace, org: value.org ?? 'personal', workers, startedAt, deadline, heartbeatMaxAgeMs,
    watcherId: value.watcherId ?? null, managedModulePath: value.managedModulePath,
    evidencePath: path.join(path.dirname(manifestPath), 'watch-observations.jsonl') };
}

async function readManifest(filename) {
  const info = await fs.lstat(filename);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024);
  return validateManifest(JSON.parse(await fs.readFile(filename, 'utf8')), filename);
}

function readControl(manifest, now) {
  const db = new DatabaseSync(manifest.databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN;');
    requireValue(db.prepare('PRAGMA user_version').get().user_version === 1, 'WATCH_SCHEMA_UNSUPPORTED');
    const control = db.prepare('SELECT epoch,status FROM control WHERE id=1').get();
    const root = db.prepare('SELECT id,role,status,heartbeat FROM cells WHERE id=?').get('root');
    requireValue(control && Number.isSafeInteger(control.epoch) && ['active', 'paused'].includes(control.status)
      && root?.role === 'coordinator', 'WATCH_CONTROL_INVALID');
    const rows = db.prepare('SELECT key,kind,state,created FROM effects ORDER BY created,key').all();
    requireValue(rows.length <= 1000, 'WATCH_CONTROL_INVALID');
    const effects = rows.map(row => {
      requireValue(ID.test(row.key) && ['provision', 'flow_call', 'retire', 'delivery'].includes(row.kind)
        && [...OPEN, 'succeeded', 'not_applied'].includes(row.state) && Number.isSafeInteger(row.created), 'WATCH_CONTROL_INVALID');
      return { key: row.key, kind: row.kind, state: row.state, ageMs: Math.max(0, now - row.created) };
    });
    const bindings = db.prepare('SELECT target,effect_key FROM effect_bindings').all();
    const cells = db.prepare('SELECT id,parent_id,depth,role,status FROM cells').all();
    const ageMs = now - root.heartbeat;
    const heartbeat = Number.isSafeInteger(root.heartbeat) && ageMs >= 0
      ? { status: ageMs > manifest.heartbeatMaxAgeMs ? 'missed' : 'fresh', ageMs }
      : { status: 'unobserved' };
    db.exec('COMMIT');
    return { coordinator: { status: control.status, epoch: control.epoch, heartbeat,
      unresolvedEffects: effects.filter(effect => OPEN.has(effect.state)),
      deadline: now >= manifest.deadline ? 'elapsed' : 'within' }, effects, bindings, cells };
  } finally { db.close(); }
}

/** Only these three inventory commands can reach Fly from this process. */
export function readOnlyFlyRunner(binary, { endAt = Infinity, clock = Date.now, env = process.env,
  allowedApps = [], org = 'personal' } = {}) {
  requireValue(typeof binary === 'string' && path.isAbsolute(binary));
  requireValue(Array.isArray(allowedApps) && allowedApps.length <= 2 && allowedApps.every(app => APP.test(app))
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(org));
  return Object.freeze({ async run(args) {
    requireValue(Array.isArray(args) && (
      (args.length === 5 && args[0] === 'apps' && args[1] === 'list' && args[2] === '--org'
        && args[3] === org && args[4] === '--json')
      || (args.length === 5 && args[0] === 'machine' && args[1] === 'list' && args[2] === '--app'
        && allowedApps.includes(args[3]) && args[4] === '--json')
      || (args.length === 5 && args[0] === 'secrets' && args[1] === 'list' && args[2] === '--app'
        && allowedApps.includes(args[3]) && args[4] === '--json')), 'WATCH_MUTATION_DENIED');
    const remaining = Math.floor(endAt - clock());
    requireValue(remaining > 0, 'WATCH_DEADLINE');
    try {
      const { stdout } = await runFile(binary, args, { timeout: Math.min(5000, remaining), maxBuffer: 1024 * 1024,
        windowsHide: true, shell: false, env });
      return stdout;
    } catch { throw safeFailure('WATCH_PROVIDER_UNOBSERVED'); }
  } });
}

async function createInspector(manifest, { modulePath, flyPath, endAt, clock = Date.now } = {}) {
  requireValue(typeof modulePath === 'string' && path.isAbsolute(modulePath));
  const { ManagedCloud } = await import(pathToFileURL(modulePath).href);
  const service = new ManagedCloud({ directory: manifest.managedDirectory,
    fly: readOnlyFlyRunner(flyPath, { endAt, clock, org: manifest.org, allowedApps: manifest.workers.map(worker => worker.worker) }), progress: () => {} });
  const bridge = await service.runtime();
  return {
    deployment: worker => service.deployment(worker, { allowUnboundJournal: true }),
    ownedApp: journal => bridge.ownedApp(journal),
    machines: worker => bridge.machines(worker),
  };
}

async function workerObservation(manifest, worker, control, inspector) {
  const effect = control.effects.find(candidate => candidate.key === worker.effectKey);
  const bound = control.bindings.some(binding => binding.target === `app:${worker.worker}` && binding.effect_key === worker.effectKey)
    && control.bindings.some(binding => binding.target === `cell:${worker.cellId}` && binding.effect_key === worker.effectKey);
  const cell = control.cells.find(candidate => candidate.id === worker.cellId);
  const result = { worker: worker.worker, cellId: worker.cellId, provisionIntent: effect ? 'admitted' : 'not-admitted',
    cached: { source: 'local-managed-journal', status: 'unobserved' },
    provider: { source: 'fly-provider-live', status: 'unobserved' } };
  if (!effect) return result;
  if (effect.kind !== 'provision' || !bound || cell?.parent_id !== worker.parentId || cell?.depth !== worker.depth) {
    result.provider.status = 'identity-mismatch'; return result;
  }
  let record;
  try {
    const deployment = await inspector.deployment(worker.worker);
    const { metadata, journal } = deployment;
    requireValue(metadata?.id === worker.worker && metadata.workspace === manifest.workspace && metadata.org === manifest.org
      && UUID.test(metadata.attemptId ?? '') && ['preparing', 'provisioning', 'ready', 'destroyed'].includes(metadata.phase));
    result.cached = { source: 'local-managed-journal', status: 'observed', phase: metadata.phase };
    if (!journal) return result;
    requireValue(journal.app === worker.worker && journal.workspace === manifest.workspace && journal.org === manifest.org
      && UUID.test(journal.owner ?? '') && IMAGE.test(journal.image ?? '')
      && metadata.image === journal.image && (!metadata.journalOwner || metadata.journalOwner === journal.owner));
    requireValue(journal.appCreated === true && typeof journal.appId === 'string' && journal.appId
      && journal.ownershipConfirmed === true, 'WATCH_OWNERSHIP_UNCONFIRMED');
    record = journal;
  } catch { return result; }
  try {
    const app = await inspector.ownedApp(record);
    if (app === null) { result.provider.status = 'app-absent'; return result; }
    requireValue(pick(app, 'Name') === record.app && String(pick(app, 'ID')) === record.appId
      && pick(pick(app, 'Organization'), 'Slug') === record.org, 'WATCH_PROVIDER_IDENTITY');
    const machines = await inspector.machines(worker.worker);
    requireValue(Array.isArray(machines) && machines.length <= 1, 'WATCH_PROVIDER_IDENTITY');
    const states = machines.map(machine => {
      const config = machine.config ?? machine.Config ?? {};
      const machineId = pick(machine, 'ID'), name = pick(machine, 'Name'), state = pick(machine, 'State');
      requireValue(MACHINE.test(machineId ?? '') && machineId === record.machineId && name === record.machineName
        && config.metadata?.flujo_cloud_owner === record.owner && STATES.has(state)
        && (config.services ?? []).length === 0 && (config.containers ?? []).every(container => (container.services ?? []).length === 0)
        && (machine.image_ref?.digest ?? machine.ImageRef?.Digest) === record.image.split('@')[1], 'WATCH_PROVIDER_IDENTITY');
      return { machineId, state };
    });
    result.provider = { source: 'fly-provider-live', status: states.length ? 'owned-machines' : 'owned-app-no-machines', machines: states };
  } catch (error) { result.provider.status = error?.code === 'WATCH_PROVIDER_IDENTITY' ? 'identity-mismatch' : 'unobserved'; }
  return result;
}

export async function observePilot(manifest, { inspector, clock = Date.now } = {}) {
  const now = clock();
  let control;
  try { control = readControl(manifest, now); }
  catch {
    return { format: 'factory-pilot-observation', version: 1, runId: manifest.runId,
      observedAt: new Date(now).toISOString(), scope: 'same-host-process-witness',
      coordinator: { status: 'unobserved', heartbeat: { status: 'unobserved' }, unresolvedEffects: null,
        deadline: now >= manifest.deadline ? 'elapsed' : 'within' },
      workers: manifest.workers.map(worker => ({ worker: worker.worker, cellId: worker.cellId, provisionIntent: 'unobserved',
        cached: { source: 'local-managed-journal', status: 'unobserved' }, provider: { source: 'fly-provider-live', status: 'unobserved' } })),
      alerts: ['control-state-unobserved', ...(now >= manifest.deadline ? ['pilot-deadline-elapsed'] : [])],
      liveRetirementObserved: false, budgetEvidence: 'allocation-only-not-metered', workerQuiescence: 'unverified' };
  }
  const workers = [];
  for (const worker of manifest.workers) workers.push(await workerObservation(manifest, worker, control, inspector));
  const alerts = [];
  if (control.coordinator.heartbeat.status === 'missed') alerts.push('coordinator-heartbeat-missed');
  if (control.coordinator.heartbeat.status === 'unobserved') alerts.push('coordinator-heartbeat-unobserved');
  if (control.coordinator.unresolvedEffects.length) alerts.push('effects-unresolved');
  if (control.coordinator.deadline === 'elapsed') alerts.push('pilot-deadline-elapsed');
  if (workers.some(worker => worker.provider.status === 'identity-mismatch')) alerts.push('worker-identity-mismatch');
  if (workers.some(worker => worker.provisionIntent === 'admitted' && worker.provider.status === 'unobserved')) alerts.push('provider-state-unobserved');
  if (workers.some(worker => worker.provider.status === 'app-absent')) alerts.push('provider-app-absent');
  if (workers.some(worker => worker.provider.status === 'owned-app-no-machines')) alerts.push('provider-machine-absent');
  const admitted = workers.filter(worker => worker.provisionIntent === 'admitted');
  return { format: 'factory-pilot-observation', version: 1, runId: manifest.runId,
    observedAt: new Date(now).toISOString(), scope: 'same-host-process-witness',
    coordinator: control.coordinator, workers, alerts,
    liveRetirementObserved: admitted.length > 0 && admitted.every(worker => worker.provider.status === 'app-absent'),
    budgetEvidence: 'allocation-only-not-metered', workerQuiescence: 'unverified' };
}

async function appendObservation(manifest, observation) {
  requireValue(within(path.dirname(manifest.evidencePath), manifest.evidencePath));
  const parent = await fs.lstat(path.dirname(manifest.evidencePath));
  requireValue(parent.isDirectory() && !parent.isSymbolicLink(), 'WATCH_EVIDENCE_UNSAFE');
  let previous;
  try { previous = await fs.lstat(manifest.evidencePath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) requireValue(previous.isFile() && !previous.isSymbolicLink() && previous.nlink === 1, 'WATCH_EVIDENCE_UNSAFE');
  const handle = await fs.open(manifest.evidencePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const info = await handle.stat();
    requireValue(info.isFile() && info.nlink === 1 && info.size < LOG_LIMIT, 'WATCH_EVIDENCE_UNSAFE');
    if (previous) requireValue(info.dev === previous.dev && info.ino === previous.ino, 'WATCH_EVIDENCE_UNSAFE');
    await handle.writeFile(`${JSON.stringify({ ...observation, evidenceDigest: digest(observation) })}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

function recordWatcherMessage(manifest, observation) {
  if (!manifest.watcherId) return 'not-requested';
  const db = new DatabaseSync(manifest.databasePath);
  try {
    db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE;');
    requireValue(db.prepare('PRAGMA user_version').get().user_version === 1, 'WATCH_SCHEMA_UNSUPPORTED');
    const watcher = db.prepare('SELECT role,status FROM cells WHERE id=?').get(manifest.watcherId);
    const root = db.prepare('SELECT role,status FROM cells WHERE id=?').get('root');
    requireValue(watcher?.role === 'watcher' && watcher.status === 'ready' && root?.role === 'coordinator', 'WATCH_MESSAGE_UNREGISTERED');
    const messageId = `watch-${digest(observation).slice(0, 40)}`;
    const payload = { type: 'watcher_observation', ...observation };
    const messageDigest = digest({ recipient: 'root', taskId: null, attempt: null, payload });
    const existing = db.prepare('SELECT digest FROM messages WHERE sender=? AND message_id=?').get(manifest.watcherId, messageId);
    if (existing) requireValue(existing.digest === messageDigest, 'WATCH_MESSAGE_CONFLICT');
    else {
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(manifest.watcherId, messageId, 'root', null, null,
        JSON.stringify(payload), messageDigest, Date.parse(observation.observedAt));
      db.prepare('INSERT INTO events(type,subject,details,observed) VALUES(?,?,?,?)').run('message_recorded', messageId,
        JSON.stringify({ sender: manifest.watcherId, recipient: 'root', taskId: null, attempt: null }), Date.parse(observation.observedAt));
    }
    db.exec('COMMIT');
    return existing ? 'duplicate' : 'recorded';
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

/** Runs separately from the coordinator. It never grants leases, dispatches, retires or takes over. */
export async function runWatcher({ manifestPath, modulePath, flyPath, once = false, durationMs = MAX_DURATION,
  intervalMs = 10_000, messages = true, inspector, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onObservation = () => {} } = {}) {
  requireValue(path.isAbsolute(manifestPath ?? '') && Number.isSafeInteger(durationMs) && durationMs >= 1 && durationMs <= MAX_DURATION
    && Number.isSafeInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 60_000);
  const manifest = await readManifest(manifestPath), endAt = clock() + durationMs;
  const lockPath = path.join(path.dirname(manifestPath), 'watch-pilot.lock'), lockId = randomUUID();
  const lock = await fs.open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ runId: manifest.runId, lockId, pid: process.pid }));
  await lock.sync();
  let last;
  try {
    inspector ??= await createInspector(manifest, { modulePath: modulePath ?? manifest.managedModulePath, flyPath, endAt, clock });
    do {
      last = await observePilot(manifest, { inspector, clock });
      await appendObservation(manifest, last);
      if (messages) { try { recordWatcherMessage(manifest, last); } catch { /* Evidence survives an unavailable or unregistered inbox. */ } }
      await onObservation(last);
      if (once || clock() >= endAt) break;
      await sleep(Math.min(intervalMs, Math.max(0, endAt - clock())));
    } while (clock() < endAt);
    return last;
  } finally {
    await lock.close();
    const info = await fs.lstat(lockPath);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.size < 1024, 'WATCH_LOCK_IDENTITY');
    const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    requireValue(current.lockId === lockId && current.runId === manifest.runId, 'WATCH_LOCK_IDENTITY');
    await fs.unlink(lockPath);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // A stuck local filesystem or foreign module cannot turn the CLI into an unbounded watcher.
  // Abrupt expiry retains the append-only evidence and lock for explicit operator inspection.
  const watchdog = setTimeout(() => {
    process.stderr.write(`${JSON.stringify({ error: 'WATCH_HARD_DEADLINE' })}\n`);
    process.exit(124);
  }, MAX_DURATION);
  watchdog.unref();
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--once') options.once = true;
      else if (key === '--no-messages') options.messages = false;
      else if (['--manifest', '--module-path', '--fly-path', '--duration-ms', '--interval-ms'].includes(key)) {
        const value = args[++i]; requireValue(value !== undefined);
        const mapping = { '--manifest': 'manifestPath', '--module-path': 'modulePath', '--fly-path': 'flyPath', '--duration-ms': 'durationMs', '--interval-ms': 'intervalMs' };
        options[mapping[key]] = key.endsWith('-ms') ? Number(value) : path.resolve(value);
      } else throw safeFailure('WATCH_INPUT_INVALID');
    }
    options.flyPath ??= process.env.FLYCTL_PATH;
    options.onObservation = observation => process.stdout.write(`${JSON.stringify(observation)}\n`);
    await runWatcher(options);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: /^WATCH_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'WATCH_UNCONFIRMED' })}\n`);
    process.exitCode = 1;
  } finally { clearTimeout(watchdog); }
}
