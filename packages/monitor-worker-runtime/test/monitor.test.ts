import {env} from 'cloudflare:workers';
import {evictAllDurableObjects} from 'cloudflare:test';
import {expect,it} from 'vitest';
const stub=(name:string)=>env.MONITOR.get(env.MONITOR.idFromName(name));
it('does not invent healthy state or implicitly initialize empty storage',async()=>{const m=stub('empty');expect(await m.status()).toMatchObject({ok:false,hold:true});expect((await m.attempt('arm')).error).toMatch(/not initialized/);expect((await m.inspect()).keys).toEqual([]);});
it('requires independent initialization approvals before persisting anything',async()=>{const m=stub('approval');expect((await m.attempt('initialize','wrong',[],'wrong')).error).toMatch(/not approved/);expect((await m.inspect()).keys).toEqual([]);expect(await m.setup()).toEqual({initialized:true,records:0});expect((await m.attempt('setup')).error).toMatch(/empty state/);expect(await m.status()).toMatchObject({hold:true,reason:'checks-disabled'});});
it('runs the actual kernel on a due alarm and never catches up or repeats a slot',async()=>{const m=stub('slots');await m.setup();await m.arm();expect(await m.fire()).toEqual({skipped:'not-due'});await m.advance();expect((await m.fire()).result).toMatchObject({ok:true,hold:false});expect((await m.status()).ok).toBe(true);expect(await m.fire()).toEqual({skipped:'not-due'});await m.advance(600000);expect((await m.fire()).result.hold).toBe(true);expect((await m.inspect()).collections).toBe(2);expect((await m.inspect()).sent).toHaveLength(2);});
it('retains schedule and notification suppression across eviction',async()=>{let m=stub('restart');await m.setup();await m.arm();await m.advance();await m.fire();await evictAllDurableObjects();m=stub('restart');expect((await m.status()).ok).toBe(true);await m.advance();await m.fire();const state=await m.inspect();expect(state.collections).toBe(2);expect(state.sent).toHaveLength(1);expect(state.alarm).toBe(state.schedule.nextDue);});
it('keeps an incident latched after healthy scans until explicit matching acknowledgement',async()=>{const m=stub('incident');await m.setup();await m.arm();await m.mode('failure');await m.advance();await m.fire();const failed=await m.status();expect(failed.hold).toBe(true);await m.mode('healthy');await m.advance();await m.fire();const held=await m.status();expect(held.hold).toBe(true);const hold=held.alerts.find((a:{code:string})=>a.code==='HOLD_LATCHED');expect(hold).toBeTruthy();expect((await m.attempt('acknowledge','wrong')).error).toMatch(/incident-id/);expect((await m.status()).hold).toBe(true);const incident=await m.incident();expect(incident).toBeTruthy();await m.acknowledge(incident);expect((await m.status()).ok).toBe(true);});
it('does not mark failed delivery as sent or suppress the next delivery',async()=>{const m=stub('delivery');await m.setup();await m.arm();await m.mode('delivery-failed');await m.advance();expect((await m.fire()).notification).toEqual({sent:false,reason:'delivery-failed'});expect((await m.inspect()).notification).toBeNull();await m.mode('healthy');await m.advance();await m.fire();expect((await m.inspect()).sent).toHaveLength(1);});
it('stopping prevents admission even with a fresh healthy heartbeat',async()=>{const m=stub('stop');await m.setup();await m.arm();await m.advance();await m.fire();await m.stop();expect(await m.status()).toMatchObject({ok:false,hold:true,reason:'checks-disabled'});expect((await m.inspect()).alarm).toBeNull();expect(await m.fire()).toEqual({skipped:'disabled'});});

it('exports exact monitor records only while stopped and drained',async()=>{const m=stub('export');await m.setup();await m.arm();await m.advance();await m.fire();expect((await m.attempt('exportState')).error).toMatch(/stop and drain/);await m.stop();const snapshot=await m.exportState();expect(snapshot.status.hold).toBe(true);expect(snapshot.records.map((r:{name:string})=>r.name)).toContain('heartbeat.json');expect(snapshot.records.some((r:{name:string})=>r.name==='runner.lock')).toBe(false);});

it('recovers only an explicitly identified expired lock while stopped and retains the incident',async()=>{
 const m=stub('interrupted');await m.setup();await m.arm();const digest=await m.interruptedLock();
 expect((await m.attempt('recoverInterrupted',digest)).error).toMatch(/stop and drain/);
 await m.stop();expect((await m.attempt('recoverInterrupted','0'.repeat(64))).error).toMatch(/lock fingerprint/);
 expect((await m.inspect()).keys).toContain('runner.lock');
 const recovered=await m.recoverInterrupted(digest);expect(recovered.incidentId).toBeTruthy();
 expect((await m.inspect()).keys).not.toContain('runner.lock');
 await m.arm();await m.advance();await m.fire();expect((await m.status()).hold).toBe(true);
 await m.acknowledge(recovered.incidentId);expect((await m.status()).ok).toBe(true);
});
it('never clears a lock still inside its run timeout',async()=>{
 const m=stub('recent-lock');await m.setup();const digest=await m.interruptedLock(0);
 expect((await m.attempt('recoverInterrupted',digest)).error).toMatch(/timeout/);
 expect((await m.inspect()).keys).toContain('runner.lock');
});

it('releases the generation when the alert sink never settles and retries later',async()=>{
 const m=stub('stalled-sink');await m.setup();await m.arm();await m.mode('delivery-stalled');await m.advance();
 let timer:ReturnType<typeof setTimeout>;
 try {
  const result=await Promise.race([m.fire(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('notification blocked generation')),6500);})]);
  expect(result.notification).toEqual({sent:false,reason:'delivery-failed'});
 } finally {clearTimeout(timer!);}
 expect((await m.inspect()).notification).toBeNull();
 await m.mode('healthy');await m.advance();expect((await m.fire()).result.ok).toBe(true);
 expect((await m.inspect()).collections).toBe(2);expect((await m.inspect()).sent).toHaveLength(1);
});

it('imports independently fingerprinted notification state without resetting suppression',async()=>{
 const source=stub('source-notification'),destination=stub('imported-notification');await source.setup();await source.arm();await source.advance();await source.fire();await source.stop();
 const exported=await source.exportState();expect(exported.notification).toBeTruthy();
 await destination.advance();await destination.importExport(exported);await destination.arm();await destination.advance();await destination.fire();
 expect((await destination.inspect()).sent).toHaveLength(0);expect((await destination.status()).ok).toBe(true);
});
it('refuses altered notification import before initializing any state',async()=>{
 const source=stub('source-bad-notification'),destination=stub('bad-notification');await source.setup();await source.arm();await source.advance();await source.fire();await source.stop();
 const exported=await source.exportState();exported.notification.bytes+=' ';
 expect((await destination.attempt('importExport',exported)).error).toMatch(/fingerprint/);expect((await destination.inspect()).keys).toEqual([]);
});
