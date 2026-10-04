import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
// Independent trusted fixture inputs; never created by observing the SDK request.
export function fixedWireCommitment() {
  const model = {id:'communityai-offline-fixture',name:'sha256:'+'1'.repeat(64),provider:'openai',adapter:'openai',
    baseUrl:'https://communityai.invalid/v1',ownerCredentialBinding:{ownerId:'factory-original-fixture',credentialId:'communityai-fixture'}};
  const headers = [
    ['accept','application/json'],['content-type','application/json'],['user-agent','OpenAI/JS 7.3.0'],
    ['x-stainless-arch','x64'],['x-stainless-lang','js'],['x-stainless-os','Windows'],
    ['x-stainless-package-version','7.3.0'],['x-stainless-retry-count','0'],['x-stainless-runtime','node'],
    ['x-stainless-runtime-version','v24.19.0']
  ];
  // SDK7.3.0 buildHeaders receives inputOptions, not the copy with the default
  // client timeout. FLUJO specifies no request-level timeout, so no timeout header.
  const bodyUtf8 = '{"model":"sha256:'+ '1'.repeat(64) +'","messages":[{"role":"user","content":"offline bridge fixture"}],"temperature":1,"stream":true,"max_tokens":8,"stream_options":{"include_usage":true}}';
  return {format:'factory-flujo-openai-sdk-wire-v1',mode:'trusted-fixture-only',taskId:'offline-task',startNonce:'offline-start-1',
    parentId:'offline-parent',slotId:'model-node:0',requestId:'offline-request-1',nonce:'offline-step-1',
    credentialGeneration:'fixture-generation-1',leaseExpires:20000,wire:{version:2,operation:'chat.completions.create(stream)',model,
      method:'POST',url:'https://communityai.invalid/v1/chat/completions',headers,bodyUtf8,bodySha256:sha(bodyUtf8),
      headersSha256:sha(JSON.stringify(headers)),routingHeaderSha256:{openaiOrganization:null,openaiProject:null,httpReferer:null,xTitle:null}}};
}
export function fixedWireProjection(commitment = fixedWireCommitment()) {
  const {bodyUtf8,...wire} = structuredClone(commitment.wire);
  return {...wire,body:Uint8Array.from(Buffer.from(bodyUtf8,'utf8'))};
}
