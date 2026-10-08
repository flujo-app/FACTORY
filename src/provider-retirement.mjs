import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readOnlyFlyRunner } from '../scripts/watch-pilot.mjs';
import { FlujoClient } from './flujo-swarm/flujo-client.mjs';
import { trustedLocalWorkspace } from './adapters/flujo-workspace.mjs';

const proofs = new WeakMap();
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const APP = /^[a-z][a-z0-9-]{2,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const INPUT_KEYS = ['closureId','expectedParent','expectedStatus','expectedAllocation','expectedSpent','expectedFactoryEpoch','provisionKey','retirementKey'];
const EFFECT_KEYS = ['key','scope','scope_id','task_id','owner','owner_epoch','control_epoch','kind','request_digest','state','receipt','created','updated'];
const TTL_MS = 60_000;
const MAX_FILE_BYTES = 64 * 1024;
const INVENTORY_SCOPE = 'configured-org-app-inventory-returned-by-trusted-cli';
const RESOURCE_SCOPE = 'owned-fly-teardown-recorded-and-app-not-returned-by-configured-inventory';
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function fail(code = 'PROVIDER_RETIREMENT_UNCONFIRMED') {
  const error = new Error('Owned provider retirement evidence could not be qualified. Details are withheld.');
  error.code = code; throw error;
}
function requireValue(value, code) { if (!value) fail(code); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function integer(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }
function absolute(value) { return typeof value === 'string' && path.isAbsolute(value)
  && (process.platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(value)); }
function capturedInput(input) {
  requireValue(plain(input) && Object.keys(input).length === INPUT_KEYS.length
    && INPUT_KEYS.every(key => Object.hasOwn(input,key)), 'PROVIDER_RETIREMENT_INPUT');
  const value = Object.fromEntries(INPUT_KEYS.map(key => [key,input[key]]));
  requireValue(['closureId','expectedParent','provisionKey','retirementKey'].every(key => ID.test(value[key] ?? ''))
    && ['reserved','ready'].includes(value.expectedStatus)
    && integer(value.expectedAllocation) && integer(value.expectedSpent)
    && integer(value.expectedFactoryEpoch,1), 'PROVIDER_RETIREMENT_INPUT');
  return Object.freeze(value);
}
function eventIdentity(control, type, subject) {
  const rows = control.db.prepare('SELECT seq,type,subject,details,observed FROM events WHERE type=? AND subject=?').all(type,subject);
  requireValue(rows.length === 1, 'PROVIDER_RETIREMENT_BINDING');
  return { ...rows[0], details: JSON.parse(rows[0].details) };
}
function effectIdentity(effect) { return Object.fromEntries(EFFECT_KEYS.map(key => [key,effect[key]])); }
function controllerIdentity(control, cellId, request) {
  const factory = control.control(), cell = control.db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
  requireValue(cellId !== 'root' && ID.test(cellId ?? '') && cell && factory.epoch === request.expectedFactoryEpoch
    && cell.parent_id === request.expectedParent && cell.status === request.expectedStatus
    && cell.allocation === request.expectedAllocation && cell.spent === request.expectedSpent,
  'PROVIDER_RETIREMENT_STALE');
  const provision = control.effect(request.provisionKey), retirement = control.effect(request.retirementKey);
  requireValue(provision.kind === 'provision' && provision.scope === 'task' && provision.state === 'succeeded'
    && provision.owner === cell.parent_id && retirement.kind === 'retire' && retirement.scope === 'cleanup'
    && retirement.owner === 'root' && retirement.state === 'succeeded', 'PROVIDER_RETIREMENT_BINDING');
  const bindings = control.db.prepare('SELECT target,effect_key FROM effect_bindings WHERE effect_key=? ORDER BY target').all(provision.key);
  requireValue(bindings.length === 2 && bindings.some(row => row.target === 'cell:'+cellId)
    && bindings.filter(row => row.target.startsWith('app:')).length === 1, 'PROVIDER_RETIREMENT_BINDING');
  const app = bindings.find(row => row.target.startsWith('app:')).target.slice(4);
  requireValue(APP.test(app) && retirement.scope_id === app && retirement.receipt?.app === app
    && retirement.receipt?.state === 'destroyed'
    && (retirement.receipt.worker === undefined || retirement.receipt.worker === app)
    && provision.receipt?.app === app && provision.receipt?.state === 'ready', 'PROVIDER_RETIREMENT_BINDING');
  const provisionEvent = eventIdentity(control,'effect_accepted',provision.key);
  const retirementEvent = eventIdentity(control,'owned_retirement_accepted',retirement.key);
  requireValue(provisionEvent.details.kind === 'provision' && provisionEvent.details.scope === provision.scope
    && provisionEvent.details.scopeId === provision.scope_id && provisionEvent.details.requestDigest === provision.request_digest
    && retirementEvent.details.app === app && retirementEvent.details.provisionKey === provision.key
    && retirementEvent.details.controlEpoch === retirement.control_epoch
    && retirement.request_digest === sha(canonical({app,provisionKey:provision.key})), 'PROVIDER_RETIREMENT_BINDING');
  return { factoryEpoch: factory.epoch, cell: { id:cell.id,parent_id:cell.parent_id,status:cell.status,
    allocation:cell.allocation,spent:cell.spent,depth:cell.depth,role:cell.role }, app, bindings,
  provision:effectIdentity(provision), retirement:effectIdentity(retirement), provisionEvent, retirementEvent };
}
function fileIdentity(info) {
  return ['dev','ino','size','mtimeNs','ctimeNs','birthtimeNs',
    'nlink','mode','uid','gid'].map(key => String(info[key])).join(':');
}
function regular(info) { return info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
  && info.size > 0n && info.size <= BigInt(MAX_FILE_BYTES)
  && (process.platform === 'win32' || ((info.mode & 0o077n) === 0n && info.uid === BigInt(process.getuid()))); }
function privateArtifact(filename) {
  const before = lstatSync(filename,{bigint:true}); requireValue(regular(before));
  const descriptor = openSync(filename,'r');
  try {
    const opened = fstatSync(descriptor,{bigint:true}); requireValue(regular(opened) && fileIdentity(opened) === fileIdentity(before));
    const buffer = Buffer.alloc(MAX_FILE_BYTES+1);
    let length = 0, count;
    do { count = readSync(descriptor,buffer,length,buffer.length-length,null); length += count; }
    while (count > 0 && length < buffer.length);
    requireValue(length <= MAX_FILE_BYTES && BigInt(length) === opened.size); const bytes = buffer.subarray(0,length);
    const after = fstatSync(descriptor,{bigint:true}), named = lstatSync(filename,{bigint:true});
    requireValue(fileIdentity(after) === fileIdentity(opened) && regular(named) && fileIdentity(named) === fileIdentity(opened));
    const value = JSON.parse(bytes.toString('utf8')); requireValue(plain(value));
    return { filename,identity:fileIdentity(opened),sha256:sha(bytes),value };
  } finally { closeSync(descriptor); }
}
function managedIdentity(directory, app, options) {
  const workers = path.join(directory,'workers');
  for (const dir of [directory,workers]) {
    const info = lstatSync(dir); requireValue(info.isDirectory() && !info.isSymbolicLink()
      && path.resolve(realpathSync(dir)) === path.resolve(dir));
  }
  for (const suffix of ['.managed.lock','.journal.json.lock','.journal.json.next']) {
    try { lstatSync(path.join(workers,app+suffix)); fail('PROVIDER_RETIREMENT_BUSY'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const metadata = privateArtifact(path.join(workers,app+'.deployment.json'));
  const journal = privateArtifact(path.join(workers,app+'.journal.json'));
  const m = metadata.value, j = journal.value;
  requireValue(m.format === 'flujo-managed-deployment' && m.version === 1 && m.id === app
    && UUID.test(m.attemptId ?? '') && m.phase === 'destroyed' && m.retirement === 'cloud-confirmed'
    && m.org === options.org && m.workspace === options.workspace && IMAGE.test(m.image ?? '')
    && UUID.test(m.journalOwner ?? '') && Number.isFinite(Date.parse(m.createdAt ?? ''))
    && j.format === 'flujo-cloud-journal' && j.version === 1 && j.owner === m.journalOwner
    && j.app === app && j.appId === app && j.org === m.org && j.workspace === m.workspace
    && j.image === m.image && j.region === m.region && /^[a-z]{3}$/.test(j.region ?? '')
    && j.state === 'destroyed' && j.stage === 'destroyed' && j.appCreated === true
    && j.ownershipConfirmed === true && j.authState === 'copied-workspace'
    && /^[A-Za-z0-9_-]{1,128}$/.test(j.machineId ?? '') && /^[A-Za-z0-9_-]{1,128}$/.test(j.volumeId ?? '')
    && j.machineName === 'worker-'+j.owner.replaceAll('-','').slice(0,12)
    && j.volumeName === 'worker_'+j.owner.replaceAll('-','').slice(0,12)
    && HASH.test(j.archiveSha256 ?? '') && Number.isFinite(Date.parse(j.createdAt ?? ''))
    && Number.isFinite(Date.parse(j.updatedAt ?? '')), 'PROVIDER_RETIREMENT_GENERATION');
  return { metadata,journal, generation:{ app,org:m.org,workspace:m.workspace,attemptId:m.attemptId,
    owner:j.owner,image:m.image,source:m.source,machineId:j.machineId,volumeId:j.volumeId,metadataCreatedAt:m.createdAt,
    journalCreatedAt:j.createdAt,journalUpdatedAt:j.updatedAt } };
}
function artifactPin(artifact) { return { filename:artifact.filename,identity:artifact.identity,sha256:artifact.sha256 }; }
function managedPin(value) { return { metadata:artifactPin(value.metadata),journal:artifactPin(value.journal),generation:value.generation }; }
function equal(left,right) { return canonical(left) === canonical(right); }
function originalGeneration(identity, managed, cellId) {
  const generation = managed.generation;
  let origin;
  try { origin = new URL(generation.source); } catch { fail('PROVIDER_RETIREMENT_GENERATION'); }
  requireValue(['http:','https:'].includes(origin.protocol) && !origin.username && !origin.password
    && !origin.search && !origin.hash && origin.pathname === '/', 'PROVIDER_RETIREMENT_GENERATION');
  requireValue(identity.provision.request_digest === sha(canonical({cellId,app:identity.app,source:generation.source,
    workspace:generation.workspace,image:generation.image})), 'PROVIDER_RETIREMENT_REQUEST_BINDING');
  for (const value of [generation.metadataCreatedAt,generation.journalCreatedAt]) {
    const created = Date.parse(value);
    requireValue(created >= identity.provision.created && created <= identity.provision.updated, 'PROVIDER_RETIREMENT_TIME_BINDING');
  }
  requireValue(Date.parse(generation.journalUpdatedAt) <= identity.retirement.updated, 'PROVIDER_RETIREMENT_TIME_BINDING');
}
function scopedAbsentInventory(stdout, app, org) {
  const values = JSON.parse(stdout); requireValue(Array.isArray(values) && values.length <= 1000);
  const names = new Set(), ids = new Set();
  for (const value of values) {
    const name = value?.Name ?? value?.name, identifier = value?.ID ?? value?.id;
    const organization = value?.Organization ?? value?.organization;
    requireValue(plain(value) && APP.test(name ?? '') && typeof identifier === 'string' && identifier.length > 0
      && identifier.length <= 128 && (organization?.Slug ?? organization?.slug) === org
      && (!Object.hasOwn(value,'Name') || !Object.hasOwn(value,'name') || value.Name === value.name)
      && (!Object.hasOwn(value,'ID') || !Object.hasOwn(value,'id') || value.ID === value.id)
      && (!Object.hasOwn(value,'Organization') || !Object.hasOwn(value,'organization') || equal(value.Organization,value.organization))
      && (!Object.hasOwn(organization,'Slug') || !Object.hasOwn(organization,'slug') || organization.Slug === organization.slug)
      && !names.has(name) && !ids.has(identifier));
    names.add(name); ids.add(identifier);
  }
  requireValue(!names.has(app) && !ids.has(app), 'PROVIDER_RETIREMENT_PRESENT');
  return { source:'fly-provider-live',scope:INVENTORY_SCOPE,org,app,
    state:'app-absent', inventorySha256:sha(stdout), inventoryCount:values.length };
}

/** Built-in trusted-local inspection; no supplied callback, service, serialized proof or provider mutation. */
async function observe(control, cellId, input, options) {
  const request = capturedInput(input);
  requireValue(plain(options) && Object.keys(options).sort().join(',') === 'flyPath,managedDirectory,org,workspace'
    && absolute(options.flyPath) && absolute(options.managedDirectory)
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(options.org ?? '')
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.workspace ?? ''), 'PROVIDER_RETIREMENT_INPUT');
  const configured = Object.freeze({ ...options });
  const startedAt = Date.now(), identity = controllerIdentity(control,cellId,request);
  const managed = managedIdentity(configured.managedDirectory,identity.app,configured), pin = managedPin(managed);
  originalGeneration(identity,managed,cellId);
  const runner = readOnlyFlyRunner(configured.flyPath,{endAt:startedAt+10_000,org:configured.org,allowedApps:[identity.app]});
  let provider;
  try { provider = scopedAbsentInventory(await runner.run(['apps','list','--org',configured.org,'--json']),identity.app,configured.org); }
  catch (error) { if (error?.code === 'PROVIDER_RETIREMENT_PRESENT') throw error; fail(); }
  const observedAt = Date.now();
  const observedMonotonic = performance.now();
  requireValue(observedAt >= startedAt && observedAt-startedAt <= 10_000, 'PROVIDER_RETIREMENT_STALE');
  requireValue(equal(pin,managedPin(managedIdentity(configured.managedDirectory,identity.app,configured)))
    && equal(identity,controllerIdentity(control,cellId,request)), 'PROVIDER_RETIREMENT_STALE');
  const receipt = Object.freeze({ resourceScope:RESOURCE_SCOPE,inventoryScope:INVENTORY_SCOPE,
    observedAt:new Date(observedAt).toISOString(), app:identity.app,
    evidenceDigest:sha(canonical({identity,managed:pin,provider,observedAt})),
    deploymentSha256:pin.metadata.sha256,journalSha256:pin.journal.sha256,providerInventorySha256:provider.inventorySha256 });
  const proof = Object.freeze(Object.create(null));
  proofs.set(proof,{control,cellId,request,identity,pin,configured,observedAt,observedMonotonic,receipt});
  return proof;
}

function sanitized(error) {
  fail(/^PROVIDER_RETIREMENT_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'PROVIDER_RETIREMENT_UNCONFIRMED');
}
/** Explicit trusted operator configuration controls the CLI executable and private managed directory. */
export async function observeProvisionedCellRetirement(control, cellId, input, options) {
  try { return await observe(control,cellId,input,options); } catch (error) { sanitized(error); }
}

/** Direct read-only FLUJO absence proof for a provisioned local workspace. */
export async function observeLocalCellRetirement(control, cellId, input, adapter) {
  try {
    const request = capturedInput(input);
    const authority = trustedLocalWorkspace(adapter);
    requireValue(authority, 'PROVIDER_RETIREMENT_INPUT');
    const startedAt = Date.now();
    const identity = controllerIdentity(control, cellId, request);
    const workspace = `swarm-${identity.app}`;
    const originDigest = sha(authority.origin);
    requireValue(identity.provision.receipt?.originDigest === originDigest
      && identity.retirement.receipt?.originDigest === originDigest,
    'PROVIDER_RETIREMENT_BINDING');
    const client = new FlujoClient({ origin: authority.origin, token: authority.token,
      workspace, deadlineAt: startedAt + 30_000 });
    requireValue(await client.confirmWorkspaceAbsent(workspace), 'PROVIDER_RETIREMENT_PRESENT');
    const observedAt = Date.now(), observedMonotonic = performance.now();
    requireValue(observedAt >= startedAt && observedAt - startedAt <= 30_000,
      'PROVIDER_RETIREMENT_STALE');
    requireValue(equal(identity, controllerIdentity(control, cellId, request)),
      'PROVIDER_RETIREMENT_STALE');
    const receipt = Object.freeze({
      resourceScope: 'local-flujo-workspace-absent-after-continuous-observation',
      inventoryScope: 'exact-local-flujo-workspace-list', app: identity.app,
      originDigest, workspace, observedAt: new Date(observedAt).toISOString(),
      evidenceDigest: sha(canonical({ identity, originDigest, workspace, observedAt })),
    });
    const proof = Object.freeze(Object.create(null));
    proofs.set(proof, { kind: 'local', control, cellId, request, identity, authority,
      observedAt, observedMonotonic, receipt });
    return proof;
  } catch (error) { sanitized(error); }
}

/** Read-only evidence for a prepared adoption report; reading it does not grant or consume authority. */
export function providerRetirementEvidence(proof, control) {
  const record = proofs.get(proof);
  if (!record || record.control !== control) fail('PROVIDER_RETIREMENT_PROOF');
  return record.receipt;
}

/** Called synchronously inside the controller's closure transaction. Opaque capabilities are single use. */
export function consumeProviderRetirementProof(proof, control, cellId, input) {
  try {
    const record = proofs.get(proof);
    if (!record || record.control !== control || record.cellId !== cellId || !equal(record.request,input)) return null;
    const now = Date.now();
    const monotonic = performance.now();
    requireValue(now >= record.observedAt && now-record.observedAt <= TTL_MS
      && monotonic >= record.observedMonotonic && monotonic-record.observedMonotonic <= TTL_MS, 'PROVIDER_RETIREMENT_STALE');
    if (record.kind === 'local') {
      requireValue(equal(record.identity, controllerIdentity(control, cellId, record.request))
        && sha(record.authority.origin) === record.receipt.originDigest,
      'PROVIDER_RETIREMENT_STALE');
      proofs.delete(proof);
      return record.receipt;
    }
    requireValue(equal(record.identity,controllerIdentity(control,cellId,record.request))
      && equal(record.pin,managedPin(managedIdentity(record.configured.managedDirectory,record.identity.app,record.configured))),
    'PROVIDER_RETIREMENT_STALE');
    const validatedAt = Date.now();
    const validatedMonotonic = performance.now();
    requireValue(validatedAt >= now && validatedAt-record.observedAt <= TTL_MS && validatedMonotonic >= monotonic
      && validatedMonotonic-record.observedMonotonic <= TTL_MS, 'PROVIDER_RETIREMENT_STALE');
    proofs.delete(proof);
    return record.receipt;
  } catch (error) { sanitized(error); }
}
