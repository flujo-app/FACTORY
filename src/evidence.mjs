import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readdirSync } from 'node:fs';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { FactoryArtifactStore, contentDigest, sha256 } from './workflows/artifacts.mjs';
import { captureWorkspace, verifyWorkspaceArtifacts, readWorkspaceManifest, materializeWorkspace } from './workflows/workspace.mjs';

const identifier = value => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value ?? '')) throw new TypeError('Invalid evidence identity.'); return value; };
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
function durable(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const fd = openSync(path + '.next', 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(path + '.next', path);
}
function validateCheckpoint(store, value, scope) {
  if (value.schemaVersion !== 1 || value.runId !== scope.runId || value.machineId !== scope.machineId || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.final !== 'boolean' || !Array.isArray(value.roots) || !value.roots.length) throw new Error('Invalid evidence checkpoint scope.');
  const labels = new Set();
  const manifests=new Map();
  for (const root of value.roots) { identifier(root.name); if (labels.has(root.name)) throw new Error('Duplicate evidence root.'); labels.add(root.name); manifests.set(root.name,verifyWorkspaceArtifacts(store, root.ref)); }
  if (!Array.isArray(value.sessions) || new Set(value.sessions.map(s => s.agentId)).size !== value.sessions.length) throw new Error('Invalid session census.');
  for (const session of value.sessions) {
    identifier(session.agentId); identifier(session.threadId);
    if (!session.agentId.startsWith(scope.machineId + '-')) throw new Error('Foreign session in machine evidence.');
  }
  if (value.final && (!value.sessions.length || value.sessions.some(s => typeof s.stopId !== 'string' || !s.stopId))) throw new Error('Final evidence requires the stopped original session census.');
  if(value.final)for(const session of value.sessions){
    if(!session.evidence || !manifests.get(session.evidence.root)?.files.some(file=>file.path===session.evidence.path && file.size>0))throw new Error('Final evidence is missing an original session transcript.');
  }
  return value;
}

/** A durable private archive receiver. Run separately from worker volumes; tokens are scoped per run/machine. */
export async function startEvidenceServer({ directory, tokens, host = '127.0.0.1', port = 0 }) {
  if (!isAbsolute(directory ?? '') || !Array.isArray(tokens) || !tokens.length) throw new TypeError('Private archive directory and scoped credentials are required.');
  for (const scope of tokens) { identifier(scope.runId); identifier(scope.machineId); if (typeof scope.token !== 'string' || scope.token.length < 32) throw new Error('Use a strong archive credential.'); }
  if (new Set(tokens.map(s => s.token)).size !== tokens.length) throw new Error('Archive credentials must be unique per machine.');
  if(new Set(tokens.map(s=>s.runId+'\0'+s.machineId)).size!==tokens.length)throw new Error('Configure one credential per run/machine scope.');
  const stores=new Map(tokens.map(scope=>[scope.runId,new FactoryArtifactStore(resolve(directory,'runs',scope.runId,'objects'))]));
  const checkpoints = resolve(directory,'checkpoints'); mkdirSync(checkpoints,{recursive:true,mode:0o700});
  // Teams in one run share content-addressed evidence. Different runs have isolated stores.
  const scopes = new Map(tokens.map(scope => { const path = resolve(checkpoints, `${scope.runId}.${scope.machineId}.json`); return [scope.token, { ...scope, store:stores.get(scope.runId), path, journal: existsSync(path) ? JSON.parse(readFileSync(path)) : { receipts: [] } }]; }));
  let queue = Promise.resolve();
  const server = createServer((request,response) => {
    const operation = async () => {
      const token = request.headers.authorization?.replace(/^Bearer /,'');
      const scope = [...scopes.values()].find(s => equal(token,s.token));
      const send = (status,body) => { response.writeHead(status,{'Content-Type':'application/json'}); response.end(JSON.stringify(body)); };
      if (!scope) { send(401,{error:'Unauthorized archive scope.'}); return; }
      const store=scope.store;
      try {
        const path = new URL(request.url,'http://localhost').pathname;
        if(path==='/identity' && request.method==='GET'){send(200,{runId:scope.runId,machineId:scope.machineId});return;}
        if(path==='/missing' && request.method==='POST'){
          let body='';for await(const chunk of request){body+=chunk;if(body.length>40000)throw new Error('Too many object references.');}
          const refs=JSON.parse(body).refs;if(!Array.isArray(refs)||refs.length>512)throw new Error('Supply at most 512 references.');
          const missing=refs.filter(ref=>!existsSync(store.path(ref)));send(200,{missing});return;
        }
        const ref = path.startsWith('/objects/') ? 'sha256:' + path.slice(9) : null;
        if (ref) {
          store.path(ref);
          if (request.method === 'HEAD') {
            if (!existsSync(store.path(ref))) { send(404,{}); return; }
            const description = store.describe(ref); response.writeHead(200,{'Content-Length':description.size,'X-Content-SHA256':ref.slice(7)}); response.end(); return;
          }
          if (request.method === 'PUT') {
            const chunks=[]; let size=0;
            for await (const chunk of request) { size+=chunk.length; if (size>64*1024*1024) throw new Error('Metadata object exceeds 64 MiB; split the workspace into smaller roots.'); chunks.push(chunk); }
            const bytes=Buffer.concat(chunks); if ('sha256:'+sha256(bytes)!==ref) throw new Error('Uploaded checksum differs.');
            const receipt=store.put(bytes);
            send(200,receipt); return;
          }
          if (request.method === 'GET' && existsSync(store.path(ref))) { const bytes=store.get(ref); response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length}); response.end(bytes); return; }
        }
        if (path === '/checkpoints' && request.method === 'POST') {
          let body=''; for await (const chunk of request) { body+=chunk; if(Buffer.byteLength(body)>1024*1024)throw new Error('Checkpoint is too large.'); }
          const checkpoint=JSON.parse(body);
          validateCheckpoint(store,checkpoint,scope);
          const digest=contentDigest(checkpoint), previous=scope.journal.receipts.find(r=>r.checkpoint.sequence===checkpoint.sequence);
          if(previous && previous.digest!==digest)throw new Error('Checkpoint sequence has different bytes.');
          if(!previous && (scope.journal.receipts.at(-1)?.checkpoint.final || checkpoint.sequence !== (scope.journal.receipts.at(-1)?.checkpoint.sequence??0)+1))throw new Error('Reconcile the original checkpoint sequence.');
          const receipt=previous??{schemaVersion:1,digest,checkpoint,verifiedAt:new Date().toISOString()};
          if(!previous){scope.journal.receipts.push(receipt);durable(scope.path,scope.journal);}
          send(200,receipt);return;
        }
        if(path==='/checkpoints/latest' && request.method==='GET') {
          const receipt=scope.journal.receipts.at(-1); if(!receipt){send(404,{error:'No checkpoint.'});return;}
          validateCheckpoint(store,receipt.checkpoint,scope); // Verify retained bytes again before authorizing shutdown.
          if(receipt.digest!==contentDigest(receipt.checkpoint))throw new Error('Checkpoint receipt is corrupt.');
          send(200,receipt);return;
        }
        send(404,{error:'Archive object not found.'});
      } catch(error) { send(409,{error:error.message}); }
    };
    queue=queue.then(operation,operation).catch(()=>{response.destroy();});
  });
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,host,accept);});
  return { url:`http://${host.includes(':')?'['+host+']':host}:${server.address().port}`,stores,close:()=>new Promise((accept,reject)=>server.close(error=>error?reject(error):accept())) };
}

