import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodePacked, erc20Abi} from 'viem';
import {GATEWAY_TESTNET as g, gatewayAbi, validateGatewayIntent} from './gateway-reserve.mjs';
import {GATEWAY_GUARDED_TESTNET as shadow, atomicFundingAbi, makeSmartAccountGatewayIntent, validateSmartAccountGatewayIntent, prepareSmartAccountReserveBatch, verifySmartAccountReserveEvents} from './gateway-reserve-smart-account.mjs';

const controller='0x1111111111111111111111111111111111111111',account='0x2222222222222222222222222222222222222222';
const agent='0x3333333333333333333333333333333333333333',provider='0x4444444444444444444444444444444444444444';
const hash='0x'+'ab'.repeat(32);
function fixture() {
  const intent=makeSmartAccountGatewayIntent({controller,sponsorAccount:account,amount:'100000',maxFee:'10000',maxBlockHeight:'1000',salt:'0x'+'55'.repeat(32)});
  const s=intent.spec;
  const encoded=encodePacked(['bytes4','uint32','uint32','uint32',...Array(8).fill('bytes32'),'uint256','bytes32','uint32'],['0xca85def7',1,26,26,s.sourceContract,s.destinationContract,s.sourceToken,s.destinationToken,s.sourceDepositor,s.destinationRecipient,s.sourceSigner,s.destinationCaller,100000n,s.salt,0]);
  return {controller,sponsorAccount:account,shadow,chainId:g.chainId,intent,currentBlock:'99',now:'1700000000',nextEpoch:'1',
    attestationPayload:encodePacked(['bytes4','uint256','uint32','bytes'],['0xff6fb334',100n,340,encoded]),attestationSignature:'0x'+'77'.repeat(65),
    params:{agent,provider,endpointHash:'0x'+'88'.repeat(32),reserve:'100000',lineSpendCap:'5000',dailySpendCap:'5000',providerPerSpendCap:'5000',providerDailyCap:'5000',lineExpiry:'1700003600',providerExpiry:'1700003600',maximumRepaymentWindow:'3600'}};
}
function log(address,abi,eventName,indexed,types,values) {
  return {address,topics:encodeEventTopics({abi,eventName,args:indexed}),data:encodeAbiParameters(types.map(type=>({type})),values)};
}
function receipt(plan,intent) {
  const p=plan.params;
  return {transactionHash:hash,to:account,status:'success',logs:[
    log(g.minter,gatewayAbi,'AttestationUsed',{token:g.token,recipient:account,transferSpecHash:plan.transferSpecHash},['uint32','bytes32','bytes32','uint256'],[26,intent.spec.sourceDepositor,intent.spec.sourceSigner,100000n]),
    log(g.token,erc20Abi,'Transfer',{from:account,to:shadow},['uint256'],[100000n]),
    log(shadow,atomicFundingAbi,'LineOpened',{lineId:plan.lineId,sponsor:account,agent},['uint64','uint256','uint64'],[1n,100000n,1n]),
    log(shadow,atomicFundingAbi,'ProviderPolicySet',{lineId:plan.lineId,provider},['bytes32','uint256','uint256','uint64','bool','uint64'],[p.endpointHash,5000n,5000n,1700003600n,true,1n]),
    log(g.token,erc20Abi,'Approval',{owner:account,spender:shadow},['uint256'],[0n]),
  ]};
}

