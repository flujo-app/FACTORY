import { FactoryWorkflow } from './engine.mjs';
import { callWorkflowTool, workflowTools } from './tools.mjs';
import { startVerification, reconcileVerification, runVerification } from './verifier.mjs';

export const localWorkflowTools = workflowTools.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema,
  properties: { ...tool.inputSchema.properties, actor: { type: 'string', description: 'Trusted local caller identity; cloud transport binds this to authentication.' } } } })).concat([{
  name: 'factory_verification', description: 'Execute or reconcile a declared objective gate on an exact clean candidate checkout. Scope authorization is explicit.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['start','run','reconcile'] }, runId: { type: 'string' }, candidateId: { type: 'string' }, gateId: { type: 'string' }, cwd: { type: 'string' }, allowedScopes: { type: 'array', items: { type: 'string', enum: ['development','publication','release','live'] } }, environment: { type: 'object' },
  } },
}]);
export async function callLocalWorkflowTool(database, name, args = {}) {
  const workflow = new FactoryWorkflow(database);
  try {
    if (name === 'factory_verification') {
      if (args.action === 'start') return startVerification(workflow, args);
      if (args.action === 'run') return await runVerification(workflow, args);
      if (args.action === 'reconcile') return reconcileVerification(workflow, args.runId);
      throw new TypeError('Unknown verification action.');
    }
    const { actor = 'root', ...input } = args;
    return callWorkflowTool(workflow, actor, name, input);
  } finally { workflow.close(); }
}
