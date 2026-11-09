import {expect,it} from 'vitest';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {mainnetSigningSource} from '../src/mainnet-signing-source.ts';
import {readProviderConfig} from '../src/config.ts';
import {approved} from '../../monitor-worker-runtime/test/fixtures/public-config.mjs';
function fixture(){
 const key=generatePrivateKey(),provider=privateKeyToAccount(key).address;
 const vars={...approved(),DEPLOYMENT:'synthetic-active',PROVIDER:provider,CONTRACT:'0x'+'1'.padStart(40,'0'),CHAIN_ID:'5042',ENDPOINT_HASH:'0x'+'1'.repeat(64),PRICE:'5000',PROVIDER_MODE:'guarded-active',PROVIDER_SIGNING_KEY:key,MONITOR_READ:{admissionState:async()=>{throw Error('synthetic held monitor');}},SHADOW_WALLET_REPORT_RPC_URLS:'https://one.invalid,https://two.invalid'};
 const result=readProviderConfig(vars);if(!result.ok)throw Error('invalid synthetic config');
 return {vars,config:result.config,connection:{chainId:5042n,address:vars.CONTRACT,client:{}}};
}
it('composes only a matching signer, mandatory monitor guard and prepared wallet report service',async()=>{
 const {vars,config,connection}=fixture();const source=mainnetSigningSource(vars,config,connection);expect(source).not.toBeNull();
 expect(source!.account.address).toBe(config.provider);expect(Object.keys(source!.account).sort()).toEqual(['address','signTypedData']);
 expect(typeof source!.service.prepare).toBe('function');expect(typeof source!.service.validatePrepared).toBe('function');
 await expect(source!.admissionGuard()).rejects.toThrow('synthetic held monitor');
});
for(const [name,patch] of [
 ['explicit recovery mode',{RECOVERY_ONLY:'true'}],['missing mode',{PROVIDER_MODE:undefined}],['missing signer',{PROVIDER_SIGNING_KEY:undefined}],['invalid signer',{PROVIDER_SIGNING_KEY:'redacted-invalid'}],['zero signer',{PROVIDER_SIGNING_KEY:'0x'+'0'.repeat(64)}],['wrong signer',{PROVIDER_SIGNING_KEY:generatePrivateKey()}],['missing monitor',{MONITOR_READ:undefined}],['missing report sources',{SHADOW_WALLET_REPORT_RPC_URLS:undefined}],
] as const)it(`keeps ${name} in recovery only`,()=>{const f=fixture();expect(mainnetSigningSource({...f.vars,...patch},f.config,f.connection)).toBeNull();});
it('does not construct a signer under an unapproved policy',()=>{const f=fixture();expect(()=>mainnetSigningSource({...f.vars,BASELINE_JSON:f.vars.BASELINE_JSON+' '},f.config,f.connection)).toThrow('not approved');});
it('cannot downgrade to testnet or compose duplicate report sources',()=>{const f=fixture();expect(mainnetSigningSource(f.vars,{...f.config,chainId:5042002n},f.connection)).toBeNull();expect(()=>mainnetSigningSource({...f.vars,SHADOW_WALLET_REPORT_RPC_URLS:'https://one.invalid,https://one.invalid'},f.config,f.connection)).toThrow('two separate RPC');});
