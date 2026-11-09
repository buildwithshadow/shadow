import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {createHash,randomUUID} from 'node:crypto';
import {createMonitorSqlState} from './sql-state.mjs';
import {pinnedContext} from './pinned-context.mjs';
import {collectorOptions} from './collector-options.mjs';
import {notificationImport} from './notification-import.mjs';
import {runMonitorOnce,heartbeatStatus,acknowledgeHold} from '../../../app/scripts/float-mainnet-monitor-runner.mjs';
import {monitorSnapshot} from '../../../app/scripts/float-mainnet-monitor.mjs';
import {canonicalJson} from '../../../app/scripts/float-mainnet-monitor-policy.mjs';
import {notifyMainnet} from '../../../app/scripts/float-mainnet-monitor-alerts.mjs';
import {createReadonlyTransport} from '../../rpc-read-websocket/src/transport.ts';
import {websocketConnector} from '../../provider-worker-runtime/src/worker-socket.ts';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const binding=context=>hash(`${context.manifestHash}:${context.baselineHash}`);
const HOLD=Object.freeze({ok:false,hold:true,status:'hold',reason:'monitor-configuration-or-state-unavailable'});
async function boundedDelivery(send,message){
 let timer;
 try {
  await Promise.race([Promise.resolve().then(()=>send(message)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('alert delivery timed out')),5000);})]);
 } finally {clearTimeout(timer);}
}


