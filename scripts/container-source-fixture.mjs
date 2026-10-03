#!/usr/bin/env node
/** Private, unpaid Docker acceptance fixture; never a production initializer. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createManagedCloudAdapter } from '../src/adapters/managed-cloud.mjs';
import * as files from '../deploy/private-files.mjs';
import { captureSnapshot } from '../deploy/managed-cloud/lib/snapshot.mjs';
import { encryptSnapshot } from '../deploy/managed-cloud/lib/envelope.mjs';
import { FactoryControl,digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { PeerStore,createPairConfigurations } from '../src/peer-messaging.mjs';
import { issueCapacityGrant,enqueueCapacityRequest } from '../src/capacity-bridge.mjs';
import { dispatchPeerMessage } from '../src/peer-gateway.mjs';
import { DatabaseSync } from 'node:sqlite';

process.umask(0o077);
const FIXTURE='/fixture',AUTHORITY='/authority',RESTORE='/restore';
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>files.readPrivateJson(p,{maxBytes:4*1048576});
const write=(p,v)=>files.writePrivateJson(p,v,{exclusive:true});
const command=process.argv[2];
async function source(){return read(FIXTURE+'/secrets.private.json');}
async function profile(s){
  return {schemaVersion:1,origin:'http://127.0.0.1:4200',tokenFile:AUTHORITY+'/native-token.private.json',dataRoot:'/data/flujo',worker:s.worker};
}
async function adapter(s,p){
  p??=await profile(s);
  return createManagedCloudAdapter({modulePath:'/app/deploy/managed-cloud/lib/managed.mjs',
    options:{directory:AUTHORITY+'/managed',env:{FLYCTL_PATH:'/fixture/forbidden-flyctl'}},sourceWorkerProfile:p,privateFiles:files});
}
async function json(origin,route,token){const response=await fetch(origin+route,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});
  const chunks=[];let size=0;for await(const part of response.body??[]){size+=part.length;assert.ok(size<=1048576);chunks.push(part);}return {status:response.status,body:JSON.parse(Buffer.concat(chunks))};}
async function prepare(){
  assert.equal(process.getuid(),1000);await files.assertPrivateDirectory(FIXTURE);
  await fs.copyFile('/app/scripts/container-source-native.mjs',FIXTURE+'/container-source-native.mjs',fs.constants.COPYFILE_EXCL);
  await fs.chmod(FIXTURE+'/container-source-native.mjs',0o600);
  return {prepared:true,helperSha256:sha(await fs.readFile(FIXTURE+'/container-source-native.mjs'))};
}
async function probe(restore=false){
  const s=await read(FIXTURE+(restore?'/restore-secrets.private.json':'/secrets.private.json')),origin='http://127.0.0.1:'+(restore?'4300':'4200');
  const status=await json(origin,'/api/worker/status',s.token);
  if(status.status!==200||status.body.state!=='ready')return {ready:false,status:status.status,workerState:status.body.state??null};
  assert.equal(status.body.mode,'worker');assert.equal(status.body.workspace,s.worker.workspace);assert.equal(status.body.archiveSha256,s.worker.archiveSha256);
  const info=await json(origin,'/api/snapshot/info?workspace='+s.worker.workspace,s.token);
  assert.equal(info.status,200);assert.deepEqual(info.body.workerCompatibility,s.worker.compatibility);
  const inventory=await json(origin,'/api/mcp/servers/snapshot-fixture/tools?workspace='+s.worker.workspace,s.token);
  assert.equal(inventory.status,200);assert.equal(Boolean(inventory.body.error),false);
  assert.deepEqual(inventory.body.tools,[{name:'fixture_probe',description:'Unpaid inert fixture',inputSchema:{type:'object',properties:{}}}]);
  const sources=restore?null:await (await adapter(s)).sources();
  if(sources){assert.equal(sources.length,1);assert.equal(sources[0].source,origin);assert.equal(Object.hasOwn(sources[0],'instanceId'),false);assert.equal(Object.hasOwn(sources[0],'pid'),false);assert.equal(JSON.stringify(sources).includes(s.token),false);}
  return {ready:true,status:status.body,info:info.body,toolInventory:inventory,sources};
}
async function capture(){
  const s=await source(),p=await profile(s),bound=await adapter(s,p);assert.equal((await bound.sources()).length,1);
  const refusals=[];
  for(const change of [v=>v.worker.archiveSha256='0'.repeat(64),v=>v.worker.compatibility.revision='0'.repeat(40),v=>v.worker.workspace='wrong-workspace']){
    const wrong=structuredClone(p);change(wrong);let refused=false;try{await(await adapter(s,wrong)).sources();}catch{refused=true;}assert.equal(refused,true);refusals.push({refused});
  }
  const httpProof=[];
  const capture=await captureSnapshot({origin:p.origin,workspace:s.worker.workspace,token:s.token,flowIds:[s.flow.id],
    async fetchImpl(url,init){const response=await fetch(url,init),u=new URL(url);const route=u.pathname,record={route,method:init.method,status:response.status,workspace:u.searchParams.get('workspace'),sessionId:u.searchParams.get('sessionId')};
      if(route!=='/api/snapshot/download'){const body=Buffer.from(await response.clone().arrayBuffer());assert.ok(body.length<=65536);record.body=JSON.parse(body);}else record.downloadSha256=response.headers.get('x-flujo-snapshot-sha256');httpProof.push(record);return response;}});
  assert.equal(sha(capture.bytes),capture.sha256);
  const finalize=httpProof.find(p=>p.route==='/api/snapshot/finalize');assert.ok(finalize?.status>=200&&finalize.status<300);
  const sessionId=httpProof.find(p=>p.route==='/api/snapshot/begin').body.sessionId;
  assert.equal(finalize.sessionId,sessionId);
  for(const record of [finalize.body,...httpProof.filter(r=>r.route==='/api/snapshot/status'&&r.body.state==='ready').map(r=>r.body)]){
    assert.equal(record.sessionId,sessionId);assert.equal(record.workspace,s.worker.workspace);assert.equal(record.sha256,capture.sha256);
  }
  const finalStatus=await json(p.origin,'/api/snapshot/status?workspace='+s.worker.workspace+'&sessionId='+sessionId,s.token);
  assert.equal(finalStatus.status,200);assert.equal(finalStatus.body.state,'finalized');
  assert.equal(finalStatus.body.sessionId,sessionId);assert.equal(finalStatus.body.workspace,s.worker.workspace);assert.equal(finalStatus.body.sha256,capture.sha256);
  const info=await json(p.origin,'/api/snapshot/info?workspace='+s.worker.workspace,s.token);assert.equal(info.body.workspace,s.worker.workspace);assert.deepEqual(info.body.workerCompatibility,s.worker.compatibility);assert.equal(info.body.capability,'available');assert.equal(info.body.activeOperation,null);
  await files.assertPrivateDirectory(RESTORE);assert.equal((await fs.readdir(RESTORE)).length,0);
  const encrypted=encryptSnapshot(capture.bytes),token=randomBytes(32).toString('hex');assert.notEqual(token,s.token);assert.notEqual(encrypted.key.toString('base64'),s.key);
  await fs.writeFile(FIXTURE+'/captured.zip',capture.bytes,{flag:'wx',mode:0o600});
  await fs.writeFile(RESTORE+'/worker.snapshot',encrypted.envelope,{flag:'wx',mode:0o600});
  await write(FIXTURE+'/restore-secrets.private.json',{token,key:encrypted.key.toString('base64'),worker:{...s.worker,archiveSha256:capture.sha256},flow:s.flow,operation:s.operation});
  const receipt={captured:true,archiveSha256:capture.sha256,archiveBytes:capture.bytes.length,envelopeSha256:sha(encrypted.envelope),sourceWorker:s.worker,restoreWorker:{...s.worker,archiveSha256:capture.sha256},sourceProfile:p,httpProof,finalStatus:finalStatus.body,info:info.body,refusals,noFlyCalls:true,paidProviderCalls:0};
  await write(FIXTURE+'/capture.private.json',receipt);capture.bytes.fill(0);encrypted.key.fill(0);return receipt;
}
async function prepareBroker(){
  const s=await source(),config=createPairConfigurations({a:{identity:{factoryId:'clone-fixture',cellId:'root'},endpoint:'http://127.0.0.1:3005/v1/peer/messages'},
    b:{identity:{factoryId:'clone-fixture',cellId:'broker'},endpoint:'http://127.0.0.1:3004/v1/peer/messages'},credentialExpiresAt:Date.now()+1800000});
  const control=new FactoryControl(AUTHORITY+'/control.sqlite'),paid=new SpendingLedger(AUTHORITY+'/paid.sqlite');let sender,receiver;
  try{
    control.pause();const originalPolicy=control.control();
    const growthTransition=control.useBudgetOnlyGrowth({transitionId:'clone-budget-growth',expectedFactoryEpoch:originalPolicy.epoch,expectedPolicyDigest:digest(originalPolicy.policy)});
    assert.equal(growthTransition.control.status,'paused');assert.equal(growthTransition.control.policy.growthMode,'budget-only');control.resume();
    control.createTask({taskId:'capacity-fixture',projectId:'fixture',branch:'codex/capacity-fixture',specification:{problem:'Refuse deployment when the same fixture authority has no free paid funds',acceptance:['No provider operation'],baseline:s.operation}});
    const lease=control.claimTask('capacity-fixture','root',1200000);
    const grant={schemaVersion:2,growthMode:'budget-only',grantId:'clone-grant',generation:1,lease,expiresAt:lease.expires,maxChildren:null,maxBudgetCents:1000,allowedRoles:['developer'],native:s.worker,
      template:{source:'http://127.0.0.1:4200',workspace:s.worker.workspace,image:'registry.invalid/fixture@sha256:'+'a'.repeat(64),org:'synthetic',region:'iad',appPrefix:'clone-fixture',flowIds:[s.flow.id]},paid:{provider:'fly',ceilingCents:500}};
    await write(AUTHORITY+'/sender.private.json',config.a);await write(AUTHORITY+'/receiver.private.json',config.b);
    sender=new PeerStore(AUTHORITY+'/sender.sqlite',{config:config.a});receiver=new PeerStore(AUTHORITY+'/receiver.sqlite',{config:config.b});
    const issued=issueCapacityGrant({control,store:receiver,grant});await write(AUTHORITY+'/grant.private.json',grant);await write(AUTHORITY+'/policy.private.json',issued.policy);
    await write(AUTHORITY+'/source.private.json',await profile(s));
    await fs.writeFile(AUTHORITY+'/fly-trap','#!/bin/sh\numask 077\nprintf "invoked\\n" >> /authority/fly-invocations.private.log\nexit 17\n',{flag:'wx',mode:0o700});
    await write(AUTHORITY+'/broker.private.json',{peerConfigFile:AUTHORITY+'/receiver.private.json',peerDatabase:AUTHORITY+'/receiver.sqlite',grantFile:AUTHORITY+'/grant.private.json',
      controlDatabase:AUTHORITY+'/control.sqlite',spendingDatabase:AUTHORITY+'/paid.sqlite',managedModule:'/app/deploy/managed-cloud/lib/managed.mjs',managedOptions:{directory:AUTHORITY+'/managed',env:{FLYCTL_PATH:AUTHORITY+'/fly-trap'}},
      sourceProfileFile:AUTHORITY+'/source.private.json',host:'127.0.0.1',port:3004,pollMs:250});
    paid.reserve({reservationId:'fully-held-fixture',provider:'synthetic',ceilingCents:10000});
    const outbox=enqueueCapacityRequest({store:sender,grant:issued.policy,request:{requestId:'budget-refused',role:'developer',budgetCents:500,purpose:'Unpaid deployment refusal acceptance'},nativeProof:s.worker});
    await write(AUTHORITY+'/outbox.private.json',{messageId:outbox.messageId});
    return{prepared:true,originalAuthority:true,messageId:outbox.messageId,worker:s.worker,paidHeldCents:10000,unallocatedCents:0,growthPolicy:control.control().policy,grantSchemaVersion:grant.schemaVersion,growthTransition};
  }finally{sender?.close();receiver?.close();paid.close();control.close();}
}
async function sendBroker(){
  const config=await read(AUTHORITY+'/sender.private.json'),outbox=await read(AUTHORITY+'/outbox.private.json'),store=new PeerStore(AUTHORITY+'/sender.sqlite',{config});
  try{return await dispatchPeerMessage({store,messageId:outbox.messageId});}finally{store.close();}
}
async function brokerAudit(){
  const paths=[AUTHORITY+'/control.sqlite',AUTHORITY+'/paid.sqlite'],before=await Promise.all(paths.map(async p=>sha(await fs.readFile(p))));
  const control=new DatabaseSync(paths[0],{readOnly:true}),paid=new DatabaseSync(paths[1],{readOnly:true});let result;
  try{control.exec('PRAGMA query_only=ON;BEGIN;');paid.exec('PRAGMA query_only=ON;BEGIN;');
    const effects=control.prepare("SELECT key,request_digest,state,receipt FROM effects WHERE task_id='capacity-fixture'").all();
    const growthPolicy=JSON.parse(control.prepare('SELECT policy FROM control WHERE id=1').get().policy),grant=JSON.parse(control.prepare("SELECT details FROM events WHERE type='capacity_grant_issued' AND subject='clone-grant' ORDER BY seq DESC LIMIT 1").get().details);
    assert.equal(growthPolicy.schemaVersion,2);assert.equal(growthPolicy.growthMode,'budget-only');assert.equal(growthPolicy.maxCells,null);assert.equal(growthPolicy.maxDepth,null);assert.equal(grant.schemaVersion,2);assert.equal(grant.policy.schemaVersion,2);assert.equal(grant.policy.maxChildren,null);
    const reservations=paid.prepare('SELECT * FROM spending_reservations ORDER BY id').all(),policy=paid.prepare('SELECT * FROM spending_policy').all(),events=paid.prepare('SELECT * FROM spending_events ORDER BY seq').all();
    assert.equal(effects.length,1);assert.equal(effects[0].state,'not_applied');assert.equal(reservations.length,1);assert.equal(reservations[0].id,'fully-held-fixture');assert.equal(reservations[0].ceiling_cents,10000);assert.equal(reservations[0].state,'reserved');
    assert.equal(reservations[0].charged_cents,null);assert.equal(reservations[0].final_cents,null);assert.equal(policy.length,1);assert.equal(policy[0].id,1);assert.equal(policy[0].limit_cents,10000);assert.equal(policy[0].currency,'USD');
    assert.equal(events.length,2);assert.equal(events.at(-1).type,'reserved');assert.equal(events.at(-1).reservation_id,'fully-held-fixture');
    const managedEntries=await fs.readdir(AUTHORITY+'/managed').catch(e=>{if(e.code==='ENOENT')return[];throw e;});assert.deepEqual(managedEntries,[]);
    const trap=await fs.readFile(AUTHORITY+'/fly-invocations.private.log').catch(e=>{if(e.code==='ENOENT')return Buffer.alloc(0);throw e;});assert.equal(trap.length,0);
    result={audited:true,effects:effects.map(e=>({...e,receipt:e.receipt?JSON.parse(e.receipt):null})),reservations,policy,events,growthPolicy,grantSchemaVersion:grant.schemaVersion,noManagedAttempt:true,noPaidAdmission:true,flyInvocations:0,queryOnly:true};
  }finally{paid.close();control.close();}
  assert.deepEqual(await Promise.all(paths.map(async p=>sha(await fs.readFile(p)))),before);return result;
}
async function serve(){
  const active=new Set(),state={requests:[],toolCalls:0};let writes=Promise.resolve();
  const persist=()=>{const next=structuredClone(state);writes=writes.then(()=>files.writePrivateJson(FIXTURE+'/mcp-state.private.json',next));return writes;};await persist();
  const server=http.createServer(async(q,s)=>{if(q.url!=='/mcp'){s.writeHead(404);s.end();return;}if(q.method!=='POST'){s.writeHead(405);s.end();return;}let mcp;
    try{const parts=[];let size=0;for await(const part of q){size+=part.length;assert.ok(size<=16384);parts.push(part);}const body=JSON.parse(Buffer.concat(parts));state.requests.push({method:body.method,id:body.id??null});await persist();
      mcp=new Server({name:'container-source-fixture',version:'1.0.0'},{capabilities:{tools:{}}});mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'fixture_probe',description:'Unpaid inert fixture',inputSchema:{type:'object',properties:{}}}]}));
      mcp.setRequestHandler(CallToolRequestSchema,async()=>{state.toolCalls++;await persist();return{content:[{type:'text',text:'fixture-probe'}]};});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});active.add(mcp);s.once('close',()=>{active.delete(mcp);void mcp.close().catch(()=>{});});await mcp.connect(transport);await transport.handleRequest(q,s,body);
    }catch{if(!s.headersSent){s.writeHead(500);s.end('{}');}else s.destroy();if(mcp){active.delete(mcp);await mcp.close().catch(()=>{});}}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3003,'127.0.0.1',resolve);});process.stdout.write(JSON.stringify({ready:true,scope:'fixture-mcp-only'})+'\n');
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});await Promise.allSettled([...active].map(m=>m.close()));await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await writes;return{stopped:true,...state};
}
try{
  let value;
  if(command==='prepare')value=await prepare();else if(command==='probe')value=await probe();else if(command==='probe-restore')value=await probe(true);else if(command==='capture')value=await capture();else if(command==='serve')value=await serve();else if(command==='stats')value=await read(FIXTURE+'/mcp-state.private.json');else if(command==='prepare-broker')value=await prepareBroker();else if(command==='send-broker')value=await sendBroker();else if(command==='broker-audit')value=await brokerAudit();else throw Error('FIXTURE_COMMAND');
  process.stdout.write(JSON.stringify(value)+'\n');
}catch{process.stderr.write(JSON.stringify({error:'CONTAINER_SOURCE_FIXTURE_FAILED',command})+'\n');process.exitCode=1;}
