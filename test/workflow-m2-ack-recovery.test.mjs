import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudLiteTrace } from '../src/cloud-lite/trace.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';
import { validateCloudLitePlan, agentInventory, secret } from '../src/cloud-lite/protocol.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'factory-workflow-m2-ack-'));
const event = seq => ({ seq, kind: `durable-${seq}`, body: { payload: `event-${seq}` }, observedAt: '2026-10-15T00:00:00.000Z' });

test('recovery does not trust a local ack that is ahead of the coordinator', async () => {
  const directory = fresh(); const plan = validateCloudLitePlan({ runId: 'm2-ack-recovery', app: 'm2-ack-recovery',
    repository: 'example/FACTORY', goal: 'Exercise durable trace recovery', machines: 1, agentsPerMachine: 1 });
  const credentials = Object.fromEntries(agentInventory(plan).map(agent => [agent.id, secret()]));
  const coordinator = await startCloudLiteCoordinator({ database: join(directory, 'board.sqlite'), plan, credentials, port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const token = credentials['m0-a0']; const file = join(directory, 'traces.jsonl');
  try {
    const seeded = await fetch(`${url}/trace`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [event(1)] }) });
    assert.equal(seeded.status, 200);
    assert.deepEqual(await seeded.json(), { acknowledged: 1 });

    mkdirSync(directory, { recursive: true });
    writeFileSync(file, [event(1), event(2), event(3)].map(JSON.stringify).join('\n') + '\n');
    // This valid integer was committed locally, but the coordinator only has
    // sequence 1. Sequences 2 and 3 are still present in the durable journal.
    writeFileSync(`${file}.ack`, '2');
    const trace = new CloudLiteTrace({ file, url, token, remoteSequence: 1 });
    await trace.flush();

    const persisted = coordinator.board.db.prepare('SELECT source_seq FROM cloud_lite_traces WHERE source=? ORDER BY source_seq').all('m0-a0').map(row => row.source_seq);
    assert.deepEqual(persisted, [1, 2, 3], 'every durable event beyond the coordinator watermark must reach the receiver');
    assert.deepEqual(trace.queue, []);
  } finally { await coordinator.close(); }
});

test('recovery rejects duplicate or reordered retained trace sequences', () => {
  for (const rows of [[event(1), event(1)], [event(2), event(1)]]) {
    const file = join(fresh(), 'traces.jsonl');
    writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    assert.throws(() => new CloudLiteTrace({ file, url: 'http://127.0.0.1:1', token: secret(), remoteSequence: 0 }),
      /sequence|order|duplicate|trace/i);
  }
});

test('recovery excludes malformed local sequence rows and preserves the original bytes', () => {
  const directory = fresh();
  const file = join(directory, 'traces.jsonl');
  const original = `${JSON.stringify(event(1))}\n{"seq":"2","kind":"invalid-sequence"}\n`;
  writeFileSync(file, original);
  const trace = new CloudLiteTrace({ file, url: 'http://127.0.0.1:1', token: secret(), remoteSequence: 0 });
  const evidenceName = readdirSync(directory).find(name => name.startsWith('traces.jsonl.recovery-'));
  assert.ok(evidenceName, 'raw damaged input is retained as recovery evidence');
  assert.equal(readFileSync(join(directory, evidenceName), 'utf8'), original);
  assert.ok(trace.queue.some(row => row.seq === 1));
  assert.ok(!trace.queue.some(row => row.kind === 'invalid-sequence'), 'malformed sequence is never sent as a durable trace row');
  assert.equal(trace.queue.at(-1).kind, 'trace.recovery');
  assert.ok(existsSync(file), 'the repaired journal remains available for future recovery');
});
