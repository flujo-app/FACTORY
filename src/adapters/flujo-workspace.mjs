import { FlujoClient } from '../flujo-swarm/flujo-client.mjs';

const WORKER = /^[a-z][a-z0-9-]{2,62}$/;
const CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Local FLUJO workspaces are isolated by workspace identity, not by machine. */
export function createFlujoWorkspaceAdapter({ origin, token, clientFactory = settings => new FlujoClient(settings) } = {}) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) throw new TypeError('origin must be an exact HTTP(S) origin');
  if (token !== undefined && (typeof token !== 'string' || !token)) throw new TypeError('token must be a nonempty bearer');
  if (typeof clientFactory !== 'function') throw new TypeError('clientFactory is required');
  const workspaceFor = app => {
    if (typeof app !== 'string' || !WORKER.test(app)) throw new TypeError('Invalid worker identity');
    return `swarm-${app}`;
  };
  const clientFor = app => clientFactory({ origin: url.origin, token, workspace: workspaceFor(app) });
  return Object.freeze({
    capabilities: Object.freeze({ adapter: 'flujo-workspace', machineIsolation: false,
      recursiveProvisioning: false, providerSpendObserved: false }),
    async provision({ app, flowSpec } = {}) {
      const client = clientFor(app);
      if (!flowSpec || typeof flowSpec !== 'object' || Array.isArray(flowSpec)
        || typeof flowSpec.name !== 'string' || !flowSpec.name.trim()) {
        throw new TypeError('An explicit FLUJO flow spec is required');
      }
      // A fresh FACTORY intent must never adopt or overwrite a preexisting workspace.
      if ((await client.workspaces()).includes(client.workspace)) throw new Error('Workspace identity is already occupied.');
      await client.ensureWorkspace();
      const flow = await client.saveFlowSpec(flowSpec);
      if (flow?.name !== flowSpec.name || typeof flow.id !== 'string' || !flow.id) {
        throw new Error('FLUJO did not confirm the installed flow.');
      }
      return { app, worker: app, workspace: client.workspace, state: 'ready' };
    },
    async call(app, { conversationId, request, timeoutMs } = {}) {
      const client = clientFor(app);
      if (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId)
        || typeof request?.flowName !== 'string' || !request.flowName.trim()
        || typeof request.prompt !== 'string' || !request.prompt.trim()) {
        throw new TypeError('A conversation ID, flow name and prompt are required');
      }
      const result = await client.runFlow({ flowName: request.flowName, prompt: request.prompt,
        conversationId, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      if (result?.conversationId !== conversationId || result?.status !== 'completed'
        || typeof result.output !== 'string') throw new Error('FLUJO conversation outcome is unconfirmed.');
      return { body: result.output, contentType: 'text/plain' };
    },
    async retire(app) {
      const client = clientFor(app);
      await client.deleteWorkspace(client.workspace);
      return { app, worker: app, state: 'destroyed' };
    },
  });
}