export function createEvidenceClient({ url, token, fetch: transport = globalThis.fetch }) {
  const parsed=new URL(url);
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || typeof token!=='string' || token.length<32)throw new TypeError('Use an authenticated archive endpoint.');
  if(parsed.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) && !parsed.hostname.endsWith('.internal'))throw new TypeError('Remote evidence transport requires HTTPS.');
  const request=async(path,options={})=>{
    let response;
    try{response=await transport(url.replace(/\/$/,'')+path,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers},redirect:'error',signal:AbortSignal.timeout(30000)});}
    catch(cause){throw Object.assign(new Error('Archive delivery is unconfirmed; retain the original checkpoint for retry.',{cause}),{code:'EVIDENCE_PENDING'});}
    if(!response.ok && response.status!==404)throw Object.assign(new Error(`Archive request failed (${response.status}); retain the original checkpoint for retry.`),{code:response.status>=500?'EVIDENCE_PENDING':'EVIDENCE_REJECTED'});
    return response;
  };
  return {
    async identity(){return(await request('/identity')).json();},
    async missing(refs){const response=await request('/missing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refs})});const result=await response.json();if(!Array.isArray(result.missing)||result.missing.some(ref=>!refs.includes(ref)))throw new Error('Invalid archive object inventory.');return result.missing;},
    async upload(ref,bytes) {
      if('sha256:'+sha256(bytes)!==ref)throw new Error('Local evidence checksum differs.');
      const path='/objects/'+ref.slice(7), known=await request(path,{method:'HEAD'});
      if(known.ok){if(Number(known.headers.get('content-length'))!==bytes.length || known.headers.get('x-content-sha256')!==ref.slice(7))throw new Error('Remote evidence identity differs.');return;}
      const response=await request(path,{method:'PUT',body:bytes});const receipt=await response.json();
      if(receipt.ref!==ref || receipt.size!==bytes.length)throw new Error('Upload acknowledgement differs.');
    },
    async commit(checkpoint) {
      const response=await request('/checkpoints',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(checkpoint)});
      const receipt=await response.json();if(receipt.digest!==contentDigest(checkpoint) || contentDigest(receipt.checkpoint)!==receipt.digest)throw new Error('Checkpoint acknowledgement differs.');return receipt;
    },
    async latest(){const response=await request('/checkpoints/latest');if(response.status===404)return null;const receipt=await response.json();if(receipt.digest!==contentDigest(receipt.checkpoint))throw new Error('Invalid archive receipt.');return receipt;},
    async download(ref){const response=await request('/objects/'+ref.slice(7));if(!response.ok)throw new Error('Missing archive object.');const bytes=Buffer.from(await response.arrayBuffer());if('sha256:'+sha256(bytes)!==ref)throw new Error('Downloaded checksum differs.');return bytes;},
  };
}

