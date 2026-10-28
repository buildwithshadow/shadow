import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi } from 'viem';
import { createCircleGuardedMainnetPurchaseDriver, createCircleSettledMainnetPurchaseDriver, GUARDED_MAINNET_CONTRACT, SETTLED_MAINNET_CONTRACT } from './circle-agent-cli-transport.mjs';
import abi from './float-mainnet-abi.json' with { type: 'json' };

for (const {label,makeDriver,contract,principal,cap} of [
 {label:'guarded',makeDriver:createCircleGuardedMainnetPurchaseDriver,contract:GUARDED_MAINNET_CONTRACT,principal:5000n,cap:5000n},
 {label:'settled',makeDriver:createCircleSettledMainnetPurchaseDriver,contract:SETTLED_MAINNET_CONTRACT,principal:10000n,cap:50000n},
]) {
const agent = `0x${'11'.repeat(20)}`, provider = `0x${'22'.repeat(20)}`;
const lineId = `0x${'33'.repeat(32)}`, endpointHash = `0x${'44'.repeat(32)}`;
const idempotencyKey = '12345678-1234-1234-1234-123456789abc';
const intent = { agent, sponsor:provider, lineId, lineEpoch:1n, termsHash:endpointHash, provider, endpointHash,
  principal, maximumTotalDebt:principal, dueAt:1000n, nonce:0n, signatureExpiry:900n, executor:agent };
const request = { blockchain:'ARC', sourceAddress:agent, contractAddress:contract, amount:'0',
  callData:encodeFunctionData({abi,functionName:'executeSpend',args:[intent,'0x1234']}), idempotencyKey };
function setup() {
  const data=new Map(), calls=[], state={valid:true,fail:false,network:'ARC',history:[],response:{...request,id:'circle-1',txHash:'0x1234'}};
  const options={entrypoint:'/stock',compatibility:'/guarded-compat',agent,provider,endpointHash,expectedLineId:lineId,maxAmount:principal.toString(),beforeSign:async()=>{state.signGuards=(state.signGuards??0)+1;if(state.guardFail)throw Error('held');},beforeExecute:async()=>{state.guards=(state.guards??0)+1;if(state.guardFail)throw Error('held');},
    journal:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)},run:async(_node,args)=>{
      calls.push(args);
      const value=args.includes('status')?{mainnet:{tokenStatus:state.valid?'VALID':'EXPIRED'},testnet:{tokenStatus:'VALID'}}
        :args.includes('wallet')&&args.includes('list')?{wallets:[{address:agent}]}
        :args.includes('transaction')?{transactions:state.history}
        :args.includes('sign')?{signature:'0x1234'}
        :args.includes('--estimate')?{blockchain:state.network,medium:{networkFee:'0.01'}}:state.response;
      if(args.includes('execute')&&!args.includes('--estimate')&&state.fail)throw new Error('SECRET SESSION');
      return {stdout:JSON.stringify({data:value})};
    }};
  return {driver:makeDriver(options),options,state,calls,data};
}
const typed = () => ({domain:{name:'ShadowFloatMainnet',version:'1',chainId:5042,verifyingContract:contract},primaryType:'SpendIntent',
  types:{SpendIntent:abi.find(f=>f.name==='executeSpend').inputs[0].components.map(({name,type})=>({name,type}))},
  message:JSON.parse(JSON.stringify(intent,(_,v)=>typeof v==='bigint'?v.toString():v))});
const scope={contract,provider,endpointHash};

