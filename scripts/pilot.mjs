import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FactoryControl } from '../src/control.mjs';
import { inspectIntegrationRef } from '../src/adapters/git-delivery.mjs';

const execute=promisify(execFile);
const json=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
function processRun(code,input) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);
    child.on('exit',exitCode=>resolve({exitCode,stdout,stderr}));child.stdin.end(JSON.stringify(input));
  });
}

/** Deterministic code fixtures, actual subprocesses/SQLite/Git. Does not run a model or cloud worker. */
export async function runPilot(outputDirectory) {
  const directory=resolve(outputDirectory),repository=join(directory,'repository'),database=join(directory,'control.sqlite');
  await mkdir(directory,{recursive:true});await mkdir(repository);await mkdir(join(repository,'src'));
  const emptyHooks=join(directory,'empty-hooks');await mkdir(emptyHooks);
  const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  const git=async(...args)=>(await execute('git',['-c',`core.hooksPath=${emptyHooks}`,'-c','commit.gpgsign=false',...args],{cwd:repository,env:environment,windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=integration');await git('config','user.name','Factory fixture');await git('config','user.email','factory@example.invalid');
  const source=join(repository,'src','checkpoint.mjs');
  await writeFile(source,'export function checkpointState(value) { return value.toLowerCase(); }\n');await git('add','.');await git('commit','-m','Fixture baseline');const baseline=await git('rev-parse','HEAD');
  const control=new FactoryControl(database);control.initialize({mission:'Offline federation protocol proof',budgetCents:10000,maxCells:5,maxDepth:2});
  for(const [cellId,role] of [['dev-a','developer'],['dev-b','developer'],['verifier','verifier'],['watcher','watcher']]) {control.reserveCell({cellId,role,budgetCents:1000,purpose:'offline proof '+role});control.enrollCell(cellId);}
  const specification={problem:'Checkpoint normalization throws on non-string input.',acceptance:'Trim and lowercase string input; return unknown for unsupported input.',baseline,deliveryTarget:{repository,ref:'refs/heads/integration'},evidenceScope:'deterministic-code-fixture'};
  const results=[];
  for(const [suffix,implementation] of [
    ['a','export function checkpointState(value) { return typeof value === "string" ? value.trim().toLowerCase() : "unknown"; }\n'],
    ['b','export function checkpointState(value) { return String(value).trim().toLowerCase(); }\n'],
  ]) {
    const taskId='approach-'+suffix,branch='codex/approach-'+suffix;
    control.createTask({taskId,projectId:'fixture',branch,specification});const lease=control.claimTask(taskId,'dev-'+suffix);
    await git('checkout','-b',branch,baseline);await writeFile(source,implementation);await git('add','.');await git('commit','-m','Candidate '+suffix);const candidateHead=await git('rev-parse','HEAD');
    const candidatePath=join(directory,'candidate-'+suffix+'.json');await json(candidatePath,{taskId,baseline,candidateHead,branch,repository,ref:'refs/heads/integration'});
    control.submit(lease,{artifactPath:candidatePath});
    const evaluationSource=join(directory,'evaluation-'+suffix+'.mjs');await writeFile(evaluationSource,await git('show',candidateHead+':src/checkpoint.mjs'));
    const evaluation=await processRun(`import {checkpointState} from ${JSON.stringify(pathToFileURL(evaluationSource).href)}; const cases=[[' READY ','ready'],[null,'unknown'],[42,'unknown']]; const results=cases.map(([input,expected])=>{let actual;try{actual=checkpointState(input);}catch{actual='THREW';}return {expected,actual,passed:actual===expected};}); console.log(JSON.stringify({passed:results.every(x=>x.passed),results}));`,{});
    assert.equal(evaluation.exitCode,0);const verdict=JSON.parse(evaluation.stdout);const reviewPath=join(directory,'review-'+suffix+'.json');await json(reviewPath,{taskId,baseline,candidateHead,...verdict,scope:'independent subprocess evaluating deterministic fixture'});
    control.reviewTask(taskId,'verifier',{accepted:verdict.passed,evidencePath:reviewPath});results.push({taskId,baseline,candidateHead,passed:verdict.passed});
    control.sendMessage({sender:'verifier',recipient:'watcher',messageId:'review-'+suffix,taskId,attempt:lease.epoch,payload:{accepted:verdict.passed,artifact:reviewPath}});
  }
  assert.equal(results[0].passed,true);assert.equal(results[1].passed,false);
  const integration=control.claimIntegration('fixture','root',60000);
  const request={repository,ref:'refs/heads/integration',expectedHead:baseline,candidateHead:results[0].candidateHead};
  control.close();
  const controlUrl=new URL('../src/control.mjs',import.meta.url).href,gitUrl=new URL('../src/adapters/git-delivery.mjs',import.meta.url).href;
  const crash=await processRun(`import {FactoryControl} from ${JSON.stringify(controlUrl)}; import {updateIntegrationRef} from ${JSON.stringify(gitUrl)}; let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);const c=new FactoryControl(input.database);c.admitEffect(input.lease,{key:'integration-1',kind:'delivery',taskId:'approach-a',request:input.request});c.startEffect(input.lease,'integration-1');await updateIntegrationRef(input.request);process.stdout.write('Injected process exit after real Git mutation and before receipt.\\n');process.exit(73);`,{database,lease:integration,request});
  assert.equal(crash.exitCode,73,crash.stderr);
  const recovered=new FactoryControl(database,{clock:()=>Date.now()+120000});
  try {
    assert.equal(recovered.effect('integration-1').state,'running');
    assert.throws(()=>recovered.claimIntegration('fixture'),error=>error.code==='UNRECONCILED');
    const actual=await inspectIntegrationRef({repository,ref:request.ref});assert.equal(actual,request.candidateHead);
    const reconciliation=join(directory,'reconciliation.json');await json(reconciliation,{effectKey:'integration-1',ref:request.ref,expectedHead:baseline,observedHead:actual,applied:actual===request.candidateHead,scope:'real local Git observation after process termination'});
    recovered.reconcileEffect('integration-1',{applied:true,evidencePath:reconciliation});recovered.deliverTask('approach-a','integration-1');
    const successor=recovered.claimIntegration('fixture');assert.equal(successor.epoch,2);
    assert.throws(()=>recovered.admitEffect(integration,{key:'stale-replay',kind:'delivery',taskId:'approach-a',request}),error=>error.code==='STALE');
    const finalHead=await inspectIntegrationRef({repository,ref:request.ref});assert.equal(finalHead,actual);
    const state=recovered.pause();
    const report={schemaVersion:1,passed:true,evidenceScope:'offline local protocol proof; deterministic code fixtures; real processes, SQLite and Git',cloudProvisioned:false,providerCalls:0,networkFederationQualified:false,results,crash:{exitCode:crash.exitCode,receiptWasMissing:true},recovery:{observedHead:actual,blindReplay:false,successorEpoch:successor.epoch,staleAdmissionRejected:true},final:{taskStatus:recovered.task('approach-a').status,integrationHead:finalHead,effectsDrained:state.effectsDrained,workerQuiescence:state.workerQuiescence},directory};
    await json(join(directory,'report.json'),report);await json(join(directory,'state.json'),state);return report;
  } finally {recovered.close();}
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const report=await runPilot(process.argv[2]??join('evidence','pilot-'+Date.now()));
  console.log(JSON.stringify(report,null,2));
}
