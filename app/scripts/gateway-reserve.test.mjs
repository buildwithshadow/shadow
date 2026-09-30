import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodePacked,keccak256} from 'viem';
import {createCircleAgentJournal} from './circle-agent-journal.mjs';
import {makeGatewayIntent,validateGatewayIntent,transferSpecHash,runGatewayStep,validateGatewayAttestation,finalizedGatewayReceipt} from './gateway-reserve.mjs';
const sponsor='0x1111111111111111111111111111111111111111';
const intent=()=>makeGatewayIntent({sponsor,amount:'100000',maxFee:'10000',maxBlockHeight:'123456',salt:'0x'+'22'.repeat(32)});
async function storage(t){const p=await mkdtemp(join(tmpdir(),'shadow-gateway-'));t.after(()=>rm(p,{recursive:true,force:true}));return createCircleAgentJournal(p);}
test('bounded route rejects ownership, network, token, amount and fee changes',()=>{
 const i=intent();assert.equal(validateGatewayIntent(i,sponsor),transferSpecHash(i.spec));
 for(const [key,value] of [['destinationRecipient','0x'+'33'.repeat(32)],['destinationDomain',5042002],['destinationToken','0x'+'44'.repeat(32)],['hookData','0x12']]){
  const bad=structuredClone(i);bad.spec[key]=value;assert.throws(()=>validateGatewayIntent(bad,sponsor));
 }
 assert.throws(()=>makeGatewayIntent({sponsor,amount:'100001',maxFee:'10000',maxBlockHeight:'123456'}));
 assert.throws(()=>makeGatewayIntent({sponsor,amount:'100000',maxFee:'10001',maxBlockHeight:'123456'}));
});
test('hash uses the protocol packed byte layout including magic and hook length',()=>{
 const s=intent().spec;
 const hex='ca85def7'+'00000001'+'0000001a'.repeat(2)+[s.sourceContract,s.destinationContract,s.sourceToken,s.destinationToken,s.sourceDepositor,s.destinationRecipient,s.sourceSigner,s.destinationCaller].map(x=>x.slice(2)).join('')+BigInt(s.value).toString(16).padStart(64,'0')+s.salt.slice(2)+'00000000';
 assert.equal(hex.length,680);assert.equal(transferSpecHash(s),keccak256('0x'+hex));
 const changed={...s,salt:'0x'+'55'.repeat(32)};assert.notEqual(transferSpecHash(s),transferSpecHash(changed));
});
for(const phase of ['deposit','attestation','mint','open'])test(`${phase}: lost response survives restart and never sends again`,async t=>{
 const journal=await storage(t);let sends=0;const request={identity:'fixed',salt:'original'};
 const args={journal,operation:'funding-1',phase,request,send:async()=>{sends++;throw Error('lost response');},reconcile:async()=>null};
 await assert.rejects(runGatewayStep(args),/lost response/);
 const unknown=await runGatewayStep(args);assert.equal(unknown.status,'unknown');assert.equal(sends,1);
 const done=await runGatewayStep({...args,reconcile:async()=>({exactOriginalReceipt:'verified'})});assert.equal(done.status,'confirmed');
 await runGatewayStep(args);assert.equal(sends,1);
 await assert.rejects(runGatewayStep({...args,request:{...request,salt:'new'}}),/changed request/);
});
test('saved response is recoverable after confirmation reader fails',async t=>{
 const journal=await storage(t);let sends=0;
 const a={journal,operation:'one',phase:'mint',request:{hash:'one'},send:async()=>{sends++;return {hash:'one'};},reconcile:async()=>{throw Error('RPC offline');}};
 await assert.rejects(runGatewayStep(a),/RPC offline/);
 const r=await runGatewayStep({...a,reconcile:async prior=>{assert.deepEqual(prior.response,{hash:'one'});return {receipt:'one'};}});
 assert.equal(r.status,'confirmed');assert.equal(sends,1);
});
test('concurrent operators cannot both send',async t=>{
 const journal=await storage(t);let release;const blocked=new Promise(r=>release=r);let started;const start=new Promise(r=>started=r);let sends=0;
 const a={journal,operation:'one',phase:'deposit',request:{},send:async()=>{sends++;started();await blocked;return {};},reconcile:async()=>({})};
 const first=runGatewayStep(a);await start;await assert.rejects(runGatewayStep(a),/locked/);release();await first;assert.equal(sends,1);
});
test('RPC disagreement, unfinalized and wrong network cannot prove completion',async()=>{
 const hash='0x'+'aa'.repeat(32);const r={blockNumber:12n,blockHash:hash,status:'success',logs:[]};
 const c={getChainId:async()=>5042002,getTransactionReceipt:async()=>r,getBlock:async()=>({number:12n,hash})};
 assert.deepEqual(await finalizedGatewayReceipt([c,c],hash),r);
 await assert.rejects(finalizedGatewayReceipt([c,{...c,getChainId:async()=>1}],hash));
 await assert.rejects(finalizedGatewayReceipt([c,{...c,getBlock:async()=>({number:11n,hash})}],hash),/finalized/);
 await assert.rejects(finalizedGatewayReceipt([c,{...c,getTransactionReceipt:async()=>({...r,logs:[{wrong:true}]})}],hash),/disagreement/);
});
test('attestation must contain exactly the authorized transfer and be unexpired',()=>{
 const i=intent(),s=i.spec;
 const encoded=encodePacked(['bytes4','uint32','uint32','uint32',...Array(8).fill('bytes32'),'uint256','bytes32','uint32'],['0xca85def7',1,26,26,s.sourceContract,s.destinationContract,s.sourceToken,s.destinationToken,s.sourceDepositor,s.destinationRecipient,s.sourceSigner,s.destinationCaller,100000n,s.salt,0]);
 const payload=encodePacked(['bytes4','uint256','uint32','bytes'],['0xff6fb334',100n,340,encoded]);
 assert.equal(validateGatewayAttestation(payload,i,sponsor,99).expirationBlock,'100');
 assert.throws(()=>validateGatewayAttestation(payload,i,sponsor,100),/expired/);
 assert.throws(()=>validateGatewayAttestation(payload+'00',i,sponsor,99),/Trailing/);
 assert.throws(()=>validateGatewayAttestation(payload,{...i,spec:{...s,value:'99999'}},sponsor,99),/match/);
 const set=encodePacked(['bytes4','uint32','bytes'],['0x1e12db71',1,payload]);assert.equal(validateGatewayAttestation(set,i,sponsor,99).expirationBlock,'100');
});

