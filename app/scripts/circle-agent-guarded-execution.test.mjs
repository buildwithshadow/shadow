import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpath, mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256, parseAbi, parseUnits } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import { circleGuardedRepaymentAbi as abi, createCircleGuardedRepayer, createCircleGuardedTestnetRepayer, createCircleGuardedTestnetPurchaser, createCircleAgentExecutor } from './circle-agent-execution.mjs';

import { createCircleAgentJournal } from './circle-agent-journal.mjs';
const agent = `0x${'11'.repeat(20)}`, contract = `0x${'22'.repeat(20)}`, provider = `0x${'33'.repeat(20)}`;
const lineId = `0x${'44'.repeat(32)}`, digest = `0x${'55'.repeat(32)}`, endpointHash = `0x${'66'.repeat(32)}`, txHash = `0x${'77'.repeat(32)}`;
const usdc = '0x3600000000000000000000000000000000000000';
const code = '0x6000';
const blockHash = `0x${'88'.repeat(32)}`;
const accountAbi = parseAbi(['function execute(address target,uint256 value,bytes data)']);
const config = { chainId: 5042, agent, contract, provider, endpointHash, runtimeHash: keccak256(code), maxAmount: '5000', expectedLineId:lineId,expectedDraw:digest, maxNetworkFee: parseUnits('0.02', 18).toString() };
const repay = { operationId: 'repay:one', to: contract, data: encodeFunctionData({ abi, functionName: 'repayForDraw', args: [lineId, digest, 5000n] }) };
function eventLog(eventName, args, address = contract, eventAbi = abi) {
  const event = eventAbi.find(x => x.type === 'event' && x.name === eventName);
  return { address, topics: encodeEventTopics({ abi: eventAbi, eventName, args }), data: encodeAbiParameters(event.inputs.filter(x => !x.indexed), event.inputs.filter(x => !x.indexed).map(x => args[x.name])) };
}
function setup(overrides = {}, factory = createCircleGuardedRepayer) {
  const activeConfig = overrides.config ?? config;
  const values = new Map(); let locked = false;
  const journal = { get: async k => structuredClone(values.get(k) ?? null), put: async(k,v) => { values.set(k, structuredClone(v)); }, withLock: async(_k,f) => { assert(!locked); locked=true; try{return await f();}finally{locked=false;} } };
  const state = { sends: 0, estimates: 0, reads: 0, lose: false, pending: false, fee: '0.01', chainId: activeConfig.chainId, policy: true, receiptStatus: 0, lineAgent: agent, code,
    finalized: 110n, canonicalHash: blockHash, userOpSuccess: true,
    receipt: { status: 'success', blockNumber: 101n, logs: [eventLog('Repaid', { lineId, payer: agent, amount: 5000n, principalRemaining: 0n }),eventLog('DrawRepaid',{lineId,drawDigest:digest,payer:agent,amount:5000n,principalRemaining:0n}),eventLog('Transfer',{from:agent,to:contract,value:5000n},usdc,erc20Abi)] } };
  const operation = () => ({sender:agent,nonce:1n,initCode:'0x',callData:encodeFunctionData({abi:accountAbi,functionName:'execute',args:[state.request.contractAddress,0n,state.request.callData]}),accountGasLimits:`0x${'00'.repeat(32)}`,preVerificationGas:1n,gasFees:`0x${'00'.repeat(32)}`,paymasterAndData:'0x',signature:'0x1234'});
  const boundary = (userOpHash=digest,success=state.userOpSuccess) => eventLog('UserOperationEvent',{userOpHash,sender:agent,paymaster:provider,nonce:1n,success,actualGasCost:1n,actualGasUsed:1n},entryPoint07Address,entryPoint07Abi);
  state.boundary=boundary;
  const before = () => eventLog('BeforeExecution',{},entryPoint07Address,entryPoint07Abi);
  const client = {
    getChainId: async()=>state.chainId, getCode: async()=>state.code,
    getBlock: async args=>args?.blockTag==='finalized'?{number:state.finalized}:args?.blockNumber?{number:args.blockNumber,hash:state.canonicalHash}:{number:100n},
    getTransaction: async()=>({to:entryPoint07Address,blockHash,input:encodeFunctionData({abi:entryPoint07Abi,functionName:'handleOps',args:[state.duplicateOps?[operation(),operation()]:[operation()],provider]})}),
    readContract: async({functionName})=>({ getLine:{agent:state.lineAgent,state:state.lineState??2,principalOutstanding:state.outstanding??5000n}, repaymentBindingVersion:2n,currentDrawDigest:state.draw??digest,openingsPaused:true,spendsPaused:true, hashSpendIntent:digest, getUserOpHash:digest, receiptStatus:state.receiptStatus })[functionName],
    simulateContract: async()=>({result:[state.policy,0]}),
    getTransactionReceipt: async()=>({...state.receipt,blockHash,logs:state.bundleLogs??[before(),...state.receipt.logs,boundary()]}),
  };
  const response = request => ({ idempotencyKey: request.idempotencyKey, id:'circle-tx-1', state:'COMPLETE', blockchain:activeConfig.chainId===5042?'ARC':'ARC-TESTNET', sourceAddress:agent, contractAddress:request.contractAddress, txHash });
  const circle = {
    estimate: async r=>{state.estimates++; assert(!('abiParameters' in r)); return { networkFee:state.fee };},
    execute: async r=>{ state.sends++;state.request=r;if(state.lose)throw new Error('response lost');return {...response(r),...(state.pending?{txHash:undefined,state:'PENDING'}:{})};},
    lookup: async r=>{state.reads++;assert.equal(r.idempotencyKey,state.request.idempotencyKey);return state.mismatch??response(state.request);},
  };
  const options = { client, circle, journal, config, ...overrides };
  return {state,values,options,adapter:factory(options)};
}
test('raw calldata execution confirms exact repayment and does not resend the same operation',async()=>{
  const {adapter,state}=setup();const first=await adapter.execute(repay);assert.equal(first.status,'confirmed');assert.equal(state.request.callData,repay.data);
  assert.equal((await adapter.execute(repay)).txHash,txHash);assert.equal(state.sends,1);
});
test('lost Circle response survives adapter recreation and recovers without resending',async()=>{
  const {adapter,state,options}=setup();state.lose=true;
  const first=await adapter.execute(repay);assert.equal(first.status,'unknown');
  const resumed=createCircleGuardedRepayer(options);assert.equal((await resumed.execute(repay)).status,'unknown');assert.equal(state.sends,1);
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
  for(const bad of [{idempotencyKey:'wrong'},{blockchain:'ARC-TESTNET'},{sourceAddress:provider},{contractAddress:provider}]){
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
    {status:'success',blockNumber:101n,logs:[eventLog('Repaid',{lineId,payer:provider,amount:5000n,principalRemaining:0n})]},
  ]){
    const {adapter,state}=setup();state.receipt=receipt;await assert.rejects(()=>adapter.execute(repay),/exact requested|reverted|predates|companion repayment/);assert.equal(state.sends,1);
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
    {...repay,data:encodeFunctionData({abi,functionName:'repayForDraw',args:[lineId,digest,5001n]})},
    {...repay,to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[provider,5000n]})},
    {...repay,data:encodeFunctionData({abi,functionName:'closeLine',args:[lineId]})},
  ])await assert.rejects(()=>adapter.execute(request));
  assert.equal(state.sends,0);
});
test('same operation ID cannot silently change amount',async()=>{
  const {adapter}=setup();await adapter.execute(repay);
  await assert.rejects(()=>adapter.execute({...repay,data:encodeFunctionData({abi,functionName:'repayForDraw',args:[lineId,digest,1n]})}),/reused|Amount exceeds/);
});
test('new allowance cycle uses a distinct explicit operation ID',async()=>{
  const {adapter,state}=setup();state.receipt.logs=[eventLog('Approval',{owner:agent,spender:contract,value:5000n},usdc,erc20Abi)];
  const request={operationId:'approve:cycle1',to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,5000n]})};
  await adapter.execute(request);await adapter.execute({...request,operationId:'approve:cycle2'});assert.equal(state.sends,2);
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
  await assert.rejects(()=>adapter.reconcile(result.key),/exact requested operation|companion repayment/);assert.equal(state.sends,1);
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
  const recovered=createCircleGuardedRepayer(x.options);assert.equal((await recovered.reconcile(first.key)).status,'not-submitted');
  x.options.circle.execute=send;
  assert.equal((await recovered.execute(repay)).status,'confirmed');assert.equal(x.state.sends,1);
});

