#!/usr/bin/env node
/** Genuine unpaid Docker source discovery, capture and restore acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const flags={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],v=process.argv[i+1];assert.ok(['--docker','--coordinator-image','--worker-image','--evidence','--private-module'].includes(key)&&v&&!Object.hasOwn(flags,key));flags[key]=v;}
for(const k of ['--docker','--evidence','--private-module'])assert.ok(path.isAbsolute(flags[k]??''));
for(const k of ['--coordinator-image','--worker-image'])assert.ok(flags[k]&&!flags[k].startsWith('-')&&!/\s/.test(flags[k]));
assert.ok(Number(process.versions.node.split('.')[0])>=24);
const privateFiles=await import(pathToFileURL(flags['--private-module']).href),evidence=flags['--evidence'];
await privateFiles.ensurePrivateDirectory(evidence);assert.equal((await fs.readdir(evidence)).length,0);
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),sha=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>execFileSync('git',['--no-optional-locks',...args],{cwd:sourceRoot,encoding:'utf8',windowsHide:true}).trim();
const sourceHead=git('rev-parse','HEAD'),names=git('ls-files','--cached','--others','--exclude-standard').split('\n').filter(n=>!n.endsWith('.md')).sort();
const pins=()=>Promise.all(names.map(async name=>({name,sha256:sha(await fs.readFile(path.join(sourceRoot,name)))})));
const sourcePins=await pins(),operation=randomUUID(),prefix='factory-clone-'+operation.slice(0,12),label='io.flujo.factory.clone.owner';
const commands=[],containers=[],volumes=[],lifecycle=[],checks={};let accepted=false,failure=null,index=0,image,native,stats,authority,data,fixture,restore,anchor,mcp,source,child,broker;
function environment(){return Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH)$/i.test(k)));}
async function raw(name,b){await fs.writeFile(path.join(evidence,name),b,{flag:'wx',mode:0o600});return{filename:name,bytes:b.length,sha256:sha(b)};}
async function docker(args,{timeoutMs=30000,allowFailure=false,limit=8*1048576}={}){
  const r={index:++index,args,startedAt:new Date().toISOString(),pid:null,closed:false,exitCode:null,signal:null,timedOut:false,overflow:false,error:null},parts=[[],[]],sizes=[0,0];let timer;
  const c=spawn(flags['--docker'],args,{cwd:sourceRoot,env:environment(),windowsHide:true,stdio:['ignore','pipe','pipe']});r.pid=c.pid??null;
  const closed=new Promise(resolve=>{c.once('error',()=>r.error='DOCKER_SPAWN');c.once('close',(code,signal)=>{clearTimeout(timer);Object.assign(r,{closed:true,exitCode:code,signal,closedAt:new Date().toISOString()});resolve();});});
  for(const[i,s]of[c.stdout,c.stderr].entries())s.on('data',b=>{sizes[i]+=b.length;if(sizes[i]>limit){r.overflow=true;c.kill();}else parts[i].push(b);});
  timer=setTimeout(()=>{r.timedOut=true;c.kill();},timeoutMs);await closed;
  const bytes=parts.map(p=>Buffer.concat(p));r.stdout=await raw('command-'+r.index+'.stdout.private.bin',bytes[0]);r.stderr=await raw('command-'+r.index+'.stderr.private.bin',bytes[1]);commands.push(r);
  if(!allowFailure)assert.ok(r.exitCode===0&&r.signal===null&&!r.timedOut&&!r.overflow&&r.error===null,'DOCKER_COMMAND_FAILED');return{receipt:r,stdout:bytes[0].toString('utf8')};
}
function parsed(r){return JSON.parse(r.stdout);}
async function inspect(c){const a=parsed(await docker(['container','inspect',c.name]));assert.equal(a.length,1);const v=a[0];assert.equal(v.Name,'/'+c.name);assert.equal(v.Image,c.image);assert.equal(v.Config.Labels?.[label],operation);if(c.id)assert.equal(v.Id,c.id);else c.id=v.Id;return v;}
async function run(role,img,args,cmd,{detached=false,timeoutMs=60000}={}){const c={role,name:prefix+'-'+role,image:img,id:null,removed:false};containers.push(c);
  const r=await docker(['run','--pull','never','--name',c.name,'--label',label+'='+operation,'--user','1000:1000',...(detached?['--detach']:[]),...args,img,...cmd],{timeoutMs});await inspect(c);return{container:c,result:r};}
const mount=(name,target,ro=false)=>['--mount','type=volume,source='+name+',target='+target+(ro?',readonly':'')];
const hardened=['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'];
async function exec(c,script,command,timeoutMs=30000){assert.equal((await inspect(c)).State.Running,true);return parsed(await docker(['exec','--user','1000:1000',c.id,'node',script,command],{timeoutMs}));}
async function stop(c){const before=await inspect(c);if(before.State.Running)await docker(['stop','--time','15',c.id],{timeoutMs:45000});const after=await inspect(c);lifecycle.push({role:c.role,id:c.id,startedAt:before.State.StartedAt,finishedAt:after.State.FinishedAt,pid:before.State.Pid,exitCode:after.State.ExitCode,oomKilled:after.State.OOMKilled,running:after.State.Running});assert.equal(after.State.Running,false);assert.equal(after.State.OOMKilled,false);assert.ok([0,143].includes(after.State.ExitCode),'CONTAINER_STOP_EXIT');return after;}
async function ready(command,target){const deadline=Date.now()+240000;let last=null;while(Date.now()<deadline){assert.equal((await inspect(target)).State.Running,true);try{last=await exec(anchor,'/app/scripts/container-source-fixture.mjs',command);}catch{}assert.notEqual(last?.workerState,'error','WORKER_BOOTSTRAP_ERROR');if(last?.ready)return last;await delay(500);}assert.fail('WORKER_READY_DEADLINE '+JSON.stringify(last));}
async function brokerState(predicate){const deadline=Date.now()+15000;while(Date.now()<deadline){assert.equal((await inspect(broker)).State.Running,true);const r=await docker(['logs',broker.id]),rows=r.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));if(predicate(rows))return rows;await delay(100);}assert.fail('BROKER_STATE_DEADLINE');}
try{
  [image]=parsed(await docker(['image','inspect',flags['--coordinator-image']]));[native]=parsed(await docker(['image','inspect',flags['--worker-image']]));
  assert.equal(native.Config.Labels['org.opencontainers.image.revision'],'549792e1839931e862e6a305eb0d9ce2b82ae905');
  const selected=['scripts/container-source-fixture.mjs','scripts/container-source-native.mjs','src/adapters/managed-cloud.mjs','src/adapters/managed-cloud-source.mjs','deploy/managed-cloud/lib/managed.mjs','deploy/managed-cloud/lib/snapshot.mjs','deploy/managed-cloud/lib/envelope.mjs'];
  const actual=parsed((await run('image-proof',image.Id,['--network','none','--entrypoint','node'],['-e','const fs=require("node:fs"),crypto=require("node:crypto");console.log(JSON.stringify('+JSON.stringify(selected)+'.map(name=>({name,sha256:crypto.createHash("sha256").update(fs.readFileSync("/app/"+name)).digest("hex")}))))'])).result);
  assert.deepEqual(actual,sourcePins.filter(p=>selected.includes(p.name)).sort((a,b)=>selected.indexOf(a.name)-selected.indexOf(b.name)));checks.imageSourceMatches=true;
  for(const kind of ['authority','source','fixture','restore']){const v={name:prefix+'-'+kind,removed:false};volumes.push(v);assert.notEqual((await docker(['volume','inspect',v.name],{allowFailure:true})).receipt.exitCode,0);await docker(['volume','create','--label',label+'='+operation,v.name]);assert.equal(parsed(await docker(['volume','inspect',v.name]))[0].Labels[label],operation);}
  [authority,data,fixture,restore]=volumes.map(v=>v.name);
  const initialized=await run('init',image.Id,['--network','none','--entrypoint','node',...mount(authority,'/authority'),...mount(data,'/data'),...mount(fixture,'/fixture')],['/app/scripts/factory-service-fixture.mjs','init',native.Config.Labels['io.flujo.application.version'],sourceHead,operation,native.Config.Labels['org.opencontainers.image.revision']]);checks.init=parsed(initialized.result);
  checks.restoreRoot=parsed((await run('restore-init',image.Id,['--network','none','--entrypoint','node',...mount(restore,'/data')],['-e','const fs=require("node:fs"),assert=require("node:assert/strict");const s=fs.statSync("/data");assert.equal(s.uid,1000);assert.equal(s.mode&511,448);assert.equal(fs.readdirSync("/data").length,0);console.log(JSON.stringify({private:true,empty:true,uid:s.uid,mode:s.mode&511}));'])).result);
  // This long-lived anchor has one private fixture authority and no external network or published ports.
  ({container:anchor}=await run('anchor',image.Id,['--network','none','--entrypoint','node',...hardened,...mount(authority,'/authority'),...mount(fixture,'/fixture'),...mount(restore,'/restore')],['-e','process.on("SIGTERM",()=>process.exit(0));process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},1000);'],{detached:true}));
  checks.prepare=await exec(anchor,'/app/scripts/container-source-fixture.mjs','prepare');
  checks.preparedSource=parsed((await run('prepare-source',native.Id,['--network','none','--entrypoint','node',...mount(data,'/data'),...mount(fixture,'/fixture')],['/fixture/container-source-native.mjs','prepare-source'])).result);
  ({container:mcp}=await run('mcp',image.Id,['--network','container:'+anchor.id,'--entrypoint','node',...hardened,...mount(fixture,'/fixture')],['/app/scripts/container-source-fixture.mjs','serve'],{detached:true}));
  const nativeArgs=volume=>['--network','container:'+anchor.id,'--no-healthcheck','--entrypoint','node',...hardened,'--tmpfs','/home/node:rw,nosuid,nodev,size=256m,mode=0700,uid=1000,gid=1000',...mount(volume,'/data'),...mount(fixture,'/fixture',true)];
  ({container:source}=await run('source-worker',native.Id,nativeArgs(data),['/fixture/worker-launch.mjs'],{detached:true}));
  checks.sourceReady=await ready('probe',source);assert.deepEqual(checks.sourceReady.status.servers,[{name:'snapshot-fixture',status:'ready'}]);
  // Allow several due schedule ticks; both source and restored worker must suppress copied schedules.
  await delay(3000);checks.sourceInspection=await exec(source,'/fixture/container-source-native.mjs','inspect-source');
  checks.capture=await exec(anchor,'/app/scripts/container-source-fixture.mjs','capture',180000);assert.equal(checks.capture.captured,true);
  checks.archive=await exec(source,'/fixture/container-source-native.mjs','inspect-capture');
  ({container:child}=await run('restore-worker',native.Id,nativeArgs(restore),['/fixture/container-source-native.mjs','launch-restore'],{detached:true}));
  checks.restoreReady=await ready('probe-restore',child);assert.deepEqual(checks.restoreReady.status.servers,[{name:'snapshot-fixture',status:'ready'}]);
  assert.equal(checks.restoreReady.status.archiveSha256,checks.capture.archiveSha256);await delay(3000);
  checks.restored=await exec(child,'/fixture/container-source-native.mjs','inspect-restore');checks.sourceAfter=await exec(source,'/fixture/container-source-native.mjs','inspect-source');
  checks.brokerPrepared=await exec(anchor,'/app/scripts/container-source-fixture.mjs','prepare-broker');
  assert.equal(checks.brokerPrepared.growthPolicy.schemaVersion,2);assert.equal(checks.brokerPrepared.growthPolicy.growthMode,'budget-only');assert.equal(checks.brokerPrepared.growthPolicy.maxCells,null);assert.equal(checks.brokerPrepared.growthPolicy.maxDepth,null);assert.equal(checks.brokerPrepared.grantSchemaVersion,2);assert.equal(checks.brokerPrepared.growthTransition.control.status,'paused');
  ({container:broker}=await run('capacity-broker',image.Id,['--network','container:'+anchor.id,...hardened,...mount(authority,'/authority')],['capacity-broker','--private-module','/app/deploy/private-files.mjs','--profile','/authority/broker.private.json'],{detached:true}));
  checks.brokerReady=await brokerState(rows=>rows.some(r=>r.ready===true&&r.scope==='standing-grant-capacity-broker'));
  checks.peerAcknowledgement=await exec(anchor,'/app/scripts/container-source-fixture.mjs','send-broker');assert.equal(checks.peerAcknowledgement.state,'acknowledged');
  checks.firstBroker=await brokerState(rows=>rows.some(r=>r.messageId===checks.brokerPrepared.messageId&&r.dispatched===false&&r.state==='not_applied'));
  const brokerMatch=r=>r.messageId===checks.brokerPrepared.messageId&&r.dispatched===false&&r.state==='not_applied';
  assert.equal(checks.firstBroker.filter(brokerMatch).length,1);const firstKey=checks.firstBroker.find(brokerMatch).effectKey;assert.ok(firstKey);
  checks.firstBudgetAudit=await exec(anchor,'/app/scripts/container-source-fixture.mjs','broker-audit');
  const stopped=await stop(broker);assert.equal(stopped.State.ExitCode,0);await docker(['start',broker.id]);const restarted=await inspect(broker);assert.equal(restarted.State.Running,true);assert.notEqual(restarted.State.StartedAt,stopped.State.StartedAt);lifecycle.push({role:broker.role,id:broker.id,restarted:true,startedAt:restarted.State.StartedAt,pid:restarted.State.Pid});
  checks.replayedBroker=await brokerState(rows=>rows.filter(brokerMatch).length>=2&&rows.filter(r=>r.ready===true).length>checks.firstBroker.filter(r=>r.ready===true).length);
  assert.equal(checks.replayedBroker.filter(brokerMatch).length,2);assert.ok(checks.replayedBroker.filter(brokerMatch).every(r=>r.effectKey===firstKey));
  checks.secondBudgetAudit=await exec(anchor,'/app/scripts/container-source-fixture.mjs','broker-audit');assert.deepEqual(checks.secondBudgetAudit,checks.firstBudgetAudit);checks.sharedPaidBudgetRefusedBeforeManagedAttempt=true;
  stats=await exec(anchor,'/app/scripts/container-source-fixture.mjs','stats');assert.equal(stats.toolCalls,0);assert.ok(stats.requests.filter(r=>r.method==='initialize').length>=2);assert.ok(stats.requests.filter(r=>r.method==='tools/list').length>=2);
  for(const c of [source,child]){const v=await inspect(c);assert.deepEqual(v.Mounts.filter(m=>m.Type==='volume').map(m=>m.Destination).sort(),['/data','/fixture']);assert.equal(v.Mounts.find(m=>m.Destination==='/fixture').RW,false);assert.equal(v.HostConfig.ReadonlyRootfs,true);assert.ok(v.HostConfig.CapDrop.includes('ALL'));assert.ok(v.HostConfig.SecurityOpt.includes('no-new-privileges:true'));assert.deepEqual(v.HostConfig.PortBindings??{},{});}
  checks.authorityExcludedByMounts=true;checks.noNativeFlowExecuted=true;checks.noPaidProviderCalls=true;accepted=true;
}catch(error){failure={name:error?.name??null,code:error?.code??null,message:String(error?.message??'CONTAINER_SOURCE_FAILED').slice(0,4096)};process.exitCode=1;}
finally{
  for(const c of [...containers].reverse())try{let v=await inspect(c);if(v.State.Running){try{await stop(c);}catch{accepted=false;process.exitCode=1;}v=await inspect(c);if(v.State.Running){await docker(['kill','--signal','KILL',c.id]);v=await inspect(c);accepted=false;process.exitCode=1;}}assert.equal(v.State.Running,false);assert.equal(v.State.OOMKilled,false);assert.ok([0,143].includes(v.State.ExitCode));await docker(['logs',c.id],{allowFailure:true});await docker(['rm',c.id]);c.removed=true;}catch{accepted=false;process.exitCode=1;}
  for(const v of [...volumes].reverse())try{assert.equal(parsed(await docker(['volume','inspect',v.name]))[0].Labels[label],operation);await docker(['volume','rm',v.name]);v.removed=true;}catch{accepted=false;process.exitCode=1;}
  const sourceUnchanged=JSON.stringify(await pins())===JSON.stringify(sourcePins);if(!sourceUnchanged){accepted=false;process.exitCode=1;}
  const report={format:'factory-container-source-docker-acceptance',schemaVersion:1,operation,accepted,failure,sourceHead,sourcePins,sourceUnchanged,images:{factory:image?.Id??null,native:native?.Id??null},checks,stats:stats??null,commands,containers,volumes,lifecycle,allOwnedContainersRemoved:containers.every(c=>c.removed),allOwnedVolumesRemoved:volumes.every(v=>v.removed),paidProviderCalls:0,
    scope:'Actual local Docker ManagedCloud container-source discovery, original authenticated snapshot begin/status/download/finalize, encryption and restore into a second clean native worker. Selected model/MCP configuration and copied-schedule suppression. No Fly/Modal provisioning, Flow inference, cross-host authority, or software acceptance.',completedAt:new Date().toISOString()};
  const filename=path.join(evidence,'execution.private.json');await privateFiles.writePrivateJson(filename,report,{exclusive:true});assert.deepEqual(await privateFiles.readPrivateJson(filename,{maxBytes:16*1048576}),report);process.stdout.write(JSON.stringify({accepted,failure,operation,sourceUnchanged,allOwnedContainersRemoved:report.allOwnedContainersRemoved,allOwnedVolumesRemoved:report.allOwnedVolumesRemoved,paidProviderCalls:0,evidenceSha256:sha(await fs.readFile(filename))})+'\n');
}
