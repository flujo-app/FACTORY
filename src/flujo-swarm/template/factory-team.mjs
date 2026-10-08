import { CASE_SPECIALISTS_V1, validateSpecialists, specialistAgentServers } from './specialists.mjs';

export { CASE_SPECIALISTS_V1 };
export const FACTORY_FLOW_NAMES = Object.freeze({ agent: 'swarm_agent', team: 'swarm_team' });

const TOOLS = Object.freeze({
  filesystem: ['read_file', 'write_file', 'edit_file', 'list_dir', 'search', 'create_directory'],
  bash: ['run', 'start', 'status', 'wait', 'kill', 'write_stdin', 'list_sessions'],
  browser: ['browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_close'],
  flujo: ['kv_get', 'kv_set', 'list_flows', 'read_flow', 'list_conversations', 'read_conversation'],
});

function bounded(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${label} must be from 1 to ${maximum}`);
  return value;
}

function selectedServers(available, inventory) {
  return available.filter(name => Object.hasOwn(TOOLS, name)).map(name => ({ name,
    tools: Array.isArray(inventory[name]) ? TOOLS[name].filter(tool => inventory[name].includes(tool)) : [],
  })).filter(server => server.tools.length);
}

/** FLUJO subflow team template. One lead plus up to nine local agents per workspace. */
export function buildFactoryTeamSpecs({ model, availableServers = [], availableTools = {},
  limits = {}, specialists } = {}) {
  if (typeof model !== 'string' || !model.trim() || !Array.isArray(availableServers)
    || new Set(availableServers).size !== availableServers.length
    || availableServers.some(name => typeof name !== 'string')) throw new TypeError('Model and connected server inventory are required');
  if (!availableTools || typeof availableTools !== 'object' || Array.isArray(availableTools)) {
    throw new TypeError('Tool inventory must be an object');
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
  const agentPrompt = `You are one agent in a FLUJO team. Work in the team's shared workspace. Follow the assigned angle and role.\n` +
    `Use only tools attached to this flow. Record exact findings and file paths; do not claim a tool ran unless you observed its result.\n` +
    `Ask the parent through subflow_send_message when blocked. Report what is verified and what remains unknown.${roleGuide}`;
  const teamPrompt = `You lead one FLUJO team for a FACTORY task. You may start at most ${concurrency} local agent subflows.\n` +
    `These agents share this workspace; give each a distinct file path and self-contained task.\n` +
    `Split the goal into independent angles, wait for their actual results, compare evidence, and request an independent check.\n` +
    `A queued or timed-out subflow is still unfinished. Preserve its conversation ID and continue waiting or report uncertainty.\n` +
    `Do not claim another Worker, machine, board, or fleet tool exists in this workspace.${roleGuide}`;
  const agent = { name: FACTORY_FLOW_NAMES.agent, description: 'One evidence-focused agent in a shared FLUJO workspace.',
    nodes: [
      { key: 'start', type: 'start', label: 'Start', prompt: agentPrompt },
      { key: 'agent', type: 'process', label: 'Agent', model, prompt: 'Complete the assigned task and report evidence.',
        servers: selectedServers(agentServers, availableTools), maxTurns: agentTurns },
      { key: 'finish', type: 'finish' },
    ], edges: [{ from: 'start', to: 'agent' }, { from: 'agent', to: 'finish' }] };
  const team = { name: FACTORY_FLOW_NAMES.team, description: 'Team lead with a bounded local FLUJO subflow gate.',
    nodes: [
      { key: 'start', type: 'start', label: 'Start', prompt: teamPrompt },
      { key: 'lead', type: 'process', label: 'Lead', model, prompt: 'Run the evidence and review cycle.',
        servers: selectedServers(connected, availableTools), maxTurns: leadTurns },
      { key: 'agents', type: 'subflow', label: 'agent', flow: FACTORY_FLOW_NAMES.agent,
        concurrencyLimit: concurrency, inputMode: 'isolated',
        prompt: 'Ask your parent for your assigned task with subflow_send_message.', outputMode: 'final-only' },
      { key: 'finish', type: 'finish' },
    ], edges: [{ from: 'start', to: 'lead' }, { from: 'lead', to: 'agents' }, { from: 'lead', to: 'finish' }] };
  return [agent, team];
}