test(label + ': ' + 'guarded purchase driver keeps mainnet session, exact calldata and original Circle response',async()=>{
  const x=setup();assert.equal((await x.driver.estimate(request)).networkFee,'0.01');
  await x.driver.execute(request);
  const sent=x.calls.at(-1);assert.equal(sent[0],'/guarded-compat');
  for(const [flag,value] of [['--chain','ARC'],['--contract',contract],['--shadow-agent',agent],['--shadow-call-data',request.callData],['--idempotency-key',idempotencyKey]]) assert.equal(sent[sent.indexOf(flag)+1],value);
  assert.equal(x.data.get(`circle-response:${idempotencyKey}`).id,'circle-1');
  assert.equal(x.driver.command,undefined);
});
test(label + ': ' + 'guarded transport rejects allowance, repayment, another deployment, line, provider and changed amounts before running the CLI',async()=>{
  const changes=[{blockchain:'ARC-TESTNET'},{amount:'1'},{sourceAddress:provider},{contractAddress:'0xb31d9e17410b10a619b66df0c31f59acbb33b553'},
    {contractAddress:'0x3600000000000000000000000000000000000000',callData:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,5000n]})},
    {callData:encodeFunctionData({abi,functionName:'repay',args:[lineId,5000n]})},{callData:request.callData+'00'}];
  for(const patch of [{lineId:endpointHash},{provider:agent},{principal:4999n},{maximumTotalDebt:5001n},{executor:provider}]) changes.push({callData:encodeFunctionData({abi,functionName:'executeSpend',args:[{...intent,...patch},'0x1234']})});
  for(const patch of changes){const x=setup();await assert.rejects(()=>x.driver.estimate({...request,...patch}));assert.equal(x.calls.length,0);}
});
test(label + ': ' + 'guarded signer pins its factory scope and cannot be redirected by the caller',async()=>{
  const x=setup();assert.equal(await x.driver.signPurchase(JSON.stringify(typed()),scope),'0x1234');
  for(const patch of [{lineId:endpointHash},{provider:agent},{principal:'50000'},{maximumTotalDebt:'5001'},{executor:provider}]) {
    const payload=typed();Object.assign(payload.message,patch);
    await assert.rejects(()=>x.driver.signPurchase(JSON.stringify(payload),scope));
  }
  for(const chainId of [5042002,1]){const payload=typed();payload.domain.chainId=chainId;await assert.rejects(()=>x.driver.signPurchase(JSON.stringify(payload),scope));}
  const payload=typed();payload.domain.verifyingContract=provider;
  await assert.rejects(()=>x.driver.signPurchase(JSON.stringify(payload),{...scope,contract:provider}),/scope changed/);
  assert.equal(x.calls.filter(c=>c.includes('sign')).length,1);
});
test(label + ': ' + 'guarded purchase cannot activate a wallet or treat a testnet estimate as mainnet',async()=>{
  const x=setup();await assert.rejects(()=>x.driver.activate({idempotencyKey}),/activation/);
  await assert.rejects(()=>x.driver.estimateActivation(),/activation/);assert.equal(x.calls.length,0);
  x.state.network='ARC-TESTNET';await assert.rejects(()=>x.driver.estimate(request),/estimate network/);
  x.state.valid=false;await assert.rejects(()=>x.driver.execute(request),e=>e.beforeSubmission===true);
  assert(!x.calls.some(c=>c.includes('execute')&&!c.includes('--estimate')));
});
test(label + ': ' + 'lost response remains unknown and lookup never resubmits or searches by amount',async()=>{
  const x=setup();x.state.fail=true;
  await assert.rejects(()=>x.driver.execute(request),e=>!e.message.includes('SECRET')&&e.beforeSubmission!==true);
  const before=x.calls.length;assert.equal(await x.driver.lookup({idempotencyKey}),null);assert.equal(x.calls.length,before);
  x.data.set(`circle-response:${idempotencyKey}`,{...x.state.response,txHash:undefined});
  x.state.history=[{id:'other',txHash:'0xwrong'}];assert.equal((await x.driver.lookup({idempotencyKey,transactionId:'circle-1'})).txHash,undefined);
  x.state.history=[{id:'circle-1',txHash:'0xcorrect'}];assert.equal((await x.driver.lookup({idempotencyKey,transactionId:'circle-1'})).txHash,'0xcorrect');
  assert.equal(x.calls.filter(c=>c.includes('execute')).length,1);
});
test(label + ': ' + 'guarded transport rejects invalid policy before any command or runtime preparation',()=>{
  for(const patch of [{maxAmount:(cap+1n).toString()},{maxAmount:'0'},{expectedLineId:`0x${'00'.repeat(32)}`},{endpointHash:'bad'}]) {
    const x=setup();assert.throws(()=>makeDriver({...x.options,...patch}));assert.equal(x.calls.length,0);
  }
});

test(label + ': ' + 'mainnet pre-send monitor failure is definitely unsent and does not execute',async()=>{
 const x=setup();x.state.guardFail=true;
 await assert.rejects(()=>x.driver.execute(request),e=>e.beforeSubmission===true);
 assert.equal(x.state.guards,1);assert(!x.calls.some(c=>c.includes('execute')));
});
test(label + ': ' + 'mainnet session cannot be satisfied by a valid testnet login',async()=>{
 const x=setup();x.state.valid=false;
 await assert.rejects(()=>x.driver.session(),/mainnet session/);
});

test(label + ': ' + 'mainnet signing guard runs after remote session probes and prevents a newly held signature',async()=>{
 const x=setup();const previous=x.options.run;
 const driver=makeDriver({...x.options,run:async(node,args,options)=>{
  const result=await previous(node,args,options);if(args.includes('list'))x.state.guardFail=true;return result;
 }});
 await assert.rejects(()=>driver.signPurchase(JSON.stringify(typed()),scope),/held/);
 assert.equal(x.state.signGuards,1);assert(!x.calls.some(c=>c.includes('sign')));
});

test(label + ': exact maximum stays bound to one purchase and one contract',async()=>{
  const x=setup();const driver=makeDriver({...x.options,maxAmount:cap.toString()});
  const capped={...intent,principal:cap,maximumTotalDebt:cap};
  const data=encodeFunctionData({abi,functionName:'executeSpend',args:[capped,'0x1234']});
  assert.equal((await driver.estimate({...request,callData:data})).networkFee,'0.01');
  const payload=typed();payload.message.principal=cap.toString();payload.message.maximumTotalDebt=cap.toString();
  assert.equal(await driver.signPurchase(JSON.stringify(payload),scope),'0x1234');
  await assert.rejects(()=>driver.estimate({...request,callData:encodeFunctionData({abi,functionName:'executeSpend',args:[{...capped,principal:cap+1n,maximumTotalDebt:cap+1n},'0x1234']})}));
  const foreign=contract===SETTLED_MAINNET_CONTRACT?GUARDED_MAINNET_CONTRACT:SETTLED_MAINNET_CONTRACT;
  await assert.rejects(()=>driver.estimate({...request,contractAddress:foreign,callData:data}),/destination/);
});

}
