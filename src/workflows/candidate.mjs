import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { FactoryArtifactStore, contentDigest } from './artifacts.mjs';
import { captureWorkspace } from './workspace.mjs';

export const candidateTool = { name:'factory_submit_workspace',description:'Freeze selected local deliverables, upload resumable immutable chunks, renew your claim and submit for independent review. Works for any task without Git. Retry the same submissionId after an uncertain result.',inputSchema:{type:'object',additionalProperties:false,required:['taskId','submissionId','paths','summary'],properties:{taskId:{type:'string'},submissionId:{type:'string'},paths:{type:'array',minItems:1,items:{type:'string'}},summary:{type:'string'},resolvedFindings:{type:'array',items:{type:'string'}}}} };

/** All transport retries retain the original captured bytes and candidate identity. */
export async function submitWorkspaceCandidate({client,cwd,directory,taskId,submissionId,paths,summary,resolvedFindings=[]}) {
  if(!isAbsolute(cwd??'')||!isAbsolute(directory??'')||!Array.isArray(paths)||!paths.length||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(submissionId??''))throw new TypeError('Use absolute private paths and a stable submission identity.');
  const intent={taskId,submissionId,paths,summary,resolvedFindings,cwd},key=contentDigest(intent);
  mkdirSync(directory,{recursive:true,mode:0o700});const file=resolve(directory,submissionId+'.json');
  const persist=value=>{const fd=openSync(file+'.next','w',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(file+'.next',file);};
  const store=new FactoryArtifactStore(resolve(directory,'objects'));
  let state=existsSync(file)?JSON.parse(readFileSync(file)):null;
  if(state && state.key!==key)throw new Error('Submission identity is already bound to different inputs.');
  if(!state){const task=await client.task(taskId);const frozen=captureWorkspace(store,cwd,{paths,baseline:task.baseline});state={key,submission:{submissionId,source:frozen.source,artifacts:frozen.artifacts,summary,resolvedFindings},objects:[...frozen.objects,...frozen.artifacts],uploaded:[]};persist(state);}
  if(state.candidate)return state.candidate;
  const task=await client.task(taskId);
  if(task.candidate?.id===submissionId){state.candidate=task.candidate;persist(state);return state.candidate;}
  for(const artifact of state.objects){
    if(state.uploaded.includes(artifact.ref))continue;
    const uploaded=await client.upload(store.get(artifact.ref));if(uploaded.ref!==artifact.ref)throw new Error('Candidate upload identity differs.');
    state.uploaded.push(artifact.ref);persist(state);
  }
  await client.call('factory_workflow',{action:'claim',taskId});
  state.candidate=await client.call('factory_workflow',{action:'submit',taskId,input:state.submission});persist(state);return state.candidate;
}
