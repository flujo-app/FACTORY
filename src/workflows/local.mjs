import { FactoryWorkflow } from './engine.mjs';
import { callWorkflowTool, workflowTools } from './tools.mjs';
import { startVerification, reconcileVerification, runVerification } from './verifier.mjs';
import { captureGitSource } from './source.mjs';

export const localWorkflowTools = workflowTools.concat([{
  name: 'factory_verification', description: 'Execute or reconcile a declared objective gate on an exact clean candidate checkout. Scope authorization is explicit.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['capture','start','run','reconcile'] }, runId: { type: 'string' }, candidateId: { type: 'string' }, gateId: { type: 'string' }, cwd: { type: 'string' }, repository: { type: 'string' }, baseline: { type: 'string' }, environment: { type: 'object' },
  } },
}]);
export async function callLocalWorkflowTool(database, name, args = {}, {actor='root',allowedScopes=['development']} = {}) {
  if (Object.hasOwn(args,'actor') || Object.hasOwn(args,'allowedScopes')) throw new Error('Actor and verification policy are bound by the trusted launcher, not tool arguments.');
  const workflow = new FactoryWorkflow(database);
  try {
    if (name === 'factory_verification') {
      if (args.action === 'capture') return captureGitSource(workflow.artifacts, args.cwd, args);
      if (actor !== 'root') throw new Error('Executable verification requires the trusted supervisor process.');
      if (args.action === 'start') return startVerification(workflow, {...args,allowedScopes});
      if (args.action === 'run') return await runVerification(workflow, {...args,allowedScopes});
      if (args.action === 'reconcile') return reconcileVerification(workflow, args.runId);
      throw new TypeError('Unknown verification action.');
    }
    return callWorkflowTool(workflow, actor, name, args);
  } finally { workflow.close(); }
}
