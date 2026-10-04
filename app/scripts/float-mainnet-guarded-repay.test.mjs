import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createPublicClient,createWalletClient,decodeFunctionData,defineChain,http,keccak256,stringToHex,erc20Abi} from 'viem';
import {account,startAnvil,runTool,e2eSkip} from './float-mainnet-e2e.mjs';
import {eip712Domain,SPEND_INTENT_TYPES} from './float-mainnet-config.mjs';

test('repayment CLI binds to a draw and refuses stale or implicit generic consent', {skip:e2eSkip,timeout:60000}, async t=> {
 const node=await startAnvil(19781);t.after(()=>node.stop());
 const chain=defineChain({id:5042002,name:'isolated local',nativeCurrency:{name:'test',symbol:'test',decimals:18},rpcUrls:{default:{http:[node.rpc]}}});
 const c=createPublicClient({chain,transport:http(node.rpc,{retryCount:0})});
 const [owner,sponsor,agent,provider]=[0,1,2,3].map(account);
 const wallet=a=>createWalletClient({account:a,chain,transport:http(node.rpc)});
 const artifact=name=>JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`,import.meta.url)));
 async function deploy(name,args){const a=artifact(name),hash=await wallet(owner).deployContract({abi:a.abi,bytecode:a.bytecode.object,args});return (await c.waitForTransactionReceipt({hash})).contractAddress;}
 async function write(who,address,abi,functionName,args){const hash=await wallet(who).writeContract({address,abi,functionName,args});assert.equal((await c.waitForTransactionReceipt({hash})).status,'success');}
 const usdc=await deploy('MockAsset',['test USDC','USDC',6]);
 const limits={protocolReserve:5000000n,lineReserve:1000000n,lineSpend:2000000n,perSpend:500000n,dailySpend:1000000n};
 const target=await deploy('ShadowFloatMainnetGuarded',[usdc,5042002n,limits,limits,3600n,86400n,172800n]);
 const abi=artifact('ShadowFloatMainnetGuarded').abi;
 const read=(functionName,args=[])=>c.readContract({address:target,abi,functionName,args});
 for(const who of [sponsor,agent]){await write(owner,usdc,artifact('MockAsset').abi,'mint',[who.address,1000000n]);await write(who,usdc,erc20Abi,'approve',[target,100000n]);}
 for(const flag of ['setOpeningsPaused','setSpendsPaused'])await write(owner,target,abi,flag,[false]);
 await write(owner,target,abi,'setSponsorAllowed',[sponsor.address,true]);
 const now=(await c.getBlock()).timestamp,endpointHash=keccak256(stringToHex('https://local.example/report'));
 await write(sponsor,target,abi,'openLine',[{agent:agent.address,reserve:100000n,lineSpendCap:200000n,dailySpendCap:200000n,lineExpiry:now+86400n,maximumRepaymentWindow:86400n,provider:provider.address,endpointHash,providerPerSpendCap:50000n,providerDailyCap:200000n,providerExpiry:now+86400n}]);
 const id=await read('activeLineId',[sponsor.address,agent.address]);
 async function draw(nonce){const timestamp=(await c.getBlock()).timestamp;const intent={agent:agent.address,sponsor:sponsor.address,lineId:id,lineEpoch:1n,termsHash:await read('currentTermsHash',[id,provider.address]),provider:provider.address,endpointHash,principal:50000n,maximumTotalDebt:50000n,dueAt:timestamp+7200n,nonce,signatureExpiry:timestamp+900n,executor:agent.address};const signature=await agent.signTypedData({domain:eip712Domain(5042002n,target),types:SPEND_INTENT_TYPES,primaryType:'SpendIntent',message:intent});await write(agent,target,abi,'executeSpend',[intent,signature]);return read('currentDrawDigest',[id]);}
 const first=await draw(1n);
 const env={ARC_RPC_URL:node.rpc,FLOAT_MAINNET_EXPECTED_CHAIN_ID:'5042002',FLOAT_MAINNET_ADDRESS:target};
 const flags=['--line-id',id,'--full','--calldata','--from',sponsor.address];
 const implicit=await runTool('repay',flags,env);assert.notEqual(implicit.status,0);assert.match(JSON.stringify(implicit.json),/requires --allow-current-line-debt/);
 const valid=await runTool('repay',[...flags,'--expected-draw',first],env);assert.equal(valid.status,0,JSON.stringify(valid.json));assert.equal(decodeFunctionData({abi,data:valid.json.calls.at(-1).data}).functionName,'repayForDraw');assert.equal(valid.json.consent,'reviewed-purchase-only');
 await write(agent,target,abi,'repayForDraw',[id,first,50000n]);await draw(2n);
 const stale=await runTool('repay',[...flags,'--expected-draw',first],env);assert.notEqual(stale.status,0);assert.match(JSON.stringify(stale.json),/not the current draw/);
 assert.equal((await read('getLine',[id])).principalOutstanding,50000n);
});
