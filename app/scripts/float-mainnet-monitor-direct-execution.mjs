import { decodeEventLog, decodeFunctionData, encodeFunctionData, hashTypedData, zeroAddress } from 'viem';
import { floatAbi, floatEventAbi } from './float-mainnet-config.mjs';
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const must=(ok,message)=>{if(!ok)throw Error(message);};
const types={SpendIntent:floatAbi.find(x=>x.type==='function' && x.name==='executeSpend').inputs[0].components.map(({name,type})=>({name,type}))};

// The caller has already bound the mined transaction to the canonical event block.
export async function readDirectExecutionAttribution(client,event,tx,shadow,chainId) {
  must(same(tx.to,shadow) && tx.value===0n,'Direct call target or value differs');
  const call=decodeFunctionData({abi:floatAbi,data:tx.input});
  must(call.functionName==='executeSpend' && same(encodeFunctionData({abi:floatAbi,...call}),tx.input),'Noncanonical direct spend calldata');
  const intent=call.args[0];
  must(!same(intent.executor,zeroAddress) && same(intent.executor,tx.from) && same(intent.lineId,event.args.lineId),'Direct executor or line differs');
  const digest=hashTypedData({domain:{name:'ShadowFloatMainnet',version:'1',chainId:Number(chainId),verifyingContract:shadow},types,primaryType:'SpendIntent',message:intent});
  must(same(digest,event.args.digest),'Direct intent digest differs');
  const receipt=await client.getTransactionReceipt({hash:tx.hash});
  must(receipt.status==='success' && same(receipt.transactionHash,tx.hash) && receipt.blockNumber===event.blockNumber && same(receipt.blockHash,event.blockHash) && receipt.transactionIndex===event.transactionIndex,'Direct receipt differs from canonical execution');
  const logs=receipt.logs.filter(l=>l.logIndex===event.logIndex);
  must(logs.length===1 && same(logs[0].address,shadow),'Direct payment log is absent or ambiguous');
  const payment=decodeEventLog({abi:floatEventAbi,data:logs[0].data,topics:logs[0].topics});
  must(payment.eventName===event.event && Object.entries(event.args).every(([k,v])=>typeof v==='string'?same(payment.args[k],v):payment.args[k]===v),'Direct payment log differs');
  if(event.event==='ProviderPaid') must(same(intent.provider,payment.args.provider) && intent.principal===payment.args.principal && intent.dueAt===payment.args.dueAt,'Direct payout differs from signed terms');
  else must(event.event==='SpendBlocked' && intent.nonce===payment.args.nonce,'Direct refusal differs from signed nonce');
  const status=await client.readContract({address:shadow,abi:floatAbi,functionName:'receiptStatus',args:[digest],blockNumber:event.blockNumber});
  must(Number(status)===(event.event==='ProviderPaid'?2:1),'Direct receipt status differs');
  return {route:'direct-intent',intentVerified:true,agent:intent.agent,sponsor:intent.sponsor,lineEpoch:String(intent.lineEpoch),executor:intent.executor};
}
