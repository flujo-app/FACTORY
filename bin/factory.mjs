#!/usr/bin/env node
import { resolve, isAbsolute } from 'node:path';
import { constants, lstatSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { FactoryControl, digest } from '../src/control.mjs';
import { validateGrowthPolicy } from '../src/growth-policy.mjs';

const [command, database] = process.argv.slice(2);
if(!command || !database) {
  process.stdout.write('Usage: node bin/factory.mjs <command> <absolute-db-path>\nCommands: init, status, growth-policy, budget-growth, reserve, enroll, task, claim, integration, message, inbox, pause, resume\nMutating command inputs arrive as JSON on stdin. Lease tokens are private runner capabilities.\n');
  process.exit(command ? 1 : 0);
}
let input={};
if(!['status','growth-policy','pause','resume'].includes(command)) {
  let raw=''; for await(const chunk of process.stdin) raw+=chunk;
  if(raw.trim()) input=JSON.parse(raw);
}
function existingGrowthIdentity(filename) {
  const reject=()=>{throw Object.assign(new Error('An existing initialized factory database is required.'),{code:'GROWTH_DATABASE'});};
  if (!isAbsolute(filename)) reject();
  const info=lstatSync(filename,{bigint:true});if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)reject();
  const handle=openSync(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0)),header=Buffer.alloc(16);try{const opened=fstatSync(handle,{bigint:true});if(!opened.isFile()||opened.nlink!==1n||opened.dev!==info.dev||opened.ino!==info.ino||readSync(handle,header,0,16,0)!==16||!header.equals(Buffer.from('SQLite format 3\0')))reject();}finally{closeSync(handle);}
  const db=new DatabaseSync(filename,{readOnly:true});try{
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    if(db.prepare('PRAGMA user_version').get().user_version!==1||JSON.stringify(tables)!==JSON.stringify(['cells','control','effect_bindings','effects','events','integrations','messages','tasks'])||db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type IN ('view','trigger')").get().n!==0)reject();
    const columns={cells:'id,parent_id,depth,role,allocation,spent,status,purpose,heartbeat',control:'id,epoch,status,policy',effect_bindings:'target,effect_key',effects:'key,scope,scope_id,task_id,owner,owner_epoch,control_epoch,kind,request_digest,state,receipt,created,updated',events:'seq,type,subject,details,observed',integrations:'project_id,owner,epoch,token_hash,expires,control_epoch',messages:'sender,message_id,recipient,task_id,attempt,payload,digest,created',tasks:'id,project_id,branch,specification,spec_digest,status,owner,epoch,token_hash,expires,control_epoch,candidate,review'};
    for(const name of tables)if(db.prepare('PRAGMA table_info('+name+')').all().map(row=>row.name).join(',')!==columns[name])reject();
    const rows=db.prepare('SELECT id,epoch,status,policy FROM control').all(),root=db.prepare("SELECT role,allocation FROM cells WHERE id='root'").get();
    if(rows.length!==1||rows[0].id!==1||!Number.isSafeInteger(rows[0].epoch)||rows[0].epoch<1||!['active','paused'].includes(rows[0].status)||root?.role!=='coordinator')reject();
    const policy=validateGrowthPolicy(JSON.parse(rows[0].policy));if(root.allocation!==policy.budgetCents)reject();db.exec('COMMIT');
    return{identity:{epoch:rows[0].epoch,status:rows[0].status,policy,policyDigest:digest(policy)},file:{dev:info.dev,ino:info.ino}};
  }finally{db.close();}
}
let control;
try {
  if (command==='growth-policy'||command==='budget-growth') {
    if(process.argv.length!==4)throw Object.assign(new Error('Exactly one absolute database path is required.'),{code:'GROWTH_ARGUMENTS'});
    if(Number(process.versions.node.split('.')[0])<24)throw Object.assign(new Error('Node 24 or newer is required.'),{code:'GROWTH_NODE_VERSION'});
    const checked=existingGrowthIdentity(database),current=lstatSync(database,{bigint:true});
    if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||current.dev!==checked.file.dev||current.ino!==checked.file.ino)throw Object.assign(new Error('The initialized database identity changed.'),{code:'GROWTH_DATABASE'});
    if(command==='growth-policy'){process.stdout.write(JSON.stringify({schemaVersion:1,scope:'trusted-local-growth-policy',...checked.identity})+'\n');process.exitCode=0;}
    else{control=new FactoryControl(database);process.stdout.write(JSON.stringify(control.useBudgetOnlyGrowth(input))+'\n');}
  } else {
  control=new FactoryControl(resolve(database));
  let result;
  switch(command) {
    case 'init': result=control.initialize(input); break;
    case 'status': result=control.status(); break;
    case 'reserve': result=control.reserveCell(input); break;
    case 'enroll': result=control.enrollCell(input.cellId); break;
    case 'task': result=control.createTask(input); break;
    case 'claim': result=control.claimTask(input.taskId,input.cellId,input.ttlMs); break;
    case 'integration': result=control.claimIntegration(input.projectId,input.cellId,input.ttlMs); break;
    case 'message': result=control.sendMessage(input); break;
    case 'inbox': result=control.inbox(input.cellId); break;
    case 'pause': result=control.pause(); break;
    case 'resume': result=control.resume(); break;
    default: throw new Error('Unknown command.');
  }
  process.stdout.write(JSON.stringify(result)+'\n');
  }
} catch(error) {
  process.stderr.write(JSON.stringify({code:error.code??'FACTORY_ERROR',message:error.message})+'\n');
  process.exitCode=1;
} finally { control?.close(); }
