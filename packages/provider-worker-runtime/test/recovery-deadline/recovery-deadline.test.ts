import {env,exports} from 'cloudflare:workers';
import {beforeAll,describe,expect,it} from 'vitest';
import {createPublicClient,createWalletClient,defineChain,getAddress,http,parseAbi,parseEventLogs,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {connectCandidate,floatAbi} from '../../../../app/scripts/float-mainnet-config.mjs';
import {intentDigest,intentFile} from '../../../../app/scripts/float-mainnet-intent.mjs';
import {acceptIntent,deliverResult,resultHashOf} from '../../../../app/scripts/float-mainnet-provider.mjs';
import {approvedDeployment} from '../../src/verified-connection.ts';
import {readProviderConfig} from '../../src/config.ts';
import {ADDR,ENDPOINT_HASH,KEYS,PRICE,RESERVE} from './constants.ts';
import {canonical,configuredIdentity,importThroughCoordinator,recordStoreFor,coordinator} from '../helpers.ts';

// REGRESSION: an old delivered record without payment.json is recovered without a payment hash by scanning logs back
// through the chain. The payment, acceptance and delivery come from the actual settled contract on an isolated local
// anvil (chain 5042) through the provider kit; the token is MockUSDC (TEST SIMULATION). Only the read path reports an
// inflated head so the scan has hundreds of batches (see worker.ts).
const e=env as unknown as Record<string,string>;
const URL=e.LOCAL_RPC_URL,FLOAT=getAddress(e.CONTRACT),MOCK=getAddress(e.MOCK_USDC);
const chain=defineChain({id:5042,name:'local-5042',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[URL]}}});
const pub=createPublicClient({chain,transport:http(URL)});
const wallet=(k:Hex)=>createWalletClient({chain,transport:http(URL),account:privateKeyToAccount(k)});
const tuple='(address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor)';
const extra=parseAbi([
 'function registerSponsor()',`function executeSpend(${tuple} intent,bytes signature) returns (bool,uint8)`,
 'function openLine((address agent,uint256 reserve,uint256 lineSpendCap,uint256 dailySpendCap,uint64 lineExpiry,uint64 maximumRepaymentWindow,address provider,bytes32 endpointHash,uint256 providerPerSpendCap,uint256 providerDailyCap,uint64 providerExpiry) params) returns (bytes32)',
 'function setOpeningsPaused(bool)','function setSpendsPaused(bool)',
]);
const tokenAbi=parseAbi(['function mint(address,uint256)','function approve(address,uint256) returns (bool)']);
async function send(key:Hex,address:Hex,abi:any,functionName:string,args:unknown[]){
 const hash=await wallet(key).writeContract({address,abi,functionName,args,chain} as never);
 const receipt=await pub.waitForTransactionReceipt({hash,timeout:10000,pollingInterval:20});expect(receipt.status,`${functionName} reverted`).toBe('success');return receipt;
}
let rpcId=0;
const plainProvider={request:async({method,params=[]}:{method:string;params?:unknown[]})=>{
 const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});
 const b=await r.json() as {result?:unknown;error?:{code?:number;message?:string}};if(b.error)throw Object.assign(Error(b.error.message),{code:b.error.code});return b.result;
}};

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function serve(ip:string,body:Record<string,unknown>){
 const started=Date.now();
 const r=await exports.default.fetch('https://provider.example.test/serve',{method:'POST',headers:{'cf-connecting-ip':ip,'content-type':'application/json'},body:JSON.stringify(body)});
 const text=await r.text();return {status:r.status,text,ms:Date.now()-started,json:()=>JSON.parse(text) as Record<string,any>};
}
const stub=async()=>(await coordinator()) as any;
const counters=async()=>(await stub()).__counters() as {getLogs:number;total:number};
const setDeadline=async(ms:number)=>(await stub()).__setDeadline(ms);
const readRecord=async(name:string)=>{const b=await (await recordStoreFor(configuredIdentity())).read(configuredIdentity(),name) as Uint8Array|null;return b===null?null:Buffer.from(b).toString('hex');};

const state={} as {digest:Hex;paymentTx:Hex;openLineTx:Hex;stored:Record<string,string|null>;resultB64:string;deliveryText:string};

