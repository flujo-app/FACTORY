import { createHash } from 'node:crypto';
import path from 'node:path';
import { takeGitCasRefusal, updateIntegrationRef } from './adapters/git-delivery.mjs';

const proofs = new WeakMap();
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const EFFECT_FIELDS = ['key', 'kind', 'scope', 'scope_id', 'task_id', 'owner', 'owner_epoch', 'control_epoch', 'request_digest'];

function fail(code) { const error = new Error('Git delivery identity or refusal proof is invalid.'); error.code = code; throw error; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function capture(intent, lease, options) {
  if (!plain(intent) || !plain(intent.request) || !plain(lease) || !plain(options)
    || Object.keys(options).some(key => key !== 'gitPath')
    || Object.keys(intent).some(key => !['key', 'kind', 'taskId', 'request'].includes(key))
    || intent.kind !== 'delivery' || !ID.test(intent.key ?? '') || !ID.test(intent.taskId ?? '')
    || lease.scope !== 'project' || !ID.test(lease.scopeId ?? '') || !ID.test(lease.cellId ?? '')
    || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
    || !Number.isSafeInteger(lease.controlEpoch) || lease.controlEpoch < 1) fail('GIT_DELIVERY_INVALID');
  const keys = Object.keys(intent.request).sort();
  if (keys.join(',') !== 'candidateHead,expectedHead,ref,repository') fail('GIT_DELIVERY_INVALID');
  // All values and authority metadata are captured before the first await.
  const { repository, ref, expectedHead, candidateHead } = intent.request;
  if (typeof repository !== 'string' || !path.isAbsolute(repository) || typeof ref !== 'string'
    || !ref.startsWith('refs/heads/') || /[\x00-\x20\x7f]/.test(ref)
    || !/^[a-f0-9]{40}$/.test(expectedHead ?? '') || !/^[a-f0-9]{40}$/.test(candidateHead ?? '')) fail('GIT_DELIVERY_INVALID');
  const gitPath = options.gitPath ?? 'git';
  if (typeof gitPath !== 'string' || !gitPath.trim() || gitPath.includes('\0')) fail('GIT_DELIVERY_INVALID');
  const request = Object.freeze({ candidateHead, expectedHead, ref, repository });
  const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const authority = Object.freeze({ ...lease });
  return Object.freeze({ intent: Object.freeze({ key: intent.key, kind: 'delivery', taskId: intent.taskId, request }),
    lease: authority, request, requestDigest, gitPath });
}
function matches(effect, captured) {
  const { intent, lease, requestDigest } = captured;
  return effect.kind === 'delivery' && effect.scope === 'project' && effect.key === intent.key
    && effect.scope_id === lease.scopeId && effect.task_id === intent.taskId && effect.owner === lease.cellId
    && effect.owner_epoch === lease.epoch && effect.control_epoch === lease.controlEpoch && effect.request_digest === requestDigest;
}

/** Only proofs minted after this gateway's actual bound executor may settle a started refusal. */
export function consumeGitRefusalProof(proof, control, effect) {
  const record = proofs.get(proof);
  if (!record || record.control !== control || EFFECT_FIELDS.some(key => record.effect[key] !== effect[key])) return null;
  proofs.delete(proof);
  return record.receipt;
}

/** Dedicated trusted-local Git dispatch. No caller-supplied operation callback or serializable trust flag. */
export async function executeGitDelivery(control, lease, intent, options = {}) {
  const captured = capture(intent, lease, options);
  // Exact existing intents can be observed after pause/expiry; they never acquire new dispatch authority.
  const existing = control.db.prepare('SELECT key FROM effects WHERE key=?').get(captured.intent.key);
  if (existing) {
    const effect = control.effect(captured.intent.key);
    if (!matches(effect, captured)) fail('CONFLICT');
    return { dispatched: false, effect };
  }
  const admission = control.admitEffect(captured.lease, captured.intent);
  if (!matches(admission.effect, captured)) fail('CONFLICT');
  if (!admission.fresh) return { dispatched: false, effect: control.effect(captured.intent.key) };
  const started = control.startEffect(captured.lease, captured.intent.key);
  const effectIdentity = Object.freeze(Object.fromEntries(EFFECT_FIELDS.map(key => [key, started[key]])));
  try {
    const receipt = await updateIntegrationRef({ ...captured.request, gitPath: captured.gitPath });
    return { dispatched: true, effect: control.settleEffect(captured.intent.key, 'succeeded', receipt) };
  } catch (error) {
    const current = control.effect(captured.intent.key);
    if (['succeeded', 'not_applied'].includes(current.state)) return { dispatched: true, effect: current };
    const refusal = takeGitCasRefusal(error, captured.request);
    if (refusal) {
      const proof = Object.freeze(Object.create(null));
      proofs.set(proof, Object.freeze({ control, effect: effectIdentity,
        receipt: Object.freeze({ ref: refusal.ref, previousHead: refusal.expectedHead, head: refusal.observedHead }) }));
      try { return { dispatched: true, effect: control.settleGitRefusal(captured.intent.key, proof) }; }
      catch { /* A lost proof/receipt is still unknown; never rerun the adapter. */ }
    }
    if (['succeeded', 'not_applied'].includes(control.effect(captured.intent.key).state)) {
      return { dispatched: true, effect: control.effect(captured.intent.key) };
    }
    return { dispatched: true, effect: control.settleEffect(captured.intent.key, 'unknown',
      { reason: 'External outcome requires reconciliation.' }) };
  }
}
