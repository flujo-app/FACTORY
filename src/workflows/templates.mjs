const definitions = [
  ['verified-task', 'Produce a candidate, independently review it, execute required checks, and revise unresolved findings.', ['candidate', 'review', 'verification'], ['requirement', 'acceptance']],
  ['repository-maintenance', 'Reconcile existing issue/PR ownership and upstream revision before repair; preserve one integration owner and repository delivery gates.', ['git-bundle', 'review', 'verification', 'delivery'], ['repository', 'baseline', 'issueOrPR', 'deliveryPolicy']],
  ['integration-migration', 'Decompose component work into dependent tasks and verify preserved interfaces against the original compatibility contract.', ['git-bundle', 'interface-contract', 'review', 'verification'], ['components', 'compatibilityContract', 'integrationOwner']],
  ['research-synthesis', 'Produce source-backed claims, independently check coverage and reasoning, and retain uncertainties alongside objective checks.', ['report', 'sources', 'review', 'verification'], ['question', 'sourcePolicy', 'coverageCriteria']],
  ['continuous-improvement', 'Maintain a persistent backlog, act on new evidence, and curate accepted reusable findings with applicability and provenance.', ['candidate', 'review', 'verification', 'knowledge'], ['backlog', 'successCriteria', 'reviewTriggers']],
];
export function listWorkflowTemplates() {
  return definitions.map(([name, description, artifactTypes, requiredContext]) => ({ schemaVersion: 1, name, revision: 1, description,
    roles: { implementer: 'developer', reviewer: 'verifier', supervisor: 'coordinator' },
    transitions: ['ready', 'running', 'review', 'verification', 'revision_required', 'accepted', 'delivered'],
    artifactTypes, requiredContext, completion: 'Independent semantic approval and every declared objective gate on the same immutable candidate.',
    wakeOn: ['assignment_available', 'candidate_submitted', 'review_recorded', 'verification_recorded', 'dependency_ready', 'resumed'],
    knowledge: { provenanceRequired: true, acceptedSourcesOnly: true, retrievalLimit: 8 },
  }));
}
export function getWorkflowTemplate(name = 'verified-task') {
  const value = listWorkflowTemplates().find(template => template.name === name);
  if (!value) throw new TypeError('Unknown workflow template.');
  return value;
}
export function buildWorkflowTask(name, input) {
  const template = getWorkflowTemplate(name);
  for (const field of template.requiredContext) if (!input.context?.[field]) throw new TypeError(`Template context requires ${field}.`);
  return { ...input, template: { name: template.name, revision: template.revision } };
}
