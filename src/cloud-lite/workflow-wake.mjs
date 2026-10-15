import { existsSync, readFileSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync } from 'node:fs';

/** A durable native wake intent. Unknown turn/start outcomes are read back, never blindly replayed. */
export class NativeWorkflowWake {
  constructor({rpc,threadId,file,effort,onEvent=()=>{}}) {
    this.rpc=rpc;this.threadId=threadId;this.file=file;this.effort=effort;this.onEvent=onEvent;
    this.intent=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
    if(this.intent&&this.intent.threadId!==threadId)throw new Error('Retained wake belongs to another native thread.');
  }
  save(value) {
    const next=this.file+'.next',fd=openSync(next,'w',0o600);
    try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(next,this.file);this.intent=value;
  }
  async read() {
    const response=await this.rpc.request('thread/read',{threadId:this.threadId,includeTurns:true});
    if(response.thread?.id!==this.threadId)throw new Error('Wake reconciliation thread identity mismatch.');
    return {status:response.thread.status?.type,turnId:response.thread.turns?.at(-1)?.id??null};
  }
  async reconcile() {
    const intent=this.intent;if(!intent||intent.status==='delivered')return intent;
    const observed=await this.read();
    if(observed.turnId&&observed.turnId!==intent.beforeTurnId){this.save({...intent,status:'delivered',turnId:observed.turnId,reconciled:true});return this.intent;}
    return intent;
  }
  async wake({trigger,input,initial=false}) {
    if(this.intent?.status==='unknown')return this.reconcile();
    if(this.intent?.trigger===trigger&&this.intent.status==='delivered')return this.intent;
    const observed=initial?{status:'idle',turnId:null}:await this.read();
    if(observed.status!=='idle')return {status:'waiting',threadId:this.threadId};
    const intent={threadId:this.threadId,trigger,input,beforeTurnId:observed.turnId,status:'unknown'};
    this.save(intent);
    try {
      const response=await this.rpc.request('turn/start',{threadId:this.threadId,input:[{type:'text',text:input}],effort:this.effort});
      if(typeof response.turn?.id==='string'){this.save({...intent,status:'delivered',turnId:response.turn.id});return this.intent;}
      return this.reconcile();
    }catch(error){
      if([-32600,-32602].includes(error.code))this.save({...intent,status:'rejected',errorCode:error.code});
      else {try{await this.reconcile();}catch{/* Retain the unresolved intent for supervisor reconciliation. */}}
      this.onEvent({threadId:this.threadId,trigger,status:this.intent.status,errorCode:error.code??null});
      return this.intent;
    }
  }
}
