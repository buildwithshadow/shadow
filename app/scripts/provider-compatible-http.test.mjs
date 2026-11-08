import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createCompatibleProviderHttpServer } from '../../examples/float-mainnet-provider-server/compatible-http.mjs';

async function send(headers) {
  let dispatched = 0;
  const server = createCompatibleProviderHttpServer({ maxHeaderSize: 256 }, (_req, res) => { dispatched++; res.end('provider'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const reply = await new Promise((resolve, reject) => {
      const req = request(`http://127.0.0.1:${server.address().port}`, { headers, agent: false }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', text => { body += text; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject); req.end();
    });
    return { reply, dispatched };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
test('compatible HTTP factory keeps the original aggregate header bound before dispatch', async () => {
  const accepted = await send({ 'x-small': 'allowed' });
  assert.equal(accepted.reply.status, 200); assert.equal(accepted.dispatched, 1);
  for (const headers of [{ 'x-large': 'x'.repeat(300) }, { 'x-one': 'a'.repeat(130), 'x-two': 'b'.repeat(130) }]) {
    const rejected = await send(headers);
    assert.equal(rejected.reply.status, 431); assert.equal(rejected.dispatched, 0);
    assert.equal(rejected.reply.headers['cache-control'], 'no-store');
    assert.doesNotMatch(rejected.reply.body, /aaaa|bbbb|xxxx/);
  }
});
test('compatible HTTP factory refuses a missing header limit', () => {
  assert.throws(() => createCompatibleProviderHttpServer({}, () => {}), /header bound/);
});
test('compatible HTTP factory releases request capacity once after disconnect', async () => {
  let firstResponse, firstArrived;
  const arrived = new Promise(resolve => { firstArrived = resolve; });
  const server = createCompatibleProviderHttpServer({ maxHeaderSize: 512 }, (req, res) => {
    if (req.url === '/hold') { firstResponse = res; firstArrived(); return; }
    res.end('provider');
  }, 1);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const first = request(`${url}/hold`, { agent: false }); first.on('error', () => {}); first.end();
  try {
    await arrived;
    const busy = await fetch(`${url}/other`);
    assert.equal(busy.status, 429); await busy.text();
    const released = new Promise(resolve => firstResponse.once('close', resolve));
    first.destroy(); await released;
    const available = await fetch(`${url}/other`);
    assert.equal(available.status, 200); assert.equal(await available.text(), 'provider');
    const again = await fetch(`${url}/other`);
    assert.equal(again.status, 200); await again.text();
  } finally { first.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
