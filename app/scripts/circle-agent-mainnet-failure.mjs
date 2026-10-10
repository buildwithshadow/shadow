import { decodeEventLog,decodeFunctionData,encodeFunctionData,hashTypedData,parseAbi } from 'viem';
import { entryPoint07Abi,entryPoint07Address } from 'viem/account-abstraction';
import { floatAbi,SPEND_INTENT_TYPES,eip712Domain } from './float-mainnet-config.mjs';
const accountAbi=parseAbi(['function execute(address target,uint256 value,bytes data)']);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
/** Proves a failed Circle purchase inside its exact canonical finalized bundle.
 * An unrelated or malformed bundle remains unknown; it never frees capacity.
 */
export async function readFailedCircleSessionAttempt(connection,entry,receipt){
 if(!same(entry.message.agent,entry.message.executor))return null;
 const tx=await connection.client.getTransaction({hash:entry.txHash});
 if(!same(tx.to,entryPoint07Address))return null;
 if(!same(receipt.transactionHash,entry.txHash)||!['success','reverted'].includes(receipt.status)||!same(tx.hash,entry.txHash)||!same(tx.blockHash,receipt.blockHash)||tx.blockNumber!==receipt.blockNumber)throw Error('Circle failure transaction differs from its receipt.');
 const [block,finalized]=await Promise.all([connection.client.getBlock({blockNumber:receipt.blockNumber}),connection.client.getBlock({blockTag:'finalized'})]);
 if(!same(block.hash,receipt.blockHash)||finalized.number<receipt.blockNumber)throw Error('Circle failure is not canonical and finalized.');
 const bundle=decodeFunctionData({abi:entryPoint07Abi,data:tx.input});
 if(bundle.functionName!=='handleOps'||!same(encodeFunctionData({abi:entryPoint07Abi,...bundle}),tx.input))throw Error('Unsupported Circle failure bundle.');
 const matching=bundle.args[0].filter(op=>{
  if(!same(op.sender,entry.message.agent))return false;
  try{
   const call=decodeFunctionData({abi:accountAbi,data:op.callData});
   if(call.functionName!=='execute'||!same(encodeFunctionData({abi:accountAbi,...call}),op.callData)||!same(call.args[0],connection.address)||call.args[1]!==0n)return false;
   const spend=decodeFunctionData({abi:floatAbi,data:call.args[2]});
   if(spend.functionName!=='executeSpend'||!same(encodeFunctionData({abi:floatAbi,...spend}),call.args[2]))return false;
   return same(hashTypedData({domain:eip712Domain(connection.chainId,connection.address),types:SPEND_INTENT_TYPES,primaryType:'SpendIntent',message:spend.args[0]}),entry.digest);
  }catch{return false;}
 });
 if(matching.length!==1)throw Error('Circle failure has no unique matching purchase.');
 if(receipt.status==='reverted')return 'reverted';
 if(!receipt.logs.every((log,i)=>Number.isSafeInteger(log.logIndex)&&log.logIndex>=0&&(!i||log.logIndex>receipt.logs[i-1].logIndex)))throw Error('Invalid Circle failure log ordering.');
 const userOpHash=await connection.client.readContract({address:entryPoint07Address,abi:entryPoint07Abi,functionName:'getUserOpHash',args:[matching[0]],blockNumber:receipt.blockNumber});
 const boundaries=receipt.logs.flatMap((log,index)=>{
  if(!same(log.address,entryPoint07Address))return [];
  try{const event=decodeEventLog({abi:entryPoint07Abi,data:log.data,topics:log.topics});return ['UserOperationEvent','BeforeExecution'].includes(event.eventName)?[{...event,index}]:[];}catch{return [];}
 });
 const ends=boundaries.filter(e=>e.eventName==='UserOperationEvent'&&same(e.args.userOpHash,userOpHash)&&same(e.args.sender,entry.message.agent));
 if(ends.length!==1)throw Error('Circle failure has no unique user operation receipt.');
 if(ends[0].args.success!==false)return null;
 const start=boundaries.filter(e=>e.index<ends[0].index).at(-1)?.index;
 if(start===undefined)throw Error('Missing Circle failure log boundary.');
 for(const log of receipt.logs.slice(start+1,ends[0].index)){
  if(!same(log.address,connection.address))continue;
  try{const e=decodeEventLog({abi:floatAbi,data:log.data,topics:log.topics});if(['ProviderPaid','SpendBlocked'].includes(e.eventName)&&same(e.args.digest,entry.digest))throw Error('Failed operation contradicts a payment receipt.');}catch(error){if(error.message==='Failed operation contradicts a payment receipt.')throw error;}
 }
 return 'failed-user-operation';
}
