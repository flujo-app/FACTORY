import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { nativeMissionRequest, nativeMissionEffectKey, canonicalMissionPacket } from './native-mission-contract.mjs';

const MAX_ENVELOPE = 262144, MAX_BODY = 32768, MAX_PROOF = 4096, MAX_DEPTH = 32, MAX_NODES = 8192;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, HEX = /^[a-f0-9]{64}$/;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const getter = key => Object.getOwnPropertyDescriptor(typed, key).get;
const byteLength = getter('byteLength'), byteOffset = getter('byteOffset'), backing = getter('buffer');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function deny() { throw Object.assign(new Error('Original inference provenance denied.'), { code: 'ORIGINAL_INFERENCE_DENIED' }); }
function check(ok) { if (!ok) deny(); }
function plain(v) { return v !== null && typeof v === 'object' && !types.isProxy(v) && Object.getPrototypeOf(v) === Object.prototype; }
function closed(v, keys) {
  check(plain(v)); const descriptors = Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(k => Object.hasOwn(descriptors, k) && Object.hasOwn(descriptors[k], 'value')));
}
function bytes(value, limit) {
  check(!types.isProxy(value) && types.isUint8Array(value));
  const length = byteLength.call(value), buffer = backing.call(value), offset = byteOffset.call(value);
  check(length > 0 && length <= limit && !types.isSharedArrayBuffer(buffer));
  return Buffer.from(new Uint8Array(buffer, offset, length));
}
function unicode(value) {
  check(typeof value === 'string');
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) check(++i < value.length && value.charCodeAt(i) >= 0xdc00 && value.charCodeAt(i) <= 0xdfff);
    else check(n < 0xdc00 || n > 0xdfff);
  }
  return value;
}
function text(input) {
  const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  check(value.charCodeAt(0) !== 0xfeff); return unicode(value);
}
function canonical(value, depth = 0, count = { nodes: 0 }) {
  check(depth <= MAX_DEPTH && ++count.nodes <= MAX_NODES);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(unicode(value));
  if (typeof value === 'number') { check(Number.isSafeInteger(value) && !Object.is(value, -0)); return String(value); }
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1, count)).join(',') + ']';
  check(plain(value));
  return '{' + Object.keys(value).sort().map(k => {
    check(/^[A-Za-z][A-Za-z0-9_]*$/.test(k));
    return JSON.stringify(k) + ':' + canonical(value[k], depth + 1, count);
  }).join(',') + '}';
}
const digest = value => sha(Buffer.from(canonical(value), 'utf8'));
const equal = (a, b) => canonical(a) === canonical(b);
const id = value => typeof value === 'string' && ID.test(value);
const hex = value => typeof value === 'string' && HEX.test(value);
const integer = (value, min = 1, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
function ordinary(value) {
  closed(value, ['confidentialityClass', 'classVersion']);
  check(value.confidentialityClass === 'ordinary' && value.classVersion === 1);
}
function freeze(value) { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }

// Validate JSON structure without renumbering Python's floating-point lexemes.
// This checks a declared projection, not that a future Python receiver rendered it.
function bodyProjection(source) {
  check(Buffer.byteLength(source, 'utf8') <= MAX_BODY); let at = 0, nodes = 0; const numbers = new Map();
  function string() {
    const start = at++; let escaped = false;
    while (at < source.length) {
      const c = source[at++];
      if (!escaped && c === '"') { const raw = source.slice(start, at), v = JSON.parse(raw); unicode(v); check(JSON.stringify(v) === raw); return v; }
      if (!escaped && c === '\\') escaped = true; else escaped = false;
    }
    deny();
  }
  function value(depth, location = '') {
    check(depth <= MAX_DEPTH && ++nodes <= MAX_NODES); const c = source[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; const out = Object.create(null); let previous = null;
      if (source[at] === '}') { at++; return out; }
      while (true) {
        check(source[at] === '"'); const key = string();
        check(/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && (previous === null || previous < key)); previous = key;
        check(source[at++] === ':'); out[key] = value(depth + 1, location + '.' + key);
        const end = source[at++]; if (end === '}') return out; check(end === ',');
      }
    }
    if (c === '[') {
      at++; const out = []; if (source[at] === ']') { at++; return out; }
      while (true) { out.push(value(depth + 1, location + '.' + out.length)); const end = source[at++]; if (end === ']') return out; check(end === ','); }
    }
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) if (source.startsWith(word, at)) { at += word.length; return v; }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    check(match); at += match[0].length; const v = Number(match[0]);
    check(Number.isFinite(v) && !Object.is(v, -0) && !(v === 0 && /[1-9]/.test(match[0].split(/[eE]/)[0]))); numbers.set(location, match[0]); return v;
  }
  const result = value(0); check(at === source.length); return { value: result, numbers };
}
function bodyClosed(v, required, optional = []) {
  check(v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === null);
  const keys = Object.keys(v); check(required.every(k => Object.hasOwn(v, k)) && keys.every(k => required.includes(k) || optional.includes(k)));
}
function validateBody(binding, model) {
  closed(binding, ['kind', 'renderer', 'canonicalUtf8', 'sha256']);
  check(['chat', 'completion'].includes(binding.kind) && binding.renderer === 'communityai-python-json-v1');
  unicode(binding.canonicalUtf8); check(hex(binding.sha256) && sha(Buffer.from(binding.canonicalUtf8, 'utf8')) === binding.sha256);
  const { value: body, numbers } = bodyProjection(binding.canonicalUtf8);
  const common = ['max_tokens', 'temperature', 'top_p', 'stop'];
  bodyClosed(body, ['model', binding.kind === 'chat' ? 'messages' : 'prompt', 'stream', 'n'], [...common, 'stream_options', ...(binding.kind === 'chat' ? ['max_completion_tokens', 'enable_thinking'] : [])]);
  check(body.model === model.manifestDigest && typeof body.stream === 'boolean' && body.n === 1 && numbers.get('.n') === '1');
  if (Object.hasOwn(body, 'stream_options')) {
    check(body.stream === true);
    bodyClosed(body.stream_options, ['include_usage']);
    check(typeof body.stream_options.include_usage === 'boolean');
  }
  for (const k of ['max_tokens', 'max_completion_tokens']) if (Object.hasOwn(body, k)) check(integer(body[k], 1, 1048576) && numbers.get('.' + k) === String(body[k]));
  for (const k of ['temperature', 'top_p']) if (Object.hasOwn(body, k)) check(typeof body[k] === 'number' && Number.isFinite(body[k]) && body[k] >= 0 && body[k] <= (k === 'temperature' ? 2 : 1));
  if (Object.hasOwn(body, 'enable_thinking')) check(typeof body.enable_thinking === 'boolean');
  const strings = v => typeof v === 'string' || Array.isArray(v) && v.length <= 1024 && v.every(x => typeof x === 'string');
  if (Object.hasOwn(body, 'stop')) check(strings(body.stop));
  if (binding.kind === 'completion') check(strings(body.prompt));
  else {
    check(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 1024);
    for (const message of body.messages) {
      bodyClosed(message, ['role', 'content']); check(['system', 'developer', 'user', 'assistant'].includes(message.role));
      if (typeof message.content !== 'string') {
        check(Array.isArray(message.content) && message.content.length <= 1024);
        for (const part of message.content) { bodyClosed(part, ['type', 'text']); check(part.type === 'text' && typeof part.text === 'string'); }
      }
    }
  }
}
export function validateOriginalCallPlan(plan) {
  closed(plan, ['format', 'schemaVersion', 'slots']);
  check(plan.format === 'factory-original-call-plan' && plan.schemaVersion === 1 && Array.isArray(plan.slots) && plan.slots.length > 0 && plan.slots.length <= 128);
  const requests = new Set(), nonces = new Set(), slots = new Set();
  for (const row of plan.slots) {
    closed(row, ['requestId', 'nonce', 'slot', 'bindingSha256', 'requiredOutcome']); closed(row.slot, ['nodeId', 'ordinal']);
    check(row.requiredOutcome === 'succeeded');
    check(/^[a-f0-9]{32}$/.test(row.requestId) && /^[a-f0-9]{32}$/.test(row.nonce) && id(row.slot.nodeId) && integer(row.slot.ordinal, 0, 1048576) && hex(row.bindingSha256));
    const slot = canonical(row.slot);
    check(!requests.has(row.requestId) && !nonces.has(row.nonce) && !slots.has(slot));
    requests.add(row.requestId); nonces.add(row.nonce); slots.add(slot);
  }
  return plan;
}
export function validateOriginalInferenceSpecification(value) {
  closed(value, ['schemaVersion', 'classification', 'issuerId', 'keyId', 'factoryId', 'originId', 'completeOriginalSha256', 'planSha256', 'plan']);
  check(value.schemaVersion === 1); ordinary(value.classification);
  check([value.issuerId, value.keyId, value.factoryId, value.originId].every(id) && hex(value.completeOriginalSha256) && hex(value.planSha256));
  validateOriginalCallPlan(value.plan); check(digest(value.plan) === value.planSha256);
  return value;
}
function validate(record, configured) {
  closed(record, ['format', 'schemaVersion', 'canonicalization', 'issuer', 'authority', 'classification', 'task', 'parent', 'lease', 'reservation', 'call', 'model', 'recipients', 'body', 'plan']);
  check(record.format === 'factory-original-inference' && record.schemaVersion === 2 && record.canonicalization === 'factory-json-safe-integer-v1');
  ordinary(record.classification);
  closed(record.issuer, ['id', 'keyId']); check(record.issuer.id === configured.issuerId && record.issuer.keyId === configured.keyId);
  closed(record.authority, ['factoryId', 'originId', 'contractVersion']); check(id(record.authority.factoryId) && id(record.authority.originId) && record.authority.contractVersion === 2);
  const task = record.task; closed(task, ['id', 'projectId', 'branch', 'specification', 'specDigest']);
  check(id(task.id) && id(task.projectId) && typeof task.branch === 'string' && /^codex\/[a-zA-Z0-9/_-]+$/.test(task.branch) && task.branch.length <= 256 && hex(task.specDigest));
  const spec = task.specification;
  closed(spec, ['problem', 'acceptance', 'baseline', 'nativeMission', 'taskType', 'originalInference']);
  check(typeof spec.problem === 'string' && spec.problem.length > 0 && typeof spec.baseline === 'string' && spec.baseline.length > 0 && Array.isArray(spec.acceptance) && spec.acceptance.length > 0 && spec.acceptance.every(v => typeof v === 'string' && v.length > 0));
  check(spec.taskType === 'software'); validateOriginalInferenceSpecification(spec.originalInference);
  check(spec.originalInference.issuerId === record.issuer.id && spec.originalInference.keyId === record.issuer.keyId && spec.originalInference.factoryId === record.authority.factoryId && spec.originalInference.originId === record.authority.originId);
  check(equal(record.classification, spec.originalInference.classification)); check(digest(spec) === task.specDigest);
  check(/^[a-f0-9]{40}$/.test(spec.nativeMission?.worker?.compatibility?.revision ?? ''));
  const lease = record.lease; closed(lease, ['scope', 'scopeId', 'cellId', 'epoch', 'controlEpoch', 'expires', 'tokenSha256']);
  check(lease.scope === 'task' && lease.scopeId === task.id && id(lease.cellId) && integer(lease.epoch) && integer(lease.controlEpoch) && integer(lease.expires) && hex(lease.tokenSha256));
  closed(record.parent, ['request', 'requestSha256', 'effectKey']);
  const request = nativeMissionRequest({ id: task.id, project_id: task.projectId, branch: task.branch, specification: spec, spec_digest: task.specDigest }, lease, record.parent.request?.outputFile);
  check(equal(request, record.parent.request) && digest(request) === record.parent.requestSha256 && record.parent.effectKey === nativeMissionEffectKey(request));
  // Safe-integer canonicalization matches the existing native packet in this restricted version.
  check(canonicalMissionPacket(spec) === canonical(spec));
  closed(record.reservation, ['reservationId', 'provider', 'ceilingCents']);
  check(record.reservation.reservationId === 'paid.' + record.parent.effectKey && record.reservation.provider === request.paid.provider && record.reservation.ceilingCents === request.paid.ceilingCents);
  closed(record.call, ['requestId', 'nonce', 'slot', 'principalId', 'role', 'recipientId']);
  check(/^[a-f0-9]{32}$/.test(record.call.requestId) && /^[a-f0-9]{32}$/.test(record.call.nonce) && id(record.call.principalId) && ['developer', 'reviewer', 'planner'].includes(record.call.role) && id(record.call.recipientId));
  closed(record.call.slot, ['nodeId', 'ordinal']); check(id(record.call.slot.nodeId) && integer(record.call.slot.ordinal, 0, 1048576));
  closed(record.model, ['manifestDigest', 'revision', 'numBlocks', 'policyVersion']);
  check(/^sha256:[a-f0-9]{64}$/.test(record.model.manifestDigest) && /^[a-f0-9]{40}$/.test(record.model.revision) && integer(record.model.numBlocks, 1, 4096) && record.model.policyVersion === 1);
  check(Array.isArray(record.recipients) && record.recipients.length > 0 && record.recipients.length <= 32);
  const ids = new Set(); let selected = 0;
  for (const recipient of record.recipients) {
    closed(recipient, ['id', 'principalId', 'role', 'kind', 'origin', 'identitySha256', 'buildSha256', 'generationSha256', 'classification']); ordinary(recipient.classification);
    check(id(recipient.id) && !ids.has(recipient.id) && id(recipient.principalId) && ['developer', 'reviewer', 'planner'].includes(recipient.role)); ids.add(recipient.id);
    check(recipient.kind === 'communityai-coordinator' && hex(recipient.identitySha256) && hex(recipient.buildSha256) && hex(recipient.generationSha256));
    const url = new URL(recipient.origin); check(url.origin === recipient.origin && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) && !url.username && !url.password);
    if (recipient.id === record.call.recipientId) { check(recipient.principalId === record.call.principalId && recipient.role === record.call.role); selected++; }
  }
  check(selected === 1); validateBody(record.body, record.model);
  validateOriginalCallPlan(record.plan); check(equal(record.plan, spec.originalInference.plan));
  const selectedSlot = record.plan.slots.filter(s => s.requestId === record.call.requestId);
  check(selectedSlot.length === 1 && selectedSlot[0].nonce === record.call.nonce && equal(selectedSlot[0].slot, record.call.slot)
    && selectedSlot[0].bindingSha256 === digest({ call: record.call, model: record.model, recipients: record.recipients, body: record.body }));
  return freeze(record);
}

