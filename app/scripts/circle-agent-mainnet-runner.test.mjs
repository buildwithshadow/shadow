import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256 } from 'viem';
import { parseGuardedMainnetArgs, runGuardedMainnetAgent, createMainnetRunnerPurchase } from './shadow-circle-guarded-mainnet.mjs';
import { createCircleGuardedMainnetPurchaser, circleGuardedRepaymentAbi as abi } from './circle-agent-execution.mjs';
import { createGuardedMainnetCircleOperations, createGuardedCircleOperations } from './circle-agent-guarded-operations.mjs';
import { GUARDED_MAINNET as deployment, GUARDED_MAINNET_SERVICE as service } from '../src/guardedMainnet.ts';
const agent=`0x${'11'.repeat(20)}`,line=`0x${'22'.repeat(32)}`,draw=`0x${'33'.repeat(32)}`;
const flags=['--agent',agent,'--line',line,'--state','/tmp/original-mainnet-journal'];
const guardFlags=['--monitor-baseline','/tmp/baseline','--monitor-manifest','/tmp/manifest','--monitor-state','/tmp/monitor','--session-policy','/tmp/session'];
test('mainnet parser requires original state and exact line; read-only commands cannot confirm',()=>{
 for(const cmd of ['doctor','inspect','recover']){
  const value=parseGuardedMainnetArgs([cmd,...flags,...(cmd==='recover'?['--session-policy','/tmp/session']:[])]);assert.equal(value.state,'/tmp/original-mainnet-journal');assert.equal(value.line,line);
  assert.throws(()=>parseGuardedMainnetArgs([cmd,...flags,'--confirm']),/read-only/);
 }
 assert.throws(()=>parseGuardedMainnetArgs(['inspect','--agent',agent,'--line',line]),/original mainnet/);
 assert.throws(()=>parseGuardedMainnetArgs(['doctor','--agent',agent,'--state','/tmp/state']),/nonzero mainnet line/);
 assert.throws(()=>parseGuardedMainnetArgs(['setup','--agent',agent]),/cannot activate/);
});
test('mainnet purchase requires all monitor paths; previews and repayment do not require unpaused spend monitor',async()=>{
 assert.equal(parseGuardedMainnetArgs(['purchase',...flags]).confirm,false);
 assert.throws(()=>parseGuardedMainnetArgs(['purchase',...flags,'--confirm']),/all four/);
 const value=parseGuardedMainnetArgs(['purchase',...flags,...guardFlags,'--confirm']);assert.equal(value.monitor.stateDir,'/tmp/monitor');
 assert.equal(parseGuardedMainnetArgs(['repay',...flags,'--confirm']).confirm,true);
 assert.throws(()=>parseGuardedMainnetArgs(['purchase',...flags,...guardFlags,'--monitor-state','/tmp/other','--confirm']),/repeated/);
 assert.match((await runGuardedMainnetAgent({command:'help'})).help,/MAINNET/);
});
test('mainnet purchaser pins chain, deployment, runtime and bounded purchase fees',()=>{
 const config={chainId:5042,agent,contract:deployment.address,runtimeHash:deployment.runtimeHash,provider:service.provider,endpointHash:draw,expectedLineId:line,maxAmount:'5000',maxNetworkFee:'20000000000000000'};
 const options={config,authorizePurchase:async()=>{},journal:{get(){},put(){},withLock(){}},client:{},circle:{}};
 assert(createCircleGuardedMainnetPurchaser(options));
 assert(createCircleGuardedMainnetPurchaser({...options,config:{...config,maxNetworkFee:'40000000000000000'}}));
 for(const patch of [{chainId:5042002},{contract:agent},{runtimeHash:draw},{maxAmount:'5001'},{maxNetworkFee:'40000000000000001'}])assert.throws(()=>createCircleGuardedMainnetPurchaser({...options,config:{...config,...patch}}));
 assert.throws(()=>createCircleGuardedMainnetPurchaser({...options,authorizePurchase:null}),/monitor authorization/);
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
 const ops=createGuardedMainnetCircleOperations(x.options);
 const result=await ops.repay();assert.equal(result.reviewedDraw,draw);assert.equal(x.sent.length,2);assert.equal(x.getDebt(),0n);
 const repay=encodeFunctionData({abi,functionName:'repayForDraw',args:[line,draw,5000n]});assert.equal(x.sent[1].data,repay);
 assert.equal((await ops.repay()).status,'no-debt');assert.equal(x.sent.length,2);
});
test('mainnet restart recovery never sends and cannot rebind saved repayment to a newer draw',async()=>{
 const x=operationsSetup();x.state.guardedRepayment={version:1,line,draw,amount:'5000'};
 x.changeDraw(`0x${'44'.repeat(32)}`);
 await assert.rejects(()=>createGuardedMainnetCircleOperations(x.options).repay(),/original repayment review/);assert.equal(x.sent.length,0);
 const data=encodeFunctionData({abi,functionName:'repayForDraw',args:[line,draw,5000n]});
 const request={operationId:`${line}:repay`,to:deployment.address,data,value:'0'};
 const key=keccak256(data);x.state.requests.repay={version:1,kind:'repay',request,draw,key};
 assert.equal((await createGuardedMainnetCircleOperations(x.options).reconcile(key)).status,'unknown');assert.equal(x.sent.length,0);
});

test('the actual mainnet runner engine constructs on chain5042, while testnet and excessive prices are refused',()=>{
 const options={client:{},wallet:{},storage:{getItem:()=>null},config:{chainId:5042,account:agent,contract:deployment.address,runtimeHash:deployment.runtimeHash,...service}};
 assert.equal(createMainnetRunnerPurchase(options).load(),null);
 for(const patch of [{chainId:5042002},{principal:'5001'}])assert.throws(()=>createMainnetRunnerPurchase({...options,config:{...options.config,...patch}}),/Guarded mainnet/);
});


test('mainnet purchase fee defaults stay at 0.02 and higher quotes require an explicit bounded option',()=>{
 assert.equal(parseGuardedMainnetArgs(['purchase',...flags]).purchaseFeeUSDC,'0.02');
 for(const value of ['0.01','0.031070143','0.04'])
  assert.equal(parseGuardedMainnetArgs(['purchase',...flags,'--purchase-fee-cap-usdc',value]).purchaseFeeUSDC,value);
 for(const value of ['0','-0.01','NaN','Infinity','1e-2','0.040000000000000001','1','0.0000000000000000001'])
  assert.throws(()=>parseGuardedMainnetArgs(['purchase',...flags,'--purchase-fee-cap-usdc',value]));
 assert.throws(()=>parseGuardedMainnetArgs(['purchase',...flags,'--purchase-fee-cap-usdc']),/invalid/);
 assert.throws(()=>parseGuardedMainnetArgs(['purchase',...flags,'--purchase-fee-cap-usdc','0.04','--purchase-fee-cap-usdc','0.04']),/repeated/);
 for(const command of ['repay','recover','doctor','inspect'])
  assert.throws(()=>parseGuardedMainnetArgs([command,...flags,'--purchase-fee-cap-usdc','0.04']),/only for purchase/);
});
