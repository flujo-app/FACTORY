import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FactoryControl,digest } from './control.mjs';
import { SpendingLedger } from './spending.mjs';
import { validateNativeMission } from './native-mission-contract.mjs';
import { claimNativeMission,runNativeMission,observeNativeMission } from './native-mission.mjs';
import { assertWorkerPowerController } from './worker-power.mjs';

function check(value){if(!value)throw Object.assign(new Error('Invalid native cell configuration.'),{code:'NATIVE_CELL_PROFILE'});}
function closed(value,keys){check(value && Object.getPrototypeOf(value)===Object.prototype && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k)));}
const terminal=new Set(['completed','cancelled','delivered','rejected']);
function target(m){return {cellId:m.cellId,app:m.app,provisionKey:m.provisionKey,worker:m.worker};}
/** An explicit queue worker at the authoritative coordinator, not a replicated spending ledger. */
export function createNativeCell({control,paidAdmission,client,privateFiles,profile,powerScheduling=null}) {
  check(control instanceof FactoryControl && paidAdmission instanceof SpendingLedger);
  closed(profile,['cellId','app','provisionKey','worker','outputDirectory','ttlMs','pollMs']);
  // Reuse the closed native identity contract without manufacturing a runnable assignment.
  validateNativeMission({schemaVersion:1,missionId:'0'.repeat(32),...target(profile),flowId:'profile',flowSha256:'0'.repeat(64),paid:{provider:'fly',ceilingCents:1}});
  check(path.isAbsolute(profile.outputDirectory??'') && Number.isSafeInteger(profile.ttlMs) && profile.ttlMs>=1000 && profile.ttlMs<=86400000
    && Number.isSafeInteger(profile.pollMs) && profile.pollMs>=100 && profile.pollMs<=60000);
  check(client && ['prepare','dispatch','observe'].every(k=>typeof client[k]==='function') && digest(client.binding)===digest(profile.worker));
  check(privateFiles && ['ensurePrivateDirectory','readPrivateJson','writePrivateJson'].every(k=>typeof privateFiles[k]==='function'));
  const binding=structuredClone(target(profile)),options=structuredClone(profile),bindingDigest=digest(binding);
  let power=null;
  if(powerScheduling!==null){
    closed(powerScheduling,['controller','managementLease','wakeCeilingCents']);
    assertWorkerPowerController(powerScheduling.controller,control,paidAdmission,binding);
    check(Number.isSafeInteger(powerScheduling.wakeCeilingCents) && powerScheduling.wakeCeilingCents>0);
    power={controller:powerScheduling.controller,managementLease:structuredClone(powerScheduling.managementLease),wakeCeilingCents:powerScheduling.wakeCeilingCents};
  }
  const schedulePower=signal=>power.controller.schedule(power.managementLease,{wakeCeilingCents:power.wakeCeilingCents,signal});
  const matches=task=>task.specification.taskType!=='operation' && task.specification.nativeMission && digest(target(task.specification.nativeMission))===bindingDigest;
  let busy=false,running=false,lastAttempted=null;
  async function tick({signal}={}) {
    check(!busy);busy=true;
    try {
      if(signal?.aborted)return {state:'stopped'};
      const snapshot=control.status(),tasks=snapshot.tasks.filter(matches),byId=new Map(tasks.map(task=>[task.id,task]));
      const effects=snapshot.effects.filter(effect=>effect.scope==='task' && byId.has(effect.scope_id));
      const children=effects.filter(effect=>effect.kind==='model_step');
      const childBlocker=children.find(effect=>['accepted','running','unknown'].includes(effect.state));
      if(childBlocker)return {state:'blocked',taskId:childBlocker.scope_id,key:childBlocker.key,effectState:childBlocker.state,reason:'model_step_reconciliation_required',runtimeAdmission:'HOLD'};
      for(const task of tasks.filter(task=>control.requiresOriginalModelStep(task.id))) {
        const parent=effects.find(effect=>effect.kind==='flow_call' && effect.scope_id===task.id);
        if(parent && !control.modelStepCompletion(parent.key).complete)return {state:'blocked',taskId:task.id,key:parent.key,reason:'model_step_manifest_incomplete',runtimeAdmission:'HOLD'};
        return {state:'blocked',taskId:task.id,reason:'original_model_step_runtime_hold',runtimeAdmission:'HOLD'};
      }
      await privateFiles.ensurePrivateDirectory(options.outputDirectory);
      // Reconciliation precedes the factory/paid admission switches and never obtains a new POST.
      const unresolved=effects.filter(effect=>effect.kind!=='model_step' && ['accepted','running','unknown'].includes(effect.state));
      if(unresolved.length){
        const observations=[];
        for(const effect of unresolved){
          const history=control.db.prepare("SELECT details FROM events WHERE type='native_mission_admitted' AND subject=?").all(effect.key);
          const original=history.length===1?JSON.parse(history[0].details).request:null;
          if(!original || original.outputFile!==path.join(options.outputDirectory,byId.get(effect.scope_id).specification.nativeMission.missionId+'.private.json'))
            return {state:'blocked',taskId:effect.scope_id,key:effect.key,reason:'output_binding'};
          if(effect.kind!=='flow_call' || effect.state==='accepted')return {state:'blocked',taskId:effect.scope_id,key:effect.key,effectState:effect.state,reason:'original_intent_requires_operator'};
          const outcome=await observeNativeMission({control,key:effect.key,client,privateFiles});
          observations.push({taskId:effect.scope_id,key:effect.key,effectState:outcome.effect.state});
        }
        return {state:observations.every(row=>row.effectState==='succeeded')?'recovered':'unresolved',observations};
      }
      if(power){const observation=await power.controller.reconcile();if(observation!==null)return observation;}
      if(snapshot.control.status!=='active')return {state:'paused'};
      try{paidAdmission.assertAdmission();}catch(error){if(error.code==='PAUSED')return {state:'paid_paused'};throw error;}
      const unfinished=tasks.filter(task=>!terminal.has(task.status));
      for(const task of unfinished.filter(task=>task.status==='running' && !effects.some(effect=>effect.scope_id===task.id))){
        if(task.owner!==binding.cellId)return {state:'blocked',taskId:task.id,reason:'assignment_owner'};
        if(task.control_epoch===snapshot.control.epoch && task.expires>control.clock())return {state:'busy',taskId:task.id};
        control.releaseUnstartedNativeMission({taskId:task.id,expectedAttempt:task.epoch,expectedSpecDigest:task.spec_digest,
          expectedFactoryEpoch:snapshot.control.epoch,workerProof:binding.worker});
        return {state:'released',taskId:task.id};
      }
      const ready=unfinished.filter(task=>task.status==='ready');
      const eligible=ready.filter(task=>!effects.some(effect=>effect.scope_id===task.id));
      if(!eligible.length){
        if(ready.length)return {state:'blocked',taskId:ready[0].id,reason:'lifetime_intent_exists'};
        const awaiting=unfinished.find(task=>effects.some(effect=>effect.scope_id===task.id && effect.state==='succeeded'));
        if(awaiting)return {state:'awaiting_review',taskId:awaiting.id};
        const stopped=unfinished.find(task=>effects.some(effect=>effect.scope_id===task.id));
        if(stopped)return{state:'blocked',taskId:stopped.id,reason:'lifetime_intent_exists'};
        if(power){const status=await schedulePower(signal);if(status.state!=='ready')return status;}
        return{state:'idle'};
      }
      const spend=paidAdmission.snapshot();
      const pivot=lastAttempted===null?0:eligible.findIndex(task=>task.id>lastAttempted),offset=pivot<0?0:pivot;
      const ordered=[...eligible.slice(offset),...eligible.slice(0,offset)];
      const task=spend.overCommittedCents===0?ordered.find(task=>task.specification.nativeMission.paid.ceilingCents<=spend.unallocatedCents):null;
      if(!task)return {state:'budget',taskId:ordered[0].id,unallocatedCents:spend.unallocatedCents};
      if(signal?.aborted)return {state:'stopped'};
      if(power){const status=await schedulePower(signal);if(status.state!=='ready')return status;}
      lastAttempted=task.id;
      const outputFile=path.join(options.outputDirectory,task.specification.nativeMission.missionId+'.private.json');
      const lease=await claimNativeMission({control,taskId:task.id,client,outputFile,ttlMs:options.ttlMs});
      // A process interruption here admits no external action. Expiry permits the guarded release above.
      if(signal?.aborted)return {state:'stopped'};
      const outcome=await runNativeMission({control,lease,client,paidAdmission,privateFiles,outputFile,signal});
      return {state:outcome.dispatched?'dispatched':'blocked',taskId:task.id,key:outcome.effect.key,effectState:outcome.effect.state};
    }catch(error){
      const reasons={STALE:'assignment_changed',PAUSED:'factory_paused',BUSY:'assignment_busy',UNRECONCILED:'original_intent_requires_operator',
        NATIVE_MISSION_UNSTARTED:'unstarted_assignment_changed',NATIVE_MISSION_TARGET:'worker_target_unavailable',NATIVE_MISSION_UNRESOLVED:'worker_not_ready',
        NATIVE_MISSION_HISTORY:'mission_history',NATIVE_MISSION_CONFLICT:'native_conflict',NATIVE_MISSION_UNAVAILABLE:'worker_not_ready',
        WORKER_POWER_UNAVAILABLE:'worker_power_unavailable',WORKER_POWER_BUSY:'worker_power_busy',WORKER_POWER_QUEUE:'queue_demand_changed',
        WORKER_POWER_BINDING:'worker_power_binding',WORKER_POWER_STOPPED:'worker_power_stopped'};
      if(reasons[error.code])return {state:'blocked',reason:reasons[error.code]};
      throw error;
    }finally{busy=false;}
  }
  async function run({signal,onChange=()=>{}}={}) {
    check(!running && !busy && typeof onChange==='function');running=true;let previous=null;
    try{
      while(!signal?.aborted){
        const status=await tick({signal}),current=digest(status);
        if(current!==previous){await onChange(status);previous=current;}
        if(signal?.aborted)break;
        try{await delay(options.pollMs,undefined,{signal});}catch(error){if(error.name!=='AbortError')throw error;}
      }
      return {state:'stopped'};
    }finally{running=false;}
  }
  return {tick,run};
}