beforeAll(async()=>{
 // ---- real chain: setup, agent-signed intent, kit acceptance, real executeSpend, kit delivery ----
 await send(KEYS.owner,FLOAT,extra,'setOpeningsPaused',[false]);
 await send(KEYS.sponsor,FLOAT,extra,'registerSponsor',[]);
 await send(KEYS.owner,FLOAT,extra,'setSpendsPaused',[false]);
 await send(KEYS.sponsor,MOCK,tokenAbi,'mint',[ADDR.sponsor,RESERVE]);
 await send(KEYS.sponsor,MOCK,tokenAbi,'approve',[FLOAT,RESERVE]);
 const head=await pub.getBlock();
 const opened=await send(KEYS.sponsor,FLOAT,extra,'openLine',[{agent:ADDR.agent,reserve:RESERVE,lineSpendCap:5000n,dailySpendCap:5000n,lineExpiry:head.timestamp+3n*86400n,maximumRepaymentWindow:86400n,provider:ADDR.provider,endpointHash:ENDPOINT_HASH,providerPerSpendCap:5000n,providerDailyCap:5000n,providerExpiry:head.timestamp+3n*86400n}]);
 const read=(functionName:string,args:unknown[]=[])=>pub.readContract({address:FLOAT,abi:[...floatAbi,...extra] as never,functionName,args} as never) as Promise<any>;
 const lineId=await read('activeLineId',[ADDR.sponsor,ADDR.agent]) as Hex;
 const now=(await pub.getBlock()).timestamp;
 const struct={agent:ADDR.agent,sponsor:ADDR.sponsor,lineId,lineEpoch:1n,termsHash:await read('currentTermsHash',[lineId,ADDR.provider]) as Hex,provider:ADDR.provider,endpointHash:ENDPOINT_HASH,principal:PRICE,maximumTotalDebt:PRICE,dueAt:now+7200n,nonce:7n,signatureExpiry:now+1800n,executor:ADDR.executor};
 const digest=intentDigest(5042n,FLOAT,struct) as Hex;
 const signature=await privateKeyToAccount(KEYS.agent).sign({hash:digest});
 const intent=intentFile({chainId:5042n,verifyingContract:FLOAT,struct,signature,signerKind:'eoa'});
 const parsed=readProviderConfig(e);if(!parsed.ok)throw Error('config');
 const connection=await connectCandidate({...approvedDeployment(e.MANIFEST_JSON,parsed.config),readSpacingMs:5},{readOnly:true,readProvider:plainProvider});
 const provider=privateKeyToAccount(KEYS.provider);
 const {acceptance}=await acceptIntent(connection,{intent,endpointHash:ENDPOINT_HASH,price:PRICE,requestId:'request-1',account:{address:provider.address,signTypedData:provider.signTypedData}});
 const paid=await send(KEYS.executor,FLOAT,extra,'executeSpend',[struct,signature]);
 expect(parseEventLogs({abi:floatAbi as never,logs:paid.logs,eventName:'ProviderPaid'})).toHaveLength(1);
 const resultBytes=Buffer.from('original paid result\n');
 const {delivery}=await deliverResult(connection,{acceptance,resultHash:resultHashOf(resultBytes),resultRef:undefined,fromBlock:undefined,account:{address:provider.address,signTypedData:provider.signTypedData},transactionHash:paid.transactionHash});
 // ---- the OLD record: acceptance, delivery and result retained; NO payment.json ----
 const result={digest,requestId:'request-1',result:resultBytes.toString('base64'),resultRef:null};
 const records=[{name:`${digest}.acceptance.json`,bytes:canonical(acceptance)},{name:`${digest}.delivery.json`,bytes:canonical(delivery)},{name:`${digest}.result.json`,bytes:canonical(result)}];
 await importThroughCoordinator(records);
 Object.assign(state,{digest,paymentTx:paid.transactionHash,openLineTx:opened.transactionHash,resultB64:result.result,deliveryText:Buffer.from(records[1].bytes).toString('utf8')});
 state.stored={acceptance:await readRecord(records[0].name),delivery:await readRecord(records[1].name),result:await readRecord(records[2].name),payment:await readRecord(`${digest}.payment.json`)};
 expect(state.stored.payment).toBeNull();
});

const ips={a:'203.0.113.11',b:'203.0.113.12',c:'203.0.113.13',d:'203.0.113.14'};