test('mint and deposit receipts bind identity, amount and emitter',async()=>{
 const {encodeEventTopics,encodeAbiParameters}=await import('viem');
 const {gatewayAbi,GATEWAY_TESTNET:g,verifyGatewayEvent}=await import('./gateway-reserve.mjs');
 const i=intent();const hash='0x'+'ab'.repeat(32);
 const log={address:g.wallet,topics:encodeEventTopics({abi:gatewayAbi,eventName:'Deposited',args:{token:g.token,depositor:sponsor,sender:sponsor}}),data:encodeAbiParameters([{type:'uint256'}],[103850n])};
 const r={transactionHash:hash,status:'success',to:g.wallet,blockNumber:1n,blockHash:hash,logs:[log]};
 assert.equal(verifyGatewayEvent({receipt:r,hash,kind:'deposit',sponsor,depositAmount:'103850'}).event,'Deposited');
 assert.throws(()=>verifyGatewayEvent({receipt:{...r,logs:[log,log]},hash,kind:'deposit',sponsor,depositAmount:'103850'}));
 assert.throws(()=>verifyGatewayEvent({receipt:r,hash,kind:'deposit',sponsor,depositAmount:'103851'}));
 const mint={address:g.minter,topics:encodeEventTopics({abi:gatewayAbi,eventName:'AttestationUsed',args:{token:g.token,recipient:sponsor,transferSpecHash:transferSpecHash(i.spec)}}),data:encodeAbiParameters([{type:'uint32'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'}],[26,i.spec.sourceDepositor,i.spec.sourceSigner,100000n])};
 const mr={...r,to:g.minter,logs:[mint]};assert.equal(verifyGatewayEvent({receipt:mr,hash,kind:'mint',sponsor,intent:i}).event,'AttestationUsed');
 assert.throws(()=>verifyGatewayEvent({receipt:{...mr,logs:[{...mint,address:g.wallet}]},hash,kind:'mint',sponsor,intent:i}));
 assert.throws(()=>verifyGatewayEvent({receipt:mr,hash:'0x'+'cd'.repeat(32),kind:'mint',sponsor,intent:i}));
});
