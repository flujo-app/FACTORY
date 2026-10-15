import { listWorkflowTemplates, getWorkflowTemplate, buildWorkflowTask } from './templates.mjs';

export const workflowTools = [
  ['factory_workflow', 'Read or advance durable candidate/review workflows. Acceptance is derived from independent review plus executable gates.', {
    action: { type: 'string', enum: ['create','get','list','claim','submit','review','revise','pause','packet','next'] },
    taskId: { type: 'string' }, candidateId: { type: 'string' }, paused: { type: 'boolean' }, input: { type: 'object' },
  }],
  ['factory_workflow_events', 'Read filtered incremental workflow events. Persist the returned cursor, including empty pages.', {
    after: { anyOf:[{type:'integer',const:0},{type:'string'}] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, taskId: { type: 'string' }, types: { type: 'array', items: { type: 'string' } },
  }],
  ['factory_artifact', 'Publish immutable portable bytes or read verified chunks by sha256 reference. Compose chunk refs for larger artifacts.', {
    action: { type: 'string', enum: ['put','read','describe','compose'] }, data: { type: 'string' }, ref: { type: 'string' }, refs: { type: 'array', maxItems: 512, items: { type: 'string' } }, offset: { type: 'integer' }, length: { type: 'integer' },
  }],
  ['factory_knowledge', 'Retrieve focused accepted knowledge or curate a version with accepted candidate provenance.', {
    action: { type: 'string', enum: ['search','curate'] }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, input: { type: 'object' },
  }],
  ['factory_workflow_templates', 'List, read or instantiate executable workflow contracts.', {
    action: { type: 'string', enum: ['list','get','build'] }, name: { type: 'string' }, input: { type: 'object' },
  }],
].map(([name,description,properties]) => ({ name, description, inputSchema: { type: 'object', properties, additionalProperties: false } }));

export function callWorkflowTool(workflow, actor, name, args = {}, { supervisor = false, authorize = () => {} } = {}) {
  const coordinator = () => { if (!supervisor) workflow.actor(actor, ['coordinator']); };
  if (name === 'factory_workflow') {
    if (args.action === 'create') { coordinator(); authorize(args.input); return workflow.createTask(args.input); }
    if (args.action === 'get') return workflow.getTask(args.taskId);
    if (args.action === 'list') return { tasks: workflow.listTasks() };
    if (args.action === 'packet') return workflow.reviewPacket(args.candidateId);
    if (args.action === 'next') return { actions: workflow.nextActions(actor) };
    if (args.action === 'claim') return workflow.claim(args.taskId, actor, args.input);
    if (args.action === 'submit') return workflow.submit(args.taskId, actor, args.input);
    if (args.action === 'review') return workflow.review(args.candidateId, actor, args.input);
    if (args.action === 'revise') return workflow.revise(args.taskId, actor);
    if (args.action === 'pause') { coordinator(); authorize(workflow.getTask(args.taskId)); return workflow.pauseTask(args.taskId, args.paused, actor); }
  }
  if (name === 'factory_workflow_events') return workflow.events({ ...args, ...(supervisor ? {} : { actor }) });
  if (name === 'factory_artifact') {
    if (args.action === 'put') {
      if (typeof args.data !== 'string' || args.data.length > 1400000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) throw new TypeError('Supply at most 1 MiB of base64 artifact bytes per chunk.');
      return workflow.artifacts.put(Buffer.from(args.data,'base64'));
    }
    if (args.action === 'read') return workflow.artifacts.readChunk(args.ref, args);
    if (args.action === 'describe') return workflow.artifacts.describe(args.ref);
    if (args.action === 'compose') {
      if (!Array.isArray(args.refs) || !args.refs.length || args.refs.length > 512) throw new TypeError('Supply 1–512 chunk references.');
      let size = 0; const chunks = args.refs.map(ref => { const bytes = workflow.artifacts.get(ref); size += bytes.length; if (size > 128 * 1024 * 1024) throw new TypeError('Cloud artifact limit is 128 MiB.'); return bytes; });
      return workflow.artifacts.put(Buffer.concat(chunks));
    }
  }
  if (name === 'factory_knowledge') {
    if (args.action === 'search') return { records: workflow.searchKnowledge(args.query, { limit: args.limit }) };
    if (args.action === 'curate') return workflow.curateKnowledge(args.input, actor);
  }
  if (name === 'factory_workflow_templates') {
    if (args.action === 'list') return { templates: listWorkflowTemplates() };
    if (args.action === 'get') return getWorkflowTemplate(args.name);
    if (args.action === 'build') return buildWorkflowTask(args.name, args.input);
  }
  throw new TypeError('Unknown workflow tool/action.');
}
