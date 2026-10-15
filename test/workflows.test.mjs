import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Factory, FactoryWorkflow, FactoryWorkflowSupervisor, runVerification, createWorkflowClient, createWorkflowComparison, summarizeWorkflowComparison, captureGitSource } from '../src/public-sdk.mjs';
import { startCloudLiteCoordinator } from '../src/cloud-lite/server.mjs';

// Keep generated evidence for the invoking harness; cleanup is performed through FLUJO Bash MCP.
function fixture() {
  const parent = process.env.FACTORY_TEST_TMP ?? tmpdir(); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'factory-workflow-')), cwd = join(root,'source'); mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding:'utf8', windowsHide: true }).trim();
  git('init'); git('config','user.email','workflow-test@example.invalid'); git('config','user.name','Workflow test');
  writeFileSync(join(cwd,'check.mjs'), "console.log('TAP version 13\\nok 1 - actual behavior\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0');\n");
  git('add','.'); git('commit','-m','Frozen verifier fixture');
  const source = { repository:'example/repository', baseline:git('rev-parse','HEAD'), commit:git('rev-parse','HEAD'), tree:git('rev-parse','HEAD^{tree}') };
  const database = join(root,'control.sqlite'); new Factory(database).createSwarm({ mission:'Verify original behavior', agents:[{id:'builder'},{id:'reviewer',role:'verifier'}] });
  const workflow = new FactoryWorkflow(database);
  const artifact = captureGitSource(workflow.artifacts,cwd,{repository:source.repository,baseline:source.baseline}).artifact;
  const task = { taskId:'repair', projectId:'repo', branch:'codex/repair', problem:'Preserve behavior', acceptance:'Independent review and actual check', baseline:source.baseline,
    assignee:'builder', reviewerId:'reviewer', gates:[{id:'tests',command:'$node',args:['check.mjs'],adapter:'node-tap',scope:'development'}] };
  const submission = { submissionId:'candidate-one', source, artifacts:[artifact], summary:'Frozen source' };
  return { root,cwd,database,workflow,task,submission };
}

test('portable source rejects export omissions and substitutions and preserves long nested paths', t => {
  const f=fixture(); t.after(()=>f.workflow.close());
  const git=(...args)=>execFileSync('git',args,{cwd:f.cwd,encoding:'utf8',windowsHide:true}).trim();
  const capture=()=>captureGitSource(f.workflow.artifacts,f.cwd,{repository:'example/repository',baseline:f.submission.source.baseline});
  writeFileSync(join(f.cwd,'.gitattributes'),'check.mjs export-ignore\n');
  git('add','.');git('commit','-m','Omitted tracked input');
  assert.throws(capture,/omits tracked Git blobs/);
  writeFileSync(join(f.cwd,'.gitattributes'),'check.mjs export-subst\n');
  writeFileSync(join(f.cwd,'check.mjs'),'// $Format:%H$\n');
  git('add','.');git('commit','-m','Rewritten tracked input');
  assert.throws(capture,/differs from tracked Git blobs/);
  writeFileSync(join(f.cwd,'.gitattributes'),'');
  // Multi-component long names force Git's PAX metadata without exceeding a
  // filesystem component's size limit.
  const nested=join(f.cwd,'a'.repeat(60),'b'.repeat(60));mkdirSync(nested,{recursive:true});
  writeFileSync(join(nested,'source.txt'),'complete source\n');
  git('-c','core.longpaths=true','add','.');git('-c','core.longpaths=true','commit','-m','Complete portable source');
  assert.ok(capture().bundle);
});

