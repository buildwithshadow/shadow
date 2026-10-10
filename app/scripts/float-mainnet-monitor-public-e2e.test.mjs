import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicClient,createWalletClient,createTestClient,defineChain,http,keccak256,stringToHex,decodeEventLog} from 'viem';
import {account,startAnvil,e2eSkip} from './float-mainnet-e2e.mjs';
import {collectSnapshot,loadContext} from './float-mainnet-monitor-runner.mjs';
import {evaluateSnapshot} from './float-mainnet-monitor-public-policy.mjs';

test('public observer follows a self registered sponsor through real local payment, maturity, exact repayment and reclaim without roster edits',{skip:e2eSkip,timeout:90000},async()=>{
 const anvil=await startAnvil(18743,[],5042n),dir=mkdtempSync(join(tmpdir(),'shadow-public-monitor-'));
 try{
  const chain=defineChain({id:5042,name:'Local Arc fixture',nativeCurrency:{name:'Test',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[anvil.rpc]}}});
  const client=createPublicClient({chain,transport:http(anvil.rpc),cacheTime:0,pollingInterval:20}),time=createTestClient({chain,mode:'anvil',transport:http(anvil.rpc)});
  const owner=account(0),sponsor=account(2),agent=account(3),provider=account(4),executor=account(5);
  const wallet=who=>createWalletClient({account:who,chain,transport:http(anvil.rpc)});
  const artifact=name=>JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`,import.meta.url),'utf8'));
  async function write(who,address,abi,functionName,args){const hash=await wallet(who).writeContract({address,abi,functionName,args});const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');return receipt;}
  async function deploy(name,args){const a=artifact(name),hash=await wallet(owner).deployContract({abi:a.abi,bytecode:a.bytecode.object,args});const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');return {...a,address:receipt.contractAddress,block:receipt.blockNumber};}
  const token=await deploy('MockAsset',['USDC','USDC',6]),limits={protocolReserve:1000000n,lineReserve:100000n,lineSpend:5000n,perSpend:5000n,dailySpend:5000n};
  const shadow=await deploy('ShadowFloatMainnetPublic',[token.address,5042n,limits,limits,3600n,86400n,172800n]);
  for(const who of [sponsor,agent])await write(owner,token.address,token.abi,'mint',[who.address,100000n]);
  await write(owner,shadow.address,shadow.abi,'setOpeningsPaused',[false]);await write(owner,shadow.address,shadow.abi,'setSpendsPaused',[false]);
  const manifestPath=join(dir,'manifest.json'),baselinePath=join(dir,'baseline.json');
  const runtime=keccak256(await client.getCode({address:shadow.address}));
  writeFileSync(manifestPath,JSON.stringify({ok:true,chainId:'5042',contract:{address:shadow.address},bytecode:{onchainRuntimeKeccak256:runtime},deployment:{blockNumber:String(shadow.block)},publicRegistration:true,repaymentBindingVersion:2}));
  const baseline={schemaVersion:2,identity:{chainId:'5042',address:shadow.address.toLowerCase(),runtimeCodeHash:runtime,usdc:token.address.toLowerCase(),deployBlock:String(shadow.block)},owner:owner.address.toLowerCase(),operators:[],sponsors:[],lines:[],effectiveLimits:Object.fromEntries(Object.entries(limits).map(([k,v])=>[k,String(v)])),pauses:{openingsPaused:false,spendsPaused:false},executor:{address:executor.address.toLowerCase(),fromBlock:String(shadow.block)},policy:{intervalMs:1000,runTimeoutMs:50000,maxHeartbeatAgeMs:60000,maxBlockAgeSeconds:120,maxIndexLagSeconds:120,warnBeforeSeconds:60,requireIndex:false},publicAdmission:{minimumRepaymentWindow:'3600',maximumRepaymentWindow:'86400'}};
  writeFileSync(baselinePath,JSON.stringify(baseline));const frozen=readFileSync(baselinePath,'utf8');
  const context=loadContext({manifestPath,baselinePath,stateDir:join(dir,'state')});
  async function observe(){const s=await collectSnapshot(context,{rpcUrl:anvil.rpc}),r=evaluateSnapshot(baseline,s,Number(s.observedAt.timestamp)*1000);assert.equal(r.ok,true,JSON.stringify(r.alerts));assert.equal(readFileSync(baselinePath,'utf8'),frozen);return {s,r};}
  await write(sponsor,shadow.address,shadow.abi,'registerSponsor',[]);await observe();
  await write(sponsor,token.address,token.abi,'approve',[shadow.address,100000n]);const now=(await client.getBlock()).timestamp;
  const params={agent:agent.address,reserve:100000n,lineSpendCap:5000n,dailySpendCap:5000n,lineExpiry:now+604800n,maximumRepaymentWindow:86400n,provider:provider.address,endpointHash:keccak256(stringToHex('https://provider.example/report')),providerPerSpendCap:5000n,providerDailyCap:5000n,providerExpiry:now+604800n};
  const opened=await write(sponsor,shadow.address,shadow.abi,'openLine',[params]);const lineId=opened.logs.map(l=>{try{return decodeEventLog({abi:shadow.abi,data:l.data,topics:l.topics})}catch{return null}}).find(e=>e?.eventName==='LineOpened').args.lineId;await observe();
  const read=(functionName,args)=>client.readContract({address:shadow.address,abi:shadow.abi,functionName,args});
  const t=(await client.getBlock()).timestamp,intent={agent:agent.address,sponsor:sponsor.address,lineId,lineEpoch:1n,termsHash:await read('currentTermsHash',[lineId,provider.address]),provider:provider.address,endpointHash:params.endpointHash,principal:5000n,maximumTotalDebt:5000n,dueAt:t+7200n,nonce:0n,signatureExpiry:t+900n,executor:executor.address};
  const digest=await read('hashSpendIntent',[intent]),signature=await agent.sign({hash:digest});
  await write(executor,shadow.address,shadow.abi,'executeSpend',[intent,signature]);const paid=await observe();assert.equal(paid.s.executionAudit.executions[0].route,'direct-intent');
  await time.setNextBlockTimestamp({timestamp:t+10800n});await time.mine({blocks:1});const matured=await observe();assert.equal(matured.r.notices[0].code,'DEFAULT_ELIGIBLE');
  await write(agent,token.address,token.abi,'approve',[shadow.address,5000n]);await write(agent,shadow.address,shadow.abi,'repayForDraw',[lineId,digest,5000n]);await observe();
  await write(sponsor,shadow.address,shadow.abi,'closeLine',[lineId]);const closed=await observe();assert.equal(closed.s.lines[0].state,'CLOSED');assert.equal(closed.s.contract.totalSponsorObligations,'0');
  assert.equal(await client.readContract({address:token.address,abi:token.abi,functionName:'balanceOf',args:[provider.address]}),5000n);
 }finally{await anvil.stop();rmSync(dir,{recursive:true,force:true});}
});
