import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, writeSync, closeSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FactoryControl } from '../src/control.mjs';
import { FactoryWorkflow } from '../src/workflows/engine.mjs';
import { FactoryArtifactStore } from '../src/workflows/artifacts.mjs';
import { captureWorkspace, materializeWorkspace, verifyWorkspaceArtifacts } from '../src/workflows/workspace.mjs';
import { callWorkflowTool } from '../src/workflows/tools.mjs';
import { submitWorkspaceCandidate } from '../src/workflows/candidate.mjs';
import { runVerification } from '../src/workflows/verifier.mjs';
import { ContinuousEvidenceCollector, createEvidenceClient, startEvidenceServer } from '../src/evidence.mjs';
import { FactoryCloudLiteFleet } from '../src/cloud-lite/fleet.mjs';
import { validateCloudLitePlan } from '../src/cloud-lite/protocol.mjs';

// The invoking release harness owns cleanup through FLUJO Bash MCP; retain failure evidence.
function fixture(){const parent=process.env.FACTORY_TEST_TMP??tmpdir();mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'factory-generic-'));const source=join(root,'source');mkdirSync(source);return{root,source};}
function workflowFixture(){
  const f=fixture(),database=join(f.root,'control.sqlite'),control=new FactoryControl(database);
  control.initializeSwarm({mission:'Research a question',budgetCents:0,maxCells:6,maxDepth:2},[
    {cellId:'writer',parentId:'root',role:'developer',budgetCents:0,purpose:'Research'},
    {cellId:'reviewer',parentId:'root',role:'verifier',budgetCents:0,purpose:'Independent review'},
  ]);
  const workflow=new FactoryWorkflow(database,{control});
  const client={task:id=>workflow.getTask(id),upload:bytes=>workflow.artifacts.put(bytes),call:(name,args)=>callWorkflowTool(workflow,'writer',name,args)};
  return{...f,control,workflow,client};
}
const reviewOnly={mode:'review-only',reason:'Source quality and synthesis require independent judgment.'};

test('generic research team integrates accepted work and enforces one independent reviewer without Git',async t=>{
  const f=workflowFixture();t.after(()=>f.control.close());
  const assign=input=>callWorkflowTool(f.workflow,'root','factory_assign',{verificationPolicy:reviewOnly,...input});
  const parent=assign({taskId:'research',assignee:'root',problem:'Answer the original question',acceptance:'Integrated evidence and uncertainties'});
  assert.equal(parent.reviewerId,'reviewer');assert.equal(parent.baseline,'initial');
  assign({taskId:'sources',parentTask:'research',assignee:'writer',problem:'Examine source evidence',acceptance:'Traceable claims and limitations'});
  writeFileSync(join(f.source,'report.txt'),'Claim with sources and uncertainty.');
  const frozen=captureWorkspace(f.workflow.artifacts,f.source);
  f.workflow.claim('research','root');
  assert.throws(()=>f.workflow.submit('research','root',{submissionId:'too-early',...frozen,summary:'Incomplete integration'}),/child work/);
  const candidate=await submitWorkspaceCandidate({client:f.client,cwd:f.source,directory:join(f.root,'captures'),taskId:'sources',submissionId:'sources-v1',paths:['report.txt'],summary:'Evidence synthesis'});
  assert.throws(()=>f.workflow.review(candidate.id,'writer',{accepted:true,rationale:'Self approval'}),/role|independent/);
  f.workflow.review(candidate.id,'reviewer',{accepted:true,rationale:'Sources and uncertainty inspected'});
  const integrated=f.workflow.submit('research','root',{submissionId:'integrated',...frozen,summary:'Integrated findings'});
  assert.equal(f.workflow.reviewPacket(integrated.id).contributions[0].candidateRef,candidate.manifestRef);
  assert.equal(f.workflow.getTask('research').status,'review');
  f.workflow.review(integrated.id,'reviewer',{accepted:true,rationale:'Original acceptance covered'});
  assert.equal(f.workflow.getTask('research').status,'accepted');
  assert.throws(()=>assign({taskId:'late',parentTask:'research',assignee:'writer',problem:'Late work',acceptance:'New content'}),/before submitting/);
  assert.ok(f.workflow.events({actor:'root'}).events.some(event=>event.type==='dependency_ready'&&event.body.child==='sources'));
});

