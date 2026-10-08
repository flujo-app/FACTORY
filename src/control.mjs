import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { safeReceipt } from './receipts.mjs';
import { consumeGitRefusalProof } from './git-effect.mjs';
import { consumeProviderRetirementProof } from './provider-retirement.mjs';
import { validateNativeMission, nativeMissionRequest, nativeMissionEffectKey } from './native-mission-contract.mjs';
import { validateGrowthPolicy } from './growth-policy.mjs';
import { validateWorkerPowerBinding, validateWorkerPowerQueue } from './worker-power-contract.mjs';
import { validateOriginalInferenceSpecification } from './original-inference-contract.mjs';
import { requireModelStepSchema, refuseMixedModelStepSchema, installModelStepMutationGuard, verifyModelStepManifestProof, materializeModelStepManifest,
  assertModelStepParentTerminal, modelStepCompletion, modelStepRequiredForTask, MODEL_STEP_DATABASE_VERSION, MODEL_PARENT_START_DATABASE_VERSION } from './model-step-contract.mjs';

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
function capacityGrowthPolicy(policy) {
  const keys = ['schemaVersion','grantId','generation','expiresAt','maxChildren','maxBudgetCents','allowedRoles','template','paid','native'];
  if (policy?.schemaVersion === 2) keys.push('growthMode');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).length !== keys.length
      || keys.some(key => !Object.hasOwn(policy,key)) || !Number.isSafeInteger(policy.maxBudgetCents) || policy.maxBudgetCents < 0
      || !(policy.schemaVersion === 1 && Number.isSafeInteger(policy.maxChildren) && policy.maxChildren >= 1 && policy.maxChildren <= 1000
        || policy.schemaVersion === 2 && policy.growthMode === 'budget-only' && policy.maxChildren === null)) {
    fail('CAPACITY_GRANT', 'Capacity grant growth policy is inconsistent.');
  }
  return policy;
}
function capacityRecord(row) {
  if (!row) return null;
  const record = JSON.parse(row.details), { grantDigest, ...binding } = record;
  const policy = capacityGrowthPolicy(record.policy);
  if (record.format !== 'factory-capacity-grant' || record.schemaVersion !== policy.schemaVersion
      || digest(binding) !== grantDigest || record.policy.grantId !== row.subject) fail('CAPACITY_GRANT', 'Capacity grant history is inconsistent.');
  return record;
}
function capacityTargets(grant, request) {
  const suffix = digest({ grantId: grant.policy.grantId, requestId: request.requestId });
  return { key: 'capacity.' + suffix, cellId: 'capacity.' + suffix,
    app: grant.policy.template.appPrefix + '-' + suffix.slice(0,24) };
}
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
  const records = control.db.prepare("SELECT type,subject,details FROM events WHERE type IN ('task_released','cell_retired','task_completed','task_cancelled')").all();
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
      || (['cleanup','worker'].includes(effect.scope) && apps.has(effect.scope_id)));
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

const TASK_CLOSURE_KEYS = ['closureId','expectedAttempt','expectedOwner','expectedStatus','expectedTaskControlEpoch','expectedFactoryEpoch'];
function taskClosureIdentity(request, statuses) {
  id(request.closureId); integer(request.expectedAttempt,'expectedAttempt'); integer(request.expectedFactoryEpoch,'expectedFactoryEpoch',1);
  if (!statuses.includes(request.expectedStatus)) fail('INVALID', 'Unsupported task closure state.');
  if (request.expectedOwner === null && request.expectedTaskControlEpoch === null) {
    if (request.expectedStatus !== 'ready') fail('INVALID', 'Only a ready task may have no recorded execution owner.');
  } else {
    id(request.expectedOwner); integer(request.expectedTaskControlEpoch,'expectedTaskControlEpoch',1); integer(request.expectedAttempt,'expectedAttempt',1);
  }
}
function operationContract(specification) {
  const operation = closureInput(specification.operation, ['kind','cellId','app']);
  if (!['provision','retire'].includes(operation.kind) || typeof operation.app !== 'string' || !/^[a-z][a-z0-9-]{2,62}$/.test(operation.app)) fail('INVALID', 'A bounded provision or retirement operation is required.');
  id(operation.cellId);
  const acceptance = closureInput(specification.acceptance,['scope']);
  if (acceptance.scope !== 'recorded-controller-operation-receipts-only') fail('INVALID', 'Operation acceptance must describe the exact recorded receipt scope.');
  if (Object.hasOwn(specification,'deliveryTarget')) fail('INVALID', 'An operation cannot carry a software delivery target.');
  return operation;
}
function conversationContract(specification) {
  const operation = closureInput(specification.operation,
    ['kind','cellId','app','conversationId','provisionKey','inputDigest','outputPath']);
  if (operation.kind !== 'flow_call' || typeof operation.app !== 'string'
    || !/^[a-z][a-z0-9-]{2,62}$/.test(operation.app)
    || typeof operation.conversationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operation.conversationId)
    || typeof operation.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(operation.inputDigest)
    || !isAbsolute(operation.outputPath)) fail('INVALID', 'A bounded conversation operation is required.');
  id(operation.cellId); id(operation.provisionKey);
  const acceptance = closureInput(specification.acceptance,['scope']);
  if (acceptance.scope !== 'recorded-controller-conversation-receipt-only'
    || Object.hasOwn(specification,'deliveryTarget')) fail('INVALID', 'Conversation acceptance must describe its recorded receipt scope.');
  return operation;
}
function retainedTaskIdentity(task) {
  return { projectId:task.project_id, branch:task.branch, specification:task.specification, specDigest:task.spec_digest,
    candidate:task.candidate, review:task.review };
}
function taskClosureRecord(control, taskId, request, type, requestDigest, terminalStatus) {
  const factory = control.control(), task = control.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const previous = closureRecord(control,request.closureId,type,taskId,requestDigest);
  if (previous) {
    if (!task || task.status !== terminalStatus || task.epoch !== request.expectedAttempt || task.owner !== null
        || task.token_hash !== null || task.expires !== null || task.control_epoch !== null
        || canonical(retainedTaskIdentity(task)) !== canonical(previous.retainedTask)
        || previous.retainedEffects && previous.retainedEffects.some(effect => canonical(control.effect(effect.key)) !== canonical(effect))) fail('STALE', 'Closed task identity changed.');
    return { task, previous };
  }
  if (factory.epoch !== request.expectedFactoryEpoch || !task || task.status !== request.expectedStatus
      || task.owner !== request.expectedOwner || task.epoch !== request.expectedAttempt
      || task.control_epoch !== request.expectedTaskControlEpoch) fail('STALE', 'Task or factory identity changed before closure.');
  if (digest(JSON.parse(task.specification)) !== task.spec_digest) fail('TASK', 'Immutable task specification is inconsistent.');
  const specification = JSON.parse(task.specification), provisionKeys = [];
  if (specification.taskType === 'operation' && specification.operation.kind === 'retire') {
    const operation = operationContract(specification);
    const cellBinding = control.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get('cell:'+operation.cellId);
    const appBinding = control.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get('app:'+operation.app);
    if (cellBinding || appBinding) provisionKeys.push(provisionIdentity(control,operation));
  }
  if (causalOpenEffects(control,{taskIds:[taskId],provisionKeys}).length) fail('UNRECONCILED', 'Causal task, delivery or cleanup effects remain open.');
  if (control.db.prepare("SELECT key FROM effects WHERE kind='delivery' AND task_id=? AND state='succeeded'").get(taskId)) fail('DELIVERY', 'Successful matching delivery must be finalized before task closure.');
  return { task, previous:null };
}
function operationReceipt(control, key, kind, task = null) {
  const effect = control.effect(key);
  let owner = task?.owner, controlEpoch = task?.control_epoch, claimSeq = null, releaseSeq = null;
  if (task) {
    const claims = control.db.prepare("SELECT seq,details FROM events WHERE type='task_claimed' AND subject=?").all(task.id)
      .map(row => ({...row,details:JSON.parse(row.details)})).filter(row => row.details.epoch === task.epoch);
    if (claims.length !== 1) fail('OPERATION_EVIDENCE', 'Original task claim history is required.');
    const claim = claims[0]; claimSeq = claim.seq;
    if (task.status === 'ready') {
      const released = control.db.prepare("SELECT seq,details FROM events WHERE type='task_released' AND subject=? ORDER BY seq DESC LIMIT 1").get(task.id);
      const result = released && JSON.parse(released.details).result;
      if (!released || !result || released.seq <= claim.seq || result.attempt !== task.epoch || result.previousOwner !== claim.details.cellId
          || result.previousTaskControlEpoch !== claim.details.controlEpoch) fail('OPERATION_EVIDENCE', 'Ready completion requires the exact released attempt provenance.');
      owner = claim.details.cellId; controlEpoch = claim.details.controlEpoch; releaseSeq = released.seq;
    } else if (owner !== claim.details.cellId || controlEpoch !== claim.details.controlEpoch) fail('OPERATION_EVIDENCE', 'Recorded owner and task claim disagree.');
  }
  if (effect.kind !== kind || effect.state !== 'succeeded' || (task && (effect.scope !== 'task' || effect.scope_id !== task.id
      || effect.task_id !== task.id || effect.owner !== owner || effect.owner_epoch !== task.epoch
      || effect.control_epoch !== controlEpoch))) fail('OPERATION_EVIDENCE', 'Successful operation must match this exact task attempt.');
  const accepted = control.db.prepare("SELECT seq,details FROM events WHERE type='effect_accepted' AND subject=?").all(key);
  const settled = control.db.prepare("SELECT seq,details FROM events WHERE type='effect_settled' AND subject=? ORDER BY seq DESC LIMIT 1").get(key);
  if (accepted.length !== 1 || !settled || settled.seq <= accepted[0].seq || claimSeq !== null && accepted[0].seq <= claimSeq
      || releaseSeq !== null && settled.seq >= releaseSeq) fail('OPERATION_EVIDENCE', 'Original admission and successful settlement history are required.');
  const admitted = JSON.parse(accepted[0].details), finished = JSON.parse(settled.details);
  if (admitted.kind !== kind || admitted.scope !== effect.scope || admitted.scopeId !== effect.scope_id || admitted.requestDigest !== effect.request_digest
      || finished.state !== 'succeeded' || canonical(finished.receipt) !== canonical(effect.receipt)) fail('OPERATION_EVIDENCE', 'Operation history does not match its receipt.');
  return effect;
}
function receiptMatchesApp(receipt, app) {
  return receipt && (Object.hasOwn(receipt,'app') || Object.hasOwn(receipt,'worker'))
    && (!Object.hasOwn(receipt,'app') || receipt.app === app) && (!Object.hasOwn(receipt,'worker') || receipt.worker === app);
}
function provisionIdentity(control, operation) {
  validateProvisionBindings(control);
  const cellBinding = control.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get('cell:'+operation.cellId);
  const appBinding = control.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get('app:'+operation.app);
  if (!cellBinding || !appBinding || cellBinding.effect_key !== appBinding.effect_key) fail('OPERATION_EVIDENCE', 'Exact cell and app provisioning identities are required.');
  return cellBinding.effect_key;
}

