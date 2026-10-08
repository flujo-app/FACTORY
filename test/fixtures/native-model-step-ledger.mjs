/**
 * Test-only design fixture. This is deliberately outside src/: no production
 * issuer, gateway, or native mission is allowed to call these methods.
 */
import { digest } from '../../src/control.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const STEP_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function refuse(code, message) { throw Object.assign(new Error(message), { code }); }
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function sha(value) { return typeof value === 'string' && SHA256.test(value); }

function declaration(task) {
  // A v1 native mission cannot be retroactively reclassified by a step request.
  if (Object.hasOwn(task.specification, 'nativeMission')) refuse('FIXTURE_ORIGINAL_V2', 'This fixture cannot upgrade a native mission.');
  const value = task.specification.fixtureOriginalFlow;
  if (!exact(value, ['schemaVersion', 'confidentialityClass', 'flowSha256', 'stepPlan'])
      || value.schemaVersion !== 2 || value.confidentialityClass !== 'ordinary'
      || !sha(value.flowSha256) || !Array.isArray(value.stepPlan) || value.stepPlan.length < 1
      || value.stepPlan.length > 16 || new Set(value.stepPlan.map(step => step.stepId)).size !== value.stepPlan.length
      || value.stepPlan.some(step => !exact(step, ['stepId', 'selectedManifestSha256', 'roleGraphSha256'])
        || !STEP_ID.test(step.stepId) || !sha(step.selectedManifestSha256) || !sha(step.roleGraphSha256))) {
    refuse('FIXTURE_ORIGINAL_V2', 'An immutable fixture-only original ordinary Flow declaration is required.');
  }
  return value;
}

export function fixtureParentRequest(task, lease) {
  const source = declaration(task);
  return { format: 'fixture-original-flow-post', schemaVersion: 2, taskId: task.id,
    specDigest: task.spec_digest, attempt: lease.epoch, controlEpoch: lease.controlEpoch,
    confidentialityClass: source.confidentialityClass, flowSha256: source.flowSha256,
    stepPlanDigest: digest(source.stepPlan) };
}

export function fixtureParentKey(request) { return 'fixture.flow.' + digest(request); }

function original(control, lease, parentEffectKey) {
  if (lease?.scope !== 'task') refuse('FIXTURE_AUTHORITY', 'Exact task authority is required.');
  const owner = control.authority(lease);
  const task = control.task(lease.scopeId);
  const source = declaration(task);
  if (digest(task.specification) !== task.spec_digest) refuse('FIXTURE_ORIGINAL_V2', 'Original task specification changed.');
  const request = fixtureParentRequest(task, lease);
  const expectedKey = fixtureParentKey(request);
  const parent = control.effect(parentEffectKey);
  if (parentEffectKey !== expectedKey || parent.kind !== 'flow_call' || parent.scope !== 'task'
      || parent.scope_id !== task.id || parent.task_id !== task.id || parent.owner !== owner.owner
      || parent.owner_epoch !== lease.epoch || parent.control_epoch !== lease.controlEpoch
      || parent.request_digest !== digest(request) || parent.state !== 'running') {
    refuse('FIXTURE_PARENT', 'The exact original running Flow effect is required.');
  }
  const accepted = control.db.prepare("SELECT details FROM events WHERE type='effect_accepted' AND subject=?").all(expectedKey);
  if (accepted.length !== 1 || JSON.parse(accepted[0].details).requestDigest !== parent.request_digest) {
    refuse('FIXTURE_PARENT', 'The original Flow admission history is required.');
  }
  return { task, source };
}

function row(control, key) {
  const value = control.db.prepare('SELECT * FROM fixture_model_steps WHERE key=?').get(key);
  if (!value) refuse('FIXTURE_STEP', 'Registered model step is required.');
  return value;
}

/** The fixture uses the controller's actual SQLite connection and BEGIN IMMEDIATE. */
export class FixtureModelStepLedger {
  constructor(control) { this.control = control; }

  initialize() {
    this.control.transaction(() => this.control.db.exec(`
      CREATE TABLE IF NOT EXISTS fixture_model_steps(
        key TEXT PRIMARY KEY,
        parent_effect_key TEXT NOT NULL REFERENCES effects(key),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        task_attempt INTEGER NOT NULL,
        control_epoch INTEGER NOT NULL,
        step_id_sha256 TEXT NOT NULL,
        class_digest TEXT NOT NULL,
        request_id_sha256 TEXT NOT NULL,
        selected_manifest_sha256 TEXT NOT NULL,
        role_graph_sha256 TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        descriptor_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('registered','claimed','unknown')),
        registered_at INTEGER NOT NULL,
        claimed_at INTEGER,
        UNIQUE(parent_effect_key, step_id_sha256),
        UNIQUE(parent_effect_key, request_id_sha256)
      );
    `));
  }

