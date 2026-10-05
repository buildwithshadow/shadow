import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderServer } from '../../examples/float-mainnet-provider-server/server.mjs';
const origin = 'https://www.shadowbuild.xyz';
async function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-http-'));
  const server = createProviderServer({ connection: {}, account: { address: '0x1111111111111111111111111111111111111111' }, endpointHash: '0x'+'00'.repeat(32), price: 50000n, storeDir: dir, service: async () => ({ result: 'test' }), publicOrigin: origin, ...extra });
  extra.onServer?.(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, {recursive:true,force:true}); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('public provider CORS accepts only the pinned frontend and supports preflight', async t => {
  const url = await fixture(t);
  const response = await fetch(url+'/accept', {method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);
  assert.equal((await fetch(url+'/accept',{method:'OPTIONS',headers:{origin:'https://untrusted.example'}})).status,403);
  const direct = await fetch(url+'/unknown');assert.equal(direct.status,404);assert.equal(direct.headers.get('cache-control'),'no-store');
});
test('public provider bounds request admission without leaking errors', async t => {
  const url=await fixture(t,{maxRequestsPerMinute:1});
  assert.equal((await fetch(url+'/unknown')).status,404);
  assert.equal((await fetch(url+'/accept',{method:'POST',body:'invalid'})).status,400);
  const response=await fetch(url+'/accept',{method:'POST',body:'invalid',headers:{'x-shadow-client-ip':'8.8.8.8'}});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');
  assert.equal((await fetch(url+'/serve',{method:'POST',body:'invalid'})).status,400,'accept quota cannot deny recovery');
});
test('public provider rejects malformed bodies before any RPC or signing',async t=>{
  const url=await fixture(t);
  const response=await fetch(url+'/accept',{method:'POST',headers:{origin,'content-type':'application/json'},body:'not json'});
  assert.equal(response.status,400);assert.match((await response.json()).error,/not JSON/);
});

test('a trusted loopback proxy assigns separate caller budgets and requires a valid address', async t => {
  const url=await fixture(t,{maxRequestsPerMinute:1,trustLoopbackProxy:true});
  const send=ip=>fetch(url+'/accept',{method:'POST',body:'invalid',headers:ip?{'x-shadow-client-ip':ip}:{}});
  assert.equal((await send()).status,400);
  assert.equal((await send('198.51.100.1')).status,400);
  assert.equal((await send('198.51.100.1')).status,429);
  assert.equal((await send('198.51.100.2')).status,400);
});

test('an incomplete purchase body cannot consume service or recovery slots', async t => {
  let server;
  const url = await fixture(t, { maxConcurrent: 2, trustLoopbackProxy: true, onServer: value => { server = value } });
  const arrived = once(server, 'request');
  const stalled = request(url + '/accept', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadow-client-ip': '198.51.100.1' } });
  stalled.on('error', () => {}); stalled.write('{');
  await arrived;
  try {
    const send = route => fetch(url + route, { method: 'POST', body: 'invalid', headers: { 'x-shadow-client-ip': '198.51.100.2' } });
    assert.equal((await send('/accept')).status, 400);
    assert.equal((await send('/serve')).status, 400, 'recovery still reaches request validation');
  } finally { stalled.destroy(); }
});
test('malformed absolute request targets return 400 without terminating the server', async t => {
  const url=await fixture(t);
  const result=await new Promise((resolve,reject)=>{
    const req=request(url,{path:'http://[',method:'GET'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end();
  });
  assert.equal(result,400);
  assert.equal((await fetch(url+'/unknown')).status,404);
});

test('blocked status RPC reads cannot consume exclusive result-delivery capacity', async t => {
  let release, started;
  const hold = new Promise(resolve => { release = resolve });
  const arrived = new Promise(resolve => { started = resolve });
  let reads = 0;
  const url = await fixture(t, { trustLoopbackProxy: true, connection: { client: { readContract: async () => { if (++reads === 2) started(); await hold; return 0n; } } } });
  const hash = '0x'+'ab'.repeat(32);
  const polling = [1,2].map(i => fetch(url+'/status/'+hash, { headers: { 'x-shadow-client-ip': `198.51.100.${i}` } }));
  try {
    await arrived;
    const busy=await fetch(url+'/status/'+hash, { headers: { 'x-shadow-client-ip': '198.51.100.3' } });
    assert.equal(busy.status,429);assert.equal(busy.headers.get('retry-after'),'60');await busy.text();
    const served = await fetch(url+'/serve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadow-client-ip': '198.51.100.1' }, body: JSON.stringify({digest:hash}) });
    assert.equal(served.status, 404, 'serve reaches the receipt lookup while both normal slots are held');
  } finally { release(); await Promise.all(polling); }
});

for (const route of ['status','serve']) test(`a full ${route} caller table still admits new callers`, async t => {
  const url = await fixture(t, { trustLoopbackProxy: true });
  for (let i = 0; i < 2048; i++) {
    const ip = `198.51.${Math.floor(i / 254)}.${i % 254 + 1}`;
    const r = await fetch(url+(route==='status'?'/status/invalid':'/serve'), {method:route==='status'?'GET':'POST',body:route==='status'?undefined:'invalid',headers:{'x-shadow-client-ip':ip}});
    assert.equal(r.status, 400);
    await r.text();
  }
  const headers = { 'x-shadow-client-ip': '203.0.113.1' };
  assert.equal((await fetch(url+'/status/invalid', {headers})).status, 400);
  assert.equal((await fetch(url+'/serve', {method:'POST',headers,body:'invalid'})).status, 400);
});


test('slow bodies in both lanes cannot block complete requests and are closed on an absolute deadline', async t => {
  let server;
  const url=await fixture(t,{trustLoopbackProxy:true,onServer:s=>{server=s}});
  const slow=[];
  try {
    for (const [i,route] of ['/accept','/accept','/serve','/serve'].entries()) {
      const arrived=once(server,'request');
      const req=request(url+route,{method:'POST',headers:{'x-shadow-client-ip':`198.51.100.${i+1}`,'content-length':'4096'}});
      req.on('error',()=>{}); req.write('{');
      const closed=new Promise(resolve=>req.once('close',resolve)); const timer=setInterval(()=>{if(!req.destroyed)req.write(' ');},100);
      slow.push({req,closed,timer}); await arrived;
    }
    for(const route of ['/accept','/serve']) {
      const r=await fetch(url+route,{method:'POST',headers:{'x-shadow-client-ip':'203.0.113.1'},body:'invalid'});
      assert.equal(r.status,400,'complete body reaches validation instead of occupied processing slots');
    }
    assert.equal((await fetch(url+'/status/invalid',{headers:{'x-shadow-client-ip':'203.0.113.1'}})).status,400);
    await Promise.race([Promise.all(slow.map(x=>x.closed)),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Body deadline did not close slow connections')),3500);timer.unref();})]);
    assert.ok(slow.every(x=>x.req.destroyed));
  } finally {for(const x of slow){clearInterval(x.timer);x.req.destroy();}}
});


test('recovery-only admission refusal does not log a provider failure',async t=>{
  const errors=t.mock.method(console,'error',()=>{});
  const url=await fixture(t,{recoveryOnly:true});
  const response=await fetch(url+'/accept',{method:'POST',body:'invalid'});
  assert.equal(response.status,503);
  assert.match((await response.json()).error,/recovery-only/);
  assert.equal(errors.mock.callCount(),0);
});

test('normal work plus slow ingress preserves every configured recovery connection',async t=>{
  let release,started,server,reads=0;
  const held=new Promise(resolve=>{release=resolve});
  const ready=new Promise(resolve=>{started=resolve});
  const url=await fixture(t,{publicOrigin:null,maxConcurrent:32,trustLoopbackProxy:true,onServer:s=>{server=s},connection:{client:{readContract:async()=>{if(++reads===16)started();await held;return 0n;}}}});
  const hash='0x'+'ab'.repeat(32);
  const polling=Array.from({length:16},(_,i)=>fetch(url+'/status/'+hash,{headers:{'x-shadow-client-ip':`198.51.100.${i+1}`}}));
  const bodies=[];
  try {
    await ready;
    for(let i=0;i<8;i++){
      const arrived=once(server,'request');
      const req=request(url+'/accept',{method:'POST',headers:{'x-shadow-client-ip':`192.0.2.${i+1}`}});
      req.on('error',()=>{});req.write('{');bodies.push(req);await arrived;
    }
    // These uploads are rejected before a body reader is available. They
    // must close promptly rather than filling the TCP recovery allowance.
    const rejected = [];
    for(let i=0;i<24;i++) {
      const req=request(url+'/accept',{method:'POST',headers:{'x-shadow-client-ip':`192.0.2.${i+20}`,'content-length':'4096'}});
      const closed=new Promise(resolve=>req.once('close',resolve));
      const response=new Promise((resolve,reject)=>{req.once('response',res=>{res.resume();resolve(res)});req.once('error',reject)});
      req.write('{');bodies.push(req);rejected.push(closed);
      const res=await response;
      assert.equal(res.statusCode,429);assert.equal(res.headers['retry-after'],'60');assert.equal(res.headers.connection,'close');
    }
    await Promise.race([Promise.all(rejected),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Rejected uploads retained TCP slots')),1000);timer.unref();})]);
    const recoveries=await Promise.all(Array.from({length:16},(_,i)=>fetch(url+'/serve',{method:'POST',headers:{'x-shadow-client-ip':`203.0.113.${i+1}`},body:JSON.stringify({digest:hash})})));
    assert.ok(recoveries.every(response=>response.status===404),'all recovery requests reach receipt lookup');
    await Promise.all(recoveries.map(response=>response.text()));
  } finally {for(const req of bodies)req.destroy();release();await Promise.allSettled(polling);}
});