/** One local transactional authority. No distributed-consensus or provider-idempotency claim. */
export class FactoryControl {
  constructor(path, { clock = Date.now } = {}) {
    if (!isAbsolute(path)) fail('INVALID', 'Database path must be absolute.');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.clock = clock;
    this.db = new DatabaseSync(path);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    try {
      if (![0,1,2,MODEL_STEP_DATABASE_VERSION,MODEL_PARENT_START_DATABASE_VERSION].includes(version)) fail('SCHEMA', 'Unsupported factory schema.');
      refuseMixedModelStepSchema(this,version);
    } catch (error) { this.db.close(); throw error; }
    this.db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    if ([MODEL_STEP_DATABASE_VERSION,MODEL_PARENT_START_DATABASE_VERSION].includes(version)) { installModelStepMutationGuard(this); return; }
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
      PRAGMA user_version=${version || 1};
    `);
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    // A COMMIT may succeed before its acknowledgment fails. A subsequent
    // ROLLBACK failure must not replace the causal error; callers inspect state.
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  event(type, subject, details = {}) { this.db.prepare('INSERT INTO events(type,subject,details,observed) VALUES(?,?,?,?)').run(type, subject, canonical(details), this.clock()); }
  control() {
    const row = this.db.prepare('SELECT * FROM control WHERE id=1').get();
    if (!row) fail('UNINITIALIZED', 'Initialize the factory first.');
    let policy;
    try { policy = validateGrowthPolicy(JSON.parse(row.policy)); }
    catch { fail('POLICY', 'The durable factory growth policy is invalid.'); }
    integer(row.epoch, 'factory epoch', 1);
    if (!['active','paused'].includes(row.status)) fail('POLICY', 'The durable factory status is invalid.');
    return { ...row, policy };
  }
  active() { const control = this.control(); if (control.status !== 'active') fail('PAUSED', 'Factory is paused.'); return control; }
  initialize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID','An initialization policy is required.');
    const { mission, budgetCents } = input;
    if (typeof mission !== 'string' || !mission.trim()) fail('INVALID', 'Mission is required.');
    let policy;
    if (Object.hasOwn(input, 'growthMode')) {
      if (input.growthMode !== 'budget-only' || ['maxCells','maxDepth'].some(key => Object.hasOwn(input,key) && input[key] !== null)) {
        fail('INVALID', 'Budget-only growth cannot include numeric cell or depth ceilings.');
      }
      policy = { schemaVersion:2,mission,budgetCents:integer(budgetCents,'budgetCents'),growthMode:'budget-only',maxCells:null,maxDepth:null };
    } else {
      const { maxCells = 4, maxDepth = 2 } = input;
      policy = { mission,budgetCents:integer(budgetCents,'budgetCents'),maxCells:integer(maxCells,'maxCells',1),maxDepth:integer(maxDepth,'maxDepth') };
    }
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM control WHERE id=1').get();
      if (previous) { if (previous.policy !== canonical(policy)) fail('CONFLICT', 'Factory already has a different policy.'); return this.control(); }
      this.db.prepare('INSERT INTO control VALUES(1,1,?,?)').run('active', canonical(policy));
      this.db.prepare('INSERT INTO cells(id,parent_id,depth,role,allocation,status,purpose,heartbeat) VALUES(?,NULL,0,?,?,?, ?,?)').run('root', 'coordinator', budgetCents, 'ready', mission, this.clock());
      this.event('initialized', 'root', policy); return this.control();
    });
  }
  /** Trusted local policy change. It revokes old authority without changing any work or reopening admission. */
  useBudgetOnlyGrowth(input) {
    const request = closureInput(input, ['transitionId','expectedFactoryEpoch','expectedPolicyDigest']);
    id(request.transitionId); integer(request.expectedFactoryEpoch,'expectedFactoryEpoch',1);
    if (typeof request.expectedPolicyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedPolicyDigest)) fail('INVALID','An exact previous policy digest is required.');
    const requestDigest = digest(request);
    return this.transaction(() => {
      const current = this.control();
      if (current.status !== 'paused') fail('PAUSED','Pause admission before changing the growth policy.');
      const rows = this.db.prepare("SELECT details FROM events WHERE type='growth_policy_changed' AND subject=?").all(request.transitionId);
      if (rows.length > 1) fail('POLICY_HISTORY','Growth transition history is inconsistent.');
      if (rows.length) {
        let record;
        try { record = JSON.parse(rows[0].details); }
        catch { fail('POLICY_HISTORY','Growth transition history is invalid.'); }
        const keys=['format','schemaVersion','transitionId','request','requestDigest','previousFactoryEpoch','factoryEpoch','beforePolicy','beforePolicyDigest','afterPolicy','afterPolicyDigest','transitionDigest'];
        if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== keys.length || keys.some(key=>!Object.hasOwn(record,key))) fail('POLICY_HISTORY','Growth transition history is invalid.');
        const {transitionDigest,...binding}=record;
        if (digest(binding)!==transitionDigest) fail('POLICY_HISTORY','Growth transition history digest is invalid.');
        if (record.requestDigest !== requestDigest || canonical(record.request) !== canonical(request)) fail('CONFLICT','Growth transition identity is already bound to another request.');
        let before, after;
        try { before = validateGrowthPolicy(record.beforePolicy); after = validateGrowthPolicy(record.afterPolicy); }
        catch { fail('POLICY_HISTORY','Growth transition policy history is invalid.'); }
        if (record.format !== 'factory-growth-policy-transition' || record.schemaVersion !== 1 || record.transitionId !== request.transitionId
            || record.beforePolicyDigest !== digest(before) || record.beforePolicyDigest !== request.expectedPolicyDigest
            || record.afterPolicyDigest !== digest(after) || record.afterPolicyDigest !== digest(current.policy)
            || before.schemaVersion !== undefined || after.schemaVersion !== 2 || before.mission !== after.mission || before.budgetCents !== after.budgetCents
            || record.previousFactoryEpoch !== request.expectedFactoryEpoch || !Number.isSafeInteger(record.factoryEpoch)
            || record.factoryEpoch !== record.previousFactoryEpoch + 1 || current.epoch < record.factoryEpoch) fail('POLICY_HISTORY','Growth transition history does not match the durable policy.');
        return { control:current,transition:record,replayed:true };
      }
      if (current.epoch !== request.expectedFactoryEpoch || digest(current.policy) !== request.expectedPolicyDigest) fail('STALE','Factory epoch or growth policy changed before transition.');
      if (current.policy.schemaVersion === 2) fail('STATE','The factory already uses budget-only growth.');
      const factoryEpoch = integer(current.epoch + 1,'factory epoch',1);
      const afterPolicy = validateGrowthPolicy({schemaVersion:2,mission:current.policy.mission,budgetCents:current.policy.budgetCents,growthMode:'budget-only',maxCells:null,maxDepth:null});
      const binding = {format:'factory-growth-policy-transition',schemaVersion:1,transitionId:request.transitionId,request,requestDigest,
        previousFactoryEpoch:current.epoch,factoryEpoch,beforePolicy:current.policy,beforePolicyDigest:digest(current.policy),afterPolicy,afterPolicyDigest:digest(afterPolicy)};
      const transition={...binding,transitionDigest:digest(binding)};
      this.db.prepare('UPDATE control SET policy=?,epoch=? WHERE id=1').run(canonical(afterPolicy),factoryEpoch);
      this.event('growth_policy_changed',request.transitionId,transition);
      return {control:this.control(),transition,replayed:false};
    });
  }
  reserveCell(input) { return this.transaction(() => this.#reserveCell(input)); }
  #reserveCell({ cellId, parentId = 'root', role = 'developer', budgetCents, purpose }) {
    id(cellId); id(parentId); integer(budgetCents, 'budgetCents');
    if (!['developer','verifier','watcher','coordinator'].includes(role) || typeof purpose !== 'string' || !purpose.trim()) fail('INVALID', 'Role and purpose are required.');
      const control = this.active();
      const existing = this.db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
      if (existing) {
        if (existing.parent_id !== parentId || existing.role !== role || existing.allocation !== budgetCents || existing.purpose !== purpose) fail('CONFLICT', 'Cell identity is already bound to another allocation.');
        return existing;
      }
      const parent = this.db.prepare('SELECT * FROM cells WHERE id=? AND status IN (\'ready\',\'reserved\')').get(parentId);
      if (!parent) fail('PARENT', 'Admitted parent is required.');
      const depth = integer(integer(parent.depth,'parent depth') + 1,'child depth');
      integer(parent.spent,'parent spent'); integer(parent.allocation,'parent allocation');
      if (control.policy.schemaVersion === 2) {
        let allocated = 0n;
        for (const child of this.db.prepare("SELECT allocation FROM cells WHERE parent_id=? AND status!='retired'").iterate(parentId)) {
          allocated += BigInt(integer(child.allocation,'child allocation'));
        }
        if (BigInt(parent.spent) + allocated + BigInt(budgetCents) > BigInt(parent.allocation)) fail('BUDGET','Insufficient unallocated parent budget.');
      } else {
        const count = this.db.prepare("SELECT count(*) AS n FROM cells WHERE status!='retired'").get().n;
        if (count >= control.policy.maxCells || depth > control.policy.maxDepth) fail('CAPACITY', 'Cell count or delegation depth would exceed policy.');
        const allocated = this.db.prepare("SELECT coalesce(sum(allocation),0) AS n FROM cells WHERE parent_id=? AND status!='retired'").get(parentId).n;
        if (parent.spent + allocated + budgetCents > parent.allocation) fail('BUDGET', 'Insufficient unallocated parent budget.');
      }
      this.db.prepare('INSERT INTO cells(id,parent_id,depth,role,allocation,status,purpose,heartbeat) VALUES(?,?,?,?,?,?,?,?)').run(cellId,parentId,depth,role,budgetCents,'reserved',purpose,this.clock());
      this.event('cell_reserved', cellId, { parentId, role, budgetCents });
      return this.db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
  }
  /** Trusted-local standing policy. Peer payloads cannot issue or replace it. */
  issueCapacityGrant(lease, record) {
    const { grantDigest, ...binding } = record;
    id(record.policy?.grantId); integer(record.policy?.generation, 'generation', 1);
    capacityGrowthPolicy(record.policy);
    if (record.format !== 'factory-capacity-grant' || record.schemaVersion !== record.policy.schemaVersion || digest(binding) !== grantDigest
        || record.policy.generation !== record.transport?.generation) fail('CAPACITY_GRANT', 'An exact capacity policy binding is required.');
    return this.transaction(() => {
      this.#capacityAuthority(lease, record);
      if (record.policy.schemaVersion === 2 && this.control().policy.schemaVersion !== 2) fail('CAPACITY_GRANT','Budget-only grants require an explicit budget-only factory.');
      integer(record.inboxFloor, 'inboxFloor');
      const previous = this.capacityGrant(record.policy.grantId);
      if (previous && (previous.policy.schemaVersion !== record.policy.schemaVersion || previous.policy.growthMode !== record.policy.growthMode)) fail('CONFLICT','A grant identity cannot change its growth mode.');
      if (previous?.policy.generation === record.policy.generation) {
        const { inboxFloor: oldFloor, grantDigest: oldDigest, ...oldPolicy } = previous;
        const { inboxFloor: newFloor, grantDigest: newDigest, ...newPolicy } = record;
        if (digest(oldPolicy) !== digest(newPolicy)) fail('CONFLICT', 'Capacity grant generation is bound to another policy.');
        return previous; // Original eligibility floor is never refreshed on restart.
      }
      if (previous && record.policy.generation !== previous.policy.generation + 1) fail('CAPACITY_GRANT_GENERATION', 'A capacity grant must advance exactly one generation.');
      this.#capacityQuota(record, null);
      this.event('capacity_grant_issued', record.policy.grantId, record);
      return record;
    });
  }
  capacityGrant(grantId) {
    return capacityRecord(this.db.prepare("SELECT subject,details FROM events WHERE type='capacity_grant_issued' AND subject=? ORDER BY seq DESC LIMIT 1").get(id(grantId)));
  }
  #capacityAuthority(lease, grant) {
    const task = this.authority(lease), a = grant.authority, p = grant.policy;
    if (lease.scope !== 'task' || a.taskId !== lease.scopeId || a.parentId !== lease.cellId
        || a.attempt !== lease.epoch || a.controlEpoch !== lease.controlEpoch || a.specDigest !== task.spec_digest
        || digest(JSON.parse(task.specification)) !== task.spec_digest) fail('CAPACITY_AUTHORITY', 'Capacity grant does not match the exact task attempt.');
    if (!Number.isSafeInteger(p.expiresAt) || p.expiresAt <= this.clock() || p.expiresAt > task.expires) fail('CAPACITY_GRANT_EXPIRED', 'Capacity grant must remain inside its task lease.');
  }
  #capacityQuota(grant, additionalBudget) {
    const p = grant.policy;
    capacityGrowthPolicy(p);
    let count = 0n, budget = 0n;
    for (const row of this.db.prepare("SELECT details FROM events WHERE type='capacity_admitted' AND subject=?").iterate(p.grantId)) {
      const admission = JSON.parse(row.details);
      integer(admission.request.budgetCents, 'admitted budget');
      budget += BigInt(admission.request.budgetCents); count++;
    }
    if ((p.schemaVersion === 1 && count + (additionalBudget === null ? 0n : 1n) > BigInt(p.maxChildren))
        || budget + BigInt(additionalBudget ?? 0) > BigInt(p.maxBudgetCents)) fail('CAPACITY_GRANT_QUOTA', 'Standing grant count or logical budget is exhausted.');
  }
  #capacityBound(lease, { grantId, generation, grantDigest }) {
    const grant = this.capacityGrant(grantId);
    if (!grant || grant.policy.generation !== generation || grant.grantDigest !== grantDigest) fail('CAPACITY_GRANT_GENERATION', 'Capacity grant is missing or superseded.');
    this.#capacityAuthority(lease, grant);
    return grant;
  }
  /** Child allocation, unique provision binding, quota debit and causal inbox identity share one COMMIT. */
  admitCapacityProvision(lease, input) {
    return this.transaction(() => {
      const grant = this.#capacityBound(lease, input), request = closureInput(input.request,['requestId','role','budgetCents','purpose']);
      id(request.requestId); integer(request.budgetCents,'budgetCents',1);
      if (!grant.policy.allowedRoles.includes(request.role) || typeof request.purpose !== 'string' || !request.purpose.trim()
          || request.purpose.length > 512 || request.budgetCents > grant.policy.paid.ceilingCents) fail('CAPACITY_REQUEST', 'Request exceeds its standing grant.');
      if (digest(input.nativeProof) !== digest(grant.policy.native)) fail('CAPACITY_NATIVE', 'Native snapshot identity does not match the grant.');
      id(input.messageId); integer(input.inboxSequence,'inboxSequence',1);
      if (input.inboxSequence <= grant.inboxFloor || !/^[a-f0-9]{64}$/.test(input.messageDigest ?? '')) fail('CAPACITY_INBOX_FLOOR', 'A post-issuance committed request is required.');
      const target = capacityTargets(grant, request), provisionRequest = { cellId:target.cellId,app:target.app,...grant.policy.template };
      delete provisionRequest.appPrefix;
      const admission = { schemaVersion:1, grantId:input.grantId, generation:input.generation, grantDigest:input.grantDigest,
        request, nativeProof:input.nativeProof, messageId:input.messageId, messageDigest:input.messageDigest, inboxSequence:input.inboxSequence,
        ...target, provisionRequest, requestDigest:digest(provisionRequest) };
      const previous = this.db.prepare("SELECT details FROM events WHERE type='capacity_admitted' AND subject=? AND json_extract(details,'$.request.requestId')=?").get(input.grantId,request.requestId);
      if (previous) {
        if (canonical(JSON.parse(previous.details)) !== canonical(admission)) fail('CONFLICT', 'Capacity request identity is permanently bound to its original input.');
        const effect = this.effect(target.key), cell = this.db.prepare('SELECT * FROM cells WHERE id=?').get(target.cellId);
        if (effect.kind !== 'provision' || effect.request_digest !== admission.requestDigest || effect.owner !== lease.cellId
            || effect.owner_epoch !== lease.epoch || effect.control_epoch !== lease.controlEpoch || effect.scope_id !== lease.scopeId
            || !cell || cell.parent_id !== lease.cellId || cell.role !== request.role || cell.allocation !== request.budgetCents || cell.purpose !== request.purpose
            || ['cell:'+target.cellId,'app:'+target.app].some(binding => this.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get(binding)?.effect_key !== target.key)) fail('CAPACITY_HISTORY', 'Original capacity binding is inconsistent.');
        return { fresh:false, admission, effect };
      }
      if (this.db.prepare('SELECT key FROM effects WHERE key=?').get(target.key)
          || this.db.prepare('SELECT id FROM cells WHERE id=?').get(target.cellId)) fail('CONFLICT', 'Capacity target already has another intent.');
      this.#capacityQuota(grant, request.budgetCents);
      this.#reserveCell({ cellId:target.cellId,parentId:lease.cellId,role:request.role,budgetCents:request.budgetCents,purpose:request.purpose });
      const accepted = this.#admitEffect(lease,{key:target.key,kind:'provision',request:provisionRequest});
      if (!accepted.fresh) fail('CONFLICT','Capacity effect already exists.');
      this.event('capacity_admitted', input.grantId, admission);
      return { fresh:true, admission, effect:accepted.effect };
    });
  }
  startCapacityProvision(lease, binding) {
    return this.transaction(() => {
      this.#capacityBound(lease,binding);
      const row = this.effect(binding.key);
      if (row.state !== 'accepted' || row.kind !== 'provision' || row.scope !== 'task' || row.scope_id !== lease.scopeId
          || row.owner !== lease.cellId || row.owner_epoch !== lease.epoch || row.control_epoch !== lease.controlEpoch) fail('EFFECT','An unstarted matching capacity effect is required.');
      const recorded = this.db.prepare("SELECT details FROM events WHERE type='capacity_admitted' AND subject=? AND json_extract(details,'$.key')=?").get(binding.grantId,binding.key);
      if (!recorded || JSON.parse(recorded.details).grantDigest !== binding.grantDigest) fail('CAPACITY_HISTORY','Capacity admission history is missing.');
      this.db.prepare('UPDATE effects SET state=?,updated=? WHERE key=?').run('running',this.clock(),binding.key);
      return this.effect(binding.key);
    });
  }
  enrollCell(cellId) { return this.transaction(() => { this.active(); const cell = this.db.prepare('SELECT * FROM cells WHERE id=?').get(id(cellId)); if (!cell || cell.status === 'retired') fail('CELL', 'Cell is unavailable.'); this.db.prepare('UPDATE cells SET status=?,heartbeat=? WHERE id=?').run('ready',this.clock(),cellId); this.event('cell_enrolled',cellId); return { cellId, status: 'ready' }; }); }
  heartbeat(cellId) { const result = this.db.prepare("UPDATE cells SET heartbeat=? WHERE id=? AND status='ready'").run(this.clock(),id(cellId)); if (!result.changes) fail('CELL','Ready cell is required.'); return { cellId, observed: this.clock() }; }
  createTask({ taskId, projectId, branch, specification }) {
    id(taskId); id(projectId);
    if (typeof branch !== 'string' || !/^codex\/[a-zA-Z0-9/_-]+$/.test(branch) || !specification?.problem || !specification?.acceptance || !specification?.baseline) fail('INVALID', 'Task requires a codex branch, problem, acceptance and baseline.');
    if (Object.hasOwn(specification,'taskType') && !['software','operation','conversation'].includes(specification.taskType)) fail('INVALID', 'Unsupported immutable task type.');
    if (specification.taskType === 'operation') operationContract(specification);
    else if (specification.taskType === 'conversation') conversationContract(specification);
    else if (Object.hasOwn(specification,'operation')) fail('INVALID', 'An operation contract requires an explicit operation task type.');
    if(Object.hasOwn(specification,'nativeMission')) {
      if(['operation','conversation'].includes(specification.taskType)) fail('INVALID','Native mission execution requires a software task.');
      validateNativeMission(specification.nativeMission);
    }
    if (Object.hasOwn(specification,'originalInference')) {
      if (specification.taskType !== 'software' || !specification.nativeMission) fail('MODEL_STEP_SPECIFICATION','Original model-step tasks require explicit software/native identity.');
      validateOriginalInferenceSpecification(specification.originalInference);
      requireModelStepSchema(this);
    }
    const payload = canonical(specification), hash = digest(specification);
    return this.transaction(() => {
      this.active(); const previous = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      if (previous) { if (previous.project_id !== projectId || previous.branch !== branch || previous.spec_digest !== hash) fail('CONFLICT', 'Task key has different input.'); return this.task(taskId); }
      if(specification.nativeMission && this.db.prepare('SELECT specification FROM tasks').all().some(row=>JSON.parse(row.specification).nativeMission?.missionId===specification.nativeMission.missionId))fail('NATIVE_MISSION_ID','Mission identity is already assigned to another task.');
      this.db.prepare('INSERT INTO tasks(id,project_id,branch,specification,spec_digest,status) VALUES(?,?,?,?,?,?)').run(taskId,projectId,branch,payload,hash,'ready');
      this.event('task_created',taskId,{projectId,branch,specDigest:hash}); return this.task(taskId);
    });
  }
  task(taskId) { const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id(taskId)); if (!task) fail('TASK','Task not found.'); delete task.token_hash; return { ...task, specification:JSON.parse(task.specification), candidate:task.candidate?JSON.parse(task.candidate):null, review:task.review?JSON.parse(task.review):null }; }
  openEffects(scope, scopeId) { return this.db.prepare(`SELECT key,state FROM effects WHERE scope=? AND scope_id=? AND state IN ${OPEN_EFFECTS}`).all(scope,scopeId); }
  openTaskEffects(taskId) {
    return this.db.prepare(`SELECT key,state FROM effects WHERE ((scope='task' AND scope_id=?) OR (scope='worker' AND task_id=?)) AND state IN ${OPEN_EFFECTS}`).all(taskId,taskId);
  }
  claimTask(taskId, cellId, ttlMs = 60000) {
    id(taskId); id(cellId); integer(ttlMs,'ttlMs',1);
    return this.transaction(() => this.#claimTask(taskId,cellId,ttlMs));
  }
  #claimTask(taskId,cellId,ttlMs) {
      const control = this.active(); const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      const cell = this.db.prepare("SELECT * FROM cells WHERE id=? AND status='ready'").get(cellId);
      if (!cell || !['developer','coordinator'].includes(cell.role)) fail('CELL','Ready developer/coordinator is required.');
      if (!task || !['ready','running'].includes(task.status)) fail('TASK','Task cannot be claimed.');
      if (task.status === 'running' && task.control_epoch===control.epoch && task.expires > this.clock()) fail('BUSY','Task lease is still held.');
      if (this.openTaskEffects(taskId).length) fail('UNRECONCILED','Prior task effects must be reconciled before takeover.');
      for(const row of this.db.prepare("SELECT subject,details FROM events WHERE type='worker_power_enrolled'").all()) {
        const binding=JSON.parse(row.details).binding;
        if(binding.cellId===cellId)this.assertWorkerPowerReady(row.subject,binding.worker);
      }
      const token = randomBytes(32).toString('base64url'), epoch = task.epoch+1, expires = this.clock()+ttlMs;
      this.db.prepare('UPDATE tasks SET status=?,owner=?,epoch=?,token_hash=?,expires=?,control_epoch=? WHERE id=?').run('running',cellId,epoch,tokenHash(token),expires,control.epoch,taskId);
      this.event('task_claimed',taskId,{cellId,epoch,controlEpoch:control.epoch});
      return {scope:'task',scopeId:taskId,cellId,epoch,controlEpoch:control.epoch,expires,token};
  }
  #nativeMissionTarget(task) {
    const m=validateNativeMission(task.specification.nativeMission),cell=this.db.prepare('SELECT * FROM cells WHERE id=?').get(m.cellId);
    const effect=this.effect(m.provisionKey);
    if(!cell || !['reserved','ready'].includes(cell.status) || !['developer','coordinator'].includes(cell.role)
      || effect.kind!=='provision' || effect.state!=='succeeded' || effect.owner!==cell.parent_id
      || effect.receipt?.worker!==m.app || effect.receipt?.app!==m.app || effect.receipt?.state!=='ready'
      || ['cell:'+m.cellId,'app:'+m.app].some(target=>this.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get(target)?.effect_key!==m.provisionKey)
      || this.db.prepare("SELECT key FROM effects WHERE kind='retire' AND scope_id=?").get(m.app)
      || this.db.prepare("SELECT t.specification FROM effects e JOIN tasks t ON t.id=e.task_id WHERE e.kind='retire'").all()
        .some(row=>JSON.parse(row.specification).operation?.app===m.app)) fail('NATIVE_MISSION_TARGET','An available provision-bound worker is required.');
    this.assertWorkerPowerReady(m.app, m.worker);
    return m;
  }
  /** Opt-in trusted-local profile enrollment; live transport verification belongs to the power client. */
  enrollWorkerPower(lease, input) {
    const binding=validateWorkerPowerBinding(input),bindingDigest=digest(binding);
    return this.transaction(()=>{
      this.authority(lease);this.#workerPowerOwner(binding,lease.cellId);
      const rows=this.db.prepare("SELECT details FROM events WHERE type='worker_power_enrolled' AND subject=?").all(binding.app);
      if(rows.length) { const prior=this.workerPowerBinding(binding.app);if(digest(prior)!==bindingDigest)fail('CONFLICT','Worker power profile is immutable.');return prior; }
      this.event('worker_power_enrolled',binding.app,{binding,bindingDigest,taskId:lease.scopeId,owner:lease.cellId,
        ownerEpoch:lease.epoch,controlEpoch:lease.controlEpoch,scope:'explicit-existing-machine-profile'});
      return structuredClone(binding);
    });
  }
  workerPowerBinding(app) {
    const rows=this.db.prepare("SELECT details FROM events WHERE type='worker_power_enrolled' AND subject=?").all(app);
    if(rows.length!==1)fail('WORKER_POWER_ENROLLMENT','One explicitly enrolled worker power profile is required.');
    const record=JSON.parse(rows[0].details),binding=validateWorkerPowerBinding(record.binding);
    if(binding.app!==app || digest(binding)!==record.bindingDigest)fail('WORKER_POWER_HISTORY','Worker power enrollment changed.');
    return binding;
  }
  #workerPowerOwner(binding,owner) {
    const cell=this.db.prepare('SELECT * FROM cells WHERE id=?').get(binding.cellId),effect=this.effect(binding.provisionKey);
    if(!cell || !['reserved','ready'].includes(cell.status) || cell.parent_id!==owner
      || effect.kind!=='provision' || effect.state!=='succeeded' || effect.owner!==owner
      || effect.receipt?.worker!==binding.app || effect.receipt?.app!==binding.app || effect.receipt?.state!=='ready'
      || ['cell:'+binding.cellId,'app:'+binding.app].some(target=>this.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get(target)?.effect_key!==binding.provisionKey)
      || this.db.prepare("SELECT key FROM effects WHERE kind='retire' AND scope_id=?").get(binding.app)
      || this.db.prepare("SELECT t.specification FROM effects e JOIN tasks t ON t.id=e.task_id WHERE e.kind='retire'").all()
        .some(row=>JSON.parse(row.specification).operation?.app===binding.app))fail('WORKER_POWER_OWNER','An available owned provision-bound worker is required.');
  }
  #workerPowerIdle(binding,exceptKey=null) {
    if(this.db.prepare("SELECT id FROM tasks WHERE owner=? AND status='running'").get(binding.cellId))fail('WORKER_POWER_BUSY','Worker has a live task.');
    const tasks=new Set(this.db.prepare('SELECT id,specification FROM tasks').all().filter(row=>{
      const mission=JSON.parse(row.specification).nativeMission;return mission?.cellId===binding.cellId || mission?.app===binding.app;
    }).map(row=>row.id));
    if(this.db.prepare(`SELECT key,owner,task_id,scope,scope_id FROM effects WHERE state IN ${OPEN_EFFECTS}`).all().some(effect=>effect.key!==exceptKey
      && (effect.owner===binding.cellId || tasks.has(effect.task_id) || effect.scope==='task' && tasks.has(effect.scope_id)
        || ['worker','cleanup'].includes(effect.scope) && effect.scope_id===binding.app)))fail('WORKER_POWER_BUSY','Worker has unresolved work or power intent.');
  }
  /** An enrolled sleeping/uncertain worker cannot admit a new native Flow POST. Legacy workers stay unchanged. */
  assertWorkerPowerReady(app,worker) {
    if(!this.db.prepare("SELECT 1 FROM events WHERE type='worker_power_enrolled' AND subject=?").get(app))return;
    const binding=this.workerPowerBinding(app);
    if(digest(binding.worker)!==digest(worker) || this.openEffects('worker',app).length)fail('WORKER_POWER_UNAVAILABLE','Worker power or snapshot is unresolved.');
    const latest=this.db.prepare("SELECT kind FROM effects WHERE scope='worker' AND scope_id=? AND state='succeeded' ORDER BY rowid DESC LIMIT 1").get(app);
    if(latest?.kind==='worker_sleep')fail('WORKER_POWER_UNAVAILABLE','Worker must be explicitly woken before native dispatch.');
  }
  workerPowerRequest(key) {
    const effect=this.effect(key),rows=this.db.prepare("SELECT details FROM events WHERE type='worker_power_admitted' AND subject=?").all(key);
    if(rows.length!==1 || effect.scope!=='worker' || !['worker_wake','worker_sleep'].includes(effect.kind))fail('WORKER_POWER_HISTORY','An original worker power intent is required.');
    const record=JSON.parse(rows[0].details);
    if(digest(record.request)!==effect.request_digest || record.request.app!==effect.scope_id
      || effect.kind!=='worker_'+record.request.action)fail('WORKER_POWER_HISTORY','Power effect and original request differ.');
    return record.request;
  }
  workerPowerEffect(key,request) {
    id(key);const existing=this.db.prepare('SELECT key FROM effects WHERE key=?').get(key);if(!existing)return null;
    if(digest(this.workerPowerRequest(key))!==digest(request))fail('CONFLICT','Power key is bound to another request.');
    return this.effect(key);
  }
  workerPowerQueue(key) {
    this.workerPowerRequest(key);
    const row=this.db.prepare("SELECT details FROM events WHERE type='worker_power_admitted' AND subject=?").get(key);
    const record=JSON.parse(row.details);return Object.hasOwn(record,'queue')?validateWorkerPowerQueue(record.queue):null;
  }
  #workerQueueTasks(binding) {
    const target={cellId:binding.cellId,app:binding.app,provisionKey:binding.provisionKey,worker:binding.worker};
    return this.db.prepare('SELECT id,specification FROM tasks ORDER BY id').all().filter(row=>{
      const spec=JSON.parse(row.specification),m=spec.nativeMission;
      return spec.taskType!=='operation' && m && digest({cellId:m.cellId,app:m.app,provisionKey:m.provisionKey,worker:m.worker})===digest(target);
    }).map(row=>this.task(row.id));
  }
  #workerQueuePrevious(app,exceptKey=null) {
    return this.db.prepare("SELECT key,kind,state FROM effects WHERE scope='worker' AND scope_id=? AND kind IN ('worker_sleep','worker_wake') AND key IS NOT ? ORDER BY rowid DESC LIMIT 1").get(app,exceptKey)??null;
  }
  #workerQueueStopped(app,exceptKey=null) {
    return this.db.prepare("SELECT kind FROM effects WHERE scope='worker' AND scope_id=? AND state='succeeded' AND kind IN ('worker_sleep','worker_wake') AND key IS NOT ? ORDER BY rowid DESC LIMIT 1").get(app,exceptKey)?.kind==='worker_sleep';
  }
  workerPowerPending(app) {
    this.workerPowerBinding(app);
    const latest=this.#workerQueuePrevious(app);
    return latest && ['accepted','running','unknown'].includes(latest.state)?latest.key:null;
  }
  assertWorkerPowerAuthority(lease,app) {
    return this.transaction(()=>{
      if(lease?.scope!=='task')fail('AUTHORITY','Power requires task authority.');
      this.authority(lease);
      if(this.task(lease.scopeId).specification.taskType==='operation')fail('OPERATION_BINDING','Power requires its own management task.');
      const binding=this.workerPowerBinding(app);this.#workerPowerOwner(binding,lease.cellId);return binding;
    });
  }
  /** Read-only authoritative demand selection; no supplied readiness or queue booleans. */
  workerQueuePowerPlan(app,{wakeCeilingCents,maxMissionCeilingCents=Number.MAX_SAFE_INTEGER}) {
    integer(wakeCeilingCents,'wakeCeilingCents',1);
    integer(maxMissionCeilingCents,'maxMissionCeilingCents',0);
    const binding=this.workerPowerBinding(app),previous=this.#workerQueuePrevious(app);
    if(previous && ['accepted','running','unknown'].includes(previous.state))return{state:'observe',key:previous.key};
    if(previous && !['succeeded','not_applied'].includes(previous.state))return{state:'blocked',key:previous.key,reason:'power_intent_requires_operator'};
    const ready=this.#workerQueueTasks(binding).filter(task=>task.status==='ready');
    const runnable=ready.filter(task=>!this.requiresOriginalModelStep(task.id) && !this.db.prepare("SELECT key FROM effects WHERE scope='task' AND scope_id=?").get(task.id));
    const stopped=this.#workerQueueStopped(app);
    if(!runnable.length && ready.length)return{state:'blocked',taskId:ready[0].id,reason:'queue_demand_not_runnable'};
    const task=stopped?runnable.find(task=>task.specification.nativeMission.paid.ceilingCents<=maxMissionCeilingCents):runnable[0];
    if(stopped && !task && runnable.length)return{state:'budget',taskId:runnable[0].id};
    if(task && !stopped)return{state:'ready'};
    this.#workerPowerIdle(binding);
    if(!task && stopped)return{state:'sleeping'};
    const action=task?'wake':'sleep',queue={previousKey:previous?.key??null,taskId:task?.id??null,
      taskSpecDigest:task?.spec_digest??null,missionCeilingCents:task?.specification.nativeMission.paid.ceilingCents??null};
    const request={app:binding.app,bindingDigest:digest(binding),action,paid:action==='wake'?{provider:'fly',ceilingCents:wakeCeilingCents}:null};
    return{state:'transition',key:'queue-power.'+digest({request,queue}),request,queue};
  }
  #assertWorkerQueuePower(binding,key,request,input) {
    const queue=validateWorkerPowerQueue(input);
    const previous=this.#workerQueuePrevious(binding.app,key);
    if((previous?.key??null)!==queue.previousKey || previous && !['succeeded','not_applied'].includes(previous.state)
      || key!=='queue-power.'+digest({request,queue}))fail('WORKER_POWER_QUEUE','Queue transition changed.');
    const ready=this.#workerQueueTasks(binding).filter(task=>task.status==='ready');
    if(request.action==='sleep') {
      if(this.#workerQueueStopped(binding.app,key) || ready.length || queue.taskId!==null || queue.taskSpecDigest!==null || queue.missionCeilingCents!==null)
        fail('WORKER_POWER_QUEUE','Worker has queued demand.');
    } else {
      const task=ready.find(task=>task.id===queue.taskId);
      if(!this.#workerQueueStopped(binding.app,key) || !task || task.spec_digest!==queue.taskSpecDigest || this.requiresOriginalModelStep(task.id)
        || this.db.prepare("SELECT key FROM effects WHERE scope='task' AND scope_id=?").get(task.id)
        || task.specification.nativeMission.paid.ceilingCents!==queue.missionCeilingCents)
        fail('WORKER_POWER_QUEUE','Runnable wake demand changed.');
    }
    return queue;
  }
  admitWorkerPower(lease,{key,request,queue=null}) {
    id(key);if(key.length>120)fail('INVALID','Power key must leave room for its paid reservation prefix.');
    const value=closureInput(request,['app','bindingDigest','action','paid']);
    if(!['wake','sleep'].includes(value.action) || !/^[a-f0-9]{64}$/.test(value.bindingDigest))fail('INVALID','Invalid worker power request.');
    if(value.action==='wake') { const paid=closureInput(value.paid,['provider','ceilingCents']);if(paid.provider!=='fly')fail('INVALID','Wake requires Fly allowance.');integer(paid.ceilingCents,'ceilingCents',1); }
    else if(value.paid!==null)fail('INVALID','Sleep cannot change paid allowance.');
    return this.transaction(()=>{
      if(lease.scope!=='task')fail('AUTHORITY','Power requires task authority.');this.authority(lease);
      if(this.task(lease.scopeId).specification.taskType==='operation')fail('OPERATION_BINDING','Power requires its own management task.');
      const binding=this.workerPowerBinding(value.app);if(digest(binding)!==value.bindingDigest)fail('WORKER_POWER_BINDING','Power profile differs.');
      this.#workerPowerOwner(binding,lease.cellId);const previous=this.workerPowerEffect(key,value);if(previous)return{fresh:false,effect:previous};
      this.#workerPowerIdle(binding);if(this.openTaskEffects(lease.scopeId).length)fail('UNRECONCILED','Management task effects remain unresolved.');
      const checkedQueue=queue===null?null:this.#assertWorkerQueuePower(binding,key,value,queue);
      const now=this.clock();this.db.prepare('INSERT INTO effects(key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(key,'worker',binding.app,lease.scopeId,lease.cellId,lease.epoch,lease.controlEpoch,'worker_'+value.action,digest(value),'accepted',now,now);
      this.event('worker_power_admitted',key,{request:value,...(checkedQueue===null?{}:{queue:checkedQueue})});return{fresh:true,effect:this.effect(key)};
    });
  }
  startWorkerPowerEffect(lease,key,dispatch) {
    const verify=()=>{this.authority(lease);const effect=this.effect(key),request=this.workerPowerRequest(key),binding=this.workerPowerBinding(request.app);
      if(effect.owner!==lease.cellId || effect.owner_epoch!==lease.epoch || effect.control_epoch!==lease.controlEpoch
        || effect.task_id!==lease.scopeId || digest(binding)!==request.bindingDigest || typeof dispatch!=='function')fail('STALE','Power admission changed.');
      this.#workerPowerOwner(binding,lease.cellId);this.#workerPowerIdle(binding,key);
      const history=this.db.prepare("SELECT details FROM events WHERE type='worker_power_admitted' AND subject=?").get(key);
      const record=JSON.parse(history.details);if(Object.hasOwn(record,'queue'))this.#assertWorkerQueuePower(binding,key,request,record.queue);
      return effect;};
    // A crash/rollback after this durable commit burns this original mutation attempt.
    this.transaction(()=>{if(verify().state!=='accepted')fail('WORKER_POWER_HISTORY','Only a fresh accepted power intent may start.');
      this.db.prepare("UPDATE effects SET state='running',updated=? WHERE key=?").run(this.clock(),key);});
    return this.transaction(()=>{if(verify().state!=='running')fail('WORKER_POWER_HISTORY','Started power intent required.');return dispatch();});
  }
  settleWorkerPower(key,proof) {
    const p=closureInput(proof,['bindingDigest','state','observationSha256','basis']);
    return this.transaction(()=>{
      const effect=this.effect(key),request=this.workerPowerRequest(key),binding=this.workerPowerBinding(request.app);
      if(!['running','unknown'].includes(effect.state) || request.bindingDigest!==p.bindingDigest || digest(binding)!==p.bindingDigest
        || p.state!==(request.action==='wake'?'started':'stopped') || !/^[a-f0-9]{64}$/.test(p.observationSha256)
        || p.basis!=='observed-owned-target-state')fail('WORKER_POWER_OBSERVATION','Matching original owned power observation required.');
      // Trusted-local transport consumer records a bounded digest, never raw config/credentials or a billing settlement.
      const receipt={worker:binding.app,app:binding.app,state:p.state==='started'?'ready':'stopped',sha256:p.observationSha256};
      this.db.prepare("UPDATE effects SET state='succeeded',receipt=?,updated=? WHERE key=?").run(canonical(receipt),this.clock(),key);
      this.event('worker_power_observed',key,{requestDigest:effect.request_digest,basis:p.basis,receipt});return this.effect(key);
    });
  }
  /** Trusted local enrollment and assignment after authenticated native preparation. */
  claimNativeMission({taskId,expectedSpecDigest,expectedFactoryEpoch,workerProof,ttlMs=60000}) {
    id(taskId);integer(expectedFactoryEpoch,'expectedFactoryEpoch',1);integer(ttlMs,'ttlMs',1);
    return this.transaction(()=>{
      const current=this.active(),task=this.task(taskId),m=this.#nativeMissionTarget(task);
      if(current.epoch!==expectedFactoryEpoch || task.status!=='ready' || task.spec_digest!==expectedSpecDigest
        || digest(workerProof)!==digest(m.worker)) fail('STALE','Native preparation no longer matches the ready task.');
      // Competing dispatchers may have prepared different tasks before either claim committed.
      for(const other of this.db.prepare("SELECT id FROM tasks WHERE owner=? AND status='running' AND id<>?").all(m.cellId,taskId)) {
        const assignment=this.task(other.id),prior=this.db.prepare("SELECT kind,state FROM effects WHERE task_id=? OR (scope='task' AND scope_id=?)").all(other.id,other.id);
        if(!assignment.specification.nativeMission || prior.some(effect=>['accepted','running','unknown'].includes(effect.state))
          || !prior.some(effect=>effect.kind==='flow_call' && effect.state==='succeeded'))
          fail('BUSY','A previous assignment on this native cell must settle before another claim.');
      }
      this.db.prepare('UPDATE cells SET status=?,heartbeat=? WHERE id=?').run('ready',this.clock(),m.cellId);
      this.event('native_cell_enrolled',m.cellId,{taskId,provisionKey:m.provisionKey,worker:m.worker});
      const lease=this.#claimTask(taskId,m.cellId,ttlMs);
      this.event('native_mission_claimed',taskId,{specDigest:task.spec_digest,cellId:m.cellId,app:m.app,
        provisionKey:m.provisionKey,worker:m.worker,attempt:lease.epoch,controlEpoch:lease.controlEpoch,expires:lease.expires});
      return lease;
    });
  }
  /** Recover only a stale native assignment that has never admitted any external effect. */
  releaseUnstartedNativeMission({taskId,expectedAttempt,expectedSpecDigest,expectedFactoryEpoch,workerProof}) {
    id(taskId);integer(expectedAttempt,'expectedAttempt',1);integer(expectedFactoryEpoch,'expectedFactoryEpoch',1);
    return this.transaction(()=>{
      const current=this.control(),task=this.task(taskId),m=this.#nativeMissionTarget(task);
      const claims=this.db.prepare("SELECT details FROM events WHERE type='native_mission_claimed' AND subject=?").all(taskId)
        .map(row=>JSON.parse(row.details)).filter(row=>row.attempt===expectedAttempt);
      const expected={specDigest:task.spec_digest,cellId:m.cellId,app:m.app,provisionKey:m.provisionKey,
        worker:m.worker,attempt:task.epoch,controlEpoch:task.control_epoch};
      const {expires:originalExpires,...originalClaim}=claims[0]??{};
      if(current.epoch!==expectedFactoryEpoch || task.status!=='running' || task.owner!==m.cellId
        || task.epoch!==expectedAttempt || task.spec_digest!==expectedSpecDigest || task.candidate!==null || task.review!==null
        || (task.control_epoch===current.epoch && task.expires>this.clock()) || digest(workerProof)!==digest(m.worker)
        || claims.length!==1 || digest(originalClaim)!==digest(expected) || !Number.isSafeInteger(originalExpires) || originalExpires>task.expires
        || this.db.prepare("SELECT key FROM effects WHERE task_id=? OR (scope='task' AND scope_id=?)").get(taskId,taskId))
        fail('NATIVE_MISSION_UNSTARTED','Only an expired original native assignment with no lifetime effects may be released.');
      this.db.prepare("UPDATE tasks SET status='ready',owner=NULL,token_hash=NULL,expires=NULL,control_epoch=NULL WHERE id=?").run(taskId);
      this.event('native_mission_unstarted_released',taskId,{...expected,expectedFactoryEpoch});
      return this.task(taskId);
    });
  }
  admitNativeMissionEffect(lease,request,modelStepManifestProof=null) {
    return this.transaction(()=>{
      const task=this.task(lease.scopeId);this.#nativeMissionTarget(task);
      if(digest(request)!==digest(nativeMissionRequest(task,lease,request.outputFile))) fail('NATIVE_MISSION_BINDING','Mission request must match the assigned task.');
      if (task.specification.originalInference) {
        requireModelStepSchema(this); verifyModelStepManifestProof(this,lease,request,modelStepManifestProof);
      } else if (modelStepManifestProof !== null) fail('MODEL_STEP_SPECIFICATION','Legacy tasks cannot acquire original model-step class.');
      const key=nativeMissionEffectKey(request),admitted=this.#admitEffect(lease,{key,kind:'flow_call',request},Boolean(task.specification.originalInference));
      if (task.specification.originalInference && admitted.fresh) materializeModelStepManifest(this,lease,request,modelStepManifestProof);
      if(!admitted.fresh) {
        const record=this.db.prepare("SELECT details FROM events WHERE type='native_mission_admitted' AND subject=?").all(key);
        if(record.length!==1 || digest(JSON.parse(record[0].details).request)!==digest(request))fail('NATIVE_MISSION_HISTORY','Original mission history is required.');
      }
      return admitted;
    });
  }
  /** Dispatch is synchronous admission only; the returned promise is awaited outside both writer locks. */
  startNativeMissionEffect(lease,key,dispatch) {
    if (modelStepRequiredForTask(this,lease.scopeId)) fail('ORIGINAL_MODEL_STEP_RUNTIME_HOLD','Original model-step operational sender is unqualified.');
    const verify=()=>{
      this.authority(lease);const row=this.effect(key),task=this.task(lease.scopeId);this.#nativeMissionTarget(task);
      const records=this.db.prepare("SELECT details FROM events WHERE type='native_mission_admitted' AND subject=?").all(key);
      if(records.length!==1 || row.kind!=='flow_call' || row.scope!=='task' || row.scope_id!==lease.scopeId
        || row.owner!==lease.cellId || row.owner_epoch!==lease.epoch || row.control_epoch!==lease.controlEpoch
        || row.request_digest!==digest(JSON.parse(records[0].details).request) || typeof dispatch!=='function')fail('NATIVE_MISSION_HISTORY','An unstarted native mission is required.');
      return row;
    };
    // Persist started BEFORE any external invocation; rollback of the final fence cannot erase it.
    this.transaction(()=>{
      if(verify().state!=='accepted')fail('NATIVE_MISSION_HISTORY','An unstarted native mission is required.');
      this.db.prepare('UPDATE effects SET state=?,updated=? WHERE key=?').run('running',this.clock(),key);
    });
    return this.transaction(()=>{
      if(verify().state!=='running')fail('NATIVE_MISSION_HISTORY','A started native mission is required.');
      return {pending:dispatch()};
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
  /** Trusted-local completion of a named, immutable provision/retirement operation; no software or provider-absence claim. */
  completeOperationalTask(taskId, input) {
    id(taskId);
    const request = closureInput(input,[...TASK_CLOSURE_KEYS,'completionEffectKeys']);
    taskClosureIdentity(request,['ready','running']);
    if (!Array.isArray(request.completionEffectKeys) || request.completionEffectKeys.length !== 1) fail('INVALID', 'One exact operational completion effect is required.');
    request.completionEffectKeys = request.completionEffectKeys.map(id);
    const requestDigest = digest({taskId,...request});
    return this.transaction(() => {
      const { task, previous } = taskClosureRecord(this,taskId,request,'task_completed',requestDigest,'completed');
      if (previous) return previous.result;
      const specification = JSON.parse(task.specification);
      if (specification.taskType !== 'operation' || task.candidate !== null || task.review !== null) fail('TASK', 'Explicit operation type and no submitted software are required.');
      const operation = operationContract(specification), provisionKey = provisionIdentity(this,operation);
      const provision = operationReceipt(this,provisionKey,'provision',operation.kind === 'provision' ? task : null);
      if (!receiptMatchesApp(provision.receipt,operation.app) || provision.receipt?.state !== 'ready') fail('OPERATION_EVIDENCE', 'Matching recorded provisioning success is required.');
      const effectKey = request.completionEffectKeys[0];
      if (operation.kind === 'provision' && effectKey !== provisionKey) fail('OPERATION_EVIDENCE', 'Provisioning completion key must match its permanent binding.');
      const effect = operation.kind === 'provision' ? provision : operationReceipt(this,effectKey,'retire',task);
      if (operation.kind === 'retire' && (effect.request_digest !== digest({cellId:operation.cellId,app:operation.app,provisionKey})
          || !receiptMatchesApp(effect.receipt,operation.app) || effect.receipt?.state !== 'destroyed')) fail('OPERATION_EVIDENCE', 'Matching recorded retirement success is required.');
      const result = {taskId,status:'completed',attempt:task.epoch,previousOwner:task.owner,previousTaskControlEpoch:task.control_epoch,
        completionScope:'recorded-controller-operation-receipts-only',operation,completionEffectKeys:request.completionEffectKeys,
        supportingEffectKeys:operation.kind === 'provision' ? [effectKey] : [provisionKey,effectKey],reviewedSoftwareDelivered:false,workerQuiescence:'unverified'};
      this.db.prepare("UPDATE tasks SET status='completed',owner=NULL,token_hash=NULL,expires=NULL,control_epoch=NULL WHERE id=?").run(taskId);
      this.event('task_completed',taskId,{closureId:request.closureId,requestDigest,expectedFactoryEpoch:request.expectedFactoryEpoch,retainedTask:retainedTaskIdentity(task),retainedEffects:result.supportingEffectKeys.map(key => this.effect(key)),result});
      return result;
    });
  }
  /** Close one exact completed FLUJO call; model quality and software review remain separate. */
  completeConversationTask(taskId, input) {
    id(taskId);
    const request = closureInput(input,[...TASK_CLOSURE_KEYS,'completionEffectKey']);
    taskClosureIdentity(request,['running']); id(request.completionEffectKey);
    const requestDigest = digest({taskId,...request});
    return this.transaction(() => {
      const { task, previous } = taskClosureRecord(this,taskId,request,'task_completed',requestDigest,'completed');
      if (previous) return previous.result;
      const specification = JSON.parse(task.specification);
      if (specification.taskType !== 'conversation' || task.candidate !== null || task.review !== null) {
        fail('TASK', 'An unsubmitted conversation task is required.');
      }
      const operation = conversationContract(specification);
      const provisionKey = provisionIdentity(this,operation);
      if (provisionKey !== operation.provisionKey || task.owner !== operation.cellId) {
        fail('CONVERSATION_BINDING', 'Conversation worker identity changed.');
      }
      const effect = operationReceipt(this,request.completionEffectKey,'flow_call',task);
      const recorded = effect.receipt;
      if (recorded?.outputPath !== operation.outputPath || !/^[a-f0-9]{64}$/.test(recorded?.outputSha256 ?? '')
        || evidence(operation.outputPath).sha256 !== recorded.outputSha256
        || effect.request_digest !== digest({worker:operation.app,cellId:operation.cellId,
          conversationId:operation.conversationId,provisionKey:operation.provisionKey,inputDigest:operation.inputDigest})) {
        fail('CONVERSATION_EVIDENCE', 'Exact retained conversation output is required.');
      }
      const result = {taskId,status:'completed',attempt:task.epoch,previousOwner:task.owner,
        previousTaskControlEpoch:task.control_epoch,completionScope:'recorded-controller-conversation-receipt-only',
        completionEffectKey:request.completionEffectKey,outputSha256:recorded.outputSha256,
        reviewedSoftwareDelivered:false,workerQuiescence:'unverified'};
      this.db.prepare("UPDATE tasks SET status='completed',owner=NULL,token_hash=NULL,expires=NULL,control_epoch=NULL WHERE id=?").run(taskId);
      this.event('task_completed',taskId,{closureId:request.closureId,requestDigest,
        expectedFactoryEpoch:request.expectedFactoryEpoch,retainedTask:retainedTaskIdentity(task),
        retainedEffects:[effect],result});
      return result;
    });
  }
  /** Explicit abandonment, including while paused. Candidate/review and unmet acceptance remain historical. */
  cancelTask(taskId, input) {
    id(taskId);
    const request = closureInput(input,[...TASK_CLOSURE_KEYS,'reason']);
    taskClosureIdentity(request,['ready','running','review','verified']);
    if (!['abandoned','acceptance-unmet','operation-failed'].includes(request.reason)) fail('INVALID', 'An explicit supported cancellation reason is required.');
    const requestDigest = digest({taskId,...request});
    return this.transaction(() => {
      const { task, previous } = taskClosureRecord(this,taskId,request,'task_cancelled',requestDigest,'cancelled');
      if (previous) return previous.result;
      const result = {taskId,status:'cancelled',attempt:task.epoch,previousOwner:task.owner,previousTaskControlEpoch:task.control_epoch,
        reason:request.reason,specificationAcceptance:'not-established-by-cancellation',reviewedSoftwareDelivered:false};
      this.db.prepare("UPDATE tasks SET status='cancelled',owner=NULL,token_hash=NULL,expires=NULL,control_epoch=NULL WHERE id=?").run(taskId);
      this.event('task_cancelled',taskId,{closureId:request.closureId,requestDigest,expectedFactoryEpoch:request.expectedFactoryEpoch,retainedTask:retainedTaskIdentity(task),result});
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
  submit(lease, { artifactPath }) { const candidate=evidence(artifactPath); return this.transaction(() => { this.authority(lease); if (lease.scope!=='task' || this.openTaskEffects(lease.scopeId).length) fail('UNRECONCILED','Task effects must be settled before submission.'); this.db.prepare('UPDATE tasks SET status=?,candidate=?,token_hash=NULL WHERE id=?').run('review',canonical(candidate),lease.scopeId); this.event('candidate_submitted',lease.scopeId,candidate); return this.task(lease.scopeId); }); }
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
  admitEffect(lease, input) { return this.transaction(() => this.#admitEffect(lease, input)); }
  #admitEffect(lease, { key, kind, request, taskId=null }, modelStepManifestAuthorized=false) {
    id(key); if (!['provision','flow_call','retire','delivery'].includes(kind)) fail('INVALID','Unknown effect kind.');
    const hash=digest(request);
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
      if(kind==='retire' && this.openEffects('worker',request?.app).length)fail('UNRECONCILED','Worker power must be reconciled before retirement.');
      if (lease.scope === 'task') {
        const task = this.task(lease.scopeId);
        if (task.specification.originalInference && !modelStepManifestAuthorized) fail('MODEL_STEP_MANIFEST_REQUIRED','Original model-step parents require authenticated manifest admission.');
        if(kind==='flow_call' && task.specification.nativeMission) {
          this.#nativeMissionTarget(task);
          if(key!==nativeMissionEffectKey(request) || digest(request)!==digest(nativeMissionRequest(task,lease,request?.outputFile))) fail('NATIVE_MISSION_BINDING','Native Flow effect must match the assigned mission.');
        }
        if (task.specification.taskType === 'operation') {
          const operation = operationContract(task.specification);
          if (kind !== operation.kind || request?.cellId !== operation.cellId || request?.app !== operation.app || taskId !== null && taskId !== task.id) fail('OPERATION_BINDING', 'Effect must match the immutable operation contract.');
          if (kind === 'retire') {
            const retirementRequest = closureInput(request,['cellId','app','provisionKey']);
            id(retirementRequest.provisionKey);
            if (provisionIdentity(this,operation) !== retirementRequest.provisionKey) fail('OPERATION_BINDING', 'Retirement must retain exact provisioning bindings.');
          }
        }
        if (task.specification.taskType === 'conversation') {
          const operation = conversationContract(task.specification);
          if (kind !== 'flow_call' || lease.cellId !== operation.cellId
            || request?.worker !== operation.app || request?.cellId !== operation.cellId
            || request?.conversationId !== operation.conversationId
            || request?.provisionKey !== operation.provisionKey
            || request?.inputDigest !== operation.inputDigest) {
            fail('CONVERSATION_BINDING', 'Effect must match the immutable conversation operation.');
          }
        }
      }
      if ((lease.scope==='task'?this.openTaskEffects(lease.scopeId):this.openEffects(lease.scope,lease.scopeId)).length) fail('UNRECONCILED','Previous external effect must settle before a conflicting effect.');
      if(kind==='provision') {
        const cell=this.db.prepare("SELECT * FROM cells WHERE id=? AND status='reserved'").get(id(request?.cellId));
        if(!cell || cell.parent_id!==lease.cellId || typeof request.app!=='string' || !/^[a-z][a-z0-9-]{2,62}$/.test(request.app)) fail('RESERVATION','Provisioning requires the owner\'s reserved child and an explicit app identity.');
        for(const target of ['cell:'+cell.id,'app:'+request.app]) if(this.db.prepare('SELECT * FROM effect_bindings WHERE target=?').get(target)) fail('CONFLICT','Provisioning target already has an intent. Reconcile it.');
      }
      const now=this.clock();
      this.db.prepare('INSERT INTO effects(key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(key,lease.scope,lease.scopeId,taskId??(lease.scope==='task'?lease.scopeId:null),owner.owner,lease.epoch,lease.controlEpoch,kind,hash,'accepted',now,now);
      if(kind==='provision') for(const target of ['cell:'+request.cellId,'app:'+request.app]) this.db.prepare('INSERT INTO effect_bindings VALUES(?,?)').run(target,key);
      this.event('effect_accepted',key,{kind,scope:lease.scope,scopeId:lease.scopeId,requestDigest:hash});
      if(kind==='flow_call' && this.task(lease.scopeId).specification.nativeMission)this.event('native_mission_admitted',key,{request});
      return {fresh:true,effect:this.effect(key)};
  }
  effect(key) { const row=this.db.prepare('SELECT * FROM effects WHERE key=?').get(id(key)); if (!row) fail('EFFECT','Effect not found.'); return {...row,receipt:row.receipt?JSON.parse(row.receipt):null}; }
  ownedWorker(app) {
    if(typeof app!=='string' || !/^[a-z][a-z0-9-]{2,62}$/.test(app)) fail('INVALID','A recorded app identity is required.');
    const binding=this.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get('app:'+app);
    if(!binding) fail('WORKER','Worker has no FACTORY provisioning intent.');
    const effect=this.effect(binding.effect_key);
    if(effect.kind!=='provision' || effect.state!=='succeeded') fail('WORKER','Worker provisioning is unconfirmed.');
    const retirement=this.db.prepare("SELECT state FROM effects WHERE scope='cleanup' AND scope_id=? AND kind='retire' ORDER BY created DESC LIMIT 1").get(app);
    if(retirement) fail('WORKER','Worker retirement has been admitted.');
    return {app,provisionKey:binding.effect_key,receipt:effect.receipt};
  }
  modelStepCompletion(key) { return modelStepCompletion(this,key); }
  requiresOriginalModelStep(taskId) { return modelStepRequiredForTask(this,taskId); }
  assertNativeMissionCompletion(key) { assertModelStepParentTerminal(this,key); }
  /** Trusted local shutdown authority, restricted to an app already admitted for provisioning. */
  admitOwnedRetirement({key,app}) {
    id(key);
    if(typeof app!=='string' || !/^[a-z][a-z0-9-]{2,62}$/.test(app)) fail('INVALID','A recorded app identity is required.');
    return this.transaction(() => {
      const control=this.control();
      const binding=this.db.prepare('SELECT effect_key FROM effect_bindings WHERE target=?').get('app:'+app);
      if(!binding || this.effect(binding.effect_key).kind!=='provision') fail('RESERVATION','Retirement requires this controller\'s recorded provisioning intent.');
      if(this.openEffects('worker',app).length)fail('UNRECONCILED','Original worker power intent must be reconciled before retirement.');
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
  startEffect(lease,key) { return this.transaction(() => { this.authority(lease); const row=this.effect(key); if(row.kind==='model_step') fail('MODEL_STEP_METHOD_REQUIRED','Original model steps require dedicated methods.'); if(row.kind==='flow_call' && this.task(lease.scopeId).specification.nativeMission) fail('NATIVE_MISSION_DISPATCH_REQUIRED','Native missions require their fenced dispatcher.'); if (row.state!=='accepted' || row.scope!==lease.scope || row.scope_id!==lease.scopeId || row.owner_epoch!==lease.epoch) fail('EFFECT','Accepted effect belongs to another attempt.'); this.db.prepare('UPDATE effects SET state=?,updated=? WHERE key=?').run('running',this.clock(),key); return this.effect(key); }); }
  settleEffect(key, state, receipt={}) {
    if (!['succeeded','not_applied','unknown'].includes(state)) fail('INVALID','Invalid settlement.');
    return this.transaction(() => {
      const row=this.effect(key);
      if (row.kind==='model_step') fail('MODEL_STEP_METHOD_REQUIRED','Original model steps require dedicated methods.');
      if (['succeeded','not_applied'].includes(state)) assertModelStepParentTerminal(this,key,state);
      if (!['accepted','running','unknown'].includes(row.state)) fail('EFFECT','Effect is already settled.');
      if(state==='not_applied' && row.state!=='accepted') fail('NEGATIVE_RECONCILIATION_UNSUPPORTED','A started external action cannot be declared not applied without executor and target reconciliation.');
      const metadata=safeReceipt(receipt);
      this.db.prepare('UPDATE effects SET state=?,receipt=?,updated=? WHERE key=?').run(state,canonical(metadata),this.clock(),key);
      this.event('effect_settled',key,{state,receipt:metadata}); return this.effect(key);
    });
  }
  reconcileEffect(key, { applied, evidencePath }) { if(typeof applied!=='boolean') fail('INVALID','Reconciliation outcome is required.'); if(this.effect(key).kind==='model_step') fail('MODEL_STEP_METHOD_REQUIRED','Original model steps require dedicated methods.'); const proof=evidence(evidencePath); return this.settleEffect(key,applied?'succeeded':'not_applied',{...proof,reconciled:true}); }
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
  pause() { return this.transaction(() => { const old=this.control(); if(old.status==='active'){this.db.prepare('UPDATE control SET status=?,epoch=? WHERE id=1').run('paused',integer(old.epoch+1,'factory epoch',1));this.event('paused','root');} return this.status(); }); }
  resume() { return this.transaction(() => {const old=this.control();if(old.status==='paused'){this.db.prepare('UPDATE control SET status=?,epoch=? WHERE id=1').run('active',integer(old.epoch+1,'factory epoch',1));this.event('resumed','root');}return this.status();}); }
  status() {
    const control=this.control(), cells=this.db.prepare('SELECT * FROM cells ORDER BY id').all(), tasks=this.db.prepare('SELECT id FROM tasks ORDER BY id').all().map(row=>this.task(row.id));
    const effects=this.db.prepare('SELECT key FROM effects ORDER BY created,key').all().map(row=>this.effect(row.key));
    const unresolved=effects.filter(effect=>['accepted','running','unknown'].includes(effect.state));
    return {schemaVersion:this.db.prepare('PRAGMA user_version').get().user_version,control,cells,tasks,effects,unresolvedEffects:unresolved.length,effectsDrained:unresolved.length===0,workerQuiescence:'unverified',scope:'local-coordinator'};
  }
}
