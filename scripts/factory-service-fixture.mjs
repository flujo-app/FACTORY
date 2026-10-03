#!/usr/bin/env node
/** Isolated Docker acceptance fixture. It is not a production authority initializer. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FactoryControl, digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import * as privateFiles from '../deploy/private-files.mjs';

process.umask(0o077);
const AUTHORITY='/authority', DATA='/data', FIXTURE='/fixture';
const PROFILE=AUTHORITY+'/profile.private.json', META=AUTHORITY+'/fixture-meta.private.json';
const SHA=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>JSON.parse(JSON.stringify(value));
const command=process.argv[2];
let control,paid;
function databases(){control=new FactoryControl(AUTHORITY+'/control.sqlite');paid=new SpendingLedger(AUTHORITY+'/paid.sqlite');}
async function read(filename,maxBytes=1048576){return privateFiles.readPrivateJson(filename,{maxBytes});}
async function write(filename,value){await privateFiles.writePrivateJson(filename,value,{exclusive:true});}
async function fetchJson(url,token){
  const response=await fetch(url,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});
  const chunks=[];let size=0;for await(const chunk of response.body??[]){size+=chunk.length;assert.ok(size<=1048576);chunks.push(chunk);}
  const body=Buffer.concat(chunks).toString('utf8');return {status:response.status,body,value:JSON.parse(body)};
}
// ZIP32 STORE writer: fixed small fixture members, regular owner-private files, no dependencies.
function zipFiles(files){
  const locals=[],central=[];let offset=0;
  const crc32=bytes=>{let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
  for(const [name,text] of Object.entries(files)){
    const nameBytes=Buffer.from(name),body=Buffer.from(text),crc=crc32(body),local=Buffer.alloc(30),record=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(nameBytes.length,26);
    record.writeUInt32LE(0x02014b50);record.writeUInt16LE((3<<8)|20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);
    record.writeUInt32LE(crc,16);record.writeUInt32LE(body.length,20);record.writeUInt32LE(body.length,24);record.writeUInt16LE(nameBytes.length,28);
    record.writeUInt32LE((0o100600<<16)>>>0,38);record.writeUInt32LE(offset,42);
    locals.push(local,nameBytes,body);central.push(record,nameBytes);offset+=local.length+nameBytes.length+body.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);
  end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
async function init(){
  const [version,sourceHead,operation,workerRevision]=process.argv.slice(3);assert.match(version??'',/^\d+\.\d+\.\d+$/);
  assert.match(sourceHead??'',/^[a-f0-9]{40}$/);assert.match(operation??'',/^[a-f0-9-]{36}$/);
  assert.match(workerRevision??'',/^[a-f0-9]{40}$/);
  assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
  for(const directory of [AUTHORITY,DATA,FIXTURE]){await privateFiles.assertPrivateDirectory(directory);assert.equal((await fs.readdir(directory)).length,0);}
  await privateFiles.ensurePrivateDirectory(AUTHORITY+'/outputs');
  const workspace='factory-service-smoke',token=randomBytes(32).toString('hex'),key=randomBytes(32);
  const compatibility={applicationVersion:version,snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1,revision:workerRevision};
  const node=(id,type,properties={})=>({id,type,position:{x:0,y:0},data:{type,label:type,properties}});
  const nodes=[node('start','start'),node('process','process',{boundModel:'fixture',promptTemplate:'Execute the assigned factory mission and return its candidate.',inputMode:'full-history',allowQuestion:false,requireToolApproval:false}),node('finish','finish')];
  const timestamp=Date.now(),flow={id:'factory-service-flow',name:'FactoryServiceMission',nodes,
    edges:nodes.slice(1).map((n,i)=>({id:nodes[i].id+'->'+n.id,source:nodes[i].id,target:n.id,sourceHandle:nodes[i].type+'-bottom',targetHandle:n.type+'-top',type:'custom',data:{edgeType:'standard'}})),createdAt:timestamp,updatedAt:timestamp};
  const files={'db/mcp_servers.json':'{}','db/models.json':JSON.stringify([{id:'fixture',name:'synthetic-service-model',provider:'openai',adapter:'openai',ApiKey:'synthetic-service-key',baseUrl:'http://127.0.0.1:3001/v1'}]),'db/flows/factory-service-flow.json':JSON.stringify(flow)};
  files['snapshot-manifest.json']=JSON.stringify({formatVersion:2,layoutVersion:2,workspace,generation:0,createdAt:new Date().toISOString(),coherence:'registered-flujo-writers',externalRootsIncluded:false,
    subtrees:['db','mcp-servers','userdata','snapshots','screenshots','recordings','browser-profile','bash-utils','artifacts'],
    files:Object.entries(files).map(([name,text])=>({path:name,size:Buffer.byteLength(text),sha256:SHA(text)})),source:{version,platform:'linux'},
    runtime:{codexAuth:'none',encryption:'default',mcpTransfer:{formatVersion:1,sourceWorkspaceRoot:'/synthetic-source/workspaces/'+workspace,servers:[]}}});
  const archive=zipFiles(files),archiveSha256=SHA(archive),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(archive),cipher.final()]);
  await write(DATA+'/worker.snapshot',{format:'flujo-workspace-encrypted',version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')});
  const worker={workspace,archiveSha256,compatibility};
  const mission={schemaVersion:1,missionId:randomBytes(16).toString('hex'),cellId:'native-child',app:'factory-service-fixture',provisionKey:'fixture-provision',worker,
    flowId:flow.id,flowSha256:digest(flow),paid:{provider:'synthetic-model',ceilingCents:500}};
  const meta={format:'factory-service-fixture',schemaVersion:1,operation,sourceHead,flow,mission,budgetMissionId:randomBytes(16).toString('hex')};
  await write(META,meta);await write(AUTHORITY+'/native-token.private.json',{token});
  await write(PROFILE,{controlDatabase:AUTHORITY+'/control.sqlite',spendingDatabase:AUTHORITY+'/paid.sqlite',
    client:{origin:'http://127.0.0.1:3000',tokenFile:AUTHORITY+'/native-token.private.json',worker,timeoutMs:120000},
    cell:{cellId:mission.cellId,app:mission.app,provisionKey:mission.provisionKey,worker,outputDirectory:AUTHORITY+'/outputs',ttlMs:1800000,pollMs:100}});
  await write(FIXTURE+'/secrets.private.json',{token,key:key.toString('base64'),worker,flow,operation});
  await write(FIXTURE+'/runtime.private.json',{operation,modelCalls:0,posts:0,dropped:null,allowObservation:false,providerRequests:[],failures:[]});
  // Private bootstrap provides secrets only to the native process, never Docker arguments/config.
  await fs.writeFile(FIXTURE+'/worker-launch.mjs',`import fs from 'node:fs/promises';\nprocess.umask(0o077);const p='/fixture/secrets.private.json',s=await fs.lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1)throw Error('FIXTURE_PRIVATE');const v=JSON.parse(await fs.readFile(p,'utf8'));Object.assign(process.env,{FLUJO_WORKER_MODE:'1',FLUJO_WORKER_SNAPSHOT:'/data/worker.snapshot',FLUJO_WORKER_SNAPSHOT_SHA256:v.worker.archiveSha256,FLUJO_WORKER_SNAPSHOT_KEY:v.key,FLUJO_SNAPSHOT_CONTROL_TOKEN:v.token,FLUJO_DATA_DIR:'/data/flujo',FLUJO_APP_ROOT:'/app',FLUJO_PORT:'4200',FLUJO_BASE_URL:'http://127.0.0.1:4200',FLUJO_EXPOSURE_MODE:'localhost',NEXT_TELEMETRY_DISABLED:'1'});process.argv=[process.execPath,'/app/scripts/launch-next.mjs','start','-p','4200','-H','127.0.0.1'];await import('/app/scripts/launch-next.mjs');\n`,{flag:'wx',mode:0o600});
  databases();control.initialize({mission:'Isolated unpaid packaged native factory acceptance',budgetCents:10000,maxCells:4,maxDepth:2});
  paid.initialize({limitCents:10000,currency:'USD'});control.reserveCell({cellId:'native-child',role:'developer',budgetCents:1000,purpose:'Fixture native worker'});
  control.createTask({taskId:'launch-fixture',projectId:'fixture',branch:'codex/launch-fixture',specification:{problem:'Synthetic provisioning receipt only',acceptance:['ready'],baseline:'synthetic'}});
  const lease=control.claimTask('launch-fixture','root',1800000);control.admitEffect(lease,{key:mission.provisionKey,kind:'provision',request:{cellId:mission.cellId,app:mission.app}});
  control.startEffect(lease,mission.provisionKey);control.settleEffect(mission.provisionKey,'succeeded',{app:mission.app,worker:mission.app,state:'ready'});
  return {initialized:true,operation,worker,flowSha256:mission.flowSha256,node:process.version,uid:process.getuid(),gid:process.getgid()};
}
async function serve(){
  const secrets=await read(FIXTURE+'/secrets.private.json'),state=await read(FIXTURE+'/runtime.private.json');let queue=Promise.resolve();
  const persist=()=>{const snapshot=normalize(state);queue=queue.then(()=>privateFiles.writePrivateJson(FIXTURE+'/runtime.private.json',snapshot));void queue.catch(()=>{});return queue;};
  const model=http.createServer(async(q,s)=>{try{
    assert.equal(q.method,'POST');assert.equal(q.url,'/v1/chat/completions');assert.equal(q.headers.authorization,'Bearer synthetic-service-key');
    const chunks=[];let size=0;for await(const b of q){size+=b.length;assert.ok(size<=65536);chunks.push(b);}const input=JSON.parse(Buffer.concat(chunks));
    assert.ok(input.messages.some(m=>typeof m.content==='string'&&m.content.includes('factory-native-mission')));
    state.modelCalls++;state.providerRequests.push(input);await persist();
    const message={role:'assistant',content:'packaged-native-mission-complete'},base={id:'fixture-'+state.modelCalls,created:Math.floor(Date.now()/1000),model:'synthetic-service-model'};
    if(input.stream){s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:message,finish_reason:null}]})+'\n\n');s.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:4,total_tokens:8}})+'\n\n');s.end('data: [DONE]\n\n');}
    else{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message,finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:4,total_tokens:8}}));}
  }catch{state.failures.push('SYNTHETIC_MODEL_REJECTED');await persist();s.writeHead(500);s.end('{}');}});
  const proxy=http.createServer((q,s)=>{
    if(q.method==='GET'&&q.url.startsWith('/v1/chat/conversations/')&&state.dropped!==null&&!state.allowObservation){s.writeHead(503,{'content-type':'application/json'});s.end('{}');return;}
    const isPost=q.method==='POST';if(isPost){state.posts++;void persist();}
    const target=http.request({hostname:'127.0.0.1',port:4200,path:q.url,method:q.method,headers:{...q.headers,host:'127.0.0.1:4200'},timeout:120000},r=>{
      const chunks=[];let size=0;r.on('data',b=>{size+=b.length;if(size>1048576){target.destroy();s.destroy();state.failures.push('PROXY_RESPONSE_LIMIT');void persist();}else chunks.push(b);});
      r.on('end',()=>{void(async()=>{const body=Buffer.concat(chunks);if(isPost&&state.dropped===null){state.dropped={status:r.statusCode,body:body.toString('utf8'),sha256:SHA(body)};await persist();s.destroy();}
        else{s.writeHead(r.statusCode,r.headers);s.end(body);}})().catch(()=>s.destroy());});
    });target.on('timeout',()=>target.destroy());target.on('error',()=>s.destroy());q.pipe(target);
  });
  const admin=http.createServer(async(q,s)=>{if(q.method!=='POST'||q.url!=='/release'||q.headers.authorization!=='Bearer '+secrets.token){s.writeHead(404);s.end('{}');return;}state.allowObservation=true;try{await persist();s.writeHead(200,{'content-type':'application/json'});s.end('{"released":true}');}catch{s.destroy();}});
  for(const [server,port] of [[model,3001],[proxy,3000],[admin,3002]])await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  process.stdout.write(JSON.stringify({listening:true,operation:secrets.operation,modelPort:3001,proxyPort:3000})+'\n');
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  for(const server of [model,proxy,admin])await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await queue;
  return {stopped:true,operation:secrets.operation};
}
async function probe(){
  const secrets=await read(FIXTURE+'/secrets.private.json');
  const status=await fetchJson('http://127.0.0.1:4200/api/worker/status?workspace='+secrets.worker.workspace,secrets.token);
  if(status.status!==200||status.value.state!=='ready')return {ready:false,status:status.status};
  assert.equal(status.value.workspace,secrets.worker.workspace);assert.equal(status.value.archiveSha256,secrets.worker.archiveSha256);
  const info=await fetchJson('http://127.0.0.1:4200/api/snapshot/info?workspace='+secrets.worker.workspace,secrets.token);
  assert.equal(info.status,200);assert.equal(info.value.workspace,secrets.worker.workspace);assert.deepEqual(info.value.workerCompatibility,secrets.worker.compatibility);
  const flow=await fetchJson('http://127.0.0.1:4200/api/flow/'+secrets.flow.id+'?workspace='+secrets.worker.workspace,secrets.token);
  assert.equal(flow.status,200);assert.equal(digest(flow.value),digest(secrets.flow));
  return {ready:true,worker:secrets.worker,status:status.value,workerCompatibility:info.value.workerCompatibility,flowSha256:digest(flow.value)};
}
async function assignment(budget=false){
  const meta=await read(META);databases();
  if(budget){control.resume();paid.reserve({reservationId:'hold-remaining',provider:'synthetic-model',ceilingCents:9500});}
  const nativeMission=budget?{...meta.mission,missionId:meta.budgetMissionId}:meta.mission,taskId=budget?'budget-refusal':'fresh-mission';
  control.createTask({taskId,projectId:'fixture',branch:'codex/'+taskId,specification:{problem:'Develop and improve FLUJO',acceptance:['independent review before delivery'],baseline:meta.sourceHead,nativeMission}});
  return {created:true,taskId,missionId:nativeMission.missionId};
}
async function audit(){
  const meta=await read(META),mainPaths=[AUTHORITY+'/control.sqlite',AUTHORITY+'/paid.sqlite'];
  const before=await Promise.all(mainPaths.map(async p=>({path:p,sha256:SHA(await fs.readFile(p))})));
  const db=new DatabaseSync(mainPaths[0],{readOnly:true}),money=new DatabaseSync(mainPaths[1],{readOnly:true});let result;
  try{
    db.exec('PRAGMA query_only=ON; BEGIN;');money.exec('PRAGMA query_only=ON; BEGIN;');
    const tasks=db.prepare('SELECT * FROM tasks ORDER BY id').all().map(row=>({...row,specification:JSON.parse(row.specification),candidate:row.candidate?JSON.parse(row.candidate):null,review:row.review?JSON.parse(row.review):null}));
    const effects=db.prepare('SELECT * FROM effects ORDER BY key').all().map(row=>({...row,receipt:row.receipt?JSON.parse(row.receipt):null}));
    const events=db.prepare('SELECT * FROM events ORDER BY seq').all().map(row=>({...row,details:JSON.parse(row.details)}));
    const admitted=events.filter(e=>e.type==='native_mission_admitted');assert.equal(admitted.length,1);const original=admitted[0].details.request;
    const conversationPath=DATA+'/flujo/workspaces/'+meta.mission.worker.workspace+'/db/conversations/'+original.conversationId+'.json';
    const rawConversation=await fs.readFile(conversationPath),conversation=JSON.parse(rawConversation);assert.equal(conversation.status,'completed');
    let output=null;try{output=await read(original.outputFile,2097152);}catch(e){if(e.code!=='ENOENT')throw e;}
    result=normalize({format:'factory-service-state-audit',schemaVersion:1,operation:meta.operation,meta,tasks,effects,events,original,
      conversation:{path:conversationPath,sha256:SHA(rawConversation),bytes:rawConversation.length,body:conversation},output,
      paid:{policy:money.prepare('SELECT * FROM spending_policy').get(),reservations:money.prepare('SELECT * FROM spending_reservations ORDER BY id').all(),events:money.prepare('SELECT * FROM spending_events ORDER BY seq').all()},
      modes:await Promise.all([AUTHORITY,AUTHORITY+'/control.sqlite',AUTHORITY+'/paid.sqlite',PROFILE,DATA+'/worker.snapshot'].map(async p=>{const s=await fs.lstat(p);return {path:p,uid:s.uid,gid:s.gid,mode:s.mode&0o777,nlink:s.nlink};}))});
  }finally{db.close();money.close();}
  const after=await Promise.all(mainPaths.map(async p=>({path:p,sha256:SHA(await fs.readFile(p))})));assert.deepEqual(after,before);
  return {...result,auditStorage:{authorityMount:'read-write-fixture-only',databaseOpen:'read-only',queryOnly:true,mayCreateSqliteSidecars:true,mainBytesUnchanged:true,before,after}};
}
try{
  assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);assert.ok(Number(process.versions.node.split('.')[0])>=24);
  let value;
  switch(command){
    case 'init':value=await init();break;
    case 'serve':value=await serve();break;
    case 'probe':value=await probe();break;
    case 'release':{const secrets=await read(FIXTURE+'/secrets.private.json');const response=await fetch('http://127.0.0.1:3002/release',{method:'POST',headers:{authorization:'Bearer '+secrets.token},redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);value=await response.json();assert.deepEqual(value,{released:true});break;}
    case 'stats':value=await read(FIXTURE+'/runtime.private.json',4194304);break;
    case 'inject':value=await assignment();break;
    case 'hold':value=await assignment(true);break;
    case 'pause':databases();value=control.pause();break;
    case 'audit':value=await audit();break;
    case 'metadata':value={node:process.version,uid:process.getuid(),gid:process.getgid(),files:await Promise.all(['package.json','package-lock.json','deploy/private-files.mjs','scripts/factory-service-fixture.mjs','scripts/factory-service-smoke.mjs','bin/native-cell.mjs','src/native-cell.mjs','src/native-mission.mjs','src/native-mission-contract.mjs','src/native-mission-client.mjs','src/control.mjs','src/spending.mjs'].map(async p=>({path:p,sha256:SHA(await fs.readFile('/app/'+p))})))};break;
    default:throw new Error('FIXTURE_COMMAND');
  }
  process.stdout.write(JSON.stringify(value)+'\n');
}catch{process.stderr.write(JSON.stringify({error:'FACTORY_SERVICE_FIXTURE_FAILED',command})+'\n');process.exitCode=1;}
finally{paid?.close();control?.close();}
