import { FlujoClient } from '../flujo-client.mjs';
import { CASE_SPECIALISTS_V1, FACTORY_FLOW_NAMES } from './factory-team.mjs';

const TEAM_COUNT = CASE_SPECIALISTS_V1.topologyTarget.workers;
const CHILD_COUNT = CASE_SPECIALISTS_V1.topologyTarget.specialistSubflowsPerWorker;

/** Read-only, point-in-time observation of the ten-lead/nine-child SAVIA topology. */
export async function observeSaviaCaseTopology(plan, { origin, token } = {}) {
  if (!plan || !Array.isArray(plan.workers) || plan.workers.length !== TEAM_COUNT
    || typeof origin !== 'string' || !/^https?:\/\//.test(origin)
    || plan.workers.some(worker => !worker || typeof worker.app !== 'string'
      || !Array.isArray(worker.conversations) || worker.conversations.length !== 1
      || worker.conversations[0].input?.request?.flowName !== FACTORY_FLOW_NAMES.team
      || typeof worker.conversations[0].input?.conversationId !== 'string')
    || new Set(plan.workers.map(worker => worker.app)).size !== TEAM_COUNT
    || new Set(plan.workers.map(worker => worker.conversations[0].input.conversationId)).size !== TEAM_COUNT) {
    throw new TypeError('A ten-team SAVIA plan and FLUJO origin are required');
  }
  const teams = [];
  for (const worker of plan.workers) {
    const leadId = worker.conversations[0].input.conversationId;
    const client = new FlujoClient({ origin, workspace: `swarm-${worker.app}`, token });
    const [lead, descendants] = await Promise.all([client.conversation(leadId), client.descendants(leadId)]);
    if (lead.status !== 200 || lead.body?.id !== leadId || descendants.status !== 200
      || !Array.isArray(descendants.body?.items)
      || !Number.isSafeInteger(descendants.body?.total)
      || typeof descendants.body?.hasMore !== 'boolean') {
      throw new Error(`FLUJO could not provide a complete conversation observation for ${worker.app}`);
    }
    const children = descendants.body.items;
    const childIds = children.map(child => child?.id);
    const exactChildren = children.length === CHILD_COUNT
      && descendants.body.total === CHILD_COUNT && !descendants.body.hasMore
      && new Set(childIds).size === CHILD_COUNT
      && children.every(child => typeof child?.id === 'string' && child.id !== leadId
        && child.parentConversationId === leadId);
    const completedChildren = exactChildren && children.every(child => child.status === 'completed');
    const leadCompleted = lead.body?.status === 'completed';
    teams.push({ workerId: worker.id, leadConversationId: leadId,
      leadStatus: lead.body?.status ?? 'unknown', observedChildren: descendants.body.total,
      completedChildren: children.filter(child => child?.status === 'completed').length,
      topologyObserved: exactChildren && leadCompleted && completedChildren });
  }
  return { topologyObserved: teams.every(team => team.topologyObserved),
    expectedLeads: TEAM_COUNT, expectedChildren: TEAM_COUNT * CHILD_COUNT, teams,
    scope: 'Read-only FLUJO conversation snapshot; verifies direct child count and completion, not specialist role quality or provider billing.' };
}
