import {describe,expect,it} from 'vitest';
import {generatePrivateKey} from 'viem/accounts';
import {recoverTypedDataAddress,keccak256} from 'viem';
import {publicTestnetSigningSource,reportRpcUrls} from '../../src/public-testnet-signing-source.ts';
import {mainnetSigningSource} from '../../src/mainnet-signing-source.ts';
import {readProviderConfig} from '../../src/config.ts';
import realManifest from '../../../../contracts/deployments/public-testnet/arc-testnet.manifest.json?raw';
import {CONTRACT,PAYMENT_TX,REPAYMENT_TX,PUBLIC_PROVIDER,FAKE_CODE,chainClient,fixture,manifestFor,sha256,syntheticClient,syntheticCycle} from './fixtures.ts';

const deps=(calls:string[]=[])=>({createClients:()=>[syntheticClient(calls),syntheticClient(calls)]});
const request=(id:string)=>`report:${'ab'.repeat(16)}:${id}`;

describe('public testnet signing source: strictly chain 5042002, address and typed-data signing only',()=>{
 it('composes the real historical cycle service with the supplied parameters and signs only typed data',async()=>{
  const f=fixture(),calls:string[]=[];const source=publicTestnetSigningSource(f.vars,f.config,chainClient(),deps(calls));
  expect(source).not.toBeNull();
  expect(Object.keys(source!.account).sort()).toEqual(['address','signTypedData']); // no wallet client, no sendTransaction
  expect(source!.account.address).toBe(f.config.provider);
  expect(typeof source!.service.prepare).toBe('function');
  await source!.admissionGuard(); // approved runtime matches
  const typed={domain:{name:'probe',version:'1',chainId:5042002,verifyingContract:CONTRACT},types:{Probe:[{name:'n',type:'uint256'}]},primaryType:'Probe',message:{n:1n}} as const;
  expect(await recoverTypedDataAddress({...typed,signature:await source!.account.signTypedData(typed)})).toBe(f.config.provider);
 });

 it('produces the original historical report (not a wallet report) for the supplied payment, from both report sources',async()=>{
  const f=fixture(),calls:string[]=[];const source=publicTestnetSigningSource(f.vars,f.config,chainClient(),deps(calls))!;
  const prepared=await (source.service as any).prepare({digest:'0x'+'1'.repeat(64),requestId:request(PAYMENT_TX)});
  const report=JSON.parse(prepared.result);
  expect(report).toMatchObject({kind:'shadow-v2-cycle-reconciliation',chainId:5042002,requestId:request(PAYMENT_TX),payment:{tx:PAYMENT_TX},repayment:{tx:REPAYMENT_TX},checks:{twoRpcReceiptsMatch:true,debtRestored:true}});
  expect(prepared.resultRef).toBe(`https://explorer.testnet.arc.io/tx/${PAYMENT_TX}`);
  // both independent report sources were asked for exactly the two supplied transactions
  expect(calls.filter(c=>c.startsWith('receipt:')).sort()).toEqual([`receipt:${PAYMENT_TX}`,`receipt:${PAYMENT_TX}`,`receipt:${REPAYMENT_TX}`,`receipt:${REPAYMENT_TX}`].sort());
 });

 it('refuses any other payment transaction without touching either report source',async()=>{
  const f=fixture(),calls:string[]=[];const source=publicTestnetSigningSource(f.vars,f.config,chainClient(),deps(calls))!;
  expect(await (source.service as any).prepare({requestId:request('0x'+'5'.repeat(64))})).toBeNull();
  expect(await (source.service as any).prepare({requestId:'arc-wallet:'+'ab'.repeat(16)+':0x00000000000000000000000000000000000000d1'})).toBeNull();
  expect(calls).toEqual([]);
 });

 it('keeps the original report validation: a shallow historical receipt (under 20 confirmations) is refused',async()=>{
  const f=fixture(),calls:string[]=[];
  const source=publicTestnetSigningSource(f.vars,f.config,chainClient(),{createClients:()=>[syntheticClient(calls,{head:1015n}),syntheticClient(calls,{head:1015n})]})!;
  await expect((source.service as any).prepare({requestId:request(PAYMENT_TX)})).rejects.toThrow('fewer than 20 confirmations');
 });

 it('refuses a report RPC on the wrong chain',async()=>{
  const f=fixture();const source=publicTestnetSigningSource(f.vars,f.config,chainClient(),{createClients:()=>[syntheticClient([],{chainId:5042}),syntheticClient([])]})!;
  await expect((source.service as any).prepare({requestId:request(PAYMENT_TX)})).rejects.toThrow('not Arc testnet');
 });

 it('accepts the repository\'s real public testnet manifest identity (contract, chain, runtime hash) but not an altered one',()=>{
  const m=JSON.parse(realManifest);
  const f=fixture({MANIFEST_JSON:realManifest,MANIFEST_APPROVED_SHA256:sha256(realManifest)});
  expect(m.chainId).toBe('5042002');
  expect(publicTestnetSigningSource(f.vars,f.config,chainClient(),deps())).not.toBeNull();
  const altered=JSON.stringify({...m,bytecode:{...m.bytecode,onchainRuntimeKeccak256:'0x'+'0'.repeat(63)}}); // not 64 hex -> invalid
  const g=fixture({MANIFEST_JSON:altered,MANIFEST_APPROVED_SHA256:sha256(altered)});
  expect(publicTestnetSigningSource(g.vars,g.config,chainClient(),deps())).toBeNull();
  const other=JSON.stringify({...m,contract:{...m.contract,address:'0x'+'2'.repeat(40)}});
  const o=fixture({MANIFEST_JSON:other,MANIFEST_APPROVED_SHA256:sha256(other)});
  expect(publicTestnetSigningSource(o.vars,o.config,chainClient(),deps())).toBeNull();
 });

 it('the admission recheck refuses changed runtime code or chain, and is not an unconditional allow',async()=>{
  const f=fixture();
  const changed=publicTestnetSigningSource(f.vars,f.config,chainClient({getCode:async()=>'0x6002'}),deps())!;
  await expect(changed.admissionGuard()).rejects.toThrow('runtime code');
  const nocode=publicTestnetSigningSource(f.vars,f.config,chainClient({getCode:async()=>'0x'}),deps())!;
  await expect(nocode.admissionGuard()).rejects.toThrow('runtime code');
  const wrong=publicTestnetSigningSource(f.vars,f.config,chainClient({getChainId:async()=>5042}),deps())!;
  await expect(wrong.admissionGuard()).rejects.toThrow('chain changed');
  void keccak256;void FAKE_CODE;
 });

 const closed:Array<[string,Record<string,unknown>]>=[
  ['explicit recovery mode',{RECOVERY_ONLY:'true'}],
  ['mainnet active mode name',{PROVIDER_MODE:'guarded-active'}],
  ['missing mode',{PROVIDER_MODE:undefined}],
  ['monitor-less admission not named',{PROVIDER_ADMISSION_MODE:undefined}],
  ['a monitored admission mode name',{PROVIDER_ADMISSION_MODE:'public-monitor'}],
  ['a different service',{PROVIDER_SERVICE:'shadow-arc-wallet'}],
  ['missing service',{PROVIDER_SERVICE:undefined}],
  ['missing signer',{PROVIDER_SIGNING_KEY:undefined}],
  ['invalid signer',{PROVIDER_SIGNING_KEY:'not-a-key'}],
  ['zero signer',{PROVIDER_SIGNING_KEY:'0x'+'0'.repeat(64)}],
  ['signer that does not match the configured provider',{PROVIDER_SIGNING_KEY:generatePrivateKey()}],
  ['missing payment transaction',{SHADOW_V2_PAYMENT_TX:undefined}],
  ['malformed repayment transaction',{SHADOW_V2_REPAYMENT_TX:'0x1234'}],
  ['equal payment and repayment transactions',{SHADOW_V2_REPAYMENT_TX:PAYMENT_TX}],
  ['missing report sources',{SHADOW_V2_REPORT_RPC_URLS:undefined}],
  ['one report source',{SHADOW_V2_REPORT_RPC_URLS:'https://rpc-a.invalid'}],
  ['the same report source twice',{SHADOW_V2_REPORT_RPC_URLS:'https://rpc-a.invalid,https://rpc-a.invalid/other'}],
  ['plain http report source',{SHADOW_V2_REPORT_RPC_URLS:'http://rpc-a.invalid,https://rpc-b.invalid'}],
  ['report source with credentials',{SHADOW_V2_REPORT_RPC_URLS:'https://u:p@rpc-a.invalid,https://rpc-b.invalid'}],
  ['missing manifest bytes',{MANIFEST_JSON:undefined}],
  ['manifest bytes that do not match the approval',{MANIFEST_JSON:manifestFor()+' '}],
 ];
 for(const [name,patch] of closed)it(`stays closed (recovery only) with ${name}`,()=>{
  let f;try{f=fixture(patch);}catch{return;} // configuration the coordinator itself would already hold
  let result;try{result=publicTestnetSigningSource(f.vars,f.config,chainClient(),deps());}catch{result=null;}
  expect(result).toBeNull();
 });

 it('refuses wrong chain on either side',()=>{
  const f=fixture();
  expect(publicTestnetSigningSource(f.vars,{...f.config,chainId:5042n},chainClient(),deps())).toBeNull();
  expect(publicTestnetSigningSource(f.vars,f.config,{...chainClient(),chainId:5042n},deps())).toBeNull();
  expect(publicTestnetSigningSource(f.vars,{...f.config,chainId:1n},{...chainClient(),chainId:1n},deps())).toBeNull();
  expect(publicTestnetSigningSource(f.vars,f.config,{...chainClient(),address:'0x00000000000000000000000000000000000000c1'},deps())).toBeNull();
 });

 it('the mainnet source still refuses chain 5042002 and the testnet source refuses mainnet inputs',()=>{
  const f=fixture();
  expect(mainnetSigningSource({...f.vars,PROVIDER_MODE:'guarded-active',MONITOR_READ:{admissionState:async()=>({})}},f.config,chainClient() as never)).toBeNull();
  const m=readProviderConfig({...f.vars,CHAIN_ID:'5042'});if(!m.ok)throw Error('cfg');
  expect(publicTestnetSigningSource({...f.vars,CHAIN_ID:'5042'},m.config,{...chainClient(),chainId:5042n},deps())).toBeNull();
 });

 it('validates report RPC configuration explicitly',()=>{
  expect(reportRpcUrls('https://a.example,https://b.example')).toEqual(['https://a.example/','https://b.example/']);
  expect(reportRpcUrls('http://127.0.0.1:1,http://localhost:1')).not.toBeNull();
  expect(reportRpcUrls(undefined)).toBeNull();
  void PUBLIC_PROVIDER;void syntheticCycle;
 });
});
