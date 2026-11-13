import {ProviderCoordinatorBase} from './coordinator.ts';
import {productionConnectionSource} from './verified-connection.ts';
import {publicTestnetSigningSource} from './public-testnet-signing-source.ts';
import {handleEdge} from './edge.ts';
export {RecordStoreDO,ProviderAdmin} from './worker.ts';

/** Separate opt-in PUBLIC ARC TESTNET entrypoint (chain 5042002 only). Neither the recovery Worker nor the mainnet active Worker imports it. */
export class PublicTestnetProviderCoordinatorDO extends ProviderCoordinatorBase {
 constructor(ctx:DurableObjectState,env:Env){
  super(ctx,env);
  const vars=()=>Object.fromEntries(Object.entries(this.env));
  this.hooks={vars,connectionSource:config=>productionConnectionSource(vars(),config)};
  this.signingSource=async(config,connection)=>{try{return publicTestnetSigningSource(vars(),config,connection);}catch{return null;}};
 }
}
export default {fetch:(request:Request,env:Env):Promise<Response>=>handleEdge(request,env)} satisfies ExportedHandler<Env>;
