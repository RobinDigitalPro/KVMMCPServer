// Only positively identified transport faults are eligible for an explicit retry.
// A manual stop always wins, including when it arrives during recovery.
export const recoverableFault = reason => typeof reason === 'string' && (
  reason === 'heartbeat_timeout' || reason === 'write EPIPE' ||
  reason === 'native write timed out; kernel watchdog must release held input' ||
  /^native helper exited \(-?\d+\)$/.test(reason));
export const technicalStop = value => Boolean(value?.stopped && value.kind !== 'operator' && recoverableFault(value.reason));
export const sameStop = (a,b) => Boolean(a?.stopped && b?.stopped && a.reason === b.reason && a.stoppedUtc === b.stoppedUtc && a.kind === b.kind);
export const recoveryLimits = { cooldownMs:30000, windowMs:300000, maxAttempts:3 };
export function budget(state={},now=Date.now()){
  const attempts=(state.attempts??[]).filter(time=>Number.isFinite(time)&&time>now-recoveryLimits.windowMs);
  return {attempts,retryAfterMs:Math.max(0,(attempts.at(-1)??0)+recoveryLimits.cooldownMs-now,attempts.length>=recoveryLimits.maxAttempts?attempts[0]+recoveryLimits.windowMs-now:0)};
}
export async function abortable(promise,signal){
  if(signal?.aborted){void Promise.resolve(promise).catch(()=>{});signal.throwIfAborted();}if(!signal)return promise;
  let listener;
  try{return await Promise.race([promise,new Promise((_,reject)=>{listener=()=>reject(signal.reason??Error('Recovery cancelled'));signal.addEventListener('abort',listener,{once:true});})]);}
  finally{signal.removeEventListener('abort',listener);}
}
