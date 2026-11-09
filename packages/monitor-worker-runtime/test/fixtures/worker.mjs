import {MonitorDO} from '../../src/worker.mjs';
import {fixture,NOW} from './data.mjs';
import {digestJson,canonicalJson} from '../../../../app/scripts/float-mainnet-monitor-policy.mjs';
import {createHash} from 'node:crypto';
import {keccak256} from 'viem';
import {approved} from './public-config.mjs';
import {pinnedContext} from '../../src/pinned-context.mjs';
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
 async importExport(view){const context=this.hooks.context();const hash=s=>createHash('sha256').update(s).digest('hex');const inventory=hash(canonicalJson(view.records.map(r=>({name:r.name,sha256:hash(r.bytes)})).sort((a,b)=>a.name.localeCompare(b.name))));return this.initialize(hash(`${context.manifestHash}:${context.baselineHash}`),view.records,inventory,view.notification??undefined);}
 async advance(ms=60000){this.writeMeta('clock',this.hooks.now()+ms);await this.ctx.storage.sync();}
 async mode(value){if(!['healthy','failure','slow','delivery-failed','delivery-stalled'].includes(value))throw Error('invalid test mode');this.writeMeta('mode',value);await this.ctx.storage.sync();}
 async interruptedLock(age=300000){const lock={token:'synthetic-interrupted-token',startedAt:new Date(this.hooks.now()-age).toISOString()};const bytes=JSON.stringify(lock);this.backend.write('runner.lock',bytes);await this.ctx.storage.sync();return createHash('sha256').update(bytes).digest('hex');}
 async incident(){return this.backend.has('hold.json')?JSON.parse(this.backend.read('hold.json')).incidentId:null;}
 async fire(){return this.step();}
 async inspect(){await this.ctx.storage.sync();return {collections:this.readMeta('collections',0),sent:this.readMeta('sent',[]),schedule:this.readMeta('schedule'),alarm:await this.ctx.storage.getAlarm(),notification:this.readMeta('notification'),keys:this.ctx.storage.sql.exec('SELECT name FROM monitor_state ORDER BY name').toArray().map(row=>row.name)};}
}
export class TestPublicMonitorDO extends TestMonitorDO {
 constructor(ctx,env){super(ctx,env);const vars=approved(keccak256('0x1234')),context=pinnedContext(vars,this.backend);
  this.hooks={...this.hooks,context:()=>context,now:Date.now,collect:async()=>{
   const snapshot=fixture().snapshot;snapshot.identity.runtimeCodeHash=keccak256('0x1234');snapshot.observedAt.timestamp=String(Math.floor(Date.now()/1000));
   snapshot.contract.operators=[];snapshot.contract.openingsPaused=false;snapshot.contract.totalSponsorObligations='0';snapshot.contract.totalCommittedCapital='0';snapshot.contract.effectiveLimits=context.baseline.effectiveLimits;
   snapshot.sponsors=[];snapshot.lines=[];snapshot.discovery.lines=0;const history=context.baseline.approvedHistory;snapshot.discovery.approvedHistory={sha256:history.sha256,anchorBlock:history.anchorBlock,anchorHash:history.anchorHash,prefixLogCount:0,suffixLogCount:0};snapshot.alerts=[];snapshot.accounting.balance='0';return snapshot;
  }};
 }
 async due(){const schedule=this.readMeta('schedule');this.writeMeta('schedule',{...schedule,nextDue:0});await this.ctx.storage.sync();return this.step();}
}
export {MonitorDO};
export default {fetch(){return new Response('Not found',{status:404});}};