test('stale reviewed draw is refused before estimate or submission',async()=>{const x=setup();x.state.draw=endpointHash;await assert.rejects(()=>x.adapter.execute(repay),/stale/);assert.equal(x.state.sends,0);assert.equal(x.state.estimates,0);});
test('draw changed during fee estimation is refused before submission',async()=>{const x=setup();x.options.circle.estimate=async()=>{x.state.draw=endpointHash;return {networkFee:'0.01'};};await assert.rejects(()=>x.adapter.execute(repay),/stale/);assert.equal(x.state.sends,0);});
test('wrong draw or payer cannot borrow correct companion events',async()=>{for(const bad of [{drawDigest:endpointHash},{payer:provider}]){const x=setup();x.state.receipt.logs[1]=eventLog('DrawRepaid',{lineId,drawDigest:digest,payer:agent,amount:5000n,principalRemaining:0n,...bad});await assert.rejects(()=>x.adapter.execute(repay),/exact requested|companion/);assert.equal(x.state.sends,1);}});
test('legacy generic repayment selector and purchasing are outside this adapter',async()=>{const x=setup();const legacy=parseAbi(['function repay(bytes32,uint256)']);await assert.rejects(()=>x.adapter.execute({...repay,data:encodeFunctionData({abi:legacy,functionName:'repay',args:[lineId,5000n]})}));await assert.rejects(()=>x.adapter.execute({...repay,data:encodeFunctionData({abi,functionName:'closeLine',args:[lineId]})}));assert.equal(x.state.sends,0);});


