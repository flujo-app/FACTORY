#!/usr/bin/env node
/** Isolated native-image snapshot fixture; never a controller or provider initializer. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const JSZip = require('/app/node_modules/jszip');
process.umask(0o077);
const DATA = '/data', FIXTURE = '/fixture', ROOT = DATA + '/flujo/workspaces';
const PREPARATION = FIXTURE + '/native-preparation.private.json';
const SERVER = 'snapshot-fixture', TOOL = 'fixture_probe', SCHEDULE = 'snapshot-dormant-schedule';
const SERVER_URL = 'http://127.0.0.1:3003/mcp';
const MODEL_FILE = 'db/models.json', MCP_FILE = 'db/mcp_servers.json', FLOW_FILE = 'db/flows/factory-service-flow.json';
const SCHEDULE_FILE = 'db/planned_executions.json', STATE_FILE = 'db/planned-execution-state/' + SCHEDULE + '.json';
const MAX_FILE = 16 * 1024 * 1024, MAX_ARCHIVE = 64 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const digest = value => sha(canonical(value));
const command = process.argv[2];
let stage = 'admission';

function exact(value, keys) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
async function directory(filename) {
  const s = await fs.lstat(filename);
  assert.ok(s.isDirectory() && !s.isSymbolicLink());
  assert.equal(s.uid, process.getuid());
  assert.equal(s.gid, process.getgid());
  assert.equal(s.mode & 0o077, 0);
}
async function read(filename, maximum = MAX_FILE) {
  const s = await fs.lstat(filename);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= maximum);
  assert.equal(s.uid, process.getuid());
  assert.equal(s.gid, process.getgid());
  assert.equal(s.mode & 0o077, 0);
  const h = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await h.stat();
    assert.ok(opened.isFile() && opened.dev === s.dev && opened.ino === s.ino && opened.size === s.size);
    assert.equal(opened.uid, process.getuid()); assert.equal(opened.gid, process.getgid());
    assert.equal(opened.mode & 0o077, 0); assert.equal(opened.nlink, 1);
    const b = await h.readFile();
    assert.equal(b.length, s.size);
    assert.ok(b.length <= maximum);
    return b;
  } finally { await h.close(); }
}
async function json(filename) { return JSON.parse((await read(filename)).toString('utf8')); }
async function optionalJson(filename) {
  try { return await json(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function publish(filename, bytes, previous = null) {
  await directory(path.dirname(filename));
  if (previous === null) {
    const h = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
    assert.equal(sha(await read(filename, MAX_ARCHIVE * 2)), sha(bytes));
    return;
  }
  assert.equal(sha(await read(filename, MAX_ARCHIVE * 2)), previous);
  const temporary = path.join(path.dirname(filename), '.native-fixture-' + randomUUID());
  const h = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
  assert.equal(sha(await read(filename, MAX_ARCHIVE * 2)), previous);
  await fs.rename(temporary, filename);
  assert.equal(sha(await read(filename, MAX_ARCHIVE * 2)), sha(bytes));
}
function base64(value, size) {
  assert.ok(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value));
  const b = Buffer.from(value, 'base64');
  assert.equal(b.toString('base64'), value);
  if (size !== undefined) assert.equal(b.length, size);
  return b;
}
function secrets(value) {
  exact(value, ['token', 'key', 'worker', 'flow', 'operation']);
  assert.match(value.token, /^[a-f0-9]{64}$/);
  assert.match(value.operation, /^[a-f0-9-]{36}$/);
  base64(value.key, 32).fill(0);
  exact(value.worker, ['workspace', 'archiveSha256', 'compatibility']);
  assert.equal(value.worker.workspace, 'factory-service-smoke');
  assert.match(value.worker.archiveSha256, /^[a-f0-9]{64}$/);
  const c = value.worker.compatibility;
  exact(c, ['applicationVersion', 'snapshotFormatVersion', 'layoutVersion', 'workerProtocolVersion', 'revision']);
  assert.equal(c.applicationVersion, '3.46.2');
  assert.equal(c.snapshotFormatVersion, 2); assert.equal(c.layoutVersion, 2); assert.equal(c.workerProtocolVersion, 1);
  assert.equal(c.revision, '549792e1839931e862e6a305eb0d9ce2b82ae905');
  assert.equal(value.flow.id, 'factory-service-flow');
  assert.ok(Array.isArray(value.flow.nodes) && Array.isArray(value.flow.edges));
  return value;
}
function decrypt(bytes, keyString) {
  const v = JSON.parse(bytes.toString('utf8'));
  exact(v, ['format', 'version', 'iv', 'tag', 'data']);
  assert.equal(v.format, 'flujo-workspace-encrypted'); assert.equal(v.version, 1);
  const key = base64(keyString, 32), iv = base64(v.iv, 12), tag = base64(v.tag, 16), data = base64(v.data);
  assert.ok(data.length <= MAX_ARCHIVE);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  } finally { key.fill(0); }
}
function encrypt(bytes, keyString) {
  const key = base64(keyString, 32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv), data = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.from(JSON.stringify({ format: 'flujo-workspace-encrypted', version: 1,
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  } finally { key.fill(0); }
}
async function archive(bytes) {
  assert.ok(bytes.length <= MAX_ARCHIVE);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const entries = Object.values(zip.files);
  assert.ok(entries.length <= 512);
  for (const e of entries) {
    assert.ok(!e.name.startsWith('/') && !e.name.includes('\\') && !e.name.split('/').includes('..'));
    assert.ok(!e.unsafeOriginalName || e.unsafeOriginalName === e.name);
    const mode = typeof e.unixPermissions === 'number' ? e.unixPermissions : 0;
    assert.ok(!(mode & 0o170000) || (mode & 0o170000) === (e.dir ? 0o040000 : 0o100000));
  }
  const manifest = JSON.parse(await zip.file('snapshot-manifest.json').async('string'));
  assert.equal(manifest.formatVersion, 2); assert.equal(manifest.layoutVersion, 2);
  assert.equal(manifest.workspace, 'factory-service-smoke'); assert.equal(manifest.externalRootsIncluded, false);
  assert.equal(manifest.source.version, '3.46.2'); assert.equal(manifest.source.platform, 'linux');
  assert.equal(manifest.runtime.codexAuth, 'none'); assert.equal(manifest.runtime.encryption, 'default');
  const declared = new Map(); let total = 0;
  for (const row of manifest.files) {
    assert.ok(typeof row.path === 'string' && !declared.has(row.path));
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= MAX_FILE);
    assert.match(row.sha256, /^[a-f0-9]{64}$/); declared.set(row.path, row);
    const member = zip.file(row.path); assert.ok(member && !member.dir);
    const b = await member.async('nodebuffer'); assert.equal(b.length, row.size); assert.equal(sha(b), row.sha256);
    total += b.length; assert.ok(total <= MAX_ARCHIVE);
  }
  assert.deepEqual(entries.filter(e => !e.dir && e.name !== 'snapshot-manifest.json').map(e => e.name).sort(), [...declared.keys()].sort());
  return { zip, manifest, total };
}
async function zipJson(zip, filename) { const e = zip.file(filename); assert.ok(e); return JSON.parse(await e.async('string')); }
function fixtureMcp(workspaceRoot) {
  // Storage keys carry server names. This explicitly public, synthetic header is
  // the real non-secret MCPHeaderValue shape, so save/load can preserve it exactly.
  return { transport: 'streamable', serverUrl: SERVER_URL, source: { type: 'remote' },
    headers: { Authorization: { value: 'Bearer synthetic-snapshot-mcp-only', metadata: { isSecret: false } } }, disabled: false, env: {}, roots: [],
    rootPath: workspaceRoot + '/mcp-servers/' + sha(SERVER).slice(0, 24) };
}
function fixtureSchedule(flowId) {
  const old = '2000-01-01T00:00:00.000Z';
  return { version: 1, paused: false, executions: [{ id: SCHEDULE, generationId: 'snapshot-fixture-generation',
    name: 'Dormant worker schedule fixture', enabled: true, flowId, prompt: 'Synthetic snapshot schedule must remain dormant on workers.',
    saveConversations: true, approvalPolicy: 'fail', trigger: { type: 'schedule', cron: '* * * * * *', timezone: 'UTC', catchUp: true },
    createdAt: old, updatedAt: old }] };
}
async function prepareSource() {
  stage = 'prepare-source'; await directory(DATA); await directory(FIXTURE);
  assert.equal(await optionalJson(PREPARATION), null);
  const sourceRaw = await read(FIXTURE + '/secrets.private.json'), s = secrets(JSON.parse(sourceRaw));
  const snapshot = await read(DATA + '/worker.snapshot', MAX_ARCHIVE * 2), plain = decrypt(snapshot, s.key);
  assert.equal(sha(plain), s.worker.archiveSha256);
  const { zip, manifest } = await archive(plain);
  assert.deepEqual(await zipJson(zip, FLOW_FILE), s.flow); assert.deepEqual(await zipJson(zip, MCP_FILE), {});
  assert.equal(zip.file(SCHEDULE_FILE), null); assert.equal(zip.file(STATE_FILE), null);
  const beforeFlow = structuredClone(s.flow), workspaceRoot = ROOT + '/' + s.worker.workspace;
  const flow = structuredClone(beforeFlow);
  assert.equal(flow.nodes.length, 3); assert.equal(flow.edges.length, 2);
  assert.ok(!flow.nodes.some(n => n.id === 'snapshot-mcp'));
  flow.nodes.push({ id: 'snapshot-mcp', type: 'mcp', position: { x: 400, y: 400 },
    data: { type: 'mcp', label: 'Configured snapshot fixture', properties: { boundServer: SERVER, enabledTools: [TOOL] } } });
  assert.deepEqual(flow.edges, beforeFlow.edges); assert.deepEqual(flow.nodes.slice(0, 3), beforeFlow.nodes);
  const schedule = fixtureSchedule(flow.id), state = { lastScheduledFireAt: '2000-01-01T00:00:00.000Z' };
  for (const [filename, value] of [[FLOW_FILE, flow], [MCP_FILE, { [SERVER]: fixtureMcp(workspaceRoot) }], [SCHEDULE_FILE, schedule], [STATE_FILE, state]]) {
    zip.file(filename, JSON.stringify(value), { unixPermissions: 0o100600 });
  }
  manifest.runtime.mcpTransfer = { formatVersion: 1, sourceWorkspaceRoot: workspaceRoot,
    servers: [{ name: SERVER, kind: 'remote', sourceRootPath: fixtureMcp(workspaceRoot).rootPath }] };
  manifest.runtime.selectedFlowIds = [flow.id];
  manifest.files = [];
  for (const filename of Object.keys(zip.files).filter(n => !zip.files[n].dir && n !== 'snapshot-manifest.json').sort()) {
    const b = await zip.file(filename).async('nodebuffer'); manifest.files.push({ path: filename, size: b.length, sha256: sha(b) });
  }
  zip.file('snapshot-manifest.json', JSON.stringify(manifest), { unixPermissions: 0o100600 });
  const prepared = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await archive(prepared);
  const worker = { ...s.worker, archiveSha256: sha(prepared) }, envelope = encrypt(prepared, s.key);
  const record = { format: 'container-source-native-preparation', schemaVersion: 1, operation: s.operation,
    originalArchiveSha256: s.worker.archiveSha256, originalEnvelopeSha256: sha(snapshot), preparedEnvelopeSha256: sha(envelope),
    worker, flowSha256: digest(flow), originalProcessPathSha256: digest({ nodes: beforeFlow.nodes, edges: beforeFlow.edges }),
    scheduleSha256: sha(JSON.stringify(schedule)), stateSha256: sha(JSON.stringify(state)), server: SERVER, tool: TOOL,
    modelSha256: sha(await zip.file(MODEL_FILE).async('nodebuffer')), authorityMountRequired: false };
  // Deliberately only these two already-owned fixture files are replaced before source boot.
  await publish(DATA + '/worker.snapshot', envelope, sha(snapshot));
  await publish(FIXTURE + '/secrets.private.json', Buffer.from(JSON.stringify({ ...s, worker, flow })), sha(sourceRaw));
  await publish(PREPARATION, Buffer.from(JSON.stringify(record)));
  plain.fill(0); prepared.fill(0); envelope.fill(0);
  return { prepared: true, operation: s.operation, worker, flowSha256: digest(flow), scheduleId: SCHEDULE,
    server: SERVER, tool: TOOL, scope: 'Inert isolated snapshot configuration; no Flow/model/tool execution or authority mutation.' };
}
async function filesBelow(directoryPath) {
  const items = []; let pending = [directoryPath];
  while (pending.length) {
    const current = pending.pop(); let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink()); const filename = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(filename); else { assert.ok(entry.isFile()); items.push(filename); }
      assert.ok(items.length + pending.length <= 512);
    }
  }
  return items;
}
function storedMcp(value, captured = false) {
  exact(value, [SERVER]); const c = value[SERVER];
  if (!captured) return value;
  // Selected-flow capture deliberately serializes the resolved config with
  // name; ordinary MCP storage drops name because the record key already binds it.
  assert.equal(c.name, SERVER);
  const { name: _, ...stored } = c;
  return { [SERVER]: stored };
}
function checkMcp(value, workspaceRoot, captured = false) {
  const stored = storedMcp(value, captured);
  assert.deepEqual(stored[SERVER], fixtureMcp(workspaceRoot));
  return digest(stored[SERVER]);
}
async function inspectCapture() {
  stage = 'inspect-capture'; const s = secrets(await json(FIXTURE + '/secrets.private.json'));
  const prepared = await json(PREPARATION), raw = await read(FIXTURE + '/captured.zip', MAX_ARCHIVE);
  const { zip, manifest, total } = await archive(raw);
  assert.equal(prepared.operation, s.operation); assert.deepEqual(prepared.worker, s.worker);
  assert.deepEqual(await zipJson(zip, FLOW_FILE), s.flow);
  assert.deepEqual(await zipJson(zip, SCHEDULE_FILE), fixtureSchedule(s.flow.id));
  assert.equal(sha(await zip.file(SCHEDULE_FILE).async('nodebuffer')), prepared.scheduleSha256);
  assert.equal(sha(await zip.file(STATE_FILE).async('nodebuffer')), prepared.stateSha256);
  assert.equal(sha(await zip.file(MODEL_FILE).async('nodebuffer')), prepared.modelSha256);
  assert.deepEqual(manifest.runtime.selectedFlowIds, [s.flow.id]);
  const plan = manifest.runtime.mcpTransfer; assert.equal(plan.formatVersion, 1);
  assert.equal(plan.sourceWorkspaceRoot, ROOT + '/' + s.worker.workspace);
  assert.deepEqual(plan.servers.map(e => ({ name: e.name, kind: e.kind })), [{ name: SERVER, kind: 'remote' }]);
  const mcp = await zipJson(zip, MCP_FILE), mcpSha256 = checkMcp(mcp, ROOT + '/' + s.worker.workspace, true);
  const models = await zipJson(zip, MODEL_FILE); assert.equal(models.length, 1);
  assert.equal(models[0].id, 'fixture'); assert.equal(models[0].provider, 'openai'); assert.equal(models[0].adapter, 'openai');
  assert.equal(models[0].baseUrl, 'http://127.0.0.1:3001/v1');
  const forbiddenNames = /(^|\/)(?:control\.sqlite|paid\.sqlite|spending\.sqlite|profile\.private\.json|secrets\.private\.json|restore-secrets\.private\.json|worker\.snapshot|worker-bootstrap-secrets\.json|auth\.json)$/;
  for (const e of Object.values(zip.files).filter(e => !e.dir)) {
    assert.ok(!forbiddenNames.test(e.name) && !e.name.startsWith('authority/'));
    const bytes = await e.async('nodebuffer'); assert.equal(bytes.includes(Buffer.from(s.token)), false);
    assert.equal(bytes.includes(Buffer.from(s.key)), false);
  }
  assert.equal(Object.keys(zip.files).filter(n => /^db\/conversations\/.+/.test(n) && !zip.files[n].dir).length, 0);
  assert.equal(Object.keys(zip.files).filter(n => /^db\/planned-execution-runs\/.+/.test(n) && !zip.files[n].dir).length, 0);
  return { captureInspected: true, operation: s.operation, archiveSha256: sha(raw), archiveBytes: raw.length,
    manifestFiles: manifest.files.length, memberBytes: total, workspace: manifest.workspace, generation: manifest.generation,
    selectedFlowIds: manifest.runtime.selectedFlowIds, flowSha256: digest(s.flow), modelSha256: sha(await zip.file(MODEL_FILE).async('nodebuffer')),
    mcpSha256, mcpFileSha256: sha(await zip.file(MCP_FILE).async('nodebuffer')),
    scheduleSha256: sha(await zip.file(SCHEDULE_FILE).async('nodebuffer')), stateSha256: prepared.stateSha256,
    sourceBootstrapSecretsExcluded: true, controllerAuthorityExcluded: true, conversations: 0, scheduleRuns: 0,
    scope: 'Actual captured ZIP configuration and exclusion inspection; source capture/finalize HTTP receipts belong to the caller.' };
}
async function inspectWorkspace(restored) {
  stage = restored ? 'inspect-restore' : 'inspect-source';
  const original = secrets(await json(FIXTURE + '/secrets.private.json'));
  const s = restored ? secrets(await json(FIXTURE + '/restore-secrets.private.json')) : original;
  const prepared = await json(PREPARATION); assert.equal(prepared.operation, s.operation);
  const root = ROOT + '/' + s.worker.workspace; await directory(root);
  if (restored) { assert.notEqual(s.token, original.token); assert.notEqual(s.key, original.key); }
  const marker = await json(root + '/.flujo-worker-snapshot.json');
  exact(marker, ['formatVersion', 'workspace', 'archiveSha256']); assert.equal(marker.formatVersion, 1);
  assert.equal(marker.workspace, s.worker.workspace); assert.equal(marker.archiveSha256, s.worker.archiveSha256);
  const flowRaw = await read(root + '/' + FLOW_FILE), modelsRaw = await read(root + '/' + MODEL_FILE), mcpRaw = await read(root + '/' + MCP_FILE);
  assert.deepEqual(JSON.parse(flowRaw), s.flow); assert.equal(digest(s.flow), prepared.flowSha256);
  const models = JSON.parse(modelsRaw); assert.equal(models.length, 1); assert.equal(models[0].id, 'fixture');
  assert.equal(sha(modelsRaw), prepared.modelSha256);
  assert.equal(models[0].provider, 'openai'); assert.equal(models[0].adapter, 'openai'); assert.equal(models[0].baseUrl, 'http://127.0.0.1:3001/v1');
  const mcpSha256 = checkMcp(JSON.parse(mcpRaw), root);
  const scheduleRaw = await read(root + '/' + SCHEDULE_FILE), stateRaw = await read(root + '/' + STATE_FILE);
  assert.equal(sha(scheduleRaw), prepared.scheduleSha256); assert.equal(sha(stateRaw), prepared.stateSha256);
  assert.deepEqual(JSON.parse(scheduleRaw), fixtureSchedule(s.flow.id));
  const conversations = await filesBelow(root + '/db/conversations'), runs = await filesBelow(root + '/db/planned-execution-runs');
  assert.equal(conversations.length, 0); assert.equal(runs.length, 0);
  const bootstrapSecretFile = await optionalJson(root + '/db/worker-bootstrap-secrets.json'); assert.equal(bootstrapSecretFile, null);
  if (restored) {
    const capture = await inspectCapture(); assert.equal(capture.archiveSha256, s.worker.archiveSha256);
    const { zip } = await archive(await read(FIXTURE + '/captured.zip', MAX_ARCHIVE));
    assert.deepEqual(JSON.parse(modelsRaw), await zipJson(zip, MODEL_FILE));
    assert.deepEqual(JSON.parse(mcpRaw), storedMcp(await zipJson(zip, MCP_FILE), true));
    assert.deepEqual(JSON.parse(flowRaw), await zipJson(zip, FLOW_FILE));
    const decrypted = decrypt(await read(DATA + '/worker.snapshot', MAX_ARCHIVE * 2), s.key);
    assert.equal(sha(decrypted), s.worker.archiveSha256); decrypted.fill(0);
  }
  return { inspected: true, restored, operation: s.operation, worker: s.worker, flowSha256: digest(s.flow),
    modelSha256: sha(modelsRaw), mcpSha256, mcpFileSha256: sha(mcpRaw),
    scheduleSha256: sha(scheduleRaw), stateSha256: sha(stateRaw),
    conversations: 0, scheduleRuns: 0, scheduleEnabled: true, schedulePaused: false,
    workerBootstrapSecretFileAbsent: true, ...(restored ? { freshBootstrapSecrets: true, capturedConfigurationPreserved: true } : {}),
    observedAt: new Date().toISOString(), scope: 'Filesystem configuration and dormant schedule observation; no authority, Flow, model or MCP tool invocation.' };
}
async function launchRestore() {
  stage = 'launch-restore'; const s = secrets(await json(FIXTURE + '/restore-secrets.private.json'));
  const original = secrets(await json(FIXTURE + '/secrets.private.json'));
  assert.equal(s.operation, original.operation); assert.notEqual(s.token, original.token); assert.notEqual(s.key, original.key);
  const raw = await read(FIXTURE + '/captured.zip', MAX_ARCHIVE); assert.equal(sha(raw), s.worker.archiveSha256);
  await archive(raw); raw.fill(0);
  Object.assign(process.env, { FLUJO_WORKER_MODE: '1', FLUJO_WORKER_SNAPSHOT: DATA + '/worker.snapshot',
    FLUJO_WORKER_SNAPSHOT_SHA256: s.worker.archiveSha256, FLUJO_WORKER_SNAPSHOT_KEY: s.key,
    FLUJO_SNAPSHOT_CONTROL_TOKEN: s.token, FLUJO_DATA_DIR: DATA + '/flujo', FLUJO_APP_ROOT: '/app',
    FLUJO_PORT: '4300', FLUJO_BASE_URL: 'http://127.0.0.1:4300', FLUJO_EXPOSURE_MODE: 'localhost',
    FLUJO_MCP_APP_SANDBOX_PORT: '4301', FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' });
  process.argv = [process.execPath, '/app/scripts/launch-next.mjs', 'start', '-p', '4300', '-H', '127.0.0.1'];
  await import('/app/scripts/launch-next.mjs');
}
try {
  assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000); assert.equal(process.versions.node.split('.')[0], '22');
  assert.equal(process.argv.length, 3);
  assert.ok(['prepare-source', 'inspect-source', 'inspect-capture', 'inspect-restore', 'launch-restore'].includes(command));
  let result;
  switch (command) {
    case 'prepare-source': result = await prepareSource(); break;
    case 'inspect-source': result = await inspectWorkspace(false); break;
    case 'inspect-capture': result = await inspectCapture(); break;
    case 'inspect-restore': result = await inspectWorkspace(true); break;
    case 'launch-restore': await launchRestore(); break;
  }
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: 'CONTAINER_SOURCE_NATIVE_FAILED', command, stage, code: error.code ?? null }) + '\n');
  process.exitCode = 1;
}
