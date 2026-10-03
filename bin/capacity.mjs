#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { PeerStore } from '../src/peer-messaging.mjs';
import { startPeerServer, dispatchPeerMessage } from '../src/peer-gateway.mjs';
import { issueCapacityGrant, enqueueCapacityRequest, interpretCapacityRequest } from '../src/capacity-bridge.mjs';
import { startCapacityMcpServer, createNativeWorkerReader } from '../src/capacity-mcp.mjs';
import { createManagedCloudAdapter } from '../src/adapters/managed-cloud.mjs';
const print=v=>process.stdout.write(JSON.stringify(v)+'\n');
function require(condition){if(!condition){const e=new Error('CAPACITY_CONFIG');e.code='CAPACITY_CONFIG';throw e;}}
const [command,...rest]=process.argv.slice(2),flags={};
let store,control,paid,server,mcp;
try{
  require(['issue','tool','broker'].includes(command));
  for(let i=0;i<rest.length;i+=2){const k=rest[i],v=rest[i+1];require(['--private-module','--profile'].includes(k)&&v&&!Object.hasOwn(flags,k));flags[k]=v;}
  for(const k of ['--private-module','--profile'])require(path.isAbsolute(flags[k]??''));
  const privateFiles=await import(pathToFileURL(flags['--private-module']).href);
  for(const k of ['readPrivateJson','writePrivateJson','assertPrivateDirectory'])require(typeof privateFiles[k]==='function');
  const profile=await privateFiles.readPrivateJson(flags['--profile']);
  const common=['peerConfigFile','peerDatabase','grantFile'];
  const fields={issue:[...common,'controlDatabase','outputFile'],tool:[...common,'mcpTokenFile','nativeOrigin','nativeTokenFile','port'],
    broker:[...common,'controlDatabase','spendingDatabase','managedModule','managedOptions','host','port','pollMs','tlsFile']}[command];
  require(profile&&Object.keys(profile).every(k=>fields.includes(k))&&common.every(k=>path.isAbsolute(profile[k]??'')));
  for(const k of fields.filter(k=>/File$|Database$|Module$/.test(k))){if(k==='tlsFile'&&!Object.hasOwn(profile,k))continue;require(path.isAbsolute(profile[k]??''));}
  await privateFiles.assertPrivateDirectory(path.dirname(profile.peerDatabase));
  const peerConfig=await privateFiles.readPrivateJson(profile.peerConfigFile),grant=await privateFiles.readPrivateJson(profile.grantFile);
  store=new PeerStore(profile.peerDatabase,{config:peerConfig});
  async function existingDatabase(filename){await privateFiles.assertPrivateDirectory(path.dirname(filename));const stat=await fs.lstat(filename);require(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1);}
  if(command==='issue'){
    await existingDatabase(profile.controlDatabase);control=new FactoryControl(profile.controlDatabase);
    const issued=issueCapacityGrant({control,store,grant});
    await privateFiles.assertPrivateDirectory(path.dirname(profile.outputFile));
    await privateFiles.writePrivateJson(profile.outputFile,issued.policy,{exclusive:true});
    print({issued:true,grantId:issued.policy.grantId,scope:'private-standing-capacity-grant'});
  }else if(command==='tool'){
    require(Number.isInteger(profile.port)&&profile.port>0&&profile.port<=65535&&grant.native);
    const token=await privateFiles.readPrivateJson(profile.mcpTokenFile),nativeToken=await privateFiles.readPrivateJson(profile.nativeTokenFile);
    require(Object.keys(token).join(',')==='token'&&Object.keys(nativeToken).join(',')==='token');
    const nativeReader=createNativeWorkerReader({origin:profile.nativeOrigin,token:nativeToken.token,...grant.native});
    mcp=await startCapacityMcpServer({token:token.token,port:profile.port,nativeReader,async requestCapacity(request,nativeProof){
      const outbox=enqueueCapacityRequest({store,grant,request,nativeProof});
      return dispatchPeerMessage({store,messageId:outbox.messageId});
    }});
    print({ready:true,endpoint:mcp.endpoint,scope:'native-capacity-request-tool'});
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  }else{
    require(Number.isInteger(profile.port)&&profile.port>0&&profile.port<=65535&&Number.isInteger(profile.pollMs)&&profile.pollMs>=250&&profile.pollMs<=30000);
    require(profile.managedOptions&&typeof profile.managedOptions==='object'&&!Array.isArray(profile.managedOptions));
    await existingDatabase(profile.controlDatabase);await existingDatabase(profile.spendingDatabase);
    control=new FactoryControl(profile.controlDatabase);paid=new SpendingLedger(profile.spendingDatabase);
    const adapter=await createManagedCloudAdapter({modulePath:profile.managedModule,options:profile.managedOptions});
    const tls=profile.tlsFile?await privateFiles.readPrivateJson(profile.tlsFile):undefined;
    if(tls)require(Object.keys(tls).sort().join(',')==='cert,key'&&typeof tls.key==='string'&&typeof tls.cert==='string');
    server=await startPeerServer({store,host:profile.host,port:profile.port,tls});
    let stopped=false,after=0;
    process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
    print({ready:true,scope:'standing-grant-capacity-broker'});
    while(!stopped){const rows=store.inbox({after,limit:100});
      for(const row of rows){if(stopped)break;try{
        const result=await interpretCapacityRequest({control,store,grant,messageId:row.message_id,adapter,paidAdmission:paid});
        print({messageId:row.message_id,dispatched:result.dispatched,effectKey:result.effect?.key??null,state:result.effect?.state??null,scope:'capacity-admission-result'});
      }catch(error){const code=/^[A-Z_]{1,48}$/.test(error?.code??'')?error.code:'CAPACITY_REJECTED';print({messageId:row.message_id,dispatched:false,error:{code}});}
      after=row.sequence;}
      if(!stopped&&rows.length<100)await delay(profile.pollMs);
    }
  }
}catch(error){const code=/^[A-Z_]{1,48}$/.test(error?.code??'')?error.code:'CAPACITY_UNAVAILABLE';print({error:{code}});process.exitCode=1;}
finally{
  await mcp?.close();if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  store?.close();control?.close();paid?.close();
}
