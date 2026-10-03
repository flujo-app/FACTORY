import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export function canonicalMissionPacket(value) {
  if(value===null || typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(canonicalMissionPacket).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalMissionPacket(value[k])).join(',')+'}';
}
const hash=v=>createHash('sha256').update(canonicalMissionPacket(v)).digest('hex');
function check(ok) { if(!ok) throw Object.assign(new Error('The native mission binding is invalid.'),{code:'NATIVE_MISSION_BINDING'}); }
function closed(v,keys) { check(v && Object.getPrototypeOf(v)===Object.prototype && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k))); }
const id=v=>typeof v==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v);
export function validateNativeMission(value) {
  closed(value,['schemaVersion','missionId','cellId','app','provisionKey','worker','flowId','flowSha256','paid']);
  check(value.schemaVersion===1 && /^[a-f0-9]{32}$/.test(value.missionId??'') && id(value.cellId) && id(value.provisionKey));
  check(/^[a-z][a-z0-9-]{2,62}$/.test(value.app??'') && id(value.flowId) && /^[a-f0-9]{64}$/.test(value.flowSha256??''));
  closed(value.worker,['workspace','archiveSha256','compatibility']);
  check(id(value.worker.workspace) && /^[a-f0-9]{64}$/.test(value.worker.archiveSha256??''));
  const c=value.worker.compatibility;
  closed(c,['applicationVersion','snapshotFormatVersion','layoutVersion','workerProtocolVersion',
    ...(c && Object.hasOwn(c,'revision')?['revision']:[])]);
  check(!Object.hasOwn(c,'revision') || typeof c.revision==='string' && /^[a-f0-9]{40}$/.test(c.revision));
  check(typeof c.applicationVersion==='string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(c.applicationVersion));
  check(['snapshotFormatVersion','layoutVersion','workerProtocolVersion'].every(k=>Number.isSafeInteger(c[k]) && c[k]>0));
  closed(value.paid,['provider','ceilingCents']);
  check(/^[a-z][a-z0-9-]{0,31}$/.test(value.paid.provider??'') && Number.isSafeInteger(value.paid.ceilingCents) && value.paid.ceilingCents>0);
  return structuredClone(value);
}
export function nativeMissionRequest(task, lease, outputFile) {
  const mission=validateNativeMission(task.specification.nativeMission);
  check(task.specification.taskType!=='operation' && lease.scope==='task' && lease.scopeId===task.id && lease.cellId===mission.cellId);
  check(Number.isSafeInteger(lease.epoch) && lease.epoch>0 && Number.isSafeInteger(lease.controlEpoch) && lease.controlEpoch>0 && isAbsolute(outputFile??''));
  const packet={format:'factory-native-mission',schemaVersion:1,missionId:mission.missionId,taskId:task.id,specDigest:task.spec_digest,
    attempt:lease.epoch,controlEpoch:lease.controlEpoch,projectId:task.project_id,branch:task.branch,
    baseline:task.specification.baseline,problem:task.specification.problem,acceptance:task.specification.acceptance};
  check(Buffer.byteLength(canonicalMissionPacket(packet))<=65536);
  // Native collection IDs have a 64-character storage bound. Preserve the full digest in the intent.
  const conversationId='factory-'+hash({missionId:mission.missionId,taskId:task.id,specDigest:task.spec_digest,attempt:lease.epoch,controlEpoch:lease.controlEpoch}).slice(0,56);
  return {...mission,conversationId,packet,outputFile};
}
// The lifetime key excludes output destination and lease attempt. Neither may create a second dispatch.
export function nativeMissionEffectKey(request) { return 'mission.'+hash({missionId:request.missionId,taskId:request.packet.taskId,
  specDigest:request.packet.specDigest,cellId:request.cellId,app:request.app,provisionKey:request.provisionKey}); }
