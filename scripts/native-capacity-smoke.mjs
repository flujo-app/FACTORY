#!/usr/bin/env node
/** Real isolated FLUJO worker/ExecutionEngine/MCP/peer admission; synthetic model and cloud executor. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { PeerStore, createPairConfigurations } from '../src/peer-messaging.mjs';
import { startPeerServer, dispatchPeerMessage } from '../src/peer-gateway.mjs';
import { createManagedCloudAdapter } from '../src/adapters/managed-cloud.mjs';
import { issueCapacityGrant, enqueueCapacityRequest, interpretCapacityRequest } from '../src/capacity-bridge.mjs';
import { startCapacityMcpServer, createNativeWorkerReader } from '../src/capacity-mcp.mjs';

const flags={};
for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];assert.ok(['--application','--expected-head','--evidence','--private-module'].includes(k)&&v&&!Object.hasOwn(flags,k));flags[k]=v;}
for(const k of ['--application','--evidence','--private-module'])assert.ok(path.isAbsolute(flags[k]??''));
assert.match(flags['--expected-head']??'',/^[a-f0-9]{40}$/);
const application=flags['--application'],root=flags['--evidence'];
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:application,encoding:'utf8',windowsHide:true}).trim(),flags['--expected-head']);
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:application,encoding:'utf8',windowsHide:true}).trim(),'');
const privateFiles=await import(pathToFileURL(flags['--private-module']).href);
await privateFiles.ensurePrivateDirectory(root);
const existing=await fs.readdir(root);assert.equal(existing.length,0,'Evidence directory must be fresh.');
const require=createRequire(path.join(application,'package.json')),JSZip=require('jszip');
const version=JSON.parse(await fs.readFile(path.join(application,'package.json'),'utf8')).version;
const compatibility={applicationVersion:version,snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1};
const runtime=path.join(root,'application'),workspace='factory-capacity-smoke';
const key=randomBytes(32),controlToken=randomBytes(32).toString('hex'),mcpToken=randomBytes(32).toString('hex');
const hash=b=>createHash('sha256').update(b).digest('hex');
let worker,workerClosed,mcp,receiver,proxy,model,control,paid,senderStore,receiverStore,grant,policy;
let nativeReader,archiveHash,stage='accepted',dropAck=true,modelCalls=0,cloudCalls=0;
const workerReceipts=[],providerRequests=[],toolResults=[],httpProof=[];
let workerLog='',errorCode=null,acceptance=null;
async function listen(s){await new Promise((res,rej)=>{s.once('error',rej);s.listen(0,'127.0.0.1',res);});return s.address().port;}
async function port(){const s=http.createServer();const p=await listen(s);await close(s);return p;}
async function close(s){if(s)await new Promise(res=>{s.close(res);s.closeAllConnections?.();});}
function safeEnv(){const env={};for(const [k,v]of Object.entries(process.env))if(/^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(k))env[k]=v;return {...env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),TMP:path.join(root,'temp'),TEMP:path.join(root,'temp'),TMPDIR:path.join(root,'temp')};}
async function stopWorker(){if(!worker)return;const current=worker,closed=workerClosed;
  if(current.exitCode===null)assert.ok(current.kill('SIGTERM'),'Retained worker handle must accept termination');
  const stopped=await Promise.race([closed,delay(10000).then(()=>null)]);assert.ok(stopped?.closed,'Actual worker close required');
  if(worker===current)worker=null;
}
async function startWorker(workerPort,archive,harness){const sandbox=await port();
  const child=spawn(process.execPath,[harness],{cwd:runtime,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...safeEnv(),
    FLUJO_WORKER_MODE:'1',FLUJO_WORKER_SNAPSHOT:archive,FLUJO_WORKER_SNAPSHOT_SHA256:archiveHash,FLUJO_WORKER_SNAPSHOT_KEY:key.toString('base64'),
    FLUJO_SNAPSHOT_CONTROL_TOKEN:controlToken,FLUJO_DATA_DIR:path.join(root,'data'),FLUJO_APP_ROOT:runtime,FLUJO_PORT:String(workerPort),FLUJO_BASE_URL:`http://127.0.0.1:${workerPort}`,
    FLUJO_MCP_APP_SANDBOX_PORT:String(sandbox),FLUJO_MCP_APP_SANDBOX_HOST:'127.0.0.1',FLUJO_EXPOSURE_MODE:'localhost',SMOKE_PORT:String(workerPort)}});
  worker=child;const receipt={pid:child.pid,spawnedAt:new Date().toISOString(),closeCode:null,closeSignal:null,closed:false};workerReceipts.push(receipt);
  workerClosed=new Promise((res,rej)=>{child.once('error',rej);child.once('close',(code,signal)=>{Object.assign(receipt,{closeCode:code,closeSignal:signal,closed:true,closedAt:new Date().toISOString()});res(receipt);});});
  void workerClosed.catch(()=>{});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{workerLog+=b.toString();});
  const deadline=Date.now()+240000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('WORKER_EARLY_EXIT');
    if(workerLog.includes("Module not found: Can't resolve"))throw new Error('WORKER_COMPILE_FAILURE');
    try{const r=await fetch(`http://127.0.0.1:${workerPort}/api/worker/status`,{headers:{authorization:'Bearer '+controlToken},signal:AbortSignal.timeout(15000)});const s=await r.json();
      if(s.state==='error')throw new Error('WORKER_BOOTSTRAP_ERROR');if(r.ok&&s.state==='ready'){httpProof.push({route:'/api/worker/status',status:r.status,body:s});return s;}}
    catch(e){if(e.message==='WORKER_BOOTSTRAP_ERROR')throw e;}await delay(500);
  }throw new Error('WORKER_READY_DEADLINE');}
try{
  for(const d of ['home','temp','application'])await fs.mkdir(path.join(root,d));
  await fs.cp(path.join(application,'src'),path.join(runtime,'src'),{recursive:true});
  for(const n of ['package.json','package-lock.json','next.config.mjs','tsconfig.json','tsconfig.build.json','next-env.d.ts','postcss.config.mjs','postcss.config.js','tailwind.config.ts','tailwind.config.js']){
    try{await fs.copyFile(path.join(application,n),path.join(runtime,n));}catch(e){if(e.code!=='ENOENT')throw e;}}
  // Remote-only MCP transfer needs no shared runtime build directory.
  await fs.mkdir(path.join(runtime,'mcp-servers'));
  for(const n of ['public','node_modules','scripts'])await fs.symlink(path.join(application,n),path.join(runtime,n),process.platform==='win32'?'junction':'dir');
  const workerPort=await port(),receiverPort=await port();
  proxy=http.createServer((q,s)=>{const forwarded=http.request(`http://127.0.0.1:${receiverPort}${q.url}`,{method:q.method,headers:q.headers},r=>{
    const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>{if(dropAck){dropAck=false;s.destroy();}else{s.writeHead(r.statusCode,r.headers);s.end(Buffer.concat(chunks));}});});forwarded.on('error',()=>s.destroy());q.pipe(forwarded);});
  const proxyPort=await listen(proxy);
  const pair=createPairConfigurations({a:{identity:{factoryId:'native-smoke',cellId:'root'},endpoint:`http://127.0.0.1:${await port()}/v1/peer/messages`},
    b:{identity:{factoryId:'native-smoke',cellId:'broker'},endpoint:`http://127.0.0.1:${proxyPort}/v1/peer/messages`},credentialExpiresAt:Date.now()+3600000});
  senderStore=new PeerStore(path.join(root,'sender.sqlite'),{config:pair.a});receiverStore=new PeerStore(path.join(root,'receiver.sqlite'),{config:pair.b});
  receiver=await startPeerServer({store:receiverStore,port:receiverPort});
  control=new FactoryControl(path.join(root,'control.sqlite'));control.initialize({mission:'Unpaid native capacity acceptance',budgetCents:10000,maxCells:4,maxDepth:2});
  control.createTask({taskId:'mission',projectId:'fixture',branch:'codex/native-smoke',specification:{problem:'Request bounded child capacity',acceptance:['durable admitted request'],baseline:'synthetic'}});
  const lease=control.claimTask('mission','root',1800000);
  paid=new SpendingLedger(path.join(root,'paid.sqlite'));paid.initialize({limitCents:10000,currency:'USD'});
  mcp=await startCapacityMcpServer({token:mcpToken,nativeReader:{read:()=>nativeReader.read()},async requestCapacity(request,native){
    const o=enqueueCapacityRequest({store:senderStore,grant:policy,request,nativeProof:native});
    const result=await dispatchPeerMessage({store:senderStore,messageId:o.messageId});toolResults.push(result);return result;}});
  model=http.createServer(async(q,s)=>{try{assert.equal(q.url,'/v1/chat/completions');assert.equal(q.headers.authorization,'Bearer synthetic-smoke-key');const parts=[];for await(const p of q)parts.push(p);const b=JSON.parse(Buffer.concat(parts));providerRequests.push(b);modelCalls++;
    const tool=b.tools?.find(t=>t.function?.name?.includes('factory_capacity_request'));assert.ok(tool,'Native MCPNode must advertise the real tool');
    const hasResult=b.messages.some(m=>m.role==='tool');const request={requestId:stage==='accepted'?'r1':'r2',role:'developer',budgetCents:500,purpose:'Explore an isolated FLUJO development branch'};
    const message=hasResult?{role:'assistant',content:'native-capacity-complete'}:{role:'assistant',content:null,tool_calls:[{id:'call_'+request.requestId,type:'function',function:{name:tool.function.name,arguments:JSON.stringify(request)}}]};
    const base={id:'fixture-'+modelCalls,created:Math.floor(Date.now()/1000),model:'synthetic-capacity-model'};
    if(b.stream){s.writeHead(200,{'content-type':'text/event-stream'});const delta=hasResult?message:{role:'assistant',tool_calls:message.tool_calls.map((t,index)=>({...t,index}))};
      s.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
      s.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:hasResult?'stop':'tool_calls'}],usage:{prompt_tokens:4,completion_tokens:4,total_tokens:8}})+'\n\n');s.end('data: [DONE]\n\n');
    }else{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message,finish_reason:hasResult?'stop':'tool_calls'}],usage:{prompt_tokens:4,completion_tokens:4,total_tokens:8}}));}
  }catch{s.writeHead(500,{'content-type':'application/json'});s.end(JSON.stringify({error:{message:'SYNTHETIC_PROVIDER_REJECTED'}}));}});
  const modelPort=await listen(model),sourceRoot=`C:\\synthetic-source\\workspaces\\${workspace}`;
  const node=(id,type,properties={})=>({id,type,position:{x:0,y:0},data:{type,label:type,properties}});
  const nodes=[node('start','start'),node('capacity','mcp',{boundServer:'capacity',enabledTools:['factory_capacity_request']}),node('process','process',{boundModel:'fixture',promptTemplate:'Request bounded capacity using the advertised tool, then finish.',inputMode:'full-history',allowQuestion:false,requireToolApproval:false}),node('finish','finish')];
  const edges=nodes.slice(1).map((n,i)=>({id:nodes[i].id+'->'+n.id,source:nodes[i].id,target:n.id,sourceHandle:nodes[i].type+'-bottom',targetHandle:n.type+'-top',type:'custom',data:{edgeType:'standard'}}));
  const flow={id:'factory-capacity-flow',name:'FactoryCapacity',nodes,edges,updatedAt:Date.now()};
  const files={'db/mcp_servers.json':JSON.stringify({capacity:{name:'capacity',transport:'streamable',serverUrl:mcp.endpoint,headers:{Authorization:'Bearer '+mcpToken},disabled:false,env:{},roots:[],rootPath:sourceRoot+'\\mcp-servers\\capacity'}}),
    'db/models.json':JSON.stringify([{id:'fixture',name:'synthetic-capacity-model',provider:'openai',adapter:'openai',ApiKey:'synthetic-smoke-key',baseUrl:`http://127.0.0.1:${modelPort}/v1`}]),
    'db/flows/factory-capacity-flow.json':JSON.stringify(flow)};
  const zip=new JSZip();for(const [n,c]of Object.entries(files))zip.file(n,c);
  zip.file('snapshot-manifest.json',JSON.stringify({formatVersion:2,layoutVersion:2,workspace,generation:0,createdAt:new Date().toISOString(),coherence:'registered-flujo-writers',externalRootsIncluded:false,
    subtrees:['db','mcp-servers','userdata','snapshots','screenshots','recordings','browser-profile','bash-utils','artifacts'],files:Object.entries(files).map(([n,c])=>({path:n,size:Buffer.byteLength(c),sha256:hash(c)})),source:{version,platform:process.platform},
    runtime:{codexAuth:'none',encryption:'default',mcpTransfer:{formatVersion:1,sourceWorkspaceRoot:sourceRoot,servers:[{name:'capacity',kind:'remote',sourceRootPath:sourceRoot+'\\mcp-servers\\capacity'}]}}}));
  const plain=await zip.generateAsync({type:'nodebuffer'});archiveHash=hash(plain);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(plain),cipher.final()]);
  const archive=path.join(root,'worker.snapshot');await privateFiles.writePrivateJson(archive,{format:'flujo-workspace-encrypted',version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')},{exclusive:true});
  nativeReader=createNativeWorkerReader({origin:`http://127.0.0.1:${workerPort}`,token:controlToken,workspace,archiveSha256:archiveHash,compatibility});
  grant={schemaVersion:1,grantId:'native-grant',generation:1,lease,expiresAt:lease.expires,maxChildren:2,maxBudgetCents:1000,allowedRoles:['developer'],
    native:{workspace,archiveSha256:archiveHash,compatibility},template:{source:'http://127.0.0.1:4200',workspace,image:'registry.invalid/fixture@sha256:'+'a'.repeat(64),org:'synthetic',region:'iad',appPrefix:'native-fixture',flowIds:[flow.id]},paid:{provider:'fly',ceilingCents:500}};
  const issued=issueCapacityGrant({control,store:receiverStore,grant});policy=issued.policy;
  const harness=path.join(root,'next-harness.mjs');await fs.writeFile(harness,`import {createRequire} from 'node:module';import http from 'node:http';const require=createRequire(${JSON.stringify(path.join(runtime,'package.json'))});const next=require('next');const app=next({dev:true,dir:${JSON.stringify(runtime)},webpack:true});const handler=app.getRequestHandler();await app.prepare();http.createServer((q,s)=>handler(q,s)).listen(Number(process.env.SMOKE_PORT),'127.0.0.1');`);
  const ready=await startWorker(workerPort,archive,harness);assert.equal(ready.workspace,workspace);assert.deepEqual(ready.servers,[{name:'capacity',status:'ready'}]);assert.equal(modelCalls,0);
  const proof=await nativeReader.read();httpProof.push({route:'/api/snapshot/info',proof});
  const adapter=await createManagedCloudAdapter({service:{async sources(){return[];},async preflight(){throw new Error('FORBIDDEN_PREFLIGHT');},async up(i){cloudCalls++;return {app:i.app,worker:i.app,workspace:i.workspace,org:i.org,region:i.region,state:'ready',phase:'ready'};},async call(){throw new Error('FORBIDDEN_CLOUD_CALL');},async list(){return[];},async down(){throw new Error('FORBIDDEN_RETIRE');}}});
  async function flowCall(id){const r=await fetch(`http://127.0.0.1:${workerPort}/v1/chat/completions?workspace=${workspace}`,{method:'POST',headers:{authorization:'Bearer '+controlToken,'content-type':'application/json'},body:JSON.stringify({model:'flow-FactoryCapacity',stream:false,messages:[{role:'user',content:'Request child capacity.'}],metadata:{conversationId:id,flujo:'true'}}),signal:AbortSignal.timeout(180000)});const b=await r.json();httpProof.push({route:'/v1/chat/completions',status:r.status,body:b});assert.equal(r.status,200);assert.equal(b.choices?.[0]?.message?.content,'native-capacity-complete');}
  await flowCall('native-accepted');assert.equal(toolResults.length,1);assert.equal(toolResults[0].state,'pending','Lost ACK must retain original outbox');
  const first=senderStore.outbox(toolResults[0].messageId);assert.ok(first);assert.equal(receiverStore.inbox().length,1);
  const admitted=await interpretCapacityRequest({control,store:receiverStore,grant,messageId:first.messageId,adapter,paidAdmission:paid});assert.equal(admitted.dispatched,true);assert.equal(cloudCalls,1);
  const effect1=control.db.prepare("SELECT key,state FROM effects WHERE kind='provision'").get();assert.equal(effect1.state,'succeeded');
  const originalBody=first.body.toString(),callsBeforeRestart=modelCalls;
  const conversationFile=path.join(root,'data','workspaces',workspace,'db','conversations','native-accepted.json'),saved=await fs.readFile(conversationFile,'utf8');assert.equal(JSON.parse(saved).unattended,true);
  await stopWorker();await close(receiver);receiver=null;senderStore.close();receiverStore.close();
  senderStore=new PeerStore(path.join(root,'sender.sqlite'),{config:pair.a});receiverStore=new PeerStore(path.join(root,'receiver.sqlite'),{config:pair.b});
  receiver=await startPeerServer({store:receiverStore,port:receiverPort});
  assert.equal(senderStore.outbox(first.messageId).body.toString(),originalBody);
  const ack=await dispatchPeerMessage({store:senderStore,messageId:first.messageId});assert.equal(ack.state,'acknowledged');assert.equal(receiverStore.inbox().length,1);
  const replay=await interpretCapacityRequest({control,store:receiverStore,grant,messageId:first.messageId,adapter,paidAdmission:paid});assert.equal(replay.dispatched,false);assert.equal(cloudCalls,1);
  await startWorker(workerPort,archive,harness);assert.equal(modelCalls,callsBeforeRestart,'Worker bootstrap cannot replay Flow');assert.equal(await fs.readFile(conversationFile,'utf8'),saved);
  paid.reserve({reservationId:'hold-remaining',provider:'fly',ceilingCents:9500});stage='blocked';await flowCall('native-blocked');
  const second=toolResults[1];assert.equal(second.state,'acknowledged');const refused=await interpretCapacityRequest({control,store:receiverStore,grant,messageId:second.messageId,adapter,paidAdmission:paid});assert.equal(refused.dispatched,false);assert.equal(cloudCalls,1);
  const effects=control.db.prepare("SELECT key,state FROM effects WHERE kind='provision' ORDER BY created,key").all();assert.equal(effects.length,2);assert.equal(effects.filter(e=>e.state==='not_applied').length,1);
  acceptance={format:'factory-native-capacity-acceptance',version:1,applicationHead:flags['--expected-head'],nativeProof:proof,issued,
    modelCalls,cloudCalls,injectedCloudExecutor:true,paidProviderCalls:0,toolResults,admitted,replay,refused,effects:effects.map(x=>({...x})),lostAckReplayedOriginal:true,nativeRestartPreserved:true,
    scope:'Actual isolated encrypted FLUJO worker, native ExecutionEngine and real MCP tool/peer transport/standing grant/controller admission. Synthetic loopback model and injected ManagedCloud executor; no deployed child or paid inference proof.'};
}catch(e){errorCode=e?.code??e?.message??'SMOKE_FAILED';console.error(JSON.stringify({accepted:false,errorCode}));process.exitCode=1;}
finally{
  try{await stopWorker();}catch{errorCode='WORKER_CLOSE_UNCONFIRMED';process.exitCode=1;}
  await mcp?.close();await close(receiver);await close(proxy);await close(model);
  senderStore?.close();receiverStore?.close();control?.close();paid?.close();
  await privateFiles.writePrivateJson(path.join(root,'execution.private.json'),{format:'factory-native-capacity-execution',version:1,workerReceipts,workerLog,providerRequests,httpProof,modelCalls,cloudCalls,paidProviderCalls:0,errorCode,completedAt:new Date().toISOString(),allWorkersClosed:workerReceipts.length>0&&workerReceipts.every(r=>r.closed)},{exclusive:true});
  // Evidence is retained. Unlink read-only overlay junctions to prevent accidental traversal later.
  for(const n of ['public','node_modules','scripts']){const p=path.join(runtime,n);const stat=await fs.lstat(p).catch(()=>null);if(stat?.isSymbolicLink())await fs.unlink(p);}
  if(acceptance){const accepted=errorCode===null&&process.exitCode!==1&&workerReceipts.every(r=>r.closed);
    await privateFiles.writePrivateJson(path.join(root,'acceptance.private.json'),{...acceptance,accepted},{exclusive:true});
    console.log(JSON.stringify({accepted,nativeFlowRequests:2,exactReplay:true,injectedProvisionCalls:cloudCalls,paidProviderCalls:0}));
  }
}
