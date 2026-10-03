#!/usr/bin/env node
/** Actual native FLUJO child mission; deterministic model, controller provisioning fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn,execFileSync } from 'node:child_process';
import { createHash,createCipheriv,randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FactoryControl,digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { createNativeMissionClient } from '../src/native-mission-client.mjs';
import { claimNativeMission,runNativeMission,observeNativeMission } from '../src/native-mission.mjs';

const flags={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];assert.ok(['--application','--expected-head','--evidence','--private-module'].includes(k)&&v&&!Object.hasOwn(flags,k));flags[k]=v;}
for(const k of ['--application','--evidence','--private-module'])assert.ok(path.isAbsolute(flags[k]??''));assert.match(flags['--expected-head']??'',/^[a-f0-9]{40}$/);
const application=flags['--application'],root=flags['--evidence'];
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:application,encoding:'utf8',windowsHide:true}).trim(),flags['--expected-head']);
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:application,encoding:'utf8',windowsHide:true}).trim(),'');
const privateFiles=await import(pathToFileURL(flags['--private-module']).href);await privateFiles.ensurePrivateDirectory(root);assert.equal((await fs.readdir(root)).length,0);
const require=createRequire(path.join(application,'package.json')),JSZip=require('jszip');
const version=JSON.parse(await fs.readFile(path.join(application,'package.json'),'utf8')).version;
const compatibility={applicationVersion:version,snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1};
const runtime=path.join(root,'application'),workspace='factory-mission-smoke',key=randomBytes(32),token=randomBytes(32).toString('hex');
const hash=b=>createHash('sha256').update(b).digest('hex');
let worker,workerClosed,model,proxy,control,paid,archiveHash,errorCode=null,acceptance=null,workerLog='',workerLogBytes=0,workerLogOverflow=false,modelCalls=0,posts=0,drop=true;
const workerReceipts=[],providerRequests=[],observations=[];
async function listen(s){await new Promise((res,rej)=>{s.once('error',rej);s.listen(0,'127.0.0.1',res);});return s.address().port;}
async function close(s){if(s)await new Promise(res=>{s.close(res);s.closeAllConnections?.();});}
async function port(){const s=http.createServer(),p=await listen(s);await close(s);return p;}
function safeEnv(){const env={};for(const[k,v]of Object.entries(process.env))if(/^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(k))env[k]=v;return {...env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),TMP:path.join(root,'temp'),TEMP:path.join(root,'temp'),TMPDIR:path.join(root,'temp')};}
async function stopWorker(){if(!worker)return;const child=worker,pending=workerClosed;if(child.exitCode===null)assert.ok(child.kill('SIGTERM'));const stopped=await Promise.race([pending,delay(10000).then(()=>null)]);assert.ok(stopped?.closed,'Actual worker closure required');if(worker===child)worker=null;}
async function startWorker(workerPort,archive,harness){
  const sandbox=await port(),child=spawn(process.execPath,[harness],{cwd:runtime,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...safeEnv(),
    FLUJO_WORKER_MODE:'1',FLUJO_WORKER_SNAPSHOT:archive,FLUJO_WORKER_SNAPSHOT_SHA256:archiveHash,FLUJO_WORKER_SNAPSHOT_KEY:key.toString('base64'),
    FLUJO_SNAPSHOT_CONTROL_TOKEN:token,FLUJO_DATA_DIR:path.join(root,'data'),FLUJO_APP_ROOT:runtime,FLUJO_PORT:String(workerPort),FLUJO_BASE_URL:`http://127.0.0.1:${workerPort}`,
    FLUJO_MCP_APP_SANDBOX_PORT:String(sandbox),FLUJO_MCP_APP_SANDBOX_HOST:'127.0.0.1',FLUJO_EXPOSURE_MODE:'localhost',SMOKE_PORT:String(workerPort)}});
  worker=child;const receipt={pid:child.pid,spawnedAt:new Date().toISOString(),closeCode:null,closeSignal:null,closed:false};workerReceipts.push(receipt);
  workerClosed=new Promise((res,rej)=>{child.once('error',rej);child.once('close',(code,signal)=>{Object.assign(receipt,{closeCode:code,closeSignal:signal,closed:true,closedAt:new Date().toISOString()});res(receipt);});});void workerClosed.catch(()=>{});
  for(const stream of[child.stdout,child.stderr])stream.on('data',b=>{workerLogBytes+=b.length;if(workerLogBytes>4*1048576){workerLogOverflow=true;child.kill('SIGTERM');}else workerLog+=b.toString();});
  const deadline=Date.now()+240000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('WORKER_EARLY_EXIT');
    if(workerLog.includes("Module not found: Can't resolve"))throw new Error('WORKER_COMPILE_FAILURE');
    try{const r=await fetch(`http://127.0.0.1:${workerPort}/api/worker/status`,{headers:{authorization:'Bearer '+token,'x-flujo-workspace':workspace},signal:AbortSignal.timeout(15000)}),s=await r.json();
      if(s.state==='error')throw new Error('WORKER_BOOTSTRAP_ERROR');if(r.ok&&s.state==='ready'){assert.equal(s.workspace,workspace);assert.equal(s.archiveSha256,archiveHash);observations.push(s);return;}}
    catch(e){if(e.message==='WORKER_BOOTSTRAP_ERROR')throw e;}await delay(500);
  }throw new Error('WORKER_READY_DEADLINE');
}
try{
  for(const d of['home','temp','application'])await fs.mkdir(path.join(root,d));await fs.cp(path.join(application,'src'),path.join(runtime,'src'),{recursive:true});
  for(const n of['package.json','package-lock.json','next.config.mjs','tsconfig.json','tsconfig.build.json','next-env.d.ts','postcss.config.mjs','postcss.config.js','tailwind.config.ts','tailwind.config.js']){try{await fs.copyFile(path.join(application,n),path.join(runtime,n));}catch(e){if(e.code!=='ENOENT')throw e;}}
  await fs.mkdir(path.join(runtime,'mcp-servers'));for(const n of['public','node_modules','scripts'])await fs.symlink(path.join(application,n),path.join(runtime,n),process.platform==='win32'?'junction':'dir');
  const workerPort=await port();
  proxy=http.createServer((q,s)=>{if(q.method==='POST')posts++;const f=http.request(`http://127.0.0.1:${workerPort}${q.url}`,{method:q.method,headers:{...q.headers,host:`127.0.0.1:${workerPort}`}},r=>{
    const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>{if(q.method==='POST'&&drop){drop=false;observations.push({droppedResponseStatus:r.statusCode,body:Buffer.concat(chunks).toString()});s.destroy();}else{s.writeHead(r.statusCode,r.headers);s.end(Buffer.concat(chunks));}});
  });f.on('error',()=>s.destroy());q.pipe(f);});const proxyPort=await listen(proxy);
  model=http.createServer(async(q,s)=>{try{assert.equal(q.url,'/v1/chat/completions');assert.equal(q.headers.authorization,'Bearer synthetic-mission-key');const chunks=[];for await(const b of q)chunks.push(b);const input=JSON.parse(Buffer.concat(chunks));providerRequests.push(input);modelCalls++;
    assert.ok(input.messages.some(m=>typeof m.content==='string'&&m.content.includes('factory-native-mission')));
    const message={role:'assistant',content:'fresh-native-mission-complete'},base={id:'fixture-'+modelCalls,created:Math.floor(Date.now()/1000),model:'synthetic-mission-model'};
    if(input.stream){s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:message,finish_reason:null}]})+'\n\n');s.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:4,total_tokens:8}})+'\n\n');s.end('data: [DONE]\n\n');}
    else{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message,finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:4,total_tokens:8}}));}
  }catch{s.writeHead(500,{'content-type':'application/json'});s.end(JSON.stringify({error:{message:'SYNTHETIC_PROVIDER_REJECTED'}}));}});const modelPort=await listen(model);
  const node=(id,type,properties={})=>({id,type,position:{x:0,y:0},data:{type,label:type,properties}}),nodes=[node('start','start'),node('process','process',{boundModel:'fixture',promptTemplate:'Execute the assigned factory mission and return its candidate.',inputMode:'full-history',allowQuestion:false,requireToolApproval:false}),node('finish','finish')];
  const flowTimestamp=Date.now(),flow={id:'factory-mission-flow',name:'FactoryMission',nodes,edges:nodes.slice(1).map((n,i)=>({id:nodes[i].id+'->'+n.id,source:nodes[i].id,target:n.id,sourceHandle:nodes[i].type+'-bottom',targetHandle:n.type+'-top',type:'custom',data:{edgeType:'standard'}})),createdAt:flowTimestamp,updatedAt:flowTimestamp};
  const files={'db/mcp_servers.json':'{}','db/models.json':JSON.stringify([{id:'fixture',name:'synthetic-mission-model',provider:'openai',adapter:'openai',ApiKey:'synthetic-mission-key',baseUrl:`http://127.0.0.1:${modelPort}/v1`}]),'db/flows/factory-mission-flow.json':JSON.stringify(flow)};
  const zip=new JSZip();for(const[n,c]of Object.entries(files))zip.file(n,c);
  zip.file('snapshot-manifest.json',JSON.stringify({formatVersion:2,layoutVersion:2,workspace,generation:0,createdAt:new Date().toISOString(),coherence:'registered-flujo-writers',externalRootsIncluded:false,
    subtrees:['db','mcp-servers','userdata','snapshots','screenshots','recordings','browser-profile','bash-utils','artifacts'],files:Object.entries(files).map(([n,c])=>({path:n,size:Buffer.byteLength(c),sha256:hash(c)})),source:{version,platform:process.platform},
    runtime:{codexAuth:'none',encryption:'default',mcpTransfer:{formatVersion:1,sourceWorkspaceRoot:`C:\\synthetic-source\\workspaces\\${workspace}`,servers:[]}}}));
  const plain=await zip.generateAsync({type:'nodebuffer'});archiveHash=hash(plain);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(plain),cipher.final()]),archive=path.join(root,'worker.snapshot');
  await privateFiles.writePrivateJson(archive,{format:'flujo-workspace-encrypted',version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')},{exclusive:true});
  const harness=path.join(root,'next-harness.mjs');await fs.writeFile(harness,`import{createRequire}from'node:module';import http from'node:http';const require=createRequire(${JSON.stringify(path.join(runtime,'package.json'))});const next=require('next'),app=next({dev:true,dir:${JSON.stringify(runtime)},webpack:true}),handler=app.getRequestHandler();await app.prepare();http.createServer((q,s)=>handler(q,s)).listen(Number(process.env.SMOKE_PORT),'127.0.0.1');`);
  await startWorker(workerPort,archive,harness);assert.equal(modelCalls,0);
  const actualFlow=await(await fetch(`http://127.0.0.1:${proxyPort}/api/flow/${flow.id}?workspace=${workspace}`,{headers:{authorization:'Bearer '+token,'x-flujo-workspace':workspace}})).json();assert.equal(actualFlow.id,flow.id);
  control=new FactoryControl(path.join(root,'control.sqlite'));control.initialize({mission:'Unpaid fresh native mission acceptance',budgetCents:10000,maxCells:4,maxDepth:2});
  paid=new SpendingLedger(path.join(root,'paid.sqlite'));paid.initialize({limitCents:10000,currency:'USD'});
  control.reserveCell({cellId:'native-child',role:'developer',budgetCents:1000,purpose:'Fresh native mission'});
  control.createTask({taskId:'launch-fixture',projectId:'fixture',branch:'codex/launch-fixture',specification:{problem:'Fixture provisioning',acceptance:['ready'],baseline:'synthetic'}});
  const launcher=control.claimTask('launch-fixture','root',1800000);control.admitEffect(launcher,{key:'fixture-provision',kind:'provision',request:{cellId:'native-child',app:'native-mission-fixture'}});control.startEffect(launcher,'fixture-provision');control.settleEffect('fixture-provision','succeeded',{worker:'native-mission-fixture',app:'native-mission-fixture',state:'ready'});
  const workerBinding={workspace,archiveSha256:archiveHash,compatibility},clientOptions={origin:`http://127.0.0.1:${proxyPort}`,token,...workerBinding,timeoutMs:180000};
  let client=createNativeMissionClient(clientOptions);const mission={schemaVersion:1,missionId:randomBytes(16).toString('hex'),cellId:'native-child',app:'native-mission-fixture',provisionKey:'fixture-provision',worker:workerBinding,flowId:flow.id,flowSha256:digest(actualFlow),paid:{provider:'fly',ceilingCents:500}};
  function assignment(id,nativeMission){control.createTask({taskId:id,projectId:'fixture',branch:'codex/'+id,specification:{problem:'Develop and improve FLUJO',acceptance:['independent review before delivery'],baseline:flags['--expected-head'],nativeMission}});}
  assignment('fresh-mission',mission);const outputFile=path.join(root,'output.private.json'),lease=await claimNativeMission({control,taskId:'fresh-mission',client,outputFile,ttlMs:1800000});await privateFiles.writePrivateJson(path.join(root,'lease.private.json'),lease,{exclusive:true});
  const first=await runNativeMission({control,lease,client,paidAdmission:paid,privateFiles,outputFile});assert.equal(first.effect.state,'unknown');assert.equal(first.dispatched,true);assert.equal(modelCalls,1);assert.equal(posts,1);
  const original=JSON.parse(control.db.prepare("SELECT details FROM events WHERE type='native_mission_admitted'").get().details).request;
  const saved=await fs.readFile(path.join(root,'data','workspaces',workspace,'db','conversations',original.conversationId+'.json'),'utf8');
  await stopWorker();control.close();paid.close();control=new FactoryControl(path.join(root,'control.sqlite'));paid=new SpendingLedger(path.join(root,'paid.sqlite'));client=createNativeMissionClient(clientOptions);
  await startWorker(workerPort,archive,harness);assert.equal(modelCalls,1,'Bootstrap cannot replay the assigned mission');
  const repaired=await observeNativeMission({control,key:first.effect.key,client,privateFiles});assert.equal(repaired.effect.state,'succeeded');assert.equal(modelCalls,1);assert.equal(posts,1);
  const output=await privateFiles.readPrivateJson(outputFile,{maxBytes:2*1048576});assert.equal(output.body.status,'completed');assert.ok(output.body.messages.some(m=>m.role==='assistant'&&m.content==='fresh-native-mission-complete'));
  assert.equal(control.task('fresh-mission').status,'running');assert.equal(control.task('fresh-mission').candidate,null);
  const replay=await runNativeMission({control,lease,client,paidAdmission:paid,privateFiles,outputFile});assert.equal(replay.dispatched,false);assert.equal(posts,1);
  paid.reserve({reservationId:'hold-remaining',provider:'modal',ceilingCents:9500});assignment('budget-refusal',{...mission,missionId:randomBytes(16).toString('hex')});
  const refusedOutput=path.join(root,'refused.private.json'),refusedLease=await claimNativeMission({control,taskId:'budget-refusal',client,outputFile:refusedOutput,ttlMs:1800000});
  const refused=await runNativeMission({control,lease:refusedLease,client,paidAdmission:paid,privateFiles,outputFile:refusedOutput});assert.equal(refused.effect.state,'not_applied');assert.equal(posts,1);assert.equal(modelCalls,1);
  acceptance={format:'factory-native-mission-acceptance',schemaVersion:1,applicationHead:flags['--expected-head'],worker:workerBinding,flowSha256:mission.flowSha256,first,repaired,replay,refused,
    modelCalls,posts,paidProviderCalls:0,controllerAndWorkerRestarted:true,originalConversationBeforeRestartSha256:hash(saved),taskStatus:control.task('fresh-mission').status,
    scope:'Actual fresh encrypted native FLUJO child, assigned Flow, durable mission dispatch and authenticated conversation recovery. Synthetic loopback model and controller provisioning fixture; no Fly/Modal deployment or software acceptance proof.'};
}catch(e){errorCode=e?.code??e?.message??'SMOKE_FAILED';console.error(JSON.stringify({accepted:false,errorCode}));process.exitCode=1;}
finally{
  try{await stopWorker();}catch{errorCode='WORKER_CLOSE_UNCONFIRMED';process.exitCode=1;}await close(proxy);await close(model);control?.close();paid?.close();
  if(workerLogOverflow){errorCode='WORKER_LOG_OVERFLOW';process.exitCode=1;}
  await privateFiles.writePrivateJson(path.join(root,'execution.private.json'),{format:'factory-native-mission-execution',schemaVersion:1,workerReceipts,workerLog,workerLogBytes,workerLogOverflow,providerRequests,observations,modelCalls,posts,paidProviderCalls:0,errorCode,completedAt:new Date().toISOString(),allWorkersClosed:workerReceipts.length>0&&workerReceipts.every(r=>r.closed)},{exclusive:true});
  for(const n of['public','node_modules','scripts']){const p=path.join(runtime,n),s=await fs.lstat(p).catch(()=>null);if(s?.isSymbolicLink())await fs.unlink(p);}
  if(acceptance){const accepted=errorCode===null&&process.exitCode!==1&&workerReceipts.every(r=>r.closed);await privateFiles.writePrivateJson(path.join(root,'acceptance.private.json'),{...acceptance,accepted},{exclusive:true});console.log(JSON.stringify({accepted,modelCalls,posts,paidProviderCalls:0}));}
}
