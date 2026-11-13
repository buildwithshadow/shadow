import {ProviderCoordinatorBase} from '../../src/coordinator.ts';
import {approvedDeployment} from '../../src/verified-connection.ts';
import handler from '../../src/worker.ts';
import {connectCandidate} from '../../../../app/scripts/float-mainnet-config.mjs';
import {HEAD_INFLATION} from './constants.ts';
export {RecordStoreDO,ProviderAdmin} from '../../src/worker.ts';
export {StoreWitnessDO} from '../../../provider-durable-store/src/do-witness.ts';
export default handler;

type LocalEnv=Env&{LOCAL_RPC_URL:string;MANIFEST_JSON:string};
let id=0;
const call=async(url:string,method:string,params:unknown[])=>{
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
 const body=await response.json() as {result?:unknown;error?:{code?:number;message?:string;data?:string}};
 if(body.error)throw Object.assign(Error(body.error.message??'rpc error'),{code:body.error.code,data:body.error.data});return body.result;
};
const hex=(n:bigint)=>`0x${n.toString(16)}`;

/**
 * The recovery coordinator (no signer) over a REAL local chain. The only shim is on the read path: it reports a head
 * HEAD_INFLATION blocks higher than the real one so a payment lookup must walk hundreds of 5000-block batches (mining that
 * many blocks locally is not feasible), clamps block-pinned reads back to real blocks, answers empty log ranges beyond the
 * real chain, and counts and slows eth_getLogs. Logs, receipts, hashes and payments are the real chain's, unaltered.
 */
export class RecoveryDeadlineCoordinatorDO extends ProviderCoordinatorBase {
 private counts={getLogs:0,total:0};
 private logDelayMs=15;
 constructor(ctx:DurableObjectState,env:LocalEnv){
  super(ctx,env);
  const url=env.LOCAL_RPC_URL;
  const realHead=async()=>BigInt(await call(url,'eth_blockNumber',[]) as string);
  const request=async({method,params=[]}:{method:string;params?:unknown[]})=>{
   this.counts.total++;
   const head=await realHead();
   if(method==='eth_getBlockByNumber'){
    const [tag,...rest]=params as [string,...unknown[]];
    const wanted=tag==='latest'?null:BigInt(tag);
    if(wanted!==null&&wanted<=head)return call(url,method,params);
    const block=await call(url,method,['latest',...rest]) as Record<string,unknown>;
    return {...block,number:hex(wanted??head+HEAD_INFLATION)};
   }
   if(method==='eth_call'){
    const [tx,tag] = params as [unknown,string];
    return call(url,method,[tx,typeof tag==='string'&&tag.startsWith('0x')&&BigInt(tag)>head?'latest':tag]);
   }
   if(method==='eth_getLogs'){
    this.counts.getLogs++;
    await new Promise(resolve=>setTimeout(resolve,this.logDelayMs));
    const filter={...(params[0] as Record<string,string>)};
    if(BigInt(filter.fromBlock)>head)return [];
    if(BigInt(filter.toBlock)>head)filter.toBlock=hex(head);
    return call(url,method,[filter]);
   }
   return call(url,method,params);
  };
  this.hooks={vars:()=>this.env as unknown as Record<string,unknown>,connectionSource:async config=>{
   const deployment={...approvedDeployment(env.MANIFEST_JSON,config),readSpacingMs:5};
   return {manifestSha256:config.manifestApprovedSha256,connect:()=>connectCandidate(deployment,{readOnly:true,readProvider:{request}})};
  }};
 }
 async __setDeadline(ms:number){await this.resetConnection();this.readDeadlineMs=ms;}
 __counters(){return {...this.counts};}
}
