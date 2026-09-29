import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256, parseUnits } from 'viem';
import abi from './float-mainnet-abi.json' with { type: 'json' };
import { createCircleAgentExecutor } from './circle-agent-execution.mjs';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';
const agent = `0x${'11'.repeat(20)}`, contract = `0x${'22'.repeat(20)}`, provider = `0x${'33'.repeat(20)}`;
const lineId = `0x${'44'.repeat(32)}`, digest = `0x${'55'.repeat(32)}`, endpointHash = `0x${'66'.repeat(32)}`, txHash = `0x${'77'.repeat(32)}`;
const usdc = '0x3600000000000000000000000000000000000000';
const code = '0x6000';
const config = { chainId: 5042002, agent, contract, provider, endpointHash, runtimeHash: keccak256(code), maxAmount: '50000', maxNetworkFee: parseUnits('0.05', 18).toString() };
const repay = { operationId: 'repay:one', to: contract, data: encodeFunctionData({ abi, functionName: 'repay', args: [lineId, 50000n] }) };
function eventLog(eventName, args, address = contract, eventAbi = abi) {
  const event = eventAbi.find(x => x.type === 'event' && x.name === eventName);
  return { address, topics: encodeEventTopics({ abi: eventAbi, eventName, args }), data: encodeAbiParameters(event.inputs.filter(x => !x.indexed), event.inputs.filter(x => !x.indexed).map(x => args[x.name])) };
}
function setup(overrides = {}) {
  const values = new Map(); let locked = false;
  const journal = { get: async k => structuredClone(values.get(k) ?? null), put: async(k,v) => { values.set(k, structuredClone(v)); }, withLock: async(_k,f) => { assert(!locked); locked=true; try{return await f();}finally{locked=false;} } };
  const state = { sends: 0, estimates: 0, reads: 0, lose: false, pending: false, fee: '0.01', chainId: 5042002, policy: true, receiptStatus: 0, lineAgent: agent, code,
    receipt: { status: 'success', blockNumber: 101n, logs: [eventLog('Repaid', { lineId, payer: agent, amount: 50000n, principalRemaining: 0n })] } };
  const client = {
    getChainId: async()=>state.chainId, getCode: async()=>state.code, getBlock: async()=>({number:100n}),
    readContract: async({functionName})=>({ lines:[provider,state.lineAgent], hashSpendIntent:digest, receiptStatus:state.receiptStatus })[functionName],
    simulateContract: async()=>({result:[state.policy,0]}), getTransactionReceipt: async()=>state.receipt,
  };
  const response = request => ({ idempotencyKey: request.idempotencyKey, id:'circle-tx-1', state:'COMPLETE', blockchain:'ARC-TESTNET', sourceAddress:agent, contractAddress:request.contractAddress, txHash });
  const circle = {
    estimate: async r=>{state.estimates++; assert(!('abiParameters' in r)); return { networkFee:state.fee };},
    execute: async r=>{ state.sends++;state.request=r;if(state.lose)throw new Error('response lost');return {...response(r),...(state.pending?{txHash:undefined,state:'PENDING'}:{})};},
    lookup: async r=>{state.reads++;assert.equal(r.idempotencyKey,state.request.idempotencyKey);return state.mismatch??response(state.request);},
  };
  const options = { client, circle, journal, config, ...overrides };
  return {state,values,options,adapter:createCircleAgentExecutor(options)};
}
test('raw calldata execution confirms exact repayment and does not resend the same operation',async()=>{
  const {adapter,state}=setup();const first=await adapter.execute(repay);assert.equal(first.status,'confirmed');assert.equal(state.request.callData,repay.data);
  assert.equal((await adapter.execute(repay)).txHash,txHash);assert.equal(state.sends,1);
});
test('lost Circle response survives adapter recreation and recovers without resending',async()=>{
  const {adapter,state,options}=setup();state.lose=true;
  const first=await adapter.execute(repay);assert.equal(first.status,'unknown');
  const resumed=createCircleAgentExecutor(options);assert.equal((await resumed.execute(repay)).status,'unknown');assert.equal(state.sends,1);
  await assert.rejects(()=>resumed.execute({...repay,operationId:'repay:other'}),/previous Circle operation/);
  assert.equal((await resumed.reconcile(first.key)).status,'confirmed');assert.equal(state.sends,1);
});
test('pending Circle transaction ID is journaled before receipt and retained on recovery',async()=>{
  const {adapter,state}=setup();state.pending=true;
  const first=await adapter.execute(repay);assert.equal(first.status,'unknown');assert.equal(first.transactionId,'circle-tx-1');
  assert.equal((await adapter.reconcile(first.key)).status,'confirmed');assert.equal(state.sends,1);
});
test('lookup timeout remains unresolved without a second execute',async()=>{
  const {adapter,state,options}=setup();state.lose=true;const first=await adapter.execute(repay);
  options.circle.lookup=async()=>{throw new Error('lookup offline');};
  await assert.rejects(()=>adapter.reconcile(first.key),/offline/);assert.equal((await adapter.execute(repay)).status,'unknown');assert.equal(state.sends,1);
});
test('wrong Circle response key, chain, sender, or destination cannot finalize',async()=>{
  for(const bad of [{idempotencyKey:'wrong'},{blockchain:'ARC'},{sourceAddress:provider},{contractAddress:provider}]){
    const {adapter,state}=setup();state.lose=true;const first=await adapter.execute(repay);
    state.mismatch={...state.request,id:'circle-tx-1',txHash,...bad};
    await assert.rejects(()=>adapter.reconcile(first.key),/Circle response/);assert.equal(state.sends,1);
  }
});
test('outer successful receipt without the agent repayment event is not completion',async()=>{
  for(const receipt of [
    {status:'success',blockNumber:101n,logs:[]},
    {status:'reverted',blockNumber:101n,logs:[]},
    {status:'success',blockNumber:99n,logs:[]},
    {status:'success',blockNumber:101n,logs:[eventLog('Repaid',{lineId,payer:provider,amount:50000n,principalRemaining:0n})]},
  ]){
    const {adapter,state}=setup();state.receipt=receipt;await assert.rejects(()=>adapter.execute(repay),/exact requested|reverted|predates/);assert.equal(state.sends,1);
  }
});
test('wrong network, deployment, line owner or excessive fees fail before submission',async()=>{
  for(const bad of [{chainId:5042001},{code:'0x6001'},{lineAgent:provider},{fee:'0.051'},{fee:'NaN'}]){
    const {adapter,state}=setup();Object.assign(state,bad);await assert.rejects(()=>adapter.execute(repay));assert.equal(state.sends,0);
  }
});
test('reject native value, foreign destinations, overspending, arbitrary approvals and trailing calldata',async()=>{
  const {adapter,state}=setup();
  for(const request of [
    {...repay,value:1n}, {...repay,to:provider}, {...repay,data:repay.data+'00'},
    {...repay,data:encodeFunctionData({abi,functionName:'repay',args:[lineId,50001n]})},
    {...repay,to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[provider,50000n]})},
    {...repay,data:encodeFunctionData({abi,functionName:'closeLine',args:[lineId]})},
  ])await assert.rejects(()=>adapter.execute(request));
  assert.equal(state.sends,0);
});
test('same operation ID cannot silently change amount',async()=>{
  const {adapter}=setup();await adapter.execute(repay);
  await assert.rejects(()=>adapter.execute({...repay,data:encodeFunctionData({abi,functionName:'repay',args:[lineId,1n]})}),/reused/);
});
test('new allowance cycle uses a distinct explicit operation ID',async()=>{
  const {adapter,state}=setup();state.receipt.logs=[eventLog('Approval',{owner:agent,spender:contract,value:50000n},usdc,erc20Abi)];
  const request={operationId:'approve:cycle1',to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,50000n]})};
  await adapter.execute(request);await adapter.execute({...request,operationId:'approve:cycle2'});assert.equal(state.sends,2);
});
test('purchase tuple is forwarded intact as calldata and matches the exact ProviderPaid digest',async()=>{
  const intent={agent,sponsor:provider,lineId,lineEpoch:1n,termsHash:digest,provider,endpointHash,principal:50000n,maximumTotalDebt:50000n,dueAt:1000n,nonce:9007199254740993n,signatureExpiry:900n,executor:agent};
  const request={operationId:'purchase:one',to:contract,data:encodeFunctionData({abi,functionName:'executeSpend',args:[intent,'0x1234']})};
  const {adapter,state}=setup();state.receipt.logs=[eventLog('ProviderPaid',{digest,lineId,provider,principal:50000n,dueAt:1000n})];
  assert.equal((await adapter.execute(request)).status,'confirmed');assert.equal(state.request.callData,request.data);
  for(const bad of [{policy:false},{receiptStatus:2}]){const x=setup();Object.assign(x.state,bad);await assert.rejects(()=>x.adapter.execute(request));assert.equal(x.state.sends,0);}
});
test('journal write failure prevents any Circle send',async()=>{
  const x=setup();x.options.journal.put=async()=>{throw new Error('disk full');};
  await assert.rejects(()=>x.adapter.execute(repay),/disk full/);assert.equal(x.state.sends,0);
});
test('file journal survives recreation, restricts file permissions and serializes independent instances',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shadow-circle-journal-'));
  try{
    const a=await createCircleAgentJournal(dir);await a.put('entry',{key:'stable'});
    const b=await createCircleAgentJournal(dir);assert.deepEqual(await b.get('entry'),{key:'stable'});
    for(const name of await readdir(dir))assert.equal((await stat(join(dir,name))).mode&0o777,0o600);
    await a.withLock('wallet',async()=>{await assert.rejects(()=>b.withLock('wallet',async()=>{}),/locked/);});
    await b.withLock('wallet',async()=>{});
  }finally{await rm(dir,{recursive:true,force:true});}
});
