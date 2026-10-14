import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudLiteBoard } from '../src/cloud-lite/board.mjs';
import { validateCloudLitePlan, agentInventory, machineConfig, redact, secret } from '../src/cloud-lite/protocol.mjs';
import { FactoryCloudLiteFleet } from '../src/cloud-lite/fleet.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';
import { CloudLiteTrace } from '../src/cloud-lite/trace.mjs';
import { collectCloudLiteSnapshot } from '../src/cloud-lite/collect.mjs';
import { DatabaseSync } from 'node:sqlite';

const plan = () => validateCloudLitePlan({ runId: 'lite-test', app: 'factory-lite-test', repository: 'mario-andreschak/FLUJO', goal: 'Analyze and merge existing PRs', machines: 10, agentsPerMachine: 10 });
const fresh = () => mkdtempSync(join(tmpdir(), 'factory-cloud-lite-'));
test('requested 10 by 10 topology and Fly resource selection retain exact values', () => {
  const input = plan(); const agents = agentInventory(input);
  assert.equal(agents.length, 100); assert.equal(agents.filter(x => x.role === 'orchestrator').length, 10);
  const config = machineConfig(input, { image: 'example@sha256:123', volumeId: 'vol_one', index: 4, environment: {} });
  assert.deepEqual(config.guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 }); assert.equal(config.mounts[0].volume, 'vol_one');
  assert.equal(config.services.length, 0);
  assert.throws(() => validateCloudLitePlan({ ...input, agentsPerMachine: -1 }));
});
test('board rejects cross-machine subagent messages while allowing orchestrator and local peer messages', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()]));
  const board = new CloudLiteBoard(join(fresh(), 'board.sqlite'), { plan: p, credentials });
  try {
    const a = id => board.authenticate(credentials[id]);
    assert.throws(() => board.call(a('m0-a1'), 'factory_message', { recipient: 'm1-a1', messageId: 'forbidden', message: {} }), /communication policy/);
    assert.throws(() => board.call(a('m0-a1'), 'factory_message', { recipient: 'm1-a0', messageId: 'also-forbidden', message: {} }), /communication policy/);
    assert.deepEqual(board.call(a('m0-a0'), 'factory_message', { recipient: 'm1-a0', messageId: 'leaders', message: { work: 'pr:1' } }), { duplicate: false });
    board.call(a('m0-a1'), 'factory_message', { recipient: 'm0-a2', messageId: 'local', message: { review: true } });
    assert.equal(board.call(a('m0-a2'), 'factory_inbox').messages.length, 1);
  } finally { board.close(); }
});
test('separate controller connections cannot assign the same resource to two machines', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()])); const db = join(fresh(), 'board.sqlite');
  const first = new CloudLiteBoard(db, { plan: p, credentials }); const second = new CloudLiteBoard(db, { plan: p, credentials });
  try {
    assert.equal(first.call(first.authenticate(credentials['m0-a0']), 'factory_claim', { resource: 'pr:1140' }).claimed, true);
    const refused = second.call(second.authenticate(credentials['m1-a0']), 'factory_claim', { resource: 'pr:1140' });
    assert.equal(refused.claimed, false); assert.equal(refused.claim.owner, 'm0-a0');
  } finally { first.close(); second.close(); }
});
test('trace replay commits once and rejects altered bytes after a lost ACK', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()])); const board = new CloudLiteBoard(join(fresh(), 'board.sqlite'), { plan: p, credentials });
  try {
    const actor = board.authenticate(credentials['m0-a0']); const events = [{ seq: 1, kind: 'tool', body: { command: 'npm run lint' } }];
    board.trace(actor, events); board.trace(actor, events); assert.equal(board.events().length, 1);
    assert.throws(() => board.trace(actor, [{ ...events[0], body: { changed: true } }]), /different bytes/);
  } finally { board.close(); }
});
test('credentials cannot appear in diagnostic trace projection', () => {
  const credential = secret(); assert.equal(redact({ stderr: `failed with ${credential}` }, [credential]).stderr, 'failed with [REDACTED]');
  assert.equal(redact({ jwt: 'eyJabcdefgh.abcdefghijkl.abcdefghijk' }).jwt, '[REDACTED]');
});

