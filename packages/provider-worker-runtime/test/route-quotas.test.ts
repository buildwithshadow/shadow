import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {durableRouteQuotas} from '../src/route-quotas.ts';
import {coordinator} from './helpers.ts';
it('persists mutable counters and keeps stored caller keys private and iterable',async()=>{
 await runInDurableObject(await coordinator(),(_instance,state)=>{
  const maps=durableRouteQuotas(state.storage),caller='203.0.113.51';
  maps.status.set(caller,{start:100,count:0});
  maps.status.get(caller)!.count++;
  expect(durableRouteQuotas(state.storage).status.get(caller)?.count).toBe(1);
  expect(maps.accept.get(caller)).toBeUndefined();
  const rows=state.storage.sql.exec<{caller:string}>('SELECT caller FROM provider_route_quotas').toArray();
  expect(rows).toHaveLength(1);expect(rows[0]!.caller).toMatch(/^[0-9a-f]{64}$/);expect(rows[0]!.caller).not.toContain(caller);
  const entries=[...maps.status];expect(entries[0]![1]).toMatchObject({start:100,count:1});
  expect(maps.status.delete(entries[0]![0])).toBe(true);expect(maps.status.size).toBe(0);
 });
});
it('retains insertion order when an existing window changes and rejects invalid counters',async()=>{
 await runInDurableObject(await coordinator(),(_instance,state)=>{
  const map=durableRouteQuotas(state.storage).serve;
  map.set('203.0.113.1',{start:1,count:0});map.set('203.0.113.2',{start:2,count:0});
  const first=[...map.keys()][0];map.set('203.0.113.1',{start:3,count:0});expect([...map.keys()][0]).toBe(first);
  expect(()=>map.set('203.0.113.3',{start:1,count:-1})).toThrow('invalid quota');
  expect(()=>{map.get('203.0.113.1')!.count=NaN;}).toThrow('invalid quota count');
 });
});
