import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ContinuousEvidenceCollector, createEvidenceClient } from '../evidence.mjs';
import { cleanupCloudLitePaths } from './cleanup.mjs';

// Dedicated process: hashing/reading a large workspace cannot starve native RPC or deadline handling.
let collector, sessions=[], finalizing=false;
process.on('message',async message=>{
  try {
    if(message.action==='start' && !collector){
      const {runId,machineId,url,token,intervalMs}=message;
      sessions=message.sessions;
      const directory='/data/factory-evidence';mkdirSync(directory,{recursive:true,mode:0o700});
      const roots=[{name:'workspaces',path:'/data/worktrees',exclude:['node_modules','.git','.next','.cache','.npm','__pycache__']},
        {name:'sessions',path:'/data/codex/sessions'}, {name:'results',path:'/data/results'},
        {name:'runtime',path:'/data/factory',exclude:['control.sqlite','control.sqlite-wal','control.sqlite-shm']},
        {name:'board',path:resolve(directory,'board')}];
      for(const root of roots)mkdirSync(root.path,{recursive:true,mode:0o700});
      collector=new ContinuousEvidenceCollector({directory,runId,machineId,roots,intervalMs,client:createEvidenceClient({url,token}),sessions:()=>sessions,
        beforeCapture:async()=>{
          // SQLite's online backup captures a consistent database, including committed WAL records.
          const directory=resolve('/data/factory-evidence','backups',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
          roots.at(-1).path=directory;
          for(const name of readdirSync('/data/factory').filter(name=>name.endsWith('.sqlite'))){
            if(!roots[3].exclude.includes(name))roots[3].exclude.push(name,name+'-wal',name+'-shm');
            const db=new DatabaseSync(resolve('/data/factory',name),{readOnly:true});
            try{await backup(db,resolve(directory,name));}finally{db.close();}
          }
        },afterCheckpoint:async()=>{
          try{
            const remove=async paths=>{for(let offset=0;offset<paths.length;offset+=100)await cleanupCloudLitePaths(paths.slice(offset,offset+100),{root:directory});};
            await collector.pruneAcknowledged({remove});
            const backups=resolve(directory,'backups'),current=roots.at(-1).path;
            const old=readdirSync(backups).map(name=>resolve(backups,name)).filter(path=>path!==current);
            if(old.length)await remove(old);
          }catch(error){process.send?.({type:'evidence.cleanup_pending',error:error.message});}
        },onEvent:event=>process.send?.(event)});
      collector.start();
    }
    if(message.action==='finalize' && collector && !finalizing){
      finalizing=true;sessions=message.sessions;
      try {const receipt=await collector.stop({final:true});process.send?.({type:'evidence.final',receipt});process.disconnect();}
      catch(error){finalizing=false;process.send?.({type:'evidence.pending',error:error.message});}
    }
  }catch(error){process.send?.({type:'evidence.pending',error:error.message});}
});
process.on('disconnect',()=>{if(!finalizing)void collector?.stop();});
