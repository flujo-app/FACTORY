import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, fsyncSync, closeSync, renameSync, readSync, ftruncateSync, writeSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { secret, hash, agentInventory, validateCloudLitePlan, machineConfig, redact } from './protocol.mjs';
import { CodexRpc } from './rpc.mjs';
import { cloudLiteBootstrap } from './bootstrap.mjs';
import { loadFlujoCloudInfrastructure } from './upstream.mjs';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createEvidenceClient } from '../evidence.mjs';

const TRACE_PAGE_SIZE = 100;
const DEFAULT_OBSERVATION_PAGES = 5;
const TRACE_PAGE_BYTE_LIMIT = 512 * 1024;
const TRACE_SINGLE_RECORD_LIMIT = 2 * 1024 * 1024 + 4096;
const TRACE_RECOVERY_WINDOW = TRACE_SINGLE_RECORD_LIMIT;

function nativeStopTarget(agentId, native) {
  if (!native || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(native.threadId ?? '')
    || !['active','idle','archived'].includes(native.threadStatus)
    || native.threadStatus === 'active' && (native.turnStatus !== 'inProgress' || !native.turnId)
    || native.turnStatus === 'inProgress' && native.threadStatus !== 'active') {
    throw new Error(`Agent ${agentId} lacks a consistent registered native thread/turn state; refusing an unbound stop.`);
  }
  return { expectedThreadId: native.threadId, expectedTurnId: native.turnId ?? null };
}

