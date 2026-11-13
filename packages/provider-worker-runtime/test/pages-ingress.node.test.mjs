import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRoutes, routeProviderRequest } from '../src/pages-ingress.mjs';

for (const [prefix, binding] of providerRoutes) {
  test(`routes ${prefix} to its own provider without changing request identity`, async () => {
    let calls = 0;
    const env = { [binding]: { async fetch(request) {
      calls++;
      assert.equal(new URL(request.url).pathname, '/accept');
      assert.equal(new URL(request.url).search, '?original=1');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('cf-connecting-ip'), '203.0.113.8');
      assert.equal(request.headers.get('origin'), 'https://www.shadowbuild.xyz');
      assert.equal(await request.text(), '{"requestId":"original"}');
      return new Response('held', { status: 503, headers: { 'retry-after': '7', 'access-control-allow-origin': 'https://www.shadowbuild.xyz' } });
    } } };
    const request = new Request(`https://api.shadowbuild.xyz:8443${prefix}/accept?original=1`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.8', origin: 'https://www.shadowbuild.xyz' }, body: '{"requestId":"original"}' });
    const response = await routeProviderRequest(request, env);
    assert.equal(calls, 1);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '7');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), 'held');
  });
}

test('unknown, legacy v1 and similarly named routes never reach a provider', async () => {
  for (const path of ['/v1/pay', '/admin', '/provider/arc-wallet-mainnet-settled-other/accept', '/provider/unknown/status']) {
    const response = await routeProviderRequest(new Request(`https://api.example${path}`), new Proxy({}, { get() { throw Error('unexpected binding access'); } }));
    assert.equal(response.status, 404);
  }
});

test('request bounds are enforced before binding access', async () => {
  const prefix = providerRoutes[0][0];
  const env = new Proxy({}, { get() { throw Error('unexpected binding access'); } });
  assert.equal((await routeProviderRequest(new Request(`https://api.example${prefix}/accept`, { method: 'POST', headers: { 'content-length': '65537' }, body: '{}' }), env)).status, 413);
  assert.equal((await routeProviderRequest(new Request(`https://api.example${prefix}/status?${'x'.repeat(2048)}`), env)).status, 414);
});

test('preflight headers pass to the maintained provider edge', async () => {
  const response = await routeProviderRequest(new Request(`https://api.example${providerRoutes[0][0]}/accept`, { method: 'OPTIONS', headers: { origin: 'https://www.shadowbuild.xyz', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }), {
    CURRENT_MAINNET: { async fetch(request) {
      assert.equal(request.method, 'OPTIONS');
      assert.equal(request.headers.get('access-control-request-method'), 'POST');
      assert.equal(request.headers.get('access-control-request-headers'), 'content-type');
      return new Response(null, { status: 204 });
    } },
  });
  assert.equal(response.status, 204);
});

test('binding failure is reported once and never retried', async () => {
  let calls = 0;
  const request = new Request(`https://api.example${providerRoutes[0][0]}/accept`, { method: 'POST', body: '{}' });
  const response = await routeProviderRequest(request, { CURRENT_MAINNET: { async fetch() { calls++; throw Error('internal detail'); } } });
  assert.equal(calls, 1);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /internal detail/);
  assert.equal((await routeProviderRequest(request, {})).status, 503);
});
