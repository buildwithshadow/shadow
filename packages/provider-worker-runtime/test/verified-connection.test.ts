import { describe, expect, it } from 'vitest';
import { approvedDeployment, hashManifest, productionConnectionSource, websocketConnector } from '../src/verified-connection.ts';
import { readProviderConfig } from '../src/config.ts';
const address = '0x00000000000000000000000000000000000000c1';
const manifest = JSON.stringify({ok:true,chainId:5042002,contract:{address},bytecode:{onchainRuntimeKeccak256:'0x'+'12'.repeat(32)},deployment:{blockNumber:'1'}});
const vars = {DEPLOYMENT:'synthetic',PROVIDER:'0x00000000000000000000000000000000000000a1',CHAIN_ID:'5042002',CONTRACT:address,ENDPOINT_HASH:'0x'+'11'.repeat(32),PRICE:'1',MANIFEST_APPROVED_SHA256:hashManifest(new TextEncoder().encode(manifest))};
const config = () => {const parsed=readProviderConfig(vars);if(!parsed.ok)throw Error('invalid fixture');return parsed.config;};
describe('verified deployment boundary, without live RPC',()=>{
 it('parses only byte-approved manifests for the configured identity',()=>{const result=approvedDeployment(manifest,config());expect(result.address.toLowerCase()).toBe(address);expect(result.expectedChainId).toBe(5042002n);expect(result.runtimeHash).toBe('0x'+'12'.repeat(32));});
 it('refuses changed manifest bytes before any connection',()=>{expect(()=>approvedDeployment(manifest+' ',config())).toThrow('not approved');});
 it('refuses a different contract even if manifest bytes are approved',()=>{expect(()=>approvedDeployment(manifest,{...config(),contract:'0x00000000000000000000000000000000000000c2'})).toThrow(/differ/);});
 it('refuses missing connection capabilities',async()=>{expect(await productionConnectionSource({},config())).toBeNull();});
 it('requires TLS and refuses URL userinfo or fragments without reflecting secrets',()=>{for(const raw of ['http://example.com/secret','wss://name:secret@example.com/','wss://example.com/#secret','secret']){expect(()=>websocketConnector(raw)).toThrow('invalid read endpoint');}});
 it('builds no socket before an explicit verified connect',async()=>{const bundle=await productionConnectionSource({MANIFEST_JSON:manifest,RPC_WSS_URL:'wss://unused.example.test/private-token'},config());expect(bundle?.manifestSha256).toBe(vars.MANIFEST_APPROVED_SHA256);bundle?.close?.();});
});
