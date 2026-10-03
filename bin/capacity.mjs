#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateGrowthPolicy } from '../src/growth-policy.mjs';

const runFile = promisify(execFile);
const print = value => process.stdout.write(JSON.stringify(value) + '\n');
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function check(condition, code = 'CAPACITY_CONFIG') {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function absolute(value) {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value)
    && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(value));
}
function object(value) { return value && Object.getPrototypeOf(value) === Object.prototype; }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const windowsPrivateFile = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $p = [Environment]::GetEnvironmentVariable('FACTORY_CAPACITY_DATABASE')
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
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'CAPACITY_DATABASE');
  if (process.platform === 'win32') {
    const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
    const result = await runFile(path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsPrivateFile, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024,
        env: { SystemRoot: windowsRoot, WINDIR: windowsRoot, FACTORY_CAPACITY_DATABASE: filename } });
    check(result.stdout === 'private', 'CAPACITY_DATABASE');
  } else check(before.uid === process.getuid() && (before.mode & 0o077) === 0, 'CAPACITY_DATABASE');
  const after = await fs.lstat(filename);
  check(sameFile(before, after) && after.isFile() && !after.isSymbolicLink() && after.nlink === 1, 'CAPACITY_DATABASE');
  return after;
}
async function existingDatabase(filename, privateFiles) {
  check(absolute(filename), 'CAPACITY_DATABASE');
  await privateFiles.assertPrivateDirectory(path.dirname(filename));
  const info = await privateDatabaseFile(filename);
  for (const suffix of ['-wal','-shm']) {
    try { await privateDatabaseFile(filename + suffix); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat(); check(sameFile(info, opened) && opened.nlink === 1, 'CAPACITY_DATABASE');
    const header = Buffer.alloc(16), { bytesRead } = await handle.read(header, 0, 16, 0);
    check(bytesRead === 16 && header.equals(Buffer.from('SQLite format 3\0')), 'CAPACITY_DATABASE');
  } finally { await handle.close(); }
  return { filename, info, realPath: await fs.realpath(filename) };
}
const COLUMNS = {
  peer: {
    peer_events:'sequence,type,message_id,digest,observed_at',
    peer_identity:'id,local,peer,endpoint,generation,key_digest,credential_expires',
    peer_inbox:'sequence,message_id,body,digest,accepted_at',
    peer_outbox:'message_id,body,digest,endpoint,admitted_generation,state,acknowledgement,acknowledged_generation',
  },
  control: {
    cells:'id,parent_id,depth,role,allocation,spent,status,purpose,heartbeat', control:'id,epoch,status,policy',
    effect_bindings:'target,effect_key', effects:'key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,receipt,created,updated',
    events:'seq,type,subject,details,observed', integrations:'project_id,owner,epoch,token_hash,expires,control_epoch',
    messages:'sender,message_id,recipient,task_id,attempt,payload,digest,created',
    tasks:'id,project_id,branch,specification,spec_digest,status,owner,epoch,token_hash,expires,control_epoch,candidate,review',
  },
  spending: {
    spending_events:'seq,type,reservation_id,details,created_at', spending_policy:'id,limit_cents,currency',
    spending_reservations:'id,provider,ceiling_cents,state,charged_cents,observed_at,observation_digest,retirement_digest,final_cents,final_digest,created_at,started_at,retired_at,settled_at,cancelled_at',
  },
};
function initializedDatabase(DatabaseSync, filename, kind, peerConfig, canonical, applicationId) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
    check(database.prepare('PRAGMA user_version').get().user_version === 1, 'CAPACITY_DATABASE');
    const names = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    check(JSON.stringify(names) === JSON.stringify(Object.keys(COLUMNS[kind]).sort()), 'CAPACITY_DATABASE');
    check(database.prepare("SELECT count(*) AS total FROM sqlite_schema WHERE type IN ('view','trigger')").get().total === 0, 'CAPACITY_DATABASE');
    for (const name of names) check(database.prepare('PRAGMA table_info(' + name + ')').all().map(row => row.name).join(',') === COLUMNS[kind][name], 'CAPACITY_DATABASE');
    if (kind === 'peer') {
      check(database.prepare('PRAGMA application_id').get().application_id === applicationId, 'CAPACITY_DATABASE');
      const rows = database.prepare('SELECT * FROM peer_identity').all(), config = peerConfig;
      check(rows.length === 1 && rows[0].id === 1 && rows[0].local === canonical(config.local) && rows[0].peer === canonical(config.peer)
        && rows[0].endpoint === config.endpoint && rows[0].generation === config.generation
        && rows[0].key_digest === createHash('sha256').update(Buffer.from(config.key, 'base64url')).digest('hex')
        && rows[0].credential_expires === config.credentialExpiresAt, 'CAPACITY_DATABASE');
    } else if (kind === 'control') {
      const rows = database.prepare('SELECT id,epoch,status,policy FROM control').all();
      const root = database.prepare("SELECT role FROM cells WHERE id='root'").get();
      check(rows.length === 1 && rows[0].id === 1 && Number.isSafeInteger(rows[0].epoch) && rows[0].epoch > 0
        && ['active','paused'].includes(rows[0].status) && root?.role === 'coordinator', 'CAPACITY_DATABASE');
      const policy = JSON.parse(rows[0].policy);
      try { validateGrowthPolicy(policy); } catch { check(false, 'CAPACITY_DATABASE'); }
    } else {
      const rows = database.prepare('SELECT id,limit_cents,currency FROM spending_policy').all();
      check(rows.length === 1 && rows[0].id === 1 && rows[0].currency === 'USD'
        && Number.isSafeInteger(rows[0].limit_cents) && rows[0].limit_cents >= 0, 'CAPACITY_DATABASE');
    }
    database.exec('COMMIT');
  } finally { database.close(); }
}

