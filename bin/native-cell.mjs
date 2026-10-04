#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const cancellation = new AbortController();
const stop = () => cancellation.abort();
let control, paid, previousOutput;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const STATES = new Set(['stopped','blocked','recovered','unresolved','paused','paid_paused','busy','released','awaiting_review','idle','budget','dispatched',
  'power_transition','power_observed','sleeping']);
const EFFECT_STATES = new Set(['accepted','running','unknown','succeeded','not_applied']);
const REASONS = new Set(['original_intent_requires_operator','assignment_owner','lifetime_intent_exists','assignment_changed',
  'factory_paused','assignment_busy','unstarted_assignment_changed','worker_target_unavailable','worker_not_ready','mission_history','native_conflict','output_binding',
  'worker_power_unavailable','worker_power_busy','queue_demand_changed','worker_power_binding','worker_power_stopped','power_reconciliation_required',
  'power_intent_requires_operator','queue_demand_not_runnable','model_step_reconciliation_required','model_step_manifest_incomplete','original_model_step_runtime_hold']);
const ERROR_CODES = new Set(['NATIVE_CELL_ARGUMENTS','NATIVE_CELL_NODE_VERSION','NATIVE_CELL_PRIVATE_MODULE','NATIVE_CELL_PROFILE',
  'NATIVE_CELL_DATABASE','NATIVE_CELL_STATUS','NATIVE_CELL_FAILED','NATIVE_CELL_CLOSE_FAILED','NATIVE_MISSION_BINDING',
  'NATIVE_MISSION_INVALID','NATIVE_MISSION_UNAVAILABLE','NATIVE_MISSION_CONFLICT','NATIVE_MISSION_ADMISSION',
  'NATIVE_MISSION_ALREADY_ATTEMPTED','NATIVE_MISSION_DISPATCH_UNKNOWN','NATIVE_MISSION_PRIVATE_OUTPUT',
  'NATIVE_MISSION_OUTPUT_LIMIT','NATIVE_MISSION_OUTPUT_CONFLICT','INVALID','SCHEMA','UNINITIALIZED','BUSY','PAUSED','BUDGET','OVERFLOW','STALE','AUTHORITY',
  'WORKER_POWER_AUTHORITY','WORKER_POWER_BINDING','WORKER_POWER_ENROLLMENT','WORKER_POWER_HISTORY','WORKER_POWER_QUEUE',
  'WORKER_POWER_OWNER','WORKER_POWER_UNAVAILABLE','WORKER_POWER_BUDGET','WORKER_POWER_REQUEST','WORKER_POWER_STOPPED']);
