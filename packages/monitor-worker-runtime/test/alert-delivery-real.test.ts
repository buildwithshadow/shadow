import {env} from 'cloudflare:workers';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {deliverMonitorAlert} from '../src/alert-sink.mjs';

// Production behaviour, not stubs: real workerd fetch (intercepted only at the network edge), the real private service
// binding to the separate AlertSink entrypoint, the real default send hook shape, real MonitorDO durable state.
const TOKEN='123456:synthetic_token-test',CHAT='-1001234567890';
const message='Shadow Arc MAINNET monitor — CONNECTED\nContract 0x0000000000000000000000000000000000000001\nSynthetic.';
// Network edge only: the stub builds a real workerd Request from the exact arguments, so workerd's own option validation
// (for example the redirect mode) runs exactly as it would inside the real fetch. Only the remote answer is canned.
let replies:Array<()=>Response>=[],seen:Array<{url:string;body:unknown}>=[];
beforeEach(()=>{replies=[];seen=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const request=new Request(input,init);seen.push({url:request.url,body:JSON.parse(await request.text())});
 const next=replies.shift();if(!next)throw Error('unexpected network request');return next();
});});
afterEach(()=>{vi.restoreAllMocks();expect(replies).toEqual([]);});
const reply=(make:()=>Response)=>{replies.push(make);};
const telegramOk=()=>reply(()=>Response.json({ok:true,result:{chat:{id:Number(CHAT)}}}));

describe('workerd runtime compatibility of the real delivery path',()=>{
 it('workerd rejects the fetch redirect mode "error" that the shared Telegram sender requests',()=>{
  expect(()=>new Request('https://api.telegram.org/x',{redirect:'error' as never})).toThrow(/Invalid redirect value/);
  expect(()=>new Request('https://api.telegram.org/x',{redirect:'manual'})).not.toThrow();
 });
 it('delivers through the real fetch to the configured bot and destination',async()=>{
  telegramOk();
  await deliverMonitorAlert({ALERT_BOT_TOKEN:TOKEN,ALERT_DESTINATION_ID:CHAT},message); // default fetcher = workerd fetch
  expect(seen).toEqual([{url:`https://api.telegram.org/bot${TOKEN}/sendMessage`,body:expect.objectContaining({chat_id:CHAT})}]);
 });
 it('still never confirms a redirect, a remote refusal or a wrong destination with the real fetch',async()=>{
  reply(()=>new Response(null,{status:302,headers:{location:'https://example.invalid/'}}));
  await expect(deliverMonitorAlert({ALERT_BOT_TOKEN:TOKEN,ALERT_DESTINATION_ID:CHAT},message)).rejects.toThrow('NOTIFICATION_DELIVERY_FAILED');
  reply(()=>Response.json({ok:true,result:{chat:{id:99}}}));
  await expect(deliverMonitorAlert({ALERT_BOT_TOKEN:TOKEN,ALERT_DESTINATION_ID:CHAT},message)).rejects.toThrow('NOTIFICATION_DELIVERY_FAILED');
 });
 it('a completed healthy generation is delivered through the service binding and recorded durably',async()=>{
  const monitor=env.SINK_MONITOR.getByName('real-sink');
  await monitor.setup();await monitor.arm();
  telegramOk();
  const cycle=await monitor.due();
  expect(cycle.result.ok).toBe(true);
  expect(cycle.notification).toMatchObject({sent:true,state:'healthy'});
  await monitor.stop();
  const exported=await monitor.exportState();
  expect(exported.notification).not.toBeNull();
 });
});
