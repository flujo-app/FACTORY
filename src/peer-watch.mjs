import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { requirePeer, wireBytes } from './peer-messaging.mjs';
import { exactWatch } from './peer-watch-state.mjs';
import { probePeerHealth } from './peer-health.mjs';
import { startPeerServer, dispatchPeerMessage } from './peer-gateway.mjs';

export function validateWatchConfig(input, pair) {
  exactWatch(input, ['schemaVersion','watchId','source','intervalMs','timeoutMs','maxAgeMs','messageTtlMs','durationMs']);
  requirePeer(input.schemaVersion===1 && typeof input.watchId==='string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.watchId),'WATCH_CONFIG');
  exactWatch(input.source,['snapshotUrl','tokenFile','expectedFactoryId','expectedCellId']);
  const s=input.source;requirePeer(typeof s.snapshotUrl==='string' && typeof s.tokenFile==='string' && path.isAbsolute(s.tokenFile),'WATCH_CONFIG');
  let url;try{url=new URL(s.snapshotUrl);}catch{requirePeer(false,'WATCH_CONFIG');}
  requirePeer(url.protocol==='http:' && ['127.0.0.1','[::1]'].includes(url.hostname) && url.pathname==='/v1/snapshot'
    && !url.username && !url.password && !url.search && !url.hash && url.port!=='0','WATCH_CONFIG');
  requirePeer(s.expectedFactoryId===pair.local.factoryId && s.expectedCellId===pair.local.cellId,'WATCH_IDENTITY');
  for(const [key,min,max] of [['intervalMs',1000,60000],['timeoutMs',100,30000],['maxAgeMs',1000,3600000],
    ['messageTtlMs',1000,86400000]])
    requirePeer(Number.isSafeInteger(input[key]) && input[key]>=min && input[key]<=max,'WATCH_CONFIG');
  requirePeer(input.durationMs===null || (Number.isSafeInteger(input.durationMs) && input.durationMs>=1000),'WATCH_CONFIG');
  const value=structuredClone(input);value.source.snapshotUrl=url.href;Object.freeze(value.source);return Object.freeze(value);
}
export function watchBinding(configuration, pair) {
  const config=validateWatchConfig(configuration,pair);
  // Only this digest travels. No token, key, source URL or private path is sent to the peer.
  const bindingDigest=createHash('sha256').update(wireBytes({domain:'factory-peer-watch-binding-v1',configuration:config,
    local:pair.local,peer:pair.peer,endpoint:pair.endpoint})).digest('hex');
  return {watchId:config.watchId,bindingDigest};
}
function pause(ms,signal) {
  if(signal?.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});
  });
}
/** An advisory daemon: observes its configured OTHER peer, with no controller or paid mutation API. */
export async function runPeerWatcher({store,configuration,sourceReader,host='127.0.0.1',port=0,tls,onEvent=()=>{},signal}={}) {
  const config=validateWatchConfig(configuration,store.config),binding=watchBinding(config,store.config);
  requirePeer(sourceReader && typeof sourceReader.read==='function' && typeof onEvent==='function','WATCH_CONFIG');
  store.assertCurrentCredential();store.watchCheckpoint(binding);store.watchPending(binding);
  const instanceId=randomUUID(),retry=new Map(),deliveryStates=new Map();let backpressure=false;
  const server=await startPeerServer({store,host,port,tls,health:{instanceId,sourceReader}});
  const deadline=config.durationMs===null?Infinity:Date.now()+config.durationMs;
  try {
    onEvent({state:'listening',port:server.address().port,tls:Boolean(tls),instanceId,generation:store.config.generation,
      watchId:config.watchId,scope:'advisory-mutual-watch'});
    while(!signal?.aborted && Date.now()<deadline) {
      store.assertCurrentCredential();
      const checkpoint=store.watchCheckpoint(binding);
      const observation=await probePeerHealth({store,timeoutMs:config.timeoutMs,maxAgeMs:config.maxAgeMs});
      store.assertCurrentCredential();if(signal?.aborted)break;
      let recorded;
      try { recorded=store.recordWatchObservation({...binding,expectedMessageId:checkpoint?.messageId??null,expectedDigest:checkpoint?.digest??null,
        observation,messageTtlMs:config.messageTtlMs}); }
      catch(error){
        if(error.code==='WATCH_CONFLICT')continue;
        if(error.code!=='WATCH_BACKPRESSURE')throw error;
        if(!backpressure)onEvent({state:'backpressure',watchId:config.watchId,scope:'advisory-mutual-watch'});
        backpressure=true;
      }
      if(recorded){backpressure=false;}
      if(recorded?.changed) {
        const {payload,messageId,digest}=recorded.checkpoint;
        onEvent({state:'observed',watchId:config.watchId,messageId,digest,episode:payload.episode,
          observation:payload.observation,revisionFloors:payload.revisionFloors,scope:'advisory-mutual-watch'});
      }
      // Reconcile committed intent on every start/poll. Each body/ID/expiry stays exactly as admitted.
      // Expired uncertain originals remain visible and retriable, but do not starve newer intents.
      const pendingRows=store.watchPending(binding),pendingIds=new Set(pendingRows.map(row=>row.messageId));
      for(const key of retry.keys())if(!pendingIds.has(key))retry.delete(key);
      for(const key of deliveryStates.keys())if(!pendingIds.has(key))deliveryStates.delete(key);
      for(const pending of pendingRows) {
        if(signal?.aborted || Date.now()>=deadline)break;
        const backoff=retry.get(pending.messageId);if(backoff && backoff.nextAt>Date.now())continue;
        store.assertCurrentCredential();
        const result=await dispatchPeerMessage({store,messageId:pending.messageId,timeoutMs:config.timeoutMs});
        store.assertCurrentCredential();
        const state=result.state==='acknowledged'?'acknowledged':pending.delivery;
        const status={state:'delivery',watchId:config.watchId,messageId:pending.messageId,digest:pending.digest,
          delivery:state,failure:result.failure??null,scope:'advisory-mutual-watch'};
        const semantic=JSON.stringify(status);
        if(deliveryStates.get(pending.messageId)!==semantic){deliveryStates.set(pending.messageId,semantic);onEvent(status);}
        if(result.state==='acknowledged'){retry.delete(pending.messageId);deliveryStates.delete(pending.messageId);}
        else {const attempts=(backoff?.attempts??0)+1;retry.set(pending.messageId,{attempts,nextAt:Date.now()+Math.min(30000,config.intervalMs*2**Math.min(attempts-1,5))});}
      }
      await pause(Math.min(config.intervalMs,Math.max(0,deadline-Date.now())),signal);
    }
    onEvent({state:'stopped',watchId:config.watchId,reason:signal?.aborted?'signal':'duration',scope:'advisory-mutual-watch'});
  } finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
