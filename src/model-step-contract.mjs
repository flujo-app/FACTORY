import { createHash } from 'node:crypto';
import { canonicalMissionPacket } from './native-mission-contract.mjs';
import { withOriginalInferenceCapability, validateOriginalInferenceSpecification } from './original-inference-contract.mjs';

const canonical = canonicalMissionPacket;
export const modelStepDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const hashToken = value => createHash('sha256').update(String(value)).digest('hex');
const equal = (a, b) => canonical(a) === canonical(b);
const proofs = new WeakMap();
const mutationGuards = new WeakMap();
export const MODEL_STEP_DATABASE_VERSION = 3;
/** Pure admission-snapshot construction; this cannot open the journal's private insertion window. */
export function modelStepClaimWitness(record, receiverSha256, { chargedCents, overCommittedCents, admittedAt }) {
  check(receiverSha256===modelStepDigest({format:'factory-original-model-step-receiver-comparison',schemaVersion:1,
    renderer:record.body.renderer,bodySha256:record.body.sha256,modelManifestDigest:record.model.manifestDigest,recipientId:record.call.recipientId}),'MODEL_STEP_CLAIM_REQUIRED');
  check(Number.isSafeInteger(admittedAt) && admittedAt>0 && admittedAt<record.lease.expires
    && overCommittedCents===0 && (chargedCents===null || Number.isSafeInteger(chargedCents) && chargedCents>=0 && chargedCents<record.reservation.ceilingCents), 'MODEL_STEP_CLAIM_REQUIRED');
  const witness={format:'factory-original-model-step-claim',schemaVersion:1,effectKey:'model.'+record.call.requestId,
    parent:{effectKey:record.parent.effectKey,requestSha256:record.parent.requestSha256},task:{id:record.task.id,specDigest:record.task.specDigest},
    call:record.call,lease:record.lease,reservation:{...record.reservation,chargedCents},receiverSha256,
    envelopeSha256:modelStepDigest(record),overCommittedCents,admittedAt};
  const witnessJson=canonical(witness);
  return {effect_key:witness.effectKey,parent_key:record.parent.effectKey,envelope_sha256:witness.envelopeSha256,
    receiver_sha256:receiverSha256,witness_json:witnessJson,witness_sha256:modelStepDigest(witness),admitted_at:admittedAt};
}
function claimMatches(witnessJson,witnessSha256,admittedAt,effectKey,parentKey,envelopeSha256,receiverSha256,envelopeJson) {
  try {
    check(typeof witnessJson==='string' && typeof envelopeJson==='string' && Buffer.byteLength(witnessJson)<=262144 && Buffer.byteLength(envelopeJson)<=262144);
    const record=JSON.parse(envelopeJson),witness=JSON.parse(witnessJson);
    const expected=modelStepClaimWitness(record,receiverSha256,{chargedCents:witness.reservation?.chargedCents,overCommittedCents:witness.overCommittedCents,admittedAt});
    return canonical(record)===envelopeJson && expected.effect_key===effectKey && expected.parent_key===parentKey
      && expected.envelope_sha256===envelopeSha256 && expected.witness_json===witnessJson && expected.witness_sha256===witnessSha256 ? 1:0;
  } catch { return 0; }
}
/** Validates stored admission only; it does not re-admit under the current lease/OFF/budget state. */
export function assertModelStepClaim(control,binding,child) {
  const claim=control.db.prepare('SELECT * FROM model_step_claims WHERE effect_key=?').get(child.key);
  if(['accepted','not_applied'].includes(child.state)){check(!claim,'MODEL_STEP_CLAIM_INCONSISTENT');return null;}
  check(['running','unknown','succeeded'].includes(child.state) && claim && claim.parent_key===binding.parent_key
    && claim.envelope_sha256===binding.envelope_sha256 && claim.receiver_sha256===binding.receiver_sha256
    && claimMatches(claim.witness_json,claim.witness_sha256,claim.admitted_at,child.key,binding.parent_key,
      binding.envelope_sha256,binding.receiver_sha256,binding.envelope_json)===1,'MODEL_STEP_CLAIM_REQUIRED');
  return claim;
}
export function installModelStepMutationGuard(control) {
  if (mutationGuards.has(control)) return;
  const state = { depth: 0 }; mutationGuards.set(control, state);
  control.db.function('factory_model_step_write_guard', () => state.depth > 0 ? 1 : 0);
  control.db.function('factory_model_step_claim_matches',claimMatches);
  // Registered readers resolve the function but receive no insertion/start authority.
  control.db.function('factory_model_step_claim_guard',(_key,_witness,_stage)=>0);
}
export function guardedModelStepMutation(control, operation) {
  installModelStepMutationGuard(control);
  const state = mutationGuards.get(control); state.depth++;
  try { return operation(); } finally { state.depth--; }
}
export function modelStepFail(code = 'MODEL_STEP_BINDING') {
  throw Object.assign(new Error('Original model-step journal could not be confirmed.'), { code });
}
function check(value, code) { if (!value) modelStepFail(code); }

