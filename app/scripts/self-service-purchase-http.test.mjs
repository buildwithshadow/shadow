import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderServer } from '../../examples/float-mainnet-provider-server/server.mjs';
const origin = 'https://www.shadowbuild.xyz';
async function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-http-'));
  const server = createProviderServer({ connection: {}, account: { address: '0x1111111111111111111111111111111111111111' }, endpointHash: '0x'+'00'.repeat(32), price: 50000n, storeDir: dir, service: async () => ({ result: 'test' }), publicOrigin: origin, ...extra });
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
  const response=await fetch(url+'/unknown');assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');
});
test('public provider rejects malformed bodies before any RPC or signing',async t=>{
  const url=await fixture(t);
  const response=await fetch(url+'/accept',{method:'POST',headers:{origin,'content-type':'application/json'},body:'not json'});
  assert.equal(response.status,400);assert.match((await response.json()).error,/not JSON/);
});
