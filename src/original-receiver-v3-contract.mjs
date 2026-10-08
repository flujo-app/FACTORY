import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { nativeMissionEffectKey, nativeMissionRequest } from './native-mission-contract.mjs';

// Offline contract candidate only. This module has no journal, credential reader,
// transport, or authority to change an accepted child into a physical attempt.
const MAX_ENVELOPE = 262144;
const MAX_BODY = 32768;
const MAX_PROOF = 4096;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HEX = /^[a-f0-9]{64}$/;
const HEADER_NAMES = Object.freeze([
  'accept', 'content-type', 'user-agent', 'x-stainless-arch', 'x-stainless-lang',
  'x-stainless-os', 'x-stainless-package-version', 'x-stainless-retry-count',
  'x-stainless-runtime', 'x-stainless-runtime-version'
]);
const heldResults = new WeakMap();
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset').get;
const backing = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const sha = value => createHash('sha256').update(value).digest('hex');
const deny = () => { throw Object.assign(new Error('Original receiver v3 contract denied.'), { code: 'ORIGINAL_RECEIVER_V3_DENIED' }); };
const check = condition => { if (!condition) deny(); };
const id = value => typeof value === 'string' && ID.test(value);
const hex = value => typeof value === 'string' && HEX.test(value);
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
function plain(value) { return value !== null && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype; }
function closed(value, keys) {
  check(plain(value));
  const fields = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(fields).length === keys.length && keys.every(key => Object.hasOwn(fields, key) && Object.hasOwn(fields[key], 'value')));
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
function canonical(value, depth = 0, state = { nodes: 0 }) {
  check(depth <= 32 && ++state.nodes <= 8192);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(unicode(value));
  if (typeof value === 'number') { check(Number.isSafeInteger(value) && !Object.is(value, -0)); return String(value); }
  if (Array.isArray(value)) { check(!types.isProxy(value)); return '[' + value.map(item => canonical(item, depth + 1, state)).join(',') + ']'; }
  check(plain(value));
  return '{' + Object.keys(value).sort().map(key => {
    check(/^[A-Za-z][A-Za-z0-9_]*$/.test(key));
    return JSON.stringify(key) + ':' + canonical(value[key], depth + 1, state);
  }).join(',') + '}';
}
export const originalReceiverV3Digest = value => sha(Buffer.from(canonical(value), 'utf8'));
/** Read a genuine held result without accepting a serialized/caller-made echo. */
export function withOriginalReceiverV3HeldResult(result, reader) {
  check(result && !types.isProxy(result) && heldResults.has(result) && typeof reader === 'function');
  return reader(heldResults.get(result));
}
const equal = (a, b) => canonical(a) === canonical(b);
function utf8(value, length, hash) {
  unicode(value);
  const bytes = Buffer.from(value, 'utf8');
  check(bytes.length > 0 && bytes.length <= MAX_BODY && length === bytes.length && hex(hash) && sha(bytes) === hash);
  return bytes;
}
function headerProjection(headers, hash) {
  check(Array.isArray(headers) && headers.length === HEADER_NAMES.length && hex(hash));
  headers.forEach((pair, index) => {
    check(Array.isArray(pair) && pair.length === 2 && pair[0] === HEADER_NAMES[index]
      && typeof pair[1] === 'string' && pair[1].length > 0 && pair[1].length <= 256
      && /^[\x20-\x7e]+$/.test(pair[1]));
  });
  check(sha(Buffer.from(JSON.stringify(headers), 'utf8')) === hash);
}
function bodyProjection(body, model) {
  check(plain(body) && body.model === model.manifestDigest && body.stream === true
    && plain(body.stream_options) && body.stream_options.include_usage === true
    && typeof body.prompt_cache_key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.prompt_cache_key)
    && Array.isArray(body.messages) && body.messages.length > 0);
  for (const message of body.messages) check(plain(message) && typeof message.role === 'string' && typeof message.content === 'string');
}
function validate(record, configured) {
  closed(record, ['format', 'schemaVersion', 'canonicalization', 'issuer', 'authority', 'classification', 'task', 'parent', 'lease', 'reservation', 'call', 'model', 'recipient', 'sender', 'credential', 'wire', 'receiver', 'plan']);
  check(record.format === 'factory-original-inference' && record.schemaVersion === 3 && record.canonicalization === 'factory-json-safe-integer-v1');
  closed(record.issuer, ['id', 'keyId']);
  check(record.issuer.id === configured.issuerId && record.issuer.keyId === configured.keyId);
  closed(record.authority, ['factoryId', 'originId', 'contractVersion']);
  check(id(record.authority.factoryId) && id(record.authority.originId) && record.authority.contractVersion === 3);
  closed(record.classification, ['confidentialityClass', 'classVersion']);
  check(record.classification.confidentialityClass === 'ordinary' && record.classification.classVersion === 1);
  closed(record.task, ['id', 'projectId', 'branch', 'specification', 'specDigest']);
  const task = record.task;
  check(id(task.id) && id(task.projectId) && typeof task.branch === 'string' && /^codex\/[A-Za-z0-9/_-]+$/.test(task.branch)
    && task.branch.length <= 256 && hex(task.specDigest));
  closed(task.specification, ['problem', 'acceptance', 'baseline', 'nativeMission', 'taskType', 'originalInference']);
  check(task.specification.taskType === 'software' && typeof task.specification.problem === 'string' && task.specification.problem.length > 0
    && typeof task.specification.baseline === 'string' && task.specification.baseline.length > 0
    && Array.isArray(task.specification.acceptance) && task.specification.acceptance.length > 0
    && task.specification.acceptance.every(value => typeof value === 'string' && value.length > 0));
  const original = task.specification.originalInference;
  closed(original, ['schemaVersion', 'classification', 'issuerId', 'keyId', 'factoryId', 'originId', 'completeOriginalSha256', 'planSha256', 'plan']);
  check(original.schemaVersion === 3 && equal(original.classification, record.classification)
    && original.issuerId === record.issuer.id && original.keyId === record.issuer.keyId
    && original.factoryId === record.authority.factoryId && original.originId === record.authority.originId
    && hex(original.completeOriginalSha256) && hex(original.planSha256)
    && originalReceiverV3Digest(task.specification) === task.specDigest);
  closed(record.call, ['requestId', 'nonce', 'slot', 'principalId', 'role', 'recipientId']);
  check(/^[a-f0-9]{32}$/.test(record.call.requestId) && /^[a-f0-9]{32}$/.test(record.call.nonce)
    && id(record.call.principalId) && ['developer', 'reviewer', 'planner'].includes(record.call.role)
    && id(record.call.recipientId));
  closed(record.call.slot, ['nodeId', 'ordinal']);
  check(id(record.call.slot.nodeId) && integer(record.call.slot.ordinal, 0, 1048576));
  closed(record.model, ['manifestDigest', 'revision', 'numBlocks', 'policyVersion']);
  check(/^sha256:[a-f0-9]{64}$/.test(record.model.manifestDigest) && /^[a-f0-9]{40}$/.test(record.model.revision)
    && integer(record.model.numBlocks, 1, 4096) && record.model.policyVersion === 1);
  closed(record.recipient, ['id', 'principalId', 'role', 'kind', 'origin', 'identitySha256', 'buildSha256', 'generationSha256', 'classification']);
  const recipient = record.recipient;
  check(recipient.id === record.call.recipientId && recipient.principalId === record.call.principalId
    && recipient.role === record.call.role && recipient.kind === 'communityai-coordinator'
    && [recipient.identitySha256, recipient.buildSha256, recipient.generationSha256].every(hex)
    && equal(recipient.classification, record.classification));
  const origin = new URL(recipient.origin);
  check(origin.origin === recipient.origin && !origin.username && !origin.password
    && (origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)));
  closed(record.sender, ['principalId', 'role']);
  check(id(record.sender.principalId) && record.sender.role === 'physical-owner');
  closed(record.credential, ['ownerId', 'credentialId', 'generationSha256']);
  check(record.credential.ownerId === record.sender.principalId && id(record.credential.credentialId)
    && hex(record.credential.generationSha256));
  closed(record.wire, ['method', 'url', 'headers', 'headersSha256', 'bodyUtf8', 'bodyByteLength', 'bodySha256']);
  check(record.wire.method === 'POST' && record.wire.url === new URL('/v1/chat/completions', recipient.origin).href);
  headerProjection(record.wire.headers, record.wire.headersSha256);
  const raw = utf8(record.wire.bodyUtf8, record.wire.bodyByteLength, record.wire.bodySha256);
  bodyProjection(JSON.parse(raw.toString('utf8')), record.model);
  closed(record.receiver, ['profile', 'normalizedBody']);
  const profile = record.receiver.profile;
  closed(profile, ['format', 'schemaVersion', 'recipientId', 'recipientOrigin', 'recipientIdentitySha256', 'recipientBuildSha256', 'recipientGenerationSha256', 'endpoint', 'ingressSchemaSha256', 'normalizerSha256', 'runtimeSha256', 'bodyPolicy', 'proxyPolicySha256']);
  check(profile.format === 'factory-communityai-receiver-profile' && profile.schemaVersion === 3
    && profile.recipientId === recipient.id && profile.recipientOrigin === recipient.origin
    && profile.recipientIdentitySha256 === recipient.identitySha256 && profile.recipientBuildSha256 === recipient.buildSha256
    && profile.recipientGenerationSha256 === recipient.generationSha256 && profile.endpoint === '/v1/chat/completions'
    && [profile.ingressSchemaSha256, profile.normalizerSha256, profile.runtimeSha256, profile.proxyPolicySha256].every(hex)
    && profile.bodyPolicy === 'strict-stream-usage-cache-key-v1');
  closed(record.receiver.normalizedBody, ['canonicalUtf8', 'byteLength', 'sha256']);
  const normalized = record.receiver.normalizedBody;
  utf8(normalized.canonicalUtf8, normalized.byteLength, normalized.sha256);
  bodyProjection(JSON.parse(normalized.canonicalUtf8), record.model);
  closed(record.plan, ['format', 'schemaVersion', 'slots']);
  check(record.plan.format === 'factory-original-call-plan' && record.plan.schemaVersion === 3
    && Array.isArray(record.plan.slots) && record.plan.slots.length > 0 && record.plan.slots.length <= 128);
  const seenRequests = new Set(), seenNonces = new Set(), seenSlots = new Set();
  for (const row of record.plan.slots) {
    closed(row, ['requestId', 'nonce', 'slot', 'bindingSha256', 'receiverProfileSha256', 'requiredOutcome']);
    closed(row.slot, ['nodeId', 'ordinal']);
    check(/^[a-f0-9]{32}$/.test(row.requestId) && /^[a-f0-9]{32}$/.test(row.nonce)
      && id(row.slot.nodeId) && integer(row.slot.ordinal, 0, 1048576)
      && hex(row.bindingSha256) && hex(row.receiverProfileSha256) && row.requiredOutcome === 'succeeded');
    const slot = canonical(row.slot);
    check(!seenRequests.has(row.requestId) && !seenNonces.has(row.nonce) && !seenSlots.has(slot));
    seenRequests.add(row.requestId); seenNonces.add(row.nonce); seenSlots.add(slot);
  }
  check(equal(record.plan, original.plan) && originalReceiverV3Digest(record.plan) === original.planSha256);
  const selected = record.plan.slots.filter(row => row.requestId === record.call.requestId);
  check(selected.length === 1 && selected[0].nonce === record.call.nonce && equal(selected[0].slot, record.call.slot)
    && selected[0].receiverProfileSha256 === originalReceiverV3Digest(profile)
    && selected[0].bindingSha256 === originalReceiverV3Digest({ call: record.call, model: record.model, recipient, sender: record.sender,
      credential: record.credential, wire: record.wire, receiver: record.receiver }));
  closed(record.lease, ['scope', 'scopeId', 'cellId', 'epoch', 'controlEpoch', 'expires', 'tokenSha256']);
  check(record.lease.scope === 'task' && record.lease.scopeId === task.id && id(record.lease.cellId)
    && integer(record.lease.epoch, 1) && integer(record.lease.controlEpoch, 1)
    && integer(record.lease.expires, 1) && hex(record.lease.tokenSha256));
  closed(record.parent, ['request', 'requestSha256', 'effectKey']);
  const request = nativeMissionRequest({ id: task.id, project_id: task.projectId, branch: task.branch,
    specification: task.specification, spec_digest: task.specDigest }, record.lease, record.parent.request?.outputFile);
  check(equal(record.parent.request, request) && record.parent.requestSha256 === originalReceiverV3Digest(request)
    && record.parent.effectKey === nativeMissionEffectKey(request));
  closed(record.reservation, ['reservationId', 'provider', 'ceilingCents']);
  check(record.reservation.reservationId === 'paid.' + record.parent.effectKey
    && record.reservation.provider === request.paid.provider && record.reservation.ceilingCents === request.paid.ceilingCents);
  return record;
}
function copyBytes(value, limit) {
  check(!types.isProxy(value) && types.isUint8Array(value));
  const length = byteLength.call(value), buffer = backing.call(value), offset = byteOffset.call(value);
  check(length > 0 && length <= limit && !types.isSharedArrayBuffer(buffer));
  return Buffer.from(new Uint8Array(buffer, offset, length));
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function synchronous(value) {
  if (types.isPromise(value)) { Promise.prototype.then.call(value, () => {}, () => {}); deny(); }
  return value;
}
function expectedObservation(record) {
  return { format: 'factory-original-receiver-held-projection', schemaVersion: 1,
    taskId: record.task.id, specDigest: record.task.specDigest, requestId: record.call.requestId, nonce: record.call.nonce,
    recipientId: record.recipient.id, authenticatedSenderPrincipalId: record.sender.principalId,
    credential: record.credential, method: record.wire.method, url: record.wire.url,
    headers: record.wire.headers, headersSha256: record.wire.headersSha256,
    bodyUtf8: record.wire.bodyUtf8, bodyByteLength: record.wire.bodyByteLength, bodySha256: record.wire.bodySha256,
    receiverProfile: record.receiver.profile, normalizedBody: record.receiver.normalizedBody, state: 'HELD_BEFORE_POST' };
}
export function createOriginalReceiverV3HeldContract(configuration) {
  closed(configuration, ['issuerId', 'keyId', 'verifyOriginal', 'observeHeldProjection']);
  check(id(configuration.issuerId) && id(configuration.keyId)
    && typeof configuration.verifyOriginal === 'function' && typeof configuration.observeHeldProjection === 'function');
  const configured = { ...configuration }, capabilities = new WeakMap();
  return Object.freeze({
    authenticate(envelopeInput, proofInput) {
      try {
        const envelope = copyBytes(envelopeInput, MAX_ENVELOPE), proof = copyBytes(proofInput, MAX_PROOF);
        const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(envelope);
        check(source.charCodeAt(0) !== 0xfeff);
        const record = JSON.parse(source);
        check(canonical(record) === source);
        validate(record, configured);
        const envelopeSha256 = sha(envelope);
        const verification = synchronous(configured.verifyOriginal(Object.freeze({ envelopeBytes: Buffer.from(envelope), proofBytes: Buffer.from(proof), envelopeSha256 })));
        closed(verification, ['format', 'schemaVersion', 'issuerId', 'keyId', 'envelopeSha256', 'principalId', 'requestId', 'nonce', 'specDigest', 'planSha256']);
        check(verification.format === 'factory-original-inference-authentication' && verification.schemaVersion === 3
          && verification.issuerId === configured.issuerId && verification.keyId === configured.keyId
          && verification.envelopeSha256 === envelopeSha256 && verification.principalId === record.call.principalId
          && verification.requestId === record.call.requestId && verification.nonce === record.call.nonce
          && verification.specDigest === record.task.specDigest && verification.planSha256 === record.task.specification.originalInference.planSha256);
        const capability = Object.freeze(Object.create(null));
        capabilities.set(capability, Object.freeze({ record: freeze(record), envelopeSha256 }));
        return capability;
      } catch { deny(); }
    },
    inspect(capability) {
      check(capability && !types.isProxy(capability) && capabilities.has(capability));
      const { record, envelopeSha256 } = capabilities.get(capability);
      return Object.freeze({ schemaVersion: 3, envelopeSha256, requestId: record.call.requestId,
        wireBodySha256: record.wire.bodySha256, wireBodyByteLength: record.wire.bodyByteLength,
        receiverProfileSha256: originalReceiverV3Digest(record.receiver.profile), runtimeAdmission: 'HOLD' });
    },
    compareHeld(capability) {
      check(capability && !types.isProxy(capability) && capabilities.has(capability));
      const { record, envelopeSha256 } = capabilities.get(capability);
      let actual;
      try {
        // The configured host receives a selector only. Its observation must come
        // from a separately authenticated sender/receiver path, not request input.
        actual = synchronous(configured.observeHeldProjection(Object.freeze({ taskId: record.task.id,
          specDigest: record.task.specDigest, requestId: record.call.requestId, nonce: record.call.nonce,
          recipientId: record.recipient.id })));
        check(equal(actual, expectedObservation(record)));
      } catch { deny(); }
      const comparison = freeze({ format: 'factory-original-model-step-receiver-comparison', schemaVersion: 2,
        taskId: record.task.id, specDigest: record.task.specDigest,
        requestId: record.call.requestId, nonce: record.call.nonce, slot: record.call.slot,
        recipientId: record.recipient.id, senderPrincipalId: record.sender.principalId,
        credentialOwnerId: record.credential.ownerId, credentialId: record.credential.credentialId,
        credentialGenerationSha256: record.credential.generationSha256,
        method: record.wire.method, url: record.wire.url, headersSha256: record.wire.headersSha256,
        wireBodySha256: record.wire.bodySha256, wireBodyByteLength: record.wire.bodyByteLength,
        normalizedBodySha256: record.receiver.normalizedBody.sha256,
        normalizedBodyByteLength: record.receiver.normalizedBody.byteLength,
        receiverProfileSha256: originalReceiverV3Digest(record.receiver.profile) });
      const comparisonSha256 = originalReceiverV3Digest(comparison);
      // A pure held witness for future schema5 design. It is never inserted in
      // schema3/4 and it cannot mint a physical attempt.
      const claimWitness = freeze({ format: 'factory-original-model-step-claim', schemaVersion: 2,
        effectKey: 'model.' + record.call.requestId,
        parent: { effectKey: record.parent.effectKey, requestSha256: record.parent.requestSha256 },
        task: { id: record.task.id, specDigest: record.task.specDigest,
          planSha256: record.task.specification.originalInference.planSha256 },
        call: record.call, lease: record.lease, reservation: record.reservation,
        envelopeSha256, receiverSha256: comparisonSha256,
        bindingSha256: record.plan.slots.find(row => row.requestId === record.call.requestId).bindingSha256,
        wireBodySha256: record.wire.bodySha256, wireBodyByteLength: record.wire.bodyByteLength,
        normalizedBodySha256: record.receiver.normalizedBody.sha256,
        normalizedBodyByteLength: record.receiver.normalizedBody.byteLength,
        receiverProfileSha256: originalReceiverV3Digest(record.receiver.profile),
        senderPrincipalId: record.sender.principalId,
        credentialGenerationSha256: record.credential.generationSha256,
        runtimeAdmission: 'HOLD', physicalAttempt: 'NONE' });
      const result = Object.freeze({ comparison, comparisonSha256, claimWitness,
        claimWitnessSha256: originalReceiverV3Digest(claimWitness), runtimeAdmission: 'HOLD' });
      heldResults.set(result, Object.freeze({ record, result }));
      return result;
    }
  });
}
