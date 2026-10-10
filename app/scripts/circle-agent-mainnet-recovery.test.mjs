import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData,getAddress,keccak256,stringToHex } from 'viem';
import { circleGuardedRepaymentAbi as abi } from './circle-agent-execution.mjs';
import { mainnetCircleSessionIntent } from './circle-agent-mainnet-session.mjs';
import { reconcileOriginalMainnetCirclePurchase } from './circle-agent-mainnet-recovery.mjs';
import { recoverAgentPurchase } from './shadow-circle-agent.mjs';
const hash=v=>keccak256(stringToHex(JSON.stringify(v)));
const agent=getAddress(`0x${'11'.repeat(20)}`),provider=`0x${'22'.repeat(20)}`,line=`0x${'33'.repeat(32)}`,txHash=`0x${'44'.repeat(32)}`,contract='0x708c8c987eb4Cd14445Ac2c65ea712b2084888eB';
function setup(){
 const message={agent,executor:agent,sponsor:provider,provider,lineId:line,lineEpoch:1n,termsHash:line,endpointHash:line,principal:5000n,maximumTotalDebt:5000n,dueAt:1000n,nonce:0n,signatureExpiry:900n};
 const {digest}=mainnetCircleSessionIntent(message,{chainId:5042n,address:contract});
 const data=encodeFunctionData({abi,functionName:'executeSpend',args:[message,'0x1234']});
 const namespace=hash({chainId:5042,agent}),operationId='guarded-purchase:original';
 const requestRecord={key:hash({namespace,operationId}),request:{to:contract,data,value:'0',operationId}};
 const request={blockchain:'ARC',sourceAddress:agent,contractAddress:contract,callData:data,amount:'0',idempotencyKey:'12345678-1234-1234-1234-123456789abc'};
 const saved={namespace,operationId,request,requestHash:hash(request),expected:{digest},txHash};
 const calls=[],sessionGuard={recordOutcome:async(...args)=>{calls.push(args);return {recordedStatus:'failed-user-operation'}},reconcile:async()=>({})};
 return {saved,calls,digest,options:{agent,requestRecord,purchaseRecord:{intent:{digest}},journal:{get:async()=>saved},sessionGuard}};
}
test('original hash reaches session recovery even when generic receipt verification has not succeeded',async()=>{
 const x=setup();assert.equal((await reconcileOriginalMainnetCirclePurchase(x.options)).recordedStatus,'failed-user-operation');assert.deepEqual(x.calls,[[x.digest,txHash,false]]);
 x.calls.length=0;await reconcileOriginalMainnetCirclePurchase({...x.options,purchaseRecord:null});assert.deepEqual(x.calls,[[x.digest,txHash,false]]);
});
test('changed source, request hash or intent digest cannot attach an unrelated Circle transaction',async()=>{
 for(const mutate of [x=>{x.saved.requestHash='bad'},x=>{x.saved.expected.digest=line},x=>{x.saved.request.sourceAddress=provider;x.saved.requestHash=hash(x.saved.request)}]){
  const x=setup();mutate(x);await assert.rejects(()=>reconcileOriginalMainnetCirclePurchase(x.options));assert.equal(x.calls.length,0);
 }
});
for(const status of ['reverted','failed-user-operation'])test(`${status} recovery never resends and archives only after unpaid authorization expiry`,async()=>{
 const state={requests:{purchase:{key:'original'}}};let archives=0,saves=0;
 const record={intent:{typedData:{message:{signatureExpiry:'900'}}}};
 const options={state,executor:{reconcile:async()=>({status,txHash})},engine:{load:()=>record,recover:async()=>({status:'unconfirmed',record}),archive:async()=>{archives++}},client:{getBlock:async()=>({timestamp:800n})},save:async()=>{saves++}};
 await recoverAgentPurchase(options);assert.equal(archives,0);assert(state.requests.purchase);
 options.client.getBlock=async()=>({timestamp:901n});await recoverAgentPurchase(options);assert.equal(archives,1);assert.equal(saves,1);assert.equal(state.requests.purchase,undefined);
});


test('a durable exact pre-send failure reconciles without attaching a transaction',async()=>{
 const x=setup();delete x.saved.txHash;x.saved.notSubmitted=true;
 await reconcileOriginalMainnetCirclePurchase(x.options);
 assert.deepEqual(x.calls,[[x.digest,undefined,true]]);
 x.options.journal.get=async()=>null;
 await assert.rejects(()=>reconcileOriginalMainnetCirclePurchase(x.options),/record is missing/);
 assert.equal(x.calls.length,1);
});
