import {createHash} from 'node:crypto';
import {createPublicClient,getAddress,http,keccak256} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {createShadowV2CycleService} from '../../../examples/float-mainnet-provider-server/shadow-v2-cycle-service.mjs';
import type {ConnectionBundle,SigningBundle} from './coordinator.ts';
import type {ProviderConfig} from './config.ts';

/**
 * Public Arc TESTNET signing source, strictly chain 5042002. It is a separate, opt-in capability: neither the default
 * recovery Worker nor the mainnet active entrypoint imports it, and the mainnet source (mainnet-signing-source.ts)
 * still refuses every chain except 5042. It exposes only an address and typed-data signing (provider acceptance and
 * delivery receipts). There is no wallet client and no transaction sender. Any missing or mismatched input returns null,
 * which leaves the coordinator in recovery-only mode.
 *
 * Admission: the Node testnet service ran `PROVIDER_ADMISSION_MODE=testnet-unmonitored` (no monitor exists for this
 * contract). That mode must be named explicitly here, and acceptance additionally re-verifies on every attempt that the
 * chain and the contract's runtime code still match the approved manifest. This is NOT the mainnet monitor guard.
 */
export const PUBLIC_TESTNET_CHAIN_ID=5042002n;
const HASH=/^0x[0-9a-fA-F]{64}$/;
type Connection=Awaited<ReturnType<ConnectionBundle['connect']>>;
export interface PublicTestnetDeps {createClients?(urls:string[]):unknown[]}

/** Explicit report RPC configuration: exactly two distinct origins, HTTPS (or loopback HTTP for tests), no credentials in the userinfo. */
export function reportRpcUrls(raw:unknown):string[]|null {
 if(typeof raw!=='string')return null;
 const urls=raw.split(',').map(value=>value.trim());
 if(urls.length!==2)return null;
 const parsed:URL[]=[];
 for(const value of urls){
  let url:URL;try{url=new URL(value);}catch{return null;}
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback)))return null;
  parsed.push(url);
 }
 if(parsed[0].origin===parsed[1].origin)return null;
 return parsed.map(url=>url.href);
}

function approvedRuntime(vars:Record<string,unknown>,config:ProviderConfig):string|null {
 const manifest=vars.MANIFEST_JSON;
 if(typeof manifest!=='string'||createHash('sha256').update(new TextEncoder().encode(manifest)).digest('hex')!==config.manifestApprovedSha256)return null;
 let parsed:{ok?:unknown;chainId?:unknown;contract?:{address?:unknown};bytecode?:{onchainRuntimeKeccak256?:unknown}};
 try{parsed=JSON.parse(manifest);}catch{return null;}
 const runtime=parsed.bytecode?.onchainRuntimeKeccak256,address=parsed.contract?.address;
 if(parsed.ok!==true||String(parsed.chainId)!=='5042002'||typeof address!=='string'||typeof runtime!=='string'||!HASH.test(runtime))return null;
 try{if(getAddress(address)!==config.contract)return null;}catch{return null;}
 return runtime.toLowerCase();
}

export function publicTestnetSigningSource(vars:Record<string,unknown>,config:ProviderConfig,connection:Connection,deps:PublicTestnetDeps={}):SigningBundle|null {
 if(vars.RECOVERY_ONLY==='true')return null;
 if(config.chainId!==PUBLIC_TESTNET_CHAIN_ID||BigInt(connection.chainId)!==PUBLIC_TESTNET_CHAIN_ID)return null;
 if(vars.PROVIDER_MODE!=='public-testnet-active'||vars.PROVIDER_ADMISSION_MODE!=='testnet-unmonitored'||vars.PROVIDER_SERVICE!=='shadow-v2-cycle')return null;
 if(typeof vars.PROVIDER_SIGNING_KEY!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(vars.PROVIDER_SIGNING_KEY))return null;
 let account;try{account=privateKeyToAccount(vars.PROVIDER_SIGNING_KEY as `0x${string}`);}catch{return null;}
 if(account.address.toLowerCase()!==config.provider.toLowerCase())return null;
 let connected:string;try{connected=getAddress(connection.address);}catch{return null;}
 if(connected!==config.contract)return null;
 const runtime=approvedRuntime(vars,config);if(runtime===null)return null;
 const paymentTx=vars.SHADOW_V2_PAYMENT_TX,repaymentTx=vars.SHADOW_V2_REPAYMENT_TX;
 if(typeof paymentTx!=='string'||typeof repaymentTx!=='string')return null;
 const urls=reportRpcUrls(vars.SHADOW_V2_REPORT_RPC_URLS);if(urls===null)return null;
 const clients=deps.createClients?deps.createClients(urls):urls.map(url=>createPublicClient({transport:http(url,{timeout:8_000})}));
 // The existing historical service, unchanged. It validates the transaction hashes and refuses equal or malformed ones.
 const service=createShadowV2CycleService({paymentTx,repaymentTx,clients:clients as never});
 const client=connection.client as {getChainId():Promise<number>;getCode(args:{address:`0x${string}`}):Promise<string|undefined>};
 const admissionGuard=async():Promise<void>=>{
  if(BigInt(await client.getChainId())!==PUBLIC_TESTNET_CHAIN_ID)throw Error('testnet admission: chain changed');
  const code=await client.getCode({address:connected as `0x${string}`});
  if(!code||code==='0x'||keccak256(code as `0x${string}`)!==runtime)throw Error('testnet admission: runtime code does not match the approved manifest');
 };
 return {account:{address:account.address,signTypedData:account.signTypedData},service:service as unknown as SigningBundle['service'],admissionGuard};
}
