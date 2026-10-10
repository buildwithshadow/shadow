import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress,keccak256 } from 'viem';
import { initializeExecutionSession } from './float-mainnet-session.mjs';
import { createMainnetCircleSessionGuard,mainnetCircleSessionIntent } from './circle-agent-mainnet-session.mjs';
const address=n=>getAddress(`0x${n.repeat(40)}`), hash=n=>`0x${n.repeat(64)}`;
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'shadow-mainnet-session-'));
 const state={receipts:{},monitorHeld:false,monitorCalls:0};
 const connection={chainId:5042n,address:address('1'),client:{getCode:async()=> '0x6000',getBlock:async({blockNumber}={})=>({number:blockNumber??100n,hash:hash('9')}),readContract:async({args})=>state.receipts[args[0]]??0}};
 const policy={kind:'ShadowFloatMainnet.ExecutionSession',sessionId:'test-mainnet-circle',chainId:'5042',verifyingContract:connection.address,runtimeKeccak256:keccak256('0x6000'),executor:address('2'),agent:address('2'),sponsor:address('3'),provider:address('4'),endpointHash:hash('5'),maxGrossPrincipal:'5000',ledgerDirectory:join(dir,'ledger')};
 const path=join(dir,'policy.json');await writeFile(path,JSON.stringify(policy));await initializeExecutionSession(path,connection);
 const guard=createMainnetCircleSessionGuard({sessionPath:path,connection,monitor:async()=>{state.monitorCalls++;if(state.monitorHeld)throw Error('held monitor');return {healthy:true}}});
 const intent={agent:policy.agent,executor:policy.executor,sponsor:policy.sponsor,provider:policy.provider,endpointHash:policy.endpointHash,lineId:hash('6'),lineEpoch:1n,termsHash:hash('7'),principal:5000n,maximumTotalDebt:5000n,dueAt:1000n,signatureExpiry:900n,nonce:0n};
 return {guard,state,intent,connection,policy,dir,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
test('mainnet session refuses an older pending attempt before monitor, signing or a new reserve',async()=>{
 const x=await setup();try{
  await x.guard.reserve(x.intent);const before=x.state.monitorCalls;
  await assert.rejects(()=>x.guard.check({...x.intent,nonce:1n}),/unresolved attempt/);
  await assert.rejects(()=>x.guard.reserve(x.intent),/unresolved attempt/);
  assert.equal(x.state.monitorCalls,before);
 }finally{await x.cleanup();}
});
for(const status of [1,2])test(`mainnet session conservatively consumes status${status} capacity and never refunds it`,async()=>{
 const x=await setup();try{
  const {digest}=await x.guard.reserve(x.intent);x.state.receipts[digest]=status;
  await x.guard.recordOutcome(digest,hash('8'));
  await assert.rejects(()=>x.guard.check({...x.intent,nonce:1n}),/gross principal budget exhausted/);
  const ledger=JSON.parse(await readFile(join(x.policy.ledgerDirectory,'ledger.json'),'utf8'));
  assert.equal(ledger.entries.length,1);assert.equal(ledger.entries[0].message.principal,'5000');
 }finally{await x.cleanup();}
});
test('monitor failure does not reserve a digest and recovery preserves original transaction identity',async()=>{
 const x=await setup();try{
  x.state.monitorHeld=true;await assert.rejects(()=>x.guard.reserve(x.intent),/held monitor/);
  x.state.monitorHeld=false;const {digest}=await x.guard.reserve(x.intent);
  x.connection.client.getTransactionReceipt=async()=>{const e=Error('not found');e.name='TransactionReceiptNotFoundError';throw e;};
  await x.guard.recordOutcome(digest,hash('8'));
  await assert.rejects(()=>x.guard.recordOutcome(digest,hash('a')),/identity changed/);
  assert.equal(mainnetCircleSessionIntent(x.intent,x.connection).digest,digest);
 }finally{await x.cleanup();}
});
for(const status of [1,2])test(`late original hash is retained after terminal receipt status${status}`,async()=>{
 const x=await setup();try{
  const {digest}=await x.guard.reserve(x.intent);x.state.receipts[digest]=status;
  await x.guard.recordOutcome(digest,undefined);
  await x.guard.recordOutcome(digest,hash('8'));
  const ledger=JSON.parse(await readFile(join(x.policy.ledgerDirectory,'ledger.json'),'utf8'));
  assert.equal(ledger.entries[0].txHash,hash('8'));
  await assert.rejects(()=>x.guard.recordOutcome(digest,hash('a')),/identity changed/);
 }finally{await x.cleanup();}
});
