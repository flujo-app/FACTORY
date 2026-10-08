import { FlujoClient, lastAssistantText } from '../flujo-swarm/flujo-client.mjs';
import { buildFactoryTeamSpecs } from '../flujo-swarm/template/factory-team.mjs';

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
    async provision({ app, flowSpec, flowSpecs, teamTemplate, modelConfig } = {}) {
      const client = clientFor(app);
      const requestedSpecs = flowSpecs ?? (flowSpec === undefined ? null : [flowSpec]);
      if (teamTemplate !== undefined && (flowSpec !== undefined || flowSpecs !== undefined)
        || teamTemplate === undefined && (!Array.isArray(requestedSpecs)
          || requestedSpecs.length < 1 || requestedSpecs.length > 32
          || new Set(requestedSpecs.map(spec => spec?.name)).size !== requestedSpecs.length
          || requestedSpecs.some(spec => !spec || typeof spec !== 'object' || Array.isArray(spec)
            || typeof spec.name !== 'string' || !spec.name.trim()))
        || teamTemplate !== undefined && (!teamTemplate || typeof teamTemplate !== 'object'
          || Array.isArray(teamTemplate) || typeof teamTemplate.model !== 'string' || !teamTemplate.model.trim())) {
        throw new TypeError('Distinct flow specs or one FACTORY team template are required');
      }
      if (modelConfig !== undefined && (!modelConfig || typeof modelConfig !== 'object'
        || Array.isArray(modelConfig) || typeof modelConfig.id !== 'string' || !modelConfig.id.trim())) {
        throw new TypeError('modelConfig must name an installed FLUJO model ID');
      }
      if (teamTemplate && modelConfig && teamTemplate.model !== modelConfig.id) {
        throw new TypeError('Team template and model configuration must name the same model');
      }
      // A fresh FACTORY intent must never adopt or overwrite a preexisting workspace.
      if ((await client.workspaces()).includes(client.workspace)) throw new Error('Workspace identity is already occupied.');
      await client.ensureWorkspace();
      if (modelConfig) await client.upsertModel(modelConfig);
      let specs = requestedSpecs;
      if (teamTemplate) {
        const supported = new Set(['filesystem', 'bash', 'browser', 'flujo']);
        const servers = (await client.servers()).filter(server => !server.disabled && supported.has(server.name));
        const availableServers = [...new Set(servers.map(server => server.name))];
        const availableTools = {};
        for (const name of availableServers) {
          const observed = await client.serverTools(name);
          if (observed?.error || !Array.isArray(observed?.tools)) throw new Error('Connected FLUJO tool inventory is unavailable.');
          availableTools[name] = observed.tools.map(tool => tool?.name).filter(name => typeof name === 'string');
        }
        specs = buildFactoryTeamSpecs({ ...teamTemplate, availableServers, availableTools });
      }
      for (const spec of specs) {
        const flow = await client.saveFlowSpec(spec);
        if (flow?.name !== spec.name || typeof flow.id !== 'string' || !flow.id) {
          throw new Error('FLUJO did not confirm the installed flow.');
        }
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
    async message(app, { conversationId, messageId, content } = {}) {
      if (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId)
        || typeof messageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)
        || typeof content !== 'string' || !content.trim()) throw new TypeError('Conversation, message ID and content are required');
      const response = await clientFor(app).inject(conversationId, content, messageId);
      if (response?.message_id !== messageId || response?.conversation_id !== conversationId
        || response?.status !== 'queued') throw new Error('FLUJO did not confirm queued steering.');
      return { messageId, state: 'queued' };
    },
    async cancel(app, { conversationId } = {}) {
      if (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId))
        throw new TypeError('A conversation ID is required');
      const client = clientFor(app);
      const before = await client.conversation(conversationId);
      if (before?.status !== 200 || before?.body?.id !== conversationId
        || !['running','queued','pending','awaiting','awaiting_tool_approval','paused_debug'].includes(before.body.status))
        throw new Error('FLUJO active conversation identity was not confirmed before cancellation.');
      const response = await client.cancel(conversationId);
      if (![200,202].includes(response?.status) || response?.body?.success !== true)
        throw new Error('FLUJO did not acknowledge cancellation request.');
      return { state: 'requested' };
    },
    async observeCancelled(app, { conversationId } = {}) {
      if (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId))
        throw new TypeError('A conversation ID is required');
      const response = await clientFor(app).conversation(conversationId);
      if (response?.status !== 200 || response?.body?.id !== conversationId)
        throw new Error('FLUJO conversation identity is unavailable.');
      return { conversationId, status: response.body.status,
        classification: response.body.recovery?.classification,
        failureCategory: response.body.recovery?.failure?.category };
    },
    async observeCompleted(app, { conversationId } = {}) {
      if (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId))
        throw new TypeError('A conversation ID is required');
      const response = await clientFor(app).conversation(conversationId);
      if (response?.status !== 200 || response?.body?.id !== conversationId
        || response.body.status !== 'completed' || !Array.isArray(response.body.messages))
        throw new Error('FLUJO terminal conversation output is unavailable.');
      return { conversationId, status: 'completed', output: lastAssistantText(response.body.messages) };
    },
    async retire(app) {
      const client = clientFor(app);
      await client.deleteWorkspace(client.workspace);
      return { app, worker: app, state: 'destroyed' };
    },
  });
}
