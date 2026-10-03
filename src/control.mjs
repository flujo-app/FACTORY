import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { safeReceipt } from './receipts.mjs';
import { consumeGitRefusalProof } from './git-effect.mjs';
import { consumeProviderRetirementProof } from './provider-retirement.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const OPEN_EFFECTS = "('accepted','running','unknown')";
export class FactoryError extends Error {
  constructor(code, message) { super(message); this.name = 'FactoryError'; this.code = code; }
}
function fail(code, message) { throw new FactoryError(code, message); }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID', 'Invalid identifier.'); return value; }
function integer(value, name, min = 0) { if (!Number.isSafeInteger(value) || value < min) fail('INVALID', `${name} must be an integer >= ${min}.`); return value; }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function tokenHash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function evidence(path) {
  if (!isAbsolute(path)) fail('INVALID', 'Evidence path must be absolute.');
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
function closureInput(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))) fail('INVALID', 'Exact closure identity is required.');
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}
function closureRecord(control, closureId, type, subject, requestDigest) {
  const records = control.db.prepare("SELECT type,subject,details FROM events WHERE type IN ('task_released','cell_retired')").all();
  for (const row of records) {
    const details = JSON.parse(row.details);
    if (details.closureId !== closureId) continue;
    if (row.type !== type || row.subject !== subject || details.requestDigest !== requestDigest) fail('CONFLICT', 'Closure identity is already bound to another request.');
    return details;
  }
  return null;
}
function causalOpenEffects(control, { cellId = null, taskIds = [], provisionKeys = [] }) {
  const tasks = new Set(taskIds), provisions = new Set(provisionKeys);
  for (const effect of control.db.prepare("SELECT key,scope,scope_id,task_id FROM effects WHERE kind='provision'").all()) {
    if (tasks.has(effect.task_id) || (effect.scope === 'task' && tasks.has(effect.scope_id))) provisions.add(effect.key);
  }
  const apps = new Set(control.db.prepare("SELECT target,effect_key FROM effect_bindings WHERE target LIKE 'app:%'").all()
    .filter(binding => provisions.has(binding.effect_key)).map(binding => binding.target.slice(4)));
  return control.db.prepare(`SELECT key,scope,scope_id,task_id,owner,state FROM effects WHERE state IN ${OPEN_EFFECTS}`).all()
    .filter(effect => (cellId !== null && effect.owner === cellId) || tasks.has(effect.task_id)
      || (effect.scope === 'task' && tasks.has(effect.scope_id)) || provisions.has(effect.key)
      || (effect.scope === 'cleanup' && apps.has(effect.scope_id)));
}
function validateProvisionBindings(control) {
  const effects = control.db.prepare("SELECT key,owner FROM effects WHERE kind='provision'").all();
  const bindings = control.db.prepare('SELECT target,effect_key FROM effect_bindings').all();
  const keys = new Set(effects.map(effect => effect.key));
  if (bindings.some(binding => !keys.has(binding.effect_key))) fail('PROVISION_BINDING', 'Provisioning bindings are inconsistent.');
  for (const effect of effects) {
    const targets = bindings.filter(binding => binding.effect_key === effect.key).map(binding => binding.target);
    const cells = targets.filter(target => target.startsWith('cell:')), apps = targets.filter(target => target.startsWith('app:'));
    if (targets.length !== 2 || cells.length !== 1 || apps.length !== 1 || !ID.test(cells[0].slice(5))
        || !/^[a-z][a-z0-9-]{2,62}$/.test(apps[0].slice(4))) fail('PROVISION_BINDING', 'Provisioning must retain its exact cell and app bindings.');
    const cell = control.db.prepare('SELECT parent_id FROM cells WHERE id=?').get(cells[0].slice(5));
    if (!cell || cell.parent_id !== effect.owner) fail('PROVISION_BINDING', 'Provisioning owner does not match the bound cell parent.');
  }
}

