import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { FactoryControl } from '../src/control.mjs';
import { loadModalJournalConfig, parseModalJournalConfig, ModalJournalConfigError } from '../src/modal-journal-config.mjs';

const runFile = promisify(execFile);
const TOKEN = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const PRIVATE = 'private-config-value-that-must-not-appear-in-output';
const MAX_BYTES = 64 * 1024;

async function protect(file) {
  if (process.platform !== 'win32') return fs.chmod(file, 0o600);
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $p = [Environment]::GetEnvironmentVariable('FACTORY_TEST_MODAL_FILE')
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $p -AclObject $acl
  `;
  const systemRoot = process.env.SystemRoot;
  await runFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15_000,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, FACTORY_TEST_MODAL_FILE: file } });
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-serve-modal-'));
  const configFile = path.join(directory, 'private-modal-config.json');
  const journalPath = path.join(directory, 'missing-journal.sqlite');
  const config = { schemaVersion: 1, journals: [{ runId: 'modal-r3', journalPath }] };
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await protect(configFile);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('factory-serve-modal-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, configFile, journalPath, config };
}

function unavailable(error) {
  assert.ok(error instanceof ModalJournalConfigError);
  assert.match(error.code, /^MODAL_JOURNALS_CONFIG_(?:INVALID|UNSAFE|UNAVAILABLE)$/);
  assert.equal(error.message, 'Modal journal configuration is unavailable.');
  assert.equal(error.message.includes(PRIVATE), false);
  return true;
}

test('Modal config is explicit, immutable, closed, bounded and unique after path normalization', () => {
  const journalPath = path.join(os.tmpdir(), 'configured-modal.sqlite');
  const value = { schemaVersion: 1, journals: [{ runId: 'a'.repeat(64), journalPath }] };
  const before = JSON.stringify(value);
  const entries = parseModalJournalConfig(value);
  assert.deepEqual(entries, value.journals);
  assert.equal(JSON.stringify(value), before);
  assert.ok(Object.isFrozen(entries) && Object.isFrozen(entries[0]));
  const invalid = [null, [], {}, { ...value, schemaVersion: '1' }, { ...value, schemaVersion: 2 },
    { ...value, token: PRIVATE }, { schemaVersion: 1, journals: {} },
    { ...value, journals: [{ runId: 'valid', journalPath, extra: PRIVATE }] },
    { ...value, journals: [{ runId: 'valid', journalPath: 'relative.sqlite' }] },
    { ...value, journals: [{ runId: 'valid', journalPath: journalPath + '\0' }] },
    ...['', '_run', 'a.b', 'a/b', 'a'.repeat(65), PRIVATE + '\n'].map(runId => ({ ...value, journals: [{ runId, journalPath }] })),
    { ...value, journals: [{ runId: 'same', journalPath }, { runId: 'same', journalPath: journalPath + '-other' }] },
    { ...value, journals: [{ runId: 'one', journalPath }, { runId: 'two', journalPath: path.join(path.dirname(journalPath), 'nested', '..', path.basename(journalPath)) }] },
    { ...value, journals: Array.from({ length: 17 }, (_, index) => ({ runId: `run-${index}`, journalPath: journalPath + index })) },
  ];
  if (process.platform === 'win32') invalid.push(
    { ...value, journals: [{ runId: 'rooted', journalPath: '\\private\\journal.sqlite' }] },
    { ...value, journals: [{ runId: 'one', journalPath }, { runId: 'two', journalPath: journalPath.toUpperCase() }] });
  for (const malformed of invalid) assert.throws(() => parseModalJournalConfig(malformed), unavailable);
  assert.equal(parseModalJournalConfig({ schemaVersion: 1, journals: [] }).length, 0);
  assert.equal(parseModalJournalConfig({ ...value, journals: Array.from({ length: 16 }, (_, index) => ({ runId: `run-${index}`, journalPath: journalPath + index })) }).length, 16);
});

test('no Modal config preserves empty configuration and a private config never opens its journal', async t => {
  const f = await fixture(t);
  assert.deepEqual(await loadModalJournalConfig(), []);
  assert.deepEqual(await loadModalJournalConfig(f.configFile), f.config.journals);
  await assert.rejects(fs.stat(f.journalPath), { code: 'ENOENT' });
  await assert.rejects(loadModalJournalConfig('relative-private-config.json'), unavailable);
  await assert.rejects(loadModalJournalConfig(path.join(f.directory, PRIVATE + '.json')), unavailable);
});

test('config rejects broad file permissions and hard links', async t => {
  const f = await fixture(t);
  const publicFile = path.join(f.directory, 'public.json');
  await fs.writeFile(publicFile, JSON.stringify(f.config), { mode: 0o644 });
  await assert.rejects(loadModalJournalConfig(publicFile), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' });
  const hardLink = path.join(f.directory, 'hard-link.json');
  await fs.link(f.configFile, hardLink);
  await assert.rejects(loadModalJournalConfig(f.configFile), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' });
  await assert.rejects(loadModalJournalConfig(hardLink), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' });
});

test('config rejects symlink paths and nonregular files', async t => {
  const f = await fixture(t);
  await assert.rejects(loadModalJournalConfig(f.directory), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' });
  const symbolic = path.join(f.directory, 'symbolic.json');
  try { await fs.symlink(f.configFile, symbolic, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Host does not permit file symlink creation.');
    throw error;
  }
  await assert.rejects(loadModalJournalConfig(symbolic), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' });
});

test('oversized and malformed config reads stay bounded and disclose no raw content', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.configFile, Buffer.alloc(MAX_BYTES + 1, 0x61));
  await assert.rejects(loadModalJournalConfig(f.configFile), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' });
  await fs.writeFile(f.configFile, '{"' + PRIVATE);
  await assert.rejects(loadModalJournalConfig(f.configFile), unavailable);
  await fs.writeFile(f.configFile, Buffer.from([0xff, 0xfe]));
  await assert.rejects(loadModalJournalConfig(f.configFile), unavailable);
});

test('config detects same-file mutation between private check and opening the descriptor', async t => {
  const f = await fixture(t);
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.configFile) await fs.appendFile(f.configFile, ' ');
    return handle;
  };
  try { await assert.rejects(loadModalJournalConfig(f.configFile), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' }); }
  finally { fs.open = open; }
});

test('config limits descriptor reads and detects concurrent growth beyond the byte ceiling', async t => {
  const f = await fixture(t);
  const open = fs.open, requests = [];
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.configFile) {
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = async (...readArgs) => {
        requests.push(readArgs[2]);
        const result = await read(...readArgs);
        if (!changed) { changed = true; await fs.writeFile(f.configFile, Buffer.alloc(MAX_BYTES * 2, 0x61)); }
        return result;
      };
    }
    return handle;
  };
  try {
    await assert.rejects(loadModalJournalConfig(f.configFile), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' });
    assert.ok(requests.length > 0 && requests.every(length => length <= MAX_BYTES + 1));
  } finally { fs.open = open; }
});

test('config detects name replacement even while its original opened bytes stay stable', async t => {
  const f = await fixture(t);
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.configFile) {
      const read = handle.read.bind(handle);
      let replaced = false;
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!replaced) {
          replaced = true;
          await fs.rename(f.configFile, path.join(f.directory, 'original-config.json'));
          await fs.writeFile(f.configFile, JSON.stringify(f.config), { mode: 0o600 });
        }
        return result;
      };
    }
    return handle;
  };
  try { await assert.rejects(loadModalJournalConfig(f.configFile), { code: 'MODAL_JOURNALS_CONFIG_UNSAFE' }); }
  finally { fs.open = open; }
});

test('CLI refuses unknown arguments and private malformed configs with generic errors', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, privateValue: PRIVATE }));
  for (const args of [['--unknown', PRIVATE], ['--modal-journals', f.configFile], ['--modal-journals', PRIVATE]]) {
    const result = await runFile(process.execPath, [path.resolve('bin/serve.mjs'), ...args], {
      env: { ...process.env, FACTORY_VIEWER_TOKEN: TOKEN }, windowsHide: true, timeout: 15_000,
    }).then(value => ({ ...value, code: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal((result.stdout + result.stderr).includes(PRIVATE), false);
    assert.equal((result.stdout + result.stderr).includes(f.directory), false);
    assert.equal((result.stdout + result.stderr).includes(TOKEN), false);
    const errorLine = result.stderr.split(/\r?\n/).find(line => line.startsWith('{'));
    assert.match(JSON.parse(errorLine).error.code, /^(?:PRESENTATION_START_UNAVAILABLE|MODAL_JOURNALS_CONFIG_(?:INVALID|UNSAFE|UNAVAILABLE))$/);
  }
});

test('CLI loads one private Modal allowlist without exposing paths or changing snapshot capabilities', async t => {
  const f = await fixture(t);
  const databasePath = path.join(f.directory, 'control.sqlite');
  const control = new FactoryControl(databasePath);
  control.initialize({ mission: 'CLI Modal fixture', budgetCents: 0 });
  control.close();
  const child = spawn(process.execPath, [path.resolve('bin/serve.mjs'), '--database', databasePath,
    '--factory-id', 'config-fixture', '--modal-journals', f.configFile, '--port', '0'], {
    env: { ...process.env, FACTORY_VIEWER_TOKEN: TOKEN }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture CLI startup timed out.')), 10_000);
        child.stdout.on('data', () => { if (stdout.includes('\n')) { clearTimeout(timer); resolve(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => clearTimeout(timer));
      }),
      once(child, 'exit').then(() => { throw new Error('Fixture CLI exited before listening.'); }),
    ]);
    const announcement = JSON.parse(stdout.trim());
    assert.equal(announcement.listening.host, '127.0.0.1');
    assert.deepEqual(announcement.capabilities, { snapshot: true, events: true, commands: false });
    const origin = `http://127.0.0.1:${announcement.listening.port}`;
    const response = await fetch(`${origin}/v1/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).capabilities, announcement.capabilities);
    const modalResponse = await fetch(`${origin}/v1/modal-runs`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(modalResponse.status, 200);
    const modalBody = await modalResponse.json();
    assert.deepEqual(modalBody.modalRuns.runs, [{ runId: 'modal-r3', availability: 'unavailable', reason: 'MODAL_JOURNAL_UNAVAILABLE' }]);
    assert.equal(modalBody.modalRuns.basis, 'persisted-local-operation-journal');
    assert.equal(modalBody.modalRuns.providerFreshness, 'not_observed');
    assert.equal(JSON.stringify(modalBody).includes(f.directory), false);
    assert.equal(JSON.stringify(modalBody).includes(TOKEN), false);
    assert.equal(Object.hasOwn(modalBody.modalRuns.runs[0], 'journalPath'), false);
    assert.equal((stdout + stderr).includes(f.directory), false);
    assert.equal((stdout + stderr).includes(TOKEN), false);
    await assert.rejects(fs.stat(f.journalPath), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
});
