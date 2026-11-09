import {expect,it} from 'vitest';
import {coordinator,configuredIdentity,operatorApproval,edge,digestOf,fileOf,canonical} from './helpers.ts';
it('does not resume public traffic while bootstrap awaits its first administrative operation',async()=>{
 const c=await coordinator();await c.quiesce();
 const result=await c.__resumeDuringBootstrap([],await operatorApproval(configuredIdentity(),[]));
 expect(result.resumeError).toMatch(/administrative/);expect(result.result).toEqual({records:0});
 expect((await edge(`/status/${digestOf(90)}`)).status).toBe(503);await c.resume();
});
it('retains the maintenance lock while repair is pending and releases the operation count after failure',async()=>{
 const c=await coordinator();await c.quiesce();
 const result=await c.__resumeDuringComplete(fileOf(90,'acceptance'),canonical({}),'invalid');
 expect(result.resumeError).toMatch(/administrative/);expect(result.error).toBeTruthy();
 expect((await edge(`/status/${digestOf(90)}`)).status).toBe(503);await c.resume();
});
