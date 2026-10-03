import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CAPACITY_TOOL, startCapacityMcpServer, createNativeWorkerReader } from '../src/capacity-mcp.mjs';
const token='a'.repeat(64),input={requestId:'r1',role:'developer',budgetCents:10,purpose:'Test isolated branch'};
async function client(endpoint){const c=new Client({name:'test',version:'1'},{capabilities:{}});await c.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{authorization:'Bearer '+token}}}));return c;}
test('actual SDK advertises narrow tool, attests before calling, and withholds privileged output',async()=>{
  const order=[];const m=await startCapacityMcpServer({token,nativeReader:{async read(){order.push('attest');return {workspace:'fixture'};}},
    async requestCapacity(request,native){order.push('request');assert.deepEqual(request,input);assert.equal(native.workspace,'fixture');return {state:'acknowledged',messageId:'capacity.r1',digest:'a'.repeat(64),leaseToken:'never-echo'};}});
  let c;try{c=await client(m.endpoint);const tools=await c.listTools();assert.deepEqual(tools.tools.map(t=>t.name),[CAPACITY_TOOL]);
    const result=await c.callTool({name:CAPACITY_TOOL,arguments:input});assert.deepEqual(order,['attest','request']);assert.equal(result.structuredContent.scope,'capacity-request-receipt-only');assert.ok(!JSON.stringify(result).includes('never-echo'));
    const invalid=await c.callTool({name:CAPACITY_TOOL,arguments:{...input,source:'https://evil'}});assert.equal(invalid.isError,true);assert.deepEqual(order,['attest','request']);
  }finally{await c?.close();await m.close();}
});
test('private ingress rejects missing token, rebinding host, foreign origin, oversize and alternate routes',async()=>{
  let calls=0;const m=await startCapacityMcpServer({token,nativeReader:{async read(){calls++;throw new Error();}},requestCapacity:()=>{calls++;}});
  try{assert.equal((await fetch(m.endpoint)).status,401);
    for(const headers of [{host:'evil.example'},{origin:'https://evil.example'}]) {
      const status=await new Promise((resolve,reject)=>{const q=http.request(m.endpoint,{method:'POST',headers:{...headers,authorization:'Bearer '+token,'content-length':'2'}},r=>{r.resume();r.once('end',()=>resolve(r.statusCode));});q.once('error',reject);q.end('{}');});
      assert.equal(status,403);
    }
    assert.equal((await fetch(m.endpoint,{method:'POST',headers:{authorization:'Bearer '+token},body:'x'.repeat(17000)})).status,413);
    assert.equal((await fetch(m.endpoint+'?other=1')).status,404);assert.equal(calls,0);
  }finally{await m.close();}
});
test('native attestation failure blocks enqueue and errors never disclose original secrets',async()=>{
  let calls=0;const m=await startCapacityMcpServer({token,nativeReader:{async read(){throw new Error('private-worker-token');}},requestCapacity:()=>{calls++;}});
  let c;try{c=await client(m.endpoint);const result=await c.callTool({name:CAPACITY_TOOL,arguments:input});assert.equal(result.isError,true);assert.equal(calls,0);assert.ok(!JSON.stringify(result).includes('private-worker-token'));}finally{await c?.close();await m.close();}
});
test('native reader binds worker workspace, encrypted archive and compatibility with bounded private reads',async()=>{
  const compatibility={applicationVersion:'3.46.0',snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1};
  let status={mode:'worker',state:'ready',workspace:'test',archiveSha256:'a'.repeat(64)},info={workerCompatibility:compatibility};
  const urls=[];const reader=createNativeWorkerReader({origin:'http://127.0.0.1:4999',token,workspace:'test',archiveSha256:'a'.repeat(64),compatibility,
    async fetchImpl(url,options){urls.push(url);assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer '+token);return Response.json(url.includes('/status')?status:info);}});
  assert.equal((await reader.read()).workspace,'test');assert.equal(urls.length,2);
  status={...status,workspace:'forged'};await assert.rejects(reader.read(),{code:'NATIVE_UNAVAILABLE'});
  status={...status,workspace:'test'};info={workerCompatibility:{...compatibility,revision:'b'.repeat(40)}};await assert.rejects(reader.read(),{code:'NATIVE_UNAVAILABLE'});
  assert.throws(()=>createNativeWorkerReader({origin:'http://localhost:4999',token,workspace:'test',archiveSha256:'a'.repeat(64),compatibility}),{code:'INVALID'});
});
