import {expect,it} from 'vitest';
import handler,{deliverMonitorAlert} from '../src/alert-sink.mjs';
const config={ALERT_BOT_TOKEN:'123:synthetic_token',ALERT_DESTINATION_ID:'-456'};
const message='Shadow Arc MAINNET monitor — ATTENTION\nSynthetic monitor';
it('uses only the configured destination and reports delivery only after confirmation',async()=>{
 let sends=0;
 await deliverMonitorAlert(config,message,async(...args:Parameters<typeof fetch>)=>{
  const [url,options]=args;
  sends++;expect(String(url)).toBe('https://api.telegram.org/bot123:synthetic_token/sendMessage');expect(options?.redirect).toBe('error');
  expect(JSON.parse(String(options?.body))).toMatchObject({chat_id:'-456',text:message});
  return Response.json({ok:true,result:{chat:{id:-456}}});
 });expect(sends).toBe(1);expect((await handler.fetch()).status).toBe(404);
});
it('rejects a missing credential or destination before making a request',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({ok:true});};
 for(const vars of [{...config,ALERT_BOT_TOKEN:undefined},{...config,ALERT_DESTINATION_ID:undefined}])await expect(deliverMonitorAlert(vars,message,fetcher)).rejects.toThrow();
 expect(calls).toBe(0);
});
for(const [name,response] of [
 ['remote failure',()=>Response.json({ok:false})],
 ['wrong destination',()=>Response.json({ok:true,result:{chat:{id:99}}})],
 ['HTTP failure',()=>Response.json({ok:true,result:{chat:{id:-456}}},{status:503})],
 ['oversized response',()=>new Response(' '.repeat(32769))],
 ['malformed response',()=>new Response('not json')],
] as const)it(`never confirms ${name}`,async()=>{await expect(deliverMonitorAlert(config,message,async()=>response())).rejects.toThrow('NOTIFICATION_DELIVERY_FAILED');});
it('does not expose provider or monitor administration through the sink',async()=>{
 for(const value of ['',42,'other message','Shadow Arc MAINNET monitor '+'.'.repeat(4096)])await expect(deliverMonitorAlert(config,value,async()=>{throw Error('must not fetch');})).rejects.toThrow('invalid monitor alert');
});
