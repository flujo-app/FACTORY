import path from 'node:path';
import { CASE_SPECIALISTS_V1, FACTORY_FLOW_NAMES } from './factory-team.mjs';

const CASE_ID = /^[a-z][a-z0-9-]{0,19}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TEAMS = CASE_SPECIALISTS_V1.topologyTarget.workers;

/** Build the ten local team launches for one Savia case without starting a provider call. */
export function buildSaviaCasePlan({ caseId, mission, projectId, baseline, model,
  modelConfig, outputDirectory, angles, budgetCents, teamBudgetCents,
  timeoutMs } = {}) {
  if (!CASE_ID.test(caseId ?? '') || typeof mission !== 'string' || !mission.trim()
    || !PROJECT_ID.test(projectId ?? '') || typeof baseline !== 'string' || !baseline.trim()
    || typeof model !== 'string' || !model.trim()
    || typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
    throw new TypeError('Case ID, mission, project, baseline, installed model and absolute output directory are required');
  }
  if (modelConfig !== undefined && (!modelConfig || typeof modelConfig !== 'object'
    || Array.isArray(modelConfig) || modelConfig.id !== model)) {
    throw new TypeError('Model configuration must use the selected installed model ID');
  }
  if (!Array.isArray(angles) || angles.length !== TEAMS
    || angles.some(angle => typeof angle !== 'string' || !angle.trim() || angle.length > 500)
    || new Set(angles.map(angle => angle.trim().toLowerCase())).size !== TEAMS) {
    throw new TypeError(`Provide ${TEAMS} distinct nonempty team angles`);
  }
  if (!Number.isSafeInteger(budgetCents) || budgetCents < 0
    || timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000)) {
    throw new TypeError('Budget and timeout must be bounded nonnegative integers');
  }
  const allocations = teamBudgetCents ?? Array.from({ length: TEAMS }, (_, index) =>
    Math.floor(budgetCents / TEAMS) + (index < budgetCents % TEAMS ? 1 : 0));
  if (!Array.isArray(allocations) || allocations.length !== TEAMS
    || allocations.some(value => !Number.isSafeInteger(value) || value < 0)
    || allocations.reduce((sum, value) => sum + BigInt(value), 0n) > BigInt(budgetCents)) {
    throw new TypeError('Team allocations must fit within the case budget');
  }
  const outputRoot = path.resolve(outputDirectory);
  return {
    caseId, mission: mission.trim(), budgetCents, projectId, baseline: baseline.trim(),
    workers: angles.map((angle, index) => {
      const number = String(index + 1).padStart(2, '0');
      const id = `savia-${caseId}-team-${number}`;
      return {
        id, app: id, budgetCents: allocations[index], purpose: `Savia case ${caseId}: ${angle.trim()}`,
        provisionInput: { app: id, teamTemplate: { model, specialists: CASE_SPECIALISTS_V1 },
          ...(modelConfig === undefined ? {} : { modelConfig }) },
        conversations: [{ id: `${caseId}-team-${number}`,
          input: { conversationId: `savia-${caseId}-team-${number}`,
            request: { flowName: FACTORY_FLOW_NAMES.team,
              prompt: `CASE_ID: ${caseId}\nTEAM_ID: ${id}\nANGLE: ${angle.trim()}\nTASK: ${mission.trim()}\nDONE_WHEN: Produce an evidence-linked synthesis, independent verification, adversarial review and unresolved questions. Do not claim unfinished subflows are complete.` },
            ...(timeoutMs === undefined ? {} : { timeoutMs }) },
          outputPath: path.join(outputRoot, `${id}.txt`) }],
      };
    }),
  };
}