test('generic executable checks bind the exact report and independent review',async t=>{
  const f=workflowFixture();t.after(()=>f.control.close());
  f.workflow.createTask({taskId:'report',problem:'Produce structured research',acceptance:'A supported claim and independent review',assignee:'writer',reviewerId:'reviewer',
    gates:[{id:'schema',command:'$node',args:['--input-type=module','-e',"import fs from 'node:fs'; const report=JSON.parse(fs.readFileSync('report.json')); if(!report.claim || report.sources.length<1)process.exit(1);"],adapter:'exit-code',scope:'development'}]});
  writeFileSync(join(f.source,'report.json'),JSON.stringify({claim:'Measured result',sources:['source A']}));
  const candidate=await submitWorkspaceCandidate({client:f.client,cwd:f.source,directory:join(f.root,'captures'),taskId:'report',submissionId:'report-v1',paths:['report.json'],summary:'Structured report'});
  f.workflow.review(candidate.id,'reviewer',{accepted:true,rationale:'Claim and source checked'});
  assert.equal(f.workflow.getTask('report').status,'verification');
  const run=await runVerification(f.workflow,{runId:'report-check',candidateId:candidate.id,gateId:'schema',cwd:f.source});
  assert.equal(run.result.outcome,'passed');assert.equal(f.workflow.getTask('report').status,'accepted');
  writeFileSync(join(f.source,'report.json'),'changed after submission');
  const same=await submitWorkspaceCandidate({client:f.client,cwd:f.source,directory:join(f.root,'captures'),taskId:'report',submissionId:'report-v1',paths:['report.json'],summary:'Structured report'});
  assert.equal(same.manifestRef,candidate.manifestRef,'A retry retains the original reviewed bytes');
});

test('workspace capture streams inputs larger than the old source cap and restores selected nested files',()=>{
  const f=fixture(),store=new FactoryArtifactStore(join(f.root,'objects'));
  mkdirSync(join(f.source,'data'));const large=join(f.source,'data','measurements.bin'),fd=openSync(large,'w');
  try{writeSync(fd,Buffer.from([7]),0,1,129*1024*1024);}finally{closeSync(fd);}
  const frozen=captureWorkspace(store,f.source,{paths:['data/measurements.bin']});
  assert.equal(verifyWorkspaceArtifacts(store,frozen.source.snapshot).files[0].size,129*1024*1024+1);
  const target=join(f.root,'restored');materializeWorkspace(store,frozen.source.snapshot,target);
  assert.equal(captureWorkspace(store,target).source.snapshot,frozen.source.snapshot);
  assert.throws(()=>captureWorkspace(store,f.source,{paths:['../outside']}),/relative|escaped/);
});

test('lost archive acknowledgements resume original checkpoints and upload only changed chunks',async t=>{
  const f=fixture(),token=randomBytes(32).toString('hex');
  const archive=await startEvidenceServer({directory:join(f.root,'archive'),tokens:[{token,runId:'run-one',machineId:'m0'}]});t.after(()=>archive.close());
  let loseAck=true,puts=0;
  const transport=async(url,options)=>{if(options.method==='PUT')puts++;const response=await fetch(url,options);if(url.endsWith('/checkpoints')&&options.method==='POST'&&loseAck){loseAck=false;await response.json();throw new Error('simulated lost acknowledgement');}return response;};
  const client=createEvidenceClient({url:archive.url,token,fetch:transport});
  writeFileSync(join(f.source,'session-one.jsonl'),'original transcript\n');writeFileSync(join(f.source,'report.txt'),'first report');
  const options={directory:join(f.root,'collector'),runId:'run-one',machineId:'m0',roots:[{name:'sessions',path:f.source}],client,sessions:()=>[{agentId:'m0-a0',threadId:'session-one',stopId:'stop-one'}]};
  await assert.rejects(new ContinuousEvidenceCollector(options).checkpoint(),/unconfirmed/);
  const before=puts;
  const recovered=new ContinuousEvidenceCollector({...options,roots:[{name:'sessions',path:f.source}]});
  const old=await recovered.flushPending();assert.equal(old.checkpoint.sequence,1);assert.equal(puts,before,'Already durable chunks are not resent');
  renameSync(join(f.source,'report.txt'),join(f.root,'old-report.txt'));
  writeFileSync(join(f.source,'result.txt'),'revised report');
  const final=await recovered.checkpoint({final:true});assert.equal(final.checkpoint.sequence,2);assert.ok(final.checkpoint.final);
  const root=final.checkpoint.roots[0],manifest=archive.stores.get('run-one').getJSON(root.ref);
  assert.ok(!manifest.files.some(file=>file.path==='report.txt'));assert.ok(manifest.files.some(file=>file.path==='result.txt'));
  assert.equal(puts-before,2,'Only the new content chunk and changed manifest upload');
  assert.equal((await client.latest()).digest,final.digest);
});

