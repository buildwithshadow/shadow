import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import httpServer from 'node:http';
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, keccak256, stringToHex, decodeFunctionData } from 'viem';
import { account, startAnvil, runTool, e2eSkip } from './float-mainnet-e2e.mjs';
import { eip712Domain, SPEND_INTENT_TYPES } from './float-mainnet-config.mjs';
import { reconcileState } from './float-mainnet-monitor.mjs';
import { accountingModel, committedCapitalOfLines, readAccountingState } from './float-mainnet-accounting.mjs';

test('settled reconciliation checks both active capacity and retired unpaid debt', () => {
  const old={lineId:'old',state:'DEFAULTED',reserveCap:100n,availableReserve:0n,principalOutstanding:30n,recoveryAvailable:20n,sponsorClaimed:50n};
  const live={lineId:'live',state:'DRAWN',reserveCap:100n,availableReserve:60n,principalOutstanding:40n,recoveryAvailable:0n,sponsorClaimed:0n};
  const input={balance:80n,totalSponsorObligations:80n,totalCommittedCapital:100n,totalDefaultedPrincipal:30n,accountingModel:'settled-v1',lines:[old,live]};
  assert.equal(reconcileState(input).ok,true);
  assert.equal(committedCapitalOfLines(input.lines,'legacy-v1'),150n);
  assert.equal(committedCapitalOfLines(input.lines,'settled-v1'),100n);
  const missing=reconcileState({...input,lines:[live]});assert.equal(missing.ok,false);
  assert.equal(missing.checks.find(x=>x.id==='defaultedPrincipalEqualsLines').status,'FAIL');
  const debtOnly={...input,balance:0n,totalSponsorObligations:0n,totalCommittedCapital:0n,lines:[]};
  assert.equal(reconcileState(debtOnly).checks.find(x=>x.id==='defaultedPrincipalEqualsLines').status,'FAIL');
  assert.throws(()=>reconcileState({...input,totalDefaultedPrincipal:undefined}),/requires totalDefaultedPrincipal/);
  assert.equal(reconcileState({...input,totalDefaultedPrincipal:31n}).ok,false);
  assert.equal(reconcileState({...input,totalCommittedCapital:101n}).ok,false);
});

test('new accounting never falls back on a failed or malformed ledger read', async () => {
  assert.equal(accountingModel(),'legacy-v1');assert.throws(()=>accountingModel('auto'),/Unsupported/);
  assert.throws(()=>accountingModel(null),/Unsupported/);
  let calls=0;
  const connection={address:'0x'+'12'.repeat(20),accountingModel:'settled-v1',client:{readContract:async r=>{calls++;assert.equal(r.blockNumber,123n);throw Error('RPC unavailable');}}};
  await assert.rejects(readAccountingState(connection,123n),/RPC unavailable/);assert.equal(calls,1);
  connection.client.readContract=async()=>undefined;
  await assert.rejects(readAccountingState(connection,123n),/Invalid defaulted/);
  connection.client.readContract=async()=>{throw Error('legacy must not query the new getter');};
  assert.deepEqual(await readAccountingState({...connection,accountingModel:'legacy-v1'},123n),{accountingModel:'legacy-v1'});
});

