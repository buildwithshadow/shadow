import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi } from 'viem';
import { circleGuardedRepaymentAbi } from './circle-agent-execution.mjs';
import { createCircleGuardedCliDriver } from './circle-agent-guarded-cli.mjs';

const agent=`0x${'11'.repeat(20)}`,contract=`0x${'22'.repeat(20)}`,other=`0x${'33'.repeat(20)}`;
const line=`0x${'44'.repeat(32)}`,draw=`0x${'55'.repeat(32)}`,usdc='0x3600000000000000000000000000000000000000';
const key='180fefd3-af7d-4b57-b14a-3b4560be742c';
const request={blockchain:'ARC',sourceAddress:agent,contractAddress:contract,amount:'0',idempotencyKey:key,
  callData:encodeFunctionData({abi:circleGuardedRepaymentAbi,functionName:'repayForDraw',args:[line,draw,5000n]})};
function setup() {
  const records=new Map(),calls=[];
  const state={valid:true,lose:false,failSave:false};
  const journal={get:async k=>records.get(k),put:async(k,v)=>{if(state.failSave)throw Error('disk failed');records.set(k,v);}};
  const response={...request,id:'original-circle-id',state:'COMPLETE',txHash:`0x${'66'.repeat(32)}`};
  const run=async (_exe,args)=>{
    calls.push(args);
    if(args[1]==='wallet'&&args[2]==='status')return {stdout:JSON.stringify({mainnet:{tokenStatus:state.valid?'VALID':'EXPIRED'}})};
    if(args[1]==='wallet'&&args[2]==='list')return {stdout:JSON.stringify([{address:agent}])};
    if(args.includes('--estimate'))return {stdout:JSON.stringify({data:{blockchain:'ARC',medium:{networkFee:'0.01'}}})};
    if(args[1]==='transaction')return {stdout:JSON.stringify({data:{transactions:[response]}})};
    if(state.lose)throw Error('SECRET_CHILD_OUTPUT');
    return {stdout:JSON.stringify({data:response})};
  };
  return {state,calls,records,response,driver:createCircleGuardedCliDriver({entrypoint:'/isolated/runtime.js',agent,contract,maxAmount:'5000',expectedLineId:line,expectedDraw:draw,journal,run})};
}
test('guarded transport uses the exact draw and original idempotency key with ordinary mainnet CLI arguments',async()=>{
  const x=setup();assert.deepEqual(await x.driver.estimate(request),{networkFee:'0.01'});
  await x.driver.execute(request);const sent=x.calls.find(a=>a.includes('--idempotency-key'));
  assert.deepEqual(sent.slice(1,7),['wallet','execute','repayForDraw(bytes32,bytes32,uint256)',line,draw,'5000']);
  assert.equal(sent[sent.indexOf('--chain')+1],'ARC');assert.equal(sent[sent.indexOf('--idempotency-key')+1],key);
  assert.equal((await x.driver.lookup({idempotencyKey:key})).id,'original-circle-id');
});
test('foreign networks, wallets, targets, arbitrary approvals and legacy repayment never reach CLI execution',async()=>{
  const x=setup();for(const patch of [
    {blockchain:'ARC-TESTNET'},{sourceAddress:other},{contractAddress:other},{amount:'1'},
    {callData:request.callData+'00'},
    {contractAddress:usdc,callData:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[other,5000n]})},
    {contractAddress:usdc,callData:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,2n**256n-1n]})},
    {callData:encodeFunctionData({abi:circleGuardedRepaymentAbi,functionName:'repayForDraw',args:[line,draw,5001n]})},
    {callData:encodeFunctionData({abi:circleGuardedRepaymentAbi,functionName:'repayForDraw',args:[line,`0x${'77'.repeat(32)}`,5000n]})},
    {callData:encodeFunctionData({abi:circleGuardedRepaymentAbi,functionName:'closeLine',args:[line]})},
  ]) await assert.rejects(()=>x.driver.execute({...request,...patch}));
  assert.equal(x.calls.length,0);
});
test('expired authentication is a definite pre-submit failure; transport errors are uncertain and sanitized',async()=>{
  const x=setup();x.state.valid=false;await assert.rejects(()=>x.driver.execute(request),e=>e.beforeSubmission===true);
  assert(!x.calls.some(a=>a.includes('--idempotency-key')));
  x.state.valid=true;x.state.lose=true;
  await assert.rejects(()=>x.driver.execute(request),e=>!e.beforeSubmission&&!e.message.includes('SECRET'));
  const n=x.calls.length;assert.equal(await x.driver.lookup({idempotencyKey:key}),null);assert.equal(x.calls.length,n);
});
test('a durable response write failure cannot be classified as never submitted',async()=>{
  const x=setup();x.state.failSave=true;await assert.rejects(()=>x.driver.execute(request),e=>!e.beforeSubmission);
  assert.equal(x.calls.filter(a=>a.includes('--idempotency-key')).length,1);
});
test('pending response recovery uses the original remote ID and never execute again',async()=>{
  const x=setup();x.records.set(`circle-response:${key}`,{...x.response,txHash:null,state:'PENDING'});
  assert.equal((await x.driver.lookup({idempotencyKey:key,transactionId:'original-circle-id'})).txHash,x.response.txHash);
  assert.equal(x.calls.filter(a=>a[1]==='transaction').length,1);
  assert(!x.calls.some(a=>a.includes('--idempotency-key')));
  await assert.rejects(()=>x.driver.lookup({idempotencyKey:key,transactionId:'different'}),/identity mismatch/);
});