let store, control, paid, server, mcp;
try {
  check(Number(process.versions.node.split('.')[0]) >= 24, 'CAPACITY_NODE_VERSION');
  process.umask(0o077);
  const [command, ...rest] = process.argv.slice(2), flags = {};
  check(['issue','tool','broker'].includes(command) && rest.length === 4);
  for (let index = 0; index < rest.length; index += 2) {
    check(['--private-module','--profile'].includes(rest[index]) && !Object.hasOwn(flags, rest[index]) && absolute(rest[index + 1]));
    flags[rest[index]] = rest[index + 1];
  }
  const privateFiles = await import(pathToFileURL(flags['--private-module']).href);
  for (const name of ['readPrivateJson','writePrivateJson','assertPrivateDirectory']) check(typeof privateFiles[name] === 'function');
  const profile = await privateFiles.readPrivateJson(flags['--profile'], { maxBytes: 65536 });
  const common = ['peerConfigFile','peerDatabase','grantFile'];
  const required = { issue:[...common,'controlDatabase','outputFile'], tool:[...common,'mcpTokenFile','nativeOrigin','nativeTokenFile','port'],
    broker:[...common,'controlDatabase','spendingDatabase','managedModule','managedOptions','host','port','pollMs'] }[command];
  const optional = command === 'broker' ? ['tlsFile','sourceProfileFile'] : [];
  check(object(profile) && required.every(name => Object.hasOwn(profile, name)) && Object.keys(profile).every(name => [...required,...optional].includes(name)));
  for (const name of Object.keys(profile).filter(name => /File$|Database$|Module$/.test(name))) check(absolute(profile[name]));
  if (command !== 'issue') check(Number.isInteger(profile.port) && profile.port > 0 && profile.port <= 65535);
  if (command === 'broker') check(object(profile.managedOptions) && typeof profile.host === 'string'
    && Number.isInteger(profile.pollMs) && profile.pollMs >= 250 && profile.pollMs <= 30000);
  const [{ DatabaseSync }, { FactoryControl, digest }, { SpendingLedger }, peer] = await Promise.all([
    import('node:sqlite'), import('../src/control.mjs'), import('../src/spending.mjs'), import('../src/peer-messaging.mjs'),
  ]);
  const { PeerStore, validatePeerConfig, PEER_APPLICATION_ID } = peer;
  const peerConfig = validatePeerConfig(await privateFiles.readPrivateJson(profile.peerConfigFile, { maxBytes: 65536 }));
  const grant = await privateFiles.readPrivateJson(profile.grantFile, { maxBytes: 65536 });
  let sourceWorkerProfile;
  if (profile.sourceProfileFile) {
    const { validateManagedCloudSourceProfile } = await import('../src/adapters/managed-cloud-source.mjs');
    sourceWorkerProfile = validateManagedCloudSourceProfile(await privateFiles.readPrivateJson(profile.sourceProfileFile, { maxBytes: 65536 }));
    check(grant.native && grant.template && sourceWorkerProfile.origin === new URL(grant.template.source).origin
      && sourceWorkerProfile.worker.workspace === grant.template.workspace && digest(sourceWorkerProfile.worker) === digest(grant.native));
  }
  const databases = [{ filename:profile.peerDatabase,kind:'peer' }];
  if (command !== 'tool') databases.push({ filename:profile.controlDatabase,kind:'control' });
  if (command === 'broker') databases.push({ filename:profile.spendingDatabase,kind:'spending' });
  const allPaths = databases.flatMap(item => ['', '-wal', '-shm'].map(suffix => pathKey(item.filename + suffix)));
  check(new Set(allPaths).size === allPaths.length, 'CAPACITY_DATABASE');
  for (const item of databases) item.checked = await existingDatabase(item.filename, privateFiles);
  for (let left = 0; left < databases.length; left++) for (let right = left + 1; right < databases.length; right++)
    check(pathKey(databases[left].checked.realPath) !== pathKey(databases[right].checked.realPath)
      && !sameFile(databases[left].checked.info, databases[right].checked.info), 'CAPACITY_DATABASE');
  for (const item of databases) initializedDatabase(DatabaseSync, item.filename, item.kind, peerConfig, canonical, PEER_APPLICATION_ID);
  // No authority constructor runs until every required database has passed private, initialized-schema and identity checks.
  for (const item of databases) check(sameFile(item.checked.info, await fs.lstat(item.filename)), 'CAPACITY_DATABASE');
  const { startPeerServer, dispatchPeerMessage } = await import('../src/peer-gateway.mjs');
  const { issueCapacityGrant, enqueueCapacityRequest, interpretCapacityRequest } = await import('../src/capacity-bridge.mjs');
  store = new PeerStore(profile.peerDatabase, { config:peerConfig });
  if (command === 'issue') {
    control = new FactoryControl(profile.controlDatabase);
    const issued = issueCapacityGrant({ control, store, grant });
    await privateFiles.assertPrivateDirectory(path.dirname(profile.outputFile));
    await privateFiles.writePrivateJson(profile.outputFile, issued.policy, { exclusive:true });
    print({ issued:true,grantId:issued.policy.grantId,scope:'private-standing-capacity-grant' });
  } else if (command === 'tool') {
    check(grant.native);
    const token = await privateFiles.readPrivateJson(profile.mcpTokenFile, { maxBytes:4096 });
    const nativeToken = await privateFiles.readPrivateJson(profile.nativeTokenFile, { maxBytes:4096 });
    check(object(token) && Object.keys(token).join(',') === 'token' && object(nativeToken) && Object.keys(nativeToken).join(',') === 'token');
    const { startCapacityMcpServer, createNativeWorkerReader } = await import('../src/capacity-mcp.mjs');
    const nativeReader = createNativeWorkerReader({ origin:profile.nativeOrigin,token:nativeToken.token,...grant.native });
    mcp = await startCapacityMcpServer({ token:token.token,port:profile.port,nativeReader,async requestCapacity(request, nativeProof) {
      const outbox = enqueueCapacityRequest({ store,grant,request,nativeProof });
      return dispatchPeerMessage({ store,messageId:outbox.messageId });
    } });
    print({ ready:true,endpoint:mcp.endpoint,scope:'native-capacity-request-tool' });
    await new Promise(resolve => { process.once('SIGINT',resolve); process.once('SIGTERM',resolve); });
  } else {
    control = new FactoryControl(profile.controlDatabase); paid = new SpendingLedger(profile.spendingDatabase);
    const { createManagedCloudAdapter } = await import('../src/adapters/managed-cloud.mjs');
    const adapter = await createManagedCloudAdapter({ modulePath:profile.managedModule,options:profile.managedOptions,sourceWorkerProfile,privateFiles });
    const tls = profile.tlsFile ? await privateFiles.readPrivateJson(profile.tlsFile, { maxBytes:65536 }) : undefined;
    if (tls) check(object(tls) && Object.keys(tls).sort().join(',') === 'cert,key' && typeof tls.key === 'string' && typeof tls.cert === 'string');
    server = await startPeerServer({ store,host:profile.host,port:profile.port,tls });
    let stopped = false, after = 0;
    process.once('SIGINT', () => { stopped = true; }); process.once('SIGTERM', () => { stopped = true; });
    print({ ready:true,scope:'standing-grant-capacity-broker' });
    while (!stopped) {
      const rows = store.inbox({ after,limit:100 });
      for (const row of rows) {
        if (stopped) break;
        try {
          const result = await interpretCapacityRequest({ control,store,grant,messageId:row.message_id,adapter,paidAdmission:paid });
          print({ messageId:row.message_id,dispatched:result.dispatched,effectKey:result.effect?.key ?? null,state:result.effect?.state ?? null,scope:'capacity-admission-result' });
        } catch (error) {
          const code = /^[A-Z_]{1,48}$/.test(error?.code ?? '') ? error.code : 'CAPACITY_REJECTED';
          print({ messageId:row.message_id,dispatched:false,error:{ code } });
        }
        after = row.sequence;
      }
      if (!stopped && rows.length < 100) await delay(profile.pollMs);
    }
  }
} catch (error) {
  const code = /^[A-Z_]{1,48}$/.test(error?.code ?? '') ? error.code : 'CAPACITY_UNAVAILABLE';
  print({ error:{ code } }); process.exitCode = 1;
} finally {
  try {
    await mcp?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store?.close(); control?.close(); paid?.close();
  } catch {
    print({ error:{ code:'CAPACITY_CLOSE_FAILED' } }); process.exitCode = 1;
  }
}