test('legacy factory still refuses mainnet; guarded factory refuses testnet and unbounded limits', () => {
  assert.throws(() => createCircleAgentExecutor({config:{...config,chainId:5042}}), /Only Arc testnet/);
  for (const patch of [{chainId:5042002},{maxAmount:'50001'},{maxNetworkFee:parseUnits('0.021',18).toString()},{expectedDraw:`0x${'00'.repeat(32)}`}]) {
    assert.throws(() => setup({config:{...config,...patch}}));
  }
});

const testnetConfig = { ...config, chainId: 5042002 };
const setupTestnet = () => setup({config:testnetConfig},createCircleGuardedTestnetRepayer);

test('guarded testnet repayment confirms the exact draw and preserves the original operation on restart',async()=>{
  const x=setupTestnet();x.state.lose=true;
  const first=await x.adapter.execute(repay);
  assert.equal(first.status,'unknown');assert.equal(x.state.request.blockchain,'ARC-TESTNET');
  const legacy=createCircleAgentExecutor(x.options);
  await assert.rejects(()=>legacy.execute({operationId:'legacy-new-approval',to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,5000n]})}),/previous Circle operation/);
  const originalKey=x.state.request.idempotencyKey;
  const restarted=createCircleGuardedTestnetRepayer(x.options);
  assert.equal((await restarted.execute(repay)).status,'unknown');
  await assert.rejects(()=>restarted.execute({...repay,operationId:'another'}),/previous Circle operation/);
  assert.equal((await restarted.reconcile(first.key)).status,'confirmed');
  assert.equal((await restarted.execute(repay)).status,'confirmed');
  assert.equal(x.state.sends,1);assert.equal(x.state.request.idempotencyKey,originalKey);
});

