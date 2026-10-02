/**
 * Trusted local shutdown path. Pause prevents new work but cannot prevent retiring
 * an already-admitted worker. The operation must retain the provider's ownership
 * checks; recording an app name alone never proves that deletion is safe.
 */
export async function executeOwnedRetirement(control,intent,operation) {
  const admission=control.admitOwnedRetirement(intent);
  if(!admission.fresh) return {dispatched:false,effect:control.effect(intent.key)};
  control.startOwnedRetirement(intent.key);
  try {
    const result=await operation();
    if(result?.state!=='destroyed' || result?.app!==intent.app) throw new Error('Retirement result did not match the recorded app.');
    return {dispatched:true,effect:control.settleEffect(intent.key,'succeeded',result)};
  } catch {
    if(['succeeded','not_applied'].includes(control.effect(intent.key).state)) return {dispatched:true,effect:control.effect(intent.key)};
    return {dispatched:true,effect:control.settleEffect(intent.key,'unknown',{reason:'External outcome requires reconciliation.'})};
  }
}
