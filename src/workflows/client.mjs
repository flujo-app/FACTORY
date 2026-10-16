import { sha256 } from './artifacts.mjs';

/** Public supervisor/agent client. Stable mutation IDs belong to the caller; uncertain writes are never silently replayed. */
export function createWorkflowClient({ url, token, operator = false, fetch: transport = globalThis.fetch }) {
  if (typeof token !== 'string' || !token || !/^https?:\/\//.test(url ?? '')) throw new TypeError('Authenticated board URL is required.');
  const request = async (route, body) => {
    let response;
    try { response = await transport(url.replace(/\/$/,'') + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch (cause) { throw Object.assign(new Error('Delivery unconfirmed. Reconcile the original operation identity before retrying.', { cause }), { code: 'OUTCOME_UNKNOWN' }); }
    let result;
    try { result = await response.json(); }
    catch (cause) { throw Object.assign(new Error('Response was incomplete; reconcile the original operation identity.', { cause }), { code: 'OUTCOME_UNKNOWN', status: response.status }); }
    if (!response.ok) throw Object.assign(new Error(result.error ?? `Board returned ${response.status}.`), { code: response.status === 401 ? 'AUTH' : response.status >= 500 || typeof result.error !== 'string' ? 'OUTCOME_UNKNOWN' : 'REJECTED', status: response.status });
    return result;
  };
  const call = (name, args) => request(operator ? '/operator/workflow' : '/tool', { name, arguments: args });
  const client = {
    call,
    tasks: () => call('factory_workflow', { action: 'list' }),
    task: taskId => call('factory_workflow', { action: 'get', taskId }),
    createTask: input => call('factory_workflow', { action: 'create', input }),
    assignTask: input => call('factory_assign',input),
    review: (candidateId,verdict) => call('factory_review',{candidateId,...verdict}),
    candidateFiles: (candidateId,options={}) => call('factory_candidate_files',{candidateId,...options}),
    events: options => call('factory_workflow_events', options),
    reviewPacket: candidateId => call('factory_workflow', { action: 'packet', candidateId }),
    pauseTask: (taskId, paused = true) => call('factory_workflow', { action: 'pause', taskId, paused }),
    command: (recipient, command) => { if (!operator) throw new Error('Operator credential required.'); return request('/operator/command', { ...command, recipient }); },
    recordVerification: (candidateId, gateId, result) => { if (!operator) throw new Error('Operator credential required.'); return request('/operator/workflow/verification', { candidateId, gateId, result }); },
    async upload(bytes) {
      bytes = Buffer.from(bytes); const refs = [];
      for (let offset = 0; offset < bytes.length || offset === 0; offset += 256 * 1024) refs.push((await call('factory_artifact', { action: 'put', data: bytes.subarray(offset, offset + 256 * 1024).toString('base64') })).ref);
      const artifact = refs.length === 1 ? { ref: refs[0], size: bytes.length } : await call('factory_artifact', { action: 'compose', refs });
      if (artifact.ref !== 'sha256:' + sha256(bytes)) throw new Error('Uploaded artifact digest mismatch.'); return artifact;
    },
    async download(ref) {
      let offset = 0, size; const chunks = [];
      for (;;) {
        const chunk = await call('factory_artifact', { action: 'read', ref, offset, length: 256 * 1024 });
        if (chunk.ref !== ref || chunk.offset !== offset || !Number.isSafeInteger(chunk.size) || chunk.size < 0 || size !== undefined && size !== chunk.size) throw new Error('Artifact chunk identity mismatch.');
        size = chunk.size; const bytes = Buffer.from(chunk.data, 'base64'); chunks.push(bytes); offset += bytes.length;
        if (offset > size || !bytes.length && !chunk.done || chunk.done && offset !== size) throw new Error('Incomplete artifact transfer.');
        if (chunk.done) break;
      }
      const bytes = Buffer.concat(chunks); if ('sha256:' + sha256(bytes) !== ref) throw new Error('Downloaded artifact digest mismatch.'); return bytes;
    },
    async *subscribe({ after = 0, signal, intervalMs = 1000, ...filter } = {}) {
      while (!signal?.aborted) {
        const page = await client.events({ ...filter, after }); after = page.cursor; yield page;
        if (!page.hasMore) await new Promise(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, intervalMs); signal?.addEventListener('abort', done, { once: true }); });
      }
    },
  };
  return client;
}

export function classifyWorkflowRecovery(agent) {
  const native = agent.nativeRuntime;
  if (!native) return { state: 'unobserved', action: 'reconcile_session', replaySafe: false };
  if (native.operatorStopReceipt) return { state: 'interrupted', action: 'await_explicit_resume', replaySafe: false };
  if (native.turnStatus === 'failed' || ['systemError','notFound'].includes(native.threadStatus)) return { state: 'failed', action: 'inspect_native_failure_and_reconcile', replaySafe: false, threadId: native.threadId };
  if (native.turnStatus === 'inProgress' || native.threadStatus === 'active') return { state: 'active', action: 'observe', replaySafe: false };
  return { state: 'idle', action: 'dispatch_pending_assignment', replaySafe: true, threadId: native.threadId };
}