test('settled CLI and canonical monitor follow default, permissionless settlement and late recovery', {skip:e2eSkip,timeout:60000}, async t => {
  const node=await startAnvil(19783);t.after(()=>node.stop());
  const chain=defineChain({id:5042002,name:'isolated settled test',nativeCurrency:{name:'test',symbol:'test',decimals:18},rpcUrls:{default:{http:[node.rpc]}}});
  const client=createPublicClient({chain,transport:http(node.rpc,{retryCount:0})});
  const [owner,sponsor,agent,provider]=[0,1,2,3].map(account);
  const wallet=a=>createWalletClient({account:a,chain,transport:http(node.rpc)});
  const artifact=name=>JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`,import.meta.url)));
  async function deploy(name,args){const a=artifact(name);const hash=await wallet(owner).deployContract({abi:a.abi,bytecode:a.bytecode.object,args});return (await client.waitForTransactionReceipt({hash})).contractAddress;}
  async function write(who,address,abi,functionName,args){const hash=await wallet(who).writeContract({address,abi,functionName,args});assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');return hash;}
  const token=await deploy('MockAsset',['test USDC','USDC',6]);
  const lim={protocolReserve:1000000n,lineReserve:100000n,lineSpend:200000n,perSpend:50000n,dailySpend:200000n};
  const target=await deploy('ShadowFloatMainnetPublicSettled',[token,5042002n,lim,lim,3600n,86400n,86400n]);
  const abi=artifact('ShadowFloatMainnetPublicSettled').abi;
  const read=(functionName,args=[])=>client.readContract({address:target,abi,functionName,args});
  const dir=mkdtempSync(join(tmpdir(),'settled-monitor-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const manifest=join(dir,'manifest.json');
  writeFileSync(manifest,JSON.stringify({ok:true,chainId:'5042002',contract:{address:target,accountingModel:'settled-v1'},deployment:{blockNumber:String(await client.getBlockNumber({cacheTime:0}))},bytecode:{onchainRuntimeKeccak256:keccak256(await client.getCode({address:target}))}}));
  const env={ARC_RPC_URL:node.rpc,FLOAT_MAINNET_EXPECTED_CHAIN_ID:'5042002',FLOAT_MAINNET_ADDRESS:target};
  for(const who of [sponsor,agent]){await write(owner,token,artifact('MockAsset').abi,'mint',[who.address,1000000n]);await write(who,token,erc20Abi,'approve',[target,1000000n]);}
  await write(owner,target,abi,'setOpeningsPaused',[false]);await write(owner,target,abi,'setSpendsPaused',[false]);await write(sponsor,target,abi,'registerSponsor',[]);
  const now=(await client.getBlock()).timestamp;const expiry=now+86400n;const endpointHash=keccak256(stringToHex('https://local.example/report'));
  await write(sponsor,target,abi,'openLine',[{agent:agent.address,reserve:100000n,lineSpendCap:200000n,dailySpendCap:200000n,lineExpiry:expiry,maximumRepaymentWindow:86400n,provider:provider.address,endpointHash,providerPerSpendCap:50000n,providerDailyCap:200000n,providerExpiry:expiry}]);
  const id=await read('activeLineId',[sponsor.address,agent.address]);
  async function draw(nonce){const timestamp=(await client.getBlock()).timestamp;const intent={agent:agent.address,sponsor:sponsor.address,lineId:id,lineEpoch:1n,termsHash:await read('currentTermsHash',[id,provider.address]),provider:provider.address,endpointHash,principal:50000n,maximumTotalDebt:50000n,dueAt:timestamp+7200n,nonce,signatureExpiry:timestamp+900n,executor:agent.address};const sig=await agent.signTypedData({domain:eip712Domain(5042002n,target),types:SPEND_INTENT_TYPES,primaryType:'SpendIntent',message:intent});await write(agent,target,abi,'executeSpend',[intent,sig]);return read('currentDrawDigest',[id]);}
  async function healthy(command='snapshot') {const result=await runTool('monitor',[command,'--manifest',manifest],env);assert.equal(result.status,0,JSON.stringify(result.json));assert(result.json.accounting?.checks.every(c=>c.status==='PASS')??result.json.checks.every(c=>c.status==='PASS'));return result.json;}
  const first=await draw(1n);
  const planned=await runTool('repay',['--line-id',id,'--full','--calldata','--from',agent.address,'--expected-draw',first],env);
  assert.equal(planned.status,0,JSON.stringify(planned.json));
  assert.equal(decodeFunctionData({abi,data:planned.json.calls.at(-1).data}).args[2],50000n);
  await write(agent,target,abi,'repayForDraw',[id,first,1n]);
  const partialPlan=await runTool('repay',['--line-id',id,'--amount','50000','--calldata','--from',agent.address,'--expected-draw',first,'--manifest',manifest],env);
  assert.equal(partialPlan.status,0,JSON.stringify(partialPlan.json));assert.equal(partialPlan.json.amountMode,'maximum');assert.equal(partialPlan.json.expectedTransfer,'49999');
  const legacyPlan=await runTool('repay',['--line-id',id,'--amount','50000','--calldata','--from',agent.address,'--expected-draw',first],env);assert.notEqual(legacyPlan.status,0);

  const before=await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[agent.address]});
  await write(agent,target,abi,'repayForDraw',[id,first,50000n]);
  assert.equal(before-await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[agent.address]}),49999n);
  await healthy();
  const second=await draw(2n);const due=(await read('getLine',[id])).dueAt;
  await client.request({method:'evm_setNextBlockTimestamp',params:[Number(due)]});await client.request({method:'evm_mine',params:[]});
  await write(sponsor,target,abi,'declareDefault',[id]);
  const snap=await healthy();assert.equal(snap.contract.accountingModel,'settled-v1');assert.equal(snap.contract.totalDefaultedPrincipal,'50000');
  await write(sponsor,target,abi,'claimDefaulted',[id]);await healthy('reconcile');
  // Omit only the opening log while zero active commitments and retired debt remain.
  const opening=keccak256(stringToHex('LineOpened(bytes32,address,address,uint64,uint256,uint64)'));
  const proxy=httpServer.createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const request=JSON.parse(raw);const response=await fetch(node.rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:raw});const body=await response.json();if(request.method==='eth_getLogs'&&Array.isArray(body.result))body.result=body.result.filter(log=>log.topics[0]!==opening);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));}catch{res.writeHead(502);res.end();}});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();}));
  const missing=await runTool('monitor',['snapshot','--manifest',manifest],{...env,ARC_RPC_URL:`http://127.0.0.1:${proxy.address().port}`});
  assert.notEqual(missing.status,0);assert(missing.json.alerts?.some(a=>a.code==='DISCOVERY_INCOMPLETE'),JSON.stringify(missing.json));
  await client.request({method:'evm_setNextBlockTimestamp',params:[Number(expiry+1n)]});await client.request({method:'evm_mine',params:[]});
  await write(owner,target,abi,'settleExpiredLine',[id]);await healthy();
  await write(agent,target,abi,'repayForDraw',[id,second,20000n]);await healthy();
  await write(owner,target,abi,'settleExpiredLine',[id]);await healthy();
  await write(agent,target,abi,'repayForDraw',[id,second,50000n]);await write(owner,target,abi,'settleExpiredLine',[id]);
  const final=await healthy();assert.equal(final.lines[0].state,'CLOSED');assert.equal(final.contract.totalDefaultedPrincipal,'0');
  const indexPath=join(dir,'index.json');const indexed=await runTool('indexer',['index','--manifest',manifest,'--out',indexPath],env);assert.equal(indexed.status,0,JSON.stringify(indexed.json));
  const settlements=JSON.parse(readFileSync(indexPath)).events.filter(e=>e.event==='ExpiredLineSettled');
  assert.deepEqual(settlements.map(e=>[e.args.returned,e.args.principalOutstanding]),[['0','50000'],['20000','30000'],['30000','0']]);
  assert(settlements.every(e=>e.args.sponsor===sponsor.address&&e.args.caller===owner.address));
});
