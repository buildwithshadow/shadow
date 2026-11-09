import {beforeAll,expect,it} from 'vitest';
import {coordinator,digestOf,edge,importThroughCoordinator} from './helpers.ts';
const ORIGIN='https://www.shadowbuild.xyz';
beforeAll(async()=>{await importThroughCoordinator([]);});
it('browser preflight allows only the exact approved origin and content type',async()=>{
 const c=await coordinator();const before=(await c.__counters()).requests;
 const result=await edge('/serve',{method:'OPTIONS',headers:{origin:ORIGIN,'access-control-request-method':'POST','access-control-request-headers':'Content-Type'}});
 expect(result.status).toBe(204);expect(result.headers.get('access-control-allow-origin')).toBe(ORIGIN);
 expect(result.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
 expect(result.headers.get('access-control-allow-headers')).toBe('content-type');
 expect(result.headers.get('vary')).toContain('Origin');expect((await c.__counters()).requests).toBe(before);
 const refused: Record<string,string>[] = [
  {origin:'https://evil.invalid','access-control-request-method':'POST'},
  {origin:ORIGIN,'access-control-request-method':'DELETE'},
  {origin:ORIGIN,'access-control-request-method':'POST','access-control-request-headers':'authorization'},
  {'access-control-request-method':'POST'},
 ];
 for(const headers of refused)expect((await edge('/serve',{method:'OPTIONS',headers})).status).toBe(403);
});
it('allowed browser origin can read success, early errors and held responses',async()=>{
 const success=await edge(`/status/${digestOf(99)}`,{headers:{origin:ORIGIN},ip:'192.0.2.101'});
 expect(success.status).toBe(200);expect(success.headers.get('access-control-allow-origin')).toBe(ORIGIN);
 const missing=await edge('/serve',{ip:null,headers:{origin:ORIGIN}});
 expect(missing.status).toBe(400);expect(missing.headers.get('access-control-allow-origin')).toBe(ORIGIN);
 const c=await coordinator();await c.quiesce();
 try {
  const held=await edge('/serve',{method:'POST',body:'{}',headers:{origin:ORIGIN,'content-type':'application/json'}});
  expect(held.status).toBe(503);expect(held.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(held.headers.get('access-control-expose-headers')).toBe('retry-after');
 } finally {await c.resume();}
});
it('foreign origins are refused before any coordinator and never reflected',async()=>{
 const c=await coordinator();const before=(await c.__counters()).requests;
 for(const origin of ['null','https://evil.invalid',ORIGIN+'.evil.invalid',ORIGIN+'/']) {
  const r=await edge('/serve',{method:'POST',body:'{}',headers:{origin}});
  expect(r.status).toBe(403);expect(r.headers.has('access-control-allow-origin')).toBe(false);expect(r.headers.get('vary')).toContain('Origin');
 }
 expect((await c.__counters()).requests).toBe(before);
});