test('agent progress cannot overwrite the SDK-registered native session identity', () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id,secret()]));
  const board = new CloudLiteBoard(join(fresh(),'board.sqlite'),{plan:p,credentials});
  try {
    const session = '01a1390d-1da9-76a1-0a6e-af0c060ec3a4';
    board.registerSession('m0-a1',session);
    board.call(board.authenticate(credentials['m0-a1']),'factory_checkpoint',{status:'reviewing',session:'m0-a1'});
    assert.equal(board.inventory().find(agent=>agent.id==='m0-a1').session,session);
    assert.throws(()=>board.registerSession('m0-a1','made-up'),/real native/);
  } finally { board.close(); }
});

test('torn trace recovery preserves damaged bytes and never reuses a receiver-confirmed sequence', () => {
  const file = join(fresh(), 'trace.jsonl');
  const bytes = JSON.stringify({ seq: 1, kind: 'shell', body: { exit: 0 } }) + '\n' + '\0'.repeat(4096);
  writeFileSync(file, bytes); writeFileSync(file + '.ack', '\0');
  const trace = new CloudLiteTrace({ file, url: 'http://localhost', token: secret(), remoteSequence: 12 });
  assert.equal(trace.queue[0].kind, 'trace.recovery'); assert.equal(trace.queue[0].seq, 13);
  const evidence = trace.queue[0].body.preservedEvidence;
  assert.equal(existsSync(evidence), true); assert.equal(readFileSync(evidence, 'utf8'), bytes);
  assert.equal(trace.record('restarted', {}).seq, 14);
});
test('provider uncertainty stays held across controller restart without a second creation', async () => {
  const directory = fresh(); let calls = 0;
  const execute = async () => { calls++; throw new Error('Lost original provider response.'); };
  const options = { image: 'registry.example/image', githubToken: secret() };
  const auth = { read: () => ({ accessToken: secret(), chatgptAccountId: 'account' }) };
  const fleet = new FactoryCloudLiteFleet({ directory, execute, auth });
  await assert.rejects(fleet.deploy(plan(), options));
  const reopened = new FactoryCloudLiteFleet({ directory, execute, auth });
  await assert.rejects(reopened.deploy(plan(), options), /inspect the existing provider identity/);
  assert.equal(calls, 1); assert.equal(JSON.parse(readFileSync(join(directory, 'fleet.json'))).operations['app.create'].state, 'unknown');
});