  register(lease, parentEffectKey, input) {
    if (!exact(input, ['stepId', 'requestIdSha256', 'bodySha256'])
        || !STEP_ID.test(input.stepId) || !sha(input.requestIdSha256) || !sha(input.bodySha256)) {
      refuse('FIXTURE_STEP', 'Exact digest-only step registration is required.');
    }
    return this.control.transaction(() => {
      const { task, source } = original(this.control, lease, parentEffectKey);
      const plan = source.stepPlan.find(step => step.stepId === input.stepId);
      if (!plan) refuse('FIXTURE_STEP', 'Step is absent from the immutable original plan.');
      const stepIdSha256 = digest(input.stepId);
      const key = 'fixture.step.' + digest({ parentEffectKey, stepIdSha256 });
      const descriptor = { parentEffectKey, taskId: task.id, specDigest: task.spec_digest,
        attempt: lease.epoch, controlEpoch: lease.controlEpoch, stepIdSha256,
        classDigest: digest(source.confidentialityClass), requestIdSha256: input.requestIdSha256,
        selectedManifestSha256: plan.selectedManifestSha256, roleGraphSha256: plan.roleGraphSha256,
        bodySha256: input.bodySha256 };
      const descriptorDigest = digest(descriptor);
      const previous = this.control.db.prepare('SELECT * FROM fixture_model_steps WHERE key=?').get(key);
      if (previous) {
        if (previous.descriptor_digest !== descriptorDigest) refuse('FIXTURE_CONFLICT', 'Original step registration differs.');
        return { key, fresh: false, state: previous.state, descriptorDigest };
      }
      this.control.db.prepare(`INSERT INTO fixture_model_steps
        (key,parent_effect_key,task_id,task_attempt,control_epoch,step_id_sha256,class_digest,request_id_sha256,
         selected_manifest_sha256,role_graph_sha256,body_sha256,descriptor_digest,state,registered_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(key, parentEffectKey, task.id, lease.epoch, lease.controlEpoch,
        stepIdSha256, descriptor.classDigest, input.requestIdSha256, plan.selectedManifestSha256,
        plan.roleGraphSha256, input.bodySha256, descriptorDigest, 'registered', this.control.clock());
      return { key, fresh: true, state: 'registered', descriptorDigest };
    });
  }

  claim(lease, key) {
    return this.control.transaction(() => {
      const current = row(this.control, key);
      const { task, source } = original(this.control, lease, current.parent_effect_key);
      const plan = source.stepPlan.find(step => digest(step.stepId) === current.step_id_sha256);
      const descriptor = { parentEffectKey: current.parent_effect_key, taskId: task.id,
        specDigest: task.spec_digest, attempt: lease.epoch, controlEpoch: lease.controlEpoch,
        stepIdSha256: current.step_id_sha256, classDigest: digest(source.confidentialityClass),
        requestIdSha256: current.request_id_sha256,
        selectedManifestSha256: plan?.selectedManifestSha256, roleGraphSha256: plan?.roleGraphSha256,
        bodySha256: current.body_sha256 };
      if (!plan || current.key !== 'fixture.step.' + digest({ parentEffectKey: current.parent_effect_key, stepIdSha256: current.step_id_sha256 })
          || current.task_id !== task.id || current.task_attempt !== lease.epoch
          || current.control_epoch !== lease.controlEpoch || current.class_digest !== descriptor.classDigest
          || current.selected_manifest_sha256 !== plan.selectedManifestSha256
          || current.role_graph_sha256 !== plan.roleGraphSha256 || !sha(current.request_id_sha256)
          || !sha(current.body_sha256) || current.descriptor_digest !== digest(descriptor)) {
        refuse('FIXTURE_STEP', 'Registered original step has changed.');
      }
      if (current.state !== 'registered') return { key, claimed: false, state: current.state };
      const changed = this.control.db.prepare("UPDATE fixture_model_steps SET state='claimed',claimed_at=? WHERE key=? AND state='registered'")
        .run(this.control.clock(), key).changes;
      if (changed !== 1) refuse('FIXTURE_RACE', 'A competing step claim won.');
      return { key, claimed: true, state: 'claimed' };
    });
  }

  markUnknown(key) {
    return this.control.transaction(() => {
      const current = row(this.control, key);
      if (current.state === 'registered') refuse('FIXTURE_STEP', 'Unclaimed step has no external outcome.');
      if (current.state === 'claimed') this.control.db.prepare("UPDATE fixture_model_steps SET state='unknown' WHERE key=?").run(key);
      return this.record(key);
    });
  }

  record(key) { return row(this.control, key); }
}
