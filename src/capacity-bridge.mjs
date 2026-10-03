import { createHash } from 'node:crypto';
import { FactoryControl, FactoryError, digest } from './control.mjs';
import { PeerStore, wireBytes } from './peer-messaging.mjs';
import { SpendingLedger } from './spending.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const ROLES = ['developer','verifier','watcher','coordinator'];
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = code => { throw new FactoryError(code, 'Capacity bridge rejected the configured request.'); };
const requireValue = (value, code='CAPACITY_INVALID') => { if (!value) failure(code); };
function exact(value, keys, optional=[]) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype,null].includes(Object.getPrototypeOf(value))
    && keys.every(key => Object.hasOwn(value,key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key)));
}
function id(value) { requireValue(typeof value === 'string' && ID.test(value)); return value; }
function integer(value, minimum=0) { requireValue(Number.isSafeInteger(value) && value>=minimum); return value; }
function text(value, limit) { requireValue(typeof value === 'string' && value.length>=1 && value.length<=limit && !/[\u0000-\u001f\u007f]/.test(value)); return value; }
function native(value) {
  if (value === null) return null;
  exact(value,['workspace','archiveSha256','compatibility']); id(value.workspace);
  requireValue(HASH.test(value.archiveSha256)); exact(value.compatibility,['applicationVersion','snapshotFormatVersion','layoutVersion','workerProtocolVersion'],['revision']);
  requireValue(!Object.hasOwn(value.compatibility,'revision') || typeof value.compatibility.revision==='string' && /^[a-f0-9]{40}$/.test(value.compatibility.revision));
  text(value.compatibility.applicationVersion,64);
  for (const key of ['snapshotFormatVersion','layoutVersion','workerProtocolVersion']) integer(value.compatibility[key],1);
  return structuredClone(value);
}
function policy(value) {
  const fields=['schemaVersion','grantId','generation','expiresAt','maxChildren','maxBudgetCents','allowedRoles','template','paid','native'];
  exact(value,value?.schemaVersion===2?[...fields,'growthMode']:fields);
  requireValue(value.schemaVersion===1 || value.schemaVersion===2); id(value.grantId); integer(value.generation,1); integer(value.expiresAt,1);
  if (value.schemaVersion===2) requireValue(value.growthMode==='budget-only' && value.maxChildren===null);
  else { integer(value.maxChildren,1); requireValue(value.maxChildren<=1000); }
  integer(value.maxBudgetCents);
  requireValue(Array.isArray(value.allowedRoles) && value.allowedRoles.length>=1 && value.allowedRoles.length<=4
    && new Set(value.allowedRoles).size===value.allowedRoles.length && value.allowedRoles.every(role=>ROLES.includes(role)));
  exact(value.template,['source','workspace','image','org','region','appPrefix','flowIds']);
  const t=value.template; let source; try { source=new URL(t.source); } catch { failure('CAPACITY_INVALID'); }
  requireValue(['http:','https:'].includes(source.protocol) && !source.username && !source.password && !source.search && !source.hash && source.pathname==='/' && source.origin===t.source);
  id(t.workspace); text(t.image,512); requireValue(/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(t.image));
  requireValue(typeof t.org==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(t.org));
  requireValue(typeof t.region==='string' && /^[a-z]{3}$/.test(t.region));
  requireValue(typeof t.appPrefix==='string' && /^[a-z][a-z0-9-]{2,30}$/.test(t.appPrefix));
  requireValue(Array.isArray(t.flowIds) && t.flowIds.length>=1 && t.flowIds.length<=32 && new Set(t.flowIds).size===t.flowIds.length);
  for (const flowId of t.flowIds) id(flowId);
  exact(value.paid,['provider','ceilingCents']); requireValue(value.paid.provider==='fly'); integer(value.paid.ceilingCents,1);
  native(value.native); requireValue(value.native===null || value.native.workspace===t.workspace);
  return structuredClone(value);
}
/** Private trusted input. Never accept a grant or lease from a peer envelope/model argument. */
export function validateCapacityGrant(input) {
  const keys=['schemaVersion','grantId','generation','lease','expiresAt','maxChildren','maxBudgetCents','allowedRoles','template','paid'];
  exact(input,input?.schemaVersion===2?[...keys,'growthMode']:keys,['native']);
  const {lease,...fields}=input;
  exact(lease,['scope','scopeId','cellId','epoch','controlEpoch','expires','token']);
  requireValue(lease.scope==='task'); id(lease.scopeId); id(lease.cellId);
  integer(lease.epoch,1); integer(lease.controlEpoch,1); integer(lease.expires,1);
  requireValue(typeof lease.token==='string' && /^[A-Za-z0-9_-]{43}$/.test(lease.token));
  return { ...policy({...fields,native:fields.native??null}),lease:structuredClone(lease) };
}
export function validateCapacityRequest(request) {
  exact(request,['requestId','role','budgetCents','purpose']); id(request.requestId);
  requireValue(ROLES.includes(request.role)); integer(request.budgetCents,1); text(request.purpose,512);
  requireValue(request.purpose.trim().length>0); return structuredClone(request);
}
function dependencies(control,store) {
  requireValue(control instanceof FactoryControl && store instanceof PeerStore,'CAPACITY_DEPENDENCY');
}
function transport(store) {
  const c=store.config;
  return { local:c.local,peer:c.peer,generation:c.generation,keyDigest:hash(Buffer.from(c.key,'base64url')),
    credentialExpiresAt:c.credentialExpiresAt,endpoint:c.endpoint };
}
function grantPolicy(grant) {
  if (Object.hasOwn(grant,'lease')) { const {lease,...p}=validateCapacityGrant(grant); return p; }
  return policy(grant);
}
export function capacityMessageId(grantId,requestId) { id(grantId); id(requestId); return 'capacity.'+digest({grantId,requestId}); }
/** Synchronous issuance holds the recipient's credential/inbox writer lock until the controller COMMIT. */
export function issueCapacityGrant({control,store,grant}) {
  dependencies(control,store); const g=validateCapacityGrant(grant),{lease,...p}=g;
  return store.transaction(()=>{
    store.assertCurrentCredential(); requireValue(store.config.peer.cellId===lease.cellId,'CAPACITY_AUTHORITY');
    requireValue(g.generation===store.config.generation,'CAPACITY_GRANT_GENERATION');
    requireValue(g.expiresAt<=store.config.credentialExpiresAt,'CAPACITY_GRANT_EXPIRED');
    if (g.schemaVersion===2) {
      const current=control.control().policy;
      requireValue(current.schemaVersion===2 && current.growthMode==='budget-only' && current.maxCells===null && current.maxDepth===null,'CAPACITY_AUTHORITY');
    }
    const task=control.authority(lease);
    const binding={format:'factory-capacity-grant',schemaVersion:p.schemaVersion,policy:p,
      authority:{taskId:lease.scopeId,parentId:lease.cellId,attempt:lease.epoch,controlEpoch:lease.controlEpoch,specDigest:task.spec_digest},
      transport:transport(store),inboxFloor:store.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM peer_inbox').get().n};
    return control.issueCapacityGrant(lease,{...binding,grantDigest:digest(binding)});
  });
}
/** Sender only: persist original advisory intent before the caller uses dispatchPeerMessage. */
export function enqueueCapacityRequest({store,grant,request,nativeProof=null}) {
  requireValue(store instanceof PeerStore,'CAPACITY_DEPENDENCY'); const p=grantPolicy(grant),r=validateCapacityRequest(request),proof=native(nativeProof);
  requireValue(p.allowedRoles.includes(r.role) && r.budgetCents<=p.maxBudgetCents && r.budgetCents<=p.paid.ceilingCents,'CAPACITY_REQUEST');
  requireValue(digest(proof)===digest(p.native),'CAPACITY_NATIVE'); store.assertCurrentCredential();
  requireValue(p.generation===store.config.generation,'CAPACITY_GRANT_GENERATION');
  const messageId=capacityMessageId(p.grantId,r.requestId),old=store.outbox(messageId),createdAt=old?.envelope.createdAt??store.clock();
  return store.enqueue({messageId,type:'capacity_request',createdAt,expiresAt:old?.envelope.expiresAt??Math.min(p.expiresAt,createdAt+86400000),
    payload:{format:'factory-capacity-request',schemaVersion:1,grantId:p.grantId,generation:p.generation,request:r,nativeProof:proof}});
}
function lockedRequest(control,store,g,messageId) {
  store.assertCurrentCredential();
  const issued=control.capacityGrant(g.grantId),{lease,...p}=g;
  requireValue(issued && digest(issued.policy)===digest(p) && issued.policy.generation===g.generation,'CAPACITY_GRANT_GENERATION');
  requireValue(digest(issued.transport)===digest(transport(store)),'CAPACITY_CREDENTIAL');
  requireValue(store.config.peer.cellId===lease.cellId,'CAPACITY_AUTHORITY');
  const envelope=store.readInbox(id(messageId)); requireValue(envelope!==null,'CAPACITY_INBOX');
  const row=store.db.prepare('SELECT sequence,digest FROM peer_inbox WHERE message_id=?').get(messageId);
  requireValue(row.sequence>issued.inboxFloor,'CAPACITY_INBOX_FLOOR');
  exact(envelope.payload,['format','schemaVersion','grantId','generation','request','nativeProof']);
  const payload=envelope.payload;
  requireValue(envelope.type==='capacity_request' && payload.format==='factory-capacity-request' && payload.schemaVersion===1
    && payload.grantId===g.grantId && payload.generation===g.generation,'CAPACITY_REQUEST');
  const request=validateCapacityRequest(payload.request),proof=native(payload.nativeProof);
  requireValue(messageId===capacityMessageId(g.grantId,request.requestId) && digest(proof)===digest(g.native),'CAPACITY_NATIVE');
  requireValue(envelope.expiresAt<=g.expiresAt && envelope.createdAt<=store.clock()+30000,'CAPACITY_REQUEST');
  // Historical status is allowed for exact existing admission; unseen expired messages never admit.
  const old=control.db.prepare("SELECT details FROM events WHERE type='capacity_admitted' AND subject=? AND json_extract(details,'$.request.requestId')=?").get(g.grantId,request.requestId);
  requireValue(old || envelope.expiresAt>store.clock(),'CAPACITY_REQUEST_EXPIRED');
  requireValue(row.digest===hash(wireBytes(envelope)),'CAPACITY_HISTORY');
  return {grantId:g.grantId,generation:g.generation,grantDigest:issued.grantDigest,request,nativeProof:proof,
    messageId,messageDigest:row.digest,inboxSequence:row.sequence};
}
function result(dispatched,effect,admission,failureCode=null,paid=null) {
  return {dispatched,effect:{key:effect.key,state:effect.state,requestDigest:effect.request_digest,receipt:effect.receipt},
    requestId:admission.request.requestId,cellId:admission.cellId,app:admission.app,
    failure:failureCode===null?null:{stage:dispatched?'post-dispatch':'pre-dispatch',code:failureCode},paid,
    scope:'standing-grant-managed-provision',workerQuiescence:'unverified',nativePeerAutonomy:false};
}
const SAFE_FAILURES=new Set(['PAUSED','STALE','CAPACITY_GRANT_EXPIRED','CAPACITY_GRANT_GENERATION','CAPACITY_CREDENTIAL','CREDENTIAL_GENERATION','CREDENTIAL_EXPIRED','BUDGET','STATE','UNINITIALIZED','CAPACITY_HISTORY','CAPACITY_REQUEST_EXPIRED']);
function safeFailure(error) { return SAFE_FAILURES.has(error?.code)?error.code:'CAPACITY_PRE_DISPATCH_REFUSED'; }
function paidCurrent(ledger,id,paid) {
  ledger.assertAdmission(); const row=ledger.row(id),policy=ledger.policy();
  const held=ledger.rows().reduce((total,item)=>total+BigInt(item.state==='cancelled'?0:item.state==='settled'?item.final_cents:Math.max(item.ceiling_cents,item.charged_cents??0)),0n);
  requireValue(row.provider===paid.provider && row.ceiling_cents===paid.ceilingCents && row.state==='started'
    && (row.charged_cents===null || row.charged_cents<row.ceiling_cents) && held<=BigInt(policy.limit_cents),'CAPACITY_PAID');
}
/** Only this newly committed admission may invoke the existing ManagedCloud adapter. No automatic retry. */
export async function interpretCapacityRequest({control,store,grant,messageId,adapter,paidAdmission}) {
  dependencies(control,store); const g=validateCapacityGrant(grant);
  requireValue(paidAdmission instanceof SpendingLedger && adapter && typeof adapter.provision==='function','CAPACITY_DEPENDENCY');
  const accepted=store.transaction(()=>control.admitCapacityProvision(g.lease,lockedRequest(control,store,g,messageId)));
  if (!accepted.fresh) return result(false,accepted.effect,accepted.admission);
  const admission=accepted.admission;
  // Controller-local effect labels are not globally unique in a shared paid ledger.
  // Bind the hold to the exact issued transport/policy and immutable deployment request.
  const paidId='paid.capacity.'+digest({grantDigest:admission.grantDigest,key:admission.key,
    requestDigest:admission.requestDigest,messageDigest:admission.messageDigest});
  let paid=null,promise;
  try {
    paidAdmission.reserve({reservationId:paidId,...g.paid});
    const reservation=paidAdmission.start(paidId);
    paid={reservationId:paidId,provider:reservation.provider,ceilingCents:reservation.ceilingCents,state:reservation.state};
    // No asynchronous preflight or callback lies between these final fences and adapter invocation.
    // Hold peer and paid writer locks during synchronous dispatch admission; release before awaiting IO.
    store.transaction(()=>paidAdmission.transaction(()=>{
      const current=lockedRequest(control,store,g,messageId);
      requireValue(digest(current)===digest({grantId:g.grantId,generation:g.generation,grantDigest:admission.grantDigest,request:admission.request,
        nativeProof:admission.nativeProof,messageId:admission.messageId,messageDigest:admission.messageDigest,inboxSequence:admission.inboxSequence}),'CAPACITY_HISTORY');
      requireValue(store.readInbox(messageId).expiresAt>store.clock(),'CAPACITY_REQUEST_EXPIRED');
      paidCurrent(paidAdmission,paidId,g.paid);
      control.startCapacityProvision(g.lease,{grantId:g.grantId,generation:g.generation,grantDigest:admission.grantDigest,key:admission.key});
      // A synchronous throw is already a dispatched ambiguous outcome. Capture it outside the transaction.
      try { promise=Promise.resolve(adapter.provision(structuredClone(admission.provisionRequest))); }
      catch (error) { promise=Promise.reject(error); }
      // A subsequent local COMMIT failure returns unknown while the dispatch is still live.
      // Observe rejection immediately even on that early return; it never authorizes a retry.
      promise.catch(()=>{});
      return null;
    }));
  } catch (error) {
    const effect=control.effect(admission.key);
    if (effect.state!=='accepted') {
      if (['running','unknown'].includes(effect.state)) control.settleEffect(admission.key,'unknown',{state:'unknown',reason:'External outcome requires reconciliation.'});
      return result(true,control.effect(admission.key),admission,'CAPACITY_OUTCOME_UNCONFIRMED',paid);
    }
    control.settleEffect(admission.key,'not_applied',{state:'not_applied'});
    return result(false,control.effect(admission.key),admission,safeFailure(error),paid);
  }
  try {
    const receipt=await promise;
    requireValue(receipt?.worker===admission.app && receipt?.app===admission.app && receipt?.state==='ready'
      && receipt?.workspace===g.template.workspace && receipt?.org===g.template.org && receipt?.region===g.template.region,'CAPACITY_RECEIPT');
    const effect=control.settleEffect(admission.key,'succeeded',{worker:admission.app,app:admission.app,state:'ready'});
    return result(true,effect,admission,null,paid);
  } catch {
    const effect=control.effect(admission.key);
    if (['running','unknown'].includes(effect.state)) control.settleEffect(admission.key,'unknown',{state:'unknown',reason:'External outcome requires reconciliation.'});
    return result(true,control.effect(admission.key),admission,'CAPACITY_OUTCOME_UNCONFIRMED',paid);
  }
}
