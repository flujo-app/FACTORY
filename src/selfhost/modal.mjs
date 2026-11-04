// A self-hosted model on Modal (vLLM), owned and journaled by FACTORY. The Python sources in
// selfhost/modal/ define the Modal app; this class runs them with the caller's Python and
// Modal profile, verifies the served model, and stops or retires exactly the owned resources.
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModelProvider } from '../model-provider.mjs';

export const SELFHOST_MODAL_DIR = fileURLToPath(new URL('../../selfhost/modal/', import.meta.url));
export const SELFHOSTED_KEY_ENV = 'FACTORY_SELFHOSTED_MODEL_KEY';
const SOURCES = ['app.py', 'settings.py', 'discovery.py', 'deploy.py', 'prices.json'];
const OWNED_NAME = /^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[a-f0-9]{12}$/;
const MINUTE = 60_000;

const notApplied = message => Object.assign(new Error(message), { outcome: 'not_applied' });
const unknown = message => Object.assign(new Error(message), { code: 'UNKNOWN', outcome: 'unknown', unknown: true });
const uncertain = () => unknown('The self-hosted model has an uncertain outcome. Its owned resources are kept for reconciliation; retire them before deploying again.');
const json = raw => { try { return JSON.parse(raw); } catch { return null; } };
const lastJsonLine = raw => json(String(raw ?? '').trim().split(/\r?\n/).reverse().find(line => line.trim().startsWith('{')) ?? '');

/** The bundled model profiles with list-price estimates per running replica. */
export function selfHostedProfiles() {
  const prices = JSON.parse(readFileSync(join(SELFHOST_MODAL_DIR, 'prices.json'), 'utf8'));
  return readdirSync(join(SELFHOST_MODAL_DIR, 'profiles')).filter(name => name.endsWith('.json')).sort().map(name => {
    const profile = JSON.parse(readFileSync(join(SELFHOST_MODAL_DIR, 'profiles', name), 'utf8'));
    const cpu = profile.cpu ?? 8, memoryMib = profile.memory_mib ?? 65536, gpuCount = profile.gpu_count ?? 1;
    const usdPerSecond = prices.gpuPerSecond[profile.gpu] * gpuCount + cpu * prices.cpuCorePerSecond + memoryMib / 1024 * prices.memoryGibPerSecond;
    return { id: name.slice(0, -5), label: profile.label, model: profile.served_name, source: profile.model, gpu: profile.gpu, gpuCount, cpu, memoryMib,
      contextWindow: profile.max_model_len, autoCompactTokenLimit: profile.compact_tokens ?? null, efforts: profile.efforts ?? null,
      variant: profile.variant ?? null, variants: Object.keys(profile.variants ?? {}), scaledownMinutes: profile.scaledown_minutes ?? 10,
      usdPerSecond, usdPerHour: Math.round(usdPerSecond * 3600 * 100) / 100, pricesCheckedAt: prices.checkedAt, estimate: 'list price, not an invoice' };
  });
}

/** An owned Modal web endpoint: https, Modal's domains, origin only. */
export function modalEndpointOrigin(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname.endsWith('.modal.run') || url.hostname.endsWith('.modal.direct'))
      && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

/**
 * Fetch from a Modal web endpoint. Modal answers a long request with 303 and a result URL on
 * the same origin and path; follow at most 20 of them with GET, never replaying a POST and
 * never sending the key to another origin.
 */
export async function modalResult(fetchImpl, url, options, controller) {
  const original = new URL(url);
  let current = original.href;
  let request = { ...options, signal: controller.signal, redirect: 'manual' };
  for (let redirects = 0; redirects <= 20; redirects++) {
    if (controller.signal.aborted) throw uncertain();
    const response = await fetchImpl(current, request);
    if (response.status !== 303) return response;
    let next;
    try { next = new URL(response.headers?.get('location'), current); } catch { controller.abort(); throw uncertain(); }
    if (redirects === 20 || next.origin !== original.origin || next.pathname !== original.pathname || !next.search || next.hash || next.username || next.password) {
      controller.abort(); throw uncertain();
    }
    response.body?.cancel?.().catch(() => {});
    current = next.href;
    request = { method: 'GET', headers: { authorization: options.headers.authorization }, signal: controller.signal, redirect: 'manual' };
  }
  controller.abort(); throw uncertain();
}

