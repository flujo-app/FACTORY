import { contentDigest, sha256 } from './artifacts.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCloudLitePlan } from '../cloud-lite/protocol.mjs';
import { FactoryCloudLiteFleet } from '../cloud-lite/fleet.mjs';

const revision = value => { if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new TypeError('Pin an immutable Git revision.'); return value; };
const bundle = value => { revision(value?.revision); if (!/^[a-f0-9]{64}$/.test(value?.bundleSha256 ?? '')) throw new TypeError('Pin each runtime package SHA256.'); return value; };

/** Planning is pure: creating a comparison never deploys machines or invokes a model. */
export function createWorkflowComparison({ id, baseline, improved, task, armRepositories, model, subagentModel = model, reasoningEffort = 'medium',
  resources = { machines: 10, agentsPerMachine: 10, cpuKind: 'shared', cpus: 2, memoryMb: 4096, diskGb: 20, region: 'iad' }, validationPolicy, evaluatorRevision }) {
  if (!/^[a-z][a-z0-9-]{2,38}$/.test(id ?? '')) throw new TypeError('Use a short comparison identity.');
  bundle(baseline); bundle(improved); revision(task?.revision); revision(evaluatorRevision);
  if (!task.goal || !task.acceptance || !validationPolicy || !model || !subagentModel) throw new TypeError('Freeze goal, acceptance, validation policy and explicit models.');
  if (!armRepositories || !/^[\w.-]+\/[\w.-]+$/.test(armRepositories.baseline??'') || !/^[\w.-]+\/[\w.-]+$/.test(armRepositories.improved??'')
    || armRepositories.baseline===armRepositories.improved || Object.values(armRepositories).includes(task.repository)) throw new TypeError('Select two isolated comparison repositories, separate from the original source.');
  const shared = { task, resources, model, subagentModel, reasoningEffort, validationPolicy, evaluatorRevision };
  const arms = ['baseline','improved'].map(arm => {
    const runId = `${id}-${arm}`, outputPrefix = `codex/${runId}/`;
    const plan = validateCloudLitePlan({ ...resources, runId, app: runId, repository: armRepositories[arm],
      repositoryRevision: task.revision, model, subagentModel, reasoningEffort,
      ...(arm === 'improved' ? { workflow: 'verified-v1' } : {}),
      goal: `${task.goal}\n\nOriginal acceptance criteria: ${task.acceptance}\nValidation policy: ${typeof validationPolicy === 'string' ? validationPolicy : JSON.stringify(validationPolicy)}\nComparison isolation: start from ${task.revision}; use only output branches beneath ${outputPrefix}. Do not read or copy the other arm's results or shared knowledge. Retain interrupted candidates and evidence if stopped.`,
    });
    return { arm, runtime: arm === 'baseline' ? baseline : improved, plan, namespace: runId, outputPrefix };
  });
  const body = { schemaVersion: 1, id, shared, sharedInputDigest: contentDigest(shared), arms, isolation: {repositories:armRepositories, credentials:'Each arm requires a distinct credential scoped only to its own repository. Shared source and evaluator credentials remain on the supervisor.'},
    evaluation: { unit: 'original task', acceptedBy: 'same independent evaluator and criteria for both arms', interrupted: 'separate outcome; retain all assigned tasks in denominator',
      metrics: ['acceptedResults','resolvedFindings','invalidApprovals','repeatedWork','coordinationMessages','modelTokens','providerCost','recoverySuccess','interruptedTasks'],
      limits: 'No implicit wall-clock deadline. Stop policy is supplied by the experiment operator.' } };
  return { ...body, manifestDigest: contentDigest(body) };
}

/** Explicit execution entry point, for the later real-task session. Both arms retain separate recovery journals. */
export async function launchWorkflowComparison(manifest, { directory, bundlePaths, image, githubTokens, auth, ...fleetOptions }) {
  const { manifestDigest, ...body } = manifest;
  if (contentDigest(body) !== manifestDigest || contentDigest(manifest.shared) !== manifest.sharedInputDigest) throw new Error('Comparison manifest changed.');
  if(!githubTokens?.baseline || !githubTokens?.improved || githubTokens.baseline===githubTokens.improved)throw new Error('Provide distinct credentials scoped to the two isolated comparison repositories.');
  const roots = manifest.arms.map(arm => resolve(directory, arm.namespace));
  if (new Set(roots).size !== 2 || new Set(manifest.arms.map(arm => arm.plan.app)).size !== 2) throw new Error('Comparison arms must be isolated.');
  for (const arm of manifest.arms) if (sha256(readFileSync(bundlePaths[arm.arm])) !== arm.runtime.bundleSha256) throw new Error(`Runtime bundle differs for ${arm.arm}.`);
  const fleets = manifest.arms.map((arm,index) => new FactoryCloudLiteFleet({ ...fleetOptions, directory: roots[index], auth }));
  const results = await Promise.allSettled(fleets.map((fleet,index) => fleet.deploy(manifest.arms[index].plan, { image, githubToken:githubTokens[manifest.arms[index].arm], bundlePath: bundlePaths[manifest.arms[index].arm] })));
  return { manifestDigest, arms: results.map((result,index) => ({ arm: manifest.arms[index].arm, directory: roots[index],
    status: result.status === 'fulfilled' ? 'deployed' : 'requires_reconciliation', ...(result.status === 'rejected' ? { error: result.reason.message } : {}) })), fleets };
}

export function summarizeWorkflowComparison(manifest, records) {
  if(records.some(record=>!manifest.arms.some(arm=>arm.arm===record.arm)))throw new Error('Unknown comparison arm.');
  const matched = manifest.arms.map(({arm})=>records.filter(record=>record.arm===arm).map(record=>record.taskId).sort());
  if(contentDigest(matched[0])!==contentDigest(matched[1]))throw new Error('Comparison arms must include the same original tasks; record pending or interrupted outcomes explicitly.');
  const results = {};
  for (const { arm } of manifest.arms) {
    const values = records.filter(record => record.arm === arm);
    if (new Set(values.map(value => value.taskId)).size !== values.length) throw new Error('Report one final evaluation per original task and arm.');
    for (const record of values) {
      if (!['accepted','failed','interrupted','pending'].includes(record.outcome)) throw new TypeError('Use an explicit evaluation outcome.');
      if (record.outcome === 'accepted' && (!record.evidenceRef || record.evaluatorRevision !== manifest.shared.evaluatorRevision || record.inputDigest !== manifest.sharedInputDigest)) throw new Error('Accepted results require matched independent evaluator evidence.');
    }
    const sum = key => values.length && values.every(value => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) ? values.reduce((total,value) => total + value[key], 0) : null;
    const accepted = values.filter(value => value.outcome === 'accepted').length;
    results[arm] = { assigned: values.length, accepted, failed: values.filter(value => value.outcome === 'failed').length,
      interrupted: values.filter(value => value.outcome === 'interrupted').length, pending: values.filter(value => value.outcome === 'pending').length,
      acceptanceRate: values.length ? accepted / values.length : null, coordinationMessages: sum('coordinationMessages'), modelTokens: sum('modelTokens'),
      providerCost: sum('providerCost'), resolvedFindings: sum('resolvedFindings'), invalidApprovals: sum('invalidApprovals'), repeatedWork: sum('repeatedWork'), recoverySuccess: sum('recoverySuccess') };
  }
  return { comparisonId: manifest.id, manifestDigest: manifest.manifestDigest, results };
}