/** Host-owned, authenticated provenance only. This proof cannot authorize a sender. */
export function originalModelStepManifestProof(bootstrap, capability) {
  const record = withOriginalInferenceCapability(bootstrap, capability, r => r);
  check(record.schemaVersion === 2);
  const proof = Object.freeze(Object.create(null));
  proofs.set(proof, { record, envelopeSha256: modelStepDigest(record) });
  return proof;
}
export function verifyModelStepManifestProof(control, lease, request, proof) {
  check(proofs.has(proof), 'MODEL_STEP_MANIFEST_REQUIRED');
  const { record, envelopeSha256 } = proofs.get(proof), task = control.task(lease.scopeId);
  const row = control.authority(lease);
  validateOriginalInferenceSpecification(task.specification.originalInference);
  check(task.specification.taskType === 'software'
    && equal(record.task, { id: task.id, projectId: task.project_id, branch: task.branch, specification: task.specification, specDigest: task.spec_digest })
    && equal(record.parent.request, request) && record.parent.requestSha256 === modelStepDigest(request)
    && record.lease.scope === 'task' && record.lease.scopeId === task.id && record.lease.cellId === lease.cellId
    && record.lease.epoch === lease.epoch && record.lease.controlEpoch === lease.controlEpoch
    && record.lease.expires === row.expires && record.lease.tokenSha256 === hashToken(lease.token)
    && equal(record.plan, task.specification.originalInference.plan));
  return { record, envelopeSha256 };
}

