import {createHash} from 'node:crypto';
import {encodeAbiParameters,encodeEventTopics,getAddress,keccak256,parseAbiItem,numberToHex,type Hex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {readProviderConfig} from '../../src/config.ts';

// DISPOSABLE synthetic inputs. The public identifiers (contract, price, historical transactions) are the supplied public testnet service parameters.
export const PAYMENT_TX='0x28d70ae57f6eda6ff27e0c2a5a13c3074ecf6792f79c726bae02f6f7c9c53b38' as Hex;
export const REPAYMENT_TX='0xc2290754ac4827fd0f214a205fa2aabf235180328f55b4dcbade29cf37f5b8f0' as Hex;
export const CONTRACT=getAddress('0xB31d9e17410B10a619B66dF0c31f59acbb33B553');
export const PUBLIC_PROVIDER=getAddress('0xFAF237F98f35A86149E901e18EB4BAd67bC0D347');
export const ENDPOINT_HASH='0x5c4ef74d3d99bf24bca241546fd4a5e0e50639f4b2af5b970cec722cf4ceb495';
export const FAKE_CODE='0x6001600055' as Hex;
export const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
export const manifestFor=(over:Record<string,unknown>={})=>JSON.stringify({ok:true,chainId:'5042002',contract:{address:CONTRACT,name:'ShadowFloatPublicTestnet'},bytecode:{onchainRuntimeKeccak256:keccak256(FAKE_CODE)},deployment:{blockNumber:'64249620'},...over});

/** Synthetic provider identity: a disposable key stands in for the real provider key, so vars carry ITS address. */
export function fixture(patch:Record<string,unknown>={}) {
 const key=generatePrivateKey(),provider=privateKeyToAccount(key).address,manifest=manifestFor();
 const vars:Record<string,unknown>={DEPLOYMENT:'shadow-public-testnet-v2-cycle',PROVIDER:provider,CHAIN_ID:'5042002',CONTRACT,ENDPOINT_HASH,PRICE:'50000',
  MANIFEST_JSON:manifest,MANIFEST_APPROVED_SHA256:sha256(manifest),PROVIDER_MODE:'public-testnet-active',PROVIDER_ADMISSION_MODE:'testnet-unmonitored',PROVIDER_SERVICE:'shadow-v2-cycle',
  PROVIDER_SIGNING_KEY:key,SHADOW_V2_PAYMENT_TX:PAYMENT_TX,SHADOW_V2_REPAYMENT_TX:REPAYMENT_TX,SHADOW_V2_REPORT_RPC_URLS:'https://rpc-a.invalid,https://rpc-b.invalid',...patch};
 for(const [k,v] of Object.entries(vars))if(v===undefined)delete vars[k];
 const parsed=readProviderConfig(vars);if(!parsed.ok)throw Error('fixture config invalid: '+parsed.reason);
 return {vars,config:parsed.config,key};
}
export const chainClient=(over:Record<string,unknown>={})=>({chainId:5042002n,address:CONTRACT,client:{getChainId:async()=>5042002,getCode:async()=>FAKE_CODE,...over}});

// ---- synthetic historical cycle: two receipts that satisfy the unchanged service's reconciliation checks ----
const floatReceipt=parseAbiItem('event FloatReceipt(uint256 indexed receiptId, bytes32 indexed receiptHash, uint8 indexed receiptType, address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, uint256 creditBeforeUSDC, uint256 creditAfterUSDC, uint256 debtBeforeUSDC, uint256 debtAfterUSDC, uint8 reason, bytes32 mandateId, bytes32 requestHash, bytes32 prevChecksum, bytes32 checksum)');
const transfer=parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
// The historical V2 cycle happened on the V2 float, not on the public testnet contract (the service pins it).
const V2_FLOAT=getAddress('0x20dcA96B0C487D94De885c726c956ffaF38b12C2');
const USDC=getAddress('0x3600000000000000000000000000000000000000');
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const AGENT=getAddress('0x00000000000000000000000000000000000000a9'),PROV=getAddress('0x00000000000000000000000000000000000000b9'),ZERO=getAddress('0x0000000000000000000000000000000000000000');
function receiptLog(id:number,type:number,provider:string,credit:[bigint,bigint],debt:[bigint,bigint],hash:Hex){
 const topics=encodeEventTopics({abi:[floatReceipt],eventName:'FloatReceipt',args:{receiptId:BigInt(id),receiptHash:hash,receiptType:type}} as never);
 const data=encodeAbiParameters([{type:'address'},{type:'address'},{type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint8'},{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'bytes32'}],[AGENT,provider as Hex,h(7),50000n,credit[0],credit[1],debt[0],debt[1],0,h(8),h(9),h(10),h(11)]);
 return {address:V2_FLOAT,topics,data,transactionHash:'' as Hex,logIndex:0,removed:false};
}
function transferLog(from:string,to:string){
 return {address:USDC,topics:encodeEventTopics({abi:[transfer],eventName:'Transfer',args:{from:from as Hex,to:to as Hex}} as never),data:encodeAbiParameters([{type:'uint256'}],[50000n]),logIndex:9,removed:false};
}
const mk=(tx:Hex,block:bigint,logs:any[])=>({transactionHash:tx,status:'success' as const,blockNumber:block,blockHash:h(Number(block)),logs});
export const syntheticCycle=()=>{
 const paymentLogs=[receiptLog(1,4,PROV,[1_000_000n,950_000n],[0n,50000n],h(21)),receiptLog(2,5,PROV,[1_000_000n,950_000n],[0n,50000n],h(22)),transferLog(V2_FLOAT,PROV)];
 const repayLogs=[receiptLog(3,6,ZERO,[950_000n,1_000_000n],[50000n,0n],h(23)),transferLog(AGENT,V2_FLOAT)];
 const payment=mk(PAYMENT_TX,1000n,paymentLogs.map((l,i)=>({...l,transactionHash:PAYMENT_TX,logIndex:i}))),repayment=mk(REPAYMENT_TX,1010n,repayLogs.map((l,i)=>({...l,transactionHash:REPAYMENT_TX,logIndex:i})));
 const intervalLogs=[...payment.logs.slice(0,2).map((l:any)=>({...l,blockNumber:1000n,args:{receiptHash:l.topics[2],receiptType:Number(BigInt(l.topics[3])),agent:AGENT,creditBeforeUSDC:1_000_000n,creditAfterUSDC:950_000n,debtBeforeUSDC:0n,debtAfterUSDC:50000n}})),
  {...repayment.logs[0],blockNumber:1010n,args:{receiptHash:h(23),receiptType:6,agent:AGENT,creditBeforeUSDC:950_000n,creditAfterUSDC:1_000_000n,debtBeforeUSDC:50000n,debtAfterUSDC:0n}}];
 return {payment,repayment,intervalLogs};
};
export function syntheticClient(calls:string[],opts:{head?:bigint;chainId?:number}={}){
 const {payment,repayment,intervalLogs}=syntheticCycle();
 return {
  getChainId:async()=>{calls.push('chainId');return opts.chainId??5042002;},
  getTransactionReceipt:async({hash}:{hash:Hex})=>{calls.push(`receipt:${hash}`);if(hash===PAYMENT_TX)return payment;if(hash===REPAYMENT_TX)return repayment;throw Object.assign(Error('nf'),{name:'TransactionReceiptNotFoundError'});},
  getBlockNumber:async()=>opts.head??2000n,
  getBlock:async({blockNumber}:{blockNumber:bigint})=>({number:blockNumber,hash:h(Number(blockNumber)),timestamp:1n}),
  getLogs:async()=>intervalLogs,
  request:async({method,params}:{method:string;params:unknown[]})=>{calls.push(method);void params;void numberToHex;throw Error('unexpected');},
 };
}
