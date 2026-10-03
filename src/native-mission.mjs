import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { digest } from './control.mjs';
import { SpendingLedger } from './spending.mjs';
import { nativeMissionRequest, nativeMissionEffectKey } from './native-mission-contract.mjs';

function requireValue(value,code='NATIVE_MISSION_BINDING') { if(!value)throw Object.assign(new Error('Native mission execution could not be confirmed.'),{code}); }
function result(control,key,dispatched=false) {
  const effect=control.effect(key);
  return {dispatched,effect:{key:effect.key,state:effect.state,requestDigest:effect.request_digest,receipt:effect.receipt},
    scope:'Native Flow execution receipt; software review and delivery remain separate.'};
}
function clientBinding(client,request) {
  requireValue(client && ['prepare','dispatch','observe'].every(k=>typeof client[k]==='function') && digest(client.binding)===digest(request.worker));
}
function callInput(request) { return {flowId:request.flowId,flowSha256:request.flowSha256,conversationId:request.conversationId,packet:request.packet}; }
function privateContract(privateFiles) { requireValue(privateFiles && ['readPrivateJson','writePrivateJson','ensurePrivateDirectory'].every(k=>typeof privateFiles[k]==='function'),'NATIVE_MISSION_PRIVATE_OUTPUT'); }
async function finish(control,key,request,observation,privateFiles) {
  requireValue(observation?.state==='completed' && typeof observation.body==='string','NATIVE_MISSION_UNRESOLVED');
  requireValue(Buffer.byteLength(observation.body)<=1048576,'NATIVE_MISSION_OUTPUT_LIMIT');
  privateContract(privateFiles);
  const value={format:'factory-native-mission-result',schemaVersion:1,key,requestDigest:digest(request),
    conversationId:request.conversationId,flowId:request.flowId,body:JSON.parse(observation.body)};
  let existing;
  try{existing=await privateFiles.readPrivateJson(request.outputFile,{maxBytes:2*1048576});}
  catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing!==undefined)requireValue(digest(existing)===digest(value),'NATIVE_MISSION_OUTPUT_CONFLICT');
  else await privateFiles.writePrivateJson(request.outputFile,value,{exclusive:true});
  const bytes=await fs.readFile(request.outputFile);
  requireValue(digest(await privateFiles.readPrivateJson(request.outputFile,{maxBytes:2*1048576}))===digest(value),'NATIVE_MISSION_OUTPUT_CONFLICT');
  control.settleEffect(key,'succeeded',{outputPath:request.outputFile,outputSha256:createHash('sha256').update(bytes).digest('hex')});
}
function unknown(control,key) {
  if(['accepted','running','unknown'].includes(control.effect(key).state))control.settleEffect(key,'unknown',{reason:'External outcome requires reconciliation.'});
}
/** Fresh private assignment. Preparation runs no Flow; enrollment and task claim commit together. */
export async function claimNativeMission({control,taskId,client,outputFile,ttlMs=60000}) {
  const task=control.task(taskId),epoch=control.active().epoch;
  requireValue(task.status==='ready');
  const provisional={scope:'task',scopeId:task.id,cellId:task.specification.nativeMission.cellId,epoch:task.epoch+1,controlEpoch:epoch};
  const request=nativeMissionRequest(task,provisional,outputFile);clientBinding(client,request);
  await client.prepare(callInput(request));
  return control.claimNativeMission({taskId,expectedSpecDigest:task.spec_digest,expectedFactoryEpoch:epoch,workerProof:client.binding,ttlMs});
}
/** Exactly one admitted POST. Existing intents are observed, never sent again. */
export async function runNativeMission({control,lease,client,paidAdmission,privateFiles,outputFile}) {
  requireValue(paidAdmission instanceof SpendingLedger,'NATIVE_MISSION_PAID_LEDGER');privateContract(privateFiles);
  const request=nativeMissionRequest(control.task(lease.scopeId),lease,outputFile);clientBinding(client,request);
  const admission=control.admitNativeMissionEffect(lease,request),key=nativeMissionEffectKey(request);
  if(!admission.fresh)return result(control,key);
  const paidId='paid.'+key;let dispatched=false,pending=null;
  try{
    paidAdmission.reserve({reservationId:paidId,...request.paid});paidAdmission.start(paidId);
    const observation=await client.dispatch(callInput(request),{admitPost(operation){
      return paidAdmission.transaction(()=>{
        paidAdmission.assertAdmission();const row=paidAdmission.row(paidId),snapshot=paidAdmission.snapshot();
        requireValue(row.state==='started' && row.provider===request.paid.provider && row.ceiling_cents===request.paid.ceilingCents
          && (row.charged_cents===null || row.charged_cents<row.ceiling_cents) && snapshot.overCommittedCents===0,'NATIVE_MISSION_PAID_FENCE');
        const started=control.startNativeMissionEffect(lease,key,()=>{
          dispatched=true;
          try{pending=Promise.resolve(operation());}catch(e){pending=Promise.reject(e);}
          void pending.catch(()=>{});return pending;
        });
        return started.pending;
      });
    }});
    requireValue(dispatched,'NATIVE_MISSION_DISPATCH_REQUIRED');
    await finish(control,key,request,observation,privateFiles);
  }catch{
    if(dispatched)unknown(control,key);
    else if(control.effect(key).state==='accepted')control.settleEffect(key,'not_applied',{state:'not_applied'});
    else unknown(control,key);
  }
  return result(control,key,dispatched);
}
/** Authenticated observation may repair native recovery metadata. It cannot run or resume a Flow. */
export async function observeNativeMission({control,key,client,privateFiles}) {
  privateContract(privateFiles);const effect=control.effect(key);
  const rows=control.db.prepare("SELECT details FROM events WHERE type='native_mission_admitted' AND subject=?").all(key);
  requireValue(rows.length===1,'NATIVE_MISSION_HISTORY');const request=JSON.parse(rows[0].details).request;
  const task=control.task(effect.scope_id),lease={scope:'task',scopeId:task.id,cellId:effect.owner,epoch:effect.owner_epoch,controlEpoch:effect.control_epoch};
  requireValue(effect.kind==='flow_call' && effect.request_digest===digest(request) && key===nativeMissionEffectKey(request)
    && digest(request)===digest(nativeMissionRequest(task,lease,request.outputFile)),'NATIVE_MISSION_HISTORY');
  clientBinding(client,request);
  if(['succeeded','not_applied','accepted'].includes(effect.state))return result(control,key);
  requireValue(['running','unknown'].includes(effect.state),'NATIVE_MISSION_HISTORY');
  try{await finish(control,key,request,await client.observe(callInput(request)),privateFiles);}
  catch{unknown(control,key);}
  return result(control,key);
}
