import { createNativeWorkerReader } from './capacity-mcp.mjs';
import { digest } from './control.mjs';

const LIMIT = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONVERSATION = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;
class NativeMissionError extends Error {
  constructor(code) { super(code); this.name = 'NativeMissionError'; this.code = code; }
}
function requireValue(value, code = 'NATIVE_MISSION_INVALID') { if (!value) throw new NativeMissionError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function canonical(value, depth = 0, ancestors = new Set(), counter = { nodes: 0 }) {
  requireValue(depth <= 16 && ++counter.nodes <= 8192);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { requireValue(Number.isFinite(value)); return JSON.stringify(value); }
  requireValue((Array.isArray(value) || object(value)) && !ancestors.has(value));
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    requireValue(value.length <= 1024 && Object.keys(value).length === value.length);
    result = '[' + value.map(item => canonical(item, depth + 1, ancestors, counter)).join(',') + ']';
  } else {
    requireValue(Object.keys(value).length <= 128 && Object.getOwnPropertySymbols(value).length === 0);
    result = '{' + Object.keys(value).sort().map(key => {
      requireValue(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
      return JSON.stringify(key) + ':' + canonical(value[key], depth + 1, ancestors, counter);
    }).join(',') + '}';
  }
  ancestors.delete(value); return result;
}
/** Exact JSON text used for the one original user turn, never an execution command. */
export function canonicalMissionPacket(value) {
  try {
    requireValue(object(value)); const result = canonical(value);
    requireValue(Buffer.byteLength(result) <= LIMIT); return result;
  } catch { throw new NativeMissionError('NATIVE_MISSION_INVALID'); }
}
function mission(input) {
  requireValue(object(input) && Object.keys(input).sort().join(',') === 'conversationId,flowId,flowSha256,packet'
    && IDENTIFIER.test(input.flowId ?? '') && HASH.test(input.flowSha256 ?? '') && CONVERSATION.test(input.conversationId ?? ''));
  return { flowId: input.flowId, flowSha256: input.flowSha256, conversationId: input.conversationId,
    packet: canonicalMissionPacket(input.packet) };
}

/** Private one-shot execution client. A durable caller owns admission and unknown-outcome recovery. */
export function createNativeMissionClient(options = {}) {
  try { return nativeMissionClient(options); }
  catch { throw new NativeMissionError('NATIVE_MISSION_INVALID'); }
}
function nativeMissionClient({ origin, token, workspace, archiveSha256, compatibility,
  fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw new NativeMissionError('NATIVE_MISSION_INVALID'); }
  requireValue(base.origin === origin && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password
    && base.port !== '0' && (base.protocol === 'https:' || base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))
    && typeof token === 'string' && /^[A-Za-z0-9._~+/-]{32,256}={0,2}$/.test(token)
    && typeof workspace === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)
    && HASH.test(archiveSha256 ?? '') && object(compatibility) && typeof fetchImpl === 'function'
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 180000);
  const required = ['applicationVersion', 'snapshotFormatVersion', 'layoutVersion', 'workerProtocolVersion'];
  requireValue(required.every(key => Object.hasOwn(compatibility, key))
    && Object.keys(compatibility).every(key => required.includes(key) || key === 'revision')
    && typeof compatibility.applicationVersion === 'string' && compatibility.applicationVersion.length > 0
    && compatibility.applicationVersion.length <= 128 && !/[\r\n]/.test(compatibility.applicationVersion)
    && required.slice(1).every(key => Number.isSafeInteger(compatibility[key]) && compatibility[key] >= 1)
    && (!Object.hasOwn(compatibility, 'revision') || /^[a-f0-9]{40}$/.test(compatibility.revision)));
  const expected = Object.freeze(structuredClone(compatibility));
  const binding = Object.freeze({ workspace, archiveSha256, compatibility: expected });
  const attempted = new Set();
  function scoped(route) {
    const url = new URL(route, origin); url.searchParams.set('workspace', workspace); return url.href;
  }
  async function fetchBound(url, options = {}) {
    const requested = new URL(url); requireValue(requested.origin === origin);
    requested.searchParams.set('workspace', workspace);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const response = await fetchImpl(requested.href, { ...options, method: options.method ?? 'GET',
      headers: { ...options.headers, authorization: 'Bearer ' + token, 'x-flujo-workspace': workspace },
      redirect: 'error', signal });
    requireValue(response && !response.redirected && (!response.url || response.url === requested.href), 'NATIVE_MISSION_UNAVAILABLE');
    return response;
  }
  let native;
  try { native = createNativeWorkerReader({ origin, token, workspace, archiveSha256, compatibility: expected, fetchImpl: fetchBound }); }
  catch { throw new NativeMissionError('NATIVE_MISSION_INVALID'); }
  async function json(route, { method = 'GET', body, absent = false } = {}) {
    const response = await fetchBound(scoped(route), { method, ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body,
    }) });
    if (absent && response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    if (response.status !== 200 || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => {}); throw new NativeMissionError('NATIVE_MISSION_UNAVAILABLE');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > LIMIT)) {
      await response.body.cancel().catch(() => {}); throw new NativeMissionError('NATIVE_MISSION_UNAVAILABLE');
    }
    const reader = response.body.getReader(); const chunks = []; let count = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break;
        count += part.value.byteLength; requireValue(count <= LIMIT, 'NATIVE_MISSION_UNAVAILABLE'); chunks.push(part.value); }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      return { value: JSON.parse(text), text };
    } catch { await reader.cancel().catch(() => {}); throw new NativeMissionError('NATIVE_MISSION_UNAVAILABLE'); }
    finally { reader.releaseLock(); }
  }
  const conversationRoute = request => '/v1/chat/conversations/' + encodeURIComponent(request.conversationId);
  function completionBody(request, name) {
    const body = JSON.stringify({ model: 'flow-' + name, stream: false,
      messages: [{ role: 'user', content: request.packet }], metadata: { conversationId: request.conversationId, flujo: 'true' } });
    requireValue(Buffer.byteLength(body) <= LIMIT); return body;
  }
  async function preflight(request) {
    const proof = await native.read();
    const selected = (await json('/api/flow/' + encodeURIComponent(request.flowId))).value;
    requireValue(object(selected) && selected.id === request.flowId && digest(selected) === request.flowSha256
      && typeof selected.name === 'string' && selected.name.length > 0 && selected.name.length <= 256
      && !/[\r\n]/.test(selected.name) && !Object.hasOwn(selected, 'personaOwnership'), 'NATIVE_MISSION_CONFLICT');
    const inventory = (await json('/api/flow')).value;
    requireValue(Array.isArray(inventory) && inventory.length <= 1000
      && inventory.every(value => object(value) && typeof value.name === 'string' && typeof value.id === 'string'), 'NATIVE_MISSION_CONFLICT');
    const matching = inventory.filter(value => value.name === selected.name);
    requireValue(matching.length === 1 && matching[0].id === request.flowId && digest(matching[0]) === request.flowSha256
      && inventory.filter(value => value.id === request.flowId).length === 1, 'NATIVE_MISSION_CONFLICT');
    const body = completionBody(request, selected.name);
    requireValue(await json(conversationRoute(request), { absent: true }) === null, 'NATIVE_MISSION_CONFLICT');
    return { proof, body };
  }
  async function observeRequest(request) {
    await native.read();
    const response = await json(conversationRoute(request), { absent: true });
    if (response === null) return { state: 'absent', body: null };
    const value = response.value;
    const persona = ['personaId', 'personaTargetId', 'personaAttribution', 'personaInstructionContext', 'personaBehaviorSlotKey',
      'activityId', 'behaviorRevisionId', 'personaArchived', 'personaOwned'].some(key => object(value) && Object.hasOwn(value, key));
    const messages = object(value) && Array.isArray(value.messages) ? value.messages : [];
    const users = messages.filter(message => object(message) && message.role === 'user');
    const window = object(value) ? value.transcriptWindow : null;
    const intact = object(value) && value.id === request.conversationId && value.flowId === request.flowId && !persona
      && (value.parentConversationId === undefined || value.parentConversationId === null)
      && (value.rootConversationId === undefined || value.rootConversationId === null || value.rootConversationId === request.conversationId)
      && messages.length > 0 && messages.length <= 8192 && messages.every(object) && users.length === 1
      && messages[0] === users[0] && users[0].content === request.packet
      && object(window) && window.truncated === false && window.loadedCount === messages.length && window.totalCount === messages.length;
    return { state: intact ? value.status === 'completed' ? 'completed' : 'pending' : 'conflict', body: response.text };
  }
  return Object.freeze({ binding,
    async prepare(input) {
      try { return (await preflight(mission(input))).proof; }
      catch (error) { throw new NativeMissionError(error instanceof NativeMissionError ? error.code : 'NATIVE_MISSION_UNAVAILABLE'); }
    },
    async observe(input) {
      try { return await observeRequest(mission(input)); }
      catch (error) { throw new NativeMissionError(error instanceof NativeMissionError ? error.code : 'NATIVE_MISSION_UNAVAILABLE'); }
    },
    async dispatch(input, { admitPost } = {}) {
      let posted = false, admissionInvoked = false;
      try {
        const request = mission(input);
        requireValue(typeof admitPost === 'function' && admitPost.constructor?.name !== 'AsyncFunction', 'NATIVE_MISSION_ADMISSION');
        requireValue(!attempted.has(request.conversationId), 'NATIVE_MISSION_ALREADY_ATTEMPTED');
        const { body } = await preflight(request);
        requireValue(!attempted.has(request.conversationId), 'NATIVE_MISSION_ALREADY_ATTEMPTED');
        let admitting = true, pending;
        try {
          admissionInvoked = true;
          const admitted = admitPost(() => {
            requireValue(admitting && !posted, 'NATIVE_MISSION_ADMISSION');
            requireValue(!attempted.has(request.conversationId), 'NATIVE_MISSION_ALREADY_ATTEMPTED');
            attempted.add(request.conversationId); posted = true;
            pending = json('/v1/chat/completions', { method: 'POST', body });
            void pending.catch(() => {}); return pending;
          });
          if (admitted && typeof admitted.then === 'function') {
            void Promise.resolve(admitted).catch(() => {});
            requireValue(admitted === pending, 'NATIVE_MISSION_ADMISSION');
          }
        } finally { admitting = false; }
        requireValue(posted && pending, 'NATIVE_MISSION_ADMISSION');
        await pending;
        const result = await observeRequest(request);
        return result.state === 'absent' ? { state: 'pending', body: null } : result;
      } catch (error) {
        throw new NativeMissionError(posted ? 'NATIVE_MISSION_DISPATCH_UNKNOWN'
          : admissionInvoked ? 'NATIVE_MISSION_ADMISSION'
            : error instanceof NativeMissionError ? error.code : 'NATIVE_MISSION_UNAVAILABLE');
      }
    },
  });
}
