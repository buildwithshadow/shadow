import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationState, notify, sendTelegram } from './public-testnet-observer-alerts.mjs';
const now = Date.now();
const healthy = { manifestHash: 'hash', startedAt: new Date(now-200000).toISOString(), completedAt: new Date(now-1000).toISOString(), ok: true, issues: [] };

test('normal scan is quiet; stuck scan, missing state and wrong manifest alert', () => {
 const running = { ...healthy, completedAt: null, ok: false, issues: ['CHECK_IN_PROGRESS'] };
 assert.equal(notificationState(running, 'hash', now), null);
 assert.equal(notificationState(running, 'hash', now+1260000).ok, false);
 assert.equal(notificationState(undefined, 'hash', now).ok, false);
 assert.equal(notificationState({issues:{}}, 'hash', now).ok, false);
 assert.equal(notificationState(running, 'different', now).ok, false);
 assert.equal(notificationState(healthy, 'hash', now+700000).ok, false);
});

test('failure and recovery each notify once across saved state; reminder after six hours', async () => {
 let previous, messages=[];
 const run = (raw, time=now) => notify({raw,manifestHash:'hash',previous,now:time,send:async m=>messages.push(m),save:async p=>{previous=p;}});
 await run(healthy); await run(healthy); assert.equal(messages.length,1);
 await run(undefined); await run(undefined); assert.equal(messages.length,2);
 await run({...healthy,completedAt:null,ok:false,issues:['CHECK_IN_PROGRESS']}); assert.equal(messages.length,2);
 await run(undefined,now+21600000); assert.equal(messages.length,3);
 await run(healthy); assert.match(messages.at(-1),/RECOVERED/); assert.equal(messages.length,4);
 await run(healthy); assert.equal(messages.length,4);
});

test('delivery failure does not mark incident acknowledged', async () => {
 let saved=false;
 await assert.rejects(notify({raw:undefined,manifestHash:'hash',send:async()=>{throw Error('offline');},save:async()=>{saved=true;},now}));
 assert.equal(saved,false);
});

test('Telegram delivery binds destination and suppresses token-bearing transport errors', async () => {
 const config={token:'123:secret',chatId:'-123'};
 await sendTelegram(config,'test',async()=>({ok:true,json:async()=>({ok:true,result:{chat:{id:-123}}})}));
 await assert.rejects(sendTelegram(config,'test',async()=>({ok:true,json:async()=>({ok:true,result:{chat:{id:-456}}})})),/NOTIFICATION_DELIVERY_FAILED/);
 await assert.rejects(sendTelegram(config,'test',async()=>{throw Error('https://api.telegram.org/bot123:secret');}),e=>e.message==='NOTIFICATION_DELIVERY_FAILED');
});
