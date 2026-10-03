import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { PeerStore, createPairConfigurations } from '../src/peer-messaging.mjs';
import * as privateFiles from '../deploy/private-files.mjs';
import { createManagedCloudAdapter } from '../src/adapters/managed-cloud.mjs';

const CLI = fileURLToPath(new URL('../bin/capacity.mjs', import.meta.url));
const HELPER = fileURLToPath(new URL('../deploy/private-files.mjs', import.meta.url));
const VENDOR = fileURLToPath(new URL('../deploy/managed-cloud/', import.meta.url));
const MODULE = path.join(VENDOR,'lib','managed.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const compatibility = { applicationVersion:'3.46.0',snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1,
  revision:'549792e1839931e862e6a305eb0d9ce2b82ae905' };

async function child(args) {
  const proc = spawn(process.execPath,[CLI,...args],{ windowsHide:true,stdio:['ignore','pipe','pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', bytes => { stdout += bytes; }); proc.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise((resolve,reject) => {
    proc.once('error',reject); proc.once('close',(code,signal) => resolve({ code,signal,stdout,stderr }));
  });
  return Promise.race([closed,delay(45000,undefined,{ ref:false }).then(() => {
    proc.kill('SIGTERM'); throw new Error('Capacity startup did not close');
  })]);
}
async function permissions(filename) {
  if (process.platform !== 'win32') for (const suffix of ['','-wal','-shm'])
    await fs.chmod(filename+suffix,0o600).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'factory-capacity-startup-'));
  await privateFiles.ensurePrivateDirectory(dir);
  const p = name => path.join(dir,name);
  t.after(async() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'factory-capacity-startup-'));
    await fs.rm(dir,{ recursive:true,force:true });
  });
  const pair = createPairConfigurations({ a:{ identity:{ factoryId:'startup-fixture',cellId:'sender' },endpoint:'http://127.0.0.1:4311/v1/peer/messages' },
    b:{ identity:{ factoryId:'startup-fixture',cellId:'broker' },endpoint:'http://127.0.0.1:4310/v1/peer/messages' },credentialExpiresAt:Date.now()+120000 });
  const peer = new PeerStore(p('peer.sqlite'),{ config:pair.b }); peer.close();
  const control = new FactoryControl(p('control.sqlite'));
  control.initialize({ mission:'Isolated capacity startup fixture',budgetCents:1000,maxCells:4,maxDepth:2 });
  control.close();
  const paid = new SpendingLedger(p('paid.sqlite')); paid.initialize({ limitCents:1000,currency:'USD' }); paid.close();
  for (const name of ['peer.sqlite','control.sqlite','paid.sqlite']) await permissions(p(name));
  const nativeToken = randomBytes(40).toString('hex');
  await privateFiles.writePrivateJson(p('peer.private.json'),pair.b,{ exclusive:true });
  await privateFiles.writePrivateJson(p('native-token.private.json'),{ token:nativeToken },{ exclusive:true });
  const worker = { workspace:'startup-fixture',archiveSha256:'a'.repeat(64),compatibility };
  const grant = { native:worker,template:{ source:'http://127.0.0.1:4200',workspace:worker.workspace } };
  await privateFiles.writePrivateJson(p('grant.private.json'),grant,{ exclusive:true });
  const source = { schemaVersion:1,origin:'http://127.0.0.1:4200',tokenFile:p('native-token.private.json'),dataRoot:p('native-data'),worker };
  await privateFiles.writePrivateJson(p('source.private.json'),source,{ exclusive:true });
  const profile = { peerConfigFile:p('peer.private.json'),peerDatabase:p('peer.sqlite'),grantFile:p('grant.private.json'),
    controlDatabase:p('control.sqlite'),spendingDatabase:p('paid.sqlite'),managedModule:MODULE,
    managedOptions:{ directory:p('managed-cloud'),env:{} },sourceProfileFile:p('source.private.json'),host:'127.0.0.1',port:4310,pollMs:250 };
  async function run(changes={}) {
    await privateFiles.writePrivateJson(p('profile.private.json'),{ ...profile,...changes });
    const result = await child(['broker','--private-module',HELPER,'--profile',p('profile.private.json')]);
    assert.equal(result.code,1); assert.equal(result.signal,null);
    assert.ok(![nativeToken,pair.b.key].some(secret => (result.stdout+result.stderr).includes(secret)), 'startup output withholds credentials');
    const lines = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(lines.length,1); assert.deepEqual(Object.keys(lines[0]),['error']);
    assert.ok(/^[A-Z_]{1,48}$/.test(lines[0].error.code));
    return lines[0].error.code;
  }
  async function hashes() {
    return Promise.all(['peer.sqlite','control.sqlite','paid.sqlite'].map(async name => [name,sha(await fs.readFile(p(name)))]));
  }
  return { p,profile,worker,source,run,hashes };
}

