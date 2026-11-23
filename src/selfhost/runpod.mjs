// A self-hosted model on RunPod GPU pods (vLLM), owned and journaled by FACTORY. The server
// settings are the bundled profiles' own: selfhost/modal/settings.py builds the vLLM command with
// the caller's Python, exactly as for Modal. Each replica is one pod running the official vLLM
// image; selfhost/runpod/boot.py starts vLLM in it and stops the pod when it is idle. Only
// RunPod's REST API is called, with the caller's account key; that key never enters a pod.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModelProvider } from '../model-provider.mjs';
import { SELFHOST_MODAL_DIR, SELFHOSTED_KEY_ENV, fileCredentialStore, lastJsonLine, notApplied, pause, probeSelfHostedModel,
  readBoundedJson, runCommand, uncertain } from './modal.mjs';

export const SELFHOST_RUNPOD_DIR = fileURLToPath(new URL('../../selfhost/runpod/', import.meta.url));
export const RUNPOD_API = 'https://api.runpod.io/v2';
export const RUNPOD_KEY_ENV = 'RUNPOD_API_KEY';
const OWNED_NAME = /^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[a-f0-9]{12}$/;
const POD_ID = /^[a-z0-9]{6,40}$/;
const OFFICIAL_IMAGE = /^(docker\.io\/)?vllm\/vllm-openai@sha256:[a-f0-9]{64}$/;
// The profile pins the publisher's weights; Modal's volumes and request limit mean nothing on a pod.
const REFUSED_OVERRIDES = { model: 'the profile pins the weights', revision: 'the profile pins the weights',
  weights_volume: 'a Modal setting', compile_volume: 'a Modal setting', request_timeout_minutes: 'a Modal setting' };
const CLOUDS = ['SECURE', 'COMMUNITY'];
const MOUNT = '/workspace';
const LOADER = 'import base64,os;exec(compile(base64.b64decode(os.environ["FACTORY_SELFHOST_BOOT_B64"]),"factory-boot","exec"))';
const LIVE = new Set(['PROVISIONING', 'STARTING', 'RUNNING']);
const GONE = new Set(['EXITED', 'TERMINATED']);
const MAX_BODY = 100_000;
const MINUTE = 60_000;