/** One local transactional authority. No distributed-consensus or provider-idempotency claim. */
export class FactoryControl {
  constructor(path, { clock = Date.now } = {}) {
    if (!isAbsolute(path)) fail('INVALID', 'Database path must be absolute.');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.clock = clock;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1) fail('SCHEMA', 'Unsupported factory schema.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, status TEXT NOT NULL, policy TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cells(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES cells(id), depth INTEGER NOT NULL, role TEXT NOT NULL, allocation INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, purpose TEXT NOT NULL, heartbeat INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL, specification TEXT NOT NULL, spec_digest TEXT NOT NULL, status TEXT NOT NULL, owner TEXT REFERENCES cells(id), epoch INTEGER NOT NULL DEFAULT 0, token_hash TEXT, expires INTEGER, control_epoch INTEGER, candidate TEXT, review TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS active_branch ON tasks(project_id,branch) WHERE status IN ('ready','running','review','verified');
      CREATE TABLE IF NOT EXISTS integrations(project_id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES cells(id), epoch INTEGER NOT NULL, token_hash TEXT NOT NULL, expires INTEGER NOT NULL, control_epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), owner TEXT NOT NULL, owner_epoch INTEGER NOT NULL, control_epoch INTEGER NOT NULL, kind TEXT NOT NULL, request_digest TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effect_bindings(target TEXT PRIMARY KEY, effect_key TEXT NOT NULL REFERENCES effects(key));
      CREATE TABLE IF NOT EXISTS messages(sender TEXT NOT NULL REFERENCES cells(id), message_id TEXT NOT NULL, recipient TEXT NOT NULL REFERENCES cells(id), task_id TEXT REFERENCES tasks(id), attempt INTEGER, payload TEXT NOT NULL, digest TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(sender,message_id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, subject TEXT NOT NULL, details TEXT NOT NULL, observed INTEGER NOT NULL);
      PRAGMA user_version=1;
    `);
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(type, subject, details = {}) { this.db.prepare('INSERT INTO events(type,subject,details,observed) VALUES(?,?,?,?)').run(type, subject, canonical(details), this.clock()); }
  control() { const row = this.db.prepare('SELECT * FROM control WHERE id=1').get(); if (!row) fail('UNINITIALIZED', 'Initialize the factory first.'); return { ...row, policy: JSON.parse(row.policy) }; }
  active() { const control = this.control(); if (control.status !== 'active') fail('PAUSED', 'Factory is paused.'); return control; }
  initialize({ mission, budgetCents, maxCells = 4, maxDepth = 2 }) {
    if (typeof mission !== 'string' || !mission.trim()) fail('INVALID', 'Mission is required.');
    const policy = { mission, budgetCents: integer(budgetCents, 'budgetCents'), maxCells: integer(maxCells, 'maxCells', 1), maxDepth: integer(maxDepth, 'maxDepth') };
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM control WHERE id=1').get();
      if (previous) { if (previous.policy !== canonical(policy)) fail('CONFLICT', 'Factory already has a different policy.'); return this.control(); }
      this.db.prepare('INSERT INTO control VALUES(1,1,?,?)').run('active', canonical(policy));
      this.db.prepare('INSERT INTO cells(id,parent_id,depth,role,allocation,status,purpose,heartbeat) VALUES(?,NULL,0,?,?,?, ?,?)').run('root', 'coordinator', budgetCents, 'ready', mission, this.clock());
      this.event('initialized', 'root', policy); return this.control();
    });
  }
  reserveCell({ cellId, parentId = 'root', role = 'developer', budgetCents, purpose }) {
    id(cellId); id(parentId); integer(budgetCents, 'budgetCents');
    if (!['developer','verifier','watcher','coordinator'].includes(role) || typeof purpose !== 'string' || !purpose.trim()) fail('INVALID', 'Role and purpose are required.');
    return this.transaction(() => {
      const control = this.active();
      const existing = this.db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
      if (existing) {
        if (existing.parent_id !== parentId || existing.role !== role || existing.allocation !== budgetCents || existing.purpose !== purpose) fail('CONFLICT', 'Cell identity is already bound to another allocation.');
        return existing;
      }
      const parent = this.db.prepare('SELECT * FROM cells WHERE id=? AND status IN (\'ready\',\'reserved\')').get(parentId);
      if (!parent) fail('PARENT', 'Admitted parent is required.');
      const count = this.db.prepare("SELECT count(*) AS n FROM cells WHERE status!='retired'").get().n;
      if (count >= control.policy.maxCells || parent.depth + 1 > control.policy.maxDepth) fail('CAPACITY', 'Cell count or delegation depth would exceed policy.');
      const allocated = this.db.prepare("SELECT coalesce(sum(allocation),0) AS n FROM cells WHERE parent_id=? AND status!='retired'").get(parentId).n;
      if (parent.spent + allocated + budgetCents > parent.allocation) fail('BUDGET', 'Insufficient unallocated parent budget.');
      this.db.prepare('INSERT INTO cells(id,parent_id,depth,role,allocation,status,purpose,heartbeat) VALUES(?,?,?,?,?,?,?,?)').run(cellId,parentId,parent.depth+1,role,budgetCents,'reserved',purpose,this.clock());
      this.event('cell_reserved', cellId, { parentId, role, budgetCents });
      return this.db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
    });
  }
  enrollCell(cellId) { return this.transaction(() => { this.active(); const cell = this.db.prepare('SELECT * FROM cells WHERE id=?').get(id(cellId)); if (!cell || cell.status === 'retired') fail('CELL', 'Cell is unavailable.'); this.db.prepare('UPDATE cells SET status=?,heartbeat=? WHERE id=?').run('ready',this.clock(),cellId); this.event('cell_enrolled',cellId); return { cellId, status: 'ready' }; }); }
  heartbeat(cellId) { const result = this.db.prepare("UPDATE cells SET heartbeat=? WHERE id=? AND status='ready'").run(this.clock(),id(cellId)); if (!result.changes) fail('CELL','Ready cell is required.'); return { cellId, observed: this.clock() }; }
  createTask({ taskId, projectId, branch, specification }) {
    id(taskId); id(projectId);
    if (typeof branch !== 'string' || !/^codex\/[a-zA-Z0-9/_-]+$/.test(branch) || !specification?.problem || !specification?.acceptance || !specification?.baseline) fail('INVALID', 'Task requires a codex branch, problem, acceptance and baseline.');
    const payload = canonical(specification), hash = digest(specification);
    return this.transaction(() => {
      this.active(); const previous = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      if (previous) { if (previous.project_id !== projectId || previous.branch !== branch || previous.spec_digest !== hash) fail('CONFLICT', 'Task key has different input.'); return this.task(taskId); }
      this.db.prepare('INSERT INTO tasks(id,project_id,branch,specification,spec_digest,status) VALUES(?,?,?,?,?,?)').run(taskId,projectId,branch,payload,hash,'ready');
      this.event('task_created',taskId,{projectId,branch,specDigest:hash}); return this.task(taskId);
    });
  }
  task(taskId) { const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id(taskId)); if (!task) fail('TASK','Task not found.'); delete task.token_hash; return { ...task, specification:JSON.parse(task.specification), candidate:task.candidate?JSON.parse(task.candidate):null, review:task.review?JSON.parse(task.review):null }; }
  openEffects(scope, scopeId) { return this.db.prepare(`SELECT key,state FROM effects WHERE scope=? AND scope_id=? AND state IN ${OPEN_EFFECTS}`).all(scope,scopeId); }
  claimTask(taskId, cellId, ttlMs = 60000) {
    id(taskId); id(cellId); integer(ttlMs,'ttlMs',1);
    return this.transaction(() => {
      const control = this.active(); const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      const cell = this.db.prepare("SELECT * FROM cells WHERE id=? AND status='ready'").get(cellId);
      if (!cell || !['developer','coordinator'].includes(cell.role)) fail('CELL','Ready developer/coordinator is required.');
      if (!task || !['ready','running'].includes(task.status)) fail('TASK','Task cannot be claimed.');
      if (task.status === 'running' && task.control_epoch===control.epoch && task.expires > this.clock()) fail('BUSY','Task lease is still held.');
      if (this.openEffects('task',taskId).length) fail('UNRECONCILED','Prior task effects must be reconciled before takeover.');
      const token = randomBytes(32).toString('base64url'), epoch = task.epoch+1, expires = this.clock()+ttlMs;
      this.db.prepare('UPDATE tasks SET status=?,owner=?,epoch=?,token_hash=?,expires=?,control_epoch=? WHERE id=?').run('running',cellId,epoch,tokenHash(token),expires,control.epoch,taskId);
      this.event('task_claimed',taskId,{cellId,epoch,controlEpoch:control.epoch});
      return {scope:'task',scopeId:taskId,cellId,epoch,controlEpoch:control.epoch,expires,token};
    });
  }
  /** Trusted-local handoff, including while paused; no operational completion claim. */
  releaseTask(taskId, input) {
    id(taskId);
    const request = closureInput(input, ['closureId','expectedAttempt','expectedOwner','expectedStatus','expectedTaskControlEpoch','expectedFactoryEpoch']);
    id(request.closureId); id(request.expectedOwner); integer(request.expectedAttempt,'expectedAttempt',1);
    integer(request.expectedTaskControlEpoch,'expectedTaskControlEpoch',1); integer(request.expectedFactoryEpoch,'expectedFactoryEpoch',1);
    if (request.expectedStatus !== 'running') fail('INVALID', 'Release requires the exact running identity.');
    const requestDigest = digest({ taskId, ...request });
    return this.transaction(() => {
      const control = this.control(), task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      const previous = closureRecord(this, request.closureId, 'task_released', taskId, requestDigest);
      if (previous) {
        if (!task || task.status !== 'ready' || task.epoch !== request.expectedAttempt || task.owner !== null
            || task.token_hash !== null || task.expires !== null || task.control_epoch !== null) fail('STALE', 'A later task claim fences this release replay.');
        return previous.result;
      }
      if (control.epoch !== request.expectedFactoryEpoch || !task || task.status !== request.expectedStatus
          || task.owner !== request.expectedOwner || task.epoch !== request.expectedAttempt
          || task.control_epoch !== request.expectedTaskControlEpoch) fail('STALE', 'Task or factory identity changed before release.');
      if (task.candidate !== null || task.review !== null) fail('TASK', 'Submitted work must retain its candidate and review state.');
      if (causalOpenEffects(this, { taskIds: [taskId] }).length) fail('UNRECONCILED', 'Causal task, delivery or cleanup effects remain open.');
      const result = { taskId, status: 'ready', attempt: task.epoch, previousOwner: task.owner, previousTaskControlEpoch: task.control_epoch };
      this.db.prepare("UPDATE tasks SET status='ready',owner=NULL,token_hash=NULL,expires=NULL,control_epoch=NULL WHERE id=?").run(taskId);
      this.event('task_released', taskId, { closureId: request.closureId, requestDigest, expectedFactoryEpoch: request.expectedFactoryEpoch, result });
      return result;
    });
  }
  /** Logical closure only. Every provision-bound identity requires a later provider-evidence path. */
  retireCell(cellId, input) {
    id(cellId);
    const request = closureInput(input, ['closureId','expectedParent','expectedStatus','expectedAllocation','expectedSpent','expectedFactoryEpoch']);
    return this.#retireCell(cellId,request,null,false);
  }
  /** Provider-bound closure requires the built-in inspector's opaque, fresh capability. */
  retireProvisionedCell(cellId, input, proof) {
    id(cellId);
    const request = closureInput(input, ['closureId','expectedParent','expectedStatus','expectedAllocation','expectedSpent','expectedFactoryEpoch','provisionKey','retirementKey']);
    id(request.provisionKey); id(request.retirementKey);
    return this.#retireCell(cellId,request,proof,true);
  }
  #retireCell(cellId, request, proof, provisioned) {
    id(request.closureId); id(request.expectedParent); integer(request.expectedAllocation,'expectedAllocation');
    integer(request.expectedSpent,'expectedSpent'); integer(request.expectedFactoryEpoch,'expectedFactoryEpoch',1);
    if (!['reserved','ready'].includes(request.expectedStatus) || cellId === 'root') fail('CELL', 'Only a non-root reserved or ready leaf may retire.');
    const requestDigest = digest({ cellId, ...request });
    return this.transaction(() => {
      const control = this.control(), cell = this.db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
      const previous = closureRecord(this, request.closureId, 'cell_retired', cellId, requestDigest);
      if (previous) {
        if (!cell || cell.status !== 'retired' || cell.parent_id !== request.expectedParent
            || cell.allocation !== request.expectedAllocation || cell.spent !== request.expectedSpent) fail('STALE', 'Retired cell identity changed.');
        return previous.result;
      }
      if (control.epoch !== request.expectedFactoryEpoch || !cell || cell.parent_id !== request.expectedParent
          || cell.status !== request.expectedStatus || cell.allocation !== request.expectedAllocation || cell.spent !== request.expectedSpent) fail('STALE', 'Cell or factory identity changed before retirement.');
      const parent = this.db.prepare('SELECT * FROM cells WHERE id=?').get(cell.parent_id);
      if (!parent || !['reserved','ready'].includes(parent.status)) fail('PARENT', 'An admitted parent is required.');
      if (this.db.prepare("SELECT id FROM cells WHERE parent_id=? AND status!='retired'").get(cellId)) fail('CHILDREN', 'Non-retired children must close first.');
      const tasks = this.db.prepare('SELECT id,status FROM tasks WHERE owner=?').all(cellId);
      if (tasks.some(task => task.status === 'running')) fail('TASK', 'Running tasks must be explicitly released before retirement.');
      validateProvisionBindings(this);
      const binding = this.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get('cell:' + cellId);
      if (causalOpenEffects(this, { cellId, taskIds: tasks.map(task => task.id), provisionKeys: binding ? [binding.effect_key] : [] }).length) fail('UNRECONCILED', 'Causal task, delivery, provision or cleanup effects remain open.');
      if (binding && !provisioned) fail('PROVISIONED_CELL', 'Provision-bound cells require a genuine provider-evidence retirement path.');
      if (provisioned && (!binding || binding.effect_key !== request.provisionKey)) fail('PROVISION_BINDING', 'The exact provision-bound cell is required.');
      const siblings = this.db.prepare("SELECT id,allocation,spent FROM cells WHERE parent_id=? AND status!='retired'").all(parent.id);
      for (const row of [cell, parent, ...siblings]) {
        integer(row.allocation,'allocation'); integer(row.spent,'spent');
        if (row.spent > row.allocation) fail('BUDGET', 'Logical spent exceeds allocation.');
      }
      if (parent.id === 'root' && parent.allocation !== integer(control.policy.budgetCents,'budgetCents')) fail('BUDGET', 'Root allocation does not match its immutable logical budget policy.');
      const allocated = siblings.reduce((sum, sibling) => sum + BigInt(sibling.allocation), 0n);
      const newSpent = BigInt(parent.spent) + BigInt(cell.spent);
      if (BigInt(parent.spent) + allocated > BigInt(parent.allocation) || newSpent > BigInt(Number.MAX_SAFE_INTEGER)
          || newSpent + allocated - BigInt(cell.allocation) > BigInt(parent.allocation)) fail('BUDGET', 'Logical allocation conservation failed.');
      const resource = provisioned ? consumeProviderRetirementProof(proof,this,cellId,request) : null;
      if (provisioned && !resource) fail('PROVIDER_RETIREMENT_PROOF', 'A fresh bound provider inspection is required.');
      const result = { cellId, status: 'retired', parentId: parent.id, allocation: cell.allocation, spent: cell.spent,
        transferredLogicalCents: cell.spent, releasedLogicalCents: cell.allocation - cell.spent,
        resourceScope: resource?.resourceScope ?? 'no-recorded-provisioning-logical-only', workerQuiescence: 'unverified',
        ...(resource ? { resourceEvidence:resource } : {}) };
      this.db.prepare("UPDATE cells SET status='retired' WHERE id=?").run(cellId);
      this.db.prepare('UPDATE cells SET spent=? WHERE id=?').run(Number(newSpent),parent.id);
      this.db.prepare('UPDATE integrations SET expires=0 WHERE owner=?').run(cellId);
      this.db.prepare('UPDATE tasks SET token_hash=NULL,expires=NULL WHERE owner=?').run(cellId);
      this.event('cell_retired', cellId, { closureId: request.closureId, requestDigest, expectedFactoryEpoch: request.expectedFactoryEpoch, result });
      return result;
    });
  }
  authority(lease) {
    const control = this.active();
    if (!lease || !['task','project'].includes(lease.scope)) fail('AUTHORITY','Lease is required.');
    const row = lease.scope === 'task' ? this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id(lease.scopeId)) : this.db.prepare('SELECT * FROM integrations WHERE project_id=?').get(id(lease.scopeId));
    if (!row || (lease.scope==='task' && row.status!=='running') || row.owner!==lease.cellId || row.epoch!==lease.epoch || row.control_epoch!==lease.controlEpoch || control.epoch!==lease.controlEpoch || row.expires<=this.clock() || row.token_hash!==tokenHash(lease.token)) fail('STALE','Lease is stale, expired or belongs to another owner.');
    if (!this.db.prepare("SELECT id FROM cells WHERE id=? AND status='ready'").get(row.owner)) fail('STALE', 'Lease owner cell is no longer ready.');
    return row;
  }
  renew(lease, ttlMs=60000) { integer(ttlMs,'ttlMs',1); return this.transaction(() => { this.authority(lease); const expires=this.clock()+ttlMs; if (lease.scope==='task') this.db.prepare('UPDATE tasks SET expires=? WHERE id=?').run(expires,lease.scopeId); else this.db.prepare('UPDATE integrations SET expires=? WHERE project_id=?').run(expires,lease.scopeId); return {...lease,expires}; }); }
  submit(lease, { artifactPath }) { const candidate=evidence(artifactPath); return this.transaction(() => { this.authority(lease); if (lease.scope!=='task' || this.openEffects('task',lease.scopeId).length) fail('UNRECONCILED','Task effects must be settled before submission.'); this.db.prepare('UPDATE tasks SET status=?,candidate=?,token_hash=NULL WHERE id=?').run('review',canonical(candidate),lease.scopeId); this.event('candidate_submitted',lease.scopeId,candidate); return this.task(lease.scopeId); }); }
  reviewTask(taskId, reviewerId, { accepted, evidencePath }) {
    const record=evidence(evidencePath);
    if (typeof accepted!=='boolean') fail('INVALID','Review verdict must be boolean.');
    return this.transaction(() => {
      this.active(); const task=this.task(taskId), reviewer=this.db.prepare("SELECT * FROM cells WHERE id=? AND status='ready' AND role='verifier'").get(id(reviewerId));
      if (!reviewer || reviewerId===task.owner) fail('REVIEWER','Separate verifier cell is required.');
      if (task.status!=='review') fail('TASK','Task is not awaiting review.');
      if (evidence(task.candidate.path).sha256!==task.candidate.sha256) fail('EVIDENCE','Submitted candidate changed.');
      const review={...record,reviewerId,accepted,candidateDigest:task.candidate.sha256,specDigest:task.spec_digest,attempt:task.epoch};
      this.db.prepare('UPDATE tasks SET status=?,review=? WHERE id=?').run(accepted?'verified':'rejected',canonical(review),taskId);
      this.event('candidate_reviewed',taskId,review); return this.task(taskId);
    });
  }
  claimIntegration(projectId, cellId='root', ttlMs=60000) {
    id(projectId); id(cellId); integer(ttlMs,'ttlMs',1);
    return this.transaction(() => {
      const control=this.active(), cell=this.db.prepare("SELECT * FROM cells WHERE id=? AND status='ready' AND role='coordinator'").get(cellId);
      if (!cell) fail('CELL','Ready coordinator is required.');
      const old=this.db.prepare('SELECT * FROM integrations WHERE project_id=?').get(projectId);
      if (old && old.control_epoch===control.epoch && old.expires>this.clock()) fail('BUSY','Integration lease is still held.');
      if (this.openEffects('project',projectId).length) fail('UNRECONCILED','Prior delivery requires reconciliation.');
      const token=randomBytes(32).toString('base64url'), epoch=(old?.epoch??0)+1, expires=this.clock()+ttlMs;
      this.db.prepare('INSERT INTO integrations VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,token_hash=excluded.token_hash,expires=excluded.expires,control_epoch=excluded.control_epoch').run(projectId,cellId,epoch,tokenHash(token),expires,control.epoch);
      this.event('integration_claimed',projectId,{cellId,epoch}); return {scope:'project',scopeId:projectId,cellId,epoch,controlEpoch:control.epoch,expires,token};
    });
  }
  admitEffect(lease, { key, kind, request, taskId=null }) {
    id(key); if (!['provision','flow_call','retire','delivery'].includes(kind)) fail('INVALID','Unknown effect kind.');
    const hash=digest(request);
    return this.transaction(() => {
      const owner=this.authority(lease);
      const previous=this.db.prepare('SELECT * FROM effects WHERE key=?').get(key);
      if (previous) {
        if (previous.request_digest!==hash || previous.kind!==kind || previous.scope!==lease.scope || previous.scope_id!==lease.scopeId || previous.owner!==lease.cellId || previous.owner_epoch!==lease.epoch || previous.control_epoch!==lease.controlEpoch || previous.task_id!==(taskId??(lease.scope==='task'?lease.scopeId:null))) fail('CONFLICT','Effect key is already bound to another request or owner.');
        return {fresh:false,effect:this.effect(key)};
      }
      if (kind==='delivery') {
        const task=this.task(taskId);
        if (lease.scope!=='project' || task.project_id!==lease.scopeId || task.status!=='verified') fail('DELIVERY','Verified task and project integration authority are required.');
        const candidateBytes=readFileSync(task.candidate.path);
        if (createHash('sha256').update(candidateBytes).digest('hex')!==task.candidate.sha256 || evidence(task.review.path).sha256!==task.review.sha256) fail('EVIDENCE','Delivery evidence changed.');
        const candidate=JSON.parse(candidateBytes.toString('utf8')), target=task.specification.deliveryTarget;
        if(!target || request?.repository!==target.repository || request.ref!==target.ref || request.expectedHead!==task.specification.baseline || request.candidateHead!==candidate.candidateHead || candidate.repository!==target.repository || candidate.ref!==target.ref || candidate.baseline!==task.specification.baseline || candidate.branch!==task.branch || !/^[a-f0-9]{40}$/.test(request.candidateHead??'') || !/^[a-f0-9]{40}$/.test(request.expectedHead??'')) fail('DELIVERY_BINDING','Delivery target, baseline and candidate must match the reviewed task.');
      } else if (lease.scope!=='task') fail('AUTHORITY','Task authority is required.');
      if (this.openEffects(lease.scope,lease.scopeId).length) fail('UNRECONCILED','Previous external effect must settle before a conflicting effect.');
      if(kind==='provision') {
        const cell=this.db.prepare("SELECT * FROM cells WHERE id=? AND status='reserved'").get(id(request?.cellId));
        if(!cell || cell.parent_id!==lease.cellId || typeof request.app!=='string' || !/^[a-z][a-z0-9-]{2,62}$/.test(request.app)) fail('RESERVATION','Provisioning requires the owner\'s reserved child and an explicit app identity.');
        for(const target of ['cell:'+cell.id,'app:'+request.app]) if(this.db.prepare('SELECT * FROM effect_bindings WHERE target=?').get(target)) fail('CONFLICT','Provisioning target already has an intent. Reconcile it.');
      }
      const now=this.clock();
      this.db.prepare('INSERT INTO effects(key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(key,lease.scope,lease.scopeId,taskId??(lease.scope==='task'?lease.scopeId:null),owner.owner,lease.epoch,lease.controlEpoch,kind,hash,'accepted',now,now);
      if(kind==='provision') for(const target of ['cell:'+request.cellId,'app:'+request.app]) this.db.prepare('INSERT INTO effect_bindings VALUES(?,?)').run(target,key);
      this.event('effect_accepted',key,{kind,scope:lease.scope,scopeId:lease.scopeId,requestDigest:hash}); return {fresh:true,effect:this.effect(key)};
    });
  }
  effect(key) { const row=this.db.prepare('SELECT * FROM effects WHERE key=?').get(id(key)); if (!row) fail('EFFECT','Effect not found.'); return {...row,receipt:row.receipt?JSON.parse(row.receipt):null}; }
  /** Trusted local shutdown authority, restricted to an app already admitted for provisioning. */
  admitOwnedRetirement({key,app}) {
    id(key);
    if(typeof app!=='string' || !/^[a-z][a-z0-9-]{2,62}$/.test(app)) fail('INVALID','A recorded app identity is required.');
    return this.transaction(() => {
      const control=this.control();
      const binding=this.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get('app:'+app);
      if(!binding || this.effect(binding.effect_key).kind!=='provision') fail('RESERVATION','Retirement requires this controller\'s recorded provisioning intent.');
      const requestDigest=digest({app,provisionKey:binding.effect_key});
      const previous=this.db.prepare('SELECT * FROM effects WHERE key=?').get(key);
      if(previous) {
        if(previous.kind!=='retire' || previous.scope!=='cleanup' || previous.scope_id!==app || previous.request_digest!==requestDigest) fail('CONFLICT','Retirement key is bound to another intent.');
        return {fresh:false,effect:this.effect(key)};
      }
      if(this.openEffects('cleanup',app).length) fail('UNRECONCILED','Prior retirement must be reconciled before another attempt.');
      const now=this.clock();
      this.db.prepare('INSERT INTO effects(key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(key,'cleanup',app,null,'root',control.epoch,control.epoch,'retire',requestDigest,'accepted',now,now);
      this.event('owned_retirement_accepted',key,{app,provisionKey:binding.effect_key,controlEpoch:control.epoch});
      return {fresh:true,effect:this.effect(key)};
    });
  }
  startOwnedRetirement(key) {
    return this.transaction(() => {
      const row=this.effect(key);
      if(row.scope!=='cleanup' || row.kind!=='retire' || row.state!=='accepted') fail('EFFECT','Accepted owned retirement is required.');
      this.db.prepare('UPDATE effects SET state=?,updated=? WHERE key=?').run('running',this.clock(),key);
      return this.effect(key);
    });
  }
  startEffect(lease,key) { return this.transaction(() => { this.authority(lease); const row=this.effect(key); if (row.state!=='accepted' || row.scope!==lease.scope || row.scope_id!==lease.scopeId || row.owner_epoch!==lease.epoch) fail('EFFECT','Accepted effect belongs to another attempt.'); this.db.prepare('UPDATE effects SET state=?,updated=? WHERE key=?').run('running',this.clock(),key); return this.effect(key); }); }
  settleEffect(key, state, receipt={}) {
    if (!['succeeded','not_applied','unknown'].includes(state)) fail('INVALID','Invalid settlement.');
    return this.transaction(() => {
      const row=this.effect(key);
      if (!['accepted','running','unknown'].includes(row.state)) fail('EFFECT','Effect is already settled.');
      if(state==='not_applied' && row.state!=='accepted') fail('NEGATIVE_RECONCILIATION_UNSUPPORTED','A started external action cannot be declared not applied without executor and target reconciliation.');
      const metadata=safeReceipt(receipt);
      this.db.prepare('UPDATE effects SET state=?,receipt=?,updated=? WHERE key=?').run(state,canonical(metadata),this.clock(),key);
      this.event('effect_settled',key,{state,receipt:metadata}); return this.effect(key);
    });
  }
  reconcileEffect(key, { applied, evidencePath }) { if(typeof applied!=='boolean') fail('INVALID','Reconciliation outcome is required.'); const proof=evidence(evidencePath); return this.settleEffect(key,applied?'succeeded':'not_applied',{...proof,reconciled:true}); }
  /** A completed local Git CAS refusal is distinct from observing that a remote effect has not applied yet. */
  settleGitRefusal(key, proof) {
    return this.transaction(() => {
      const row=this.effect(key);
      if(row.kind!=='delivery' || row.scope!=='project' || !['running','unknown'].includes(row.state)) fail('GIT_REFUSAL_STATE','A started unsettled Git delivery is required.');
      const receipt=consumeGitRefusalProof(proof,this,row);
      if(!receipt) fail('GIT_REFUSAL_PROOF','A bound in-process Git refusal proof is required.');
      const metadata=safeReceipt(receipt);
      this.db.prepare('UPDATE effects SET state=?,receipt=?,updated=? WHERE key=?').run('not_applied',canonical(metadata),this.clock(),key);
      this.event('effect_settled',key,{state:'not_applied',receipt:metadata});
      return this.effect(key);
    });
  }
  deliverTask(taskId,key) {
    return this.transaction(() => {
      const task=this.task(taskId), effect=this.effect(key);
      if(effect.kind!=='delivery' || effect.task_id!==taskId || effect.state!=='succeeded') fail('DELIVERY','Successful matching delivery receipt is required.');
      if(task.status==='delivered') {
        const recorded=this.db.prepare("SELECT details FROM events WHERE type='task_delivered' AND subject=? ORDER BY seq DESC LIMIT 1").get(taskId);
        if(recorded && JSON.parse(recorded.details).effectKey===key) return task;
      }
      if(task.status!=='verified') fail('DELIVERY','Successful matching delivery receipt is required.');
      this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('delivered',taskId);
      this.event('task_delivered',taskId,{effectKey:key}); return this.task(taskId);
    });
  }
  sendMessage({ sender, messageId, recipient, taskId=null, attempt=null, payload }) {
    id(sender); id(messageId); id(recipient); const hash=digest({recipient,taskId,attempt,payload});
    return this.transaction(() => {
      const old=this.db.prepare('SELECT * FROM messages WHERE sender=? AND message_id=?').get(sender,messageId);
      if(old) {if(old.digest!==hash)fail('CONFLICT','Message identity has different input.');return {duplicate:true};}
      if(taskId) {const task=this.task(taskId);if(attempt!==task.epoch)fail('STALE','Message attempt is no longer current.');}
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(sender,messageId,recipient,taskId,attempt,canonical(payload),hash,this.clock());
      this.event('message_recorded',messageId,{sender,recipient,taskId,attempt}); return {duplicate:false};
    });
  }
  inbox(cellId) { return this.db.prepare('SELECT * FROM messages WHERE recipient=? ORDER BY created,message_id').all(id(cellId)).map(row=>({...row,payload:JSON.parse(row.payload)})); }
  pause() { return this.transaction(() => { const old=this.control(); if(old.status==='active'){this.db.prepare('UPDATE control SET status=?,epoch=epoch+1 WHERE id=1').run('paused');this.event('paused','root');} return this.status(); }); }
  resume() { return this.transaction(() => {const old=this.control();if(old.status==='paused'){this.db.prepare('UPDATE control SET status=?,epoch=epoch+1 WHERE id=1').run('active');this.event('resumed','root');}return this.status();}); }
  status() {
    const control=this.control(), cells=this.db.prepare('SELECT * FROM cells ORDER BY id').all(), tasks=this.db.prepare('SELECT id FROM tasks ORDER BY id').all().map(row=>this.task(row.id));
    const effects=this.db.prepare('SELECT key FROM effects ORDER BY created,key').all().map(row=>this.effect(row.key));
    const unresolved=effects.filter(effect=>['accepted','running','unknown'].includes(effect.state));
    return {schemaVersion:1,control,cells,tasks,effects,unresolvedEffects:unresolved.length,effectsDrained:unresolved.length===0,workerQuiescence:'unverified',scope:'local-coordinator'};
  }
}