const bootstraps = new WeakMap();
export function withOriginalInferenceCapability(bootstrap, capability, reader) {
  check(bootstraps.has(bootstrap) && typeof reader === 'function');
  return bootstraps.get(bootstrap)(capability, reader);
}

/** Pure v2 provenance bootstrap. No lease freshness, durable claim, budget or transport grant. */
export function createOriginalInferenceBootstrap(configuration) {
  try { closed(configuration, ['issuerId', 'keyId', 'verifyOriginal']); check(id(configuration.issuerId) && id(configuration.keyId) && typeof configuration.verifyOriginal === 'function'); }
  catch { deny(); }
  const configured = { issuerId: configuration.issuerId, keyId: configuration.keyId, verifyOriginal: configuration.verifyOriginal };
  const capabilities = new WeakMap();
  function authenticate(envelopeInput, proofInput) {
    try {
      const envelope = bytes(envelopeInput, MAX_ENVELOPE), proof = bytes(proofInput, MAX_PROOF), source = text(envelope);
      const record = JSON.parse(source); check(canonical(record) === source); validate(record, configured);
      const envelopeSha256 = sha(envelope);
      const result = configured.verifyOriginal(Object.freeze({ envelopeBytes: Buffer.from(envelope), proofBytes: Buffer.from(proof), envelopeSha256 }));
      if (types.isPromise(result)) { Promise.prototype.then.call(result, () => {}, () => {}); deny(); }
      closed(result, ['format', 'schemaVersion', 'issuerId', 'keyId', 'envelopeSha256', 'principalId', 'requestId', 'nonce']);
      check(result.format === 'factory-original-inference-authentication' && result.schemaVersion === 1 && result.issuerId === configured.issuerId && result.keyId === configured.keyId && result.envelopeSha256 === envelopeSha256 && result.principalId === record.call.principalId && result.requestId === record.call.requestId && result.nonce === record.call.nonce);
      const capability = Object.freeze(Object.create(null)); capabilities.set(capability, Object.freeze({ record, envelopeSha256 })); return capability;
    } catch { deny(); }
  }
  function verified(capability) { check(!types.isProxy(capability) && capability !== null && typeof capability === 'object' && capabilities.has(capability)); return capabilities.get(capability); }
  const bootstrap = Object.freeze({
    authenticate,
    inspect(capability) {
      const { record: r, envelopeSha256 } = verified(capability);
      return Object.freeze({ format: 'factory-original-inference-provenance', schemaVersion: 2, requestId: r.call.requestId, nonce: r.call.nonce, taskId: r.task.id, specDigest: r.task.specDigest, bodySha256: r.body.sha256, envelopeSha256, scope: 'provenance-only', runtimeAdmission: 'HOLD' });
    },
    withVerified(capability, reader) { const { record } = verified(capability); check(typeof reader === 'function'); return reader(record); }
  });
  bootstraps.set(bootstrap, bootstrap.withVerified); return bootstrap;
}
