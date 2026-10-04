import { FactoryControl, digest } from './control.mjs';
import { SpendingLedger } from './spending.mjs';
import { validateWorkerPowerBinding, powerCheck as check } from './worker-power-contract.mjs';

/** Explicit existing-worker power client. Construction never contacts either service. */
export function createWorkerPowerController({ control, paidAdmission, binding: input,
  flyToken, workerToken, workerOrigin, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  check(control instanceof FactoryControl && paidAdmission instanceof SpendingLedger, 'WORKER_POWER_AUTHORITY');
  const binding = validateWorkerPowerBinding(input);
  let origin; try { origin = new URL(workerOrigin); } catch { check(false); }
  // A caller must establish the existing private Machine-specific proxy. No public Fly service is added.
  check(origin.origin === workerOrigin && origin.pathname === '/' && !origin.search && !origin.hash
    && !origin.username && !origin.password && origin.protocol === 'http:'
    && ['127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port !== '0'
    && typeof fetchImpl === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000);
  for (const token of [flyToken, workerToken]) check(typeof token === 'string'
    && token.length >= 32 && token.length <= 4096 && !/[\r\n]/.test(token));
  const machineUrl = 'https://api.machines.dev/v1/apps/' + encodeURIComponent(binding.app)
    + '/machines/' + encodeURIComponent(binding.machineId);
  async function json(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      check(response.ok && response.body && /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''), 'WORKER_POWER_HTTP');
      const chunks = []; let bytes = 0;
      for await (const part of response.body) { bytes += part.length; check(bytes <= 65536, 'WORKER_POWER_HTTP'); chunks.push(part); }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      // Fetch, decoding and JSON errors can quote untrusted bodies or credentials.
      // Return one content-free refusal without retaining the original cause.
      check(false, 'WORKER_POWER_HTTP');
    } finally {
      try { if (response?.body && !response.bodyUsed) await response.body.cancel(); } catch { /* No raw failure escapes. */ }
    }
  }
  function machine(value) {
    check(value?.id === binding.machineId && value.instance_id === binding.instanceId && value.name === binding.machineName
      && value.image_ref?.digest === binding.imageDigest && digest(value.config) === binding.configSha256
      && value.config?.metadata?.flujo_cloud_owner === binding.owner
      && value.config?.env?.FLUJO_WORKER_SNAPSHOT_SHA256 === binding.worker.archiveSha256
      && Array.isArray(value.config.services) && value.config.services.length === 0
      && !(value.config.containers ?? []).some(c => (c.services ?? []).length)
      && Array.isArray(value.config.mounts) && value.config.mounts.some(m => m.path === '/data' && typeof m.volume === 'string')
      && ['started', 'stopped'].includes(value.state), 'WORKER_POWER_IDENTITY');
    return { machineId: value.id, instanceId: value.instance_id, state: value.state,
      imageDigest: value.image_ref.digest, configSha256: digest(value.config) };
  }
  async function inspect() { return machine(await json(machineUrl, { headers: { authorization: 'Bearer ' + flyToken } })); }
  async function ready() {
    const get = route => { const url = new URL(route, workerOrigin); url.searchParams.set('workspace', binding.worker.workspace);
      return json(url.href, { headers: { authorization: 'Bearer ' + workerToken, 'x-flujo-workspace': binding.worker.workspace } }); };
    const status = await get('/api/worker/status'), info = await get('/api/snapshot/info');
    check(status.mode === 'worker' && status.state === 'ready' && status.workspace === binding.worker.workspace
      && status.archiveSha256 === binding.worker.archiveSha256
      && info.workspace === binding.worker.workspace && info.capability === 'available' && info.activeOperation === null
      && digest(info.workerCompatibility) === digest(binding.worker.compatibility), 'WORKER_POWER_READINESS');
    return { workspace: binding.worker.workspace, archiveSha256: binding.worker.archiveSha256,
      compatibility: binding.worker.compatibility };
  }
  function result(key, dispatched = false) { return { dispatched, effect: control.effect(key),
    scope: 'owned-worker-current-power-state', productionQualified: false, queuePowerScheduling: false }; }
  async function finish(key, action) {
    const observed = await inspect(); check(observed.state === (action === 'wake' ? 'started' : 'stopped'), 'WORKER_POWER_PENDING');
    const worker = action === 'wake' ? await ready() : null;
    // Repeat Machine identity after the authenticated worker reads too.
    check(digest(await inspect()) === digest(observed), 'WORKER_POWER_IDENTITY');
    control.settleWorkerPower(key, { bindingDigest: digest(binding), state: observed.state,
      observationSha256: digest({ observed, worker }), basis: 'observed-owned-target-state' });
  }
  async function execute(lease, { key, action, ceilingCents = null }) {
    check(['wake', 'sleep'].includes(action) && (action === 'sleep' ? ceilingCents === null
      : Number.isSafeInteger(ceilingCents) && ceilingCents > 0), 'WORKER_POWER_REQUEST');
    const request = { app: binding.app, bindingDigest: digest(binding), action,
      paid: action === 'wake' ? { provider: 'fly', ceilingCents } : null };
    const old = control.workerPowerEffect(key, request);
    if (old) return result(key); // Existing accepted/running/unknown intent is never mutated again.
    // Refuse OFF or free-zero before even creating a new wake intent/reservation.
    control.authority(lease);
    if (action === 'wake') {
      paidAdmission.assertAdmission(); const budget = paidAdmission.snapshot();
      check(budget.overCommittedCents === 0 && budget.unallocatedCents >= ceilingCents, 'WORKER_POWER_BUDGET');
      check(!paidAdmission.rows().some(row => row.id === 'power.' + key), 'WORKER_POWER_HISTORY');
    }
    const admission = control.admitWorkerPower(lease, { key, request });
    if (!admission.fresh) return result(key);
    let dispatched = false;
    try {
      const observed = await inspect();
      check(observed.state === (action === 'wake' ? 'stopped' : 'started'), 'WORKER_POWER_STATE');
      if (action === 'sleep') await ready();
      // Observe the pinned instance/config again immediately before durable dispatch admission.
      check(digest(await inspect()) === digest(observed), 'WORKER_POWER_IDENTITY');
      const reservationId = 'power.' + key;
      if (action === 'wake') {
        paidAdmission.reserveFresh({ reservationId, ...request.paid }); paidAdmission.start(reservationId);
      }
      let pending;
      const dispatch = () => {
        dispatched = true;
        pending = json(machineUrl + (action === 'wake' ? '/start' : '/stop'), {
          method: 'POST', headers: { authorization: 'Bearer ' + flyToken, 'content-type': 'application/json' },
          body: JSON.stringify(action === 'wake' ? {} : { signal: 'SIGTERM', timeout: '20' }) });
        // A local COMMIT can fail after the request has started. Retain its rejection handler
        // even when startWorkerPowerEffect throws before it returns this promise.
        void pending.catch(() => {});
        return pending;
      };
      if (action === 'wake') pending = control.startWorkerPowerEffect(lease, key, () => paidAdmission.transaction(() => {
        paidAdmission.assertAdmission(); const row = paidAdmission.row(reservationId), budget = paidAdmission.snapshot();
        check(row.state === 'started' && row.provider === 'fly' && row.ceiling_cents === ceilingCents
          && (row.charged_cents === null || row.charged_cents < row.ceiling_cents)
          && budget.overCommittedCents === 0, 'WORKER_POWER_BUDGET');
        return dispatch();
      }));
      else pending = control.startWorkerPowerEffect(lease, key, dispatch);
      await pending; await finish(key, action);
    } catch {
      const state = control.effect(key).state;
      if (!['succeeded', 'not_applied'].includes(state)) control.settleEffect(key,
        dispatched || state !== 'accepted' ? 'unknown' : 'not_applied', { reason: 'External outcome requires reconciliation.' });
    }
    return result(key, dispatched);
  }
  return Object.freeze({ binding: Object.freeze(structuredClone(binding)),
    capabilities: Object.freeze({ powerOnly: true, automaticRetry: false, automaticCleanup: false,
      queuePowerScheduling: false, providerTransportQualified: false, providerSideAtomicOwnershipFence: false }),
    async enroll(lease) {
      control.authority(lease); const observed = await inspect(); check(observed.state === 'started', 'WORKER_POWER_STATE');
      await ready(); check(digest(await inspect()) === digest(observed), 'WORKER_POWER_IDENTITY');
      return control.enrollWorkerPower(lease, binding);
    }, execute,
    async observe(key) {
      const request = control.workerPowerRequest(key); check(request.bindingDigest === digest(binding));
      const state = control.effect(key).state;
      if (['running', 'unknown'].includes(state)) { try { await finish(key, request.action); } catch { /* Unknown remains; no POST or negative inference. */ } }
      return result(key);
    },
  });
}