test('guarded testnet shares the legacy testnet wallet barrier and cannot recover it with changed semantics',async()=>{
  const x=setupTestnet();x.state.lose=true;
  const legacy=createCircleAgentExecutor(x.options);
  const approval={operationId:'legacy-approval',to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,5000n]})};
  const unknown=await legacy.execute(approval);
  assert.equal(unknown.status,'unknown');
  assert.equal(legacy.operationKey(approval),x.adapter.operationKey(approval));
  const snapshot=structuredClone([...x.values]);
  await assert.rejects(()=>x.adapter.execute(repay),/previous Circle operation/);
  await assert.rejects(()=>x.adapter.reconcile(unknown.key),/Journal repayment attribution/);
  assert.deepEqual([...x.values],snapshot);assert.equal(x.state.sends,1);assert.equal(x.state.reads,0);
});

test('guarded testnet refuses mainnet responses and keeps the unresolved wallet hold',async()=>{
  const x=setupTestnet();x.state.lose=true;const unknown=await x.adapter.execute(repay);
  x.state.mismatch={...x.state.request,id:'circle-tx-1',txHash,blockchain:'ARC'};
  await assert.rejects(()=>x.adapter.reconcile(unknown.key),/Circle response identity/);
  await assert.rejects(()=>x.adapter.execute({...repay,operationId:'another'}),/previous Circle operation/);
  assert.equal(x.state.sends,1);
});

test('explicit guarded testnet entry point retains guarded caps, network checks and stale-draw refusal',async()=>{
  for(const patch of [{chainId:5042},{chainId:1},{maxAmount:'50001'},{maxNetworkFee:parseUnits('0.030000000000000001',18).toString()}]){
    assert.throws(()=>setup({config:{...testnetConfig,...patch}},createCircleGuardedTestnetRepayer));
  }
  for(const patch of [{chainId:5042},{draw:endpointHash}]){
    const x=setupTestnet();Object.assign(x.state,patch);
    await assert.rejects(()=>x.adapter.execute(repay));assert.equal(x.state.sends,0);assert.equal(x.state.estimates,0);
  }
  const x=setupTestnet();
  const mainnet=createCircleGuardedRepayer({...x.options,config});
  assert.notEqual(mainnet.operationKey(repay),x.adapter.operationKey(repay));
});

test('guarded testnet repayment accepts the observed fee and exact 0.03 ceiling for the same draw',async()=>{
  for(const fee of ['0.020700798075','0.03']) {
    const x=setup({config:{...testnetConfig,maxNetworkFee:parseUnits('0.03',18).toString()}},createCircleGuardedTestnetRepayer);
    x.state.fee=fee;
    assert.equal((await x.adapter.execute(repay)).status,'confirmed');
    assert.equal((await x.adapter.execute(repay)).status,'confirmed');
    assert.equal(x.state.sends,1);assert.equal(x.state.request.callData,repay.data);
    assert.equal(x.state.request.blockchain,'ARC-TESTNET');assert.equal(x.state.request.amount,'0');
  }
});

test('guarded testnet repayment respects lower configured limits and preserves exact unsent records when excess fees are rejected',async()=>{
  for(const [cap,fee] of [['0.02','0.020700798075'],['0.03','0.030000000000000001']]) {
    const x=setup({config:{...testnetConfig,maxNetworkFee:parseUnits(cap,18).toString()}},createCircleGuardedTestnetRepayer);
    x.state.fee=fee;
    await assert.rejects(()=>x.adapter.execute(repay),error=>error.message.includes(`Quote: ${fee} USDC; cap: ${cap} USDC`));
    assert.equal(x.state.sends,0);assert.equal(x.values.size,1);
    assert.equal((await x.adapter.reconcile(x.adapter.operationKey(repay))).status,'not-submitted');
  }
  assert.throws(()=>setup({config:{...config,maxNetworkFee:parseUnits('0.03',18).toString()}}),/Invalid bounded execution limits/);
});

