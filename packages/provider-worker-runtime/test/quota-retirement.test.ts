import {expect,it} from 'vitest';
import {evictAllDurableObjects} from 'cloudflare:test';
import {coordinator,digestOf,edge,importThroughCoordinator} from './helpers.ts';
it('retains per-caller route quotas across idle retirement and actor eviction',async()=>{
 let c=await coordinator();await c.__override({RATE_LIMIT_PER_MINUTE:'2'});await c.__managedConnection();await importThroughCoordinator();
 expect((await edge(`/status/${digestOf(71)}`)).status).toBe(200);
 expect((await edge(`/status/${digestOf(72)}`)).status).toBe(200);
 await new Promise(resolve=>setTimeout(resolve,50));
 expect((await c.__counters()).closed).toBeGreaterThanOrEqual(1);
 expect((await edge(`/status/${digestOf(73)}`)).status).toBe(429);
 await evictAllDurableObjects();c=await coordinator();
 expect((await edge(`/status/${digestOf(74)}`)).status).toBe(429);
 expect((await edge(`/status/${digestOf(75)}`,{ip:'203.0.113.8'})).status).toBe(200);
});
