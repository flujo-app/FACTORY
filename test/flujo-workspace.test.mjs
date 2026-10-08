import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlujoWorkspaceAdapter } from '../src/adapters/flujo-workspace.mjs';

test('workspace adapter creates one owned workspace and runs an exact conversation', async () => {
  const actions = [];
  const adapter = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200', token: 'private',
    clientFactory(settings) {
      assert.deepEqual(settings, { origin: 'http://127.0.0.1:4200', token: 'private', workspace: 'swarm-worker-one' });
      return { workspace: settings.workspace,
        async workspaces() { return []; },
        async ensureWorkspace() { actions.push('create'); },
        async saveFlowSpec(spec) { actions.push('flow'); return { id: 'flow-one', name: spec.name }; },
        async runFlow(input) { actions.push('call'); return { conversationId: input.conversationId, status: 'completed', output: 'done' }; },
        async deleteWorkspace(name) { actions.push(`retire:${name}`); },
      };
    } });
  assert.equal((await adapter.provision({ app: 'worker-one', flowSpec: { name: 'Work' } })).state, 'ready');
  assert.deepEqual(await adapter.call('worker-one', { conversationId: 'conversation-one',
    request: { flowName: 'Work', prompt: 'Do the work' } }), { body: 'done', contentType: 'text/plain' });
  assert.equal((await adapter.retire('worker-one')).state, 'destroyed');
  assert.deepEqual(actions, ['create', 'flow', 'call', 'retire:swarm-worker-one']);
});

test('occupied workspace and uncertain conversation do not claim success', async () => {
  let created = 0;
  const adapter = createFlujoWorkspaceAdapter({ origin: 'http://127.0.0.1:4200', clientFactory: settings => ({
    workspace: settings.workspace,
    async workspaces() { return ['swarm-worker-one']; },
    async ensureWorkspace() { created++; },
    async runFlow(input) { return { conversationId: input.conversationId, status: 'unknown', output: '' }; },
  }) });
  await assert.rejects(adapter.provision({ app: 'worker-one', flowSpec: { name: 'Work' } }), /occupied/);
  assert.equal(created, 0);
  await assert.rejects(adapter.call('worker-one', { conversationId: 'conversation-one',
    request: { flowName: 'Work', prompt: 'Do the work' } }), /unconfirmed/);
});
