import http from 'node:http';
import https from 'node:https';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { requirePeer, PeerError, wireBytes, parseWire } from './peer-messaging.mjs';
import { exactWatch, validateHealthProjection, validateWatchObservation } from './peer-watch-state.mjs';

export const HEALTH_PATH='/v1/peer/health';
export const HEALTH_PROTOCOL='factory-peer-health-v1';
export const HEALTH_LIMIT=8192;
const SKEW=30000;
const unavailablePaid=availability=>({availability,observedAt:null,revision:null,limitCents:null,committedCents:null,
  unallocatedCents:null,overCommittedCents:null,knownMeteredCents:null,meteredSpendCents:null,billingIncomplete:null,basis:'shared-paid-admission-ledger',currency:'USD'});
const unavailableSource=()=>({availability:'unavailable',observedAt:null,controller:null,paid:unavailablePaid('unavailable')});
function active(config,now){requirePeer(config.credentialExpiresAt>now,'CREDENTIAL_EXPIRED');}
function challenge(input){exactWatch(input,['nonce','requestedAt']);requirePeer(typeof input.nonce==='string' && /^[a-f0-9]{64}$/.test(input.nonce)
  && Number.isSafeInteger(input.requestedAt) && input.requestedAt>=0,'AUTHENTICATION');return input;}
function mac(config,direction,request,body,sender,recipient){
  return createHmac('sha256',Buffer.from(config.key,'base64url')).update(wireBytes({domain:HEALTH_PROTOCOL,direction,method:'GET',path:HEALTH_PATH,
    sender,recipient,generation:config.generation,nonce:request.nonce,requestedAt:request.requestedAt,body:body.toString('base64')})).digest('hex');
}
function equalMac(given,expected){requirePeer(typeof given==='string' && /^[a-f0-9]{64}$/.test(given)
  && timingSafeEqual(Buffer.from(given,'hex'),Buffer.from(expected,'hex')),'AUTHENTICATION');}