function check(value, code = 'NATIVE_CELL_PROFILE') {
  if (!value) throw Object.assign(new Error(code), { code });
}
function closed(value, keys, code) {
  check(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)), code);
}
function absolute(value) {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value)
    && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(value));
}
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
const windowsPrivateFile = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $p = [Environment]::GetEnvironmentVariable('FACTORY_NATIVE_CELL_FILE')
  if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = [IO.File]::GetAccessControl($p)
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'unsafe' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { throw 'unsafe' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $identity.User.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'unsafe' }
  }
  [Console]::Out.Write('private')
} catch { [Environment]::Exit(1) }
`;
async function privateDatabaseFile(filename) {
  const before = await fs.lstat(filename);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'NATIVE_CELL_DATABASE');
  if (process.platform === 'win32') {
    const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
    const result = await runFile(path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsPrivateFile, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024,
        env: { SystemRoot: windowsRoot, WINDIR: windowsRoot, FACTORY_NATIVE_CELL_FILE: filename } });
    check(result.stdout === 'private', 'NATIVE_CELL_DATABASE');
  } else check(before.uid === process.getuid() && (before.mode & 0o077) === 0, 'NATIVE_CELL_DATABASE');
  const after = await fs.lstat(filename);
  check(sameFile(before, after) && after.isFile() && !after.isSymbolicLink() && after.nlink === 1, 'NATIVE_CELL_DATABASE');
  return after;
}
async function existingDatabase(filename, privateFiles) {
  check(absolute(filename), 'NATIVE_CELL_DATABASE');
  await privateFiles.assertPrivateDirectory(path.dirname(filename));
  const info = await privateDatabaseFile(filename);
  for (const suffix of ['-wal','-shm']) {
    try { await privateDatabaseFile(filename + suffix); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat(); check(sameFile(info, opened) && opened.nlink === 1, 'NATIVE_CELL_DATABASE');
    const header = Buffer.alloc(16); const { bytesRead } = await handle.read(header, 0, 16, 0);
    check(bytesRead === 16 && header.equals(Buffer.from('SQLite format 3\0')), 'NATIVE_CELL_DATABASE');
  } finally { await handle.close(); }
  return { info, realPath: await fs.realpath(filename) };
}
function initializedDatabase(DatabaseSync, filename, kind) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
    check(database.prepare('PRAGMA user_version').get().user_version === 1, 'NATIVE_CELL_DATABASE');
    const names = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    const expected = kind === 'control' ? ['cells','control','effect_bindings','effects','events','integrations','messages','tasks']
      : ['spending_events','spending_policy','spending_reservations'];
    check(JSON.stringify(names) === JSON.stringify(expected), 'NATIVE_CELL_DATABASE');
    if (kind === 'control') {
      const rows = database.prepare('SELECT id,epoch,status,policy FROM control').all();
      const root = database.prepare("SELECT role FROM cells WHERE id='root'").get();
      check(rows.length === 1 && rows[0].id === 1 && Number.isSafeInteger(rows[0].epoch) && rows[0].epoch > 0
        && ['active','paused'].includes(rows[0].status) && root?.role === 'coordinator', 'NATIVE_CELL_DATABASE');
      const policy = JSON.parse(rows[0].policy);
      check(typeof policy.mission === 'string' && Number.isSafeInteger(policy.budgetCents) && policy.budgetCents >= 0, 'NATIVE_CELL_DATABASE');
    } else {
      const rows = database.prepare('SELECT id,limit_cents,currency FROM spending_policy').all();
      check(rows.length === 1 && rows[0].id === 1 && rows[0].currency === 'USD'
        && Number.isSafeInteger(rows[0].limit_cents) && rows[0].limit_cents >= 0, 'NATIVE_CELL_DATABASE');
    }
    database.exec('COMMIT');
  } finally { database.close(); }
}
function observation(value) {
  closed(value, ['taskId','key','effectState'], 'NATIVE_CELL_STATUS');
  check(typeof value.taskId === 'string' && typeof value.key === 'string'
    && ID.test(value.taskId) && ID.test(value.key) && EFFECT_STATES.has(value.effectState), 'NATIVE_CELL_STATUS');
  return { taskId: value.taskId, key: value.key, effectState: value.effectState };
}
function printStatus(value) {
  check(value && Object.getPrototypeOf(value) === Object.prototype && STATES.has(value.state)
    && Object.keys(value).every(key => ['state','taskId','key','effectState','reason','unallocatedCents','observations','runtimeAdmission'].includes(key)), 'NATIVE_CELL_STATUS');
  const safe = { state: value.state };
  for (const key of ['taskId','key']) if (Object.hasOwn(value, key)) {
    check(typeof value[key] === 'string' && ID.test(value[key]), 'NATIVE_CELL_STATUS'); safe[key] = value[key];
  }
  if (Object.hasOwn(value, 'effectState')) { check(EFFECT_STATES.has(value.effectState), 'NATIVE_CELL_STATUS'); safe.effectState = value.effectState; }
  if (Object.hasOwn(value, 'reason')) { check(REASONS.has(value.reason), 'NATIVE_CELL_STATUS'); safe.reason = value.reason; }
  if (Object.hasOwn(value, 'unallocatedCents')) {
    check(Number.isSafeInteger(value.unallocatedCents) && value.unallocatedCents >= 0, 'NATIVE_CELL_STATUS'); safe.unallocatedCents = value.unallocatedCents;
  }
  if (Object.hasOwn(value, 'observations')) {
    check(Array.isArray(value.observations) && value.observations.length <= 1000, 'NATIVE_CELL_STATUS'); safe.observations = value.observations.map(observation);
  }
  if (Object.hasOwn(value, 'runtimeAdmission')) { check(value.runtimeAdmission === 'HOLD', 'NATIVE_CELL_STATUS'); safe.runtimeAdmission = 'HOLD'; }
  const output = JSON.stringify(safe);
  if (output !== previousOutput) { process.stdout.write(output + '\n'); previousOutput = output; }
}

try {
  check(Number(process.versions.node.split('.')[0]) >= 24, 'NATIVE_CELL_NODE_VERSION');
  const [command, ...args] = process.argv.slice(2), flags = {};
  check(['run','once'].includes(command) && args.length === 4, 'NATIVE_CELL_ARGUMENTS');
  for (let index = 0; index < args.length; index += 2) {
    check(['--private-module','--profile'].includes(args[index]) && !Object.hasOwn(flags, args[index]) && absolute(args[index + 1]), 'NATIVE_CELL_ARGUMENTS');
    flags[args[index]] = args[index + 1];
  }
  check(absolute(flags['--private-module']) && absolute(flags['--profile']), 'NATIVE_CELL_ARGUMENTS');
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const privateFiles = await import(pathToFileURL(flags['--private-module']).href);
  for (const name of ['readPrivateJson','writePrivateJson','ensurePrivateDirectory','assertPrivateDirectory'])
    check(typeof privateFiles[name] === 'function', 'NATIVE_CELL_PRIVATE_MODULE');
  const profile = await privateFiles.readPrivateJson(flags['--profile'], { maxBytes: 65536 });
  const usePower = Boolean(profile && Object.hasOwn(profile, 'powerScheduling'));
  closed(profile, ['controlDatabase','spendingDatabase','client','cell', ...(usePower ? ['powerScheduling'] : [])]);
  closed(profile.client, ['origin','tokenFile','worker','timeoutMs']);
  closed(profile.cell, ['cellId','app','provisionKey','worker','outputDirectory','ttlMs','pollMs']);
  check(absolute(profile.cell.outputDirectory));
  closed(profile.client.worker, ['workspace','archiveSha256','compatibility']);
  closed(profile.cell.worker, ['workspace','archiveSha256','compatibility']);
  check(absolute(profile.client.tokenFile));
  const token = await privateFiles.readPrivateJson(profile.client.tokenFile, { maxBytes: 4096 }); closed(token, ['token']);
  let powerCredentials = null;
  if (usePower) {
    closed(profile.powerScheduling, ['flyTokenFile','managementLeaseFile','wakeCeilingCents','timeoutMs']);
    const value = profile.powerScheduling;
    check(absolute(value.flyTokenFile) && absolute(value.managementLeaseFile)
      && Number.isSafeInteger(value.wakeCeilingCents) && value.wakeCeilingCents > 0
      && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 100 && value.timeoutMs <= 60000);
    const fly = await privateFiles.readPrivateJson(value.flyTokenFile, { maxBytes: 4096 }); closed(fly, ['token']);
    const lease = await privateFiles.readPrivateJson(value.managementLeaseFile, { maxBytes: 4096 });
    closed(lease, ['scope','scopeId','cellId','epoch','controlEpoch','expires','token']);
    check(lease.scope === 'task' && typeof lease.scopeId === 'string' && ID.test(lease.scopeId)
      && typeof lease.cellId === 'string' && ID.test(lease.cellId)
      && ['epoch','controlEpoch','expires'].every(key => Number.isSafeInteger(lease[key]) && lease[key] > 0)
      && typeof lease.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(lease.token));
    powerCredentials = { flyToken: fly.token, managementLease: lease };
  }
  check(absolute(profile.controlDatabase) && absolute(profile.spendingDatabase), 'NATIVE_CELL_DATABASE');
  const controlPaths = ['', '-wal', '-shm'].map(suffix => pathKey(profile.controlDatabase + suffix));
  const paidPaths = ['', '-wal', '-shm'].map(suffix => pathKey(profile.spendingDatabase + suffix));
  check(!controlPaths.some(filename => paidPaths.includes(filename)), 'NATIVE_CELL_DATABASE');
  const controlFile = await existingDatabase(profile.controlDatabase, privateFiles);
  const paidFile = await existingDatabase(profile.spendingDatabase, privateFiles);
  check(pathKey(controlFile.realPath) !== pathKey(paidFile.realPath) && !sameFile(controlFile.info, paidFile.info), 'NATIVE_CELL_DATABASE');
  const { DatabaseSync } = await import('node:sqlite');
  initializedDatabase(DatabaseSync, profile.controlDatabase, 'control');
  initializedDatabase(DatabaseSync, profile.spendingDatabase, 'spending');
  const { FactoryControl, digest } = await import('../src/control.mjs');
  const { SpendingLedger } = await import('../src/spending.mjs');
  const { createNativeMissionClient } = await import('../src/native-mission-client.mjs');
  const { createNativeCell } = await import('../src/native-cell.mjs');
  const fetchBound = (url, init = {}) => {
    const signal = AbortSignal.any(init.signal ? [init.signal, cancellation.signal] : [cancellation.signal]);
    return globalThis.fetch(url, { ...init, signal });
  };
  const client = createNativeMissionClient({ ...profile.client.worker, origin: profile.client.origin,
    token: token.token, timeoutMs: profile.client.timeoutMs, fetchImpl: fetchBound });
  check(digest(client.binding) === digest(profile.client.worker) && digest(profile.client.worker) === digest(profile.cell.worker));
  check(sameFile(controlFile.info, await fs.lstat(profile.controlDatabase)) && sameFile(paidFile.info, await fs.lstat(profile.spendingDatabase)), 'NATIVE_CELL_DATABASE');
  if (cancellation.signal.aborted) printStatus({ state: 'stopped' });
  else {
    control = new FactoryControl(profile.controlDatabase); paid = new SpendingLedger(profile.spendingDatabase);
    let powerScheduling = null;
    if (usePower) {
      const binding = control.workerPowerBinding(profile.cell.app);
      const target = value => ({ cellId: value.cellId, app: value.app, provisionKey: value.provisionKey, worker: value.worker });
      check(digest(target(binding)) === digest(target(profile.cell)), 'WORKER_POWER_BINDING');
      const { createWorkerPowerController } = await import('../src/worker-power.mjs');
      const controller = createWorkerPowerController({ control, paidAdmission: paid, binding,
        flyToken: powerCredentials.flyToken, workerToken: token.token, workerOrigin: profile.client.origin,
        fetchImpl: fetchBound, timeoutMs: profile.powerScheduling.timeoutMs });
      powerScheduling = { controller, managementLease: powerCredentials.managementLease, wakeCeilingCents: profile.powerScheduling.wakeCeilingCents };
    }
    const cell = createNativeCell({ control, paidAdmission: paid, client, privateFiles, profile: profile.cell, powerScheduling });
    // The cell's validated tick ensures its explicit output directory is private before any output write.
    if (command === 'once') printStatus(await cell.tick({ signal: cancellation.signal }));
    else printStatus(await cell.run({ signal: cancellation.signal, onChange: printStatus }));
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: ERROR_CODES.has(error?.code) ? error.code : 'NATIVE_CELL_FAILED' }) + '\n'); process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  let closeFailed = false;
  for (const handle of [paid, control]) if (handle) { try { handle.close(); } catch { closeFailed = true; } }
  if (closeFailed) { process.stderr.write(JSON.stringify({ error: 'NATIVE_CELL_CLOSE_FAILED' }) + '\n'); process.exitCode = 1; }
}
