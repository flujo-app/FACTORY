#!/usr/bin/env node
import { resolve } from 'node:path';
import { FactoryControl } from '../src/control.mjs';

const [command, database] = process.argv.slice(2);
if(!command || !database) {
  process.stdout.write('Usage: node bin/factory.mjs <command> <absolute-db-path>\nCommands: init, status, reserve, enroll, task, claim, integration, message, inbox, pause, resume\nMutating command inputs arrive as JSON on stdin. Lease tokens are private runner capabilities.\n');
  process.exit(command ? 1 : 0);
}
let input={};
if(!['status','pause','resume'].includes(command)) {
  let raw=''; for await(const chunk of process.stdin) raw+=chunk;
  if(raw.trim()) input=JSON.parse(raw);
}
const control=new FactoryControl(resolve(database));
try {
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
} catch(error) {
  process.stderr.write(JSON.stringify({code:error.code??'FACTORY_ERROR',message:error.message})+'\n');
  process.exitCode=1;
} finally { control.close(); }
