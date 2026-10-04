import { FactoryControl } from './control.mjs';
import { types } from 'node:util';
import { randomBytes } from 'node:crypto';
import { SpendingLedger } from './spending.mjs';
import { safeReceipt } from './receipts.mjs';
import { withOriginalInferenceCapability } from './original-inference-contract.mjs';
import { canonicalMissionPacket } from './native-mission-contract.mjs';
import { MODEL_STEP_SCHEMA_SQL, modelStepDigest, modelStepFail, requireModelStepSchema, refuseMixedModelStepSchema,
  originalModelStepManifestProof, verifyModelStepManifestProof, installModelStepMutationGuard, guardedModelStepMutation, assertModelStepParentTerminal,
  MODEL_STEP_DATABASE_VERSION,modelStepClaimWitness,assertModelStepClaim,MODEL_PARENT_START_DATABASE_VERSION,
  MODEL_PARENT_START_SCHEMA_SQL,modelParentStartWitness,assertModelParentStart } from './model-step-contract.mjs';

const canonical = canonicalMissionPacket;
const check = (ok, code) => { if (!ok) modelStepFail(code); };
const keyFor = record => 'model.' + record.call.requestId;
const callBinding = r => modelStepDigest({ call: r.call, model: r.model, recipients: r.recipients, body: r.body });
// Shared across journal instances, inaccessible to the exported generic mutation helper.
const privateClaimWindows=new WeakMap();
const privateParentStartWindows=new WeakMap();
function installPrivateParentStartGuard(control) {
  if (privateParentStartWindows.has(control)) return privateParentStartWindows.get(control);
  const state={active:null}; privateParentStartWindows.set(control,state);
  control.db.function('factory_model_parent_start_guard',(key,witnessJson,stage)=>{
    const active=state.active;
    if (!active || key!==active.key || witnessJson!==active.witnessJson) return 0;
    if (stage==='insert' && !active.inserted && !active.started) { active.inserted=true; return 1; }
    if (stage==='start' && active.inserted && !active.started) { active.started=true; return 1; }
    return 0;
  });
  return state;
}
function installPrivateClaimGuard(control){
  if(privateClaimWindows.has(control))return privateClaimWindows.get(control);
  const state={active:null};privateClaimWindows.set(control,state);
  control.db.function('factory_model_step_claim_guard',(key,witnessJson,stage)=>{
    const active=state.active;
    if(!active || key!==active.key || witnessJson!==active.witnessJson)return 0;
    if(stage==='insert' && !active.inserted && !active.started){active.inserted=true;return 1;}
    if(stage==='start' && active.inserted && !active.started){active.started=true;return 1;}
    return 0;
  });
  return state;
}

/** Explicit source-only schema3 installation from v1 only. Old schema2 is never inferred/upgraded. */
export function initializeOriginalModelStepSchema(control) {
  check(control instanceof FactoryControl, 'MODEL_STEP_SCHEMA_REQUIRED');
  return control.transaction(() => {
    const version = control.db.prepare('PRAGMA user_version').get().user_version;
    refuseMixedModelStepSchema(control,version);
    if (version === MODEL_STEP_DATABASE_VERSION) { requireModelStepSchema(control); return { schemaVersion: MODEL_STEP_DATABASE_VERSION, fresh: false, liveMigration: 'HOLD' }; }
    check(version === 1, 'MODEL_STEP_SCHEMA_REQUIRED');
    check(control.control().status === 'paused'
      && !control.db.prepare("SELECT 1 FROM effects WHERE state IN ('accepted','running','unknown')").get()
      && !control.db.prepare("SELECT 1 FROM tasks WHERE status='running'").get()
      && !control.db.prepare('SELECT 1 FROM integrations WHERE expires>?').get(control.clock()), 'MODEL_STEP_MIGRATION_HOLD');
    control.db.exec(MODEL_STEP_SCHEMA_SQL); installModelStepMutationGuard(control);
    control.event('model_step_schema_initialized', 'root', { schemaVersion: MODEL_STEP_DATABASE_VERSION, recordedDrained: true, oldWriterQuiescence: 'unverified', liveMigration: 'HOLD' });
    return { schemaVersion: MODEL_STEP_DATABASE_VERSION, fresh: true, liveMigration: 'HOLD' };
  });
}