test('a higher testnet fee allowance cannot replace an unresolved repayment',async()=>{
  const x=setupTestnet();x.state.lose=true;
  const first=await x.adapter.execute(repay);assert.equal(first.status,'unknown');
  const originalKey=x.state.request.idempotencyKey;
  const resumed=createCircleGuardedTestnetRepayer({...x.options,config:{...testnetConfig,maxNetworkFee:parseUnits('0.03',18).toString()}});
  assert.equal((await resumed.execute(repay)).status,'unknown');
  assert.equal((await resumed.reconcile(first.key)).status,'confirmed');
  assert.equal(x.state.sends,1);assert.equal(x.state.request.idempotencyKey,originalKey);
});

test('guarded path never sends generic repayment, purchases, or owner controls', async () => {
  const x=setup();
  for (const data of [
    encodeFunctionData({abi:parseAbi(['function repay(bytes32,uint256)']),functionName:'repay',args:[lineId,5000n]}),
    encodeFunctionData({abi,functionName:'closeLine',args:[lineId]}),
  ]) await assert.rejects(() => x.adapter.execute({...repay,data}));
  assert.equal(x.state.sends,0);assert.equal(x.state.estimates,0);
});

test('a stale draw appearing during the fee quote prevents submission', async () => {
  const x=setup();x.options.circle.estimate=async()=>{x.state.draw=endpointHash;return {networkFee:'0.01'};};
  await assert.rejects(()=>x.adapter.execute(repay),/stale/);assert.equal(x.state.sends,0);
});

test('draw-bound repayment remains available while paused or defaulted, including partial repayment', async () => {
  const x=setup();x.state.lineState=3;x.state.outstanding=6000n;
  x.state.receipt.logs=[eventLog('Repaid',{lineId,payer:agent,amount:5000n,principalRemaining:1000n}),eventLog('DrawRepaid',{lineId,drawDigest:digest,payer:agent,amount:5000n,principalRemaining:1000n}),eventLog('Transfer',{from:agent,to:contract,value:5000n},usdc,erc20Abi)];
  assert.equal((await x.adapter.execute(repay)).status,'confirmed');assert.equal(x.state.sends,1);
});

test('saved repayment attribution cannot silently change while the request hash stays intact', async () => {
  const x=setup();x.state.lose=true;const first=await x.adapter.execute(repay);
  const entry=x.values.get(first.key);entry.expected.digest=endpointHash;x.values.set(first.key,entry);
  await assert.rejects(()=>x.adapter.reconcile(first.key),/attribution changed/);
  await assert.rejects(()=>x.adapter.execute(repay),/attribution changed/);assert.equal(x.state.sends,1);
});

test('disk-backed lost repayment survives independent journal/adapter recreation without a second send', async () => {
  const sandbox=await mkdtemp(join(await realpath(tmpdir()),'shadow-guarded-repayment-')),dir=join(sandbox,'journal');
  try {
    const journal=await createCircleAgentJournal(dir,{identityDirectory:join(sandbox,'identities')});const x=setup({journal});x.state.lose=true;
    const first=await x.adapter.execute(repay);assert.equal(first.status,'unknown');
    const restoredJournal=await createCircleAgentJournal(dir,{identityDirectory:join(sandbox,'identities')});
    const restored=createCircleGuardedRepayer({...x.options,journal:restoredJournal});
    assert.equal((await restored.execute(repay)).status,'unknown');
    await assert.rejects(()=>restored.execute({...repay,operationId:'repay:replacement'}),/previous Circle operation/);
    assert.equal((await restored.reconcile(first.key)).status,'confirmed');assert.equal(x.state.sends,1);
  } finally {await rm(sandbox,{recursive:true,force:true});}
});