describe('recovery of a delivered record without payment.json',()=>{
 it('retires transient read retries in the actual shared queue so a hinted retry can finish',async()=>{
  await setDeadline(400);
  await (await stub()).__failLogs(true);
  try {
   const before=await counters();
   const expired=await serve(ips.a,{digest:state.digest});
   expect(expired.status).toBe(503);
   const stopped=(await counters()).getLogs;
   expect(stopped-before.getLogs).toBe(1);
   const retry=await serve(ips.b,{digest:state.digest,paymentTransactionHash:state.paymentTx});
   expect(retry.status,retry.text).toBe(200);
   expect(retry.json()).toEqual({result:state.resultB64,delivery:JSON.parse(state.deliveryText)});
   await sleep(800);
   expect((await counters()).getLogs).toBe(stopped);
  } finally {await (await stub()).__failLogs(false);}
 });

 it('bounds abandoned hashless lookups: reads stop, capacity returns, and the original hash then completes',async()=>{
  await setDeadline(400);
  const before=await counters();
  // Two callers send the hashless recovery and stop waiting; the provider keeps working for them.
  const abandonedA=serve(ips.a,{digest:state.digest}),abandonedB=serve(ips.b,{digest:state.digest});
  await sleep(120);
  // Both recovery slots are held by the abandoned lookup, so a third caller is refused (inside the bounded window only).
  const refused=await serve(ips.c,{digest:state.digest,paymentTransactionHash:state.paymentTx});
  expect(refused.status).toBe(429);
  // The deadline ends the lookup: both abandoned requests answer with the retryable deadline error.
  const [a,b]=await Promise.all([abandonedA,abandonedB]);
  for(const r of [a,b]){expect(r.status).toBe(503);expect(r.json().error).toMatch(/payment lookup timed out.*transaction hash/);expect(r.ms).toBeLessThan(5000);}
  const stopped=await counters();
  expect(stopped.getLogs-before.getLogs).toBeGreaterThan(0);
  expect(stopped.getLogs-before.getLogs).toBeLessThan(100); // a full lookback is about 400 batches
  await sleep(500);
  expect((await counters()).getLogs).toBe(stopped.getLogs); // nothing keeps reading after the deadline
  // The retry with the original payment transaction hash completes with the original bytes.
  const retry=await serve(ips.c,{digest:state.digest,paymentTransactionHash:state.paymentTx});
  expect(retry.status,retry.text).toBe(200);
  expect(retry.json()).toEqual({result:state.resultB64,delivery:JSON.parse(state.deliveryText)});
  const hinted=(await counters()).getLogs;
  expect(hinted).toBe(stopped.getLogs); // the hinted recovery read the receipt, it did not scan
 });

 it('a request carrying the payment hash replaces an in-flight hashless lookup instead of joining it',async()=>{
  await setDeadline(30_000); // the deadline is not what ends the first lookup here
  const before=await counters();
  const scanning=serve(ips.a,{digest:state.digest});
  await sleep(150);
  expect((await counters()).getLogs).toBeGreaterThan(before.getLogs); // the scan is really running
  const hinted=await serve(ips.b,{digest:state.digest,paymentTransactionHash:state.paymentTx});
  expect(hinted.status,hinted.text).toBe(200);
  expect(hinted.json()).toEqual({result:state.resultB64,delivery:JSON.parse(state.deliveryText)});
  expect(hinted.ms).toBeLessThan(5000);
  const replaced=await scanning;
  expect(replaced.status).toBe(503);expect(replaced.json().error).toMatch(/newer recovery request supplied a payment transaction hash/);
  const stopped=(await counters()).getLogs;
  await sleep(400);
  expect((await counters()).getLogs).toBe(stopped); // the replaced scan stopped reading
 });

 it('a transaction that is not this digest\'s payment is never accepted as evidence, and no record changes',async()=>{
  await setDeadline(30_000);
  const wrong=await serve(ips.d,{digest:state.digest,paymentTransactionHash:state.openLineTx});
  expect(wrong.status).not.toBe(200);
  expect(wrong.text).not.toContain(state.resultB64);
  expect({acceptance:await readRecord(`${state.digest}.acceptance.json`),delivery:await readRecord(`${state.digest}.delivery.json`),result:await readRecord(`${state.digest}.result.json`),payment:await readRecord(`${state.digest}.payment.json`)}).toEqual(state.stored);
 });

 it('a request that finishes inside the deadline is unaffected by it',async()=>{
  await setDeadline(25_000);
  const ok=await serve(ips.a,{digest:state.digest,paymentTransactionHash:state.paymentTx});
  expect(ok.status).toBe(200);
  expect(configuredIdentity().deployment).toBe('recovery-deadline-local');
 });
});