/** Dedicated readonly Worker. Do not install provider signing keys or public routes here. */
export class MonitorDO extends DurableObject {
 constructor(ctx,env){
  super(ctx,env);
  this.backend=createMonitorSqlState(ctx.storage.sql);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS monitor_meta (name TEXT PRIMARY KEY, bytes TEXT NOT NULL)');
  this.inFlight=false;
  this.hooks={now:Date.now,context:()=>pinnedContext(env,this.backend),collect:context=>this.collect(context),send:async message=>{if(!env.ALERT_SINK)throw Error('alert sink unavailable');await env.ALERT_SINK.sendMonitorMessage(message);}};
 }
 readMeta=(name,fallback=null)=>{const rows=this.ctx.storage.sql.exec('SELECT bytes FROM monitor_meta WHERE name=?',name).toArray();return rows.length?JSON.parse(rows[0].bytes):fallback;}
 writeMeta=(name,value)=>{this.ctx.storage.sql.exec('INSERT INTO monitor_meta(name,bytes) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes',name,JSON.stringify(value));}
 context=()=>{const context=this.hooks.context();if(this.readMeta('binding')!==binding(context))throw Error('monitor binding not initialized');return context;}
 async initialize(approvedBinding,records,approvedInventoryHash,notificationPacket){
  if(this.inFlight||this.readMeta('binding')!==null||this.ctx.storage.sql.exec('SELECT name FROM monitor_state LIMIT 1').toArray().length)throw Error('monitor initialization requires completely empty state');
  const context=this.hooks.context();if(approvedBinding!==binding(context))throw Error('monitor binding not approved');
  if(!Array.isArray(records)||records.length>5)throw Error('invalid monitor inventory');
  const entries=records.map(record=>{if(!record||!['heartbeat.json','snapshot.json','hold.json','events.json','publication.json'].includes(record.name)||typeof record.bytes!=='string')throw Error('invalid monitor inventory');JSON.parse(record.bytes);return {name:record.name,bytes:record.bytes};});
  if(new Set(entries.map(r=>r.name)).size!==entries.length)throw Error('duplicate monitor record');
  const fingerprint=hash(canonicalJson(entries.map(r=>({name:r.name,sha256:hash(r.bytes)})).sort((a,b)=>a.name.localeCompare(b.name))));
  if(approvedInventoryHash!==fingerprint)throw Error('monitor inventory not approved');
  const notification=notificationImport(context,this.env.ALERT_DESTINATION_ID,notificationPacket,this.hooks.now());
  this.ctx.storage.transactionSync(()=>{if(notification)this.writeMeta('notification',notification);for(const r of entries)this.backend.write(r.name,r.bytes);this.writeMeta('binding',approvedBinding);});
  await this.ctx.storage.sync();return {initialized:true,records:entries.length};
 }
 async arm(){
  const context=this.context();let schedule=this.readMeta('schedule');
  if(!schedule?.enabled){schedule={enabled:true,nextDue:this.hooks.now()+context.baseline.policy.intervalMs,attempts:schedule?.attempts??0};this.writeMeta('schedule',schedule);}
  await this.ctx.storage.setAlarm(schedule.nextDue);await this.ctx.storage.sync();return schedule;
 }
 async stop(){const schedule=this.readMeta('schedule');if(schedule)this.writeMeta('schedule',{...schedule,enabled:false});await this.ctx.storage.deleteAlarm();await this.ctx.storage.sync();}
 async status(){await this.ctx.storage.sync();try{const context=this.context();if(!this.readMeta('schedule')?.enabled)return {...HOLD,reason:'checks-disabled'};return heartbeatStatus(context,this.hooks.now());}catch{return HOLD;}}
 collect=async(context)=>{
  if(typeof this.env.RPC_WSS_URL!=='string')throw Error('read endpoint unavailable');
  const started=performance.now(),diagnostics={requestedReads:0,logReads:0};
  const controller=new AbortController();const transport=createReadonlyTransport({connect:websocketConnector(this.env.RPC_WSS_URL),connectAttempts:1,requestTimeoutMs:20000,connectTimeoutMs:5000});
  const timer=setTimeout(()=>{controller.abort();transport.close();},context.baseline.policy.runTimeoutMs);
  try{
   const snapshot=await monitorSnapshot(collectorOptions(context),{readProvider:{request:args=>{diagnostics.requestedReads++;if(args.method==='eth_getLogs')diagnostics.logReads++;return transport.request(args,{signal:controller.signal});}}});
   return JSON.parse(JSON.stringify(snapshot,(_key,value)=>typeof value==='bigint'?value.toString():value));
  }finally{clearTimeout(timer);transport.close();this.writeMeta('lastCollectionUsage',{...diagnostics,elapsedMs:Math.ceil(performance.now()-started),transport:transport.stats()});}
 }
 notify=async(context)=>{
  return notifyMainnet({context,now:this.hooks.now(),previous:this.readMeta('notification'),destinationId:this.env.ALERT_DESTINATION_ID,
   send:message=>boundedDelivery(this.hooks.send,message),save:async value=>{this.writeMeta('notification',value);await this.ctx.storage.sync();}});
 }
 step=async()=>{
  if(this.inFlight)return {skipped:'overlap'};this.inFlight=true;
  try{
   const context=this.context(),schedule=this.readMeta('schedule');if(!schedule?.enabled)return {skipped:'disabled'};
   const now=this.hooks.now();if(now<schedule.nextDue){await this.ctx.storage.setAlarm(schedule.nextDue);return {skipped:'not-due'};}
   const next={...schedule,nextDue:now+context.baseline.policy.intervalMs,attempts:schedule.attempts+1};
   this.writeMeta('schedule',next);await this.ctx.storage.setAlarm(next.nextDue);await this.ctx.storage.sync();
   let result;try{result=await runMonitorOnce(context,{now:this.hooks.now,collect:()=>this.hooks.collect(context),afterCheckingPublished:()=>this.ctx.storage.sync(),afterSnapshotPublished:()=>this.ctx.storage.sync(),afterHoldLatched:()=>this.ctx.storage.sync()});}catch{result=HOLD;}
   await this.ctx.storage.sync();
   let notification;try{notification=await this.notify(context);}catch{notification={sent:false,reason:'delivery-failed'};}
   if(this.readMeta('schedule')?.enabled){const due=Math.max(next.nextDue,this.hooks.now()+1000);this.writeMeta('schedule',{...next,nextDue:due});await this.ctx.storage.setAlarm(due);}else await this.ctx.storage.deleteAlarm();
   await this.ctx.storage.sync();return {result,notification};
  }finally{this.inFlight=false;}
 }
 async admissionState(){
  await this.ctx.storage.sync();
  try {
   const context=this.context(),records=[];let total=0;
   for(const name of ['heartbeat.json','snapshot.json','hold.json','events.json','publication.json','runner.lock'])if(this.backend.has(name)){
    const bytes=this.backend.read(name);total+=new TextEncoder().encode(bytes).length;if(total>16*1024*1024)throw Error('monitor view exceeds bound');records.push({name,bytes});
   }
   const status=this.readMeta('schedule')?.enabled?heartbeatStatus(context,this.hooks.now()):{...HOLD,reason:'checks-disabled'};
   return {manifestHash:context.manifestHash,baselineHash:context.baselineHash,status,records};
  }catch{return {status:HOLD,records:[]};}
 }
 async recoverInterrupted(expectedLockHash){
  if(this.inFlight||this.readMeta('schedule')?.enabled)throw Error('stop and drain before interrupted recovery');
  const context=this.context(),bytes=this.backend.read('runner.lock');
  if(!/^[0-9a-f]{64}$/.test(expectedLockHash??'')||hash(bytes)!==expectedLockHash)throw Error('interrupted lock fingerprint mismatch');
  const lock=JSON.parse(bytes),started=Date.parse(lock.startedAt),now=this.hooks.now();
  if(typeof lock.token!=='string'||!lock.token||!Number.isFinite(started)||started>now||now-started<=context.baseline.policy.runTimeoutMs)throw Error('interrupted lock has not exceeded its run timeout');
  // Record the incident before releasing the lock. Recovery never creates a
  // healthy observation; a complete fresh scan and explicit acknowledgement follow.
  let incident=this.backend.has('hold.json')?JSON.parse(this.backend.read('hold.json')):null;
  if(incident&&(!incident.incidentId||incident.baselineHash!==context.baselineHash))throw Error('existing incident needs inspection');
  if(!incident)incident={incidentId:randomUUID(),createdAt:new Date(now).toISOString(),baselineHash:context.baselineHash,alerts:[{code:'MONITOR_INTERRUPTED',severity:'critical',detail:'operator recovered an interrupted durable monitor run'}]};
  this.ctx.storage.transactionSync(()=>{
   this.backend.write('hold.json',canonicalJson(incident));
   this.writeMeta(`interrupted:${expectedLockHash}`,{bytes,recoveredAt:new Date(now).toISOString(),incidentId:incident.incidentId});
   this.backend.release('runner.lock',lock.token);
  });
  await this.ctx.storage.sync();return {recovered:true,incidentId:incident.incidentId,hold:true};
 }
 async usage(){return this.readMeta('lastCollectionUsage');}
 async exportState(){if(this.inFlight||this.readMeta('schedule')?.enabled)throw Error('stop and drain the monitor before export');const view=await this.admissionState();if(this.inFlight||this.readMeta('schedule')?.enabled)throw Error('stop and drain the monitor before export');const notification=this.readMeta('notification');const bytes=notification===null?null:canonicalJson(notification);return {...view,notification:bytes===null?null:{bytes,sha256:hash(bytes)}};}
 async alarm(){await this.step();}
 async acknowledge(incidentId){if(this.inFlight)throw Error('monitor generation is active');const context=this.context();const result=acknowledgeHold(context,incidentId,this.hooks.now());await this.ctx.storage.sync();let notification;try{notification=await this.notify(context);}catch{notification={sent:false,reason:'delivery-failed'};}return {result,notification};}
}
const selected=env=>{
 if(!/^[0-9a-f]{64}$/.test(env.MANIFEST_APPROVED_SHA256??'')||!/^[0-9a-f]{64}$/.test(env.BASELINE_APPROVED_SHA256??''))throw Error('monitor identity is not configured');
 return env.MONITOR.getByName(hash(`${env.MANIFEST_APPROVED_SHA256}:${env.BASELINE_APPROVED_SHA256}`));
};
/** Bind only this read surface to the provider Worker. It cannot arm, acknowledge, import or change policy. */
export class MonitorRead extends WorkerEntrypoint {
 async status(){return selected(this.env).status();}
 async admissionState(){return selected(this.env).admissionState();}
}
/** Operator binding only. Never proxy this entrypoint from an HTTP route or a public Pages Function. */
export class MonitorAdmin extends WorkerEntrypoint {
 async initialize(approvedBinding,records,approvedInventoryHash,notificationPacket){return selected(this.env).initialize(approvedBinding,records,approvedInventoryHash,notificationPacket);}
 async arm(){return selected(this.env).arm();}
 async stop(){return selected(this.env).stop();}
 async acknowledge(incidentId){return selected(this.env).acknowledge(incidentId);}
 async recoverInterrupted(expectedLockHash){return selected(this.env).recoverInterrupted(expectedLockHash);}
 async exportState(){return selected(this.env).exportState();}
 async usage(){return selected(this.env).usage();}
}
export default {fetch(){return new Response('Not found',{status:404});}};
