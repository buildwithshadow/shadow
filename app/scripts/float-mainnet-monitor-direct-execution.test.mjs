import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData,encodeEventTopics,encodeAbiParameters,hashTypedData} from 'viem';
import {floatAbi,floatEventAbi} from './float-mainnet-config.mjs';
import {readDirectExecutionAttribution} from './float-mainnet-monitor-direct-execution.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture(blocked=false){
 const shadow=addr(1),intent={agent:addr(4),sponsor:addr(3),lineId:hash(2),lineEpoch:1n,termsHash:hash(9),provider:addr(5),endpointHash:hash(8),principal:5000n,maximumTotalDebt:5000n,dueAt:1800003600n,nonce:7n,signatureExpiry:1800000900n,executor:addr(6)};
 const types={SpendIntent:floatAbi.find(x=>x.type==='function'&&x.name==='executeSpend').inputs[0].components.map(({name,type})=>({name,type}))};
 const digest=hashTypedData({domain:{name:'ShadowFloatMainnet',version:'1',chainId:5042,verifyingContract:shadow},types,primaryType:'SpendIntent',message:intent});
 const event={event:blocked?'SpendBlocked':'ProviderPaid',args:blocked?{digest,lineId:intent.lineId,nonce:intent.nonce,reason:7}:{digest,lineId:intent.lineId,provider:intent.provider,principal:intent.principal,dueAt:intent.dueAt},blockNumber:100n,blockHash:hash(100),transactionHash:hash(12),transactionIndex:0,logIndex:1};
 const tx={hash:event.transactionHash,to:shadow,from:intent.executor,value:0n,input:encodeFunctionData({abi:floatAbi,functionName:'executeSpend',args:[intent,'0x01']})};
 const log={address:shadow,logIndex:1,topics:encodeEventTopics({abi:floatEventAbi,eventName:event.event,args:event.args}),data:blocked?encodeAbiParameters([{type:'uint8'}],[7]):encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[intent.principal,intent.dueAt])};
 const receipt={status:'success',transactionHash:tx.hash,blockNumber:event.blockNumber,blockHash:event.blockHash,transactionIndex:0,logs:[log]};
 const client={getTransactionReceipt:async()=>receipt,readContract:async()=>blocked?1n:2n};
 return {shadow,intent,event,tx,receipt,client};
}
for(const blocked of [false,true])test(`exact direct ${blocked?'refusal':'payment'} is attributed to its signed executor and line`,async()=>{const f=fixture(blocked);const r=await readDirectExecutionAttribution(f.client,f.event,f.tx,f.shadow,'5042');assert.equal(r.intentVerified,true);assert.equal(r.route,'direct-intent');assert.equal(r.agent,f.intent.agent);assert.equal(r.sponsor,f.intent.sponsor);assert.equal(r.executor,f.intent.executor);});
for(const [name,change] of [
 ['wrong caller',f=>f.tx.from=addr(99)],['wrong target',f=>f.tx.to=addr(99)],['native transfer',f=>f.tx.value=1n],['different event digest',f=>f.event.args.digest=hash(99)],['different line',f=>f.event.args.lineId=hash(99)],['reverted receipt',f=>f.receipt.status='reverted'],['different receipt block',f=>f.receipt.blockHash=hash(99)],['different receipt transaction',f=>f.receipt.transactionHash=hash(99)],['missing log',f=>f.receipt.logs=[]],['foreign log',f=>f.receipt.logs[0].address=addr(99)],['duplicate log slot',f=>f.receipt.logs.push(f.receipt.logs[0])],['different payout amount',f=>f.event.args.principal=5001n],['noncanonical calldata',f=>f.tx.input+='00'],['different receipt status',f=>f.client.readContract=async()=>1n]
])test(`direct attribution rejects ${name}`,async()=>{const f=fixture();change(f);await assert.rejects(()=>readDirectExecutionAttribution(f.client,f.event,f.tx,f.shadow,'5042'));});
