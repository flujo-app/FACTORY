import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalMissionPacket } from './native-mission-contract.mjs';
import { originalReceiverV3Digest, withOriginalReceiverV3HeldResult } from './original-receiver-v3-contract.mjs';

// Proposed cross-host evidence format. No sender, socket, durable CAS or
// production receiver receipt issuer is installed by this module.
const MAX_RECEIPT = 65536, MAX_PROOF = 4096;
const HEX = /^[a-f0-9]{64}$/;
const ROUTING = new Set(['http-referer', 'openai-organization', 'openai-project', 'x-title']);
const PROJECTED = new Set(['accept', 'content-type', 'user-agent', 'x-stainless-arch', 'x-stainless-lang',
  'x-stainless-os', 'x-stainless-package-version', 'x-stainless-retry-count', 'x-stainless-runtime',
  'x-stainless-runtime-version', ...ROUTING]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deny = () => { throw Object.assign(new Error('Original receiver post receipt denied.'), { code: 'ORIGINAL_RECEIVER_POST_RECEIPT_DENIED' }); };
const check = condition => { if (!condition) deny(); };
const hex = value => typeof value === 'string' && HEX.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function closed(value, keys) {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const fields = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(fields).length === keys.length && keys.every(key => Object.hasOwn(fields, key) && Object.hasOwn(fields[key], 'value')));
}
function copyBytes(value, limit) {
  check(value && !types.isProxy(value) && types.isUint8Array(value));
  const prototype = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(prototype, 'byteLength').get.call(value);
  const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer').get.call(value);
  const offset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset').get.call(value);
  check(length > 0 && length <= limit && !types.isSharedArrayBuffer(buffer));
  return Buffer.from(new Uint8Array(buffer, offset, length));
}
function synchronous(value) {
  if (types.isPromise(value)) { Promise.prototype.then.call(value, () => {}, () => {}); deny(); }
  return value;
}
function validateHeaders(headers) {
  check(Array.isArray(headers) && headers.length <= 14);
  let prior = '';
  for (const pair of headers) {
    check(Array.isArray(pair) && pair.length === 2 && PROJECTED.has(pair[0]) && pair[0] > prior
      && typeof pair[1] === 'string' && pair[1].length > 0 && pair[1].length <= 1024
      && /^[\x20-\x7e]+$/.test(pair[1]));
    prior = pair[0];
  }
}
function validateProxyPolicy(policy) {
  closed(policy, ['format', 'schemaVersion', 'generationSha256', 'senderUrl', 'receiverRoute',
    'methodTransform', 'bodyTransform', 'headerRemovals', 'headerAdditions', 'transportGenerationSha256']);
  check(policy.format === 'factory-original-receiver-proxy-policy' && policy.schemaVersion === 1
    && hex(policy.generationSha256) && hex(policy.transportGenerationSha256)
    && typeof policy.senderUrl === 'string' && /^https:\/\//.test(policy.senderUrl)
    && policy.receiverRoute === '/v1/chat/completions'
    && policy.methodTransform === 'preserve-post' && policy.bodyTransform === 'identity-utf8'
    && Array.isArray(policy.headerRemovals) && Array.isArray(policy.headerAdditions));
  let prior = '';
  for (const name of policy.headerRemovals) {
    check(typeof name === 'string' && PROJECTED.has(name) && !ROUTING.has(name) && name > prior);
    prior = name;
  }
  prior = '';
  for (const pair of policy.headerAdditions) {
    check(Array.isArray(pair) && pair.length === 2 && ROUTING.has(pair[0]) && pair[0] > prior
      && typeof pair[1] === 'string' && pair[1].length > 0 && pair[1].length <= 1024
      && /^[\x20-\x7e]+$/.test(pair[1]));
    prior = pair[0];
  }
}
function projectedHeaders(sender, policy) {
  const map = new Map(sender);
  for (const name of policy.headerRemovals) { check(map.delete(name)); }
  for (const [name, value] of policy.headerAdditions) { check(!map.has(name)); map.set(name, value); }
  return [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
function compareReceipt(record, held, receipt, policy) {
  closed(receipt, ['format', 'schemaVersion', 'held', 'attempt', 'proxyPolicySha256', 'receiver', 'state']);
  check(receipt.format === 'factory-original-receiver-post-receipt' && receipt.schemaVersion === 1
    && receipt.state === 'ASGI_OBSERVED_BEFORE_DISPATCH'
    && receipt.proxyPolicySha256 === originalReceiverV3Digest(policy)
    && receipt.proxyPolicySha256 === record.receiver.profile.proxyPolicySha256);
  closed(receipt.held, ['envelopeSha256', 'comparisonSha256', 'claimWitnessSha256']);
  check(receipt.held.envelopeSha256 === held.claimWitness.envelopeSha256
    && receipt.held.comparisonSha256 === held.comparisonSha256
    && receipt.held.claimWitnessSha256 === held.claimWitnessSha256);
  const attempt = receipt.attempt;
  closed(attempt, ['id', 'requestId', 'nonce', 'senderPrincipalId', 'credentialOwnerId', 'credentialId',
    'credentialGenerationSha256', 'channelBindingSha256', 'method', 'url', 'headersSha256', 'bodySha256', 'bodyByteLength']);
  check(/^[a-f0-9]{32}$/.test(attempt.id) && attempt.requestId === record.call.requestId
    && attempt.nonce === record.call.nonce && attempt.senderPrincipalId === record.sender.principalId
    && attempt.credentialOwnerId === record.credential.ownerId && attempt.credentialId === record.credential.credentialId
    && attempt.credentialGenerationSha256 === record.credential.generationSha256 && hex(attempt.channelBindingSha256)
    && attempt.method === record.wire.method && attempt.url === record.wire.url
    && attempt.headersSha256 === record.wire.headersSha256 && attempt.bodySha256 === record.wire.bodySha256
    && attempt.bodyByteLength === record.wire.bodyByteLength);
  check(policy.senderUrl === record.wire.url);
  closed(receipt.receiver, ['recipientId', 'identitySha256', 'buildSha256', 'generationSha256', 'profileSha256', 'transport', 'observation']);
  const receiver = receipt.receiver;
  check(receiver.recipientId === record.recipient.id && receiver.identitySha256 === record.recipient.identitySha256
    && receiver.buildSha256 === record.recipient.buildSha256 && receiver.generationSha256 === record.recipient.generationSha256
    && receiver.profileSha256 === originalReceiverV3Digest(record.receiver.profile));
  closed(receiver.transport, ['principalId', 'channelBindingSha256', 'generationSha256']);
  check(receiver.transport.principalId === attempt.senderPrincipalId
    && receiver.transport.channelBindingSha256 === attempt.channelBindingSha256
    && receiver.transport.generationSha256 === policy.transportGenerationSha256);
  const observed = receiver.observation;
  closed(observed, ['format', 'schemaVersion', 'method', 'route', 'headers', 'rawBodyByteLength',
    'rawBodySha256', 'normalizedBodySha256', 'observationSha256']);
  check(observed.format === 'communityai-factory-asgi-ingress-observation' && observed.schemaVersion === 2
    && observed.method === 'POST' && observed.route === policy.receiverRoute
    && integer(observed.rawBodyByteLength, 1, 32768) && observed.rawBodyByteLength === record.wire.bodyByteLength
    && observed.rawBodySha256 === record.wire.bodySha256
    && observed.normalizedBodySha256 === record.receiver.normalizedBody.sha256 && hex(observed.observationSha256));
  validateHeaders(observed.headers);
  check(canonicalMissionPacket(observed.headers) === canonicalMissionPacket(projectedHeaders(record.wire.headers, policy)));
  // This projection matches FactoryIngressObservationV2.digest(): Python's
  // sorted, compact, ensure_ascii=False JSON over these ASCII-only fields.
  const observationProjection = { format: observed.format, schemaVersion: observed.schemaVersion,
    method: observed.method, route: observed.route, headers: observed.headers,
    rawBodyBytes: observed.rawBodyByteLength, rawBodySha256: observed.rawBodySha256,
    normalizedBodySha256: observed.normalizedBodySha256 };
  check(observed.observationSha256 === originalReceiverV3Digest(observationProjection));
  return { attempt, receiver, observed };
}
export function createOriginalReceiverPostReceiptJoin(configuration) {
  closed(configuration, ['proxyPolicy', 'verifySenderAttempt', 'verifyReceiverReceipt']);
  validateProxyPolicy(configuration.proxyPolicy);
  check(typeof configuration.verifySenderAttempt === 'function' && typeof configuration.verifyReceiverReceipt === 'function');
  const proxyPolicy = structuredClone(configuration.proxyPolicy);
  const verifySenderAttempt = configuration.verifySenderAttempt;
  const verifyReceiverReceipt = configuration.verifyReceiverReceipt;
  return Object.freeze({
    join(heldResult, receiptInput, proofInput) {
      try {
        return withOriginalReceiverV3HeldResult(heldResult, ({ record, result: held }) => {
          const receiptBytes = copyBytes(receiptInput, MAX_RECEIPT), proofBytes = copyBytes(proofInput, MAX_PROOF);
          const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(receiptBytes);
          check(source.charCodeAt(0) !== 0xfeff);
          const receipt = JSON.parse(source);
          check(canonicalMissionPacket(receipt) === source);
          const { attempt, receiver, observed } = compareReceipt(record, held, receipt, proxyPolicy);
          const heldWitnessSha256 = held.claimWitnessSha256;
          const sender = synchronous(verifySenderAttempt(Object.freeze({ attempt: Object.freeze(structuredClone(attempt)), heldWitnessSha256 })));
          closed(sender, ['format', 'schemaVersion', 'attemptId', 'attemptSha256', 'heldWitnessSha256',
            'senderPrincipalId', 'credentialGenerationSha256', 'channelBindingSha256']);
          check(sender.format === 'factory-original-sender-attempt-authentication' && sender.schemaVersion === 1
            && sender.attemptId === attempt.id && sender.attemptSha256 === originalReceiverV3Digest(attempt)
            && sender.heldWitnessSha256 === heldWitnessSha256
            && sender.senderPrincipalId === attempt.senderPrincipalId
            && sender.credentialGenerationSha256 === attempt.credentialGenerationSha256
            && sender.channelBindingSha256 === attempt.channelBindingSha256);
          const receiptSha256 = sha(receiptBytes);
          const authenticated = synchronous(verifyReceiverReceipt(Object.freeze({ receiptBytes: Buffer.from(receiptBytes),
            proofBytes: Buffer.from(proofBytes), receiptSha256 })));
          closed(authenticated, ['format', 'schemaVersion', 'receiptSha256', 'attemptId', 'recipientId',
            'recipientIdentitySha256', 'recipientBuildSha256', 'recipientGenerationSha256', 'receiverProfileSha256',
            'transportPrincipalId', 'channelBindingSha256', 'transportGenerationSha256', 'proxyPolicySha256']);
          check(authenticated.format === 'factory-original-receiver-receipt-authentication' && authenticated.schemaVersion === 1
            && authenticated.receiptSha256 === receiptSha256 && authenticated.attemptId === attempt.id
            && authenticated.recipientId === receiver.recipientId
            && authenticated.recipientIdentitySha256 === receiver.identitySha256
            && authenticated.recipientBuildSha256 === receiver.buildSha256
            && authenticated.recipientGenerationSha256 === receiver.generationSha256
            && authenticated.receiverProfileSha256 === receiver.profileSha256
            && authenticated.transportPrincipalId === receiver.transport.principalId
            && authenticated.channelBindingSha256 === receiver.transport.channelBindingSha256
            && authenticated.transportGenerationSha256 === receiver.transport.generationSha256
            && authenticated.proxyPolicySha256 === receipt.proxyPolicySha256);
          return Object.freeze({ format: 'factory-original-receiver-post-join', schemaVersion: 1,
            heldComparisonSha256: held.comparisonSha256, heldClaimWitnessSha256: heldWitnessSha256,
            senderAttemptId: attempt.id, receiptSha256,
            receiverObservationSha256: observed.observationSha256,
            proxyPolicySha256: receipt.proxyPolicySha256,
            runtimeAdmission: 'HOLD', physicalSendAuthority: 'NONE', replayDisposition: 'UNRESOLVED' });
        });
      } catch { deny(); }
    }
  });
}