test('final checkpoints require transcripts and immutable sequence identity; archive runs are isolated',async t=>{
  const f=fixture(),a=randomBytes(32).toString('hex'),b=randomBytes(32).toString('hex');
  const archive=await startEvidenceServer({directory:join(f.root,'archive'),tokens:[{token:a,runId:'run-one',machineId:'m0'},{token:b,runId:'run-two',machineId:'m0'}]});t.after(()=>archive.close());
  const client=createEvidenceClient({url:archive.url,token:a}),other=createEvidenceClient({url:archive.url,token:b});
  writeFileSync(join(f.source,'report.txt'),'private research');
  const collector=new ContinuousEvidenceCollector({directory:join(f.root,'collector'),runId:'run-one',machineId:'m0',roots:[{name:'outputs',path:f.source}],client,sessions:()=>[{agentId:'m0-a0',threadId:'missing',stopId:'stop-one'}]});
  const receipt=await collector.checkpoint();
  await assert.rejects(collector.checkpoint({final:true}),/missing.*transcript/);
  await assert.rejects(client.commit({...receipt.checkpoint,capturedAt:'different'}),/failed/);
  await assert.rejects(other.download(receipt.checkpoint.roots[0].ref),/Missing archive/);
});

test('verified shutdown refuses corrupt retained evidence and confirms provider stop before retirement',async t=>{
  const f=fixture(),token=randomBytes(32).toString('hex'),runId='run-one';
  const archive=await startEvidenceServer({directory:join(f.root,'archive'),tokens:[{token,runId,machineId:'m0'}]});t.after(()=>archive.close());
  writeFileSync(join(f.source,'session-one.jsonl'),'native transcript\n');
  const client=createEvidenceClient({url:archive.url,token});
  const collector=new ContinuousEvidenceCollector({directory:join(f.root,'collector'),runId,machineId:'m0',roots:['workspaces','sessions','results','runtime','board'].map(name=>({name,path:f.source})),client,sessions:()=>[{agentId:'m0-a0',threadId:'session-one',stopId:'stop-one'}]});
  const receipt=await collector.checkpoint({final:true});
  const directory=join(f.root,'fleet');mkdirSync(directory);writeFileSync(join(directory,'evidence-credentials.json'),JSON.stringify({m0:token}));
  let stops=0,providerState='started',loseStopAck=true,confirmStopped=false;
  const machine={id:'owned-machine',state:providerState,config:{metadata:{'factory.run':runId},mounts:[{volume:'owned-volume'}]}};
  const fleet=new FactoryCloudLiteFleet({directory,execute:async(_cmd,args)=>{
    if(args[0]==='machine'&&args[1]==='list')return JSON.stringify([{...machine,state:confirmStopped?'stopped':providerState}]);
    if(args[0]==='machine'&&args[1]==='stop'){stops++;providerState='stopping';if(loseStopAck){loseStopAck=false;throw new Error('lost provider acknowledgement');}return '';}
    throw new Error('Unexpected provider operation');
  }});
  fleet.state={plan:{runId,app:'owned-app',machines:1,agentsPerMachine:1,collection:{url:archive.url}},machines:[{id:machine.id,volumeId:'owned-volume'}],operations:{}};
  fleet.request=async path=>path==='/operator/evidence-seal'?{sealed:true}:({agents:[{id:'m0-a0',nativeRuntime:{threadId:'session-one',threadStatus:'idle',turnStatus:'completed',turnId:'turn-one',operatorStopReceipt:{commandId:'stop-one',threadId:'session-one',threadStatus:'idle',turnId:'turn-one',turnStatus:'completed'}}}]});
  const store=archive.stores.get(runId),manifest=store.getJSON(receipt.checkpoint.roots[0].ref),path=store.path(manifest.files[0].chunks[0].ref),bytes=readFileSync(path);
  writeFileSync(path,'corruption');await assert.rejects(fleet.verifiedShutdown(),/Archive request failed/);assert.equal(stops,0);
  writeFileSync(path,bytes);await assert.rejects(fleet.verifiedShutdown({providerTimeoutMs:1}),error=>error.code==='SHUTDOWN_PENDING');assert.ok(fleet.state.shutdownIntent);
  // A restarted supervisor must reconcile a stopping Machine without contacting its stopped coordinator.
  const recovered=new FactoryCloudLiteFleet({directory,execute:fleet.execute});recovered.observe=async()=>{throw new Error('Stopped coordinator must not be contacted');};
  setTimeout(()=>{confirmStopped=true;},50);
  const result=await recovered.supervise({shouldStop:()=>false,intervalMs:1000});assert.equal(result.status,'stopped');assert.ok(result.shutdownVerifiedAt);assert.equal(stops,1);
  await recovered.verifiedShutdown();assert.equal(stops,1,'Repeated shutdown does not repeat provider effects');
});

test('generic cloud plans need no repository and deadline shutdown requires collection',()=>{
  const plan=validateCloudLitePlan({runId:'research-run',app:'research-app',goal:'Research an environmental question',machines:5,agentsPerMachine:5,workflow:'verified-v1'});
  assert.equal(plan.repository,undefined);
  assert.throws(()=>validateCloudLitePlan({...plan,shutdown:{deadlineUtc:'2030-01-01T00:00:00Z'}}),/collection/);
});
