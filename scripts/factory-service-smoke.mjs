#!/usr/bin/env node
/** Real local Docker packaging acceptance, with isolated synthetic authority and model. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../src/control.mjs';

const flags={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];assert.ok(['--docker','--coordinator-image','--worker-image','--evidence','--private-module'].includes(key)&&value&&!Object.hasOwn(flags,key));flags[key]=value;}
for(const key of ['--docker','--evidence','--private-module'])assert.ok(path.isAbsolute(flags[key]??''));
for(const key of ['--coordinator-image','--worker-image'])assert.ok(typeof flags[key]==='string'&&!flags[key].startsWith('-')&&!/\s/.test(flags[key]));
assert.ok(Number(process.versions.node.split('.')[0])>=24);
const privateFiles=await import(pathToFileURL(flags['--private-module']).href),root=flags['--evidence'];
await privateFiles.ensurePrivateDirectory(root);assert.equal((await fs.readdir(root)).length,0);
const operation=randomUUID(),prefix='factory-service-'+operation.slice(0,12),ownerLabel='io.flujo.factory.smoke.owner';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceHead=execFileSync('git',['--no-optional-locks','rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8',windowsHide:true}).trim();
assert.match(sourceHead,/^[a-f0-9]{40}$/);
const SHA=bytes=>createHash('sha256').update(bytes).digest('hex');
const containers=[],volumes=[],commands=[],lifecycle=[],checks={};let commandIndex=0,errorCode=null,failure=null,accepted=false;
let coordinatorImage,workerImage,initReceipt,metadata,firstAudit,recoveredAudit,finalAudit,stats;
const paths=['package.json','package-lock.json','deploy/private-files.mjs','scripts/factory-service-fixture.mjs','scripts/factory-service-smoke.mjs','bin/native-cell.mjs','src/native-cell.mjs','src/native-mission.mjs','src/native-mission-contract.mjs','src/native-mission-client.mjs','src/control.mjs','src/spending.mjs'];
const sourcePins=await Promise.all(paths.map(async filename=>({path:filename,sha256:SHA(await fs.readFile(path.join(sourceRoot,filename)))})));
function environment(){const result={};for(const [k,v] of Object.entries(process.env))if(/^(path|systemroot|windir|comspec|pathext|home|userprofile|localappdata|appdata|docker_host|docker_context|docker_config|docker_tls_verify|docker_cert_path)$/i.test(k))result[k]=v;return result;}
async function raw(filename,bytes){await privateFiles.assertPrivateDirectory(root);await fs.writeFile(path.join(root,filename),bytes,{flag:'wx',mode:0o600});return {filename,bytes:bytes.length,sha256:SHA(bytes)};}
async function docker(args,{timeoutMs=30000,allowFailure=false,limit=8*1048576}={}){
  const receipt={index:++commandIndex,args,startedAt:new Date().toISOString(),pid:null,closed:false,exitCode:null,signal:null,timedOut:false,overflow:false,error:null};
  const chunks=[[],[]];let sizes=[0,0],timer;const child=spawn(flags['--docker'],args,{cwd:sourceRoot,env:environment(),windowsHide:true,stdio:['ignore','pipe','pipe']});receipt.pid=child.pid??null;
  const closed=new Promise(resolve=>{child.once('error',()=>{receipt.error='DOCKER_SPAWN';});child.once('close',(code,signal)=>{clearTimeout(timer);Object.assign(receipt,{closed:true,exitCode:code,signal,closedAt:new Date().toISOString()});resolve();});});
  for(const [index,stream] of [child.stdout,child.stderr].entries())stream.on('data',bytes=>{sizes[index]+=bytes.length;if(sizes[index]>limit){receipt.overflow=true;child.kill();}else chunks[index].push(bytes);});
  timer=setTimeout(()=>{receipt.timedOut=true;child.kill();},timeoutMs);await closed;
  const stdout=Buffer.concat(chunks[0]),stderr=Buffer.concat(chunks[1]);
  receipt.stdout=await raw('command-'+receipt.index+'.stdout.private.bin',stdout);receipt.stderr=await raw('command-'+receipt.index+'.stderr.private.bin',stderr);commands.push(receipt);
  if(!allowFailure)assert.ok(receipt.closed&&receipt.exitCode===0&&receipt.signal===null&&!receipt.timedOut&&!receipt.overflow&&receipt.error===null,'DOCKER_COMMAND_FAILED');
  return {receipt,stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8')};
}
function parsed(result){assert.ok(result.stdout.trim());return JSON.parse(result.stdout);}
async function inspect(container){const value=parsed(await docker(['container','inspect',container.name]));assert.equal(value.length,1);const c=value[0];assert.equal(c.Config.Labels?.[ownerLabel],operation);assert.equal(c.Name,'/'+container.name);assert.equal(c.Image,container.image);if(container.id)assert.equal(c.Id,container.id);else container.id=c.Id;return c;}
async function container(role,image,args,{detached=true}={}){
  const value={role,name:prefix+'-'+role,image,id:null,removed:false};containers.push(value);
  const result=await docker(['run','--pull','never','--name',value.name,'--label',ownerLabel+'='+operation,'--user','1000:1000',...(detached?['--detach']:[]),...args,image,...(role.startsWith('audit')||role==='init'||role==='metadata'?['/app/scripts/factory-service-fixture.mjs',role.startsWith('audit')?'audit':role]:role==='fixture'?['/app/scripts/factory-service-fixture.mjs','serve']:[])],{timeoutMs:detached?30000:60000});
  await inspect(value);return {container:value,result};
}
function terminalState(container,value){assert.equal(value.State.Running,false);assert.equal(value.State.OOMKilled,false);
  assert.ok((container.role==='worker'?[0,143]:[0]).includes(value.State.ExitCode),'CONTAINER_STOP_EXIT');}
async function stop(container){const before=await inspect(container);if(before.State.Running)await docker(['stop','--time','15',container.id],{timeoutMs:45000});const after=await inspect(container);lifecycle.push({role:container.role,id:container.id,startedAt:before.State.StartedAt,finishedAt:after.State.FinishedAt,pid:before.State.Pid,exitCode:after.State.ExitCode,oomKilled:after.State.OOMKilled,running:after.State.Running});terminalState(container,after);assert.ok(after.State.FinishedAt&&!after.State.FinishedAt.startsWith('0001-'));return after;}
async function restart(container){const before=await inspect(container);assert.equal(before.State.Running,false);await docker(['start',container.id]);const after=await inspect(container);assert.equal(after.State.Running,true);assert.notEqual(after.State.StartedAt,before.State.StartedAt);lifecycle.push({role:container.role,id:container.id,restarted:true,startedAt:after.State.StartedAt,pid:after.State.Pid});}
function hardened(value,{home=false}={}){assert.equal(value.HostConfig.ReadonlyRootfs,true);assert.ok(value.HostConfig.CapDrop.includes('ALL'));
  assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges:true'));assert.ok(value.HostConfig.Tmpfs['/tmp']);if(home)assert.ok(value.HostConfig.Tmpfs['/home/node']);
  return {readOnly:true,capDrop:value.HostConfig.CapDrop,securityOpt:value.HostConfig.SecurityOpt,tmpfs:value.HostConfig.Tmpfs};}
const mount=(name,target,readOnly=false)=>['--mount','type=volume,source='+name+',target='+target+(readOnly?',readonly':'')];
async function fixtureCommand(c,command){await inspect(c);return parsed(await docker(['exec','--user','1000:1000',c.id,'node','/app/scripts/factory-service-fixture.mjs',command],{timeoutMs:30000}));}
async function waitFor(c,predicate,timeoutMs=180000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const state=await inspect(c);assert.equal(state.State.Running,true,'CONTAINER_EARLY_EXIT');const logs=await docker(['logs',c.id],{limit:4*1048576});const statuses=[];for(const line of logs.stdout.trim().split('\n').filter(Boolean)){try{statuses.push(JSON.parse(line));}catch{assert.fail('COORDINATOR_PROTOCOL');}}const selected=statuses.find(predicate);if(selected)return selected;await delay(250);}assert.fail('COORDINATOR_STATE_DEADLINE');}
// All fixture writers are closed. SQLite read-only WAL readers may create private sidecars;
// only this owned authority mount permits that, while queries and both main DB bytes stay read-only.
async function stateAudit(role){const args=['--entrypoint','node',...mount(authority,'/authority'),...mount(data,'/data',true),...mount(fixture,'/fixture',true)];return parsed((await container(role,coordinatorImage.Id,args,{detached:false})).result);}
let authority,data,fixture,coordinator,worker,sidecar;
try{
  const coord=parsed(await docker(['image','inspect',flags['--coordinator-image']])),native=parsed(await docker(['image','inspect',flags['--worker-image']]));
  assert.equal(coord.length,1);assert.equal(native.length,1);coordinatorImage=coord[0];workerImage=native[0];
  assert.match(coordinatorImage.Id,/^sha256:[a-f0-9]{64}$/);assert.match(workerImage.Id,/^sha256:[a-f0-9]{64}$/);
  assert.equal(workerImage.Config.Labels?.['org.opencontainers.image.revision'],'549792e1839931e862e6a305eb0d9ce2b82ae905');
  const workerRevision=workerImage.Config.Labels['org.opencontainers.image.revision'];
  const version=workerImage.Config.Labels?.['io.flujo.application.version'];assert.match(version??'',/^\d+\.\d+\.\d+$/);
  ({result:metadata}=await container('metadata',coordinatorImage.Id,['--entrypoint','node','--network','none'],{detached:false}));metadata=parsed(metadata);
  assert.ok(metadata.node.startsWith('v24.'));assert.equal(metadata.uid,1000);assert.equal(metadata.gid,1000);assert.deepEqual(metadata.files,sourcePins);checks.imageSourceMatches=true;
  for(const kind of ['authority','native','fixture'])volumes.push({name:prefix+'-'+kind,removed:false});
  // Exclusive names: inspect refusal is expected before publication; never adopt an existing volume.
  for(const volume of volumes){const existing=await docker(['volume','inspect',volume.name],{allowFailure:true});assert.notEqual(existing.receipt.exitCode,0);await docker(['volume','create','--label',ownerLabel+'='+operation,volume.name]);const actual=parsed(await docker(['volume','inspect',volume.name]));assert.equal(actual[0].Labels?.[ownerLabel],operation);}
  [authority,data,fixture]=volumes.map(v=>v.name);
  const init={role:'init',name:prefix+'-init',image:coordinatorImage.Id,id:null,removed:false};containers.push(init);
  const initialized=await docker(['run','--pull','never','--name',init.name,'--label',ownerLabel+'='+operation,'--user','1000:1000','--network','none','--entrypoint','node',...mount(authority,'/authority'),...mount(data,'/data'),...mount(fixture,'/fixture'),coordinatorImage.Id,'/app/scripts/factory-service-fixture.mjs','init',version,sourceHead,operation,workerRevision],{timeoutMs:60000});
  initReceipt=parsed(initialized);await inspect(init);assert.equal(initReceipt.initialized,true);assert.equal(initReceipt.operation,operation);
  ({container:coordinator}=await container('coordinator',coordinatorImage.Id,[...mount(authority,'/authority'),'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777']));
  const coordinatorConfig=await inspect(coordinator);checks.coordinatorHardening=hardened(coordinatorConfig);assert.deepEqual(coordinatorConfig.Mounts.filter(m=>m.Type==='volume').map(m=>m.Destination).sort(),['/authority']);
  ({container:sidecar}=await container('fixture',coordinatorImage.Id,['--entrypoint','node',...mount(fixture,'/fixture'),'--network','container:'+coordinator.id]));
  const nodeProbe={role:'worker-metadata',name:prefix+'-worker-metadata',image:workerImage.Id,id:null,removed:false};containers.push(nodeProbe);
  const workerNode=parsed(await docker(['run','--pull','never','--name',nodeProbe.name,'--label',ownerLabel+'='+operation,'--network','none','--entrypoint','node',workerImage.Id,'-e','console.log(JSON.stringify({node:process.version,uid:process.getuid(),gid:process.getgid()}))']));await inspect(nodeProbe);
  assert.ok(workerNode.node.startsWith('v22.'));assert.equal(workerNode.uid,1000);checks.workerRuntime=workerNode;
  const w={role:'worker',name:prefix+'-worker',image:workerImage.Id,id:null,removed:false};containers.push(w);
  await docker(['run','--pull','never','--name',w.name,'--label',ownerLabel+'='+operation,'--user','1000:1000','--detach','--no-healthcheck','--network','container:'+coordinator.id,
    '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777','--tmpfs','/home/node:rw,nosuid,nodev,size=256m,mode=0700,uid=1000,gid=1000',
    '--entrypoint','node',...mount(data,'/data'),...mount(fixture,'/fixture',true),workerImage.Id,'/fixture/worker-launch.mjs']);worker=w;const workerConfig=await inspect(worker);
  checks.workerHardening=hardened(workerConfig,{home:true});assert.deepEqual(workerConfig.Mounts.filter(m=>m.Type==='volume').map(m=>m.Destination).sort(),['/data','/fixture']);
  assert.equal(workerConfig.Mounts.find(m=>m.Destination==='/fixture').RW,false);assert.equal(workerConfig.HostConfig.NetworkMode,'container:'+coordinator.id);
  const readyDeadline=Date.now()+240000;let ready=null;while(Date.now()<readyDeadline){assert.equal((await inspect(worker)).State.Running,true);try{const r=await fixtureCommand(sidecar,'probe');if(r.ready){ready=r;break;}}catch{}await delay(500);}assert.ok(ready?.ready,'NATIVE_READY_DEADLINE');assert.equal(ready.flowSha256,initReceipt.flowSha256);checks.nativeReady=ready;
  checks.initialIdle=await waitFor(coordinator,s=>s.state==='idle');checks.injection=await fixtureCommand(coordinator,'inject');
  checks.first=await waitFor(coordinator,s=>s.state==='dispatched'&&s.effectState==='unknown');
  // Freeze original state before the daemon could observe the completed conversation on its next tick.
  await stop(coordinator);await stop(worker);stats=await fixtureCommand(sidecar,'stats');assert.equal(stats.posts,1);assert.equal(stats.modelCalls,1);assert.equal(stats.dropped.status,200);assert.deepEqual(stats.failures,[]);await stop(sidecar);
  firstAudit=await stateAudit('audit-first');const original=firstAudit.original,firstEffect=firstAudit.effects.find(e=>e.key===checks.first.key);assert.equal(firstEffect.state,'unknown');assert.equal(firstEffect.request_digest,digest(original));
  assert.equal(firstAudit.tasks.find(t=>t.id==='fresh-mission').status,'running');assert.equal(firstAudit.output,null);assert.equal(firstAudit.conversation.body.status,'completed');
  // Pause the authoritative fixture before recovery. No worker/model state is reconstructed.
  const paused={role:'pause',name:prefix+'-pause',image:coordinatorImage.Id,id:null,removed:false};containers.push(paused);
  await docker(['run','--pull','never','--name',paused.name,'--label',ownerLabel+'='+operation,'--user','1000:1000','--network','none','--entrypoint','node',...mount(authority,'/authority'),coordinatorImage.Id,'/app/scripts/factory-service-fixture.mjs','pause']);await inspect(paused);
  await restart(coordinator);await restart(sidecar);await restart(worker);const secondReadyDeadline=Date.now()+180000;let secondReady=false;while(Date.now()<secondReadyDeadline){try{if((await fixtureCommand(sidecar,'probe')).ready){secondReady=true;break;}}catch{}await delay(500);}assert.ok(secondReady);
  checks.observationRelease=await fixtureCommand(sidecar,'release');checks.recovered=await waitFor(coordinator,s=>s.state==='recovered');assert.equal(checks.recovered.observations.length,1);assert.equal(checks.recovered.observations[0].key,checks.first.key);
  checks.hold=await fixtureCommand(coordinator,'hold');checks.budget=await waitFor(coordinator,s=>s.state==='budget');assert.equal(checks.budget.taskId,'budget-refusal');
  await stop(coordinator);await stop(worker);stats=await fixtureCommand(sidecar,'stats');assert.equal(stats.posts,1);assert.equal(stats.modelCalls,1);assert.deepEqual(stats.failures,[]);
  finalAudit=await stateAudit('audit-final');recoveredAudit=finalAudit;assert.equal(finalAudit.conversation.sha256,firstAudit.conversation.sha256);assert.deepEqual(finalAudit.original,original);
  const finalEffect=finalAudit.effects.find(e=>e.key===checks.first.key);assert.equal(finalEffect.state,'succeeded');assert.equal(finalEffect.request_digest,firstEffect.request_digest);
  assert.equal(finalAudit.output.key,checks.first.key);assert.equal(finalAudit.output.requestDigest,digest(original));assert.equal(finalAudit.output.body.id,original.conversationId);
  assert.ok(finalAudit.output.body.messages.some(m=>m.role==='assistant'&&m.content==='packaged-native-mission-complete'));
  const task=finalAudit.tasks.find(t=>t.id==='fresh-mission');assert.equal(task.status,'running');assert.equal(task.candidate,null);assert.equal(task.review,null);
  const budget=finalAudit.tasks.find(t=>t.id==='budget-refusal');assert.equal(budget.status,'ready');assert.equal(budget.owner,null);assert.equal(finalAudit.effects.filter(e=>e.scope_id==='budget-refusal').length,0);
  assert.equal(finalAudit.effects.filter(e=>e.kind==='flow_call').length,1);assert.equal(finalAudit.events.filter(e=>e.type==='native_mission_admitted').length,1);
  const sequence=finalAudit.events.filter(e=>e.subject===checks.first.key&&e.type==='effect_settled').map(e=>e.details.state);
  assert.ok(sequence.length>=2&&sequence.at(-1)==='succeeded'&&sequence.slice(0,-1).every(state=>state==='unknown'));checks.settlementSequence=sequence;
  assert.equal(finalAudit.paid.reservations.length,2);assert.equal(finalAudit.paid.reservations.reduce((sum,r)=>sum+r.ceiling_cents,0),10000);assert.equal(finalAudit.paid.reservations.every(r=>r.charged_cents===null&&r.final_cents===null),true);
  assert.equal(firstAudit.paid.reservations.length,1);const originalPaid=firstAudit.paid.reservations[0];assert.equal(originalPaid.state,'started');assert.equal(originalPaid.ceiling_cents,500);
  assert.deepEqual(finalAudit.paid.reservations.find(r=>r.id===originalPaid.id),originalPaid);assert.deepEqual(finalAudit.paid.events.slice(0,firstAudit.paid.events.length),firstAudit.paid.events);
  assert.equal(finalAudit.paid.events.length,firstAudit.paid.events.length+1);assert.equal(finalAudit.paid.events.at(-1).type,'reserved');assert.equal(finalAudit.paid.events.at(-1).reservation_id,'hold-remaining');checks.originalPaidPreserved=true;
  for(const record of finalAudit.modes){assert.equal(record.uid,1000);assert.equal(record.gid,1000);assert.equal(record.mode&0o077,0);}
  checks.originalRecovered=true;checks.budgetRefusedWithoutEffects=true;checks.noSoftwareAcceptance=true;accepted=true;
}catch(error){failure={name:error?.name??null,code:error?.code??null,message:String(error?.message??'FACTORY_SERVICE_SMOKE_FAILED').slice(0,4096)};errorCode='FACTORY_SERVICE_SMOKE_FAILED';process.exitCode=1;}
finally{
  for(const c of [...containers].reverse())try{let inspected=await inspect(c);if(inspected.State.Running){try{await stop(c);}catch{errorCode='FACTORY_SERVICE_CLEANUP_FAILED';accepted=false;process.exitCode=1;}inspected=await inspect(c);
      if(inspected.State.Running){await docker(['kill','--signal','KILL',c.id]);inspected=await inspect(c);lifecycle.push({role:c.role,id:c.id,forcedCleanup:true,finishedAt:inspected.State.FinishedAt,exitCode:inspected.State.ExitCode,oomKilled:inspected.State.OOMKilled,running:inspected.State.Running});}}
    else lifecycle.push({role:c.role,id:c.id,finishedAt:inspected.State.FinishedAt,exitCode:inspected.State.ExitCode,oomKilled:inspected.State.OOMKilled,running:false});
    try{terminalState(c,inspected);}catch{errorCode='FACTORY_SERVICE_CLEANUP_FAILED';accepted=false;process.exitCode=1;}assert.equal(inspected.State.Running,false);
    await docker(['logs',c.id],{allowFailure:true});await docker(['rm',c.id]);c.removed=true;}catch{errorCode='FACTORY_SERVICE_CLEANUP_FAILED';accepted=false;process.exitCode=1;}
  for(const v of [...volumes].reverse())try{const actual=parsed(await docker(['volume','inspect',v.name]));assert.equal(actual[0].Labels?.[ownerLabel],operation);await docker(['volume','rm',v.name]);v.removed=true;}catch{errorCode='FACTORY_SERVICE_CLEANUP_FAILED';accepted=false;process.exitCode=1;}
  const afterPins=await Promise.all(sourcePins.map(async p=>({path:p.path,sha256:SHA(await fs.readFile(path.join(sourceRoot,p.path)))})));const sourceUnchanged=JSON.stringify(afterPins)===JSON.stringify(sourcePins);if(!sourceUnchanged){accepted=false;errorCode='FACTORY_SERVICE_SOURCE_CHANGED';process.exitCode=1;}
  const report={format:'factory-service-docker-acceptance',schemaVersion:1,operation,accepted,errorCode,failure,sourceHead,sourcePins,sourceUnchanged,
    images:coordinatorImage&&workerImage?{coordinator:{id:coordinatorImage.Id,labels:coordinatorImage.Config.Labels??{},repoDigests:coordinatorImage.RepoDigests??[]},worker:{id:workerImage.Id,labels:workerImage.Config.Labels??{},repoDigests:workerImage.RepoDigests??[]}}:null,
    metadata:metadata??null,init:initReceipt??null,checks,firstAudit:firstAudit??null,recoveredAudit:recoveredAudit??null,finalAudit:finalAudit??null,stats:stats??null,
    containers,volumes,lifecycle,commands,allOwnedContainersRemoved:containers.every(c=>c.removed),allOwnedVolumesRemoved:volumes.every(v=>v.removed),paidProviderCalls:0,
    shutdownScope:'Confirmed actual container stop/removal; accepted stops require exit0 (native worker may exit143), OOM false, and reject force-kill exit137. Application work cancellation is not implied.',
    workerToolsScope:'No MCP or browser tools selected; the private HOME tmpfs masks image-baked HOME assets.',
    scope:'Actual local packaged coordinator and clean pinned FLUJO Docker worker with persistent isolated fixture state and a synthetic model. No Fly/Modal provisioning, production ledger mutation, cross-host authority, or software acceptance.',completedAt:new Date().toISOString()};
  const filename=path.join(root,'execution.private.json');await privateFiles.writePrivateJson(filename,report,{exclusive:true});assert.deepEqual(await privateFiles.readPrivateJson(filename,{maxBytes:16*1048576}),report);
  process.stdout.write(JSON.stringify({accepted,errorCode,operation,modelCalls:stats?.modelCalls??null,posts:stats?.posts??null,paidProviderCalls:0,sourceUnchanged,evidenceSha256:SHA(await fs.readFile(filename))})+'\n');
}
