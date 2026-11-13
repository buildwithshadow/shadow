import {env,exports} from 'cloudflare:workers';
import {evictAllDurableObjects} from 'cloudflare:test';
import {describe,expect,it} from 'vitest';
import {generatePrivateKey} from 'viem/accounts';
import {storeObjectName} from '../../../provider-durable-store/src/identity.ts';
import {importThroughCoordinator} from '../helpers.ts';

// The OPT-IN public testnet entrypoint in workerd: same coordinator/server/witness checks, synthetic connection only.
const e=env as unknown as {PROVIDER_COORDINATOR:any;DEPLOYMENT:string;PROVIDER:string;CHAIN_ID:string;CONTRACT:string;ENDPOINT_HASH:string};
async function coordinator(){const id={deployment:e.DEPLOYMENT,provider:e.PROVIDER,chainId:e.CHAIN_ID,contract:e.CONTRACT,endpointHash:e.ENDPOINT_HASH};return e.PROVIDER_COORDINATOR.get(e.PROVIDER_COORDINATOR.idFromName(await storeObjectName(id)));}
async function configure(overrides:Record<string,unknown>={},chain?:string){await (await coordinator()).__set(overrides,chain);await evictAllDurableObjects();}
async function accept(){
 const r=await exports.default.fetch('https://provider.example.test/accept',{method:'POST',headers:{'cf-connecting-ip':'203.0.113.7','content-type':'application/json'},body:'{}'});
 return {status:r.status,body:await r.json() as Record<string,any>};
}
const RECOVERY='Provider is in recovery-only mode; no new acceptances or purchases are offered';

describe('public testnet entrypoint',()=>{
 it('serves active only with a complete matching testnet configuration (store imported through the quiesced coordinator)',async()=>{
  await configure();await importThroughCoordinator([]);await configure();
  const r=await accept();
  expect(r.status).toBe(400); // reached the ACTIVE server: it rejects the empty request body, it does not answer recovery-only 503
  expect(r.body.error).toBe('requestId must be a non-empty string');
 });
 const cases:Array<[string,Record<string,unknown>,string?]>=[
  ['a connection that reports mainnet chain 5042',{}, '5042'],
  ['a signer that does not match the configured provider',{PROVIDER_SIGNING_KEY:generatePrivateKey()}],
  ['the mainnet active mode name',{PROVIDER_MODE:'guarded-active'}],
  ['explicit recovery mode',{RECOVERY_ONLY:'true'}],
  ['a missing signer secret',{PROVIDER_SIGNING_KEY:null}],
  ['a single report source',{SHADOW_V2_REPORT_RPC_URLS:'https://rpc-a.invalid'}],
 ];
 for(const [name,overrides,chain] of cases)it(`stays recovery only with ${name}`,async()=>{
  await configure(overrides,chain);
  const r=await accept();
  expect(r.status).toBe(503);expect(r.body.error).toBe(RECOVERY);
 });
 it('returns to active when the configuration is restored',async()=>{await configure();expect((await accept()).status).toBe(400);});
});
