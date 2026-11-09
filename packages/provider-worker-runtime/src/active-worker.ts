import {ProviderCoordinatorBase} from './coordinator.ts';
import {productionConnectionSource} from './verified-connection.ts';
import {mainnetSigningSource} from './mainnet-signing-source.ts';
import {handleEdge} from './edge.ts';
export {RecordStoreDO,ProviderAdmin} from './worker.ts';

/** Separate opt-in entrypoint. The default recovery Worker never installs this capability. */
export class MainnetActiveProviderCoordinatorDO extends ProviderCoordinatorBase {
 constructor(ctx:DurableObjectState,env:Env){
  super(ctx,env);
  const vars=()=>Object.fromEntries(Object.entries(this.env));
  this.hooks={vars,connectionSource:config=>productionConnectionSource(vars(),config)};
  this.signingSource=async(config,connection)=>{try{return mainnetSigningSource(vars(),config,connection);}catch{return null;}};
 }
}
export default {fetch:(request:Request,env:Env):Promise<Response>=>handleEdge(request,env)} satisfies ExportedHandler<Env>;
