import { FlujoClient, textOf } from '../flujo-client.mjs';
import { CASE_SPECIALISTS_V1, FACTORY_FLOW_NAMES } from './factory-team.mjs';

const TEAM_COUNT = CASE_SPECIALISTS_V1.topologyTarget.workers;
const CHILD_COUNT = CASE_SPECIALISTS_V1.topologyTarget.specialistSubflowsPerWorker;

/** Read-only, point-in-time observation of the ten-lead/nine-child SAVIA topology. */
export async function observeSaviaCaseTopology(plan, { origin, token, verifyRoleBriefs = false } = {}) {
  if (!plan || !Array.isArray(plan.workers) || plan.workers.length !== TEAM_COUNT
    || typeof origin !== 'string' || !/^https?:\/\//.test(origin)
    || plan.workers.some(worker => !worker || typeof worker.app !== 'string'
      || !Array.isArray(worker.conversations) || worker.conversations.length !== 1
      || worker.conversations[0].input?.request?.flowName !== FACTORY_FLOW_NAMES.team
      || typeof worker.conversations[0].input?.conversationId !== 'string')
    || new Set(plan.workers.map(worker => worker.app)).size !== TEAM_COUNT
    || new Set(plan.workers.map(worker => worker.conversations[0].input.conversationId)).size !== TEAM_COUNT
    || typeof verifyRoleBriefs !== 'boolean'
    || verifyRoleBriefs && (typeof plan.caseId !== 'string' || !plan.caseId)) {
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
    let roleBriefsObserved;
    if (verifyRoleBriefs) {
      const expectedRoles = new Set(CASE_SPECIALISTS_V1.roles.map(role => role.id));
      const roles = new Set(), agents = new Set();
      roleBriefsObserved = exactChildren;
      for (const child of exactChildren ? children : []) {
        const detail = await client.conversation(child.id);
        if (detail.status !== 200 || detail.body?.id !== child.id
          || detail.body?.parentConversationId !== leadId
          || !Array.isArray(detail.body?.messages)) {
          throw new Error(`FLUJO could not provide a bound child conversation for ${worker.app}`);
        }
        const firstUser = detail.body.messages.find(message => message?.role === 'user');
        const brief = textOf(firstUser?.content).slice(0, 4096);
        const assigned = {
          caseIds: [...brief.matchAll(/\bCASE_ID:\s*([a-z][a-z0-9-]*)/g)].map(match => match[1]),
          teamIds: [...brief.matchAll(/\bTEAM_ID:\s*([a-z][a-z0-9-]*)/g)].map(match => match[1]),
          agentIds: [...brief.matchAll(/\bAGENT_ID:\s*([A-Za-z0-9_.-]+)/g)].map(match => match[1]),
          roleIds: [...brief.matchAll(/\bROLE_ID:\s*([a-z][a-z0-9_]*)/g)].map(match => match[1]),
        };
        if (assigned.caseIds.length !== 1 || assigned.caseIds[0] !== plan.caseId
          || assigned.teamIds.length !== 1 || assigned.teamIds[0] !== worker.id
          || assigned.agentIds.length !== 1 || agents.has(assigned.agentIds[0])
          || assigned.roleIds.length !== 1 || !expectedRoles.has(assigned.roleIds[0])
          || roles.has(assigned.roleIds[0])) roleBriefsObserved = false;
        else { agents.add(assigned.agentIds[0]); roles.add(assigned.roleIds[0]); }
      }
      roleBriefsObserved &&= roles.size === expectedRoles.size && agents.size === CHILD_COUNT;
    }
    teams.push({ workerId: worker.id, leadConversationId: leadId,
      leadStatus: lead.body?.status ?? 'unknown', observedChildren: descendants.body.total,
      completedChildren: children.filter(child => child?.status === 'completed').length,
      topologyObserved: exactChildren && leadCompleted && completedChildren,
      ...(verifyRoleBriefs ? { roleBriefsObserved } : {}) });
  }
  return { topologyObserved: teams.every(team => team.topologyObserved),
    ...(verifyRoleBriefs ? { roleBriefsObserved: teams.every(team => team.roleBriefsObserved) } : {}),
    expectedLeads: TEAM_COUNT, expectedChildren: TEAM_COUNT * CHILD_COUNT, teams,
    scope: verifyRoleBriefs
      ? 'Read-only FLUJO snapshot; verifies direct child completion and nine distinct assigned role briefs per team, not work quality or provider billing.'
      : 'Read-only FLUJO conversation snapshot; verifies direct child count and completion, not specialist role quality or provider billing.' };
}
