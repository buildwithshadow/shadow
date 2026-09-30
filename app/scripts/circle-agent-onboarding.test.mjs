import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCircleCliDriver, rawCalldataCompatibility, unwrapCircle } from './circle-agent-cli-transport.mjs';
import { parseAgentArgs, recoverAgentPurchase } from './shadow-circle-agent.mjs';
import { circleAgentCommands } from '../src/circleAgentCommands.ts';
import abi from './float-mainnet-abi.json' with { type:'json' };
const agent=`0x${'11'.repeat(20)}`,other=`0x${'22'.repeat(20)}`,line=`0x${'33'.repeat(32)}`;
const contract='0xb31d9e17410b10a619b66df0c31f59acbb33b553';
function setup() {
  const data=new Map(), calls=[];
  const state={valid:true,owned:true,throwOnExecute:false,history:[],response:{id:'circle-1',idempotencyKey:'key-1',state:'COMPLETE',txHash:`0x${'44'.repeat(32)}`}};
  const run=async(_node,args)=>{
    calls.push(args);
    if(args.includes('status'))return {stdout:JSON.stringify({data:{testnet:{tokenStatus:state.valid?'VALID':'EXPIRED'},mainnet:{tokenStatus:'VALID'}}})};
    if(args.includes('list')&&args.includes('wallet'))return {stdout:JSON.stringify({data:{wallets:[{address:state.owned?agent:other}]}})};
    if(args.includes('transaction'))return {stdout:JSON.stringify({data:{transactions:state.history}})};
    if(args.includes('sign'))return {stdout:JSON.stringify({data:{signature:'0x1234'}})};
    if(args.includes('--estimate'))return {stdout:JSON.stringify({data:{medium:{networkFee:'0.01'}}})};
    if(state.throwOnExecute)throw new Error('SECRET signature session contents');
    return {stdout:JSON.stringify({data:state.response})};
  };
  const journal={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)};
  return {driver:createCircleCliDriver({entrypoint:'/stock',compatibility:'/compat',agent,journal,run}),state,calls,data};
}
const request={blockchain:'ARC-TESTNET',sourceAddress:agent,contractAddress:contract,amount:'0',callData:'0x1234',idempotencyKey:'key-1'};
test('unwraps Circle envelope without confusing mainnet with testnet',async()=>{
  assert.deepEqual(unwrapCircle({data:{ok:true}}),{ok:true});const x=setup();assert.equal((await x.driver.session()).authenticated,true);
  x.state.valid=false;await assert.rejects(()=>x.driver.session(),/No valid Circle testnet/);
  assert(!x.calls.some(c=>c.includes('login')));
});
test('rejects another account and never initiates OTP or provisioning',async()=>{
  const x=setup();x.state.owned=false;await assert.rejects(()=>x.driver.session(),/not in the logged-in/);
  assert(!x.calls.some(c=>c.includes('login')||c.includes('create')||c.includes('fund')));
});
test('passes exact raw calldata and idempotency key, saving response before returning',async()=>{
  const x=setup();assert.equal((await x.driver.estimate(request)).networkFee,'0.01');
  await x.driver.execute(request);assert.equal(x.data.get('circle-response:key-1').id,'circle-1');
  const sent=x.calls.at(-1);assert.equal(sent[0],'/compat');assert.equal(sent[sent.indexOf('--shadow-call-data')+1],'0x1234');assert.equal(sent[sent.indexOf('--idempotency-key')+1],'key-1');
});
test('transport refuses wrong network, value, account and destination',async()=>{
  for(const change of [{blockchain:'ARC'},{sourceAddress:other},{contractAddress:other},{amount:'1'}]){
    const x=setup();await assert.rejects(()=>x.driver.estimate({...request,...change}));assert(!x.calls.some(c=>c.includes('execute')));
  }
});
test('unknown response errors never print child-process secrets and lookup cannot resend',async()=>{
  const x=setup();x.state.throwOnExecute=true;
  await assert.rejects(()=>x.driver.execute(request),e=>!e.message.includes('SECRET')&&e.message.includes('reliable result'));
  const before=x.calls.length;assert.equal(await x.driver.lookup({idempotencyKey:'key-1',transactionId:null}),null);assert.equal(x.calls.length,before);
});
test('pending lookup only joins history by its saved Circle transaction ID',async()=>{
  const x=setup();x.state.response={...x.state.response,txHash:undefined,state:'PENDING'};await x.driver.execute(request);
  x.state.history=[{id:'unrelated',txHash:'0xbad'}];assert.equal((await x.driver.lookup({idempotencyKey:'key-1',transactionId:'circle-1'})).state,'PENDING');
  x.state.history=[{id:'circle-1',state:'COMPLETE',txHash:'0x123'}];assert.equal((await x.driver.lookup({idempotencyKey:'key-1',transactionId:'circle-1'})).txHash,'0x123');
  assert.equal(await x.driver.lookup({idempotencyKey:'key-1',transactionId:'wrong'}),null);
});
test('unknown CLI source fails closed',()=>{assert.throws(()=>rawCalldataCompatibility('modified runtime'),/differs from the tested/);});
test('signer accepts only bounded Shadow SpendIntent shape',async()=>{
  const x=setup();const endpointHash=`0x${'55'.repeat(32)}`;
  const typed={domain:{name:'ShadowFloatMainnet',version:'1',chainId:'5042002',verifyingContract:contract},primaryType:'SpendIntent',types:{SpendIntent:abi.find(f=>f.name==='executeSpend').inputs[0].components.map(({name,type})=>({name,type}))},message:{agent,executor:agent,provider:other,endpointHash,principal:'50000',maximumTotalDebt:'50000'}};
  const scope={contract,provider:other,endpointHash};assert.equal(await x.driver.signPurchase(JSON.stringify(typed),scope),'0x1234');
  typed.message.principal='50001';await assert.rejects(()=>x.driver.signPurchase(JSON.stringify(typed),scope),/exceeds/);
  typed.message.principal='50000';typed.types.SpendIntent[0].type='string';await assert.rejects(()=>x.driver.signPurchase(JSON.stringify(typed),scope),/schema/);
});
test('CLI actions need explicit confirmation; recovery cannot accept it',()=>{
  assert.equal(parseAgentArgs(['purchase','--agent',agent,'--line',line]).confirm,false);
  assert.equal(parseAgentArgs(['purchase','--agent',agent,'--line',line,'--confirm']).confirm,true);
  for(const args of [['recover','--agent',agent,'--line',line,'--confirm'],['purchase','--agent',agent,'--line',line,'--agent',agent],['purchase','--agent',agent,'--line',line,'--chain','ARC']])assert.throws(()=>parseAgentArgs(args));
});
test('website commands contain only validated public identifiers and recovery is read-only',()=>{
  const c=circleAgentCommands(line,agent);assert(!c.inspect.includes('--confirm'));assert(!c.recover.includes('--confirm'));assert(c.purchase.includes('--confirm'));
  assert.throws(()=>circleAgentCommands(line+';touch /tmp/injected',agent));assert.throws(()=>circleAgentCommands(line,agent+'$(echo bad)'));
});

