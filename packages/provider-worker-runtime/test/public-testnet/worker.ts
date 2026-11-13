import {getAddress,keccak256,toBytes} from 'viem';
import {PublicTestnetProviderCoordinatorDO} from '../../src/public-testnet-worker.ts';
import handler from '../../src/public-testnet-worker.ts';
import {CONTRACT,FAKE_CODE,PAYMENT_TX,REPAYMENT_TX,manifestFor} from './fixtures.ts';
export {RecordStoreDO,ProviderAdmin} from '../../src/public-testnet-worker.ts';
export {StoreWitnessDO} from '../../../provider-durable-store/src/do-witness.ts';
export default handler;

export const TEST_PROVIDER_KEY=keccak256(toBytes('shadow-public-testnet-test-provider')); // DISPOSABLE, derived from a label

/**
 * TEST FIXTURE around the unmodified PublicTestnetProviderCoordinatorDO. Only the connection source is replaced (production
 * uses a TLS WebSocket verified by connectCandidate); the signing source, server, store and witness checks are the maintained ones.
 * Test overrides live in durable storage and take effect after the coordinator is evicted and rebuilt.
 */
export class TestPublicTestnetCoordinatorDO extends PublicTestnetProviderCoordinatorDO {
 constructor(ctx:DurableObjectState,env:Env){
  const overrides=ctx.storage.kv.get<Record<string,unknown>>('test:overrides')??{};
  const merged:Record<string,unknown>={...(env as unknown as Record<string,unknown>),MANIFEST_JSON:manifestFor(),PROVIDER_MODE:'public-testnet-active',PROVIDER_ADMISSION_MODE:'testnet-unmonitored',PROVIDER_SERVICE:'shadow-v2-cycle',
   PROVIDER_SIGNING_KEY:TEST_PROVIDER_KEY,SHADOW_V2_PAYMENT_TX:PAYMENT_TX,SHADOW_V2_REPAYMENT_TX:REPAYMENT_TX,SHADOW_V2_REPORT_RPC_URLS:'https://rpc-a.invalid,https://rpc-b.invalid',...overrides};
  for(const [k,v] of Object.entries(overrides))if(v===null)delete merged[k];
  super(ctx,merged as unknown as Env);
  const chain=ctx.storage.kv.get<string>('test:connectionChain')??'5042002';
  const vars=this.hooks.vars;
  this.hooks={vars,connectionSource:async config=>({
   manifestSha256:config.manifestApprovedSha256,
   connect:async()=>({chainId:BigInt(chain),address:getAddress(CONTRACT),client:{getChainId:async()=>Number(chain),getCode:async()=>FAKE_CODE,readContract:async()=>{throw Error('synthetic client: unsupported read');}}}),
  })};
 }
 __set(overrides:Record<string,unknown>,connectionChain?:string){this.ctx.storage.kv.put('test:overrides',overrides);this.ctx.storage.kv.put('test:connectionChain',connectionChain??'5042002');}
}
