import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeWorkflowWake} from '../src/cloud-lite/workflow-wake.mjs';
const threadId='00000000-0000-0000-0000-000000000001';
function file(){const parent=process.env.FACTORY_TEST_TMP??tmpdir();mkdirSync(parent,{recursive:true});return join(mkdtempSync(join(parent,'factory-wake-')),'wake.json');}
test('native wake retains a rejected start and retries only after native idle readback',async()=>{
  let starts=0;const rpc={request:async method=>{if(method==='thread/read')return {thread:{id:threadId,status:{type:'idle'},turns:[{id:'before'}]}};
    if(++starts===1)throw Object.assign(new Error('Invalid request'),{code:-32602});return {turn:{id:'after'}};}};
  const wake=new NativeWorkflowWake({rpc,threadId,file:file(),effort:'medium'});
  assert.equal((await wake.wake({trigger:'1:2',input:'Continue'})).status,'rejected');
  assert.equal((await wake.wake({trigger:'1:2',input:'Continue'})).status,'delivered');assert.equal(starts,2);
  await wake.wake({trigger:'1:2',input:'Continue'});assert.equal(starts,2);
});
test('lost native start response reconciles through restart without another model turn',async()=>{
  let starts=0,last='before';const path=file();
  const rpc={request:async method=>{if(method==='thread/read')return {thread:{id:threadId,status:{type:last==='before'?'idle':'active'},turns:[{id:last}]}};
    starts++;last='after';throw new Error('Response lost');}};
  const wake=new NativeWorkflowWake({rpc,threadId,file:path});
  assert.equal((await wake.wake({trigger:'1:2',input:'Continue'})).status,'delivered');
  const recovered=new NativeWorkflowWake({rpc,threadId,file:path});await recovered.wake({trigger:'1:2',input:'Continue'});assert.equal(starts,1);
});
test('unresolved native start is retained without blindly replaying even after restart',async()=>{
  let starts=0;const path=file();const rpc={request:async method=>{if(method==='thread/read')return {thread:{id:threadId,status:{type:'idle'},turns:[{id:'before'}]}};starts++;throw new Error('Unconfirmed delivery');}};
  const wake=new NativeWorkflowWake({rpc,threadId,file:path});assert.equal((await wake.wake({trigger:'1:2',input:'Continue'})).status,'unknown');
  const recovered=new NativeWorkflowWake({rpc,threadId,file:path});assert.equal((await recovered.wake({trigger:'2:3',input:'More work'})).status,'unknown');assert.equal(starts,1);
});