test('vendored ManagedCloud files match the pinned clean builtin-only source and import without provider operations',async t => {
  const bytes = await fs.readFile(path.join(VENDOR,'provenance.json'));
  assert.equal(sha(bytes),'c2c4db31be0ceb7d2f53fcb2920553bbd41d6012e26f8e330b5a90b06ed88490');
  const record = JSON.parse(bytes);
  assert.equal(record.sourceCommit,'c36ceef69d6563b4839b605a377b3757ee8e4958'); assert.equal(record.sourceClean,true);
  assert.equal(record.files.length,12);
  for (const file of record.files) {
    assert.ok(/^(package\.json|lib\/[a-z-]+\.mjs)$/.test(file.path));
    const source = await fs.readFile(path.join(VENDOR,file.path)); assert.equal(source.length,file.bytes); assert.equal(sha(source),file.sha256);
    if (file.path.endsWith('.mjs')) for (const match of source.toString().matchAll(/from\s+['"]([^'"]+)['"]/g))
      assert.ok(match[1].startsWith('node:') || /^\.\/[a-z-]+\.mjs$/.test(match[1]),'vendor import needs only builtin or local modules');
  }
  const f = await fixture(t);
  const loaded = await import(pathToFileURL(MODULE).href); assert.equal(typeof loaded.ManagedCloud,'function');
  const adapter = await createManagedCloudAdapter({ modulePath:MODULE,options:{ directory:f.p('managed'),env:{} },sourceWorkerProfile:f.source,privateFiles });
  assert.equal(typeof adapter.provision,'function');
  assert.equal(await fs.access(f.p('managed')).then(() => true,() => false),false,'module construction creates no deployment state');
});

test('capacity CLI rejects unknown, duplicate, missing and extra arguments before authority access',async() => {
  const invalid = [[],['broker'],['broker','--private-module',HELPER],['broker','--private-module',HELPER,'--private-module',HELPER],
    ['broker','--private-module',HELPER,'--other',HELPER],['broker','--private-module',HELPER,'--profile',HELPER,'--profile',HELPER],
    ['broker','--private-module',HELPER,'--profile','relative.json']];
  for (const args of invalid) {
    const result = await child(args); assert.equal(result.code,1); assert.equal(result.signal,null);
    assert.deepEqual(JSON.parse(result.stdout),{ error:{ code:'CAPACITY_CONFIG' } });
  }
});

test('broker refuses missing authority files before creating peer or global state',async t => {
  const f = await fixture(t), before = await f.hashes();
  for (const name of ['peerDatabase','controlDatabase','spendingDatabase']) {
    const missing = f.p('missing-'+name+'.sqlite');
    await f.run({ [name]:missing }); assert.equal(await fs.access(missing).then(() => true,() => false),false);
    assert.deepEqual(await f.hashes(),before);
  }
});

