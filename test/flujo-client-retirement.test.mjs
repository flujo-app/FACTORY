import test from 'node:test';
import assert from 'node:assert/strict';
import { FlujoClient } from '../src/flujo-swarm/flujo-client.mjs';

test('workspace retirement waits through a late recreation before issuing a receipt', async () => {
  const client = new FlujoClient({ origin: 'http://127.0.0.1:4200', workspace: 'swarm-owned' });
  let deletes = 0;
  let observations = 0;
  client.servers = async () => [];
  client.api = async method => {
    assert.equal(method, 'DELETE');
    deletes++;
    return { status: 200, body: { deleted: 'swarm-owned' } };
  };
  client.workspaces = async () => {
    observations++;
    // The first delete looks clean initially, then a background writer restores it.
    return deletes === 1 && observations >= 3 ? ['swarm-owned'] : [];
  };
  const receipt = await client.deleteWorkspace('swarm-owned', { verificationWindowMs: 12, pollIntervalMs: 1 });
  assert.equal(receipt.deleted, 'swarm-owned');
  assert.equal(deletes, 2);
  assert.ok(observations >= 3);
});

test('workspace retirement rejects when FLUJO repeatedly recreates the directory', async () => {
  const client = new FlujoClient({ origin: 'http://127.0.0.1:4200', workspace: 'swarm-owned' });
  let deletes = 0;
  client.servers = async () => [];
  client.api = async () => { deletes++; return { status: 200, body: { deleted: 'swarm-owned' } }; };
  client.workspaces = async () => ['swarm-owned'];
  await assert.rejects(client.deleteWorkspace('swarm-owned',
    { verificationWindowMs: 2, pollIntervalMs: 1 }), /Could not confirm deletion/);
  assert.equal(deletes, 4);
});
