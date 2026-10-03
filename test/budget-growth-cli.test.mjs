import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {FactoryControl,digest} from '../src/control.mjs';

const cli=fileURLToPath(new URL('../bin/factory.mjs',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
async function invoke(command,database,input,extra=[]){
 const p=spawn(process.execPath,[cli,command,database,...extra],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',overflow=false;
 for(const [stream,key]of [[p.stdout,'out'],[p.stderr,'err']])stream.on('data',b=>{if(key==='out')stdout+=b;else stderr+=b;if(stdout.length+stderr.length>65536){overflow=true;p.kill('SIGTERM');}});
 const timer=setTimeout(()=>p.kill('SIGTERM'),20000);const closed=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(code,signal)=>resolve({code,signal,stdout,stderr,pid:p.pid}));});
 p.stdin.on('error',()=>{});p.stdin.end(input===undefined?'':JSON.stringify(input));try{const result=await closed;assert.equal(overflow,false);assert.equal(result.signal,null);assert.ok(result.pid>0);return result;}finally{clearTimeout(timer);}
}
async function fixture(t,{initialize=true}={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'factory-budget-growth-cli-')),database=path.join(dir,'control.sqlite'),connections=[];t.after(async()=>{for(const c of connections)try{c.close();}catch{}assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'factory-budget-growth-cli-'));await fs.rm(dir,{recursive:true,force:true});});const open=()=>{const c=new FactoryControl(database);connections.push(c);return c;};const control=initialize?open():null;if(control)control.initialize({mission:'Improve FLUJO',budgetCents:10000,maxCells:2,maxDepth:1});return{dir,database,control,open};}
const parse=r=>{assert.equal(r.code,0,r.stderr);return JSON.parse(r.stdout);};
const cas=(control,transitionId)=>({transitionId,expectedFactoryEpoch:control.control().epoch,expectedPolicyDigest:digest(control.control().policy)});

test('growth-policy reads the exact initialized legacy policy and digest without modifying main bytes',async t=>{
 const f=await fixture(t),before=sha(await fs.readFile(f.database)),revision=f.control.db.prepare('SELECT max(seq) AS n FROM events').get().n;
 const value=parse(await invoke('growth-policy',f.database));assert.equal(value.scope,'trusted-local-growth-policy');assert.deepEqual(value.policy,f.control.control().policy);assert.equal(value.policyDigest,digest(value.policy));assert.equal(value.epoch,1);assert.equal(value.status,'active');assert.equal(sha(await fs.readFile(f.database)),before);assert.equal(f.control.db.prepare('SELECT max(seq) AS n FROM events').get().n,revision);
});

test('actual CLI transition remains paused, preserves uncertain history and fences the original claim',async t=>{
 const f=await fixture(t);f.control.createTask({taskId:'work',projectId:'fixture',branch:'codex/growth-fixture',specification:{problem:'Original work',acceptance:'Independent review',baseline:'fixture'}});const lease=f.control.claimTask('work','root',600000);f.control.admitEffect(lease,{key:'original-unknown',kind:'flow_call',request:{conversationId:'original-conversation'}});f.control.startEffect(lease,'original-unknown');f.control.settleEffect('original-unknown','unknown',{state:'unknown'});f.control.pause();
 const old=f.control.status(),originalEvents=f.control.db.prepare('SELECT * FROM events ORDER BY seq').all(),request=cas(f.control,'cli-transition');const value=parse(await invoke('budget-growth',f.database,request));assert.equal(value.replayed,false);assert.equal(value.control.status,'paused');assert.equal(value.control.epoch,old.control.epoch+1);assert.equal(value.control.policy.growthMode,'budget-only');assert.equal(value.control.policy.maxCells,null);assert.equal(value.control.policy.maxDepth,null);
 const current=f.control.status();assert.deepEqual(current.cells,old.cells);assert.deepEqual(current.tasks,old.tasks);assert.deepEqual(current.effects,old.effects);assert.deepEqual(f.control.db.prepare('SELECT * FROM events ORDER BY seq LIMIT ?').all(originalEvents.length),originalEvents);assert.equal(f.control.effect('original-unknown').state,'unknown');
 const replay=parse(await invoke('budget-growth',f.database,request));assert.equal(replay.replayed,true);assert.equal(f.control.control().epoch,value.control.epoch);f.control.resume();assert.throws(()=>f.control.admitEffect(lease,{key:'stale-new',kind:'flow_call',request:{}}),e=>e.code==='STALE');assert.throws(()=>f.control.claimTask('work','root'),e=>e.code==='UNRECONCILED');assert.equal(f.control.status().effects.length,1);
});

