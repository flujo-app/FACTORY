import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const CAPACITY_TOOL = 'factory_capacity_request';
const LIMIT = 16 * 1024;
const SAFE_ERRORS = new Set(['INVALID','CONFLICT','PAUSED','BUDGET','CAPACITY','STALE','AUTHORITY',
  'CREDENTIAL_GENERATION','CREDENTIAL_EXPIRED','GRANT','GRANT_EXPIRED','NATIVE_UNAVAILABLE']);
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function object(v) { return v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v)); }
function args(v) {
  if (!object(v) || Object.keys(v).sort().join(',') !== 'budgetCents,purpose,requestId,role'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v.requestId ?? '')
    || !['developer','verifier','watcher','coordinator'].includes(v.role)
    || !Number.isSafeInteger(v.budgetCents) || v.budgetCents < 1
    || typeof v.purpose !== 'string' || !v.purpose.trim() || v.purpose.length > 512) fail('INVALID');
  return structuredClone(v);
}
export const capacityToolDefinition = Object.freeze({
  name: CAPACITY_TOOL,
  description: 'Request a child cell under this server’s private standing grant. A transport acknowledgement confirms receipt only; the factory separately decides admission and provisioning.',
  inputSchema: { type:'object', additionalProperties:false, required:['requestId','role','budgetCents','purpose'], properties:{
    requestId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'},
    role:{type:'string',enum:['developer','verifier','watcher','coordinator']},
    budgetCents:{type:'integer',minimum:1}, purpose:{type:'string',minLength:1,maxLength:512},
  } },
  annotations:{ readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:true },
});

/** Read-only bootstrap identity check. It confers no task, budget or dispatch authority. */
export function createNativeWorkerReader({ origin, token, workspace, archiveSha256, compatibility, fetchImpl=fetch }) {
  let url; try { url = new URL(origin); } catch { fail('INVALID'); }
  if (url.origin !== origin || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname))
    || typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)
    || typeof workspace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(workspace)
    || !/^[a-f0-9]{64}$/.test(archiveSha256 ?? '') || !object(compatibility)
    || !['applicationVersion','snapshotFormatVersion','layoutVersion','workerProtocolVersion'].every(k=>Object.hasOwn(compatibility,k))
    || Object.keys(compatibility).some(k=>!['applicationVersion','snapshotFormatVersion','layoutVersion','workerProtocolVersion','revision'].includes(k))) fail('INVALID');
  const expected = structuredClone(compatibility);
  async function json(route) {
    const response = await fetchImpl(origin+route,{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!response.ok || !response.body) fail('NATIVE_UNAVAILABLE');
    const chunks=[]; let bytes=0;
    try { for await (const part of response.body) { bytes+=part.length; if(bytes>64*1024)fail('NATIVE_UNAVAILABLE'); chunks.push(part); } }
    catch { await response.body.cancel().catch(()=>{}); fail('NATIVE_UNAVAILABLE'); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return Object.freeze({async read() {
    try {
      const status = await json('/api/worker/status');
      if (status.mode !== 'worker' || status.state !== 'ready' || status.workspace !== workspace || status.archiveSha256 !== archiveSha256) fail('NATIVE_UNAVAILABLE');
      const info = await json('/api/snapshot/info?workspace='+encodeURIComponent(workspace));
      const actual=info.workerCompatibility;
      if (!object(actual) || Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',')
        || Object.keys(expected).some(k=>actual[k]!==expected[k])) fail('NATIVE_UNAVAILABLE');
      return {workspace,archiveSha256,compatibility:structuredClone(expected)};
    } catch { fail('NATIVE_UNAVAILABLE'); }
  }});
}

/** Owner-private loopback capability. The callback handles durable advisory transport only. */
export async function startCapacityMcpServer({ token, port=0, requestCapacity, nativeReader }) {
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)
    || !Number.isInteger(port) || port<0 || port>65535 || typeof requestCapacity!=='function'
    || typeof nativeReader?.read!=='function') fail('INVALID');
  const expected=Buffer.from('Bearer '+token), active=new Set();
  const server=http.createServer({maxHeaderSize:8192},async (request,response)=>{
    response.setHeader('cache-control','no-store');
    response.setHeader('x-content-type-options','nosniff');
    const reject=(status,code)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify({error:{code}}));};
    const host='127.0.0.1:'+server.address().port;
    if (request.url!=='/mcp') return reject(404,'ROUTE');
    if (request.headers.host!==host || request.headers.origin && request.headers.origin!=='http://'+host) return reject(403,'ORIGIN');
    const supplied=Buffer.from(request.headers.authorization ?? '');
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected))return reject(401,'AUTHENTICATION');
    if(request.method!=='POST')return reject(405,'METHOD');
    const length=request.headers['content-length'];
    if(request.headers['transfer-encoding'] || !/^[1-9][0-9]{0,5}$/.test(length ?? '') || Number(length)>LIMIT)return reject(413,'BODY_LIMIT');
    let mcp,transport;
    try {
      const chunks=[];let count=0;
      for await(const part of request){count+=part.length;if(count>LIMIT){reject(413,'BODY_LIMIT');request.destroy();return;}chunks.push(part);}
      if(count!==Number(length))return reject(400,'BODY_LIMIT');
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(400,'INVALID');}
      mcp=new Server({name:'flujo-factory-capacity',version:'1.0.0'},{capabilities:{tools:{}}});
      mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[capacityToolDefinition]}));
      mcp.setRequestHandler(CallToolRequestSchema,async request=>{
        try {
          if(request.params.name!==CAPACITY_TOOL)fail('INVALID');
          const input=args(request.params.arguments);
          const native=await nativeReader.read();
          const result=await requestCapacity(input,native);
          // No lease, grant contents, endpoint, provider receipt or caller data is echoed.
          if (!object(result) || !['pending','acknowledged'].includes(result.state)
            || typeof result.messageId!=='string' || !/^[a-f0-9]{64}$/.test(result.digest ?? ''))fail('INVALID');
          const safe={state:result.state,messageId:result.messageId,digest:result.digest,scope:'capacity-request-receipt-only'};
          return {content:[{type:'text',text:JSON.stringify(safe)}],structuredContent:safe};
        } catch(error) {
          const code=SAFE_ERRORS.has(error?.code)?error.code:'CAPACITY_UNAVAILABLE';
          return {isError:true,content:[{type:'text',text:code}]};
        }
      });
      transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      active.add(mcp);
      response.once('close',()=>{active.delete(mcp);void mcp.close().catch(()=>{});});
      await mcp.connect(transport);
      await transport.handleRequest(request,response,body);
    } catch {
      if(!response.headersSent)reject(500,'CAPACITY_UNAVAILABLE');
      else response.destroy();
      if(mcp){active.delete(mcp);await mcp.close().catch(()=>{});}
    }
  });
  server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=1000;server.maxConnections=32;
  server.on('clientError',(_e,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,endpoint:`http://127.0.0.1:${server.address().port}/mcp`,async close(){
    await Promise.allSettled([...active].map(mcp=>mcp.close()));
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }};
}
