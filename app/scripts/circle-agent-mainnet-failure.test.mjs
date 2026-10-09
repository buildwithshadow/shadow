import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData,encodeEventTopics,encodeAbiParameters,hashTypedData,parseAbi } from 'viem';
import { entryPoint07Abi,entryPoint07Address } from 'viem/account-abstraction';
import { floatAbi,SPEND_INTENT_TYPES,eip712Domain } from './float-mainnet-config.mjs';
import { readFailedCircleSessionAttempt } from './circle-agent-mainnet-failure.mjs';
const agent=`0x${'11'.repeat(20)}`,contract=`0x${'22'.repeat(20)}`,provider=`0x${'33'.repeat(20)}`,line=`0x${'44'.repeat(32)}`,txHash=`0x${'55'.repeat(32)}`,blockHash=`0x${'66'.repeat(32)}`,userOpHash=`0x${'77'.repeat(32)}`;
const accountAbi=parseAbi(['function execute(address target,uint256 value,bytes data)']);
function setup(){
 const message={agent,executor:agent,sponsor:provider,provider,lineId:line,lineEpoch:1n,termsHash:line,endpointHash:line,principal:5000n,maximumTotalDebt:5000n,dueAt:1000n,nonce:0n,signatureExpiry:900n};
 const digest=hashTypedData({domain:eip712Domain(5042n,contract),types:SPEND_INTENT_TYPES,primaryType:'SpendIntent',message});
 const operation={sender:agent,nonce:1n,initCode:'0x',callData:encodeFunctionData({abi:accountAbi,functionName:'execute',args:[contract,0n,encodeFunctionData({abi:floatAbi,functionName:'executeSpend',args:[message,'0x1234']})]}),accountGasLimits:line,preVerificationGas:1n,gasFees:line,paymasterAndData:'0x',signature:'0x1234'};
 const event=(name,args,index)=>{const e=entryPoint07Abi.find(e=>e.type==='event'&&e.name===name);return {address:entryPoint07Address,logIndex:index,topics:encodeEventTopics({abi:entryPoint07Abi,eventName:name,args}),data:encodeAbiParameters(e.inputs.filter(i=>!i.indexed),e.inputs.filter(i=>!i.indexed).map(i=>args[i.name]))}};
 const receipt={transactionHash:txHash,blockHash,blockNumber:100n,status:'success',logs:[event('BeforeExecution',{},0),event('UserOperationEvent',{userOpHash,sender:agent,paymaster:provider,nonce:1n,success:false,actualGasCost:1n,actualGasUsed:1n},1)]};
 const tx={hash:txHash,to:entryPoint07Address,blockHash,blockNumber:100n,input:encodeFunctionData({abi:entryPoint07Abi,functionName:'handleOps',args:[[operation],provider]})};
 const state={finalized:101n,canonical:blockHash};
 const connection={chainId:5042n,address:contract,client:{getTransaction:async()=>tx,getBlock:async args=>args.blockTag==='finalized'?{number:state.finalized}:{number:100n,hash:state.canonical},readContract:async()=>userOpHash}};
 return {connection,entry:{message,digest,txHash},receipt,tx,state,operation};
}
test('exact failed Circle operation is terminal despite successful outer bundle',async()=>{
 const x=setup();assert.equal(await readFailedCircleSessionAttempt(x.connection,x.entry,x.receipt),'failed-user-operation');
});
test('exact reverted bundle is identified without claiming a payment',async()=>{
 const x=setup();x.receipt.status='reverted';x.receipt.logs=[];assert.equal(await readFailedCircleSessionAttempt(x.connection,x.entry,x.receipt),'reverted');
});
test('unrelated sender, modified calldata, duplicated matching operations, reorg and unfinalized failures stay held',async()=>{
 for(const change of [x=>{x.entry.message.agent=provider},x=>{x.tx.input=encodeFunctionData({abi:entryPoint07Abi,functionName:'handleOps',args:[[{...x.operation,callData:'0x1234'}],provider]})},x=>{x.tx.input=encodeFunctionData({abi:entryPoint07Abi,functionName:'handleOps',args:[[x.operation,x.operation],provider]})},x=>{x.state.canonical=line},x=>{x.state.finalized=99n},x=>{x.receipt.transactionHash=line}]){
  const x=setup();change(x);
  if(x.entry.message.agent!==agent)assert.equal(await readFailedCircleSessionAttempt(x.connection,x.entry,x.receipt),null);
  else await assert.rejects(()=>readFailedCircleSessionAttempt(x.connection,x.entry,x.receipt));
 }
});
for(const outer of ['success','reverted'])test(`session recovery records exact ${outer} bundle failure without recycling capacity`,async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {getAddress,keccak256}=await import('viem');
 const {initializeExecutionSession}=await import('./float-mainnet-session.mjs');
 const {createMainnetCircleSessionGuard}=await import('./circle-agent-mainnet-session.mjs');
 const x=setup(),dir=await mkdtemp(join(tmpdir(),'shadow-circle-failure-session-'));
 try{
  x.receipt.status=outer;
  x.connection.address=getAddress(contract);
  x.connection.client.getCode=async()=> '0x6000';
  x.connection.client.getTransactionReceipt=async()=>x.receipt;
  x.connection.client.readContract=async({functionName})=>functionName==='getUserOpHash'?userOpHash:0;
  const path=join(dir,'policy.json'),ledgerDirectory=join(dir,'ledger');
  const policy={kind:'ShadowFloatMainnet.ExecutionSession',sessionId:'failed-circle',chainId:'5042',verifyingContract:x.connection.address,runtimeKeccak256:keccak256('0x6000'),executor:agent,agent,sponsor:provider,provider,endpointHash:line,maxGrossPrincipal:'5000',ledgerDirectory};
  await writeFile(path,JSON.stringify(policy));await initializeExecutionSession(path,x.connection);
  const guard=createMainnetCircleSessionGuard({sessionPath:path,connection:x.connection,monitor:async()=>({ok:true})});
  await guard.reserve(x.entry.message);
  const result=await guard.recordOutcome(x.entry.digest,txHash);
  assert.equal(result.recordedStatus,outer==='success'?'failed-user-operation':'reverted');assert.deepEqual(result.pending,[]);
  await assert.rejects(()=>guard.check({...x.entry.message,nonce:1n}),/gross principal budget exhausted/);
  const ledger=JSON.parse(await readFile(join(ledgerDirectory,'ledger.json'),'utf8'));
  assert.equal(ledger.entries[0].txHash,txHash);assert.equal(ledger.entries[0].message.principal,'5000');
 }finally{await rm(dir,{recursive:true,force:true});}
});