test('interrupted artifact writes cannot publish or poison a content reference', () => {
  const directory=mkdtempSync(join(process.env.FACTORY_TEST_TMP??tmpdir(),'factory-artifact-fault-'));
  const module=new URL('../src/workflows/artifacts.mjs',import.meta.url).href;
  execFileSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    import {syncBuiltinESMExports} from 'node:module';
    const {FactoryArtifactStore,sha256}=await import(${JSON.stringify(module)});
    const store=new FactoryArtifactStore(${JSON.stringify(directory)}), bytes=Buffer.from('complete immutable artifact');
    const original=fs.writeFileSync;
    fs.writeFileSync=(fd,data)=>{original(fd,data.subarray(0,4));throw new Error('injected interrupted write');};
    syncBuiltinESMExports();
    assert.throws(()=>store.put(bytes),/injected/);
    assert.equal(fs.existsSync(store.path('sha256:'+sha256(bytes))),false);
    fs.writeFileSync=original;syncBuiltinESMExports();
    const saved=store.put(bytes);assert.deepEqual(store.get(saved.ref),bytes);
    assert.equal(fs.readdirSync(store.directory).filter(name=>name.startsWith('.pending-')).length,0);
  `],{windowsHide:true,stdio:'pipe'});
});

test('public workflow executes a frozen candidate, separates review, resumes and accepts only matching evidence', async t => {
  const f = fixture(); t.after(() => f.workflow.close());
  f.workflow.createTask(f.task); f.workflow.claim('repair','builder'); f.workflow.submit('repair','builder',f.submission);
  assert.equal(f.workflow.getTask('repair').status,'review');
  assert.throws(() => f.workflow.review('candidate-one','builder',{accepted:true,findings:[],rationale:'self approval'}), /role|reviewer/);
  assert.throws(() => f.workflow.control.reviewTask('repair','reviewer',{accepted:true,evidencePath:f.workflow.artifacts.path(f.submission.artifacts[0].ref)}), /workflow review/);
  const run = await runVerification(f.workflow,{runId:'check-one',candidateId:'candidate-one',gateId:'tests',cwd:f.cwd});
  assert.equal(run.result.outcome,'passed'); assert.equal(f.workflow.getTask('repair').status,'review');
  f.workflow.review('candidate-one','reviewer',{accepted:true,findings:[],rationale:'Original requirements covered.'});
  assert.equal(f.workflow.getTask('repair').status,'accepted');
  f.workflow.close(); f.workflow = new FactoryWorkflow(f.database);
  assert.equal(f.workflow.getTask('repair').status,'accepted');
  const knowledge = f.workflow.curateKnowledge({id:'recipe',title:'Verified recipe',content:'Use the accepted artifact',applicability:'This repository revision',candidateId:'candidate-one',sources:[{ref:f.submission.artifacts[0].ref,location:'source'}]},'reviewer');
  assert.equal(knowledge.version,1); assert.equal(f.workflow.searchKnowledge('recipe')[0].candidateId,'candidate-one');
});

test('revision rejects stale reviews and preserves original requirements and findings', t => {
  const f = fixture(); t.after(() => f.workflow.close()); f.workflow.createTask({...f.task,gates:[],verificationPolicy:{mode:'review-only',reason:'This test isolates the semantic revision loop.'}});
  f.workflow.claim('repair','builder'); f.workflow.submit('repair','builder',f.submission);
  f.workflow.review('candidate-one','reviewer',{accepted:false,findings:[{id:'edge',description:'Handle edge case',requirement:'Preserve behavior'}],rationale:'Missing edge case'});
  assert.equal(f.workflow.getTask('repair').status,'revision_required');
  f.workflow.revise('repair','builder'); f.workflow.claim('repair','builder');
  const second = f.workflow.submit('repair','builder',{...f.submission,submissionId:'candidate-two',resolvedFindings:['edge']});
  assert.equal(second.supersedes,'candidate-one');
  assert.throws(() => f.workflow.review('candidate-one','reviewer',{accepted:true,findings:[],rationale:'Late approval'}), /superseded/);
  assert.equal(f.workflow.reviewPacket('candidate-two').problem,f.task.problem);
  f.workflow.review('candidate-two','reviewer',{accepted:true,findings:[],rationale:'Edge case resolved'});
  assert.equal(f.workflow.getTask('repair').status,'accepted');
});

test('real HTTP cloud tools bind actors and refuse worker-forged validation', async t => {
  const f = fixture(); t.after(() => f.workflow.close());
  const plan = {runId:'workflow-test',app:'workflow-test',repository:'example/repository',goal:'Check workflow',machines:1,agentsPerMachine:4,workflow:'verified-v1'};
  const credentials = Object.fromEntries([0,1,2,3].map(i=>[`m0-a${i}`,`private-agent-token-${i}`]));
  const coordinator = await startCloudLiteCoordinator({database:join(f.root,'cloud.sqlite'),plan,credentials,operatorToken:'private-operator-token',auth:{accessToken:'test',chatgptAccountId:'test'},githubToken:'test',host:'127.0.0.1',port:0});
  t.after(()=>coordinator.close());
  const url = `http://127.0.0.1:${coordinator.server.address().port}`;
  const operator = createWorkflowClient({url,token:'private-operator-token',operator:true}), worker = createWorkflowClient({url,token:credentials['m0-a1']});
  await operator.createTask({...f.task,assignee:'m0-a1',reviewerId:'m0-a3'});
  await assert.rejects(worker.createTask({...f.task,taskId:'forged',assignee:'m0-a1',reviewerId:'m0-a3'}),/role/);
  const bytes = Buffer.alloc(300000, 71), uploaded = await worker.upload(bytes);
  assert.deepEqual(await operator.download(uploaded.ref),bytes);
  await worker.call('factory_workflow',{action:'claim',taskId:'repair'});
  await worker.call('factory_workflow',{action:'submit',taskId:'repair',input:{...f.submission,artifacts:[{...uploaded,name:'candidate',kind:'source'}]}});
  const forged = await fetch(url+'/operator/workflow/verification',{method:'POST',headers:{Authorization:`Bearer ${credentials['m0-a1']}`,'Content-Type':'application/json'},body:JSON.stringify({candidateId:'candidate-one',gateId:'tests',result:{outcome:'passed'}})});
  assert.equal(forged.status,404); assert.equal((await operator.task('repair')).status,'review');
  const events = await worker.events({after:0,limit:1}); assert.ok(events.sequence>0); assert.match(events.cursor,/^wf1:/);
  await operator.pauseTask('repair'); assert.equal((await operator.task('repair')).status,'paused');
  await operator.pauseTask('repair',false); assert.equal((await operator.task('repair')).status,'review');
});

