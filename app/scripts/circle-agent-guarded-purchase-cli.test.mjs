import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi } from 'viem';
import { createCircleGuardedTestnetPurchaseDriver, GUARDED_TESTNET_CONTRACT as contract } from './circle-agent-cli-transport.mjs';
import abi from './float-mainnet-abi.json' with { type: 'json' };

const agent = `0x${'11'.repeat(20)}`, provider = `0x${'22'.repeat(20)}`;
const lineId = `0x${'33'.repeat(32)}`, endpointHash = `0x${'44'.repeat(32)}`;
const idempotencyKey = '12345678-1234-1234-1234-123456789abc';
const intent = { agent, sponsor:provider, lineId, lineEpoch:1n, termsHash:endpointHash, provider, endpointHash,
  principal:5000n, maximumTotalDebt:5000n, dueAt:1000n, nonce:0n, signatureExpiry:900n, executor:agent };
const request = { blockchain:'ARC-TESTNET', sourceAddress:agent, contractAddress:contract, amount:'0',
  callData:encodeFunctionData({abi,functionName:'executeSpend',args:[intent,'0x1234']}), idempotencyKey };
function setup() {
  const data=new Map(), calls=[], state={valid:true,fail:false,network:'ARC-TESTNET',history:[],response:{...request,id:'circle-1',txHash:'0x1234'}};
  const options={entrypoint:'/stock',compatibility:'/guarded-compat',agent,provider,endpointHash,expectedLineId:lineId,maxAmount:'5000',
    journal:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)},run:async(_node,args)=>{
      calls.push(args);
      const value=args.includes('status')?{testnet:{tokenStatus:state.valid?'VALID':'EXPIRED'},mainnet:{tokenStatus:'VALID'}}
        :args.includes('wallet')&&args.includes('list')?{wallets:[{address:agent}]}
        :args.includes('transaction')?{transactions:state.history}
        :args.includes('sign')?{signature:'0x1234'}
        :args.includes('--estimate')?{blockchain:state.network,medium:{networkFee:'0.01'}}:state.response;
      if(args.includes('execute')&&!args.includes('--estimate')&&state.fail)throw new Error('SECRET SESSION');
      return {stdout:JSON.stringify({data:value})};
    }};
  return {driver:createCircleGuardedTestnetPurchaseDriver(options),options,state,calls,data};
}
const typed = () => ({domain:{name:'ShadowFloatMainnet',version:'1',chainId:5042002,verifyingContract:contract},primaryType:'SpendIntent',
  types:{SpendIntent:abi.find(f=>f.name==='executeSpend').inputs[0].components.map(({name,type})=>({name,type}))},
  message:JSON.parse(JSON.stringify(intent,(_,v)=>typeof v==='bigint'?v.toString():v))});
const scope={contract,provider,endpointHash};

test('guarded purchase driver keeps testnet session, exact calldata and original Circle response',async()=>{
  const x=setup();assert.equal((await x.driver.estimate(request)).networkFee,'0.01');
  await x.driver.execute(request);
  const sent=x.calls.at(-1);assert.equal(sent[0],'/guarded-compat');
  for(const [flag,value] of [['--chain','ARC-TESTNET'],['--contract',contract],['--shadow-agent',agent],['--shadow-call-data',request.callData],['--idempotency-key',idempotencyKey]]) assert.equal(sent[sent.indexOf(flag)+1],value);
  assert.equal(x.data.get(`circle-response:${idempotencyKey}`).id,'circle-1');
  assert.equal(x.driver.command,undefined);
});
test('guarded transport rejects allowance, repayment, another deployment, line, provider and changed amounts before running the CLI',async()=>{
  const changes=[{blockchain:'ARC'},{amount:'1'},{sourceAddress:provider},{contractAddress:'0xb31d9e17410b10a619b66df0c31f59acbb33b553'},
    {contractAddress:'0x3600000000000000000000000000000000000000',callData:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,5000n]})},
    {callData:encodeFunctionData({abi,functionName:'repay',args:[lineId,5000n]})},{callData:request.callData+'00'}];
  for(const patch of [{lineId:endpointHash},{provider:agent},{principal:4999n},{maximumTotalDebt:5001n},{executor:provider}]) changes.push({callData:encodeFunctionData({abi,functionName:'executeSpend',args:[{...intent,...patch},'0x1234']})});
  for(const patch of changes){const x=setup();await assert.rejects(()=>x.driver.estimate({...request,...patch}));assert.equal(x.calls.length,0);}
});
test('guarded signer pins its factory scope and cannot be redirected by the caller',async()=>{
  const x=setup();assert.equal(await x.driver.signPurchase(JSON.stringify(typed()),scope),'0x1234');
  for(const patch of [{lineId:endpointHash},{provider:agent},{principal:'50000'},{maximumTotalDebt:'5001'},{executor:provider}]) {
    const payload=typed();Object.assign(payload.message,patch);
    await assert.rejects(()=>x.driver.signPurchase(JSON.stringify(payload),scope));
  }
  for(const chainId of [5042,1]){const payload=typed();payload.domain.chainId=chainId;await assert.rejects(()=>x.driver.signPurchase(JSON.stringify(payload),scope));}
  const payload=typed();payload.domain.verifyingContract=provider;
  await assert.rejects(()=>x.driver.signPurchase(JSON.stringify(payload),{...scope,contract:provider}),/scope changed/);
  assert.equal(x.calls.filter(c=>c.includes('sign')).length,1);
});
test('guarded purchase cannot activate a wallet or treat a mainnet estimate as testnet',async()=>{
  const x=setup();await assert.rejects(()=>x.driver.activate({idempotencyKey}),/activation/);
  await assert.rejects(()=>x.driver.estimateActivation(),/activation/);assert.equal(x.calls.length,0);
  x.state.network='ARC';await assert.rejects(()=>x.driver.estimate(request),/estimate network/);
  x.state.valid=false;await assert.rejects(()=>x.driver.execute(request),e=>e.beforeSubmission===true);
  assert(!x.calls.some(c=>c.includes('execute')&&!c.includes('--estimate')));
});
test('lost response remains unknown and lookup never resubmits or searches by amount',async()=>{
  const x=setup();x.state.fail=true;
  await assert.rejects(()=>x.driver.execute(request),e=>!e.message.includes('SECRET')&&e.beforeSubmission!==true);
  const before=x.calls.length;assert.equal(await x.driver.lookup({idempotencyKey}),null);assert.equal(x.calls.length,before);
  x.data.set(`circle-response:${idempotencyKey}`,{...x.state.response,txHash:undefined});
  x.state.history=[{id:'other',txHash:'0xwrong'}];assert.equal((await x.driver.lookup({idempotencyKey,transactionId:'circle-1'})).txHash,undefined);
  x.state.history=[{id:'circle-1',txHash:'0xcorrect'}];assert.equal((await x.driver.lookup({idempotencyKey,transactionId:'circle-1'})).txHash,'0xcorrect');
  assert.equal(x.calls.filter(c=>c.includes('execute')).length,1);
});
test('guarded transport rejects invalid policy before any command or runtime preparation',()=>{
  for(const patch of [{maxAmount:'5001'},{maxAmount:'0'},{expectedLineId:`0x${'00'.repeat(32)}`},{endpointHash:'bad'}]) {
    const x=setup();assert.throws(()=>createCircleGuardedTestnetPurchaseDriver({...x.options,...patch}));assert.equal(x.calls.length,0);
  }
});