test('concurrent CLI policy changes admit one paused epoch transition and one immutable record',async t=>{
 const f=await fixture(t);f.control.pause();const a=cas(f.control,'concurrent-a'),b={...a,transitionId:'concurrent-b'};const results=await Promise.all([invoke('budget-growth',f.database,a),invoke('budget-growth',f.database,b)]);assert.equal(results.filter(r=>r.code===0).length,1);assert.equal(results.filter(r=>r.code===1).length,1);assert.equal(f.control.control().epoch,a.expectedFactoryEpoch+1);assert.equal(f.control.control().status,'paused');assert.equal(f.control.db.prepare("SELECT count(*) AS n FROM events WHERE type='growth_policy_changed'").get().n,1);
});

test('growth commands reject missing, blank, foreign, malformed and relative databases before creating authority',async t=>{
 const f=await fixture(t);f.control.pause();const request=cas(f.control,'refused');const missing=path.join(f.dir,'missing','control.sqlite'),blank=path.join(f.dir,'blank.sqlite'),foreign=path.join(f.dir,'foreign.sqlite');await fs.writeFile(blank,'');await fs.writeFile(foreign,'not-a-factory');
 for(const filename of [missing,blank,foreign,'relative-growth.sqlite']){const r=await invoke('budget-growth',filename,request);assert.equal(r.code,1);assert.equal(r.stdout,'');}assert.equal(await fs.stat(path.dirname(missing)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false);assert.equal((await fs.readFile(blank)).length,0);assert.equal(await fs.readFile(foreign,'utf8'),'not-a-factory');assert.equal(await fs.stat(path.resolve('relative-growth.sqlite')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false);
 const old=f.control.control().policy;f.control.db.prepare('UPDATE control SET policy=?').run(JSON.stringify({...old,maxCells:null}));const before=sha(await fs.readFile(f.database)),events=f.control.db.prepare('SELECT * FROM events ORDER BY seq').all();const refused=await invoke('budget-growth',f.database,request);assert.equal(refused.code,1);assert.equal(refused.stdout,'');assert.equal(JSON.parse(refused.stderr.trim().split('\n').find(s=>s.startsWith('{'))).code,'GROWTH_POLICY_INVALID');assert.equal(sha(await fs.readFile(f.database)),before);assert.deepEqual(f.control.db.prepare('SELECT * FROM events ORDER BY seq').all(),events);
});

test('explicit CLI initialization is budget-only while numeric and extra command caps are refused',async t=>{
 const f=await fixture(t,{initialize:false});const input={mission:'Improve FLUJO',budgetCents:10000,growthMode:'budget-only'};const initialized=parse(await invoke('init',f.database,input));assert.equal(initialized.policy.schemaVersion,2);assert.equal(initialized.policy.maxCells,null);assert.equal(initialized.policy.maxDepth,null);const read=parse(await invoke('growth-policy',f.database));assert.equal(read.policyDigest,digest(initialized.policy));assert.equal(parse(await invoke('init',f.database,input)).epoch,initialized.epoch);
 const refused=await invoke('init',f.database,{...input,maxCells:5});assert.equal(refused.code,1);const extra=await invoke('budget-growth',f.database,{transitionId:'unexpected',expectedFactoryEpoch:1,expectedPolicyDigest:read.policyDigest},['--execute']);assert.equal(extra.code,1);assert.equal(JSON.parse(extra.stderr.trim().split('\n').find(s=>s.startsWith('{'))).code,'GROWTH_ARGUMENTS');
});
