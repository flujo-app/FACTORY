import { listWorkflowTemplates, getWorkflowTemplate, buildWorkflowTask } from './templates.mjs';
import { readWorkspaceFile, readWorkspaceManifest } from './workspace.mjs';

const gateSchema = {
  type:'object', additionalProperties:false, required:['id','command','args','adapter','scope'],
  properties:{
    id:{type:'string'}, command:{type:'string',description:'Executable name; $node uses the verifier Node binary. Commands execute without a shell.'},
    args:{type:'array',items:{type:'string'}},
    adapter:{type:'string',enum:['exit-code','node-tap','json-summary'],description:'exit-code for assertion scripts and commands with authoritative exit status; node-tap for complete Node TAP results; json-summary for a complete Jest-style result.'},
    scope:{type:'string',enum:['development','publication','release','live'],description:'Must be authorized by the task and trusted verifier.'},
    timeoutMs:{type:'integer',minimum:1},minimumTests:{type:'integer',minimum:1},
    writablePaths:{type:'array',items:{type:'string'},description:'Relative generated-output paths, never reviewed input paths.'},
  },
};
const verificationPolicySchema = {type:'object',additionalProperties:false,required:['mode'],properties:{
  mode:{type:'string',enum:['objective','review-only']},reason:{type:'string',description:'Required for review-only; explain why executable gates do not apply.'},
}};

export const workflowTools = [
  ['factory_candidate_files','Inspect immutable candidate deliverables. Omit path to list files; supply path to read a bounded range, with no local workspace changes.',{candidateId:{type:'string'},path:{type:'string'},offset:{type:'integer',minimum:0},length:{type:'integer',minimum:1,maximum:65536},after:{type:'integer',minimum:0}}],
  ['factory_assign', 'Assign a generic task to your team. The SDK selects its one independent reviewer. Keep the original goal as a parent task and integrate accepted child outputs into its final candidate.', {
    taskId:{type:'string'}, assignee:{type:'string'}, problem:{type:'string'}, acceptance:{type:'string'}, baseline:{type:'string'}, parentTask:{type:'string'}, dependencies:{type:'array',items:{type:'string'}}, gates:{type:'array',items:gateSchema}, verificationPolicy:verificationPolicySchema,
  }],
  ['factory_review', 'Record independent review of an exact immutable candidate. Acceptance requires no unresolved findings; executable checks remain separate.', {
    candidateId:{type:'string'}, accepted:{type:'boolean'}, rationale:{type:'string'}, findings:{type:'array',items:{type:'object',required:['id','requirement','description'],properties:{id:{type:'string'},requirement:{type:'string'},description:{type:'string'}},additionalProperties:false}},
  }],
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
].map(([name,description,properties]) => ({ name, description, inputSchema: { type: 'object', properties, additionalProperties: false,
  ...(name==='factory_assign'?{required:['taskId','assignee','problem','acceptance','verificationPolicy']}:name==='factory_review'?{required:['candidateId','accepted','rationale']}:{}),
} }));

export function callWorkflowTool(workflow, actor, name, args = {}, { supervisor = false, authorize = () => {} } = {}) {
  const coordinator = () => { if (!supervisor) workflow.actor(actor, ['coordinator']); };
  if(name==='factory_candidate_files'){
    const candidate=workflow.candidate(args.candidateId);if(candidate.source.kind!=='workspace')throw new Error('This candidate uses the legacy Git artifact adapter.');
    if(args.path!==undefined)return readWorkspaceFile(workflow.artifacts,candidate.source.snapshot,args.path,args);
    const after=args.after??0;if(!Number.isSafeInteger(after)||after<0)throw new TypeError('Use a nonnegative file offset.');
    const files=readWorkspaceManifest(workflow.artifacts,candidate.source.snapshot).files;
    return{candidateId:candidate.id,snapshot:candidate.source.snapshot,files:files.slice(after,after+100).map(({path,size})=>({path,size})),next:after+100<files.length?after+100:null};
  }
  if (name === 'factory_assign') {
    coordinator();
    const assigned=workflow.db.prepare('SELECT parent_id,role FROM cells WHERE id=?').get(args.assignee);
    if(!assigned)throw new Error('Unknown assigned team member.');
    const team=assigned.role==='coordinator'?args.assignee:assigned.parent_id;
    if(!supervisor && team!==actor)throw new Error('Assign only your own team.');
    const reviewers=workflow.db.prepare("SELECT id FROM cells WHERE parent_id=? AND role='verifier' AND status='ready'").all(team);
    if(reviewers.length!==1)throw new Error('A team must have exactly one independent reviewer.');
    const input={...args,reviewerId:reviewers[0].id};authorize(input);return workflow.createTask(input);
  }
  if(name==='factory_review')return workflow.review(args.candidateId,actor,args);
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
