#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { startEvidenceServer } from '../src/evidence.mjs';
import { FactoryCloudLiteFleet, CodexSubscriptionBroker } from '../src/cloud-lite/fleet.mjs';

const [action,path]=process.argv.slice(2);
if(action==='--help'||action==='-h')console.log('Usage: factory-evidence <serve|supervise|shutdown> <private-config.json>\nserve: {directory,tokens:[{runId,machineId,token}],host?,port?}\nsupervise/shutdown: {directory,authFile?,flujoCloudPath?,options?}. Supervision uses the saved explicit deadline.');
else try{
  if(!['serve','supervise','shutdown'].includes(action)||!path)throw new Error('Use factory-evidence --help.');
  const config=JSON.parse(readFileSync(path,'utf8'));
  if(action==='serve'){
    const server=await startEvidenceServer(config);console.log(JSON.stringify({listening:server.url}));
    let closing;const stop=()=>closing??=server.close();process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  }else{
    const fleet=new FactoryCloudLiteFleet({...config,...(config.authFile?{auth:new CodexSubscriptionBroker({authFile:config.authFile})}:{})});
    const abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
    try{console.log(JSON.stringify(await(action==='shutdown'?fleet.verifiedShutdown(config.options):fleet.supervise({...config.options,signal:abort.signal}))));}
    finally{await fleet.disconnect();}
  }
}catch(error){console.error(error.message);process.exitCode=1;}