test('separates source controller from destination sponsor and preserves old EOA route restrictions',()=>{
  const {intent}=fixture();
  assert.equal(validateSmartAccountGatewayIntent(intent,controller,account).length,66);
  assert.notEqual(intent.spec.sourceDepositor,intent.spec.destinationRecipient);
  assert.equal(intent.spec.destinationRecipient,intent.spec.destinationCaller);
  assert.throws(()=>validateGatewayIntent(intent,controller),/differs/);
  assert.throws(()=>validateSmartAccountGatewayIntent(intent,account,controller),/differs/);
  for(const [key,value] of [['destinationCaller','0x'+'00'.repeat(32)],['destinationRecipient',intent.spec.sourceDepositor],['sourceSigner',intent.spec.destinationRecipient],['destinationDomain',5042],['destinationToken',intent.spec.sourceContract],['hookData','0x12']]) {
    const bad=structuredClone(intent);bad.spec[key]=value;
    assert.throws(()=>validateSmartAccountGatewayIntent(bad,controller,account));
  }
});
test('builds one exact bounded batch with zero native value and no unlimited allowance',()=>{
  const input=fixture(),plan=prepareSmartAccountReserveBatch(input);
  assert.equal(plan.sponsorAccount,account);assert.equal(plan.controller,controller);assert.equal(plan.calls.length,5);
  assert(plan.calls.every(call=>call.value==='0'));
  assert.deepEqual(plan.calls.map(call=>call.to.toLowerCase()),[g.minter,g.token,g.token,shadow,g.token].map(x=>x.toLowerCase()));
  assert.equal(decodeFunctionData({abi:gatewayAbi,data:plan.calls[0].data}).functionName,'gatewayMint');
  const amounts=[1,2,4].map(i=>decodeFunctionData({abi:erc20Abi,data:plan.calls[i].data}).args[1]);
  assert.deepEqual(amounts,[0n,100000n,0n]);
  const opened=decodeFunctionData({abi:atomicFundingAbi,data:plan.calls[3].data});
  assert.equal(opened.functionName,'openLine');assert.equal(opened.args[0].reserve,100000n);assert.equal(opened.args[0].agent,agent);
});
test('rejects mainnet, wrong contract, old epoch, expired attestation and malformed signature',()=>{
  for(const mutation of [x=>x.chainId=5042,x=>x.shadow=provider,x=>x.nextEpoch='0',x=>x.currentBlock='100',x=>x.attestationSignature='0x12',x=>x.sponsorAccount=controller,x=>x.sponsorAccount=g.minter,x=>x.params.provider=shadow]) {
    const input=fixture();mutation(input);assert.throws(()=>prepareSmartAccountReserveBatch(input));
  }
});
test('refuses oversized funds, incompatible reserve, weaker provider caps and changed attestation route',()=>{
  for(const mutation of [x=>x.params.reserve='100001',x=>x.params.reserve='99999',x=>x.params.providerPerSpendCap='5001',x=>x.params.providerDailyCap='5001',x=>x.params.lineExpiry='1700086401',x=>x.params.providerExpiry='1700003601',x=>x.params.maximumRepaymentWindow='86401',x=>x.params.endpointHash='0x'+'00'.repeat(32),x=>x.params.extra='ignored',x=>x.params.reserve=100000,x=>x.intent.spec.destinationRecipient=x.intent.spec.sourceDepositor]) {
    const input=fixture();mutation(input);assert.throws(()=>prepareSmartAccountReserveBatch(input));
  }
});
test('requires original mint, exact funding, line and policy together in the account receipt',()=>{
  const input=fixture(),plan=prepareSmartAccountReserveBatch(input),r=receipt(plan,input.intent);
  const result=verifySmartAccountReserveEvents({receipt:r,hash,plan,intent:input.intent});
  assert.equal(result.sponsor,account);assert.equal(result.reserve,'100000');assert.equal(result.lineId,plan.lineId);
  for(let i=0;i<r.logs.length;i++) {
    const partial={...r,logs:r.logs.filter((_,j)=>i!==j)};
    assert.throws(()=>verifySmartAccountReserveEvents({receipt:partial,hash,plan,intent:input.intent}));
  }
});
test('outer success cannot certify a caught internal batch failure, mint alone, or an unrelated line',()=>{
  const input=fixture(),plan=prepareSmartAccountReserveBatch(input),r=receipt(plan,input.intent);
  for(const logs of [[],[r.logs[0]],r.logs.map((entry,i)=>i===2?{...entry,topics:[entry.topics[0],hash,...entry.topics.slice(2)]}:entry)]) {
    assert.throws(()=>verifySmartAccountReserveEvents({receipt:{...r,logs},hash,plan,intent:input.intent}));
  }
  assert.throws(()=>verifySmartAccountReserveEvents({receipt:r,hash:'0x'+'cc'.repeat(32),plan,intent:input.intent}));
  assert.throws(()=>verifySmartAccountReserveEvents({receipt:{...r,to:controller},hash,plan,intent:input.intent}));
});
test('rejects duplicate effects, counterfeit emitter, altered policy and remaining allowance',()=>{
  const input=fixture(),plan=prepareSmartAccountReserveBatch(input),r=receipt(plan,input.intent);
  for(const mutation of [x=>x.logs.push(x.logs[0]),x=>x.logs[0].address=shadow,x=>x.logs[1].data=encodeAbiParameters([{type:'uint256'}],[99999n]),x=>x.logs[2].topics[2]=intentAddress(controller),x=>x.logs[3].data=encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'uint64'},{type:'bool'},{type:'uint64'}],[plan.params.endpointHash,5001n,5000n,1700003600n,true,1n]),x=>x.logs[4].data=encodeAbiParameters([{type:'uint256'}],[100000n])]) {
    const altered=structuredClone(r);mutation(altered);
    assert.throws(()=>verifySmartAccountReserveEvents({receipt:altered,hash,plan,intent:input.intent}));
  }
});
function intentAddress(value) { return '0x'+value.slice(2).padStart(64,'0'); }
