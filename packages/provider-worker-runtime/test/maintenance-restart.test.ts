import { evictAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { coordinator, digestOf, edge, importThroughCoordinator, jsonOf } from './helpers.ts';
it('preserves the maintenance lock across coordinator eviction and resumes only explicitly', async()=>{
 await importThroughCoordinator();
 const c=await coordinator();
 expect(await c.quiesce()).toMatchObject({quiesced:true,drained:true});
 await evictAllDurableObjects();
 const held=await edge(`/status/${digestOf(99)}`);
 expect(held.status).toBe(503);
 expect(jsonOf(held).error).toBe('Provider is quiesced for maintenance; retry later');
 await (await coordinator()).resume();
 expect((await edge(`/status/${digestOf(99)}`)).status).toBe(200);
});
