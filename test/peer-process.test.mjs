import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createPairConfigurations } from '../src/peer-messaging.mjs';

function child() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)));
  const process_ = fork(new URL('../fixtures/peer-process.mjs', import.meta.url), [], { execPath: process.execPath, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pending = new Map(); let sequence = 0;
  const terminal = new Promise(resolve => process_.once('close', (code, signal) => resolve({ code, signal })));
  const ready = new Promise(resolve => process_.on('message', value => {
    if (value.ready) resolve();
    const reply = pending.get(value.requestId); if (reply) { pending.delete(value.requestId); value.error ? reply.reject(new Error(value.error)) : reply.resolve(value.result); }
  }));
  process_.on('exit', () => { for (const reply of pending.values()) reply.reject(new Error('CHILD_EXIT')); pending.clear(); });
  let outputBytes = 0;
  for (const stream of [process_.stdout, process_.stderr]) stream.on('data', bytes => { outputBytes += bytes.length; if (outputBytes > 65536) process_.kill(); });
  return { process: process_, terminal, ready,
    async request(value) {
      await ready; const requestId = ++sequence;
      return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CHILD_DEADLINE')); }, 10000);
        pending.set(requestId, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } }); process_.send({ ...value, requestId }); });
    } };
}
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
test('actual receiver commits then dies before ACK; both processes restart and resolve one original intent', { timeout: 45000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-peer-process-'));
  const processes = [];
  t.after(async () => {
    for (const item of processes) { if (item.process.exitCode === null && item.process.signalCode === null) item.process.kill(); await item.terminal; }
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'factory-peer-process-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const receiverPort = await port(), now = Date.now();
  const configs = createPairConfigurations({ a: { identity: { factoryId: 'source-factory', cellId: 'dev' }, endpoint: 'http://127.0.0.1:1/v1/peer/messages' },
    b: { identity: { factoryId: 'receiver-factory', cellId: 'watcher' }, endpoint: `http://127.0.0.1:${receiverPort}/v1/peer/messages` }, credentialExpiresAt: now + 3600000 });
  const databaseA = path.join(directory, 'sender.sqlite'), databaseB = path.join(directory, 'receiver.sqlite');
  const sender = child(), receiver = child(); processes.push(sender, receiver);
  await sender.request({ command: 'open', database: databaseA, config: configs.a });
  await receiver.request({ command: 'open', database: databaseB, config: configs.b, receiver: true, crashAfterCommit: true, port: receiverPort });
  const admitted = await sender.request({ command: 'enqueue', message: { messageId: 'lost-ack', type: 'checkpoint', payload: { phase: 'ready' }, expiresAt: now + 600000 } });
  const failed = await sender.request({ command: 'send', messageId: 'lost-ack' });
  assert.equal(failed.state, 'pending'); assert.equal((await receiver.terminal).code, 91);
  const persisted = new DatabaseSync(databaseB, { readOnly: true });
  assert.equal(persisted.prepare('SELECT count(*) AS n FROM peer_inbox').get().n, 1);
  assert.equal(persisted.prepare("SELECT count(*) AS n FROM peer_events WHERE type='inbox_recorded'").get().n, 1);
  assert.equal(persisted.prepare('SELECT digest FROM peer_inbox').get().digest, admitted.digest); persisted.close();
  assert.equal((await sender.request({ command: 'inspect', messageId: 'lost-ack' })).outbox.state, 'pending');
  await sender.request({ command: 'close' }); assert.equal((await sender.terminal).code, 0);
  const restartedSender = child(), restartedReceiver = child(); processes.push(restartedSender, restartedReceiver);
  assert.notEqual(restartedSender.process.pid, sender.process.pid); assert.notEqual(restartedReceiver.process.pid, receiver.process.pid);
  await restartedSender.request({ command: 'open', database: databaseA, config: configs.a });
  await restartedReceiver.request({ command: 'open', database: databaseB, config: configs.b, receiver: true, port: receiverPort });
  assert.equal((await restartedSender.request({ command: 'send', messageId: 'lost-ack' })).state, 'acknowledged');
  const a = await restartedSender.request({ command: 'inspect', messageId: 'lost-ack' }), b = await restartedReceiver.request({ command: 'inspect' });
  assert.deepEqual(a.outbox, { messageId: 'lost-ack', digest: admitted.digest, state: 'acknowledged', endpoint: configs.a.endpoint });
  assert.equal(a.counts.peer_outbox, 1); assert.equal(a.events.filter(event => event.type === 'outbox_acknowledged').length, 1);
  assert.equal(b.counts.peer_inbox, 1); assert.equal(b.events.filter(event => event.type === 'inbox_recorded').length, 1);
  assert.equal(b.inbox[0].digest, admitted.digest);
  assert.equal((await restartedSender.request({ command: 'send', messageId: 'lost-ack' })).dispatched, false);
  await restartedSender.request({ command: 'close' }); await restartedReceiver.request({ command: 'close' });
  assert.equal((await restartedSender.terminal).code, 0); assert.equal((await restartedReceiver.terminal).code, 0);
});
