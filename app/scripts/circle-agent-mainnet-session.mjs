import { hashTypedData } from 'viem';
import { SPEND_INTENT_TYPES, eip712Domain } from './float-mainnet-config.mjs';
import { withExecutionSession } from './float-mainnet-session.mjs';

const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
export function mainnetCircleSessionIntent(message, connection) {
  const struct=Object.fromEntries(SPEND_INTENT_TYPES.SpendIntent.map(({name,type})=>[name,type.startsWith('uint')?BigInt(message[name]):message[name]]));
  const digest=hashTypedData({domain:eip712Domain(connection.chainId,connection.address),types:SPEND_INTENT_TYPES,primaryType:'SpendIntent',message:struct});
  return {struct,digest};
}
/** Shares the existing execution-session ledger. No initialization, reset or refund. */
export function createMainnetCircleSessionGuard({sessionPath,connection,monitor}) {
  const inSession=work=>withExecutionSession(sessionPath,connection,work);
  async function authorize(message,reserve=false) {
    const {struct,digest}=mainnetCircleSessionIntent(message,connection);
    return inSession(async session=>{
      await session.reconcile();
      if(session.check(struct,digest))throw Error('This session intent is already recorded. Recover its original outcome; do not sign or send it again.');
      const proof=await monitor(struct,session.policy);
      if(reserve)session.reserve(struct,digest);
      return {digest,proof};
    });
  }
  async function recordOutcome(digest,txHash,allowUnreserved=false) {
    return inSession(async session=>{
      const prior=session.recorded(digest);
      if(!prior){if(allowUnreserved)return session.reconcile();throw Error('The original execution session reservation is missing. Keep the Circle journal and inspect it.');}
      if(prior.txHash && txHash && !same(prior.txHash,txHash))throw Error('Session transaction identity changed.');
      if(prior.status==='pending' && prior.txHash===null && txHash)session.beforeSend(digest,txHash);
      return session.reconcile();
    });
  }
  return {check:message=>authorize(message),reserve:message=>authorize(message,true),recordOutcome,reconcile:()=>inSession(session=>session.reconcile())};
}