const purchaseIntent = {agent, sponsor: provider, lineId, lineEpoch:1n, termsHash:digest, provider, endpointHash, principal:5000n, maximumTotalDebt:5000n, dueAt:1000n, nonce:0n, signatureExpiry:900n, executor:agent};
const purchaseRequest = {operationId:'guarded-purchase:one',to:contract,data:encodeFunctionData({abi,functionName:'executeSpend',args:[purchaseIntent,'0x1234']})};
function setupPurchase(configPatch = {}) {
  const x=setup({config:{...testnetConfig,...configPatch}},createCircleGuardedTestnetPurchaser);
  x.state.lineState=1;x.state.outstanding=0n;
  x.state.receipt.logs=[eventLog('ProviderPaid',{digest,lineId,provider,principal:5000n,dueAt:1000n})];
  return x;
}
test('guarded testnet purchase recovers one exact user operation after lost confirmation',async()=>{
  const x=setupPurchase();x.state.lose=true;
  const held=await x.adapter.execute(purchaseRequest);assert.equal(held.status,'unknown');
  const resumed=createCircleGuardedTestnetPurchaser(x.options);
  assert.equal((await resumed.execute(purchaseRequest)).status,'unknown');
  assert.equal((await resumed.reconcile(held.key)).status,'confirmed');
  assert.equal((await resumed.execute(purchaseRequest)).status,'confirmed');
  assert.equal(x.state.sends,1);assert.equal(x.state.request.blockchain,'ARC-TESTNET');
});
test('guarded purchase disallows mainnet, extra value, changed line/provider/price and all repayment or allowance calls',async()=>{
  assert.throws(()=>createCircleGuardedTestnetPurchaser({config}),/Only Arc testnet/);
  for(const patch of [{maxAmount:'5001'},{expectedLineId:`0x${'00'.repeat(32)}`},{maxNetworkFee:parseUnits('0.050000000000000001',18).toString()}]) {
    assert.throws(()=>setup({config:{...testnetConfig,...patch}},createCircleGuardedTestnetPurchaser));
  }
  const x=setupPurchase();
  for(const patch of [{lineId:endpointHash},{provider:agent},{principal:4999n},{maximumTotalDebt:5001n},{executor:provider}]) {
    await assert.rejects(()=>x.adapter.execute({...purchaseRequest,data:encodeFunctionData({abi,functionName:'executeSpend',args:[{...purchaseIntent,...patch},'0x1234']})}));
  }
  for(const request of [repay,{...purchaseRequest,value:1n},{...purchaseRequest,data:purchaseRequest.data+'00'},
    {...purchaseRequest,to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,5000n]})}]) await assert.rejects(()=>x.adapter.execute(request));
  assert.equal(x.state.sends,0);assert.equal(x.state.estimates,0);
});
test('guarded testnet purchase accepts its observed fee and the exact 0.05 ceiling without increasing principal',async()=>{
  for (const fee of ['0.0430571714625','0.05']) {
    const x=setupPurchase({maxNetworkFee:parseUnits('0.05',18).toString()});x.state.fee=fee;
    assert.equal((await x.adapter.execute(purchaseRequest)).status,'confirmed');
    assert.equal(x.state.sends,1);assert.equal(x.state.request.blockchain,'ARC-TESTNET');
    assert.equal(x.state.request.amount,'0');assert.equal(x.state.request.callData,purchaseRequest.data);
  }
});
test('guarded purchase still honors a lower configured fee and refuses an excessive quote before journaling a send',async()=>{
  for (const [cap,fee] of [['0.02','0.0430571714625'],['0.05','0.050000000000000001']]) {
    const x=setupPurchase({maxNetworkFee:parseUnits(cap,18).toString()});x.state.fee=fee;
    await assert.rejects(()=>x.adapter.execute(purchaseRequest),error=>error.message.includes(`Quote: ${fee} USDC; cap: ${cap} USDC`));
    assert.equal(x.state.sends,0);assert.equal(x.values.size,1);
  }
});
test('the purchase fee ceiling does not extend either guarded repayment adapter',()=>{
  for (const [factory,base] of [[createCircleGuardedRepayer,config],[createCircleGuardedTestnetRepayer,testnetConfig]]) {
    assert.throws(()=>setup({config:{...base,maxNetworkFee:parseUnits('0.05',18).toString()}},factory),/Invalid bounded execution limits/);
  }
});
test('guarded purchase refuses non guarded deployments and changed debt both before and after fee estimation',async()=>{
  for(const stage of ['before','estimate']) {
    const x=setupPurchase();const change=()=>{x.state.lineState=2;x.state.outstanding=5000n;};
    if(stage==='before')change();else x.options.circle.estimate=async()=>{change();return {networkFee:'0.01'};};
    await assert.rejects(()=>x.adapter.execute(purchaseRequest),/open agent line/);assert.equal(x.state.sends,0);
  }
  const x=setupPurchase(),read=x.options.client.readContract;
  x.options.client.readContract=async args=>args.functionName==='repaymentBindingVersion'?1n:read(args);
  await assert.rejects(()=>x.adapter.execute(purchaseRequest),/binding version/);assert.equal(x.state.estimates,0);
});
test('unresolved guarded purchase blocks repayment and a new legacy testnet operation',async()=>{
  const x=setupPurchase();x.state.lose=true;const held=await x.adapter.execute(purchaseRequest);
  const repayer=createCircleGuardedTestnetRepayer(x.options);
  await assert.rejects(()=>repayer.execute(repay),/previous Circle operation/);
  await assert.rejects(()=>repayer.reconcile(held.key),/Unsupported Shadow operation/);
  const legacy=createCircleAgentExecutor(x.options);
  await assert.rejects(()=>legacy.execute({operationId:'other',to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,5000n]})}),/previous Circle operation/);
  assert.equal(x.state.sends,1);
});
test('guarded purchaser cannot reinterpret a legacy allowance journal or another deployment',async()=>{
  const x=setupPurchase();x.state.lose=true;
  const legacy=createCircleAgentExecutor(x.options);
  const held=await legacy.execute({operationId:'legacy:approval',to:usdc,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,5000n]})});
  const snapshot=structuredClone([...x.values]);
  await assert.rejects(()=>x.adapter.reconcile(held.key),/Only a guarded purchase/);
  await assert.rejects(()=>x.adapter.execute(purchaseRequest),/previous Circle operation/);
  assert.deepEqual([...x.values],snapshot);
});
test('guarded purchase completion cannot borrow a different digest or a neighboring user operation',async()=>{
  const x=setupPurchase();x.state.receipt.logs=[eventLog('ProviderPaid',{digest:endpointHash,lineId,provider,principal:5000n,dueAt:1000n})];
  await assert.rejects(()=>x.adapter.execute(purchaseRequest),/exact requested operation/);
  const held=await x.adapter.execute(purchaseRequest);assert.equal(held.status,'unknown');
  const before=eventLog('BeforeExecution',{},entryPoint07Address,entryPoint07Abi);
  x.state.bundleLogs=[before,eventLog('ProviderPaid',{digest,lineId,provider,principal:5000n,dueAt:1000n}),x.state.boundary(endpointHash,true),x.state.boundary(digest,true)];
  await assert.rejects(()=>x.adapter.reconcile(held.key),/exact requested operation/);assert.equal(x.state.sends,1);
});