test('broker refuses blank and uninitialized policies without initializing or changing authority',async t => {
  const f = await fixture(t), blank = f.p('blank.sqlite');
  await fs.writeFile(blank,'',{ mode:0o600 });
  assert.equal(await f.run({ peerDatabase:blank }),'CAPACITY_DATABASE'); assert.equal((await fs.stat(blank)).size,0);
  const emptyControl = f.p('empty-control.sqlite'), control = new FactoryControl(emptyControl); control.close(); await permissions(emptyControl);
  const emptyPaid = f.p('empty-paid.sqlite'), paid = new SpendingLedger(emptyPaid); paid.close(); await permissions(emptyPaid);
  for (const [field,filename] of [['controlDatabase',emptyControl],['spendingDatabase',emptyPaid]]) {
    const before = sha(await fs.readFile(filename)); assert.equal(await f.run({ [field]:filename }),'CAPACITY_DATABASE');
    assert.equal(sha(await fs.readFile(filename)),before);
  }
});

test('broker refuses cross-database aliases, foreign table sets and partial schemas before constructors',async t => {
  const f = await fixture(t), before = await f.hashes();
  for (const changes of [{ controlDatabase:f.profile.peerDatabase },{ spendingDatabase:f.profile.controlDatabase },
    { controlDatabase:f.profile.spendingDatabase },{ spendingDatabase:f.profile.peerDatabase+'-wal' }])
    assert.equal(await f.run(changes),'CAPACITY_DATABASE');
  assert.deepEqual(await f.hashes(),before);
  const foreign = f.p('foreign.sqlite'), db = new DatabaseSync(foreign);
  db.exec('CREATE TABLE unrelated(id INTEGER); PRAGMA user_version=1'); db.close(); await permissions(foreign);
  const foreignBefore = sha(await fs.readFile(foreign));
  assert.equal(await f.run({ spendingDatabase:foreign }),'CAPACITY_DATABASE'); assert.equal(sha(await fs.readFile(foreign)),foreignBefore);
  const broken = new DatabaseSync(f.profile.controlDatabase); broken.exec('DROP TABLE effects'); broken.close(); await permissions(f.profile.controlDatabase);
  const brokenBefore = await f.hashes(); assert.equal(await f.run(),'CAPACITY_DATABASE'); assert.deepEqual(await f.hashes(),brokenBefore);
});

test('broker rejects changed peer binding and source revision before opening any ledger for writes',async t => {
  const f = await fixture(t), before = await f.hashes();
  const peer = await privateFiles.readPrivateJson(f.profile.peerConfigFile); peer.generation++;
  await privateFiles.writePrivateJson(f.profile.peerConfigFile,peer);
  assert.equal(await f.run(),'CAPACITY_DATABASE'); assert.deepEqual(await f.hashes(),before);
  const changed = { ...f.source,worker:{ ...f.worker,compatibility:{ ...compatibility,revision:'f'.repeat(40) } } };
  await privateFiles.writePrivateJson(f.profile.sourceProfileFile,changed);
  assert.equal(await f.run(),'CAPACITY_CONFIG'); assert.deepEqual(await f.hashes(),before);
});

test('broker rejects unsafe SQLite leaves including existing WAL without rewriting permissions',async t => {
  const f = await fixture(t);
  // A symbolic link is unsafe on every supported host; Windows may require developer mode to create one.
  const linked = f.p('linked.sqlite');
  try {
    await fs.symlink(f.profile.controlDatabase,linked,'file');
    assert.equal(await f.run({ controlDatabase:linked }),'CAPACITY_DATABASE');
  } catch (error) { if (process.platform !== 'win32' || !['EPERM','EACCES'].includes(error.code)) throw error; }
  if (process.platform !== 'win32') {
    await fs.chmod(f.profile.controlDatabase,0o644);
    assert.equal(await f.run(),'CAPACITY_DATABASE'); assert.equal((await fs.stat(f.profile.controlDatabase)).mode & 0o777,0o644);
    await fs.chmod(f.profile.controlDatabase,0o600);
    const wal = f.profile.controlDatabase+'-wal'; await fs.writeFile(wal,'unsafe-fixture',{ mode:0o644 });
    assert.equal(await f.run(),'CAPACITY_DATABASE'); assert.equal((await fs.stat(wal)).mode & 0o777,0o644);
  }
});