/** New drained synthetic databases only. Schema3 and live Original migration remain HOLD. */
export function initializeOriginalModelParentStartSchema4(control, configuration) {
  check(control instanceof FactoryControl && configuration && !types.isProxy(configuration)
    && Object.getPrototypeOf(configuration)===Object.prototype && Reflect.ownKeys(configuration).length===1
    && Object.getOwnPropertyDescriptor(configuration,'mode')?.value==='trusted-fixture-only','MODEL_PARENT_FIXTURE_MODE_REQUIRED');
  return control.transaction(()=>{
    const version=control.db.prepare('PRAGMA user_version').get().user_version;
    refuseMixedModelStepSchema(control,version);
    if (version===MODEL_PARENT_START_DATABASE_VERSION) { requireModelStepSchema(control); return {schemaVersion:4,fresh:false,mode:'trusted-fixture-only',liveMigration:'HOLD'}; }
    check(version===1,'MODEL_PARENT_SCHEMA4_INITIALIZATION_REQUIRED');
    check(control.control().status==='paused'
      && !control.db.prepare("SELECT 1 FROM effects WHERE state IN ('accepted','running','unknown')").get()
      && !control.db.prepare("SELECT 1 FROM tasks WHERE status='running'").get()
      && !control.db.prepare('SELECT 1 FROM integrations WHERE expires>?').get(control.clock()),'MODEL_STEP_MIGRATION_HOLD');
    control.db.exec(MODEL_PARENT_START_SCHEMA_SQL); installModelStepMutationGuard(control);
    control.event('model_parent_start_schema_initialized','root',{schemaVersion:4,mode:'trusted-fixture-only',liveMigration:'HOLD',oldWriterQuiescence:'unverified'});
    return {schemaVersion:4,fresh:true,mode:'trusted-fixture-only',liveMigration:'HOLD'};
  });
}