export function requireModelStepSchema(control) {
  check(control.db.prepare('PRAGMA user_version').get().user_version === MODEL_STEP_DATABASE_VERSION, 'MODEL_STEP_SCHEMA_REQUIRED');
  const tables = new Set(control.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
  const expected = ['control','cells','tasks','integrations','effects','effect_bindings','messages','events','model_step_manifests','model_step_slots','model_step_bindings','model_step_aborts','model_step_claims'];
  check(tables.size === expected.length && expected.every(t => tables.has(t)), 'MODEL_STEP_SCHEMA_REQUIRED');
  const triggers = new Set(control.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r => r.name));
  const expectedTriggers=['model_manifest_no_update','model_manifest_no_delete','model_slots_no_update','model_slots_no_delete',
    'model_bindings_no_update','model_bindings_no_delete','model_child_state_guard','model_effect_identity_guard','model_parent_completion_guard',
    'model_enrolled_task_identity_guard','model_abort_no_update','model_abort_no_delete','model_claim_insert_guard','model_claim_no_update','model_claim_no_delete'];
  check(triggers.size===expectedTriggers.length && expectedTriggers.every(t => triggers.has(t)), 'MODEL_STEP_SCHEMA_REQUIRED');
  const normalize = sql => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
  const actual = new Map(control.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger')").all()
    .map(row => [row.type + ':' + row.name, row.sql]));
  const expectedObjects = [...MODEL_STEP_SCHEMA_SQL.matchAll(/CREATE (TABLE|TRIGGER) (\w+)([\s\S]*?)(?=\n  CREATE|\n  PRAGMA|$)/g)];
  check(expectedObjects.length === 20 && expectedObjects.every(match => {
    const sql = actual.get(match[1].toLowerCase() + ':' + match[2]);
    return typeof sql === 'string' && normalize(sql) === normalize(match[0]);
  }), 'MODEL_STEP_SCHEMA_REQUIRED');
}
export function modelStepRequiredForTask(control, taskId) {
  const task = control.task(taskId);
  const hasTable = control.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_step_manifests'").get();
  return Object.hasOwn(task.specification, 'originalInference') || Boolean(hasTable && control.db.prepare('SELECT 1 FROM model_step_manifests WHERE task_id=?').get(taskId));
}
export function refuseMixedModelStepSchema(control, version) {
  if (version === MODEL_STEP_DATABASE_VERSION) { requireModelStepSchema(control); return; }
  check(version!==2,'MODEL_STEP_SCHEMA_REQUIRED'); // Previous schema2 is refused, never upgraded or inferred.
  check(!control.db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'model_%'").get(), 'MODEL_STEP_SCHEMA_INCONSISTENT');
}

/** Called only inside the same transaction that inserted the exact parent intent. */
export function materializeModelStepManifest(control, lease, request, proof) {
  requireModelStepSchema(control);
  const { record, envelopeSha256 } = verifyModelStepManifestProof(control, lease, request, proof), parent = control.effect(record.parent.effectKey);
  check(parent.kind === 'flow_call' && parent.scope === 'task' && parent.scope_id === record.task.id
    && parent.task_id === record.task.id && parent.state === 'accepted' && parent.request_digest === record.parent.requestSha256);
  const previous = control.db.prepare('SELECT * FROM model_step_manifests WHERE parent_key=?').get(parent.key);
  if (previous) {
    check(previous.plan_sha256 === modelStepDigest(record.plan) && previous.spec_digest === record.task.specDigest
      && previous.enrollment_envelope_sha256 === envelopeSha256 && previous.plan_json === canonical(record.plan), 'CONFLICT');
    return;
  }
  control.db.prepare('INSERT INTO model_step_manifests(parent_key,task_id,spec_digest,plan_sha256,plan_json,enrollment_envelope_sha256,created) VALUES(?,?,?,?,?,?,?)')
    .run(parent.key, record.task.id, record.task.specDigest, modelStepDigest(record.plan), canonical(record.plan), envelopeSha256, control.clock());
  const insert = control.db.prepare('INSERT INTO model_step_slots(parent_key,node_id,ordinal,request_id,nonce,binding_sha256,required_outcome) VALUES(?,?,?,?,?,?,?)');
  for (const slot of record.plan.slots) insert.run(parent.key, slot.slot.nodeId, slot.slot.ordinal, slot.requestId, slot.nonce, slot.bindingSha256, slot.requiredOutcome);
  control.event('model_step_manifest_materialized', parent.key, { taskId: record.task.id, planSha256: modelStepDigest(record.plan), expectedSlots: record.plan.slots.length, runtimeAdmission: 'HOLD' });
}

/** Exact expected membership, including never-registered slots, not absence of open rows. */
export function modelStepCompletion(control, parentKey) {
  const parent = control.effect(parentKey);
  if (parent.kind !== 'flow_call' || parent.scope !== 'task') return { required: false, complete: true };
  const task = control.task(parent.scope_id);
  if (!modelStepRequiredForTask(control, task.id)) return { required: false, complete: true, scope: 'legacy-no-model-step-authority' };
  requireModelStepSchema(control);
  validateOriginalInferenceSpecification(task.specification.originalInference);
  const expected = task.specification.originalInference.plan, manifest = control.db.prepare('SELECT * FROM model_step_manifests WHERE parent_key=?').get(parentKey);
  check(manifest && manifest.task_id === task.id && manifest.spec_digest === task.spec_digest
    && manifest.plan_sha256 === modelStepDigest(expected) && manifest.plan_json === canonical(expected), 'MODEL_STEP_MANIFEST_REQUIRED');
  const rows = control.db.prepare('SELECT * FROM model_step_slots WHERE parent_key=? ORDER BY node_id,ordinal').all(parentKey);
  check(rows.length === expected.slots.length && expected.slots.every(s => rows.some(r => r.node_id === s.slot.nodeId && r.ordinal === s.slot.ordinal
    && r.request_id === s.requestId && r.nonce === s.nonce && r.binding_sha256 === s.bindingSha256 && r.required_outcome === s.requiredOutcome)), 'MODEL_STEP_MANIFEST_INCONSISTENT');
  const bindings = control.db.prepare('SELECT * FROM model_step_bindings WHERE parent_key=?').all(parentKey);
  check(bindings.length <= rows.length, 'MODEL_STEP_MANIFEST_INCONSISTENT');
  const allChildren = control.db.prepare("SELECT key FROM effects WHERE kind='model_step' AND (task_id=? OR (scope='task' AND scope_id=?))").all(task.id,task.id);
  check(allChildren.length === bindings.length && allChildren.every(child => bindings.some(b => b.effect_key === child.key)), 'MODEL_STEP_MANIFEST_INCONSISTENT');
  const slots = rows.map(row => {
    const bound = bindings.find(b => b.node_id === row.node_id && b.ordinal === row.ordinal);
    if (!bound) return { nodeId: row.node_id, ordinal: row.ordinal, state: 'missing' };
    const child = control.effect(bound.effect_key);
    check(bound.request_id === row.request_id && bound.nonce === row.nonce && bound.binding_sha256 === row.binding_sha256
      && child.kind === 'model_step' && child.scope === 'task' && child.scope_id === task.id && child.task_id === task.id
      && child.owner === parent.owner && child.owner_epoch === parent.owner_epoch && child.control_epoch === parent.control_epoch
      && child.request_digest === bound.envelope_sha256, 'MODEL_STEP_MANIFEST_INCONSISTENT');
    assertModelStepClaim(control,bound,child);
    return { nodeId: row.node_id, ordinal: row.ordinal, key: child.key, state: child.state };
  });
  const abort = control.db.prepare('SELECT * FROM model_step_aborts WHERE parent_key=?').get(parentKey);
  if (abort) {
    check(!control.db.prepare('SELECT 1 FROM model_step_claims WHERE parent_key=?').get(parentKey),'MODEL_STEP_CLAIM_INCONSISTENT');
    check(abort.spec_digest === manifest.spec_digest && abort.plan_sha256 === manifest.plan_sha256
      && ['accepted','not_applied'].includes(parent.state) && slots.every(s => ['missing','not_applied'].includes(s.state)), 'MODEL_STEP_MANIFEST_INCONSISTENT');
    return { required:true,complete:true,drained:true,requiredSuccessful:false,aborted:true,
      slots:slots.map(s=>({...s,state:'not_applied',scope:'source-only-never-dispatched-plan-abort'})),runtimeAdmission:'HOLD' };
  }
  return { required: true, complete: bindings.length === rows.length && slots.every(s => s.state === 'succeeded'),
    drained:bindings.length === rows.length && slots.every(s=>['succeeded','not_applied'].includes(s.state)),
    requiredSuccessful:bindings.length === rows.length && slots.every(s=>s.state==='succeeded'),slots,runtimeAdmission:'HOLD' };
}
export function assertModelStepParentTerminal(control, key, outcome='succeeded') {
  const completion=modelStepCompletion(control,key);
  check(completion.complete && (!completion.required || outcome==='succeeded' && completion.requiredSuccessful && !completion.aborted
    || outcome==='not_applied' && completion.aborted), 'MODEL_STEP_UNRESOLVED');
}

export const MODEL_STEP_SCHEMA_SQL = `
  CREATE TABLE model_step_manifests(
    parent_key TEXT PRIMARY KEY REFERENCES effects(key), task_id TEXT NOT NULL REFERENCES tasks(id),
    spec_digest TEXT NOT NULL, plan_sha256 TEXT NOT NULL, plan_json TEXT NOT NULL,
    enrollment_envelope_sha256 TEXT NOT NULL, created INTEGER NOT NULL
  );
  CREATE TABLE model_step_slots(
    parent_key TEXT NOT NULL REFERENCES model_step_manifests(parent_key), node_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    request_id TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL UNIQUE, binding_sha256 TEXT NOT NULL, required_outcome TEXT NOT NULL CHECK(required_outcome='succeeded'),
    PRIMARY KEY(parent_key,node_id,ordinal), UNIQUE(parent_key,request_id)
  );
  CREATE TABLE model_step_bindings(
    effect_key TEXT PRIMARY KEY REFERENCES effects(key), parent_key TEXT NOT NULL, node_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
    request_id TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL UNIQUE, binding_sha256 TEXT NOT NULL,
    envelope_sha256 TEXT NOT NULL, envelope_json TEXT NOT NULL, receiver_sha256 TEXT NOT NULL,
    FOREIGN KEY(parent_key,node_id,ordinal) REFERENCES model_step_slots(parent_key,node_id,ordinal),
    UNIQUE(parent_key,node_id,ordinal)
  );
  CREATE TABLE model_step_aborts(
    parent_key TEXT PRIMARY KEY REFERENCES model_step_manifests(parent_key),spec_digest TEXT NOT NULL,plan_sha256 TEXT NOT NULL,
    envelope_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,created INTEGER NOT NULL
  );
  CREATE TABLE model_step_claims(
    effect_key TEXT PRIMARY KEY NOT NULL REFERENCES model_step_bindings(effect_key),parent_key TEXT NOT NULL REFERENCES model_step_manifests(parent_key),
    envelope_sha256 TEXT NOT NULL,receiver_sha256 TEXT NOT NULL,witness_json TEXT NOT NULL,witness_sha256 TEXT NOT NULL,admitted_at INTEGER NOT NULL
  );
  CREATE TRIGGER model_claim_insert_guard BEFORE INSERT ON model_step_claims BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM model_step_bindings b JOIN effects e ON e.key=b.effect_key
      WHERE b.effect_key=NEW.effect_key AND e.state='accepted' AND e.kind='model_step' AND e.request_digest=b.envelope_sha256
        AND b.parent_key=NEW.parent_key AND b.envelope_sha256=NEW.envelope_sha256 AND b.receiver_sha256=NEW.receiver_sha256
        AND factory_model_step_claim_matches(NEW.witness_json,NEW.witness_sha256,NEW.admitted_at,b.effect_key,b.parent_key,b.envelope_sha256,b.receiver_sha256,b.envelope_json)=1)
      OR factory_model_step_claim_guard(NEW.effect_key,NEW.witness_json,'insert')!=1
      THEN RAISE(ABORT,'dedicated exact model claim required') END;
  END;
  CREATE TRIGGER model_claim_no_update BEFORE UPDATE ON model_step_claims BEGIN SELECT RAISE(ABORT,'immutable model claim'); END;
  CREATE TRIGGER model_claim_no_delete BEFORE DELETE ON model_step_claims BEGIN SELECT RAISE(ABORT,'immutable model claim'); END;
  CREATE TRIGGER model_manifest_no_update BEFORE UPDATE ON model_step_manifests BEGIN SELECT RAISE(ABORT,'immutable model manifest'); END;
  CREATE TRIGGER model_manifest_no_delete BEFORE DELETE ON model_step_manifests BEGIN SELECT RAISE(ABORT,'immutable model manifest'); END;
  CREATE TRIGGER model_slots_no_update BEFORE UPDATE ON model_step_slots BEGIN SELECT RAISE(ABORT,'immutable model slots'); END;
  CREATE TRIGGER model_slots_no_delete BEFORE DELETE ON model_step_slots BEGIN SELECT RAISE(ABORT,'immutable model slots'); END;
  CREATE TRIGGER model_bindings_no_update BEFORE UPDATE ON model_step_bindings BEGIN SELECT RAISE(ABORT,'immutable model binding'); END;
  CREATE TRIGGER model_bindings_no_delete BEFORE DELETE ON model_step_bindings BEGIN SELECT RAISE(ABORT,'immutable model binding'); END;
  CREATE TRIGGER model_abort_no_update BEFORE UPDATE ON model_step_aborts BEGIN SELECT RAISE(ABORT,'immutable model abort'); END;
  CREATE TRIGGER model_abort_no_delete BEFORE DELETE ON model_step_aborts BEGIN SELECT RAISE(ABORT,'immutable model abort'); END;
  CREATE TRIGGER model_enrolled_task_identity_guard BEFORE UPDATE OF id,project_id,branch,specification,spec_digest ON tasks
    WHEN EXISTS(SELECT 1 FROM model_step_manifests WHERE task_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'immutable enrolled original task'); END;
  CREATE TRIGGER model_child_state_guard BEFORE UPDATE OF state ON effects WHEN OLD.kind='model_step'
    BEGIN
      SELECT CASE WHEN factory_model_step_write_guard()!=1 THEN RAISE(ABORT,'dedicated model child method required') END;
      SELECT CASE WHEN NOT(OLD.state=NEW.state OR OLD.state='accepted' AND NEW.state IN ('running','not_applied')
        OR OLD.state='running' AND NEW.state IN ('unknown','succeeded') OR OLD.state='unknown' AND NEW.state='succeeded')
        THEN RAISE(ABORT,'invalid model child transition') END;
      SELECT CASE WHEN NEW.state IN ('accepted','not_applied') AND EXISTS(SELECT 1 FROM model_step_claims WHERE effect_key=OLD.key)
        OR NEW.state IN ('running','unknown','succeeded') AND NOT EXISTS(
          SELECT 1 FROM model_step_claims c JOIN model_step_bindings b ON b.effect_key=c.effect_key WHERE c.effect_key=OLD.key
            AND c.parent_key=b.parent_key AND c.envelope_sha256=b.envelope_sha256 AND c.receiver_sha256=b.receiver_sha256
            AND factory_model_step_claim_matches(c.witness_json,c.witness_sha256,c.admitted_at,b.effect_key,b.parent_key,b.envelope_sha256,b.receiver_sha256,b.envelope_json)=1)
        THEN RAISE(ABORT,'exact model claim witness required') END;
      SELECT CASE WHEN OLD.state='accepted' AND NEW.state='running' AND NOT EXISTS(
        SELECT 1 FROM model_step_claims c WHERE c.effect_key=OLD.key AND factory_model_step_claim_guard(OLD.key,c.witness_json,'start')=1)
        THEN RAISE(ABORT,'dedicated exact model claim required') END;
    END;
  CREATE TRIGGER model_effect_identity_guard BEFORE UPDATE OF key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,created ON effects
    WHEN OLD.kind='model_step' OR EXISTS(SELECT 1 FROM model_step_manifests WHERE parent_key=OLD.key)
    BEGIN SELECT RAISE(ABORT,'immutable original model effect'); END;
  CREATE TRIGGER model_parent_completion_guard BEFORE UPDATE OF state ON effects
    WHEN OLD.kind='flow_call' AND NEW.state IN ('succeeded','not_applied')
      AND (EXISTS(SELECT 1 FROM model_step_manifests WHERE parent_key=OLD.key)
        OR EXISTS(SELECT 1 FROM tasks WHERE id=OLD.scope_id AND json_type(specification,'$.originalInference') IS NOT NULL))
    BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM model_step_manifests WHERE parent_key=OLD.key)
        OR OLD.scope!='task' OR OLD.task_id IS NOT OLD.scope_id
        OR NOT EXISTS(SELECT 1 FROM model_step_manifests m JOIN tasks t ON t.id=OLD.scope_id WHERE m.parent_key=OLD.key
          AND m.task_id=t.id AND m.spec_digest=t.spec_digest AND json_type(t.specification,'$.originalInference')='object'
          AND json_extract(t.specification,'$.originalInference.planSha256')=m.plan_sha256)
        OR NOT EXISTS(SELECT 1 FROM model_step_slots WHERE parent_key=OLD.key)
        OR EXISTS(SELECT 1 FROM model_step_manifests m WHERE m.parent_key=OLD.key AND
          json_array_length(m.plan_json,'$.slots')!=(SELECT count(*) FROM model_step_slots WHERE parent_key=OLD.key))
        OR EXISTS(SELECT 1 FROM model_step_slots s WHERE s.parent_key=OLD.key AND NOT EXISTS(
          SELECT 1 FROM model_step_manifests m,json_each(m.plan_json,'$.slots') j WHERE m.parent_key=OLD.key
            AND json_extract(j.value,'$.slot.nodeId')=s.node_id AND json_extract(j.value,'$.slot.ordinal')=s.ordinal
            AND json_extract(j.value,'$.requestId')=s.request_id AND json_extract(j.value,'$.nonce')=s.nonce
            AND json_extract(j.value,'$.bindingSha256')=s.binding_sha256 AND json_extract(j.value,'$.requiredOutcome')=s.required_outcome))
        OR (SELECT count(*) FROM effects WHERE kind='model_step' AND (task_id=OLD.task_id OR (scope='task' AND scope_id=OLD.scope_id)))
          !=(SELECT count(*) FROM model_step_bindings WHERE parent_key=OLD.key)
        OR EXISTS(SELECT 1 FROM model_step_bindings b WHERE b.parent_key=OLD.key AND NOT EXISTS(
          SELECT 1 FROM model_step_slots s WHERE s.parent_key=b.parent_key AND s.node_id=b.node_id AND s.ordinal=b.ordinal))
        OR (NEW.state='succeeded' AND EXISTS(SELECT 1 FROM model_step_aborts WHERE parent_key=OLD.key))
        OR (NEW.state='not_applied' AND OLD.state NOT IN ('accepted','not_applied'))
        OR (NEW.state='not_applied' AND EXISTS(SELECT 1 FROM model_step_claims WHERE parent_key=OLD.key))
        OR (NEW.state='not_applied' AND NOT EXISTS(SELECT 1 FROM model_step_aborts a JOIN model_step_manifests m ON m.parent_key=a.parent_key
          WHERE a.parent_key=OLD.key AND a.spec_digest=m.spec_digest AND a.plan_sha256=m.plan_sha256))
        OR EXISTS(SELECT 1 FROM model_step_slots s LEFT JOIN model_step_bindings b
          ON b.parent_key=s.parent_key AND b.node_id=s.node_id AND b.ordinal=s.ordinal
          LEFT JOIN effects e ON e.key=b.effect_key WHERE s.parent_key=OLD.key
          AND ((NEW.state='succeeded' AND (b.effect_key IS NULL OR e.key IS NULL))
            OR (b.effect_key IS NOT NULL AND (e.key IS NULL OR b.request_id!=s.request_id OR b.nonce!=s.nonce OR b.binding_sha256!=s.binding_sha256
              OR e.kind!='model_step' OR e.scope!='task' OR e.scope_id!=OLD.scope_id OR e.task_id IS NOT OLD.task_id
              OR e.owner!=OLD.owner OR e.owner_epoch!=OLD.owner_epoch OR e.control_epoch!=OLD.control_epoch OR e.request_digest!=b.envelope_sha256
              OR (NEW.state='succeeded' AND (e.state!='succeeded' OR NOT EXISTS(SELECT 1 FROM model_step_claims c WHERE c.effect_key=e.key
                AND c.parent_key=b.parent_key AND c.envelope_sha256=b.envelope_sha256 AND c.receiver_sha256=b.receiver_sha256
                AND factory_model_step_claim_matches(c.witness_json,c.witness_sha256,c.admitted_at,b.effect_key,b.parent_key,b.envelope_sha256,b.receiver_sha256,b.envelope_json)=1)))
              OR (NEW.state='not_applied' AND e.state!='not_applied')))))
        THEN RAISE(ABORT,'required model steps unresolved') END;
    END;
  PRAGMA user_version=3;
`;
