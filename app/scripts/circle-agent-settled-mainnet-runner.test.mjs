import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256 } from 'viem';
import { parseSettledMainnetArgs, runSettledMainnetAgent, createSettledMainnetRunnerPurchase } from './shadow-circle-settled-mainnet.mjs';
import { createCircleSettledMainnetPurchaser, circleGuardedRepaymentAbi as abi } from './circle-agent-execution.mjs';
import { createSettledMainnetCircleOperations, createGuardedCircleOperations } from './circle-agent-guarded-operations.mjs';
import { SETTLED_MAINNET as deployment, SETTLED_MAINNET_SERVICE as service } from '../settledMainnetDeployment.mjs';
const agent=`0x${'11'.repeat(20)}`,line=`0x${'22'.repeat(32)}`,draw=`0x${'33'.repeat(32)}`;
const flags=['--agent',agent,'--line',line,'--state','/tmp/original-mainnet-journal'];
const guardFlags=['--monitor-baseline','/tmp/baseline','--monitor-manifest','/tmp/manifest','--monitor-state','/tmp/monitor','--session-policy','/tmp/session'];
test('mainnet parser requires original state and exact line; read-only commands cannot confirm',()=>{
 for(const cmd of ['doctor','inspect','recover']){
  const value=parseSettledMainnetArgs([cmd,...flags,...(cmd==='recover'?['--session-policy','/tmp/session']:[])]);assert.equal(value.state,'/tmp/original-mainnet-journal');assert.equal(value.line,line);
  assert.throws(()=>parseSettledMainnetArgs([cmd,...flags,'--confirm']),/read-only/);
 }
 assert.throws(()=>parseSettledMainnetArgs(['inspect','--agent',agent,'--line',line]),/original mainnet/);
 assert.throws(()=>parseSettledMainnetArgs(['doctor','--agent',agent,'--state','/tmp/state']),/nonzero mainnet line/);
 assert.throws(()=>parseSettledMainnetArgs(['setup','--agent',agent]),/cannot activate/);
});
test('mainnet purchase requires all monitor paths; previews and repayment do not require unpaused spend monitor',async()=>{
 assert.equal(parseSettledMainnetArgs(['purchase',...flags]).confirm,false);
 assert.throws(()=>parseSettledMainnetArgs(['purchase',...flags,'--confirm']),/all four/);
 const value=parseSettledMainnetArgs(['purchase',...flags,...guardFlags,'--confirm']);assert.equal(value.monitor.stateDir,'/tmp/monitor');
 assert.equal(parseSettledMainnetArgs(['repay',...flags,'--confirm']).confirm,true);
 assert.throws(()=>parseSettledMainnetArgs(['purchase',...flags,...guardFlags,'--monitor-state','/tmp/other','--confirm']),/repeated/);
 assert.match((await runSettledMainnetAgent({command:'help'})).help,/MAINNET/);
});
test('mainnet purchaser pins chain, deployment, runtime and bounded purchase fees',()=>{
 const config={chainId:5042,agent,contract:deployment.address,runtimeHash:deployment.runtimeHash,provider:service.provider,endpointHash:draw,expectedLineId:line,maxAmount:'5000',maxNetworkFee:'20000000000000000'};
 const options={config,authorizePurchase:async()=>{},journal:{get(){},put(){},withLock(){}},client:{},circle:{}};
 assert(createCircleSettledMainnetPurchaser(options));
 assert(createCircleSettledMainnetPurchaser({...options,config:{...config,maxNetworkFee:'40000000000000000'}}));
 for(const patch of [{chainId:5042002},{contract:agent},{runtimeHash:draw},{maxAmount:'50001'},{maxNetworkFee:'40000000000000001'}])assert.throws(()=>createCircleSettledMainnetPurchaser({...options,config:{...config,...patch}}));
 assert.throws(()=>createCircleSettledMainnetPurchaser({...options,authorizePurchase:null}),/monitor authorization/);
});
function operationsSetup(){
 const state={chainId:5042,agent,line,contract:deployment.address,requests:{}};
 const sent=[],remote=new Map();let persisted,allowance=0n,debt=5000n,currentDraw=draw;
 const executor={operationKey:r=>keccak256(r.data),execute:async r=>{
  assert(Object.values(persisted.requests).some(x=>x.request.data===r.data),'save original operation before send');
  const call= r.to===deployment.usdc ? 'approve' : 'repay';
  if(!remote.has(executor.operationKey(r))){sent.push(r);remote.set(executor.operationKey(r),{status:'confirmed',txHash:draw});if(call==='approve')allowance=5000n;else debt=0n;}
  return remote.get(executor.operationKey(r));
 },reconcile:async key=>remote.get(key)??{status:'unknown'}};
 const options={agent,line,state,purchaseExecutor:executor,makeRepayer:async plan=>{assert.equal(plan.draw,draw);return executor;},save:async()=>{persisted=structuredClone(state);},readLine:async()=>({agent,state:2,principalOutstanding:debt,drawDigest:currentDraw}),readAllowance:async()=>allowance};
 return {state,options,sent,changeDraw:value=>{currentDraw=value},getDebt:()=>debt};
}
test('mainnet operations reject testnet identity and persist original repayment draw before exact allowance and repay',async()=>{
 const x=operationsSetup();assert.throws(()=>createGuardedCircleOperations(x.options),/identity changed/);
 const ops=createSettledMainnetCircleOperations(x.options,service);
 const result=await ops.repay();assert.equal(result.reviewedDraw,draw);assert.equal(x.sent.length,2);assert.equal(x.getDebt(),0n);
 const repay=encodeFunctionData({abi,functionName:'repayForDraw',args:[line,draw,5000n]});assert.equal(x.sent[1].data,repay);
 assert.equal((await ops.repay()).status,'no-debt');assert.equal(x.sent.length,2);
});
test('mainnet restart recovery never sends and cannot rebind saved repayment to a newer draw',async()=>{
 const x=operationsSetup();x.state.guardedRepayment={version:1,line,draw,amount:'5000'};
 x.changeDraw(`0x${'44'.repeat(32)}`);
 await assert.rejects(()=>createSettledMainnetCircleOperations(x.options,service).repay(),/original repayment review/);assert.equal(x.sent.length,0);
 const data=encodeFunctionData({abi,functionName:'repayForDraw',args:[line,draw,5000n]});
 const request={operationId:`${line}:repay`,to:deployment.address,data,value:'0'};
 const key=keccak256(data);x.state.requests.repay={version:1,kind:'repay',request,draw,key};
 assert.equal((await createSettledMainnetCircleOperations(x.options,service).reconcile(key)).status,'unknown');assert.equal(x.sent.length,0);
});