const fingerprint = key => createHash('sha256').update(key).digest('hex').slice(0, 16);
const podName = (appName, index) => `${appName}-r${index + 1}`;
const podOrigin = (id, port) => `https://${id}-${port}.proxy.runpod.net`;
const short = value => String(value ?? '').replace(/[^\w .,:;()/'-]/g, ' ').slice(0, 200).trim();
const base64 = value => Buffer.from(value).toString('base64');

/** RunPod GPU types FACTORY can start, with list prices (selfhost/runpod/gpus.json). */
export function runpodGpus() {
  return JSON.parse(readFileSync(join(SELFHOST_RUNPOD_DIR, 'gpus.json'), 'utf8'));
}

/** An owned pod's address: RunPod's HTTPS proxy for one pod and port, origin only. */
export function runpodEndpointOrigin(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && /^[a-z0-9]{6,40}-\d{2,5}\.proxy\.runpod\.net$/.test(url.hostname)
      && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

/**
 * The create-pod request for one replica. The endpoint key is its only secret; the pod gets the
 * official vLLM image, a disk for the weights at /workspace, one HTTPS port and the boot script.
 */
export function runpodPodRequest({ name, gpuId, gpuCount = 1, image, launch, key, cloud = 'SECURE', diskGb = 60, volumeGb, networkVolumeId, dataCenterIds }) {
  return {
    name, image, cloud, gpu: { id: gpuId, count: gpuCount }, disk: diskGb,
    mounts: networkVolumeId ? { network: [{ volumeId: networkVolumeId, path: MOUNT }] } : { persistent: { size: volumeGb, path: MOUNT } },
    ports: [`${launch.port}/http`],
    env: {
      VLLM_API_KEY: key, HF_HOME: `${MOUNT}/huggingface`, VLLM_CACHE_ROOT: `${MOUNT}/vllm`, TRITON_CACHE_DIR: `${MOUNT}/vllm/triton`,
      HF_XET_HIGH_PERFORMANCE: '1', VLLM_ALLOW_LONG_MAX_MODEL_LEN: '1',
      FACTORY_SELFHOST_PLAN_B64: base64(JSON.stringify(launch)),
      FACTORY_SELFHOST_DISCOVERY_B64: base64(readFileSync(join(SELFHOST_MODAL_DIR, 'discovery.py'))),
      FACTORY_SELFHOST_BOOT_B64: base64(readFileSync(join(SELFHOST_RUNPOD_DIR, 'boot.py'))),
    },
    entrypoint: ['python3', '-c', LOADER],
    ...(dataCenterIds?.length ? { dataCenterIds: [...dataCenterIds] } : {}),
  };
}

/**
 * One owned self-hosted model on RunPod: one GPU pod per replica. Phases as on Modal: prepared →
 * deploying → unverified → ready, stopped (GPU off, disks kept), retired (pods deleted and
 * checked), unknown (an uncertain remote outcome; retire to reconcile). An idle pod stops
 * itself; `refresh` notices it, and `deploy` starts it again. Uncertain operations are never replayed.
 */
export class RunPodSelfHostedModel {
  constructor({ directory, apiKey, python = process.platform === 'win32' ? 'python' : 'python3', pythonArgs = [], env = process.env,
    commandRunner = runCommand, fetchImpl = fetch, credentialStore, keyName = 'selfhosted-model', namePrefix = 'factory', clock = Date.now,
    pollMs = 10_000, stopWaitMs = 3 * MINUTE, gpuRetryMs = MINUTE, rateLimitWaitMs = MINUTE, requestTimeoutMs = MINUTE, deleteAttempts = 5 } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Select a private state directory.');
    if (!/^[a-z][a-z0-9]{1,15}$/.test(namePrefix)) throw new TypeError('namePrefix must be a short lowercase name.');
    Object.assign(this, { directory, python, pythonArgs: [...pythonArgs], commandRunner, fetch: fetchImpl, keyName, namePrefix, clock,
      pollMs, stopWaitMs, gpuRetryMs, rateLimitWaitMs, requestTimeoutMs, deleteAttempts });
    this.environment = typeof env === 'function' ? env : () => env;
    this.apiKey = typeof apiKey === 'function' ? apiKey : () => apiKey ?? this.environment()[RUNPOD_KEY_ENV];
    this.store = credentialStore ?? fileCredentialStore(directory);
    this.path = join(directory, 'model.json');
    this.busy = false;
    this.record = null;
    if (existsSync(this.path)) {
      let record = null;
      try { record = JSON.parse(readFileSync(this.path, 'utf8')); } catch { /* unreadable: unknown */ }
      this.record = record?.version === 1 && record.cloud === 'runpod' && OWNED_NAME.test(record.appName ?? '') ? record : { version: 1, cloud: 'runpod', phase: 'unknown' };
    }
  }

  #save(record) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const next = { ...record, updatedAt: new Date(this.clock()).toISOString() };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.record = next;
    return next;
  }

  #accountKey() {
    const key = this.apiKey();
    if (typeof key !== 'string' || key.length < 16) throw notApplied(`Set ${RUNPOD_KEY_ENV} to a RunPod API key.`);
    return key;
  }

  // The caller's Python builds the settings; it gets neither FACTORY's launch variables nor the RunPod key.
  #pythonEnv() {
    const env = { ...this.environment() };
    for (const name of Object.keys(env)) if (/^FACTORY_SELFHOST_/i.test(name) || name === RUNPOD_KEY_ENV) delete env[name];
    return env;
  }

  async #describe(request, signal) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const result = await this.commandRunner(this.python, [...this.pythonArgs, '-B', join(SELFHOST_MODAL_DIR, 'deploy.py')],
      { signal, timeoutMs: MINUTE, input: JSON.stringify({ ...request, action: 'describe' }), maxBytes: 1_000_000, env: this.#pythonEnv(), killTree: true, cwd: this.directory });
    const answer = lastJsonLine(result?.stdout);
    if (result?.code !== 0 || !answer || answer.error || !answer.settings) throw notApplied(answer?.error ?? 'The model settings could not be read.');
    return answer;
  }

  /** One RunPod REST call: { status, data }. A lost answer is uncertain; rate limits are waited out. */
  async #api(method, path, { body, signal } = {}) {
    const key = this.#accountKey();
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) throw uncertain();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, this.requestTimeoutMs);
      let response;
      try {
        response = await this.fetch(`${RUNPOD_API}${path}`, { method, redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        if (response.status === 429 && attempt < 6) {
          response.body?.cancel?.().catch(() => {});
          const seconds = Number(response.headers?.get?.('retry-after'));
          await pause(Math.min(this.rateLimitWaitMs, (seconds > 0 ? seconds : 5) * 1000), signal);
          continue;
        }
        const data = response.body ? await readBoundedJson(response, 4_000_000, controller) : null;
        return { status: response.status, data };
      } catch (error) { throw error?.outcome ? error : uncertain(); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
  }

  async #pod(id, signal) {
    const { status, data } = await this.#api('GET', `/pods/${id}`, { signal });
    if (status === 404) return { status: 'TERMINATED' };
    if (status !== 200 || typeof data?.status !== 'string') throw uncertain();
    return data;
  }

  // Every pod of the account whose name marks it as this model's (RunPod has no name filter).
  async #ownedByName(signal) {
    const owned = new RegExp(`^${this.record.appName}-r[1-4]$`);
    const found = [];
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const { status, data } = await this.#api('GET', `/pods?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
      if (status !== 200 || !Array.isArray(data?.pods)) throw uncertain();
      for (const pod of data.pods) if (owned.test(pod?.name ?? '') && POD_ID.test(pod?.id ?? '') && pod.status !== 'TERMINATED') found.push(pod);
      if (!data.pagination?.hasNextPage) return found;
      cursor = String(data.pagination.nextCursor ?? '');
      if (!cursor) throw uncertain();
    }
    throw uncertain();
  }

  // The GPU types to try, in order, with RunPod's id and price; the live catalogue wins over the table.
  async #gpuChoices(names, cloud, signal) {
    const table = runpodGpus().gpus;
    let catalogue = null;
    try {
      const { status, data } = await this.#api('GET', '/catalog/gpus', { signal });
      const items = Array.isArray(data) ? data : data?.gpus;
      if (status === 200 && Array.isArray(items)) catalogue = items;
    } catch { catalogue = null; }
    return names.map(name => {
      const known = table[name];
      const live = catalogue?.find(item => item?.id === known.id) ?? catalogue?.find(item => item?.name === name);
      const price = Number(live?.price?.[cloud.toLowerCase()]);
      return { gpu: name, id: typeof live?.id === 'string' && live.id ? live.id : known.id,
        usdPerHour: price > 0 ? price : known.usdPerHour[cloud], priceSource: price > 0 ? 'catalogue' : 'table' };
    });
  }

  /** Safe state: no key, URL, pod id or account. */
  status() {
    const r = this.record, s = r?.settings;
    const phase = r?.phase ?? 'off';
    return { phase, ready: phase === 'ready' && !this.busy, busy: this.busy, cloud: 'runpod', profile: r?.profile ?? null, label: s?.label ?? null,
      model: s?.model ?? null, gpu: s?.gpu ?? null, replicas: s?.replicas ?? null, endpoints: r?.endpoints?.length ?? 0, contextWindow: s?.contextWindow ?? null,
      usdPerHourPerReplica: s?.usdPerHourPerReplica ?? null, scaledownMinutes: s?.scaledownMinutes ?? null,
      verified: Boolean(r?.verification && phase === 'ready'), cleanupVerified: r?.cleanupVerified === true,
      stoppedBy: phase === 'stopped' ? r?.stoppedBy ?? null : null, updatedAt: r?.updatedAt ?? null };
  }

  /**
   * Start the model: new pods (or the stopped ones again) and, by default, verify that each serves
   * the expected model. GPUs are tried in order: `gpus`, else the profile's GPU and its
   * `gpu_fallbacks`. With `waitForGpuMinutes`, a moment with no free GPU is waited out.
   */
  async deploy({ profile = 'nemotron', overrides = {}, gpus, waitForGpuMinutes = 0, cloud = 'SECURE', volumeGb, diskGb = 60, networkVolumeId, dataCenterIds,
    signal, verify = true } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (signal?.aborted) throw notApplied('Deployment was cancelled before it started.');
    if (!/^[a-z][a-z0-9]{1,15}$/.test(profile) || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw notApplied('Select a profile and an overrides object.');
    const refused = Object.keys(overrides).filter(name => REFUSED_OVERRIDES[name]);
    if (refused.length) throw notApplied(`On RunPod these settings cannot be changed: ${refused.map(name => `${name} (${REFUSED_OVERRIDES[name]})`).join(', ')}.`);
    if (gpus !== undefined && (!Array.isArray(gpus) || !gpus.length || gpus.length > 6 || !gpus.every(name => typeof name === 'string' && /^[A-Z][A-Z0-9-]{1,15}$/.test(name)))) throw notApplied('gpus must list GPU names such as B300.');
    if (!Number.isSafeInteger(waitForGpuMinutes) || waitForGpuMinutes < 0 || waitForGpuMinutes > 24 * 60) throw notApplied('waitForGpuMinutes must be 0 to 1440.');
    if (!CLOUDS.includes(cloud)) throw notApplied(`cloud must be ${CLOUDS.join(' or ')}.`);
    if (volumeGb !== undefined && (!Number.isSafeInteger(volumeGb) || volumeGb < 20 || volumeGb > 4000)) throw notApplied('volumeGb must be 20 to 4000.');
    if (!Number.isSafeInteger(diskGb) || diskGb < 20 || diskGb > 1000) throw notApplied('diskGb must be 20 to 1000.');
    if (networkVolumeId !== undefined && !POD_ID.test(networkVolumeId)) throw notApplied('networkVolumeId must be a RunPod volume id.');
    if (dataCenterIds !== undefined && (!Array.isArray(dataCenterIds) || dataCenterIds.length > 20 || !dataCenterIds.every(id => typeof id === 'string' && /^[A-Z0-9-]{3,24}$/.test(id)))) throw notApplied('dataCenterIds must list RunPod data centre ids such as EU-RO-1.');
    this.busy = true;
    try {
      this.#accountKey();
      if (this.record?.phase === 'ready') await this.#refresh(signal);
      let record = this.record;
      const redeploy = record?.phase === 'stopped';
      if (record && !['retired', 'stopped'].includes(record.phase)) {
        throw notApplied(record.phase === 'unknown' ? 'The owned model has an uncertain outcome; retire it to reconcile first.' : `The owned model is ${record.phase}.`);
      }
      if (redeploy && (record.profile !== profile || JSON.stringify(record.overrides ?? {}) !== JSON.stringify(overrides))) {
        throw notApplied('A stopped model keeps its profile and settings; retire it to change them.');
      }
      if (redeploy) await this.#confirmAccount(signal);
      else await this.#prepare({ profile, overrides, gpus, waitForGpuMinutes, cloud, volumeGb, diskGb, networkVolumeId, dataCenterIds, signal });
      record = this.#save({ ...this.record, phase: 'deploying', verification: undefined, stoppedBy: undefined });
      try {
        const key = await this.store.get(this.keyName);
        if (typeof key !== 'string' || key.length < 32) throw uncertain();
        for (let index = 0; index < record.settings.replicas; index++) await this.#place(index, key, signal);
        for (const pod of this.record.pods) await this.#waitRunning(pod.id, signal);
        const endpoints = this.record.pods.map(pod => podOrigin(pod.id, this.record.launch.port));
        if (endpoints.some(origin => !runpodEndpointOrigin(origin))) throw uncertain();
        const used = [...new Set(this.record.pods.map(pod => pod.gpu))];
        const price = Math.max(...this.record.pods.map(pod => this.record.gpus.find(choice => choice.gpu === pod.gpu)?.usdPerHour ?? 0));
        this.#save({ ...this.record, phase: 'unverified', endpoints, deployedAt: new Date(this.clock()).toISOString(),
          settings: { ...this.record.settings, gpu: used.join(', '), usdPerHourPerReplica: Math.round(price * this.record.settings.gpuCount * 100) / 100 } });
      } catch (error) {
        if (error?.outcome === 'not_applied') await this.#undoPlacement(redeploy, signal);
        else this.#save({ ...this.record, phase: 'unknown' });
        throw error?.outcome ? error : uncertain();
      }
      if (verify) await this.#verify(signal);
      return this.status();
    } finally { this.busy = false; }
  }

  async #prepare({ profile, overrides, gpus, waitForGpuMinutes, cloud, volumeGb, diskGb, networkVolumeId, dataCenterIds, signal }) {
    const appName = `${this.namePrefix}-${profile}-${randomBytes(6).toString('hex')}`;
    this.#save({ version: 1, cloud: 'runpod', attemptId: randomUUID(), appName, profile, overrides, phase: 'prepared', createdAt: new Date(this.clock()).toISOString() });
    try {
      const listed = JSON.parse(readFileSync(join(SELFHOST_MODAL_DIR, 'profiles', `${profile}.json`), 'utf8'));
      const names = [...new Set(gpus ?? (overrides.gpu ? [overrides.gpu] : [listed.gpu, ...(listed.gpu_fallbacks ?? [])]))];
      const table = runpodGpus().gpus;
      const unknown = names.filter(name => !table[name]);
      if (unknown.length) throw notApplied(`RunPod GPUs here are ${Object.keys(table).join(', ')}; ${unknown.map(short).join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not among them.`);
      const described = [];
      for (const gpu of names) described.push({ gpu, ...await this.#describe({ appName, profile, overrides: { ...overrides, gpu } }, signal) });
      const fitting = described.filter(item => item.settings.estimateGib?.fits === true);
      if (!fitting.length) throw notApplied('The model does not fit any of the selected GPUs.');
      const s = fitting[0].settings;
      if (!OFFICIAL_IMAGE.test(s.image ?? '')) throw notApplied('RunPod runs the official vLLM image pinned by digest (vllm/vllm-openai@sha256:...); set it with the image override.');
      if (s.source !== listed.model || s.revision !== listed.revision || fitting.some(item => JSON.stringify(item.settings.vllmCommand) !== JSON.stringify(s.vllmCommand))) {
        throw notApplied('The model settings could not be confirmed.');
      }
      const account = fingerprint(this.#accountKey());
      const choices = await this.#gpuChoices(fitting.map(item => item.gpu), cloud, signal);
      const launch = { version: 1, argv: s.vllmCommand, env: s.env ?? {}, inputModalities: s.inputModalities, port: s.port,
        idleMinutes: s.scaledownMinutes, startupMinutes: s.startupTimeoutMinutes };
      await this.store.set(this.keyName, randomBytes(48).toString('base64url'));
      this.#save({ ...this.record, account, hints: fitting[0].hints ?? {}, gpus: choices, launch, image: s.image, pods: [],
        options: { cloud, diskGb, volumeGb: networkVolumeId ? null : volumeGb ?? Math.ceil((s.weightsGib + 40) / 10) * 10,
          networkVolumeId: networkVolumeId ?? null, dataCenterIds: dataCenterIds ?? null, waitForGpuMinutes },
        settings: { label: s.label, model: s.model, gpu: choices[0].gpu, gpuCount: s.gpuCount, replicas: s.replicas, contextWindow: s.contextWindow,
          usdPerHourPerReplica: Math.round(choices[0].usdPerHour * s.gpuCount * 100) / 100, scaledownMinutes: s.scaledownMinutes,
          startupTimeoutMinutes: s.startupTimeoutMinutes, variant: s.variant ?? null } });
      if (signal?.aborted) throw notApplied('Deployment was cancelled before remote work started.');
    } catch (error) {
      // Nothing remote exists yet: retire the local preparation.
      await this.store.delete(this.keyName)?.catch?.(() => {});
      this.#save({ ...this.record, phase: 'retired', cleanupVerified: true });
      throw error?.outcome === 'not_applied' ? error : notApplied('The self-hosted model could not be prepared.');
    }
  }

  #setPod(index, pod) {
    const pods = [...(this.record.pods ?? [])];
    pods[index] = pod;
    return this.#save({ ...this.record, pods });
  }

  // Replica `index` gets a running pod: its stopped pod started again, else a new one.
  async #place(index, key, signal) {
    const existing = this.record.pods?.[index];
    if (existing?.id) {
      const pod = await this.#pod(existing.id, signal);
      if (LIVE.has(pod.status)) return;
      if (pod.status === 'EXITED' || pod.status === 'ERROR') {
        const started = await this.#api('POST', `/pods/${existing.id}/action`, { body: { action: 'start' }, signal });
        if (started.status === 200) return;
        // Its machine's GPU went to someone else meanwhile: a new pod replaces it (the weights download again).
        await this.#deletePod(existing.id, signal);
      }
      this.#setPod(index, null);
    }
    const { options, gpus, launch, settings, appName } = this.record;
    const name = podName(appName, index);
    const deadline = this.clock() + options.waitForGpuMinutes * MINUTE;
    for (;;) {
      const busy = [];
      for (const choice of gpus) {
        const body = runpodPodRequest({ name, gpuId: choice.id, gpuCount: settings.gpuCount, image: this.record.image, launch, key, cloud: options.cloud,
          diskGb: options.diskGb, volumeGb: options.volumeGb, networkVolumeId: options.networkVolumeId ?? undefined, dataCenterIds: options.dataCenterIds ?? undefined });
        if (JSON.stringify(body).length > MAX_BODY) throw notApplied('The pod request is too large for RunPod.');
        // Journaled first: if the answer is lost, retire finds the pod by its name.
        this.#setPod(index, { name, id: null, gpu: choice.gpu, creating: true });
        const created = await this.#api('POST', '/pods', { body, signal });
        if (created.status === 201 && POD_ID.test(created.data?.id ?? '')) { this.#setPod(index, { name, id: created.data.id, gpu: choice.gpu }); return; }
        if (![400, 401, 402, 403, 422].includes(created.status)) throw uncertain();
        // Refused: no pod was created.
        this.#setPod(index, null);
        if (created.status === 402) throw notApplied('The RunPod balance is too low to start the pod.');
        if (created.status === 401 || created.status === 403) throw notApplied('RunPod refused the API key.');
        if (created.status === 422) throw notApplied(`RunPod refused the pod settings: ${short(created.data?.detail ?? created.data?.message) || 'no reason given'}.`);
        busy.push(choice.gpu);
      }
      if (this.clock() >= deadline) throw notApplied(`No ${busy.join(', ')} GPU is free on RunPod right now. Try again later, or wait for one with waitForGpuMinutes.`);
      await pause(Math.min(this.gpuRetryMs, Math.max(1, deadline - this.clock())), signal);
    }
  }

  async #waitRunning(id, signal) {
    const deadline = this.clock() + (this.record.launch.startupMinutes + 5) * MINUTE;
    for (;;) {
      const pod = await this.#pod(id, signal);
      if (pod.status === 'RUNNING') return;
      if (!LIVE.has(pod.status) || this.clock() >= deadline) throw uncertain();
      await pause(this.pollMs, signal);
    }
  }

  // A deployment that cannot be placed leaves nothing running: new pods are deleted, started ones stopped.
  async #undoPlacement(redeploy, signal) {
    try {
      if (redeploy) {
        await this.#stopPods(signal);
        this.#save({ ...this.record, phase: 'stopped', pods: (this.record.pods ?? []).map(pod => pod?.id ? pod : null) });
      } else {
        for (const pod of this.record.pods ?? []) if (pod?.id) await this.#deletePod(pod.id, signal);
        if ((await this.#ownedByName(signal)).length) throw uncertain();
        await this.store.delete(this.keyName);
        this.#save({ ...this.record, phase: 'retired', pods: [], cleanupVerified: true, retiredAt: new Date(this.clock()).toISOString() });
      }
    } catch { this.#save({ ...this.record, phase: 'unknown' }); throw uncertain(); }
  }

  // Wait until the server answers, then prove it serves the model (catalogue and one exact challenge).
  async #verify(signal) {
    const record = this.record;
    try {
      const key = await this.store.get(this.keyName);
      const timeoutMs = (record.launch.startupMinutes + 5) * MINUTE;
      let verification;
      for (const [index, endpoint] of record.endpoints.entries()) {
        await this.#waitServing(endpoint, record.pods[index].id, key, signal, this.clock() + timeoutMs);
        verification = await probeSelfHostedModel({ fetchImpl: this.fetch, endpoint, key, model: record.settings.model,
          challenge: `FACTORY-${randomBytes(4).toString('hex').toUpperCase()}`, signal, timeoutMs: 10 * MINUTE });
      }
      this.#save({ ...this.record, phase: 'ready', verification: { ...verification, version: 1 } });
    } catch { this.#save({ ...this.record, phase: 'unknown' }); throw uncertain(); }
  }

  // RunPod's proxy answers 502 until vLLM listens; vLLM's catalogue answers once the weights are loaded.
  async #waitServing(endpoint, podId, key, signal, deadline) {
    for (;;) {
      let status = 0;
      try {
        const response = await this.fetch(`${endpoint}/v1/models`, { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal });
        status = response.status;
        response.body?.cancel?.().catch(() => {});
      } catch { if (signal?.aborted) throw uncertain(); }
      if (status === 200) return;
      if (status === 401 || status === 403 || this.clock() >= deadline) throw uncertain();
      // A pod whose vLLM never came up stops itself; do not wait for it.
      if (!LIVE.has((await this.#pod(podId, signal)).status)) throw uncertain();
      await pause(this.pollMs, signal);
    }
  }

  /** Re-check an unverified deployment. */
  async verify({ signal } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (!['unverified', 'ready'].includes(this.record?.phase)) throw notApplied('Deploy the model before verifying it.');
    this.busy = true;
    try { await this.#verify(signal); return this.status(); } finally { this.busy = false; }
  }

  async #refresh(signal) {
    await this.#confirmAccount(signal);
    const pods = (this.record.pods ?? []).filter(pod => pod?.id);
    const states = [];
    for (const pod of pods) states.push((await this.#pod(pod.id, signal)).status);
    if (pods.length && states.every(state => GONE.has(state))) {
      this.#save({ ...this.record, phase: 'stopped', verification: undefined, stoppedBy: 'idle', stoppedAt: new Date(this.clock()).toISOString() });
    }
  }

  /** Ask RunPod whether a ready model's pods still run; pods that stopped themselves when idle make it `stopped`. */
  async refresh({ signal } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (this.record?.phase !== 'ready') return this.status();
    this.busy = true;
    try { await this.#refresh(signal); return this.status(); } finally { this.busy = false; }
  }

  /** A model-provider description for workers (see validateModelProvider); never the key. */
  endpoint() {
    const r = this.record;
    if (r?.phase !== 'ready' || !r.verification) throw notApplied('The self-hosted model is not verified and ready.');
    const s = r.settings;
    return validateModelProvider({ id: `selfhosted-${r.profile}`, name: s.label, model: s.model, envKey: SELFHOSTED_KEY_ENV,
      baseUrls: r.endpoints.map(origin => `${origin}/v1`), apis: ['responses', 'chat', 'anthropic'], contextWindow: s.contextWindow,
      ...(r.hints?.compact_tokens ? { autoCompactTokenLimit: r.hints.compact_tokens } : {}),
      profile: r.profile, gpu: s.gpu, replicas: s.replicas, usdPerHourPerReplica: s.usdPerHourPerReplica, scaledownMinutes: s.scaledownMinutes });
  }

  /** The endpoint key (backend only). */
  async key() {
    if (!['ready', 'unverified', 'stopped'].includes(this.record?.phase)) throw notApplied('No owned self-hosted model is deployed.');
    return this.store.get(this.keyName);
  }

  // The key must belong to the account that owns the pods: the same key, or a new key that sees them.
  async #confirmAccount(signal) {
    const current = fingerprint(this.#accountKey());
    if (current === this.record.account) return;
    const refused = notApplied('The RunPod key changed and does not reach the owned pods; use a key of the account that owns them.');
    const pods = (this.record.pods ?? []).filter(pod => pod?.id);
    if (this.record.account && !pods.length) throw refused;
    for (const pod of pods) {
      const { status, data } = await this.#api('GET', `/pods/${pod.id}`, { signal });
      if (status !== 200 || data?.name !== pod.name) throw refused;
    }
    this.#save({ ...this.record, account: current });
  }

  async #deletePod(id, signal) {
    for (let attempt = 1; ; attempt++) {
      const { status } = await this.#api('DELETE', `/pods/${id}`, { signal });
      if (status === 204 || status === 200 || status === 404) return;
      if (attempt >= this.deleteAttempts) throw uncertain();
      await pause(this.pollMs, signal);
    }
  }

  // Stop every owned pod and wait until RunPod reports each one stopped (or gone).
  async #stopPods(signal) {
    const pods = (this.record.pods ?? []).filter(pod => pod?.id);
    for (const pod of pods) {
      const { status } = await this.#api('POST', `/pods/${pod.id}/action`, { body: { action: 'stop' }, signal });
      if (![200, 404, 409].includes(status)) throw uncertain();
    }
    const deadline = this.clock() + this.stopWaitMs;
    for (const pod of pods) {
      for (;;) {
        const state = (await this.#pod(pod.id, signal)).status;
        if (GONE.has(state)) break;
        if (this.clock() >= deadline) throw uncertain();
        await pause(this.pollMs, signal);
      }
    }
  }

  /** Stop the GPUs now; the key and the disks with the weights stay for a later deploy. */
  async stop({ signal } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (!['ready', 'unverified', 'unknown'].includes(this.record?.phase) || !OWNED_NAME.test(this.record?.appName ?? '') || !this.record.pods?.some(pod => pod?.id)) {
      throw notApplied('No owned self-hosted model is running.');
    }
    this.busy = true;
    try {
      await this.#confirmAccount(signal);
      try { await this.#stopPods(signal); } catch { this.#save({ ...this.record, phase: 'unknown' }); throw uncertain(); }
      this.#save({ ...this.record, phase: 'stopped', verification: undefined, stoppedBy: 'stop', stoppedAt: new Date(this.clock()).toISOString() });
      return this.status();
    } finally { this.busy = false; }
  }

  /**
   * Take over the pods of an owned model that another version of the caller created, so they can
   * be retired. It starts as unknown: never trusted for work without a fresh deployment.
   */
  adopt({ appName } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (this.record && this.record.phase !== 'retired') throw notApplied('An owned model is already journaled here.');
    if (!OWNED_NAME.test(appName ?? '') || !appName.startsWith(`${this.namePrefix}-`)) throw notApplied('Only a model with this owner prefix can be adopted.');
    const at = new Date(this.clock()).toISOString();
    this.#save({ version: 1, cloud: 'runpod', attemptId: randomUUID(), appName, profile: appName.split('-')[1], overrides: {}, phase: 'unknown',
      account: null, pods: [], createdAt: at, adoptedAt: at });
    return this.status();
  }

  /** Delete every owned pod (with its disk) and the local key, and check that none is left. A network volume is never deleted. */
  async retire({ signal } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    const record = this.record;
    if (!record || record.phase === 'retired') return this.status();
    if (!OWNED_NAME.test(record.appName ?? '')) throw notApplied('The journal is unreadable; adopt the model by its name to retire it.');
    this.busy = true;
    try {
      if (record.phase === 'prepared') {
        await this.store.delete(this.keyName);
        this.#save({ ...record, phase: 'retired', cleanupVerified: true });
        return this.status();
      }
      await this.#confirmAccount(signal);
      this.#save({ ...this.record, phase: 'retiring' });
      try {
        const ids = new Set((this.record.pods ?? []).filter(pod => pod?.id).map(pod => pod.id));
        for (const pod of await this.#ownedByName(signal)) ids.add(pod.id);
        for (const id of ids) await this.#deletePod(id, signal);
        if ((await this.#ownedByName(signal)).length) throw uncertain();
        for (const id of ids) if ((await this.#pod(id, signal)).status !== 'TERMINATED') throw uncertain();
        await this.store.delete(this.keyName);
      } catch { this.#save({ ...this.record, phase: 'unknown' }); throw uncertain(); }
      this.#save({ ...this.record, phase: 'retired', cleanupVerified: true, pods: [], endpoints: undefined, verification: undefined, retiredAt: new Date(this.clock()).toISOString() });
      return this.status();
    } finally { this.busy = false; }
  }
}