export function healthRequestHeaders(config,request,now=Date.now()){
  active(config,now);challenge(request);requirePeer(Math.abs(now-request.requestedAt)<=SKEW,'AUTHENTICATION');
  return {'x-factory-peer-generation':String(config.generation),'x-factory-health-nonce':request.nonce,
    'x-factory-health-requested-at':String(request.requestedAt),'x-factory-health-mac':mac(config,'request',request,Buffer.alloc(0),config.local,config.peer)};
}
export function verifyHealthRequest(config,headers,now=Date.now()){
  active(config,now);requirePeer(headers['x-factory-peer-generation']===String(config.generation),'CREDENTIAL_GENERATION');
  requirePeer(typeof headers['x-factory-health-requested-at']==='string' && /^(?:0|[1-9][0-9]{0,15})$/.test(headers['x-factory-health-requested-at']),'AUTHENTICATION');
  const request=challenge({nonce:headers['x-factory-health-nonce'],requestedAt:Number(headers['x-factory-health-requested-at'])});
  requirePeer(Math.abs(now-request.requestedAt)<=SKEW,'AUTHENTICATION');
  equalMac(headers['x-factory-health-mac'],mac(config,'request',request,Buffer.alloc(0),config.peer,config.local));return request;
}
export function healthResponseBytes(config,request,{instanceId,source},now=Date.now()){
  active(config,now);challenge(request);validateHealthProjection(source);
  requirePeer(source.availability!=='available' || source.controller.cell.id===config.local.cellId,'IDENTITY');
  return wireBytes({schemaVersion:1,protocol:HEALTH_PROTOCOL,sender:config.local,recipient:config.peer,generation:config.generation,
    nonce:request.nonce,requestedAt:request.requestedAt,observedAt:now,instanceId,source,capabilities:{observation:true,commands:false}},HEALTH_LIMIT);
}
export function healthResponseHeaders(config,request,body,now=Date.now()){
  active(config,now);return {'content-type':'application/json','x-factory-peer-generation':String(config.generation),
    'x-factory-health-mac':mac(config,'response',challenge(request),body,config.local,config.peer)};
}
export function verifyHealthResponse(config,request,body,headers,now=Date.now()){
  active(config,now);requirePeer(headers['content-type']==='application/json','AUTHENTICATION');
  requirePeer(headers['x-factory-peer-generation']===String(config.generation),'CREDENTIAL_GENERATION');
  equalMac(headers['x-factory-health-mac'],mac(config,'response',challenge(request),body,config.peer,config.local));
  const value=parseWire(body,HEALTH_LIMIT);
  exactWatch(value,['schemaVersion','protocol','sender','recipient','generation','nonce','requestedAt','observedAt','instanceId','source','capabilities']);
  requirePeer(value.schemaVersion===1 && value.protocol===HEALTH_PROTOCOL && value.generation===config.generation
    && wireBytes(value.sender).equals(wireBytes(config.peer)) && wireBytes(value.recipient).equals(wireBytes(config.local)),'IDENTITY');
  requirePeer(value.nonce===request.nonce && value.requestedAt===request.requestedAt && Number.isSafeInteger(value.observedAt)
    && Math.abs(now-value.observedAt)<=SKEW && value.observedAt>=request.requestedAt-SKEW,'STALE_HEALTH');
  exactWatch(value.capabilities,['observation','commands']);requirePeer(value.capabilities.observation===true && value.capabilities.commands===false,'INVALID_HEALTH');
  validateHealthProjection(value.source);
  requirePeer(value.source.availability!=='available' || value.source.controller.cell.id===config.peer.cellId,'IDENTITY');
  requirePeer(value.source.observedAt===null || value.source.observedAt<=value.observedAt+SKEW,'STALE_HEALTH');
  requirePeer(value.source.paid.observedAt===null || value.source.paid.observedAt<=value.observedAt+SKEW,'STALE_HEALTH');
  const available=value.source.availability==='available';
  validateWatchObservation({sampledAt:now,reachability:'responding',authentication:'verified',freshness:available?'fresh':'stale',generation:config.generation,
    instanceId:value.instanceId,source:value.source,sourceRevisions:{controller:available?value.source.controller.revision:null,
      paid:value.source.paid.availability==='available'?value.source.paid.revision:null},failure:available?null:'SOURCE_UNAVAILABLE'});return value;
}
async function boundedGet(url,{headers={},timeoutMs,limit}){
  return new Promise(resolve=>{
    let request,timer,done=false,responded=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
    timer=setTimeout(()=>{request?.destroy();finish({failure:'DEADLINE',responded});},timeoutMs);
    try{
      request=(url.protocol==='https:'?https:http).request(url,{method:'GET',headers,agent:false,rejectUnauthorized:true},response=>{
        responded=true;
        if(response.statusCode!==200){response.destroy();finish({failure:'HTTP_REJECTION',responded:true});return;}
        const chunks=[];let count=0;
        response.on('data',chunk=>{count+=chunk.length;if(count>limit){response.destroy();finish({failure:'HEALTH_LIMIT',responded:true});}else chunks.push(chunk);});
        response.on('error',()=>finish({failure:'RESPONSE_INTERRUPTED',responded:true}));
        response.on('end',()=>finish({body:Buffer.concat(chunks),headers:response.headers,responded:true}));
      });request.on('error',()=>finish({failure:'CONNECTION',responded}));request.end();
    }catch{request?.destroy();finish({failure:'CONNECTION',responded});}
  });
}
export async function createLocalHealthSource({configuration,privateFiles,clock=Date.now}){
  const token=await privateFiles.readPrivateJson(configuration.source.tokenFile,{maxBytes:1024});
  exactWatch(token,['token']);requirePeer(typeof token.token==='string' && /^[A-Za-z0-9_-]{32,256}$/.test(token.token) && new Set(token.token).size>=8,'SOURCE_TOKEN');
  const url=new URL(configuration.source.snapshotUrl);const configured=configuration.source;
  requirePeer(url.protocol==='http:' && ['127.0.0.1','[::1]'].includes(url.hostname) && url.pathname==='/v1/snapshot'
    && !url.username && !url.password && !url.search && !url.hash && url.port!=='0','WATCH_CONFIG');
  return {async read(){
    try{
      const result=await boundedGet(url,{headers:{Authorization:'Bearer '+token.token},timeoutMs:configuration.timeoutMs,limit:256*1024});
      requirePeer(!result.failure && /^application\/json(?:;\s*charset=utf-8)?$/i.test(result.headers['content-type']??''),'SOURCE');
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.body));
      requirePeer(value.schemaVersion===1 && value.factoryId===configured.expectedFactoryId && value.capabilities?.commands===false,'SOURCE');
      const now=clock(),observedAt=Date.parse(value.observedAt),snapshot=value.snapshot;
      requirePeer(Number.isSafeInteger(observedAt) && Math.abs(now-observedAt)<=configuration.maxAgeMs,'SOURCE');
      const cells=snapshot.cells.filter(cell=>cell.id===configured.expectedCellId);requirePeer(cells.length===1,'SOURCE');
      const cell=cells[0],heartbeat=Date.parse(cell.heartbeat),budget=snapshot.budget,paid=snapshot.paidBudget;
      requirePeer(Number.isSafeInteger(heartbeat) && heartbeat<=now+SKEW && snapshot.workerQuiescence==='unverified','SOURCE');
      requirePeer(budget.currency==='USD' && (paid.availability!=='available' || paid.currency==='USD'),'SOURCE');
      const output={availability:'available',observedAt,controller:{revision:value.revision,epoch:snapshot.control.epoch,status:snapshot.control.status,
        cell:{id:cell.id,role:cell.role,status:cell.status,heartbeat:now-heartbeat<=configuration.maxAgeMs?'fresh':'stale'},
        unresolvedEffects:snapshot.unresolvedEffects,effectsDrained:snapshot.effectsDrained,workerQuiescence:'unverified',
        logical:{limitCents:budget.limitCents,committedCents:budget.rootCommittedCents,unallocatedCents:budget.unallocatedCents,
          meteredSpendCents:budget.meteredSpendCents,basis:budget.basis,currency:budget.currency}},paid:paid.availability==='available'?{
          availability:'available',observedAt:Date.parse(paid.observedAt),revision:paid.revision,limitCents:paid.limitCents,committedCents:paid.committedCents,
          unallocatedCents:paid.unallocatedCents,overCommittedCents:paid.overCommittedCents,knownMeteredCents:paid.knownMeteredCents,meteredSpendCents:paid.meteredSpendCents,
          billingIncomplete:paid.billingIncomplete,basis:paid.basis,currency:paid.currency}:unavailablePaid(paid.availability)};
      requirePeer(output.paid.observedAt===null || Math.abs(now-output.paid.observedAt)<=configuration.maxAgeMs,'SOURCE');
      validateHealthProjection(output);requirePeer(!JSON.stringify(output).includes(token.token),'SOURCE');return output;
    }catch{return unavailableSource();}
  }};
}
export async function probePeerHealth({store,timeoutMs=5000,maxAgeMs=30000}){
  requirePeer(Number.isSafeInteger(timeoutMs) && timeoutMs>=100 && timeoutMs<=30000,'DEADLINE');
  requirePeer(Number.isSafeInteger(maxAgeMs) && maxAgeMs>=1000 && maxAgeMs<=3600000,'WATCH_SHAPE');
  store.assertCurrentCredential();const request={nonce:randomBytes(32).toString('hex'),requestedAt:store.clock()};
  const url=new URL(store.config.endpoint);url.pathname=HEALTH_PATH;
  const result=await boundedGet(url,{headers:healthRequestHeaders(store.config,request,store.clock()),timeoutMs,limit:HEALTH_LIMIT});
  store.assertCurrentCredential();const now=store.clock();
  const base={sampledAt:now,reachability:result.responded?'responding':'unreachable',authentication:'unverified',freshness:'unobserved',
    generation:store.config.generation,instanceId:null,source:null,sourceRevisions:{controller:null,paid:null},failure:result.failure??null};
  if(result.failure)return validateWatchObservation(base);
  try{
    const health=verifyHealthResponse(store.config,request,result.body,result.headers,now);
    const available=health.source.availability==='available',fresh=available && Math.abs(now-health.source.observedAt)<=maxAgeMs
      && (health.source.paid.observedAt===null || Math.abs(now-health.source.paid.observedAt)<=maxAgeMs);
    return validateWatchObservation({...base,authentication:'verified',freshness:fresh?'fresh':'stale',instanceId:health.instanceId,
      source:health.source,sourceRevisions:{controller:available?health.source.controller.revision:null,
        paid:health.source.paid.availability==='available'?health.source.paid.revision:null},failure:available?(fresh?null:'STALE_HEALTH'):'SOURCE_UNAVAILABLE'});
  }catch(error){const code=error instanceof PeerError?error.code:'INVALID_HEALTH';
    return validateWatchObservation({...base,failure:['AUTHENTICATION','CREDENTIAL_GENERATION','IDENTITY','STALE_HEALTH'].includes(code)?code:'INVALID_HEALTH'});}
}