test('supervisor retrieves source and runs a real gate for a remote candidate without model calls', async t => {
  const f=fixture(); t.after(()=>f.workflow.close());
  const plan={runId:'service-test',app:'service-test',repository:'example/repository',goal:'Verify remotely',machines:1,agentsPerMachine:3,workflow:'verified-v1'};
  const credentials={'m0-a0':'lead-token','m0-a1':'builder-token','m0-a2':'reviewer-token'};
  const coordinator=await startCloudLiteCoordinator({database:join(f.root,'service-board.sqlite'),plan,credentials,operatorToken:'operator-token',auth:{accessToken:'test',chatgptAccountId:'test'},githubToken:'test',host:'127.0.0.1',port:0}); t.after(()=>coordinator.close());
  const url=`http://127.0.0.1:${coordinator.server.address().port}`;
  const operator=createWorkflowClient({url,token:'operator-token',operator:true}),worker=createWorkflowClient({url,token:'builder-token'}),reviewer=createWorkflowClient({url,token:'reviewer-token'});
  await operator.createTask({...f.task,assignee:'m0-a1',reviewerId:'m0-a2'});
  for(const artifact of f.submission.artifacts) await worker.upload(f.workflow.artifacts.get(artifact.ref));
  await worker.call('factory_workflow',{action:'claim',taskId:'repair'});
  await worker.call('factory_workflow',{action:'submit',taskId:'repair',input:f.submission});
  const supervisor=new FactoryWorkflowSupervisor({client:operator,directory:join(f.root,'verifier-service'),repositories:{'example/repository':f.cwd}});
  const runs=await supervisor.drain(); assert.equal(runs.length,1); assert.equal(runs[0].result.outcome,'passed');
  assert.equal((await operator.task('repair')).status,'review');
  await reviewer.call('factory_workflow',{action:'review',candidateId:'candidate-one',input:{accepted:true,findings:[],rationale:'Frozen requirements met'}});
  assert.equal((await operator.task('repair')).status,'accepted');
  assert.deepEqual(await supervisor.drain(),[]);
});

test('comparison keeps all inputs matched, isolates arms and counts interrupted work separately', () => {
  const rev='a'.repeat(40),sha='b'.repeat(64);
  const plan=createWorkflowComparison({id:'matched-test',baseline:{revision:rev,bundleSha256:sha},improved:{revision:'c'.repeat(40),bundleSha256:'d'.repeat(64)},task:{repository:'example/repo',revision:rev,goal:'Repair behavior',acceptance:'Same criteria'},armRepositories:{baseline:'example/arm-baseline',improved:'example/arm-improved'},model:'gpt-6-luna',validationPolicy:'Local only',evaluatorRevision:rev});
  assert.equal(plan.arms[0].plan.workflow,undefined); assert.equal(plan.arms[1].plan.workflow,'verified-v1');
  assert.notEqual(plan.arms[0].namespace,plan.arms[1].namespace);
  assert.equal(plan.arms[0].plan.repositoryRevision,plan.arms[1].plan.repositoryRevision);
  const report=summarizeWorkflowComparison(plan,[{arm:'baseline',taskId:'mission',outcome:'interrupted'},{arm:'improved',taskId:'mission',outcome:'pending'}]);
  assert.equal(report.results.baseline.failed,0); assert.equal(report.results.baseline.interrupted,1); assert.equal(report.results.baseline.providerCost,null);
});
