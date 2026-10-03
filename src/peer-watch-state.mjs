import { createHash } from 'node:crypto';
import { requirePeer, wireBytes } from './peer-messaging.mjs';

export const WATCH_FORMAT = 'factory-peer-watch-state';
export const WATCH_PAGE_LIMIT = 256;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function exactWatch(value, keys) {
  requirePeer(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value,key)), 'WATCH_SHAPE');
}
function integer(value,min=0) { requirePeer(Number.isSafeInteger(value) && value>=min,'WATCH_SHAPE'); }
function member(value,list) { requirePeer(list.includes(value),'WATCH_SHAPE'); }
const sha = value => createHash('sha256').update(wireBytes(value)).digest('hex');
export function validateHealthProjection(value) {
  exactWatch(value,['availability','observedAt','controller','paid']);member(value.availability,['available','unavailable']);
  if(value.availability==='unavailable')requirePeer(value.observedAt===null && value.controller===null,'WATCH_SHAPE');
  else {
    integer(value.observedAt);const c=value.controller;
    exactWatch(c,['revision','epoch','status','cell','unresolvedEffects','effectsDrained','workerQuiescence','logical']);
    integer(c.revision);integer(c.epoch,1);member(c.status,['active','paused']);integer(c.unresolvedEffects);
    requirePeer(c.effectsDrained===(c.unresolvedEffects===0) && c.workerQuiescence==='unverified','WATCH_SHAPE');
    exactWatch(c.cell,['id','role','status','heartbeat']);requirePeer(typeof c.cell.id==='string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(c.cell.id),'WATCH_SHAPE');
    member(c.cell.role,['developer','verifier','watcher','coordinator']);member(c.cell.status,['reserved','ready','retired']);member(c.cell.heartbeat,['fresh','stale']);
    const b=c.logical;exactWatch(b,['limitCents','committedCents','unallocatedCents','meteredSpendCents','basis','currency']);
    for(const key of ['limitCents','committedCents','unallocatedCents'])integer(b[key]);
    requirePeer(b.committedCents<=b.limitCents && b.unallocatedCents===b.limitCents-b.committedCents
      && b.meteredSpendCents===null && b.basis==='logical-allocation' && b.currency==='USD','WATCH_SHAPE');
  }
  const p=value.paid;exactWatch(p,['availability','observedAt','revision','limitCents','committedCents','unallocatedCents','overCommittedCents','knownMeteredCents','meteredSpendCents','billingIncomplete','basis','currency']);
  member(p.availability,['available','unavailable','not-configured']);requirePeer(p.basis==='shared-paid-admission-ledger' && p.currency==='USD','WATCH_SHAPE');
  if(value.availability==='unavailable')requirePeer(p.availability==='unavailable','WATCH_SHAPE');
  const fields=['observedAt','revision','limitCents','committedCents','unallocatedCents','overCommittedCents','knownMeteredCents','meteredSpendCents','billingIncomplete'];
  if(p.availability!=='available')requirePeer(fields.every(key=>p[key]===null),'WATCH_SHAPE');
  else {
    for(const key of fields.filter(key=>!['meteredSpendCents','billingIncomplete'].includes(key)))integer(p[key]);
    requirePeer(typeof p.billingIncomplete==='boolean' && p.unallocatedCents===Math.max(0,p.limitCents-p.committedCents)
      && p.overCommittedCents===Math.max(0,p.committedCents-p.limitCents),'WATCH_SHAPE');
    if(p.billingIncomplete)requirePeer(p.meteredSpendCents===null,'WATCH_SHAPE');else {
      integer(p.meteredSpendCents);requirePeer(p.meteredSpendCents===p.knownMeteredCents,'WATCH_SHAPE');
    }
  }
  wireBytes(value);return value;
}
export function validateWatchObservation(value) {
  exactWatch(value,['sampledAt','reachability','authentication','freshness','generation','instanceId','source','sourceRevisions','failure']);
  integer(value.sampledAt);integer(value.generation,1);member(value.reachability,['responding','unreachable']);
  member(value.authentication,['verified','unverified']);member(value.freshness,['fresh','stale','unobserved']);
  member(value.failure,[null,'CONNECTION','DEADLINE','HTTP_REJECTION','HEALTH_LIMIT','RESPONSE_INTERRUPTED','AUTHENTICATION',
    'CREDENTIAL_GENERATION','IDENTITY','INVALID_HEALTH','STALE_HEALTH','SOURCE_UNAVAILABLE','REVISION_REGRESSED']);
  exactWatch(value.sourceRevisions,['controller','paid']);
  for(const revision of Object.values(value.sourceRevisions))if(revision!==null)integer(revision);
  if(value.authentication==='verified') {
    requirePeer(value.reachability==='responding' && typeof value.instanceId==='string' && UUID.test(value.instanceId),'WATCH_SHAPE');validateHealthProjection(value.source);
    requirePeer(value.freshness!=='unobserved','WATCH_SHAPE');
    if(value.freshness==='fresh')requirePeer(value.source.availability==='available' && value.failure===null,'WATCH_SHAPE');
    else requirePeer(['STALE_HEALTH','SOURCE_UNAVAILABLE','REVISION_REGRESSED'].includes(value.failure),'WATCH_SHAPE');
    if(value.source.availability==='available')requirePeer(value.sourceRevisions.controller===value.source.controller.revision
      && value.sourceRevisions.paid===(value.source.paid.availability==='available'?value.source.paid.revision:null),'WATCH_SHAPE');
    else requirePeer(value.freshness==='stale' && ((value.failure==='SOURCE_UNAVAILABLE' && Object.values(value.sourceRevisions).every(v=>v===null))
      || (value.failure==='REVISION_REGRESSED' && Object.values(value.sourceRevisions).some(v=>v!==null))),'WATCH_SHAPE');
  } else requirePeer(value.instanceId===null && value.source===null && value.freshness==='unobserved'
    && Object.values(value.sourceRevisions).every(v=>v===null),'WATCH_SHAPE');
  if(value.reachability==='unreachable')requirePeer(value.authentication==='unverified','WATCH_SHAPE');
  return value;
}
export function watchFingerprint(observation) {
  validateWatchObservation(observation);const value=structuredClone(observation);delete value.sampledAt;
  if(value.source){delete value.source.observedAt;delete value.source.paid.observedAt;}
  return sha(value);
}
export function nextWatchPayload(previous, observation, {watchId,bindingDigest}) {
  requirePeer(typeof watchId==='string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(watchId) && typeof bindingDigest==='string' && HASH.test(bindingDigest),'WATCH_SHAPE');
  const current=structuredClone(validateWatchObservation(observation));
  const floors=structuredClone(previous?.payload.revisionFloors ?? {controller:null,paid:null});
  let lastTrusted=structuredClone(previous?.payload.lastTrustedSource ?? null);
  if(current.authentication==='verified') {
    const source=current.source,{controller:c,paid:p}=current.sourceRevisions;
    const regressed=(c!==null && floors.controller!==null && c<floors.controller)||(p!==null && floors.paid!==null && p<floors.paid);
    if(c!==null)floors.controller=Math.max(floors.controller??0,c);if(p!==null)floors.paid=Math.max(floors.paid??0,p);
    if(regressed){current.freshness='stale';current.failure='REVISION_REGRESSED';current.source={availability:'unavailable',observedAt:null,controller:null,
      paid:{availability:'unavailable',observedAt:null,revision:null,limitCents:null,committedCents:null,unallocatedCents:null,overCommittedCents:null,
        knownMeteredCents:null,meteredSpendCents:null,billingIncomplete:null,basis:'shared-paid-admission-ledger',currency:'USD'}};}
    if(!regressed && current.freshness==='fresh') {
      lastTrusted=structuredClone(source);
      if(p===null && previous?.payload.lastTrustedSource?.paid.availability==='available')
        lastTrusted.paid=structuredClone(previous.payload.lastTrustedSource.paid);
    }
  }
  const payload={format:WATCH_FORMAT,schemaVersion:1,watchId,bindingDigest,episode:(previous?.payload.episode??0)+1,
    previousMessageId:previous?.messageId??null,previousDigest:previous?.digest??null,semanticDigest:watchFingerprint(current),
    observation:current,revisionFloors:floors,lastTrustedSource:lastTrusted};
  wireBytes(payload);return payload;
}
export function validateWatchPayload(payload, previous, binding) {
  exactWatch(payload,['format','schemaVersion','watchId','bindingDigest','episode','previousMessageId','previousDigest','semanticDigest','observation','revisionFloors','lastTrustedSource']);
  requirePeer(payload.format===WATCH_FORMAT && payload.schemaVersion===1,'WATCH_SHAPE');
  const expected=nextWatchPayload(previous,payload.observation,binding);
  requirePeer(wireBytes(payload).equals(wireBytes(expected)),'WATCH_CHAIN');
  return payload;
}
