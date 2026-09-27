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

test('an occupied purchase lane cannot consume reserved recovery slots', async t => {
  let server;
  const url = await fixture(t, { maxConcurrent: 2, trustLoopbackProxy: true, onServer: value => { server = value } });
  const arrived = once(server, 'request');
  const stalled = request(url + '/accept', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadow-client-ip': '198.51.100.1' } });
  stalled.on('error', () => {}); stalled.write('{');
  await arrived;
  try {
    const send = route => fetch(url + route, { method: 'POST', body: 'invalid', headers: { 'x-shadow-client-ip': '198.51.100.2' } });
    assert.equal((await send('/accept')).status, 429);
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
    assert.equal((await fetch(url+'/status/'+hash, { headers: { 'x-shadow-client-ip': '198.51.100.3' } })).status, 429);
    const served = await fetch(url+'/serve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadow-client-ip': '198.51.100.1' }, body: JSON.stringify({digest:hash}) });
    assert.equal(served.status, 404, 'serve reaches the receipt lookup while both normal slots are held');
  } finally { release(); await Promise.all(polling); }
});

test('a full status-caller quota table cannot reject a new recovery caller', async t => {
  const url = await fixture(t, { trustLoopbackProxy: true });
  for (let i = 0; i < 2048; i++) {
    const ip = `198.51.${Math.floor(i / 254)}.${i % 254 + 1}`;
    const r = await fetch(url+'/status/invalid', { headers: { 'x-shadow-client-ip': ip } });
    assert.equal(r.status, 400);
    await r.text();
  }
  const headers = { 'x-shadow-client-ip': '203.0.113.1' };
  assert.equal((await fetch(url+'/status/invalid', {headers})).status, 429);
  assert.equal((await fetch(url+'/serve', {method:'POST',headers,body:'invalid'})).status, 400);
});