test('runner reaches recovery after preflight rejection and releases only expired unpaid authorization',async()=>{
  let now=9n,archives=0,saves=0,recoveries=0;
  const state={requests:{purchase:{key:'never-sent'}}};
  const engine={load:()=>({}),recover:async()=>{recoveries++;return {status:'unconfirmed',record:{intent:{typedData:{message:{signatureExpiry:'10'}}}}};},archive:async()=>{archives++;}};
  const options={executor:{reconcile:async()=>({status:'not-submitted'})},state,engine,client:{getBlock:async()=>({timestamp:now})},save:()=>{saves++;}};
  const before=await recoverAgentPurchase(options);assert.match(before.next,/after the signed authorization expires/);assert.equal(recoveries,1);assert.equal(archives,0);assert(state.requests.purchase);
  now=11n;const after=await recoverAgentPurchase(options);assert.match(after.next,/prepare a new request/);assert.equal(archives,1);assert.equal(saves,1);assert.equal(state.requests.purchase,undefined);
});
test('runner never releases an unknown send or an authorization whose archive check fails',async()=>{
  let archives=0;const state={requests:{purchase:{key:'held'}}};
  const options={executor:{reconcile:async()=>({status:'unknown'})},state,engine:{load:()=>({}),recover:async()=>({status:'unconfirmed',record:{intent:{typedData:{message:{signatureExpiry:'10'}}}}}),archive:async()=>{archives++;throw new Error('receipt is paid');}},client:{getBlock:async()=>({timestamp:11n})},save:()=>assert.fail('must not clear state')};
  await recoverAgentPurchase(options);assert.equal(archives,0);assert(state.requests.purchase);
  options.executor.reconcile=async()=>({status:'not-submitted'});await assert.rejects(()=>recoverAgentPurchase(options),/receipt is paid/);assert(state.requests.purchase);
});

test('expired session before execute is definite while execute-command errors stay ambiguous',async()=>{
  const x=setup();x.state.valid=false;
  await assert.rejects(()=>x.driver.execute(request),e=>e.beforeSubmission===true);assert(!x.calls.some(c=>c.includes('execute')));
  x.state.valid=true;x.state.throwOnExecute=true;
  await assert.rejects(()=>x.driver.execute(request),e=>e.beforeSubmission!==true);
});
test('runner archives an exact onchain refusal so a new intent can be prepared',async()=>{
  let archives=0,saves=0;const state={requests:{purchase:{key:'refused'}}};
  const r=await recoverAgentPurchase({state,executor:{reconcile:async()=>({status:'blocked'})},engine:{load:()=>({}),recover:async()=>({status:'blocked'}),archive:async()=>{archives++;}},client:{},save:()=>{saves++;}});
  assert.equal(r.delivery,'blocked');assert.equal(archives,1);assert.equal(saves,1);assert.equal(state.requests.purchase,undefined);assert.match(r.next,/refused on chain/);
});


test('provider failure before execution keeps authorization until finalized unpaid expiry',async()=>{
  let now=9n,archives=0,saves=0;
  const state={requests:{}};
  const options={state,executor:{reconcile:async()=>assert.fail('no execution to reconcile')},
    engine:{load:()=>({stage:'prepared'}),recover:async()=>({status:'unconfirmed',record:{intent:{typedData:{message:{signatureExpiry:'10'}}}}}),archive:async()=>{archives++;}},
    client:{getBlock:async({blockTag})=>{assert.equal(blockTag,'finalized');return {timestamp:now};}},save:()=>{saves++;}};
  assert.match((await recoverAgentPurchase(options)).next,/after the signed authorization expires/);
  assert.equal(archives,0);assert.equal(saves,0);
  now=11n;assert.match((await recoverAgentPurchase(options)).next,/prepare a new request/);
  assert.equal(archives,1);assert.equal(saves,1);
  options.engine.archive=async()=>{throw new Error('receipt is paid');};
  await assert.rejects(recoverAgentPurchase(options),/receipt is paid/);assert.equal(saves,1);
});
