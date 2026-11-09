import {expect,it} from 'vitest';
import {coordinator,digestOf,edge,importThroughCoordinator} from './helpers.ts';
it('unregisters every HTTP server across repeated managed connection retirement',async()=>{
 const c=await coordinator();await c.__managedConnection();await importThroughCoordinator();
 for(let n=0;n<6;n++){
  expect((await edge(`/status/${digestOf(100+n)}`)).status).toBe(200);
  await new Promise(resolve=>setTimeout(resolve,40));
 }
 const stats=await c.__serverStats();expect(stats.created).toBeGreaterThanOrEqual(6);expect(stats.listening).toBe(0);
});
