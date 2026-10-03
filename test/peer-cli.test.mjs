import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PeerStore, wireBytes } from '../src/peer-messaging.mjs';
const nativeModule = process.env.FACTORY_PEER_PRIVATE_TEST_MODULE ?? 'C:/Users/Moe/Documents/GitHub/flujo-cloud/lib/private-files.mjs';
const CLI = fileURLToPath(new URL('../bin/peer.mjs', import.meta.url));
async function run(arguments_, input, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)));
  const child = spawn(process.execPath, [CLI, ...arguments_], { env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [], err = []; let count = 0;
  for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', bytes => { count += bytes.length; if (count > 65536) child.kill(); else chunks.push(bytes); });
  const timer = setTimeout(() => child.kill(), 30000);
  child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  const code = await new Promise(resolve => child.once('close', resolve)); clearTimeout(timer);
  return { code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}
test('actual CLI bootstrap restart preserves original pair and supports private advisory export', { timeout: 90000 }, async t => {
  const available = await fs.access(nativeModule).then(() => true, () => false);
  if (!available) { t.skip('Explicit owner-private helper not installed; set FACTORY_PEER_PRIVATE_TEST_MODULE'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-peer-cli-'));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'factory-peer-cli-')); await fs.rm(directory, { recursive: true, force: true }); });
  const privateDirectory = path.join(directory, 'private'), now = Date.now();
  const request = { a: { identity: { factoryId: 'alpha', cellId: 'dev' }, endpoint: 'http://127.0.0.1:4351/v1/peer/messages' },
    b: { identity: { factoryId: 'beta', cellId: 'watch' }, endpoint: 'http://127.0.0.1:4352/v1/peer/messages' }, generation: 1, credentialExpiresAt: now + 3600000,
    bootstrapPath: path.join(privateDirectory, 'bootstrap.private.json'), configAPath: path.join(privateDirectory, 'config-a.private.json'), configBPath: path.join(privateDirectory, 'config-b.private.json') };
  const aliased = { ...request, configBPath: process.platform === 'win32' ? path.join(privateDirectory, 'CONFIG-A.PRIVATE.JSON') : request.configAPath };
  const rejected = await run(['pair', '--private-module', nativeModule], aliased);
  assert.equal(rejected.code, 1);
  assert.equal(await fs.access(privateDirectory).then(() => true, () => false), false);
  const fixture = fileURLToPath(new URL('../fixtures/peer-bootstrap-private.mjs', import.meta.url));
  const interrupted = await run(['pair', '--private-module', fixture], request, { PEER_PRIVATE_TEST_MODULE: nativeModule });
  assert.equal(interrupted.code, 92); assert.equal(interrupted.stdout, '');
  const files = await import(pathToFileURL(nativeModule).href);
  const intent = await files.readPrivateJson(request.bootstrapPath), a = await files.readPrivateJson(request.configAPath);
  assert.ok(a.key === intent.configs.a.key); assert.equal(await fs.access(request.configBPath).then(() => true, () => false), false);
  const before = createHash('sha256').update(await fs.readFile(request.configAPath)).digest('hex');
  const resumed = await run(['pair', '--private-module', nativeModule], request);
  assert.equal(resumed.code, 0); assert.equal(JSON.parse(resumed.stdout).configured, true);
  const b = await files.readPrivateJson(request.configBPath);
  assert.ok(a.key === b.key && b.key === intent.configs.b.key);
  assert.ok(!resumed.stdout.includes(a.key) && !resumed.stderr.includes(a.key));
  assert.equal(createHash('sha256').update(await fs.readFile(request.configAPath)).digest('hex'), before);
  const mismatch = await run(['pair', '--private-module', nativeModule], { ...request, generation: 2 });
  assert.equal(mismatch.code, 1); assert.ok(!mismatch.stderr.includes(a.key));
  const database = path.join(privateDirectory, 'advisory.sqlite');
  const store = new PeerStore(database, { config: b });
  store.receiveEnvelope({ schemaVersion: 1, protocol: 'factory-peer-advisory-v1', messageId: 'observation', sender: a.local, recipient: b.local,
    type: 'health_observation', createdAt: now, expiresAt: now + 600000,
    provenance: { taskId: null, attempt: null, ownerEpoch: null, policyRevision: null, observedAt: null, causalParent: null }, payload: { state: 'observed' } }); store.close();
  const exported = path.join(privateDirectory, 'observation.private.json');
  const result = await run(['read', '--private-module', nativeModule, '--config', request.configBPath, '--database', database, '--message-id', 'observation', '--output', exported]);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).exported, true);
  assert.ok(!result.stdout.includes('observed') && !result.stdout.includes(a.key));
  const envelope = await files.readPrivateJson(exported); assert.equal(envelope.payload.state, 'observed');
  assert.ok(wireBytes(envelope).length < 65536);
});