/** Read a JSON body up to maxBytes; a larger or broken body aborts the request. */
export async function readBoundedJson(response, maxBytes, controller) {
  if (!response?.body || typeof response.body.getReader !== 'function') throw uncertain();
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0, complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw uncertain();
      bytes += value.byteLength;
      if (bytes > maxBytes) throw uncertain();
      chunks.push(value);
    }
    return json(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch { controller.abort(); throw uncertain(); }
  finally {
    if (!complete) { try { reader.cancel().catch(() => {}); } catch { /* already aborted */ } }
    reader.releaseLock();
  }
}

/**
 * Prove an endpoint serves the expected model: its catalogue lists it and one short, non-
 * thinking completion returns an exact challenge with finish_reason "stop".
 */
export async function probeSelfHostedModel({ fetchImpl = fetch, endpoint, key, model, challenge, signal, timeoutMs = 45 * MINUTE }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const catalogue = await modalResult(fetchImpl, `${endpoint}/v1/models`, { headers: { authorization: `Bearer ${key}` } }, controller);
    if (!catalogue.ok) { controller.abort(); throw uncertain(); }
    const models = (await readBoundedJson(catalogue, 64_000, controller))?.data;
    if (!Array.isArray(models) || !models.some(item => item?.id === model)) throw uncertain();
    const catalogVerifiedAt = new Date().toISOString();
    const completion = await modalResult(fetchImpl, `${endpoint}/v1/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 48, stream: false, chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: 'user', content: `Reply with exactly this text and nothing else: ${challenge}` }] }) }, controller);
    if (!completion.ok) { controller.abort(); throw uncertain(); }
    const result = await readBoundedJson(completion, 64_000, controller);
    if (controller.signal.aborted) throw uncertain();
    const choice = result?.choices?.[0];
    if (result?.model !== model || !Array.isArray(result?.choices) || result.choices.length !== 1 || choice?.message?.role !== 'assistant'
      || typeof choice.message.content !== 'string' || choice.message.content.trim() !== challenge || choice.finish_reason !== 'stop') throw uncertain();
    return { model, catalogVerifiedAt, completionVerifiedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Run a command with stdin input and bounded output; Stop and timeouts end its process tree. */
export function runCommand(command, args, { input = '', env = process.env, cwd, timeoutMs = 10 * MINUTE, signal, maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const posix = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: posix });
    let stdout = '', stderr = '', size = 0, settled = false;
    const killTree = () => {
      try {
        if (posix) process.kill(-child.pid, 'SIGKILL');
        else spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { child.kill('SIGKILL'); }
    };
    const finish = action => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); action(); };
    const fail = message => { killTree(); finish(() => reject(new Error(message))); };
    const onAbort = () => fail('The command was stopped.');
    const timer = setTimeout(() => fail('The command timed out.'), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = target => chunk => {
      size += chunk.length;
      if (size > maxBytes) return fail('The command output exceeded its limit.');
      if (target === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function fileCredentialStore(directory) {
  const file = name => join(directory, `${name}.key`);
  return {
    get: async name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : null,
    set: async (name, value) => { mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(file(name), value, { mode: 0o600 }); },
    delete: async name => rmSync(file(name), { force: true }),
  };
}

/**
 * One owned self-hosted model on Modal. Phases: prepared → deploying → unverified → ready,
 * stopped (GPU off, resources kept), retired (resources deleted and checked), unknown (an
 * uncertain remote outcome; retire to reconcile). Uncertain operations are never replayed.
 */
export class ModalSelfHostedModel {
  constructor({ directory, python = process.platform === 'win32' ? 'python' : 'python3', pythonArgs = [], env = process.env,
    commandRunner = runCommand, fetchImpl = fetch, credentialStore, keyName = 'selfhosted-model', namePrefix = 'factory',
    clock = Date.now, deployTimeoutMs = 45 * MINUTE, prefetchTimeoutMs = 70 * MINUTE } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Select a private state directory.');
    if (!/^[a-z][a-z0-9]{1,15}$/.test(namePrefix)) throw new TypeError('namePrefix must be a short lowercase name.');
    Object.assign(this, { directory, python, pythonArgs: [...pythonArgs], commandRunner, fetch: fetchImpl, keyName, namePrefix, clock, deployTimeoutMs, prefetchTimeoutMs });
    this.environment = typeof env === 'function' ? env : () => env;
    this.store = credentialStore ?? fileCredentialStore(directory);
    this.path = join(directory, 'model.json');
    this.busy = false;
    this.record = null;
    if (existsSync(this.path)) {
      const record = json(readFileSync(this.path, 'utf8'));
      this.record = record?.version === 1 && OWNED_NAME.test(record.appName ?? '') ? record : { version: 1, phase: 'unknown' };
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

  #env() {
    const env = { ...this.environment() };
    for (const name of Object.keys(env)) if (/^FACTORY_SELFHOST_/i.test(name)) delete env[name];
    if (this.record?.profileName) env.MODAL_PROFILE = this.record.profileName;
    return env;
  }

  #cli(args, { signal, timeoutMs = MINUTE } = {}) {
    return this.commandRunner(this.python, [...this.pythonArgs, '-m', 'modal', ...args], { signal, timeoutMs, maxBytes: 1_000_000, env: this.#env(), killTree: true });
  }

  async #script(request, { signal, timeoutMs }) {
    const source = join(this.directory, 'source');
    mkdirSync(source, { recursive: true, mode: 0o700 });
    for (const name of SOURCES) copyFileSync(join(SELFHOST_MODAL_DIR, name), join(source, name));
    // The settings read their profile next to themselves.
    mkdirSync(join(source, 'profiles'), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(join(SELFHOST_MODAL_DIR, 'profiles'))) copyFileSync(join(SELFHOST_MODAL_DIR, 'profiles', name), join(source, 'profiles', name));
    const result = await this.commandRunner(this.python, [...this.pythonArgs, '-B', join(source, 'deploy.py')],
      { signal, timeoutMs, input: JSON.stringify(request), maxBytes: 1_000_000, env: this.#env(), killTree: true, cwd: source });
    const answer = lastJsonLine(result?.stdout);
    if (result?.code !== 0 || !answer || answer.error) return { error: answer?.error ?? 'The self-hosted model script did not complete.' };
    return answer;
  }

  async #account(signal) {
    const result = await this.#cli(['profile', 'list', '--json'], { signal, timeoutMs: 20_000 });
    const profiles = json(result?.stdout);
    const active = Array.isArray(profiles) ? profiles.filter(item => item?.active === true) : [];
    if (result?.code !== 0 || active.length !== 1 || typeof active[0].name !== 'string' || !active[0].name
      || typeof active[0].workspace !== 'string' || !active[0].workspace || /^unknown/i.test(active[0].workspace)) {
      throw notApplied('The Modal profile and workspace could not be verified.');
    }
    return { profileName: active[0].name, workspaceName: active[0].workspace };
  }

  /** Safe state: no key, URL or app name. */
  status() {
    const r = this.record, s = r?.settings;
    const phase = r?.phase ?? 'off';
    return { phase, ready: phase === 'ready' && !this.busy, busy: this.busy, profile: r?.profile ?? null, label: s?.label ?? null, model: s?.model ?? null,
      gpu: s?.gpu ?? null, replicas: s?.replicas ?? null, endpoints: r?.endpoints?.length ?? 0, contextWindow: s?.contextWindow ?? null,
      usdPerHourPerReplica: s?.usdPerHourPerReplica ?? null, scaledownMinutes: s?.scaledownMinutes ?? null,
      verified: Boolean(r?.verification && phase === 'ready'), cleanupVerified: r?.cleanupVerified === true, updatedAt: r?.updatedAt ?? null };
  }

  /** Deploy a profile (or redeploy a stopped model) and, by default, verify it serves the model. */
  async deploy({ profile = 'qwen', overrides = {}, signal, verify = true, prefetch = false } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (signal?.aborted) throw notApplied('Deployment was cancelled before it started.');
    if (!/^[a-z][a-z0-9]{1,15}$/.test(profile) || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw notApplied('Select a profile and an overrides object.');
    this.busy = true;
    try {
      let record = this.record;
      const redeploy = record?.phase === 'stopped';
      if (record && !['retired', 'stopped'].includes(record.phase)) {
        throw notApplied(record.phase === 'unknown' ? 'The owned model has an uncertain outcome; retire it to reconcile first.' : `The owned model is ${record.phase}.`);
      }
      if (redeploy && (record.profile !== profile || JSON.stringify(record.overrides ?? {}) !== JSON.stringify(overrides))) {
        throw notApplied('A stopped model keeps its profile and settings; retire it to change them.');
      }
      if (!redeploy) {
        const appName = `${this.namePrefix}-${profile}-${randomBytes(6).toString('hex')}`;
        record = this.#save({ version: 1, attemptId: randomUUID(), appName, profile, overrides, phase: 'prepared', createdAt: new Date(this.clock()).toISOString() });
        try {
          const described = await this.#script({ action: 'describe', appName, profile, overrides }, { signal, timeoutMs: MINUTE });
          if (described.error) throw notApplied(described.error);
          const account = await this.#account(signal);
          await this.store.set(this.keyName, randomBytes(48).toString('base64url'));
          record = this.#save({ ...this.record, ...account, settings: described.settings, hints: described.hints ?? {} });
          if (signal?.aborted) throw notApplied('Deployment was cancelled before remote work started.');
        } catch (error) {
          // Nothing remote exists yet: retire the local preparation.
          await this.store.delete(this.keyName)?.catch?.(() => {});
          this.#save({ ...this.record, phase: 'retired', cleanupVerified: true });
          throw error.outcome ? error : notApplied('The self-hosted model could not be prepared.');
        }
      }
      this.#save({ ...record, phase: 'deploying', verification: undefined });
      try {
        const key = await this.store.get(this.keyName);
        if (typeof key !== 'string' || key.length < 32) throw uncertain();
        const request = { appName: record.appName, profile: record.profile, overrides: record.overrides ?? {} };
        if (prefetch && !redeploy) {
          const fetched = await this.#script({ ...request, action: 'prefetch' }, { signal, timeoutMs: this.prefetchTimeoutMs });
          if (fetched.error) throw uncertain();
        }
        const result = await this.#script({ ...request, action: 'deploy', key, reuseSecret: redeploy }, { signal, timeoutMs: this.deployTimeoutMs });
        const endpoints = Array.isArray(result.endpoints) ? result.endpoints.map(modalEndpointOrigin) : [];
        if (result.error || !endpoints.length || endpoints.some(value => !value) || endpoints.length !== record.settings.replicas) throw uncertain();
        this.#save({ ...this.record, phase: 'unverified', endpoints, deployedAt: new Date(this.clock()).toISOString() });
      } catch { this.#save({ ...this.record, phase: 'unknown' }); throw uncertain(); }
      if (verify) await this.#verify(signal);
      return this.status();
    } finally { this.busy = false; }
  }

  async #verify(signal) {
    const record = this.record;
    try {
      const key = await this.store.get(this.keyName);
      const timeoutMs = ((record.settings?.startupTimeoutMinutes ?? 40) + 5) * MINUTE;
      let verification;
      for (const endpoint of record.endpoints) {
        verification = await probeSelfHostedModel({ fetchImpl: this.fetch, endpoint, key, model: record.settings.model,
          challenge: `FACTORY-${randomBytes(4).toString('hex').toUpperCase()}`, signal, timeoutMs });
      }
      this.#save({ ...this.record, phase: 'ready', verification: { ...verification, version: 1 } });
    } catch { this.#save({ ...this.record, phase: 'unknown' }); throw uncertain(); }
  }

  /** Re-check an unverified deployment. */
  async verify({ signal } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (!['unverified', 'ready'].includes(this.record?.phase)) throw notApplied('Deploy the model before verifying it.');
    this.busy = true;
    try { await this.#verify(signal); return this.status(); } finally { this.busy = false; }
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

  async #confirmAccount(signal) {
    const record = this.record;
    const account = await this.#account(signal);
    if (account.profileName !== record.profileName || account.workspaceName !== record.workspaceName) {
      throw notApplied('The active Modal profile or workspace changed; select the original one first.');
    }
  }

  // app list --json: the owned app's state, or null when Modal no longer lists it.
  async #appState(signal) {
    const listed = await this.#cli(['app', 'list', '--json'], { signal });
    const apps = json(listed?.stdout);
    if (listed?.code !== 0 || !Array.isArray(apps)) throw uncertain();
    const own = apps.filter(item => item?.description === this.record.appName);
    return own.length ? own.map(item => String(item.state ?? '')) : null;
  }

  async #stopApp(signal) {
    const stopped = await this.#cli(['app', 'stop', '--yes', this.record.appName], { signal });
    const states = await this.#appState(signal);
    // Stopped (now or earlier), or never created after an early deployment failure, is a
    // confirmed GPU-off state; anything else stays uncertain.
    if (states && !states.every(state => /^stopped$/i.test(state))) throw uncertain();
    return { stopCommand: stopped?.code === 0 ? 'ok' : 'refused', listed: Boolean(states) };
  }

  /** Stop the GPU containers now; key, secret and cached weights stay for a later redeploy. */
  async stop({ signal } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (!['ready', 'unverified', 'unknown'].includes(this.record?.phase) || !OWNED_NAME.test(this.record?.appName ?? '')) throw notApplied('No owned self-hosted model is running.');
    this.busy = true;
    try {
      await this.#confirmAccount(signal);
      try { await this.#stopApp(signal); } catch { this.#save({ ...this.record, phase: 'unknown' }); throw uncertain(); }
      this.#save({ ...this.record, phase: 'stopped', verification: undefined, stoppedAt: new Date(this.clock()).toISOString() });
      return this.status();
    } finally { this.busy = false; }
  }

  /**
   * Take over an owned app that another version of the caller created, so it can be retired.
   * The model starts as unknown: it is never trusted for work without a fresh deployment.
   */
  adopt({ appName, profileName, workspaceName, endpoints = [] } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    if (this.record && this.record.phase !== 'retired') throw notApplied('An owned model is already journaled here.');
    if (!OWNED_NAME.test(appName ?? '') || !appName.startsWith(`${this.namePrefix}-`)) throw notApplied('Only an app with this owner prefix can be adopted.');
    if (typeof profileName !== 'string' || !profileName || typeof workspaceName !== 'string' || !workspaceName) {
      throw notApplied('Adopting needs the original Modal profile and workspace.');
    }
    const origins = Array.isArray(endpoints) ? endpoints.map(modalEndpointOrigin) : [null];
    if (origins.some(origin => !origin)) throw notApplied('Adopted endpoints must be owned Modal origins.');
    const at = new Date(this.clock()).toISOString();
    this.#save({ version: 1, attemptId: randomUUID(), appName, profile: appName.split('-')[1], overrides: {}, phase: 'unknown',
      profileName, workspaceName, endpoints: origins, createdAt: at, adoptedAt: at });
    return this.status();
  }

  /** Stop and delete every owned resource (app, secret, both volumes, local key) and check it. */
  async retire({ signal } = {}) {
    if (this.busy) throw notApplied('The self-hosted model is already changing.');
    const record = this.record;
    if (!record || record.phase === 'retired') return this.status();
    if (!OWNED_NAME.test(record.appName ?? '')) throw uncertain();
    this.busy = true;
    try {
      if (record.phase === 'prepared') {
        await this.store.delete(this.keyName);
        this.#save({ ...record, phase: 'retired', cleanupVerified: true });
        return this.status();
      }
      await this.#confirmAccount(signal);
      this.#save({ ...record, phase: 'retiring' });
      try {
        await this.#stopApp(signal);
        const app = record.appName;
        const owned = [['secret', `${app}-auth`], ['volume', `${app}-hf-cache`], ['volume', `${app}-vllm-cache`]];
        for (const [kind, name] of owned) {
          const deleted = await this.#cli([kind, 'delete', '--allow-missing', '--yes', name], { signal });
          if (deleted?.code !== 0) throw uncertain();
        }
        const [secrets, volumes] = await Promise.all([this.#cli(['secret', 'list', '--json'], { signal }), this.#cli(['volume', 'list', '--json'], { signal })]);
        const remaining = [json(secrets?.stdout), json(volumes?.stdout)];
        if (secrets?.code !== 0 || volumes?.code !== 0 || remaining.some(items => !Array.isArray(items))
          || remaining.some(items => items.some(item => owned.some(([, name]) => item?.name === name)))) throw uncertain();
        await this.store.delete(this.keyName);
      } catch { this.#save({ ...this.record, phase: 'unknown' }); throw uncertain(); }
      this.#save({ ...this.record, phase: 'retired', cleanupVerified: true, endpoints: undefined, verification: undefined, retiredAt: new Date(this.clock()).toISOString() });
      return this.status();
    } finally { this.busy = false; }
  }
}
