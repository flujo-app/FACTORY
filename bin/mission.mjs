#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FactoryControl } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { createNativeMissionClient } from '../src/native-mission-client.mjs';
import { claimNativeMission,runNativeMission,observeNativeMission } from '../src/native-mission.mjs';

let control,paid;
function check(v){if(!v)throw Object.assign(new Error('Invalid private mission profile.'),{code:'NATIVE_MISSION_PROFILE'});}
function closed(v,keys){check(v && Object.getPrototypeOf(v)===Object.prototype && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k)));}
async function database(filename,privateFiles){check(path.isAbsolute(filename??''));await privateFiles.ensurePrivateDirectory(path.dirname(filename));const s=await fs.lstat(filename);check(s.isFile() && !s.isSymbolicLink() && s.nlink===1);}
try{
  const command=process.argv[2],args=process.argv.slice(3);check(['claim','run','observe'].includes(command) && args.length===4);
  const flags={};for(let i=0;i<args.length;i+=2){check(['--private-module','--profile'].includes(args[i]) && !Object.hasOwn(flags,args[i]) && path.isAbsolute(args[i+1]??''));flags[args[i]]=args[i+1];}
  const privateFiles=await import(pathToFileURL(flags['--private-module']).href);
  const p=await privateFiles.readPrivateJson(flags['--profile'],{maxBytes:65536});
  const fields={claim:['controlDatabase','client','taskId','outputFile','leaseFile','ttlMs'],run:['controlDatabase','spendingDatabase','client','leaseFile','outputFile'],observe:['controlDatabase','client','key']};closed(p,fields[command]);
  closed(p.client,['origin','tokenFile','worker','timeoutMs']);
  check(path.isAbsolute(p.client.tokenFile??''));const auth=await privateFiles.readPrivateJson(p.client.tokenFile,{maxBytes:4096});closed(auth,['token']);
  const client=createNativeMissionClient({...p.client.worker,origin:p.client.origin,token:auth.token,timeoutMs:p.client.timeoutMs});
  await database(p.controlDatabase,privateFiles);control=new FactoryControl(p.controlDatabase);
  let outcome;
  if(command==='claim'){
    check(path.isAbsolute(p.leaseFile??'') && path.isAbsolute(p.outputFile??''));await privateFiles.ensurePrivateDirectory(path.dirname(p.leaseFile));await privateFiles.ensurePrivateDirectory(path.dirname(p.outputFile));
    // Reserve the destination before claiming; an existing lease path must not create an unreachable assignment.
    try{await fs.lstat(p.leaseFile);throw Object.assign(new Error('Existing private lease output.'),{code:'NATIVE_MISSION_LEASE_EXISTS'});}catch(e){if(e.code!=='ENOENT')throw e;}
    const lease=await claimNativeMission({control,taskId:p.taskId,client,outputFile:p.outputFile,ttlMs:p.ttlMs});
    await privateFiles.writePrivateJson(p.leaseFile,lease,{exclusive:true});outcome={claimed:true,taskId:lease.scopeId,cellId:lease.cellId,attempt:lease.epoch};
  }else if(command==='run'){
    check(path.isAbsolute(p.leaseFile??'') && path.isAbsolute(p.outputFile??''));await privateFiles.ensurePrivateDirectory(path.dirname(p.outputFile));
    const lease=await privateFiles.readPrivateJson(p.leaseFile,{maxBytes:4096});await database(p.spendingDatabase,privateFiles);paid=new SpendingLedger(p.spendingDatabase);
    outcome=await runNativeMission({control,lease,client,paidAdmission:paid,privateFiles,outputFile:p.outputFile});
  }else outcome=await observeNativeMission({control,key:p.key,client,privateFiles});
  console.log(JSON.stringify(outcome));
}catch(e){console.error(JSON.stringify({error:typeof e?.code==='string' && /^[A-Z0-9_]{1,64}$/.test(e.code)?e.code:'NATIVE_MISSION_FAILED'}));process.exitCode=1;}
finally{paid?.close();control?.close();}
