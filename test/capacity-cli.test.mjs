import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { PeerStore, createPairConfigurations } from '../src/peer-messaging.mjs';
const helper=process.env.FACTORY_PEER_PRIVATE_TEST_MODULE??'C:/Users/Moe/Documents/GitHub/flujo-cloud/lib/private-files.mjs';
const cli=fileURLToPath(new URL('../bin/capacity.mjs',import.meta.url));
async function listen(s){await new Promise(r=>s.listen(0,'127.0.0.1',r));return s.address().port;}
async function port(){const s=http.createServer(),p=await listen(s);await new Promise(r=>s.close(r));return p;}
function child(command,profile){const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(k)));
  const c=spawn(process.execPath,[cli,command,'--private-module',helper,'--profile',profile],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  c.stdout.on('data',b=>{stdout+=b.toString();});c.stderr.on('data',b=>{stderr+=b.toString();});
  const closed=new Promise((resolve,reject)=>{c.once('error',reject);c.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
  return {c,closed,get stdout(){return stdout;},async ready(){const deadline=Date.now()+20000;while(Date.now()<deadline){if(stdout.includes('"ready":true'))return;if(c.exitCode!==null)throw new Error('CLI failed: '+stdout);await delay(25);}throw new Error('CLI startup deadline');},async stop(){if(c.exitCode===null)c.kill('SIGTERM');return closed;}};
}
test('actual issue/tool/broker CLIs connect private MCP to authenticated peers and refuse fully held paid capacity', {timeout:90000},async t=>{
  if(!await fs.access(helper).then(()=>true,()=>false)){t.skip('Explicit owner-private helper unavailable');return;}
  const files=await import(pathToFileURL(helper).href),base=await fs.mkdtemp(path.join(os.tmpdir(),'factory-capacity-cli-')),dir=path.join(base,'private');
  await files.ensurePrivateDirectory(dir);const p=n=>path.join(dir,n),children=[];let control,paid,native,c;
  t.after(async()=>{await c?.close();for(const child of children)await child.stop();if(native)await new Promise(r=>{native.close(r);native.closeAllConnections();});control?.close();paid?.close();
    assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep+'factory-capacity-cli-'));await fs.rm(base,{recursive:true,force:true});});
  const brokerPort=await port(),toolPort=await port(),now=Date.now(),token='t'.repeat(64),nativeToken='n'.repeat(64);
  const pair=createPairConfigurations({a:{identity:{factoryId:'cli-fixture',cellId:'root'},endpoint:`http://127.0.0.1:${await port()}/v1/peer/messages`},b:{identity:{factoryId:'cli-fixture',cellId:'broker'},endpoint:`http://127.0.0.1:${brokerPort}/v1/peer/messages`},credentialExpiresAt:now+120000});
  await files.writePrivateJson(p('sender.json'),pair.a,{exclusive:true});await files.writePrivateJson(p('receiver.json'),pair.b,{exclusive:true});
  const receiver=new PeerStore(p('receiver.sqlite'),{config:pair.b});receiver.close();
  const sender=new PeerStore(p('sender.sqlite'),{config:pair.a});sender.close();
  control=new FactoryControl(p('control.sqlite'));control.initialize({mission:'CLI acceptance',budgetCents:10000,maxCells:4,maxDepth:2});
  control.createTask({taskId:'t',projectId:'fixture',branch:'codex/cli',specification:{problem:'Capacity',acceptance:['No unpaid cloud call'],baseline:'fixture'}});
  const lease=control.claimTask('t','root',100000),compatibility={applicationVersion:'3.46.0',snapshotFormatVersion:2,layoutVersion:2,workerProtocolVersion:1},nativeIdentity={workspace:'fixture',archiveSha256:'b'.repeat(64),compatibility};
  const grant={schemaVersion:1,grantId:'g',generation:1,lease,expiresAt:lease.expires,maxChildren:2,maxBudgetCents:1000,allowedRoles:['developer'],native:nativeIdentity,
    template:{source:'http://127.0.0.1:4200',workspace:'fixture',image:'registry.invalid/test@sha256:'+'a'.repeat(64),org:'synthetic',region:'iad',appPrefix:'cli-fixture',flowIds:['fixture']},paid:{provider:'fly',ceilingCents:500}};
  await files.writePrivateJson(p('grant.json'),grant,{exclusive:true});
  paid=new SpendingLedger(p('paid.sqlite'));paid.initialize({limitCents:10000,currency:'USD'});paid.reserve({reservationId:'fully-held',provider:'fly',ceilingCents:10000});
  if(process.platform!=='win32')for(const name of ['receiver.sqlite','sender.sqlite','control.sqlite','paid.sqlite'])for(const suffix of ['','-wal','-shm']){
    await fs.chmod(p(name+suffix),0o600).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  await files.writePrivateJson(p('issue.json'),{peerConfigFile:p('receiver.json'),peerDatabase:p('receiver.sqlite'),grantFile:p('grant.json'),controlDatabase:p('control.sqlite'),outputFile:p('policy.json')},{exclusive:true});
  const issued=child('issue',p('issue.json'));children.push(issued);const issueResult=await issued.closed;assert.equal(issueResult.code,0);assert.equal(JSON.parse(issueResult.stdout).issued,true);assert.ok(!issueResult.stdout.includes(lease.token)&&!issueResult.stdout.includes(pair.a.key));
  const managed=p('managed.mjs');await fs.writeFile(managed,"import fs from 'node:fs';export class ManagedCloud {constructor(o){this.o=o;}async sources(){return [];}async preflight(){throw new Error('Forbidden');}async up(){fs.writeFileSync(this.o.callsFile,'unexpected');throw new Error('Forbidden');}async call(){throw new Error('Forbidden');}async list(){return [];}async down(){throw new Error('Forbidden');}}\n");
  await files.writePrivateJson(p('broker.json'),{peerConfigFile:p('receiver.json'),peerDatabase:p('receiver.sqlite'),grantFile:p('grant.json'),controlDatabase:p('control.sqlite'),spendingDatabase:p('paid.sqlite'),managedModule:managed,managedOptions:{callsFile:p('calls.txt')},host:'127.0.0.1',port:brokerPort,pollMs:250},{exclusive:true});
  native=http.createServer((q,s)=>{assert.equal(q.headers.authorization,'Bearer '+nativeToken);s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify(q.url==='/api/worker/status'?{mode:'worker',state:'ready',workspace:'fixture',archiveSha256:nativeIdentity.archiveSha256}:{workerCompatibility:compatibility}));});
  const nativePort=await listen(native);await files.writePrivateJson(p('mcp-token.json'),{token},{exclusive:true});await files.writePrivateJson(p('native-token.json'),{token:nativeToken},{exclusive:true});
  await files.writePrivateJson(p('tool.json'),{peerConfigFile:p('sender.json'),peerDatabase:p('sender.sqlite'),grantFile:p('policy.json'),mcpTokenFile:p('mcp-token.json'),nativeOrigin:`http://127.0.0.1:${nativePort}`,nativeTokenFile:p('native-token.json'),port:toolPort},{exclusive:true});
  const broker=child('broker',p('broker.json')),tool=child('tool',p('tool.json'));children.push(broker,tool);await broker.ready();await tool.ready();
  c=new Client({name:'cli-test',version:'1'},{capabilities:{}});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${toolPort}/mcp`),{requestInit:{headers:{authorization:'Bearer '+token}}}));
  const input={requestId:'r1',role:'developer',budgetCents:500,purpose:'Investigate a FLUJO branch'};
  const result=await c.callTool({name:'factory_capacity_request',arguments:input});assert.equal(result.structuredContent.state,'acknowledged');
  const deadline=Date.now()+10000;let effects=[];while(Date.now()<deadline){effects=control.db.prepare("SELECT key,state FROM effects WHERE kind='provision'").all();if(effects[0]?.state==='not_applied')break;await delay(25);}
  assert.equal(effects.length,1);assert.equal(effects[0].state,'not_applied');assert.equal(await fs.access(p('calls.txt')).then(()=>true,()=>false),false);
  const conflict=await c.callTool({name:'factory_capacity_request',arguments:{...input,budgetCents:400}});assert.equal(conflict.isError,true);
  assert.equal(control.db.prepare("SELECT count(*) n FROM effects").get().n,1);
  assert.ok(!broker.stdout.includes(lease.token)&&!tool.stdout.includes(pair.a.key)&&!tool.stdout.includes(token));
});
