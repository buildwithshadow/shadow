import {WorkerEntrypoint} from 'cloudflare:workers';
import {sendTelegram} from '../../../app/scripts/public-testnet-observer-alerts.mjs';

/** The caller supplies text only; destination and credential belong to this separate Worker. */
export async function deliverMonitorAlert(vars,message,fetcher=fetch){
 if(typeof message!=='string'||message.length>4096||!/^Shadow Arc MAINNET monitor [\s\S]+/.test(message))throw Error('invalid monitor alert');
 await sendTelegram({token:vars.ALERT_BOT_TOKEN,chatId:vars.ALERT_DESTINATION_ID},message,async(url,options)=>{
  try {
   // workerd rejects redirect:'error' (the shared Node sender's mode) with a TypeError before any request, so every delivery
   // failed. 'manual' returns a redirect response unfollowed instead; any redirect is refused here and never confirms delivery.
   const response=await fetcher(url,{...options,redirect:'manual',signal:AbortSignal.timeout(4000)});
   if(response.type==='opaqueredirect'||response.status>=300&&response.status<400)throw Error();
   if(!response.body)throw Error();
   const reader=response.body.getReader();let size=0;const chunks=[];
   try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768)throw Error();chunks.push(value);}
   }finally{await reader.cancel().catch(()=>{});}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   return new Response(bytes,{status:response.status});
  }catch{throw Error('alert delivery unavailable');}
 });
}
export class AlertSink extends WorkerEntrypoint {
 async sendMonitorMessage(message){await deliverMonitorAlert(this.env,message);}
}
export default {fetch(){return new Response('Not found',{status:404});}};