/** No model calls. Pending immutable checkpoints survive unknown upload outcomes and process restarts. */
export class ContinuousEvidenceCollector {
  constructor({ directory, runId, machineId, roots, client, intervalMs = 60000, sessions = () => [], beforeCapture = async () => {}, afterCheckpoint = async () => {}, onEvent = () => {} }) {
    if(!isAbsolute(directory??'') || !Array.isArray(roots) || !roots.length || !Number.isSafeInteger(intervalMs) || intervalMs<1000)throw new TypeError('Configure private collector storage, roots and a positive interval.');
    identifier(runId);identifier(machineId);for(const root of roots){identifier(root.name);if(!isAbsolute(root.path))throw new Error('Evidence roots must be absolute.');}
    this.directory=directory;this.store=new FactoryArtifactStore(resolve(directory,'objects'));this.path=resolve(directory,'state.json');
    const policy=contentDigest(roots.map(root=>({name:root.name,path:root.path,paths:root.paths??['.'],exclude:root.exclude??[]})));
    this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path)):{runId,machineId,sequence:0,policy};
    if(this.state.runId!==runId||this.state.machineId!==machineId)throw new Error('Collector identity differs.');
    if(this.state.policy!==policy)throw new Error('Retain original collection roots and exclusion policy on recovery.');
    for(const root of roots){
      const privatePath=relative(root.path,directory).split(sep).join('/');
      if(!privatePath)throw new Error('Collector storage cannot be an evidence root.');
      if(!privatePath.startsWith('../')&&!isAbsolute(privatePath))root.exclude=[...(root.exclude??[]),privatePath];
    }
    Object.assign(this,{runId,machineId,roots,client,intervalMs,sessions,beforeCapture,afterCheckpoint,onEvent});
  }
  save(){durable(this.path,this.state);}
  async flushPending(){
    const pending=this.state.pending;if(!pending)return this.state.receipt;
    const refs=new Set();
    for(const root of pending.roots){
      const manifest=verifyWorkspaceArtifacts(this.store,root.ref);
      for(const file of manifest.files)for(const chunk of file.chunks)refs.add(chunk.ref);
      refs.add(root.ref);
    }
    const objects=[...refs];
    for(let offset=0;offset<objects.length;offset+=512){const batch=objects.slice(offset,offset+512);for(const ref of await this.client.missing(batch))await this.client.upload(ref,this.store.get(ref));}
    const receipt=await this.client.commit(pending);this.state.sequence=pending.sequence;this.state.receipt=receipt;delete this.state.pending;this.save();
    this.onEvent({type:'evidence.acknowledged',sequence:pending.sequence,final:pending.final,digest:receipt.digest});await this.afterCheckpoint(receipt);return receipt;
  }
  async checkpoint({final=false}={}){
    if(this.busy){await this.busy;return final?this.checkpoint({final}):this.state.receipt;}
    this.busy=(async()=>{
      await this.flushPending();if(this.state.receipt?.checkpoint.final)return this.state.receipt;
      await this.beforeCapture();const roots=[];
      for(const root of this.roots){root.cache??=new Map();const captured=captureWorkspace(this.store,root.path,{paths:root.paths??['.'],exclude:root.exclude??[],cache:final?new Map():root.cache});roots.push({name:root.name,ref:captured.source.snapshot});}
      const sessions=this.sessions().map(session=>{
        if(!final || session.evidence)return session;
        const root=roots.find(root=>root.name==='sessions');
        const file=root && verifyWorkspaceArtifacts(this.store,root.ref).files.find(file=>file.path.includes(session.threadId) && file.size>0);
        return {...session,...(file?{evidence:{root:'sessions',path:file.path}}:{})};
      });
      const checkpoint={schemaVersion:1,runId:this.runId,machineId:this.machineId,sequence:this.state.sequence+1,final,roots,sessions,capturedAt:new Date().toISOString()};
      validateCheckpoint(this.store,checkpoint,this);this.state.pending=checkpoint;this.save();return this.flushPending();
    })();
    try{return await this.busy;}finally{this.busy=null;}
  }
  start(){
    if(this.loop)return this;
    this.stopping=false;this.loop=(async()=>{
      while(!this.stopping && !this.state.receipt?.checkpoint.final){
        try{await this.checkpoint();}catch(error){this.onEvent({type:'evidence.pending',error:error.message});}
        if(!this.stopping)await new Promise(accept=>{this.wake=accept;this.timer=setTimeout(accept,this.intervalMs);});
      }
    })();return this;
  }
  async stop({final=false}={}){this.stopping=true;clearTimeout(this.timer);this.wake?.();await this.loop;return final?this.checkpoint({final:true}):this.state.receipt;}
  async pruneAcknowledged({remove}){
    if(typeof remove!=='function'||!this.state.receipt)throw new Error('A verified checkpoint and explicit cleanup adapter are required.');
    const keep=new Set();
    for(const checkpoint of [this.state.receipt.checkpoint,this.state.pending].filter(Boolean))for(const root of checkpoint.roots){
      keep.add(root.ref.slice(7));for(const file of verifyWorkspaceArtifacts(this.store,root.ref).files)for(const chunk of file.chunks)keep.add(chunk.ref.slice(7));
    }
    const paths=readdirSync(this.store.directory).filter(name=>/^[a-f0-9]{64}$/.test(name)&&!keep.has(name)).map(name=>'objects/'+name);
    if(paths.length){
      await remove(paths);
      for(const root of this.roots)for(const [name,value]of root.cache??[])if(value.file.chunks.some(chunk=>!keep.has(chunk.ref.slice(7))))root.cache.delete(name);
    }
    return{removed:paths.length};
  }
}

/** Restore a retained run's exact selected files without needing the original machines or Git. */
export async function restoreEvidenceCheckpoint({client,receipt,directory}) {
  if(!isAbsolute(directory??'') || receipt.digest!==contentDigest(receipt.checkpoint))throw new TypeError('Select an absolute restore directory and valid checkpoint.');
  const store=new FactoryArtifactStore(resolve(directory,'objects'));
  for(const root of receipt.checkpoint.roots){
    identifier(root.name);const manifest=await client.download(root.ref);if(store.put(manifest).ref!==root.ref)throw new Error('Manifest mismatch.');
    for(const ref of new Set(readWorkspaceManifest(store,root.ref).files.flatMap(file=>file.chunks.map(chunk=>chunk.ref)))){
      if(!existsSync(store.path(ref))){const bytes=await client.download(ref);if(store.put(bytes).ref!==ref)throw new Error('Restored object mismatch.');}
    }
    materializeWorkspace(store,root.ref,resolve(directory,'roots',root.name));
  }
  durable(resolve(directory,'receipt.json'),receipt);return{directory,roots:receipt.checkpoint.roots.map(root=>({name:root.name,path:resolve(directory,'roots',root.name)}))};
}
