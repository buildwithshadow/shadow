import {MonitorDO} from '../../src/worker.mjs';
import {fixture,NOW} from './data.mjs';
import {digestJson,canonicalJson} from '../../../../app/scripts/float-mainnet-monitor-policy.mjs';
import {createHash} from 'node:crypto';
export class TestMonitorDO extends MonitorDO {
 constructor(ctx,env){super(ctx,env);const baseline=fixture().baseline;baseline.policy.intervalMs=60000;baseline.policy.maxHeartbeatAgeMs=120000;
  const context={baseline,baselineHash:digestJson(baseline),manifestHash:'synthetic-manifest',stateDir:'/durable-monitor-state',stateBackend:this.backend};
  this.hooks={context:()=>context,now:()=>this.readMeta('clock',NOW),collect:async()=>{
   this.writeMeta('collections',this.readMeta('collections',0)+1);
   const mode=this.readMeta('mode','healthy');if(mode==='failure')throw Error('synthetic read failure');
   if(mode==='slow')await new Promise(resolve=>setTimeout(resolve,50));
   const snapshot=fixture().snapshot;snapshot.observedAt.timestamp=String(this.hooks.now()/1000);return snapshot;
  },send:async message=>{if(this.readMeta('mode')==='delivery-stalled')await new Promise(()=>{});if(this.readMeta('mode')==='delivery-failed')throw Error('synthetic send failure');this.writeMeta('sent',[...this.readMeta('sent',[]),message]);}};
 }
 async attempt(action,...args){try{return {result:await this[action](...args)};}catch(error){return {error:error.message};}}
 async setup(){const context=this.hooks.context();const hash=s=>createHash('sha256').update(s).digest('hex');return this.initialize(hash(`${context.manifestHash}:${context.baselineHash}`),[],hash(canonicalJson([])));}
 async advance(ms=60000){this.writeMeta('clock',this.hooks.now()+ms);await this.ctx.storage.sync();}
 async mode(value){if(!['healthy','failure','slow','delivery-failed','delivery-stalled'].includes(value))throw Error('invalid test mode');this.writeMeta('mode',value);await this.ctx.storage.sync();}
 async interruptedLock(age=300000){const lock={token:'synthetic-interrupted-token',startedAt:new Date(this.hooks.now()-age).toISOString()};const bytes=JSON.stringify(lock);this.backend.write('runner.lock',bytes);await this.ctx.storage.sync();return createHash('sha256').update(bytes).digest('hex');}
 async incident(){return this.backend.has('hold.json')?JSON.parse(this.backend.read('hold.json')).incidentId:null;}
 async fire(){return this.step();}
 async inspect(){await this.ctx.storage.sync();return {collections:this.readMeta('collections',0),sent:this.readMeta('sent',[]),schedule:this.readMeta('schedule'),alarm:await this.ctx.storage.getAlarm(),notification:this.readMeta('notification'),keys:this.ctx.storage.sql.exec('SELECT name FROM monitor_state ORDER BY name').toArray().map(row=>row.name)};}
}
export {MonitorDO};
export default {fetch(){return new Response('Not found',{status:404});}};