function lastPersistedTraceSequence(file) {
  if (!existsSync(file)) return 0;
  const fd = openSync(file, 'r+');
  try {
    const size = statSync(file).size;
    if (!size) return 0;
    const lastByte = Buffer.alloc(1);
    readSync(fd, lastByte, 0, 1, size - 1);
    const complete = lastByte[0] === 10;
    let position = complete ? size - 1 : size;
    let newline = -1;
    while (position > 0 && (complete ? size - 1 : size) - position < TRACE_RECOVERY_WINDOW) {
      const start = Math.max(0, position - 64 * 1024);
      const chunk = Buffer.alloc(position - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const found = chunk.lastIndexOf(10);
      if (found >= 0) { newline = start + found; break; }
      position = start;
    }
    if (newline < 0 && position > 0) throw new Error('Trace tail exceeds the bounded recovery window.');
    const lineStart = newline + 1;
    if (!complete) {
      const fragment = Buffer.alloc(size - lineStart);
      readSync(fd, fragment, 0, fragment.length, lineStart);
      const evidence = `${file}.preserved-tail-${hash(fragment)}.raw`;
      let evidenceFd;
      try {
        evidenceFd = openSync(evidence, 'wx', 0o600);
        writeSync(evidenceFd, fragment);
        fsyncSync(evidenceFd);
      } catch (error) {
        if (error.code !== 'EEXIST' || !readFileSync(evidence).equals(fragment)) throw error;
      } finally { if (evidenceFd !== undefined) closeSync(evidenceFd); }
      ftruncateSync(fd, lineStart);
      fsyncSync(fd);
      return lastPersistedTraceSequence(file);
    }
    const lineLength = size - 1 - lineStart;
    if (lineLength > TRACE_RECOVERY_WINDOW) throw new Error('Trace tail record exceeds the bounded recovery window.');
    const bytes = Buffer.alloc(lineLength);
    readSync(fd, bytes, 0, lineLength, lineStart);
    const line = bytes.toString('utf8');
    if (!line) return 0;
    const event = JSON.parse(line);
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error('Persisted trace tail has an invalid sequence.');
    return event.seq;
  } finally { closeSync(fd); }
}

function appendTracePage(file, events, after, through) {
  const fresh = [];
  let previous = after;
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous) throw new Error('Trace page sequence is not strictly increasing.');
    if (event.seq > through) throw new Error('Trace page exceeded its fixed watermark.');
    previous = event.seq;
    if (event.seq > after) fresh.push(event);
  }
  if (!fresh.length) return after;
  const fd = openSync(file, 'a', 0o600);
  try {
    for (const event of fresh) {
      const record = Buffer.from(JSON.stringify(event) + '\n');
      let offset = 0;
      while (offset < record.length) {
        const written = writeSync(fd, record, offset, record.length - offset);
        if (!written) throw new Error('Trace archive write made no progress.');
        offset += written;
      }
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return fresh.at(-1).seq;
}

function persistObservation(file, value) {
  const temporary = `${file}.${secret()}.next`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
}

/** Only this native host owns managed refresh; remote harnesses receive external access tokens. */
export class CodexSubscriptionBroker {
  constructor({ authFile, codexCommand = 'codex' } = {}) {
    if (!isAbsolute(authFile ?? '')) throw new TypeError('Select the existing absolute Codex subscription auth file.');
    this.authFile = authFile; this.command = codexCommand;
  }
  read() {
    const cache = JSON.parse(readFileSync(this.authFile, 'utf8'));
    if (cache.OPENAI_API_KEY || !cache.tokens?.access_token || !cache.tokens?.account_id) throw new Error('A ChatGPT subscription login is required; API-key fallback is disabled.');
    const jwt = JSON.parse(Buffer.from(cache.tokens.access_token.split('.')[1], 'base64url').toString());
    return { accessToken: cache.tokens.access_token, chatgptAccountId: cache.tokens.account_id,
      chatgptPlanType: jwt['https://api.openai.com/auth']?.chatgpt_plan_type };
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const home = resolve(this.authFile, '..');
      const rpc = new CodexRpc({ command: this.command, args: ['-c', 'mcp_servers={}'], env: { ...process.env, CODEX_HOME: home } });
      try { await rpc.initialize(); await rpc.request('account/read', { refreshToken: true }); return this.read(); }
      finally { rpc.close(); }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}

export class FactoryCloudLiteFleet {
  constructor({ directory, flujoCloudPath = process.env.FACTORY_FLUJO_CLOUD_PATH, infrastructure, flyCommand = 'flyctl', flyEnv = process.env, proxyEnv = flyEnv, execute, auth, onEvent = () => {} } = {}) {
    if (!isAbsolute(directory ?? '')) throw new TypeError('An absolute private fleet directory is required.');
    this.directory = directory; this.flyCommand = flyCommand; this.flyEnv = flyEnv; this.execute = execute; this.auth = auth; this.onEvent = onEvent;
    this.flujoCloudPath = flujoCloudPath; this.infrastructure = infrastructure;
    this.proxyEnv = proxyEnv;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.journalPath = join(directory, 'fleet.json');
    this.state = existsSync(this.journalPath) ? JSON.parse(readFileSync(this.journalPath, 'utf8')) : null;
  }
  save() {
    const temporary = `${this.journalPath}.${secret()}.next`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.journalPath);
  }
  event(type, body) { const event = { observedAt: new Date().toISOString(), type, body }; this.onEvent(event); }
  async upstream() {
    this.infrastructure ??= await loadFlujoCloudInfrastructure({ directory: this.flujoCloudPath, binary: this.flyCommand, env: this.flyEnv, proxyEnv: this.proxyEnv, cwd: this.directory });
    return this.infrastructure;
  }
  async fly(args, options = {}) {
    if (this.execute) return this.execute(this.flyCommand, args, { env: this.flyEnv, ...options, secrets: [...(this.knownSecrets ?? []), this.flyEnv.FLY_API_TOKEN, this.flyEnv.FLY_ACCESS_TOKEN].filter(Boolean) });
    return (await this.upstream()).run(args, options);
  }
  async stage(key, operation) {
    if (existsSync(this.journalPath)) this.state = JSON.parse(readFileSync(this.journalPath, 'utf8'));
    const prior = this.state.operations[key];
    if (prior?.state === 'succeeded') return prior.result;
    if (prior) throw new Error(`Operation ${key} is ${prior.state}; inspect the existing provider identity before recovery.`);
    const intents = join(this.directory, 'intents'); mkdirSync(intents, { recursive: true, mode: 0o700 });
    const intentFile = join(intents, `${hash(key)}.json`);
    try { writeFileSync(intentFile, JSON.stringify({ key, app: this.state.plan.app, startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error(`Operation ${key} retains an original intent; reconcile before dispatch.`); throw error; }
    this.state.operations[key] = { state: 'running', startedAt: new Date().toISOString() }; this.save(); this.event('provider.started', { key });
    try {
      const result = await operation(); this.state.operations[key] = { ...this.state.operations[key], state: 'succeeded', result, endedAt: new Date().toISOString() };
      this.save(); this.event('provider.succeeded', { key, result }); return result;
    } catch (error) {
      this.state.operations[key] = { ...this.state.operations[key], state: 'unknown', error: redact(error.message, this.knownSecrets), endedAt: new Date().toISOString() };
      this.save(); this.event('provider.unknown', { key, error: this.state.operations[key].error }); throw error;
    }
  }
  async prepare(input) {
    if (existsSync(this.journalPath)) this.state = JSON.parse(readFileSync(this.journalPath, 'utf8'));
    const plan = validateCloudLitePlan(input);
    if (this.state) {
      if (JSON.stringify(this.state.plan) !== JSON.stringify(plan)) throw new Error('Existing fleet binding differs.');
    } else {
      const credentials = Object.fromEntries(agentInventory(plan).map(a => [a.id, secret()]));
      writeFileSync(join(this.directory, 'credentials.json'), JSON.stringify({ credentials, operatorToken: secret() }), { mode: 0o600, flag: 'wx' });
      this.state = { schemaVersion: 1, plan, image: null, operations: {}, machines: [], createdAt: new Date().toISOString() }; this.save();
    }
    await this.stage('app.create', async () => { await this.fly(['apps', 'create', plan.app, '--org', plan.org ?? 'personal']); return { app: plan.app }; });
    return this.snapshot();
  }
  async deploy(input, { image, imageSource, channel, githubToken, bundlePath, evidenceTokens } = {}) {
    if (input.repository && !githubToken || !this.auth) throw new TypeError('Select a subscription auth broker and, for Git tasks, a GitHub credential.');
    if (imageSource) image = (await (await this.upstream()).resolveWorkerImage({ source: imageSource, image, channel })).image;
    if (!image) throw new TypeError('Select an immutable worker image or its upstream FLUJO compatibility advertisement.');
    await this.prepare(input); const plan = this.state.plan;
    if(plan.collection){
      const path=join(this.directory,'evidence-credentials.json');
      if(!evidenceTokens && existsSync(path))evidenceTokens=JSON.parse(readFileSync(path));
      if(!evidenceTokens || Array.from({length:plan.machines},(_,i)=>evidenceTokens[`m${i}`]).some(token=>typeof token!=='string'||token.length<32))throw new Error('Configure one archive credential per machine.');
      if(new Set(Object.values(evidenceTokens)).size!==plan.machines)throw new Error('Archive credentials must be distinct per machine.');
      if(existsSync(path) && hash(JSON.parse(readFileSync(path)))!==hash(evidenceTokens))throw new Error('Retain original archive credentials on recovery.');
      if(!existsSync(path))writeFileSync(path,JSON.stringify(evidenceTokens),{mode:0o600,flag:'wx'});
      // Preflight the external archive before provisioning paid worker machines.
      for(const [machineId,token]of Object.entries(evidenceTokens)){
        const identity=await createEvidenceClient({url:plan.collection.url,token}).identity();
        if(identity.runId!==plan.runId || identity.machineId!==machineId)throw new Error('Archive credential is bound to a different run/machine.');
      }
    }
    if (this.state.image && this.state.image !== image) throw new Error('Existing fleet image differs.');
    this.state.image = image; this.save();
    let bootstrapPath;
    if (bundlePath) {
      if (!isAbsolute(bundlePath)) throw new TypeError('Select an absolute SDK tarball path.');
      const bundleDigest = hash(readFileSync(bundlePath));
      if (this.state.bundleSha256 && this.state.bundleSha256 !== bundleDigest) throw new Error('Existing fleet bundle differs.');
      this.state.bundleSha256 = bundleDigest; this.save();
      bootstrapPath = join(this.directory, 'bootstrap.sh'); writeFileSync(bootstrapPath, cloudLiteBootstrap(bundleDigest), { mode: 0o600 });
    }
    const { credentials, operatorToken } = JSON.parse(readFileSync(join(this.directory, 'credentials.json')));
    const initialAuth = this.auth.read(); this.knownSecrets = [githubToken, initialAuth.accessToken, operatorToken, ...Object.values(credentials),...Object.values(evidenceTokens??{})];
    await this.stage('app.credentials', async () => {
      const config = Buffer.from(JSON.stringify({ plan, credentials, operatorToken, initialAuth, githubToken, evidenceTokens })).toString('base64');
      this.knownSecrets.push(config);
      await this.fly(['secrets', 'import', '--app', plan.app, '--stage'], { input: `FACTORY_CLOUD_BOOTSTRAP_B64=${config}\n` });
      return { staged: true };
    });
    for (let index = 0; index < plan.machines; index++) {
      const name = `factory-${plan.runId}-m${index}`;
      const volume = await this.stage(`m${index}.volume`, async () => {
        const raw = await this.fly(['volumes', 'create', `factory_m${index}`, '--app', plan.app, '--region', plan.region, '--size', String(plan.diskGb), '--scheduled-snapshots=false', '--yes', '--json']);
        const parsed = JSON.parse(raw); return { id: parsed.id ?? parsed.ID };
      });
      const upstream = await this.upstream();
      const base = upstream.buildMachineConfig({ image, volumeId: volume.id, owner: plan.runId }, { idle: false, memoryMb: plan.memoryMb });
      const config = { ...base, ...machineConfig(plan, { image, volumeId: volume.id, index, environment: {
        FACTORY_MACHINE_INDEX: String(index), ...(index ? { FACTORY_BOARD_MACHINE_ID: this.state.machines[0]?.id } : {}),
      } }) };
      config.init = { exec: bundlePath ? ['/bin/bash', '/opt/factory-bootstrap.sh'] : ['node', '/opt/factory/bin/factory-cloud-runtime.mjs'] };
      const configPath = join(this.directory, `m${index}.machine.json`); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      const old = this.state.operations[`m${index}.machine`];
      if (old?.state === 'unknown' && old.error?.includes('unknown flag: --json')) {
        const inventory = JSON.parse(await this.fly(['machine', 'list', '--app', plan.app, '--json']));
        if (inventory.some(x => x.name === name || x.Name === name)) throw new Error('A machine exists despite the CLI validation refusal; retain the original outcome.');
        this.state.operations[`m${index}.machine`] = { ...old, state: 'not_applied', reconciliation: 'Closed CLI argument refusal plus exact-name provider absence.' }; this.save();
      }
      const machine = await this.stage(`m${index}.machine-create`, async () => {
        if (bundlePath) config.files = [
          { guest_path: '/tmp/factory-sdk.tgz', raw_value: readFileSync(bundlePath).toString('base64') },
          { guest_path: '/opt/factory-bootstrap.sh', raw_value: readFileSync(bootstrapPath).toString('base64') },
        ];
        // This is flujo-cloud's existing Machines API helper. No positional CLI
        // image resolver, image build, registry login or push occurs here.
        await upstream.createMachine({ app: plan.app, name, region: plan.region, config });
        const inventory = JSON.parse(await this.fly(['machine', 'list', '--app', plan.app, '--json']));
        const matching = inventory.filter(x => x.name === name || x.Name === name);
        if (matching.length !== 1) throw new Error('Exactly one original machine must be observed after creation.');
        const value = matching[0]; const id = value.id ?? value.ID;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Provider machine identity was not confirmed.');
        return { id, name, volumeId: volume.id, config: { cpuKind: plan.cpuKind, cpus: plan.cpus, memoryMb: plan.memoryMb, diskGb: plan.diskGb } };
      });
      if (!this.state.machines.some(x => x.id === machine.id)) { this.state.machines.push(machine); this.save(); }
    }
    this.state.status = 'provisioned'; this.save(); return this.snapshot();
  }
  async request(path, body) {
    if (!this.connection) {
      const upstream = await this.upstream();
      const inventory = JSON.parse(await this.fly(['machine', 'list', '--app', this.state.plan.app, '--json']));
      const first = this.state.machines[0];
      const owned = inventory.find(x => x.id === first?.id);
      if (!owned || owned.config?.metadata?.['factory.run'] !== this.state.plan.runId || owned.config?.metadata?.['factory.machine'] !== 'm0') {
        throw new Error('Coordinator Machine ownership differs from the original fleet journal.');
      }
      if (owned.state !== 'started') throw new Error('Original coordinator Machine is not started.');
      this.connection = await upstream.proxy({ app: this.state.plan.app, org: this.state.plan.org ?? 'personal', machineId: first.id, localPort: await upstream.unusedLoopbackPort() });
      const deadline = Date.now() + 30000;
      try {
        for (;;) {
          this.connection.check();
          try {
            const response = await fetch(this.connection.origin + '/health', { signal: AbortSignal.timeout(2000), redirect: 'error' });
            const health = await response.json();
            if (response.ok && health.runId === this.state.plan.runId && health.runtime === 'factory-cloud-lite') break;
          } catch { /* flujo-cloud starts the owned proxy asynchronously. */ }
          if (Date.now() >= deadline) throw new Error('Original coordinator did not become ready through the upstream private proxy.');
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) { await this.disconnect(); throw error; }
    }
    try { this.connection.check(); } catch (error) { await this.disconnect(); throw error; }
    const { operatorToken } = JSON.parse(readFileSync(join(this.directory, 'credentials.json')));
    try {
      const response = await fetch(`${this.connection.origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Fleet coordinator ${path} returned ${response.status}.`); return await response.json();
    } catch (error) { await this.disconnect(); throw error; }
  }
  async disconnect() { if (this.connection) { await this.connection.stop(); this.connection = null; } }
  async start({ attempt } = {}) {
    if (!/^[a-z0-9-]{3,64}$/.test(attempt ?? '')) throw new TypeError('Select a stable recovery attempt identity.');
    for (const machine of this.state.machines) await this.stage(`${machine.id}.start.${attempt}`, async () => {
      const inventory = JSON.parse(await this.fly(['machine', 'list', '--app', this.state.plan.app, '--json']));
      const original = inventory.find(value => value.id === machine.id);
      if (!original || original.name !== machine.name || original.config?.metadata?.['factory.run'] !== this.state.plan.runId) throw new Error('Start requires the original owned Machine identity.');
      if (original.state !== 'started') {
        if (original.state !== 'stopped') throw new Error('Original Machine is transitioning; observe it before starting.');
        await this.fly(['machine', 'start', machine.id, '--app', this.state.plan.app]);
      }
      const readback = JSON.parse(await this.fly(['machine', 'list', '--app', this.state.plan.app, '--json'])).find(value => value.id === machine.id);
      return { machineId: machine.id, state: readback?.state };
    });
    return this.snapshot();
  }
  async observe({ maxPages = DEFAULT_OBSERVATION_PAGES } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 25) throw new TypeError('Select a bounded trace page budget.');
    // A watcher may run beside a deployment/recovery controller. Its cursor and
    // observations must never replace that controller's provisioning receipts.
    const observationPath = join(this.directory, 'observation.json');
    const snapshot = await this.request('/operator/status');
    if (snapshot.refreshRequested) { const auth = await this.auth.refresh(); this.knownSecrets?.push(auth.accessToken); await this.request('/operator/auth', auth); }
    const retained = existsSync(observationPath) ? JSON.parse(readFileSync(observationPath, 'utf8')) : null;
    if (retained && retained.runId !== this.state.plan.runId) throw new Error('Observation journal belongs to another fleet.');
    const observedWatermark = Number.isSafeInteger(snapshot.traceSequence) && snapshot.traceSequence >= 0 ? snapshot.traceSequence : null;
    if (observedWatermark === null) throw new Error('Fleet status did not provide a fixed trace watermark.');
    const priorWatermark = retained?.collection?.complete === false ? retained.traceWatermark : null;
    const traceWatermark = priorWatermark ?? observedWatermark;
    if (!Number.isSafeInteger(traceWatermark) || traceWatermark < 0 || traceWatermark > observedWatermark) throw new Error('Retained trace watermark is invalid or ahead of coordinator status.');
    const traceFile = join(this.directory, 'traces.jsonl');
    let traceCursor = retained?.traceCursor ?? this.state.traceCursor ?? 0;
    if (!Number.isSafeInteger(traceCursor) || traceCursor < 0) throw new Error('Retained trace cursor is invalid.');
    if (traceCursor > traceWatermark) throw new Error('Retained trace cursor is ahead of its fixed watermark.');
    const durableCursor = lastPersistedTraceSequence(traceFile);
    if (durableCursor < traceCursor) throw new Error('Retained trace cursor is ahead of durable trace evidence.');
    if (durableCursor > traceWatermark) throw new Error('Durable trace evidence is ahead of the fixed collection watermark.');
    // A crash after append+fsync but before cursor replacement leaves complete
    // rows in the trace file. Reconcile from that durable tail without appending
    // the same rows again.
    traceCursor = durableCursor;
    let pages = 0;
    let lastPageEvents = 0;
    let eventsCollected = 0;
    const observationStarted = Date.now();
    while (traceCursor < traceWatermark && pages < maxPages) {
      const report = await this.request(`/operator/events?after=${traceCursor}&through=${traceWatermark}`);
      if (!Array.isArray(report.events) || report.events.length > TRACE_PAGE_SIZE) throw new Error('Coordinator returned an invalid bounded trace page.');
      if (!report.events.length) break;
      const pageBytes = report.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
      if (pageBytes > TRACE_PAGE_BYTE_LIMIT && !(report.events.length === 1 && pageBytes <= TRACE_SINGLE_RECORD_LIMIT)) {
        throw new Error('Coordinator returned a trace page above the byte limit.');
      }
      const nextCursor = appendTracePage(traceFile, report.events, traceCursor, traceWatermark);
      if (nextCursor <= traceCursor) throw new Error('Trace page did not advance within the fixed watermark.');
      traceCursor = nextCursor;
      pages++;
      lastPageEvents = report.events.length;
      eventsCollected += report.events.length;
      const collection = { traceCursor, traceWatermark, observedWatermark, complete: traceCursor >= traceWatermark,
        remainingLag: Math.max(0, traceWatermark - traceCursor), observedLag: Math.max(0, observedWatermark - traceCursor),
        pages, eventsCollected, lastPageEvents, durationMs: Date.now() - observationStarted };
      persistObservation(observationPath, { runId: this.state.plan.runId, traceCursor, traceWatermark, observation: snapshot, collection });
    }
    const collection = { traceCursor, traceWatermark, observedWatermark, complete: traceCursor >= traceWatermark,
      remainingLag: Math.max(0, traceWatermark - traceCursor), observedLag: Math.max(0, observedWatermark - traceCursor),
      pages, eventsCollected, lastPageEvents, durationMs: Date.now() - observationStarted };
    snapshot.traceCollection = collection;
    persistObservation(observationPath, { runId: this.state.plan.runId, traceCursor, traceWatermark, observation: snapshot, collection });
    this.state = JSON.parse(readFileSync(this.journalPath, 'utf8'));
    this.state.traceCursor = traceCursor; this.state.observation = snapshot;
    return snapshot;
  }
  snapshot() { return structuredClone(this.state); }
  async command(agent, { id, action = 'message', message, expectedThreadId, expectedTurnId } = {}) {
    // The coordinator binds an omitted legacy stop target when it first
    // records the stable id, then reuses that stored binding on retries.
    return this.request('/operator/command', { id, recipient: agent, action, message, expectedThreadId, expectedTurnId });
  }
  /** Replace only the runtime bundle on the original, journal-owned Machines. */
  async updateRuntime({ bundlePath, machineIds } = {}) {
    if (!isAbsolute(bundlePath ?? '')) throw new TypeError('Select an absolute SDK tarball path.');
    const digest = hash(readFileSync(bundlePath));
    const selected = machineIds === undefined ? this.state.machines : this.state.machines.filter(machine => machineIds.includes(machine.id));
    if (machineIds !== undefined && (!Array.isArray(machineIds) || !machineIds.length || new Set(machineIds).size !== machineIds.length || selected.length !== machineIds.length)) {
      throw new TypeError('Select original journal-owned Machine identities.');
    }
    const bootstrapPath = join(this.directory, `bootstrap-${digest}.sh`);
    writeFileSync(bootstrapPath, cloudLiteBootstrap(digest), { mode: 0o600 });
    for (const machine of selected) {
      await this.stage(`${machine.id}.runtime.${digest}`, async () => {
        const inventory = JSON.parse(await this.fly(['machine', 'list', '--app', this.state.plan.app, '--json']));
        const original = inventory.find(value => value.id === machine.id);
        if (!original || original.name !== machine.name || original.config?.metadata?.['factory.run'] !== this.state.plan.runId) {
          throw new Error('Runtime update requires the exact original Machine identity.');
        }
        const config = original.config;
        config.init = { exec: ['/bin/bash', '/opt/factory-bootstrap.sh'] };
        config.env.FACTORY_BOARD_MACHINE_ID = this.state.machines[0].id;
        config.env.FACTORY_BOARD_PORT = '4200';
        config.services = [];
        config.metadata['factory.bundle'] = digest;
        const configPath = join(this.directory, `${machine.id}.${digest}.machine.json`);
        writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
        await this.fly(['machine', 'update', machine.id, '--app', this.state.plan.app, '--machine-config', configPath,
          '--file-local', `/tmp/factory-sdk.tgz=${bundlePath}`, '--file-local', `/opt/factory-bootstrap.sh=${bootstrapPath}`, '--yes', '--detach']);
        const readback = JSON.parse(await this.fly(['machine', 'list', '--app', this.state.plan.app, '--json'])).find(value => value.id === machine.id);
        if (readback?.config?.metadata?.['factory.bundle'] !== digest || readback.config.env.FACTORY_BOARD_MACHINE_ID !== this.state.machines[0].id) {
          throw new Error('Original Machine did not confirm the runtime update.');
        }
        return { machineId: machine.id, digest, state: readback.state };
      });
    }
    this.state.runtimeBundles = { ...this.state.runtimeBundles, ...Object.fromEntries(selected.map(machine => [machine.id, digest])) };
    if (selected.length === this.state.machines.length) this.state.bundleSha256 = digest;
    this.save(); return { updated: selected.length, digest };
  }
  async quiesce({ timeoutMs = 120000, attempt = 'default' } = {}) {
    if (!/^[a-z0-9-]{3,48}$/.test(attempt)) throw new Error('Select a stable stop attempt identity.');
    const inventory = agentInventory(this.state.plan);
    const initial = await this.request('/operator/status');
    const initialById = new Map(initial.agents.map(agent => [agent.id, agent]));
    const stopCommands = new Map();
    for (const agent of inventory) {
      const observed = initialById.get(agent.id)?.nativeRuntime;
      const target = nativeStopTarget(agent.id, observed);
      const commandId = `quiesce-${this.state.plan.runId}-${attempt}-${agent.id}`;
      stopCommands.set(agent.id, commandId);
      await this.command(agent.id, { id: commandId, action: 'stop', ...target });
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = await this.request('/operator/status');
      const byId = new Map(snapshot.agents.map(agent => [agent.id, agent]));
      const allStopped = snapshot.agents.length === inventory.length && inventory.every(expected => {
        const agent = byId.get(expected.id);
        const native = agent?.nativeRuntime;
        const receipt = native?.operatorStopReceipt;
        if (!native || !receipt || receipt.commandId !== stopCommands.get(expected.id) || receipt.threadId !== native.threadId
          || !['idle','archived'].includes(receipt.threadStatus) || !['idle','archived'].includes(native.threadStatus)
          || native.turnStatus === 'inProgress') return false;
        if (receipt.turnId && (receipt.turnId !== native.turnId || receipt.turnStatus !== native.turnStatus)) return false;
        const target = initialById.get(expected.id)?.nativeRuntime;
        if (!target || native.threadId !== target.threadId || (native.turnId ?? null) !== (target.turnId ?? null)) return false;
        if (receipt.turnId !== (target.turnId ?? undefined)) return false;
        if (target.turnStatus === 'inProgress') {
          if (!['completed','interrupted'].includes(native.turnStatus) || receipt.turnStatus !== native.turnStatus) return false;
        } else if (receipt.turnStatus !== target.turnStatus) return false;
        return true;
      });
      if (allStopped) {
        this.state.quiescedAt = new Date().toISOString(); this.save(); return { agents: inventory.length, quiescedAt: this.state.quiescedAt };
      }
      if (Date.now() >= deadline) throw new Error('Original agents have not all acknowledged stop; retain the live fleet and inspect its commands.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  async collect({ attempt = 'default', concurrency = 3, transferTimeoutMs = 7200000, includeGitObjects = true, machineIds } = {}) {
    if (!/^[a-z0-9-]{3,32}$/.test(attempt)) throw new Error('Select a stable collection attempt identity.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('Select 1 to 10 simultaneous Machine collections.');
    if (!Number.isSafeInteger(transferTimeoutMs) || transferTimeoutMs < 30000) throw new Error('Select a transfer timeout of at least 30 seconds.');
    if (typeof includeGitObjects !== 'boolean') throw new Error('Select whether to include Git object stores.');
    const selected = machineIds === undefined ? this.state.machines : this.state.machines.filter(machine => machineIds.includes(machine.id));
    if (machineIds !== undefined && (!Array.isArray(machineIds) || !machineIds.length || new Set(machineIds).size !== machineIds.length || selected.length !== machineIds.length)) throw new Error('Select original journal-owned Machine identities.');
    await this.quiesce({ attempt: `collection-${attempt}` });
    const artifacts = join(this.directory, 'artifacts'); mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    // Fly's exec endpoint can reject a large command while flyctl still exits
    // zero. Compress the embedded module before the two transport encodings.
    const collector = gzipSync(readFileSync(fileURLToPath(new URL('./collect.mjs', import.meta.url)))).toString('base64');
    const receipts = [...(this.state.artifacts ?? [])].filter(receipt => !selected.some(machine => machine.id === receipt.machineId)); const failures = []; let next = 0;
    const capture = async machine => {
      this.event('artifacts.started', { machineId: machine.id });
      const job = `/data/factory/collection-${this.state.plan.runId}-${attempt}.json`;
      const worker = `import {writeFileSync,renameSync} from 'node:fs'; import {gunzipSync} from 'node:zlib'; const save=value=>{writeFileSync('${job}.next',JSON.stringify({...value,includeGitObjects:${includeGitObjects}}),{mode:384});renameSync('${job}.next','${job}');}; try {const source=gunzipSync(Buffer.from('${collector}','base64')).toString('base64'); const {collectCloudLiteSnapshot}=await import('data:text/javascript;base64,'+source); const receipt=await collectCloudLiteSnapshot({runId:'${this.state.plan.runId}',includeGitObjects:${includeGitObjects}});save({state:'completed',...receipt});}catch(error){save({state:'failed',error:error.message});process.exitCode=1;}`;
      const launch = `const fs=require('node:fs'); const job='${job}'; if(fs.existsSync(job)){console.log(fs.readFileSync(job,'utf8'));}else{fs.writeFileSync(job,JSON.stringify({state:'preparing',includeGitObjects:${includeGitObjects}}),{flag:'wx',mode:384});const out=fs.openSync(job+'.log','a',384);const child=require('node:child_process').spawn(process.execPath,['--input-type=module','-e',Buffer.from('${Buffer.from(worker).toString('base64')}','base64').toString()],{detached:true,stdio:['ignore',out,out]});fs.writeFileSync(job,JSON.stringify({state:'running',pid:child.pid,includeGitObjects:${includeGitObjects}}),{mode:384});child.unref();fs.closeSync(out);console.log(fs.readFileSync(job,'utf8'));}`;
      // Dispatch only a durable detached job; Fly exec's observation timeout
      // must never be interpreted as permission to start another copy.
      try { await this.fly(['machine','exec',machine.id,`node -e "eval(Buffer.from('${Buffer.from(launch).toString('base64')}','base64').toString())"`,'--app',this.state.plan.app,'--timeout','30']); }
      catch { this.event('artifacts.dispatch_unknown', { machineId: machine.id, job }); }
      let receipt; let observationErrors = 0;
      for (;;) {
        const inspect = `const fs=require('node:fs');const value=fs.existsSync('${job}')?JSON.parse(fs.readFileSync('${job}','utf8')):{state:'missing'};if(value.state==='running'){try{process.kill(value.pid,0);}catch{value.state='missing';}}console.log(JSON.stringify(value));`;
        let raw;
        try { raw = await this.fly(['machine','exec',machine.id,`node -e "eval(Buffer.from('${Buffer.from(inspect).toString('base64')}','base64').toString())"`,'--app',this.state.plan.app,'--timeout','30']); observationErrors = 0; }
        catch {
          this.event('artifacts.observation_pending', { machineId: machine.id, job });
          if (++observationErrors >= 3) throw new Error(`Original collection observation remains pending at ${job}; retain its job identity.`);
          await new Promise(resolve => setTimeout(resolve, 30000)); continue;
        }
        const state = JSON.parse(raw.trim().split('\n').findLast(line => line.startsWith('{')));
        if (state.state === 'missing') throw new Error(`Original collection job is missing at ${job}; reconcile dispatch before retrying.`);
        if ((state.includeGitObjects ?? true) !== includeGitObjects) throw new Error('Original collection content differs; select a new explicit capture attempt.');
        if (state.state === 'completed') { receipt = state; break; }
        if (state.state !== 'running') throw new Error(`Original collection job is ${state.state}; inspect ${job} before selecting another attempt.`);
        this.event('artifacts.pending',{machineId:machine.id,job,pid:state.pid});
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
      this.event('artifacts.snapshot', { machineId: machine.id, ...receipt });
      const remote = receipt.archive;
      let destination = join(artifacts, `${machine.id}-${attempt}.tgz`);
      if (existsSync(destination) && statSync(destination).size !== receipt.bytes) {
        this.state.partialDownloads = [...(this.state.partialDownloads ?? []), { machineId: machine.id, file: destination, bytes: statSync(destination).size, expectedBytes: receipt.bytes }];
        this.save(); destination = join(artifacts, `${machine.id}-${attempt}-${secret()}.tgz`);
      }
      if (!existsSync(destination)) {
        this.event('artifacts.transfer_started', { machineId: machine.id, file: destination, expectedBytes: receipt.bytes });
        const progress = setInterval(() => this.event('artifacts.transfer_progress', { machineId: machine.id, bytes: existsSync(destination) ? statSync(destination).size : 0, expectedBytes: receipt.bytes }), 30000);
        try { await this.fly(['ssh', 'sftp', 'get', remote, destination, '--app', this.state.plan.app, '--machine', machine.id, '--quiet'], { timeoutMs: transferTimeoutMs }); }
        finally { clearInterval(progress); }
      }
      const digest = createHash('sha256'); for await (const bytes of createReadStream(destination)) digest.update(bytes);
      if (digest.digest('hex') !== receipt.sha256) throw new Error('Downloaded evidence differs from the original Machine archive.');
      receipts.push({ ...receipt, machineId: machine.id, file: destination });
      this.state.artifacts = receipts; this.save(); this.event('artifacts.collected', receipts.at(-1));
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      for (;;) { const machine = selected[next++]; if (!machine) return;
        try { await capture(machine); } catch (error) { const failure = { machineId: machine.id, error: error.message }; failures.push(failure); this.event('artifacts.failed', failure); }
      }
    }));
    if (failures.length) throw new Error(`Evidence collection incomplete: ${JSON.stringify(failures)}. Keep the original jobs and volumes.`);
    const complete = this.state.machines.every(machine => receipts.some(receipt => receipt.machineId === machine.id));
    if (complete) this.state.artifactsCollectedAt = new Date().toISOString(); this.save(); return { directory: artifacts, complete, collected: receipts.length, expected: this.state.machines.length };
  }
  async stop() {
    for (const machine of [...this.state.machines].reverse()) await this.stage(`${machine.id}.stop`, async () => {
      await this.fly(['machine', 'stop', machine.id, '--app', this.state.plan.app]); return { stopped: true, machineId: machine.id };
    });
    this.state.status = 'stopped'; this.save();
  }
  /** Quiesce original sessions, verify remote immutable evidence, then stop exactly the owned machines. */
  async verifiedShutdown({ attempt = 'final', timeoutMs = 120000, evidenceTimeoutMs = 300000, providerTimeoutMs = 120000, retire = false } = {}) {
    if(!this.state.plan.collection)throw new Error('Verified shutdown requires configured continuous evidence collection.');
    if(!Number.isSafeInteger(evidenceTimeoutMs)||evidenceTimeoutMs<1)throw new TypeError('Evidence timeout must be a positive integer.');
    // Sealed native runtimes cannot resume work. Reconcile the same stop intent after a lost provider acknowledgement.
    if(this.state.shutdownIntent && this.state.status!=='retired'){await this.recheckEvidence();await this.stopVerifiedResources({timeoutMs:providerTimeoutMs});}
    const expected=agentInventory(this.state.plan);
    const stopped=snapshot=>snapshot.agents.length===expected.length && expected.every(wanted=>{
      const agent=snapshot.agents.find(a=>a.id===wanted.id),native=agent?.nativeRuntime,receipt=native?.operatorStopReceipt;
      return receipt && receipt.threadId===native.threadId && ['idle','archived'].includes(native.threadStatus) && ['idle','archived'].includes(receipt.threadStatus)
        && native.turnStatus!=='inProgress' && (receipt.turnId??null)===(native.turnId??null) && (receipt.turnStatus??null)===(native.turnStatus??null);
    });
    if(this.state.status!=='stopped' && this.state.status!=='retired'){
      let snapshot=await this.request('/operator/status');
      if(!stopped(snapshot)){await this.quiesce({attempt,timeoutMs});snapshot=await this.request('/operator/status');}
      if(!stopped(snapshot))throw new Error('Native stop proof is incomplete. Preserve original machines.');
      const seal=await this.request('/operator/evidence-seal',{runId:this.state.plan.runId});
      if(!seal.sealed)throw new Error('Final collection seal is unconfirmed.');
      this.state.shutdownSessions=snapshot.agents.map(agent=>({agentId:agent.id,threadId:agent.nativeRuntime.threadId,stopId:agent.nativeRuntime.operatorStopReceipt.commandId}));this.save();
      const tokens=JSON.parse(readFileSync(join(this.directory,'evidence-credentials.json'))),deadline=Date.now()+evidenceTimeoutMs;
      const receipts=[];
      for(let index=0;index<this.state.plan.machines;index++){
        const machineId=`m${index}`,client=createEvidenceClient({url:this.state.plan.collection.url,token:tokens[machineId]});let receipt;
        for(;;){
          receipt=await client.latest();
          if(receipt?.checkpoint.final)break;
          if(Date.now()>=deadline)throw Object.assign(new Error(`Final evidence for ${machineId} is pending. Native work is stopped; preserve its volume and retry verifiedShutdown.`),{code:'EVIDENCE_PENDING'});
          await new Promise(accept=>setTimeout(accept,1000));
        }
        const checkpoint=receipt.checkpoint,sessions=this.state.shutdownSessions.filter(s=>s.agentId.startsWith(machineId+'-'));
        if(checkpoint.roots.length!==5 || ['workspaces','sessions','results','runtime','board'].some(name=>!checkpoint.roots.some(root=>root.name===name)))throw new Error('Final cloud evidence is missing a required capture root.');
        if(checkpoint.runId!==this.state.plan.runId || checkpoint.machineId!==machineId || checkpoint.sessions.length!==sessions.length
          || sessions.some(s=>!checkpoint.sessions.some(actual=>actual.agentId===s.agentId && actual.threadId===s.threadId && actual.stopId===s.stopId)))throw new Error('Final archive does not account for the original stopped sessions.');
        receipts.push(receipt);
      }
      const readback=await this.request('/operator/status');
      if(!stopped(readback) || this.state.shutdownSessions.some(s=>{const native=readback.agents.find(a=>a.id===s.agentId)?.nativeRuntime;return native?.threadId!==s.threadId || native.operatorStopReceipt?.commandId!==s.stopId;}))throw new Error('Sessions changed while evidence was being verified. Preserve the fleet.');
      this.state.verifiedEvidence={verifiedAt:new Date().toISOString(),receipts};this.save();
      const owned=JSON.parse(await this.fly(['machine','list','--app',this.state.plan.app,'--json']));
      if(owned.length!==this.state.machines.length || this.state.machines.some(machine=>!owned.some(m=>m.id===machine.id && m.config?.metadata?.['factory.run']===this.state.plan.runId && m.config?.mounts?.some(mount=>mount.volume===machine.volumeId))))throw new Error('Provider ownership changed; preserve resources.');
      this.state.shutdownIntent={createdAt:new Date().toISOString(),evidence:this.state.verifiedEvidence.receipts.map(receipt=>receipt.digest)};this.save();
      await this.stopVerifiedResources({timeoutMs:providerTimeoutMs});
    }
    if(this.state.status!=='retired'){
      const machines=JSON.parse(await this.fly(['machine','list','--app',this.state.plan.app,'--json']));
      if(machines.length!==this.state.machines.length || this.state.machines.some(owned=>!machines.some(m=>m.id===owned.id && m.state==='stopped' && m.config?.metadata?.['factory.run']===this.state.plan.runId && m.config?.mounts?.some(mount=>mount.volume===owned.volumeId))))throw new Error('Provider has not confirmed all original machines stopped.');
      this.state.shutdownVerifiedAt=new Date().toISOString();this.save();
      if(retire)await this.retire();
    }
    return {status:this.state.status,shutdownVerifiedAt:this.state.shutdownVerifiedAt,evidence:this.state.verifiedEvidence};
  }
  async recheckEvidence(){
    if(this.state.verifiedEvidence?.receipts?.length!==this.state.plan.machines)throw new Error('Incomplete verified evidence census.');
    const tokens=JSON.parse(readFileSync(join(this.directory,'evidence-credentials.json')));
    for(const expected of this.state.verifiedEvidence.receipts){
      const actual=await createEvidenceClient({url:this.state.plan.collection.url,token:tokens[expected.checkpoint.machineId]}).latest();
      if(!actual?.checkpoint.final || actual.digest!==expected.digest)throw new Error('Retained final evidence changed or is missing. Preserve owned volumes.');
    }
  }
  async stopVerifiedResources({timeoutMs=120000}={}){
    if(!this.state.shutdownIntent)throw new Error('A verified native/evidence stop intent is required.');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new TypeError('Provider confirmation timeout must be positive.');
    const owned=inventory=>inventory.length===this.state.machines.length && this.state.machines.every(machine=>inventory.some(m=>m.id===machine.id && m.config?.metadata?.['factory.run']===this.state.plan.runId && m.config?.mounts?.some(mount=>mount.volume===machine.volumeId)));
    const readback=async()=>{
      let inventory;
      try{inventory=JSON.parse(await this.fly(['machine','list','--app',this.state.plan.app,'--json']));}
      catch(cause){throw Object.assign(new Error('Provider state is unconfirmed; retain the original stop intent.',{cause}),{code:'SHUTDOWN_PENDING'});}
      if(!owned(inventory))throw new Error('Provider ownership changed; preserve resources.');return inventory;
    };
    const inventory=await readback();
    for(const machine of [...this.state.machines].reverse()){
      if(!['stopped','stopping'].includes(inventory.find(m=>m.id===machine.id).state)){
        try{await this.fly(['machine','stop',machine.id,'--app',this.state.plan.app]);}
        catch{this.event('shutdown.stop_unconfirmed',{machineId:machine.id});}
      }
    }
    const deadline=Date.now()+timeoutMs;
    for(;;){
      try{if((await readback()).every(machine=>machine.state==='stopped'))break;}
      catch(error){if(error.code!=='SHUTDOWN_PENDING')throw error;}
      if(Date.now()>=deadline)throw Object.assign(new Error('Provider shutdown remains unconfirmed; retain the original stop intent.'),{code:'SHUTDOWN_PENDING'});
      await new Promise(accept=>setTimeout(accept,Math.min(2000,deadline-Date.now())));
    }
    this.state.status='stopped';this.state.shutdownVerifiedAt=new Date().toISOString();this.save();
  }
  /** Run this supervisor in a durable host process. No implicit duration or model calls. */
  async supervise({ shouldStop, signal, intervalMs = 15000, ...shutdownOptions } = {}) {
    if(!this.state.plan.collection || !this.state.plan.shutdown && typeof shouldStop!=='function' && !signal)throw new Error('Configure collection and an explicit completion predicate, deadline or abort signal.');
    if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw new TypeError('Supervisor interval must be at least 1000 ms.');
    for(;;){
      try{
        if(this.state.shutdownIntent)return await this.verifiedShutdown(shutdownOptions);
        const snapshot=await this.observe();
        if(signal?.aborted || this.state.plan.shutdown && Date.now()>=Date.parse(this.state.plan.shutdown.deadlineUtc) || shouldStop && await shouldStop(snapshot))return await this.verifiedShutdown(shutdownOptions);
      }catch(error){if(!['EVIDENCE_PENDING','SHUTDOWN_PENDING'].includes(error.code)||signal?.aborted)throw error;this.event('shutdown.pending',{error:error.message});}
      await new Promise(accept=>{const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);accept();};const timer=setTimeout(finish,intervalMs);signal?.addEventListener('abort',finish,{once:true});});
    }
  }
  async retire() {
    if(this.state.plan.collection && (!this.state.shutdownVerifiedAt || !this.state.verifiedEvidence?.receipts?.length))throw new Error('Verify final archive receipts and provider shutdown before retiring continuous-collection volumes.');
    if(this.state.plan.collection && this.state.status!=='retired')await this.recheckEvidence();
    if (this.state.operations['app.retire']?.state !== 'succeeded') {
      const inventory = JSON.parse(await this.fly(['machine', 'list', '--app', this.state.plan.app, '--json']));
      const volumes = JSON.parse(await this.fly(['volumes', 'list', '--app', this.state.plan.app, '--json']));
      if (inventory.length !== this.state.machines.length || inventory.some(value => !this.state.machines.some(machine =>
        machine.id === value.id && machine.name === value.name && value.config?.metadata?.['factory.run'] === this.state.plan.runId && value.config?.mounts?.some(mount => mount.volume === machine.volumeId))) ||
        volumes.length !== this.state.machines.length || volumes.some(value => !this.state.machines.some(machine => machine.volumeId === value.id))) {
        throw new Error('Retirement requires the exact original Machine and volume inventory; retain resources whose ownership differs.');
      }
    }
    await this.stage('app.retire', async () => { await this.fly(['apps', 'destroy', this.state.plan.app, '--yes']); return { app: this.state.plan.app, retired: true }; });
    this.state.status = 'retired'; this.save();
  }
}
