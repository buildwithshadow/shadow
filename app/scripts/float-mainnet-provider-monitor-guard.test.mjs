import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256} from 'viem';
import {createProviderMonitorGuard,createTestnetProviderMonitorGuard,createSettledTestnetProviderMonitorGuard,configureProviderAdmission} from './float-mainnet-provider-monitor-guard.mjs';
import {loadContext,runMonitorOnce} from './float-mainnet-monitor-runner.mjs';
import {SETTLED_MAINNET_CANDIDATE} from '../settledMainnetCandidate.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
async function fixture({testnet=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'shadow-provider-monitor-'));
 const now=Date.now(), timestamp=String(Math.floor(now/1000)),code='0x1234',runtime=keccak256(code);
 const limits={protocolReserve:'1000000',lineReserve:'100000',lineSpend:'5000',perSpend:'5000',dailySpend:'5000'};
 const baseline={schemaVersion:2,identity:{chainId:'5042',address:addr(1),runtimeCodeHash:runtime,usdc:addr(8),deployBlock:'10'},owner:addr(2),operators:[],sponsors:[],effectiveLimits:limits,pauses:{openingsPaused:false,spendsPaused:false},lines:[],executor:{address:addr(9),fromBlock:'10'},policy:{intervalMs:1000,runTimeoutMs:5000,maxHeartbeatAgeMs:10000,maxBlockAgeSeconds:120,maxIndexLagSeconds:120,warnBeforeSeconds:3600,requireIndex:false},publicAdmission:{minimumRepaymentWindow:'3600',maximumRepaymentWindow:'86400'}};
 const snapshot={ok:true,identity:{chainId:'5042',address:addr(1),runtimeCodeHash:runtime,usdc:addr(8)},observedAt:{blockNumber:'100',blockHash:hash(100),timestamp},contract:{address:addr(1),owner:addr(2),pendingOwner:addr(0),openingsPaused:false,spendsPaused:false,effectiveLimits:limits,pendingCapIncreases:[],operators:[],totalSponsorObligations:'0',totalCommittedCapital:'0'},sponsors:[],discovery:{lines:0,scanned:{fromBlock:'10',toBlock:'100'},index:null},lines:[],alerts:[],accounting:{ok:true,balance:'0',checks:['balanceCoversObligations','obligationsEqualLines','committedCapitalEqualsLines','linesMatchReserveCap'].map(id=>({id,status:'PASS'}))},executionAudit:{fromBlock:'10',toBlock:'100',executions:[]}};
 const manifest={ok:true,chainId:'5042',publicRegistration:true,repaymentBindingVersion:2,contract:{address:addr(1)},bytecode:{onchainRuntimeKeccak256:runtime}};
 if(testnet){
  baseline.schemaVersion=1;baseline.identity.chainId='5042002';delete baseline.publicAdmission;
  snapshot.identity.chainId='5042002';manifest.chainId='5042002';
  manifest.kind='shadow-public-bounded-testnet-release';manifest.contract.name='ShadowFloatMainnetPublicBounded';
  manifest.config={maximumLineLifetime:'604800'};
  if(testnet==='settled') {
   baseline.accountingModel='settled-v1';manifest.contract.accountingModel='settled-v1';
   manifest.kind='shadow-public-settled-testnet-release';manifest.contract.name='ShadowFloatMainnetPublicSettled';
   snapshot.contract.accountingModel='settled-v1';snapshot.contract.totalDefaultedPrincipal='0';
   snapshot.accounting.checks.push({id:'defaultedPrincipalEqualsLines',status:'PASS'});
  }
 }
 const baselinePath=join(directory,'baseline.json'),manifestPath=join(directory,'manifest.json'),stateDir=join(directory,'state');
 writeFileSync(baselinePath,JSON.stringify(baseline));writeFileSync(manifestPath,JSON.stringify(manifest));
 const context=loadContext({baselinePath,manifestPath,stateDir});
 assert.equal((await runMonitorOnce(context,{collect:async()=>snapshot})).ok,true);
 const connection={chainId:testnet?5042002n:5042n,address:addr(1),client:{getBlock:async()=>({number:100n,hash:hash(100),timestamp:BigInt(timestamp)}),getCode:async()=>code}};
 const options={connection,baselinePath,manifestPath,stateDir};
 return {options,context,baseline,manifest,directory,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('provider admission verifies a fresh public heartbeat and canonical deployed runtime',async()=>{
 const f=await fixture();try{await createProviderMonitorGuard(f.options)();}finally{f.cleanup();}
});
test('settled mainnet provider startup accepts its pinned profile but cannot reuse the previous profile heartbeat',async()=>{
 const f=await fixture();try{
  f.baseline.accountingModel='settled-v1';
  Object.assign(f.baseline.identity,{address:SETTLED_MAINNET_CANDIDATE.address,runtimeCodeHash:SETTLED_MAINNET_CANDIDATE.runtimeHash});
  for(const key of ['lineSpend','perSpend','dailySpend'])f.baseline.effectiveLimits[key]='50000';
  Object.assign(f.manifest.contract,{address:SETTLED_MAINNET_CANDIDATE.address,accountingModel:'settled-v1'});
  f.manifest.bytecode.onchainRuntimeKeccak256=SETTLED_MAINNET_CANDIDATE.runtimeHash;
  f.options.connection.address=SETTLED_MAINNET_CANDIDATE.address;
  writeFileSync(f.options.baselinePath,JSON.stringify(f.baseline));writeFileSync(f.options.manifestPath,JSON.stringify(f.manifest));
  const guard=configureProviderAdmission({...f.options,mode:'public-monitor'});
  await assert.rejects(guard,/could not be verified/);
 }finally{f.cleanup();}
});
for(const testnet of [false,true,'settled']) for(const [name,change] of [
 ['missing heartbeat',f=>rmSync(join(f.options.stateDir,'heartbeat.json'))],
 ['latched hold',f=>writeFileSync(join(f.options.stateDir,'hold.json'),JSON.stringify({incidentId:'test'}))],
 ['stale heartbeat',f=>{const p=join(f.options.stateDir,'heartbeat.json');const h=JSON.parse(readFileSync(p));h.startedAt=h.completedAt=new Date(Date.now()-60000).toISOString();writeFileSync(p,JSON.stringify(h));}],
 ['substituted canonical observation',f=>{const p=join(f.options.stateDir,'heartbeat.json');const h=JSON.parse(readFileSync(p));h.observedAt={...h.observedAt,blockNumber:'101',blockHash:hash(101)};writeFileSync(p,JSON.stringify(h));f.options.connection.client.getBlock=async()=>({number:101n,hash:hash(101),timestamp:BigInt(h.observedAt.timestamp)});}],
 ['checking heartbeat',f=>{const p=join(f.options.stateDir,'heartbeat.json');const h=JSON.parse(readFileSync(p));h.status='checking';writeFileSync(p,JSON.stringify(h));}],
 ['changed policy',f=>{f.baseline.policy.maxHeartbeatAgeMs=20000;writeFileSync(f.options.baselinePath,JSON.stringify(f.baseline));}],
 ['changed manifest',f=>{f.manifest.extra='changed';writeFileSync(f.options.manifestPath,JSON.stringify(f.manifest));}],
 ['runtime mismatch',f=>{f.options.connection.client.getCode=async()=> '0x5678';}],
 ['noncanonical observation',f=>{f.options.connection.client.getBlock=async()=>({number:100n,hash:hash(99),timestamp:1n});}],
 ['hold during canonical reads',f=>{f.options.connection.client.getCode=async()=>{writeFileSync(join(f.options.stateDir,'hold.json'),JSON.stringify({incidentId:'during-read'}));return '0x1234';};}],
])test(`${testnet==='settled'?'settled testnet':testnet?'bounded testnet':'mainnet'} provider refuses ${name}`,async()=>{const f=await fixture({testnet});try{const guard=(testnet==='settled'?createSettledTestnetProviderMonitorGuard:testnet?createTestnetProviderMonitorGuard:createProviderMonitorGuard)(f.options);change(f);await assert.rejects(guard);}finally{f.cleanup();}});
test('provider startup refuses missing configuration and wrong release identity',async()=>{
 const f=await fixture();try{
  assert.throws(()=>createProviderMonitorGuard({...f.options,baselinePath:undefined}));
  assert.throws(()=>createProviderMonitorGuard({...f.options,connection:{...f.options.connection,address:addr(99)}}));
  f.manifest.bytecode.onchainRuntimeKeccak256=hash(99);writeFileSync(f.options.manifestPath,JSON.stringify(f.manifest));
  assert.throws(()=>createProviderMonitorGuard(f.options));
 }finally{f.cleanup();}
});

test('bounded testnet uses a healthy fixed monitor and cannot substitute either mainnet mode',async()=>{
 const rehearsal=await fixture({testnet:true}),mainnet=await fixture();
 try{
  const guard=configureProviderAdmission({...rehearsal.options,mode:'testnet-monitor'});
  assert.equal(typeof guard,'function');await guard();
  assert.throws(()=>createProviderMonitorGuard(rehearsal.options));
  assert.throws(()=>configureProviderAdmission({...rehearsal.options,mode:'public-monitor'}));
  assert.throws(()=>createTestnetProviderMonitorGuard(mainnet.options));
  assert.throws(()=>configureProviderAdmission({...mainnet.options,mode:'testnet-monitor'}));
 }finally{rehearsal.cleanup();mainnet.cleanup();}
});

for(const [name,mutate] of [
 ['missing version marker',m=>delete m.kind],
 ['wrong version marker',m=>{m.kind='shadow-public-mainnet-release';}],
 ['wrong contract generation',m=>{m.contract.name='ShadowFloatMainnetPublic';}],
 ['missing original expiry bound',m=>{delete m.config;}],
 ['different original expiry bound',m=>{m.config.maximumLineLifetime='604801';}],
 ['missing public registration',m=>{delete m.publicRegistration;}],
 ['legacy repayment',m=>{m.repaymentBindingVersion=1;}],
])test(`bounded testnet startup refuses ${name}`,async()=>{
 const f=await fixture({testnet:true});try{
  mutate(f.manifest);writeFileSync(f.options.manifestPath,JSON.stringify(f.manifest));
  assert.throws(()=>createTestnetProviderMonitorGuard(f.options));
 }finally{f.cleanup();}
});

test('bounded testnet does not sign while spending is paused',async()=>{
 const f=await fixture({testnet:true});try{
  f.baseline.pauses.spendsPaused=true;writeFileSync(f.options.baselinePath,JSON.stringify(f.baseline));
  const guard=createTestnetProviderMonitorGuard(f.options);
  await assert.rejects(guard);
 }finally{f.cleanup();}
});

test('signing startup requires an explicit validated mode and never falls back on a missing public marker',async()=>{
 const f=await fixture();try{
  for(const mode of [undefined,'','legacy','testnet-unmonitored']) assert.throws(()=>configureProviderAdmission({...f.options,mode}));
  assert.equal(typeof configureProviderAdmission({...f.options,mode:'public-monitor'}),'function');
  assert.throws(()=>configureProviderAdmission({...f.options,mode:'public-monitor',manifestPath:undefined}));
  for(const marker of [undefined,false]){
   f.manifest.publicRegistration=marker;writeFileSync(f.options.manifestPath,JSON.stringify(f.manifest));
   assert.throws(()=>configureProviderAdmission({...f.options,mode:'public-monitor'}));
  }
  assert.equal(configureProviderAdmission({mode:'testnet-unmonitored',connection:{chainId:5042002n}}),null);
  for(const chainId of [undefined,1n,31337n]) assert.throws(()=>configureProviderAdmission({mode:'testnet-unmonitored',connection:{chainId}}));
  assert.equal(configureProviderAdmission({recoveryOnly:true}),null);
 }finally{f.cleanup();}
});

test('settled provider requires its own accounting mode and cannot substitute bounded or mainnet policy',async()=>{
 const f=await fixture({testnet:'settled'}),bounded=await fixture({testnet:true}),mainnet=await fixture();
 try{
  await configureProviderAdmission({...f.options,mode:'settled-testnet-monitor'})();
  assert.throws(()=>configureProviderAdmission({...f.options,mode:'testnet-monitor'}));
  assert.throws(()=>configureProviderAdmission({...f.options,mode:'public-monitor'}));
  for(const other of [bounded,mainnet]) assert.throws(()=>configureProviderAdmission({...other.options,mode:'settled-testnet-monitor'}));
 }finally{f.cleanup();bounded.cleanup();mainnet.cleanup();}
});
for(const [name,mutate] of [
 ['missing model',m=>delete m.contract.accountingModel],
 ['legacy model',m=>m.contract.accountingModel='legacy-v1'],
 ['wrong generation',m=>m.contract.name='ShadowFloatMainnetPublicBounded'],
 ['wrong marker',m=>m.kind='shadow-public-bounded-testnet-release'],
 ['missing lifetime',m=>delete m.config],
 ['wrong lifetime',m=>m.config.maximumLineLifetime='604801'],
 ['legacy repayment',m=>m.repaymentBindingVersion=1],
])test(`settled provider startup rejects ${name}`,async()=>{
 const f=await fixture({testnet:'settled'});
 try{mutate(f.manifest);writeFileSync(f.options.manifestPath,JSON.stringify(f.manifest));assert.throws(()=>createSettledTestnetProviderMonitorGuard(f.options));}
 finally{f.cleanup();}
});
test('settled provider holds while its protected spending phase is paused',async()=>{
 const f=await fixture({testnet:'settled'});
 try{f.baseline.pauses.spendsPaused=true;writeFileSync(f.options.baselinePath,JSON.stringify(f.baseline));await assert.rejects(createSettledTestnetProviderMonitorGuard(f.options));}
 finally{f.cleanup();}
});
