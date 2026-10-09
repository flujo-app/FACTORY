import { CASE_SPECIALISTS_V1, validateSpecialists, specialistAgentServers } from './specialists.mjs';

export { CASE_SPECIALISTS_V1 };
export const FACTORY_FLOW_NAMES = Object.freeze({ agent: 'swarm_agent', team: 'swarm_team' });

function bounded(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${label} must be from 1 to ${maximum}`);
  return value;
}

function selectedServers(available, inventory) {
  return available.filter(name => name !== 'fleet').map(name => ({ name,
    tools: Array.isArray(inventory[name]) ? [...inventory[name]] : [],
  })).filter(server => server.tools.length);
}

function context(value, label) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 4000) throw new TypeError(`${label} must be text under 4000 characters`);
  return value.trim();
}

function environmentText(value) {
  if (value === undefined) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length > 32 || Object.entries(value).some(([key, entry]) =>
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
      || /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH)/i.test(key) || typeof entry !== 'string' || entry.length > 1000)) {
    throw new TypeError('environment must be a plain object of bounded text values without credential fields');
  }
  return Object.entries(value).map(([key, entry]) => `${key}: ${entry}`).join('\n');
}

/** FLUJO subflow team template. One lead plus up to nine local agents per workspace. */
export function buildFactoryTeamSpecs({ model, availableServers = [], availableTools = {},
  limits = {}, specialists, goalContext, environment } = {}) {
  if (typeof model !== 'string' || !model.trim() || !Array.isArray(availableServers)
    || new Set(availableServers).size !== availableServers.length
    || availableServers.some(name => typeof name !== 'string')) throw new TypeError('Model and connected server inventory are required');
  if (!availableTools || typeof availableTools !== 'object' || Array.isArray(availableTools)) {
    throw new TypeError('Tool inventory must be an object');
  }
  for (const [name, tools] of Object.entries(availableTools)) {
    if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !tool.trim())
      || new Set(tools).size !== tools.length)) throw new TypeError(`Invalid observed tool names for ${name}`);
  }
  const agentTurns = bounded(limits.agentTurns, 200, 200, 'agentTurns');
  const leadTurns = bounded(limits.leadTurns, 600, 600, 'leadTurns');
  const requested = bounded(limits.concurrency, 9, 9, 'concurrency');
  const connected = availableServers.filter(name => name !== 'fleet');
  if (specialists) validateSpecialists(specialists, model);
  const agentServers = specialists ? specialistAgentServers(specialists, model, connected) : connected;
  const concurrency = specialists ? Math.min(requested, specialists.topologyTarget.specialistSubflowsPerWorker) : requested;
  const roleGuide = specialists ? `\nAssign specialist briefs with CASE_ID, AGENT_ID, ROLE_ID, ANGLE, TASK and DONE_WHEN.\n` +
    specialists.roles.map(role => `${role.id}: ${role.mission} ${role.instructions} Evidence: ${role.evidence}`).join('\n') : '';
  const goal = context(goalContext, 'goalContext');
  const surroundings = environmentText(environment);
  const shared = `${goal ? `\nGoal context: ${goal}` : ''}${surroundings ? `\nEnvironment:\n${surroundings}` : ''}`;
  const principles = `Use the tools actually attached to this flow; never claim an action or result without its receipt. ` +
    `Reuse relevant installed upstream code and contracts before making a small adapter or product change. ` +
    `Deliver a bounded, useful product change where the task calls for one. Coordinate concisely on an available shared board and linked issue or PR. ` +
    `An independent reviewer must assess another person's implementation before merge or deployment. ` +
    `Keep meaningful checks for authentication, consent, idempotency and action receipts; avoid repeated evidence capture once checks pass. ` +
    `Categorize the recent hour as implementation, integration, design, review, tests, docs, operations or blocked; when tests exceed development, return to a usable slice. ` +
    `Hold a shared Git integration lease only during a write. Reconcile an uncertain push against the exact remote ref before retrying. ` +
    `Never expose credentials or customer data. Preserve uncertain external outcomes before retrying.`;
  const agentPrompt = `You are a general-purpose agent in a FLUJO team. Work in the team's shared workspace on your assigned task.${shared}\n` +
    `${principles} Ask the parent through subflow_send_message when blocked. Report what is verified and unknown.${roleGuide}`;
  const teamPrompt = `You lead a general-purpose FLUJO team for a FACTORY task. One native subflow gate admits at most ${concurrency} local agent runs. ` +
    `Give each admitted agent a concrete task and acceptance condition; you can also implement or independently review work yourself.${shared}\n` +
    `${principles} Wait on original subflow conversation IDs for real terminal results. A queued or timed-out subflow is unfinished. ` +
    `Use only the workspace and communication tools actually attached; do not infer another Worker or machine exists.${roleGuide}`;
  const agent = { name: FACTORY_FLOW_NAMES.agent, description: 'General-purpose agent in a shared FLUJO workspace.',
    nodes: [
      { key: 'start', type: 'start', label: 'Start', prompt: agentPrompt },
      { key: 'agent', type: 'process', label: 'Agent', model, prompt: 'Complete the assigned task and report the observed result.',
        servers: selectedServers(agentServers, availableTools), maxTurns: agentTurns },
      { key: 'finish', type: 'finish' },
    ], edges: [{ from: 'start', to: 'agent' }, { from: 'agent', to: 'finish' }] };
  const team = { name: FACTORY_FLOW_NAMES.team, description: 'General-purpose lead with a bounded native FLUJO subflow gate.',
    nodes: [
      { key: 'start', type: 'start', label: 'Start', prompt: teamPrompt },
      { key: 'lead', type: 'process', label: 'Lead', model, prompt: 'Deliver and coordinate the admitted task.',
        servers: selectedServers(connected, availableTools), maxTurns: leadTurns },
      { key: 'agents', type: 'subflow', label: 'agent', flow: FACTORY_FLOW_NAMES.agent,
        concurrencyLimit: concurrency, inputMode: 'isolated',
        prompt: 'Ask your parent for your assigned task with subflow_send_message.', outputMode: 'final-only' },
      { key: 'finish', type: 'finish' },
    ], edges: [{ from: 'start', to: 'lead' }, { from: 'lead', to: 'agents' }, { from: 'lead', to: 'finish' }] };
  return [agent, team];
}