test('the actual mainnet runner engine constructs on chain5042, while testnet and excessive prices are refused',()=>{
 const options={client:{},wallet:{},storage:{getItem:()=>null},config:{chainId:5042,account:agent,contract:deployment.address,runtimeHash:deployment.runtimeHash,...service}};
 assert.equal(createSettledMainnetRunnerPurchase(options).load(),null);
 for(const patch of [{chainId:5042002},{principal:'50001'}])assert.throws(()=>createSettledMainnetRunnerPurchase({...options,config:{...options.config,...patch}}),/Settled mainnet/);
});


test('mainnet purchase fee defaults stay at 0.02 and higher quotes require an explicit bounded option',()=>{
 assert.equal(parseSettledMainnetArgs(['purchase',...flags]).purchaseFeeUSDC,'0.02');
 for(const value of ['0.01','0.031070143','0.04'])
  assert.equal(parseSettledMainnetArgs(['purchase',...flags,'--purchase-fee-cap-usdc',value]).purchaseFeeUSDC,value);
 for(const value of ['0','-0.01','NaN','Infinity','1e-2','0.040000000000000001','1','0.0000000000000000001'])
  assert.throws(()=>parseSettledMainnetArgs(['purchase',...flags,'--purchase-fee-cap-usdc',value]));
 assert.throws(()=>parseSettledMainnetArgs(['purchase',...flags,'--purchase-fee-cap-usdc']),/invalid/);
 assert.throws(()=>parseSettledMainnetArgs(['purchase',...flags,'--purchase-fee-cap-usdc','0.04','--purchase-fee-cap-usdc','0.04']),/repeated/);
 for(const command of ['repay','recover','doctor','inspect'])
  assert.throws(()=>parseSettledMainnetArgs([command,...flags,'--purchase-fee-cap-usdc','0.04']),/only for purchase/);
});

test('settled release funding kit refuses an absent candidate before interacting with a wallet',async()=>{
 const {createSettledPublicMainnetFundingKit}=await import('../src/candidateFunding.ts');
 const kit=createSettledPublicMainnetFundingKit(deployment);
 await assert.rejects(()=>kit.verifyCandidate({getChainId:async()=>5042,getCode:async()=> '0x'}),/bytecode|release|candidate/i);
});
