import {privateKeyToAccount} from 'viem/accounts';
import {createShadowArcWalletService} from '../../../examples/float-mainnet-provider-server/shadow-arc-wallet-service.mjs';
import {createWorkerProviderMonitorGuard} from '../../monitor-worker-runtime/src/provider-guard.mjs';
import type {ConnectionBundle,SigningBundle} from './coordinator.ts';
import type {ProviderConfig} from './config.ts';

/** Missing or invalid signing configuration permits recovery only, never unmonitored acceptance. */
export function mainnetSigningSource(vars:Record<string,unknown>,config:ProviderConfig,connection:Awaited<ReturnType<ConnectionBundle['connect']>>):SigningBundle|null {
 if(vars.RECOVERY_ONLY==='true')return null;
 if(config.chainId!==5042n||vars.PROVIDER_MODE!=='guarded-active'||typeof vars.PROVIDER_SIGNING_KEY!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(vars.PROVIDER_SIGNING_KEY))return null;
 const monitor=vars.MONITOR_READ;
 if(!monitor||typeof monitor!=='object'||typeof Reflect.get(monitor,'admissionState')!=='function')return null;
 // Validate locally approved policy and history before materialising a signer.
 const admissionGuard=createWorkerProviderMonitorGuard(vars,connection,monitor);
 let account;try{account=privateKeyToAccount(vars.PROVIDER_SIGNING_KEY as `0x${string}`);}catch{return null;}
 if(account.address.toLowerCase()!==config.provider.toLowerCase())return null;
 const raw=vars.SHADOW_WALLET_REPORT_RPC_URLS;
 if(typeof raw!=='string')return null;
 const service=createShadowArcWalletService({chainId:5042,rpcUrls:raw.split(',').map(url=>url.trim())});
 return {account:{address:account.address,signTypedData:account.signTypedData},service,admissionGuard};
}
