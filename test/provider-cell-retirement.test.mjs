import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FactoryControl } from '../src/control.mjs';
import { observeProvisionedCellRetirement, providerRetirementEvidence } from '../src/provider-retirement.mjs';
import { SpendingLedger } from '../src/spending.mjs';

// The configured executable is a genuine child process. A test-only Node preload
// emulates inventory responses; the production API has no callback/service hook.
function fixture(t) {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(path.join(parent,'factory-provider-closure-'));
  const database = path.join(dir,'control.sqlite'), control = new FactoryControl(database);
  control.initialize({mission:'Provider closure fixture',budgetCents:10000,maxCells:12,maxDepth:3});
  const managedDirectory = path.join(dir,'managed'), workers = path.join(managedDirectory,'workers');
  mkdirSync(workers,{recursive:true});
  const inventory = path.join(dir,'inventory.json'), calls = path.join(dir,'calls.jsonl'), preload = path.join(dir,'fake-fly.mjs');
  writeFileSync(inventory,'[]',{mode:0o600});
  writeFileSync(preload,`import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
const args=process.argv.slice(1);args[0]=path.basename(args[0]);appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.join(' ')!=='apps list --org personal --json')process.exit(71);
const value=JSON.parse(readFileSync(${JSON.stringify(inventory)},'utf8'));
if(value.mutate)writeFileSync(value.mutate.path,value.mutate.content);
if(value.delay)await new Promise(resolve=>setTimeout(resolve,value.delay));
if(value.exit)process.exit(value.exit);
process.stdout.write(value.raw??JSON.stringify(value.apps??value));process.exit(0);
`);
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previousOptions ? previousOptions+' ' : ''}--import=${pathToFileURL(preload).href}`;
  const connections = [control];
  t.after(() => {
    if(previousOptions === undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previousOptions;
    for(const value of connections)try{value.close();}catch{}
    assert.equal(path.dirname(dir),parent); assert.ok(path.basename(dir).startsWith('factory-provider-closure-'));
    rmSync(dir,{recursive:true,force:true,maxRetries:3});
  });
  const options = {managedDirectory,org:'personal',workspace:'factory-pilot',flyPath:process.execPath};
  function bound(cellId='worker',parentId='root',allocation=1000) {
    control.reserveCell({cellId,parentId,role:'developer',budgetCents:allocation,purpose:cellId});
    const taskId='launch-'+cellId;
    control.createTask({taskId,projectId:'project',branch:'codex/'+taskId,
      specification:{problem:'Provision worker',acceptance:'Bound provider worker',baseline:'fixture'}});
    const lease=control.claimTask(taskId,parentId),app='factory-'+cellId;
    const source='http://127.0.0.1:4200',image='ghcr.io/example/flujo@sha256:'+'a'.repeat(64);
    const provisionKey='provision-'+cellId,retirementKey='retire-'+cellId;
    control.admitEffect(lease,{key:provisionKey,kind:'provision',request:{cellId,app,source,workspace:options.workspace,image}});
    control.startEffect(lease,provisionKey);
    const owner=randomUUID(),createdAt=new Date().toISOString();
    const metadata={format:'flujo-managed-deployment',version:1,id:app,attemptId:randomUUID(),phase:'destroyed',source,
      workspace:options.workspace,org:options.org,region:'iad',image,createdAt,journalOwner:owner,retirement:'cloud-confirmed'};
    const journal={format:'flujo-cloud-journal',version:1,owner,createdAt,state:'destroyed',stage:'destroyed',app,org:options.org,
      region:'iad',workspace:options.workspace,image,authState:'copied-workspace',appCreated:true,appId:app,ownershipConfirmed:true,
      volumeName:'worker_'+owner.replaceAll('-','').slice(0,12),volumeId:'vol_fixture_'+cellId,
      machineName:'worker-'+owner.replaceAll('-','').slice(0,12),machineId:'machine_'+cellId,archiveSha256:'b'.repeat(64),
      updatedAt:createdAt};
    control.settleEffect(provisionKey,'succeeded',{app,worker:app,state:'ready'});
    control.enrollCell(cellId);
    control.admitOwnedRetirement({key:retirementKey,app});control.startOwnedRetirement(retirementKey);
    control.settleEffect(retirementKey,'succeeded',{app,worker:app,state:'destroyed'});
    const metadataPath=path.join(workers,app+'.deployment.json'),journalPath=path.join(workers,app+'.journal.json');
    writeFileSync(metadataPath,JSON.stringify(metadata),{mode:0o600});writeFileSync(journalPath,JSON.stringify(journal),{mode:0o600});
    return {cellId,app,provisionKey,retirementKey,metadata,journal,metadataPath,journalPath,lease,taskId};
  }
  function input(value,closureId='close-'+value.cellId) {
    const cell=control.db.prepare('SELECT * FROM cells WHERE id=?').get(value.cellId);
    return {closureId,expectedParent:cell.parent_id,expectedStatus:cell.status,expectedAllocation:cell.allocation,
      expectedSpent:cell.spent,expectedFactoryEpoch:control.control().epoch,provisionKey:value.provisionKey,retirementKey:value.retirementKey};
  }
  function count(type) {return control.db.prepare('SELECT count(*) AS n FROM events WHERE type=?').get(type).n;}
  return {dir,database,control,options,inventory,calls,workers,bound,input,count,
    observe:(value,request=input(value))=>observeProvisionedCellRetirement(control,value.cellId,request,options),
    open(){const value=new FactoryControl(database);connections.push(value);return value;},
    track(connection){connections.push(connection);return connection;},
    callCount(){return readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).length;}};
}

test('fresh subprocess inventory closes exact provider-bound leaf, preserving history and replay across epochs/reopen',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();const request=f.input(value);
  const effectBytes=JSON.stringify(f.control.status().effects),proof=await f.observe(value,request);
  assert.equal(JSON.stringify(proof),'{}');
  const prepared=providerRetirementEvidence(proof,f.control);
  assert.equal(Object.isFrozen(prepared),true);assert.equal(f.count('cell_retired'),0);
  assert.equal(prepared.inventoryScope,'configured-org-app-inventory-returned-by-trusted-cli');
  const result=f.control.retireProvisionedCell(value.cellId,request,proof);
  assert.equal(result.status,'retired');assert.equal(result.releasedLogicalCents,1000);
  assert.equal(result.resourceScope,'owned-fly-teardown-recorded-and-app-not-returned-by-configured-inventory');assert.equal(result.workerQuiescence,'unverified');
  assert.match(result.resourceEvidence.evidenceDigest,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(f.control.status().effects),effectBytes);
  assert.deepEqual(f.control.retireProvisionedCell(value.cellId,request,proof),result);
  f.control.resume();f.control.pause();assert.deepEqual(f.open().retireProvisionedCell(value.cellId,request),result);
  assert.equal(f.count('cell_retired'),1);assert.equal(f.callCount(),1);
  assert.throws(()=>f.control.retireProvisionedCell(value.cellId,{...request,closureId:'different'},proof),{code:'STALE'});
  assert.throws(()=>f.control.enrollCell(value.cellId),{code:'PAUSED'});
});

test('JSON, trusted booleans, wrong controller, changed request and expired/future proof cannot close a cell',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();const request=f.input(value),proof=await f.observe(value,request);
  for(const forged of [{},{trusted:true,state:'destroyed'},JSON.parse(JSON.stringify(proof)),undefined])
    assert.throws(()=>f.control.retireProvisionedCell(value.cellId,request,forged),{code:'PROVIDER_RETIREMENT_PROOF'});
  assert.throws(()=>f.open().retireProvisionedCell(value.cellId,request,proof),{code:'PROVIDER_RETIREMENT_PROOF'});
  assert.throws(()=>f.control.retireProvisionedCell(value.cellId,{...request,closureId:'other'},proof),{code:'PROVIDER_RETIREMENT_PROOF'});
  const clock=Date.now;
  try {Date.now=()=>clock()+60_001;assert.throws(()=>f.control.retireProvisionedCell(value.cellId,request,proof),{code:'PROVIDER_RETIREMENT_STALE'});
    Date.now=()=>clock()-60_000;assert.throws(()=>f.control.retireProvisionedCell(value.cellId,request,proof),{code:'PROVIDER_RETIREMENT_STALE'});
  } finally {Date.now=clock;}
  assert.equal(f.count('cell_retired'),0);
});

test('old logical retirement still rejects provision bindings; existing provider identity and epoch cannot change',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();const request=f.input(value),proof=await f.observe(value,request);
  const logical=Object.fromEntries(Object.entries(request).filter(([key])=>!['provisionKey','retirementKey'].includes(key)));
  assert.throws(()=>f.control.retireCell(value.cellId,logical),{code:'PROVISIONED_CELL'});
  f.control.resume();f.control.pause();
  assert.throws(()=>f.control.retireProvisionedCell(value.cellId,request,proof),{code:'STALE'});
  assert.equal(f.count('cell_retired'),0);
});

test('visible app, malformed/duplicate/wrong-org inventory and CLI failure do not mint retirement proof',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();
  const row={Name:value.app,ID:value.app,Organization:{Slug:'personal'}};
  for(const inventory of [[row],[row,row],[{...row,Name:'other-app'}],[{...row,name:'other-app'}],
    [{...row,Organization:{Slug:'other'}}],{raw:'private-token-malformed-json'}, {exit:4}]) {
    writeFileSync(f.inventory,JSON.stringify(inventory));
    await assert.rejects(f.observe(value),error=>{assert.match(error.code,/^PROVIDER_RETIREMENT_/);assert.doesNotMatch(error.message,/private-token|\.json|factory-provider-closure/);return true;});
  }
  assert.equal(f.count('cell_retired'),0);
});

test('managed generation, original source digest and cleanup event binding are required before any CLI call',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();
  for(const changed of [{retirement:'local-capture'},{phase:'ready'},{journalOwner:randomUUID()},{source:'http://127.0.0.1:4201'},
    {createdAt:'2000-01-01T00:00:00.000Z'}]) {
    writeFileSync(value.metadataPath,JSON.stringify({...value.metadata,...changed}));
    await assert.rejects(f.observe(value),error=>/^PROVIDER_RETIREMENT_(GENERATION|REQUEST_BINDING|TIME_BINDING)$/.test(error.code));
  }
  writeFileSync(value.metadataPath,JSON.stringify(value.metadata));
  const accepted=f.control.db.prepare("SELECT seq,details FROM events WHERE type='owned_retirement_accepted' AND subject=?").get(value.retirementKey);
  f.control.db.prepare('UPDATE events SET details=? WHERE seq=?').run(JSON.stringify({...JSON.parse(accepted.details),provisionKey:'other'}),accepted.seq);
  await assert.rejects(f.observe(value),{code:'PROVIDER_RETIREMENT_BINDING'});
  assert.throws(()=>readFileSync(f.calls),{code:'ENOENT'});assert.equal(f.count('cell_retired'),0);
});

test('managed writes, locks and byte-identical replacement fence a minted proof',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();const request=f.input(value);
  for(const suffix of ['.managed.lock','.journal.json.lock','.journal.json.next']) {
    const lock=path.join(f.workers,value.app+suffix);writeFileSync(lock,'{}');
    await assert.rejects(f.observe(value,request),{code:'PROVIDER_RETIREMENT_BUSY'});rmSync(lock);
  }
  const proof=await f.observe(value,request),original=readFileSync(value.metadataPath);
  renameSync(value.metadataPath,value.metadataPath+'.old');writeFileSync(value.metadataPath,original,{mode:0o600});
  assert.throws(()=>f.control.retireProvisionedCell(value.cellId,request,proof),{code:'PROVIDER_RETIREMENT_STALE'});
  assert.equal(f.count('cell_retired'),0);
});

test('a managed generation changing during actual subprocess inspection cannot mint proof',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();
  writeFileSync(f.inventory,JSON.stringify({apps:[],mutate:{path:value.journalPath,content:JSON.stringify({...value.journal,updatedAt:new Date().toISOString()})}}));
  await assert.rejects(f.observe(value),error=>/^PROVIDER_RETIREMENT_(STALE|GENERATION)$/.test(error.code));
  assert.equal(f.count('cell_retired'),0);assert.equal(f.callCount(),1);
});

test('nested provider closure is leaf-first, conserves allocation once and preserves verified artifacts and paid holds',async t=>{
  const f=fixture(t),parent=f.bound('parent','root',6000),child=f.bound('child','parent',1500);
  // Release the parent-owned launch task explicitly so it cannot be hidden by parent retirement.
  const launch=f.control.task(child.taskId);
  f.control.releaseTask(child.taskId,{closureId:'release-launch-child',expectedAttempt:launch.epoch,expectedOwner:launch.owner,
    expectedStatus:'running',expectedTaskControlEpoch:launch.control_epoch,expectedFactoryEpoch:f.control.control().epoch});
  f.control.reserveCell({cellId:'verify',parentId:'root',role:'verifier',budgetCents:0,purpose:'Review'});f.control.enrollCell('verify');
  f.control.createTask({taskId:'candidate',projectId:'project',branch:'codex/candidate',specification:{problem:'Change',acceptance:'Review',baseline:'fixed'}});
  const lease=f.control.claimTask('candidate','child'),artifact=path.join(f.dir,'artifact.json'),review=path.join(f.dir,'review.json');
  writeFileSync(artifact,'{"candidate":"preserved"}');writeFileSync(review,'{"review":"accepted"}');
  f.control.submit(lease,{artifactPath:artifact});f.control.reviewTask('candidate','verify',{accepted:true,evidencePath:review});
  const before=f.control.task('candidate');
  const paidPath=path.join(f.dir,'spending.sqlite'),paid=f.track(new SpendingLedger(paidPath));
  paid.initialize({limitCents:10000,currency:'USD'});paid.reserve({reservationId:'held',provider:'fly',ceilingCents:1000});paid.start('held');
  const paidBefore=JSON.stringify(paid.status());f.control.pause();
  const parentRequest=f.input(parent),parentProof=await f.observe(parent,parentRequest);
  assert.throws(()=>f.control.retireProvisionedCell(parent.cellId,parentRequest,parentProof),{code:'CHILDREN'});
  const childRequest=f.input(child),childProof=await f.observe(child,childRequest);
  const childResult=f.control.retireProvisionedCell(child.cellId,childRequest,childProof);
  assert.equal(childResult.releasedLogicalCents,1500);
  const parentResult=f.control.retireProvisionedCell(parent.cellId,parentRequest,parentProof);
  assert.equal(parentResult.releasedLogicalCents,6000);assert.equal(f.control.status().cells.find(x=>x.id==='root').spent,0);
  const after=f.control.task('candidate');assert.equal(after.status,'verified');assert.deepEqual(after.candidate,before.candidate);
  assert.deepEqual(after.review,before.review);assert.deepEqual(after.specification,before.specification);assert.equal(after.owner,'child');assert.equal(after.epoch,1);
  assert.equal(after.expires,null);assert.equal(JSON.stringify(paid.status()),paidBefore);assert.equal(f.count('cell_retired'),2);
  assert.deepEqual(f.control.retireProvisionedCell(child.cellId,childRequest,childProof),childResult);
  assert.equal(f.count('cell_retired'),2);paid.close();
});

test('running owned task and its causal unknown effect prevent closure',async t=>{
  const f=fixture(t),value=f.bound();
  f.control.createTask({taskId:'work',projectId:'project',branch:'codex/work',specification:{problem:'Work',acceptance:'Receipt',baseline:'fixed'}});
  const lease=f.control.claimTask('work',value.cellId);
  f.control.admitEffect(lease,{key:'unknown-call',kind:'flow_call',request:{input:'bounded'}});f.control.startEffect(lease,'unknown-call');
  f.control.settleEffect('unknown-call','unknown',{});f.control.pause();const request=f.input(value),proof=await f.observe(value,request);
  assert.throws(()=>f.control.retireProvisionedCell(value.cellId,request,proof),{code:'TASK'});
  // Historical task no longer running, but its unknown causal effect still blocks.
  f.control.db.prepare("UPDATE tasks SET status='review' WHERE id='work'").run();
  assert.throws(()=>f.control.retireProvisionedCell(value.cellId,request,proof),{code:'UNRECONCILED'});
  assert.equal(f.count('cell_retired'),0);
});

test('an unrelated root-owned unknown effect stays unknown while the exact retired leaf closes',async t=>{
  const f=fixture(t),value=f.bound();
  f.control.createTask({taskId:'unrelated',projectId:'other-project',branch:'codex/unrelated',
    specification:{problem:'Other work',acceptance:'Other receipt',baseline:'fixed'}});
  const lease=f.control.claimTask('unrelated','root');
  f.control.admitEffect(lease,{key:'unrelated-call',kind:'flow_call',request:{input:'other'}});
  f.control.startEffect(lease,'unrelated-call');f.control.settleEffect('unrelated-call','unknown',{});
  f.control.pause();const request=f.input(value),proof=await f.observe(value,request);
  assert.equal(f.control.retireProvisionedCell(value.cellId,request,proof).status,'retired');
  assert.equal(f.control.effect('unrelated-call').state,'unknown');assert.equal(f.control.status().unresolvedEffects,1);
  assert.equal(f.count('cell_retired'),1);
});

test('two genuine inspections on separate SQLite connections produce one closure event and historical exact replay',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();const request=f.input(value),other=f.open();
  const [first,second]=await Promise.all([f.observe(value,request),observeProvisionedCellRetirement(other,value.cellId,request,f.options)]);
  const result=f.control.retireProvisionedCell(value.cellId,request,first);
  assert.deepEqual(other.retireProvisionedCell(value.cellId,request,second),result);
  assert.equal(f.count('cell_retired'),1);assert.equal(f.callCount(),2);
  assert.equal(f.control.status().cells.find(row=>row.id==='root').spent,0);
});

test('expiry during synchronous artifact validation prevents consuming the proof',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();const request=f.input(value),proof=await f.observe(value,request);
  const original=Date.now,now=original();let count=0;
  try {Date.now=()=>++count===1?now:now+60_001;
    assert.throws(()=>f.control.retireProvisionedCell(value.cellId,request,proof),{code:'PROVIDER_RETIREMENT_STALE'});
  }finally{Date.now=original;}
  assert.equal(f.count('cell_retired'),0);
});

test('hardlinked, oversized and invalid artifacts fail safely before any CLI action',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();const bytes=readFileSync(value.metadataPath);
  const linked=value.metadataPath+'.linked';linkSync(value.metadataPath,linked);
  await assert.rejects(f.observe(value),{code:'PROVIDER_RETIREMENT_UNCONFIRMED'});rmSync(linked);
  for(const contents of ['private-token-invalid-json',Buffer.alloc(65537,32)]) {
    writeFileSync(value.metadataPath,contents);
    await assert.rejects(f.observe(value),error=>{assert.equal(error.code,'PROVIDER_RETIREMENT_UNCONFIRMED');
      assert.doesNotMatch(error.message,/private-token|\.json|factory-provider/);return true;});
  }
  writeFileSync(value.metadataPath,bytes);
  assert.throws(()=>readFileSync(f.calls),{code:'ENOENT'});assert.equal(f.count('cell_retired'),0);
});

test('closed configuration rejects callbacks and partially qualified paths before dispatch',async t=>{
  const f=fixture(t),value=f.bound();f.control.pause();const request=f.input(value);
  for(const options of [{...f.options,operation:()=>[]},{...f.options,flyPath:'flyctl'},
    {...f.options,managedDirectory:'relative-private-directory'},...(process.platform==='win32'?[{...f.options,flyPath:'\\root-relative.exe'}]:[])])
    await assert.rejects(observeProvisionedCellRetirement(f.control,value.cellId,request,options),{code:'PROVIDER_RETIREMENT_INPUT'});
  assert.throws(()=>readFileSync(f.calls),{code:'ENOENT'});assert.equal(f.count('cell_retired'),0);
});
