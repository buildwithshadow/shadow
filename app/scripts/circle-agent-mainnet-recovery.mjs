import { getAddress,keccak256,stringToHex,decodeFunctionData } from 'viem';
import { circleGuardedRepaymentAbi } from './circle-agent-execution.mjs';
import { mainnetCircleSessionIntent } from './circle-agent-mainnet-session.mjs';
const hash=v=>keccak256(stringToHex(JSON.stringify(v)));
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
/** Read the original protected adapter record, not an arbitrary hash from UI. */
export async function reconcileOriginalMainnetCirclePurchase({journal,requestRecord,purchaseRecord,agent,sessionGuard}){
 if(!requestRecord)return sessionGuard.reconcile();
 const saved=await journal.get(requestRecord.key);
 if(!saved)throw Error('Original Circle execution record is missing. Preserve the session and journal.');
 const namespace=hash({chainId:5042,agent:getAddress(agent)});
 const key=hash({namespace,operationId:requestRecord.request.operationId});
 if(key!==requestRecord.key||saved.namespace!==namespace||saved.requestHash!==hash(saved.request)
  ||saved.request.blockchain!=='ARC'||!same(saved.request.sourceAddress,agent)||!same(saved.request.contractAddress,requestRecord.request.to)
  ||!same(saved.request.callData,requestRecord.request.data)||saved.request.amount!=='0'||saved.operationId!==requestRecord.request.operationId||!same(saved.request.contractAddress,'0x708c8c987eb4Cd14445Ac2c65ea712b2084888eB'))throw Error('Original Circle recovery identity changed.');
 const decoded=decodeFunctionData({abi:circleGuardedRepaymentAbi,data:saved.request.callData});
 if(decoded.functionName!=='executeSpend'||!same(decoded.args[0].agent,agent)||!same(decoded.args[0].executor,agent))throw Error('Original Circle purchase calldata changed.');
 const {digest}=mainnetCircleSessionIntent(decoded.args[0],{chainId:5042n,address:saved.request.contractAddress});
 if(!same(saved.expected.digest,digest)||(purchaseRecord&&!same(purchaseRecord.intent.digest,digest)))throw Error('Original Circle intent digest changed.');
 if(saved.notSubmitted===true&&(saved.transactionId||saved.txHash||saved.result))throw Error('Contradictory original Circle outcome.');
 return sessionGuard.recordOutcome(digest,saved.txHash,saved.notSubmitted===true);
}