test('fleet delegates immutable images to upstream Machines API and exposes no public worker service', async () => {
  const p = { ...plan(), machines: 2 }; const machines = []; const calls = [];
  const infrastructure = {
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'volumes') return JSON.stringify({ id: `vol_${machines.length}` });
      if (args[0] === 'machine') {
        assert.deepEqual(args.slice(0, 2), ['machine', 'list']);
        return JSON.stringify(machines);
      }
      return '';
    },
    buildMachineConfig: () => ({ init: { cmd: ['upstream-runtime'] }, services: [] }),
    createMachine: async ({ name, config }) => {
      assert.equal(config.image, 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64));
      assert.deepEqual(config.services, []);
      const machine = { id: `machine-${machines.length}`, name, config }; machines.push(machine); return machine;
    },
  };
  const fleet = new FactoryCloudLiteFleet({ directory: fresh(), infrastructure,
    auth: { read: () => ({ accessToken: secret(), chatgptAccountId: 'account' }) } });
  const result = await fleet.deploy(p, { image: 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64), githubToken: secret() });
  assert.equal(result.machines.length, 2);
  assert.equal(machines[1].config.env.FACTORY_BOARD_MACHINE_ID, machines[0].id);
  assert.equal(calls.some(args => ['deploy','ips','auth'].includes(args[0]) || args[0] === 'machine' && args[1] === 'run'), false);
});
test('authenticated HTTP board binds sender independently of client input', async () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()]));
  const coordinator = await startCloudLiteCoordinator({ database: join(fresh(), 'board.sqlite'), plan: p, credentials, operatorToken: secret(),
    auth: { accessToken: secret(), chatgptAccountId: 'account' }, githubToken: secret(), host: '127.0.0.1', port: 0 });
  try {
    const url = `http://127.0.0.1:${coordinator.server.address().port}`;
    assert.equal((await fetch(url + '/operator/status')).status, 401);
    const response = await fetch(url + '/tool', { method: 'POST', headers: { Authorization: `Bearer ${credentials['m0-a1']}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'factory_message', arguments: { sender: 'm0-a0', recipient: 'm1-a1', messageId: 'fake-role', message: {} } }) });
    assert.equal(response.status, 400);
  } finally { await coordinator.close(); }
});

test('evidence collection includes independent evidence roots and consistent WAL database content', async () => {
  const root = fresh(); const evidence = join(root, 'm8-evidence'); mkdirSync(evidence);
  writeFileSync(join(evidence, 'result.json'), '{"tests":54}');
  writeFileSync(join(evidence, 'trace.jsonl'), '{"seq":1}\n{"seq":');
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'cache'), 'disposable');
  writeFileSync(join(root, 'auth.json'), 'private-credential');
  const database = new DatabaseSync(join(root, 'board.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence(result TEXT); INSERT INTO evidence VALUES(\'passed\');');
  try {
    const destination = join(root, '.factory-export-test');
    const receipt = await collectCloudLiteSnapshot({ root, runId: 'lite-test', destination });
    assert.equal(receipt.sqliteBackups, 1); assert.equal(existsSync(receipt.archive), true);
    assert.equal(readFileSync(join(destination, 'snapshot', 'm8-evidence', 'trace.jsonl'), 'utf8'), '{"seq":1}\n');
    const retained = new DatabaseSync(join(destination, 'snapshot', 'board.sqlite'), { readOnly: true });
    try { assert.equal(retained.prepare('SELECT result FROM evidence').get().result, 'passed'); } finally { retained.close(); }
    assert.equal(existsSync(join(destination, 'snapshot', 'node_modules')), false);
    assert.equal(existsSync(join(destination, 'snapshot', 'auth.json')), false);
    assert.equal(readFileSync(join(destination, 'snapshot', 'm8-evidence', 'result.json'), 'utf8'), '{"tests":54}');
  } finally { database.close(); }
});

test('a new stop supersedes older work but replaying that stop preserves a later explicit message', async () => {
  const p = plan(); const credentials = Object.fromEntries(agentInventory(p).map(x => [x.id, secret()])); const operatorToken = secret();
  const coordinator = await startCloudLiteCoordinator({ database: join(fresh(), 'board.sqlite'), plan: p, credentials, operatorToken,
    auth: { accessToken: secret(), chatgptAccountId: 'account' }, githubToken: secret(), host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const request = async (path, body, token = operatorToken) => {
    const response = await fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  try {
    await request('/operator/command', { id: 'old-work', recipient: 'm0-a0', action: 'message', message: 'Review PR' });
    const stop = { id: 'stop-work', recipient: 'm0-a0', action: 'stop' };
    await request('/operator/command', stop);
    let inbox = await request('/commands', {}, credentials['m0-a0']); assert.deepEqual(inbox.commands.map(command => command.id), ['stop-work']);
    assert.equal(coordinator.board.db.prepare('SELECT superseded_by FROM cloud_lite_command_cancellations WHERE command_id=?').get('old-work').superseded_by, 'stop-work');
    await request('/commands', { acknowledge: 'stop-work' }, credentials['m0-a0']);
    await request('/operator/command', { id: 'new-work', recipient: 'm0-a0', action: 'message', message: 'Resume review' });
    await request('/operator/command', stop);
    inbox = await request('/commands', {}, credentials['m0-a0']); assert.deepEqual(inbox.commands.map(command => command.id), ['new-work']);
  } finally { await coordinator.close(); }
});

test('retirement refuses an app containing a Machine absent from the original fleet journal', async () => {
  let destroyed = false; const original = { id: 'original', name: 'owned', volumeId: 'volume-one' };
  const fleet = new FactoryCloudLiteFleet({ directory: fresh(), execute: async (_command, args) => {
    if (args[0] === 'machine') return JSON.stringify([{ id: 'original', name: 'owned', config: { metadata: { 'factory.run': 'lite-test' }, mounts: [{ volume: 'volume-one' }] } }, { id: 'other' }]);
    if (args[0] === 'volumes') return JSON.stringify([{ id: 'volume-one' }]);
    destroyed = true; return '';
  } });
  fleet.state = { plan: plan(), machines: [original], operations: {} }; fleet.save();
  await assert.rejects(fleet.retire(), /exact original Machine and volume inventory/); assert.equal(destroyed, false);
});