/** Ledger transitions only. Host-owned bootstrap/handles are not request arguments. No sender exists. */
export class OriginalModelStepJournal {
  #control; #paid; #bootstrap; #compareReceiver; #claimWindow; #parentStartWindow; #parentEntry; #parentLifetimes=new WeakMap();
  constructor({ control, paidAdmission, bootstrap, compareReceiver = null, parentEntry = null }) {
    check(control instanceof FactoryControl && paidAdmission instanceof SpendingLedger, 'MODEL_STEP_HOST_REQUIRED');
    requireModelStepSchema(control); installModelStepMutationGuard(control);
    check(bootstrap && typeof bootstrap.authenticate === 'function' && typeof bootstrap.withVerified === 'function', 'MODEL_STEP_HOST_REQUIRED');
    check(compareReceiver === null || typeof compareReceiver === 'function', 'MODEL_STEP_RECEIVER_REQUIRED');
    this.#control = control; this.#paid = paidAdmission; this.#bootstrap = bootstrap; this.#compareReceiver = compareReceiver;
    this.#claimWindow=installPrivateClaimGuard(control);
    this.#parentStartWindow=installPrivateParentStartGuard(control);
    if (parentEntry!==null) {
      check(control.db.prepare('PRAGMA user_version').get().user_version===MODEL_PARENT_START_DATABASE_VERSION,'MODEL_PARENT_SCHEMA4_REQUIRED');
      check(parentEntry && !types.isProxy(parentEntry) && Object.getPrototypeOf(parentEntry)===Object.prototype
        && Reflect.ownKeys(parentEntry).length===3 && Object.getOwnPropertyDescriptor(parentEntry,'mode')?.value==='trusted-fixture-only'
        && typeof Object.getOwnPropertyDescriptor(parentEntry,'generation')?.value==='string'
        && /^[a-zA-Z0-9_.:-]{1,128}$/.test(parentEntry.generation)
        && typeof Object.getOwnPropertyDescriptor(parentEntry,'currentGeneration')?.value==='function','MODEL_PARENT_FIXTURE_MODE_REQUIRED');
      this.#parentEntry=Object.freeze({mode:parentEntry.mode,generation:parentEntry.generation,currentGeneration:parentEntry.currentGeneration});
    } else this.#parentEntry=null;
  }
  #record(capability) { return withOriginalInferenceCapability(this.#bootstrap, capability, r => r); }
  #receiver(record) {
    check(typeof this.#compareReceiver === 'function', 'MODEL_STEP_RECEIVER_REQUIRED');
    let result;
    const expected = { format: 'factory-original-model-step-receiver-comparison', schemaVersion: 1,
      renderer: record.body.renderer, bodySha256: record.body.sha256,
      modelManifestDigest: record.model.manifestDigest, recipientId: record.call.recipientId };
    try {
      result = this.#compareReceiver(record);
      if (types.isPromise(result)) { Promise.prototype.then.call(result, () => {}, () => {}); modelStepFail(); }
      check(result && !types.isProxy(result) && Object.getPrototypeOf(result) === Object.prototype
        && Reflect.ownKeys(result).length === Object.keys(expected).length
        && Object.entries(expected).every(([k, v]) => Object.getOwnPropertyDescriptor(result, k)?.value === v));
    } catch { modelStepFail('MODEL_STEP_RECEIVER_REQUIRED'); }
    return modelStepDigest(expected);
  }
  #verify(capability, lease) {
    const record = this.#record(capability), proof = originalModelStepManifestProof(this.#bootstrap, capability);
    verifyModelStepManifestProof(this.#control, lease, record.parent.request, proof);
    return record;
  }
  #parent(record, states = ['running']) {
    requireModelStepSchema(this.#control);
    const parent = this.#control.effect(record.parent.effectKey);
    check(parent.kind === 'flow_call' && parent.scope === 'task' && parent.scope_id === record.task.id
      && parent.task_id === record.task.id && parent.owner === record.lease.cellId
      && parent.owner_epoch === record.lease.epoch && parent.control_epoch === record.lease.controlEpoch
      && parent.request_digest === record.parent.requestSha256 && states.includes(parent.state), 'MODEL_STEP_PARENT_CLOSED');
    assertModelParentStart(this.#control,parent,record);
    const manifest = this.#control.db.prepare('SELECT * FROM model_step_manifests WHERE parent_key=?').get(parent.key);
    check(manifest && manifest.spec_digest === record.task.specDigest && manifest.plan_sha256 === modelStepDigest(record.plan)
      && manifest.plan_json === canonical(record.plan), 'MODEL_STEP_MANIFEST_REQUIRED');
    const slot = this.#control.db.prepare('SELECT * FROM model_step_slots WHERE parent_key=? AND node_id=? AND ordinal=?')
      .get(parent.key, record.call.slot.nodeId, record.call.slot.ordinal);
    check(slot && slot.request_id === record.call.requestId && slot.nonce === record.call.nonce && slot.binding_sha256 === callBinding(record), 'MODEL_STEP_SLOT_BINDING');
    return parent;
  }
  #paidFence(record) {
    this.#paid.assertAdmission();
    const row = this.#paid.row(record.reservation.reservationId), snapshot = this.#paid.snapshot();
    check(row.state === 'started' && row.provider === record.reservation.provider && row.ceiling_cents === record.reservation.ceilingCents
      && row.ceiling_cents > 0 && (row.charged_cents === null || row.charged_cents < row.ceiling_cents)
      && snapshot.overCommittedCents === 0, 'MODEL_STEP_PAID_FENCE');
    return {chargedCents:row.charged_cents,overCommittedCents:snapshot.overCommittedCents};
  }
  #stored(record) {
    requireModelStepSchema(this.#control);
    const binding = this.#control.db.prepare('SELECT * FROM model_step_bindings WHERE effect_key=?').get(keyFor(record));
    if (!binding) return null;
    check(binding.parent_key === record.parent.effectKey && binding.node_id === record.call.slot.nodeId
      && binding.ordinal === record.call.slot.ordinal && binding.request_id === record.call.requestId
      && binding.nonce === record.call.nonce && binding.binding_sha256 === callBinding(record)
      && binding.envelope_sha256 === modelStepDigest(record) && binding.envelope_json === canonical(record), 'CONFLICT');
    const child = this.#control.effect(binding.effect_key);
    check(child.kind === 'model_step' && child.scope === 'task' && child.scope_id === record.task.id && child.task_id === record.task.id
      && child.owner === record.lease.cellId && child.owner_epoch === record.lease.epoch && child.control_epoch === record.lease.controlEpoch
      && child.request_digest === binding.envelope_sha256, 'MODEL_STEP_BINDING');
    assertModelStepClaim(this.#control,binding,child);
    return child;
  }
  #view(child, fresh = false) {
    return Object.freeze({ key: child.key, state: child.state, requestDigest: child.request_digest, fresh,
      observationOnly: !fresh, runtimeAdmission: 'HOLD', scope: 'source-only-logical-journal' });
  }
  #schema4() {
    requireModelStepSchema(this.#control);
    check(this.#control.db.prepare('PRAGMA user_version').get().user_version===MODEL_PARENT_START_DATABASE_VERSION,'MODEL_PARENT_SCHEMA4_REQUIRED');
  }
  #generationFence() {
    check(this.#parentEntry?.mode==='trusted-fixture-only','MODEL_PARENT_FIXTURE_MODE_REQUIRED');
    let generation;
    try { generation=this.#parentEntry.currentGeneration(); }
    catch { modelStepFail('MODEL_PARENT_GENERATION_CHANGED'); }
    if (types.isPromise(generation)) { Promise.prototype.then.call(generation,()=>{},()=>{}); modelStepFail('MODEL_PARENT_GENERATION_CHANGED'); }
    check(generation===this.#parentEntry.generation,'MODEL_PARENT_GENERATION_CHANGED');
  }
  #lifetime(record,parentStart) {
    if (this.#control.db.prepare('PRAGMA user_version').get().user_version!==MODEL_PARENT_START_DATABASE_VERSION) return;
    const lifetime=parentStart && this.#parentLifetimes.get(parentStart);
    check(lifetime?.active && lifetime.parentKey===record.parent.effectKey,'MODEL_PARENT_LIFETIME_REQUIRED');
    const start=assertModelParentStart(this.#control,this.#parent(record),record);
    check(start && start.start_nonce===lifetime.startNonce,'MODEL_PARENT_LIFETIME_REQUIRED');
    this.#generationFence();
    check(start.generation===this.#parentEntry.generation,'MODEL_PARENT_GENERATION_CHANGED');
  }
  #parentView(record, fresh=false) {
    const parent=this.#parent(record,['accepted','running','unknown','succeeded','not_applied']);
    const start=assertModelParentStart(this.#control,parent,record);
    return Object.freeze({key:parent.key,state:parent.state,requestDigest:parent.request_digest,
      startWitnessSha256:start?.witness_sha256??null,fresh,observationOnly:!fresh,mode:'trusted-fixture-only',
      runtimeAdmission:'HOLD',scope:'source-only-parent-start-journal'});
  }
  #unknownParent(record,startNonce) {
    this.#control.transaction(()=>{
      const parent=this.#parent(record,['running','unknown','succeeded']);
      const start=assertModelParentStart(this.#control,parent,record);
      check(start.start_nonce===startNonce,'MODEL_PARENT_LIFETIME_REQUIRED');
      if (parent.state==='running') {
        this.#control.db.prepare("UPDATE effects SET state='unknown',updated=? WHERE key=? AND state='running'").run(this.#control.clock(),parent.key);
        this.#control.event('original_model_parent_entry_closed',parent.key,{state:'unknown',startWitnessSha256:start.witness_sha256,mode:'trusted-fixture-only',runtimeAdmission:'HOLD'});
      }
    });
  }
  /** Durable start before any callback. Existing history never creates a new execution lifetime. */
  async withParentStart(lease,capability,enter) {
    this.#schema4(); check(typeof enter==='function','MODEL_PARENT_ENTRY_REQUIRED');
    const record=this.#record(capability),startNonce=randomBytes(32).toString('hex');
    let lifetime=null,created=false;
    try {
      const fresh=this.#paid.transaction(()=>this.#control.transaction(()=>{
        const parent=this.#parent(record,['accepted','running','unknown','succeeded','not_applied']);
        if (parent.state!=='accepted') return false;
        check(!this.#control.db.prepare('SELECT 1 FROM model_step_aborts WHERE parent_key=?').get(parent.key),'MODEL_PARENT_ABORT_INCONSISTENT');
        this.#generationFence(); this.#verify(capability,lease); this.#receiver(record);
        const manifest=this.#control.db.prepare('SELECT * FROM model_step_manifests WHERE parent_key=?').get(parent.key);
        check(manifest.enrollment_envelope_sha256===modelStepDigest(record),'MODEL_PARENT_ENROLLMENT_REQUIRED');
        const witness=modelParentStartWitness(record,{generation:this.#parentEntry.generation,startNonce,
          ...this.#paidFence(record),admittedAt:this.#control.clock()});
        check(!this.#parentStartWindow.active,'MODEL_PARENT_START_CONFLICT');
        const active={key:parent.key,witnessJson:witness.witness_json,inserted:false,started:false};
        this.#parentStartWindow.active=active;
        try {
          this.#control.db.prepare('INSERT INTO model_parent_starts(parent_key,enrollment_envelope_sha256,envelope_json,start_nonce,generation,witness_json,witness_sha256,admitted_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(witness.parent_key,witness.enrollment_envelope_sha256,witness.envelope_json,witness.start_nonce,witness.generation,witness.witness_json,witness.witness_sha256,witness.admitted_at);
          const update=this.#control.db.prepare("UPDATE effects SET state='running',updated=? WHERE key=? AND state='accepted'").run(witness.admitted_at,parent.key);
          check(update.changes===1 && active.inserted && active.started,'MODEL_PARENT_START_CONFLICT');
          created=true;
        } finally { this.#parentStartWindow.active=null; }
        this.#control.event('original_model_parent_started',parent.key,{startWitnessSha256:witness.witness_sha256,mode:'trusted-fixture-only',runtimeAdmission:'HOLD'});
        return true;
      }));
      if (!fresh) return {kind:'observation',parent:this.#parentView(record)};
      // A failed final fence cannot roll back the separately committed start.
      this.#generationFence();
      this.#paid.transaction(()=>this.#control.transaction(()=>{
        this.#verify(capability,lease); this.#parent(record); this.#paidFence(record);
      }));
      const parentStart=Object.freeze(Object.create(null));
      lifetime={parentKey:record.parent.effectKey,startNonce,active:true}; this.#parentLifetimes.set(parentStart,lifetime);
      // No await between the final local snapshot and callback invocation. This
      // is not a distributed OFF broker or a physical provider authorization.
      // Ordinary synchronous returns retire before any queued microtask. Only
      // genuine Promises keep the lifetime pending; thenables are plain values.
      const result=enter(parentStart);
      const value=types.isPromise(result)?await result:result;
      lifetime.active=false; this.#unknownParent(record,startNonce);
      return {kind:'fresh',parent:this.#parentView(record,true),value};
    } catch (error) {
      if (lifetime) lifetime.active=false;
      if (created) {
        const start=this.#control.db.prepare('SELECT * FROM model_parent_starts WHERE parent_key=?').get(record.parent.effectKey);
        if (start?.start_nonce===startNonce) this.#unknownParent(record,startNonce);
      }
      throw error;
    } finally { if (lifetime) lifetime.active=false; }
  }
  observeParent(capability) { this.#schema4(); return this.#parentView(this.#record(capability)); }
  /** Authenticate complete fixed manifest and materialize all slots with parent admission before any POST. */
  admitParent(lease, capability) {
    const record = this.#record(capability); this.#receiver(record);
    const proof = originalModelStepManifestProof(this.#bootstrap, capability);
    const result = this.#control.admitNativeMissionEffect(lease, record.parent.request, proof);
    return { ...result, runtimeAdmission: 'HOLD', scope: 'source-only-parent-manifest' };
  }
  register(lease, capability, {parentStart} = {}) {
    const record = this.#record(capability), receiverSha256 = this.#receiver(record);
    return this.#control.transaction(() => {
      const previous = this.#stored(record);
      if (previous) return this.#view(previous);
      this.#lifetime(record,parentStart);
      this.#verify(capability, lease); this.#parent(record);
      const now = this.#control.clock(), key = keyFor(record);
      this.#control.db.prepare('INSERT INTO effects(key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(key, 'task', record.task.id, record.task.id, record.lease.cellId, record.lease.epoch, record.lease.controlEpoch, 'model_step', modelStepDigest(record), 'accepted', now, now);
      this.#control.db.prepare('INSERT INTO model_step_bindings(effect_key,parent_key,node_id,ordinal,request_id,nonce,binding_sha256,envelope_sha256,envelope_json,receiver_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(key, record.parent.effectKey, record.call.slot.nodeId, record.call.slot.ordinal, record.call.requestId, record.call.nonce, callBinding(record), modelStepDigest(record), canonical(record), receiverSha256);
      this.#control.event('original_model_step_registered', key, { parentKey: record.parent.effectKey, envelopeSha256: modelStepDigest(record), receiverSha256, runtimeAdmission: 'HOLD' });
      return this.#view(this.#control.effect(key), true);
    });
  }
  /** Authenticated logical whole-plan abort while parent is accepted; preserves every immutable identity. */
  abortNeverDispatched(capability, receipt = {}) {
    const record = this.#record(capability), metadata = safeReceipt(receipt);
    return this.#control.transaction(() => {
      requireModelStepSchema(this.#control);
      if (this.#control.db.prepare('PRAGMA user_version').get().user_version===MODEL_PARENT_START_DATABASE_VERSION)
        check(!this.#control.db.prepare('SELECT 1 FROM model_parent_starts WHERE parent_key=?').get(record.parent.effectKey),'MODEL_PARENT_ALREADY_STARTED');
      check(!this.#control.db.prepare('SELECT 1 FROM model_step_claims WHERE parent_key=?').get(record.parent.effectKey),'MODEL_STEP_ABORT_STARTED');
      const previous = this.#control.db.prepare('SELECT * FROM model_step_aborts WHERE parent_key=?').get(record.parent.effectKey);
      if (previous) {
        check(previous.envelope_sha256 === modelStepDigest(record) && this.#control.effect(record.parent.effectKey).state === 'not_applied', 'MODEL_STEP_ABORT_BINDING');
        assertModelStepParentTerminal(this.#control,record.parent.effectKey,'not_applied');
        return { state: 'not_applied', observationOnly: true, runtimeAdmission: 'HOLD', scope: 'source-only-never-dispatched-plan-abort' };
      }
      const parent = this.#parent(record, ['accepted']);
      const manifest = this.#control.db.prepare('SELECT * FROM model_step_manifests WHERE parent_key=?').get(parent.key);
      check(manifest.enrollment_envelope_sha256 === modelStepDigest(record), 'MODEL_STEP_ABORT_BINDING');
      const bindings = this.#control.db.prepare('SELECT * FROM model_step_bindings WHERE parent_key=?').all(parent.key);
      check(bindings.every(b => {const child=this.#control.effect(b.effect_key);assertModelStepClaim(this.#control,b,child);return child.state==='accepted';}), 'MODEL_STEP_ABORT_STARTED');
      for (const binding of bindings) guardedModelStepMutation(this.#control, () => this.#control.db.prepare("UPDATE effects SET state='not_applied',updated=? WHERE key=? AND state='accepted'").run(this.#control.clock(),binding.effect_key));
      this.#control.db.prepare('INSERT INTO model_step_aborts(parent_key,spec_digest,plan_sha256,envelope_sha256,receipt_json,created) VALUES(?,?,?,?,?,?)')
        .run(parent.key,record.task.specDigest,modelStepDigest(record.plan),modelStepDigest(record),canonical(metadata),this.#control.clock());
      this.#control.event('original_model_step_plan_aborted',parent.key,{planSha256:manifest.plan_sha256,envelopeSha256:modelStepDigest(record),runtimeAdmission:'HOLD',physicalAbsence:'unqualified'});
      assertModelStepParentTerminal(this.#control,parent.key,'not_applied');
      const result=this.#control.db.prepare("UPDATE effects SET state='not_applied',receipt=?,updated=? WHERE key=? AND state='accepted'").run(canonical(metadata),this.#control.clock(),parent.key);
      check(result.changes===1,'MODEL_STEP_ABORT_STARTED');
      this.#control.event('effect_settled',parent.key,{state:'not_applied',receipt:metadata});
      return { state: 'not_applied', observationOnly: false, runtimeAdmission: 'HOLD', scope: 'source-only-never-dispatched-plan-abort' };
    });
  }
  /** One durable logical CAS across handlers/processes. No physical dispatch approval is returned. */
  claim(lease, capability, {parentStart} = {}) {
    const record = this.#record(capability);
    return this.#paid.transaction(() => this.#control.transaction(() => {
      const child = this.#stored(record); check(child, 'MODEL_STEP_NOT_REGISTERED');
      if (child.state !== 'accepted') return this.#view(child);
      this.#lifetime(record,parentStart);
      this.#verify(capability, lease); this.#parent(record);
      const receiverSha256=this.#receiver(record),paidSnapshot=this.#paidFence(record),admittedAt=this.#control.clock();
      const witness=modelStepClaimWitness(record,receiverSha256,{...paidSnapshot,admittedAt});
      const insert=this.#control.db.prepare('INSERT INTO model_step_claims(effect_key,parent_key,envelope_sha256,receiver_sha256,witness_json,witness_sha256,admitted_at) VALUES(?,?,?,?,?,?,?)');
      const insertArgs=[witness.effect_key,witness.parent_key,witness.envelope_sha256,witness.receiver_sha256,witness.witness_json,witness.witness_sha256,witness.admitted_at];
      const start=this.#control.db.prepare("UPDATE effects SET state='running',updated=? WHERE key=? AND state='accepted'");
      check(!this.#claimWindow.active,'MODEL_STEP_CLAIM_CONFLICT');
      const active={key:child.key,witnessJson:witness.witness_json,inserted:false,started:false};
      this.#claimWindow.active=active;
      try{
        insert.run(...insertArgs);
        const update=guardedModelStepMutation(this.#control,()=>start.run(admittedAt,child.key));
        check(update.changes===1 && active.inserted && active.started,'MODEL_STEP_CLAIM_CONFLICT');
      }finally{this.#claimWindow.active=null;}
      this.#control.event('original_model_step_claimed', child.key, { envelopeSha256: modelStepDigest(record),claimSha256:witness.witness_sha256, logicalOnly: true, runtimeAdmission: 'HOLD' });
      return this.#view(this.#stored(record), true);
    }));
  }
  /** Source-only observation settlement. Configured host provenance is still unqualified for deployment. */
  settle(capability, state, receipt = {}) {
    check(['succeeded', 'not_applied', 'unknown'].includes(state), 'MODEL_STEP_STATE');
    const record = this.#record(capability), metadata = safeReceipt(receipt);
    return this.#control.transaction(() => {
      const child = this.#stored(record); check(child, 'MODEL_STEP_NOT_REGISTERED');
      if (child.state === state && ['succeeded', 'not_applied', 'unknown'].includes(state)) return this.#view(child);
      check(['accepted', 'running', 'unknown'].includes(child.state), 'MODEL_STEP_STATE');
      check(state !== 'not_applied' || child.state === 'accepted', 'MODEL_STEP_NEGATIVE_UNSUPPORTED');
      check(state !== 'succeeded' || ['running', 'unknown'].includes(child.state), 'MODEL_STEP_STATE');
      check(state !== 'unknown' || ['running','unknown'].includes(child.state),'MODEL_STEP_STATE');
      this.#parent(record, ['running', 'unknown']);
      guardedModelStepMutation(this.#control, () => this.#control.db.prepare('UPDATE effects SET state=?,receipt=?,updated=? WHERE key=?').run(state, canonical(metadata), this.#control.clock(), child.key));
      this.#control.event('original_model_step_settled', child.key, { state, receipt: metadata, runtimeAdmission: 'HOLD' });
      return this.#view(this.#control.effect(child.key));
    });
  }
  observe(capability) {
    const record = this.#record(capability), child = this.#stored(record);
    check(child, 'MODEL_STEP_NOT_REGISTERED'); return this.#view(child);
  }
}