test('fee rejection leaves a durable exact unsent record across adapter recreation',async()=>{
 const x=setup();x.state.fee='0.031070143';
 await assert.rejects(()=>x.adapter.execute(repay),/Estimated fee/);
 const key=x.adapter.operationKey(repay),saved=await x.options.journal.get(key);
 assert(saved,'Fee rejection must preserve an exact original execution record');
 assert.equal(saved.notSubmitted,true);assert.equal(saved.request.callData,repay.data);
 assert.equal(saved.expected.operation,'repayForDraw');assert.equal(saved.txHash,undefined);
 const restored=createCircleGuardedRepayer(x.options);
 assert.equal((await restored.reconcile(key)).status,'not-submitted');
 assert.equal(x.state.sends,0);assert.equal(x.state.reads,0);
});


test('read-only quote failure is retained while transport uncertainty stays unresolved',async()=>{
 const x=setup();x.options.circle.estimate=async()=>{throw Error('quote unavailable')};
 await assert.rejects(()=>x.adapter.execute(repay),/quote unavailable/);
 const key=x.adapter.operationKey(repay);assert.equal((await x.options.journal.get(key)).notSubmitted,true);
 assert.equal((await createCircleGuardedRepayer(x.options).reconcile(key)).status,'not-submitted');
 assert.equal(x.state.sends,0);
});
