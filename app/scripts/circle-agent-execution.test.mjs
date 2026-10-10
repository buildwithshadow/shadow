import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpath, mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256, parseAbi, parseUnits } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import abi from './float-mainnet-abi.json' with { type: 'json' };
import { createCircleAgentExecutor } from './circle-agent-execution.mjs';
import { setupCircleAgentWallet } from './circle-agent-setup.mjs';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';
const agent = `0x${'11'.repeat(20)}`, contract = `0x${'22'.repeat(20)}`, provider = `0x${'33'.repeat(20)}`;
const lineId = `0x${'44'.repeat(32)}`, digest = `0x${'55'.repeat(32)}`, endpointHash = `0x${'66'.repeat(32)}`, txHash = `0x${'77'.repeat(32)}`;
const usdc = '0x3600000000000000000000000000000000000000';
const code = '0x6000';
const blockHash = `0x${'88'.repeat(32)}`;
const accountAbi = parseAbi(['function execute(address target,uint256 value,bytes data)']);
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
    finalized: 110n, canonicalHash: blockHash, userOpSuccess: true,
    receipt: { status: 'success', blockNumber: 101n, logs: [eventLog('Repaid', { lineId, payer: agent, amount: 50000n, principalRemaining: 0n })] } };
  const operation = () => ({sender:agent,nonce:1n,initCode:'0x',callData:encodeFunctionData({abi:accountAbi,functionName:'execute',args:[state.request.contractAddress,0n,state.request.callData]}),accountGasLimits:`0x${'00'.repeat(32)}`,preVerificationGas:1n,gasFees:`0x${'00'.repeat(32)}`,paymasterAndData:'0x',signature:'0x1234'});
  const boundary = (userOpHash=digest,success=state.userOpSuccess) => eventLog('UserOperationEvent',{userOpHash,sender:agent,paymaster:provider,nonce:1n,success,actualGasCost:1n,actualGasUsed:1n},entryPoint07Address,entryPoint07Abi);
  state.boundary=boundary;
  const before = () => eventLog('BeforeExecution',{},entryPoint07Address,entryPoint07Abi);
  const client = {
    getChainId: async()=>state.chainId, getCode: async()=>state.code,
    getBlock: async args=>args?.blockTag==='finalized'?{number:state.finalized}:args?.blockNumber?{number:args.blockNumber,hash:state.canonicalHash}:{number:100n},
    getTransaction: async()=>({to:entryPoint07Address,blockHash,input:encodeFunctionData({abi:entryPoint07Abi,functionName:'handleOps',args:[state.duplicateOps?[operation(),operation()]:[operation()],provider]})}),
    readContract: async({functionName})=>({ lines:[provider,state.lineAgent], hashSpendIntent:digest, getUserOpHash:digest, receiptStatus:state.receiptStatus })[functionName],
    simulateContract: async()=>({result:[state.policy,0]}),
    getTransactionReceipt: async()=>({...state.receipt,blockHash,logs:state.bundleLogs??[before(),...state.receipt.logs,boundary()]}),
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
test('an identical event in another bundled operation cannot prove the requested operation',async()=>{
  const {adapter,state}=setup();
  const before=eventLog('BeforeExecution',{},entryPoint07Address,entryPoint07Abi);
  const other=`0x${'99'.repeat(32)}`;
  state.bundleLogs=[before,...state.receipt.logs,state.boundary(other,true),state.boundary(digest,false)];
  await assert.rejects(()=>adapter.execute(repay),/user operation did not succeed/);
  // Even a successful requested operation with no own Repaid log cannot borrow another operation's event.
  state.bundleLogs=[before,...state.receipt.logs,state.boundary(other,true),state.boundary(digest,true)];
  const result=await adapter.execute(repay);assert.equal(result.status,'unknown');
  await assert.rejects(()=>adapter.reconcile(result.key),/exact requested operation/);assert.equal(state.sends,1);
});
test('duplicate identical calls in a bundle remain ambiguous',async()=>{
  const {adapter,state}=setup();state.duplicateOps=true;
  await assert.rejects(()=>adapter.execute(repay),/unique matching user operation/);
});
test('unfinalized inclusion retains the barrier and can be reconciled after finality',async()=>{
  const {adapter,state}=setup();state.finalized=100n;
  await assert.rejects(()=>adapter.execute(repay),/canonical and finalized/);
  const held=await adapter.execute(repay);assert.equal(held.status,'unknown');
  await assert.rejects(()=>adapter.execute({...repay,operationId:'other'}),/previous Circle operation/);
  state.finalized=110n;assert.equal((await adapter.reconcile(held.key)).status,'confirmed');assert.equal(state.sends,1);
});
test('cached success is revalidated against canonical chain before being returned',async()=>{
  const {adapter,state}=setup();const done=await adapter.execute(repay);
  state.canonicalHash=`0x${'99'.repeat(32)}`;
  await assert.rejects(()=>adapter.execute(repay),/canonical and finalized/);
  await assert.rejects(()=>adapter.reconcile(done.key),/canonical and finalized/);assert.equal(state.sends,1);
});
test('file journal survives recreation, restricts file permissions and serializes independent instances',async()=>{
  const sandbox=await mkdtemp(join(await realpath(tmpdir()),'shadow-circle-journal-')),dir=join(sandbox,'journal');
  try{
    const a=await createCircleAgentJournal(dir,{identityDirectory:join(sandbox,'identities')});await a.put('entry',{key:'stable'});
    const b=await createCircleAgentJournal(dir,{identityDirectory:join(sandbox,'identities')});assert.deepEqual(await b.get('entry'),{key:'stable'});
    for(const name of await readdir(dir))assert.equal((await stat(join(dir,name))).mode&0o777,0o600);
    await a.withLock('wallet',async()=>{await assert.rejects(()=>b.withLock('wallet',async()=>{}),/locked/);});
    await b.withLock('wallet',async()=>{});
  }finally{await rm(sandbox,{recursive:true,force:true});}
});

test('preflight rejection can be reconciled as unsent without a Circle request',async()=>{
  const {adapter,state}=setup();state.fee='1';
  await assert.rejects(()=>adapter.execute(repay),/Estimated fee/);
  assert.equal((await adapter.reconcile(adapter.operationKey(repay))).status,'not-submitted');
  assert.equal(state.sends,0);assert.equal(state.reads,0);
  state.fee='0.01';assert.equal((await adapter.execute(repay)).status,'confirmed');assert.equal(state.sends,1);
});
test('a partial durable barrier cannot be classified as an unsent operation',async()=>{
  const {adapter,state,options}=setup();const put=options.journal.put;
  options.journal.put=async(k,v)=>{if(v?.request)throw new Error('disk failure');return put(k,v);};
  await assert.rejects(()=>adapter.execute(repay),/disk failure/);
  await assert.rejects(()=>adapter.reconcile(adapter.operationKey(repay)),/barrier exists/);
  options.journal.put=put;
  await assert.rejects(()=>adapter.execute(repay),/barrier exists/);
  assert.equal(state.sends,0);
});

test('definite transport pre-send failure releases barrier and survives recreation',async()=>{
  const x=setup();const send=x.options.circle.execute;
  x.options.circle.execute=async()=>{const e=new Error('session expired');e.beforeSubmission=true;throw e;};
  const first=await x.adapter.execute(repay);assert.equal(first.status,'not-submitted');assert.equal(x.state.sends,0);
  const recovered=createCircleAgentExecutor(x.options);assert.equal((await recovered.reconcile(first.key)).status,'not-submitted');
  x.options.circle.execute=send;
  assert.equal((await recovered.execute(repay)).status,'confirmed');assert.equal(x.state.sends,1);
});
test('an exact finalized SpendBlocked is terminal without accepting unrelated refusals',async()=>{
  const intent={agent,sponsor:provider,lineId,lineEpoch:1n,termsHash:digest,provider,endpointHash,principal:50000n,maximumTotalDebt:50000n,dueAt:1000n,nonce:1n,signatureExpiry:900n,executor:agent};
  const request={operationId:'blocked:one',to:contract,data:encodeFunctionData({abi,functionName:'executeSpend',args:[intent,'0x1234']})};
  for(const wrong of [false,true]){
    const x=setup();const send=x.options.circle.execute;
    x.options.circle.execute=async r=>{const out=await send(r);x.state.receiptStatus=1;return out;};
    x.state.receipt.logs=[eventLog('SpendBlocked',{digest:wrong?endpointHash:digest,lineId,nonce:1n,reason:1})];
    if(wrong){await assert.rejects(()=>x.adapter.execute(request),/exact requested/);continue;}
    const result=await x.adapter.execute(request);assert.equal(result.status,'blocked');
    assert.equal((await createCircleAgentExecutor(x.options).reconcile(result.key)).status,'blocked');assert.equal(x.state.sends,1);
    x.state.receipt.logs=[eventLog('Repaid',{lineId,payer:agent,amount:50000n,principalRemaining:0n})];
    assert.equal((await x.adapter.execute(repay)).status,'confirmed');
  }
});

test('ambiguous activation blocks later executor writes until wallet deployment is finalized', async () => {
  const { adapter, state, options } = setup();
  let deployed = false;
  options.client.getCode = async ({ address, blockTag }) => {
    if (address === agent) {
      assert.equal(blockTag, 'finalized');
      return deployed ? code : '0x';
    }
    return code;
  };
  options.client.getBalance = async () => parseUnits('1', 18);
  let activations = 0;
  const activationCircle = {
    session: async () => {}, estimateActivation: async () => ({ networkFee: '0.01' }),
    activate: async () => { activations++; throw new Error('response lost'); },
  };
  assert.equal((await setupCircleAgentWallet({ ...options, agent, circle: activationCircle, confirm: true })).status, 'unknown');
  // Recreating the executor must not remove the persistent activation barrier.
  await assert.rejects(() => createCircleAgentExecutor(options).execute(repay), /activation to finalize/);
  assert.equal(state.estimates, 0); assert.equal(state.sends, 0); assert.equal(activations, 1);
  deployed = true;
  assert.equal((await adapter.execute(repay)).status, 'confirmed');
  assert.equal(state.sends, 1); assert.equal(activations, 1);
});
