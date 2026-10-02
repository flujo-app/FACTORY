import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { safeReceipt } from './receipts.mjs';

/** Durable admission before dispatch. An existing intent is observed, never blindly rerun. */
export async function executeEffect(control, lease, intent, operation, { outputPath }={}) {
  const admission=control.admitEffect(lease,intent);
  if(!admission.fresh) return {dispatched:false,effect:control.effect(intent.key)};
  control.startEffect(lease,intent.key);
  try {
    const result=await operation();
    let receipt=safeReceipt(result);
    if(typeof result?.body==='string') {
      if(!outputPath || !isAbsolute(outputPath))throw new Error('Private output path is required.');
      await writeFile(outputPath,result.body,{encoding:'utf8',mode:0o600,flag:'wx'});
      receipt={...receipt,outputPath,outputSha256:createHash('sha256').update(result.body).digest('hex')};
    }
    return {dispatched:true,effect:control.settleEffect(intent.key,'succeeded',receipt)};
  } catch {
    if(['succeeded','not_applied'].includes(control.effect(intent.key).state))return {dispatched:true,effect:control.effect(intent.key)};
    return {dispatched:true,effect:control.settleEffect(intent.key,'unknown',{reason:'External outcome requires reconciliation.'})};
  }
}
