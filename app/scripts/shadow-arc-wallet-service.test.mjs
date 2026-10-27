import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createShadowArcWalletService, walletReportAddress } from '../../examples/float-mainnet-provider-server/shadow-arc-wallet-service.mjs';
const address = '0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF';
const requestId = `arc-wallet:${'a'.repeat(32)}:${address}`;
const hash = `0x${'b'.repeat(64)}`;
const block = { number: 100n, hash, timestamp: 1000n };
function client(overrides = {}) {
  return { getChainId: async () => 5042, getBlockNumber: async () => 120n,
    getBlock: async ({ blockNumber }) => { assert.equal(blockNumber, 100n); return { ...block }; },
    readContract: async args => { assert.equal(args.address, '0x3600000000000000000000000000000000000000');
      assert.equal(args.blockNumber, 100n); assert.deepEqual(args.args, [address]); return 10000001n; },
    getBalance: async args => { assert.equal(args.blockNumber, 100n); assert.equal(args.address, address); return 10000001000000000001n; },
    ...overrides };
}
const create = (a = {}, b = {}, extra = {}) => createShadowArcWalletService({ clients: [client(a), client(b)], now: () => 1010, ...extra });
test('report pins both balance representations to a confirmed common block and rechecks it', async () => {
  const result = await create({}, { getBlockNumber: async () => 125n }).prepare({ requestId });
  const report = JSON.parse(result.result);
  assert.equal(report.chainId, 5042); assert.equal(report.address, address);
  assert.deepEqual(report.block, { number: '100', hash, timestamp: '1000', minimumNewerBlocks: 20 });
  assert.equal(report.balance.usdc, '10.000001');
  assert.equal(report.balance.nativeUsdc, '10.000001000000000001');
  assert.match(report.scope, /do not add/);
  assert.equal(result.resultRef, `arc-wallet-report:5042:100:${address}`);
});
test('invalid jobs are refused without RPC calls and repeat reports can use distinct job ids', async () => {
  let reads = 0;
  const service = create({ getChainId: async () => { reads++; return 5042; } });
  for (const id of [null, 'latest', address, `arc-wallet:short:${address}`, `arc-wallet:${'a'.repeat(32)}:0x${'0'.repeat(40)}`,
    `${requestId}:suffix`, requestId.replace(/.$/, 'G')]) assert.equal(await service.prepare({ requestId: id }), null);
  assert.equal(reads, 0);
  assert.equal(walletReportAddress(requestId), walletReportAddress(requestId.replace('a'.repeat(32), 'c'.repeat(32))));
  await assert.rejects(service(), /prepared before acceptance/);
});
test('wrong network, stale/future blocks, disagreement and missing confirmations prevent acceptance', async () => {
  for (const [a, b, extra, message] of [
    [{}, { getChainId: async () => 5042002 }, {}, /network mismatch/],
    [{ getBlockNumber: async () => 19n }, {}, {}, /no confirmed block/],
    [{}, { getBlock: async () => ({ ...block, hash: `0x${'c'.repeat(64)}` }) }, {}, /blocks disagree/],
    [{}, {}, { now: () => 1301 }, /stale/], [{}, {}, { now: () => 999 }, /future/],
    [{}, { readContract: async () => 5n }, {}, /balances disagree/],
    [{ getBalance: async () => 0n }, { getBalance: async () => 0n }, {}, /do not reconcile/],
  ]) await assert.rejects(create(a, b, extra).prepare({ requestId }), message);
});
test('a block reorg during balance reads prevents freezing a report', async () => {
  const changing = () => { let calls = 0; return { getBlock: async () => ({ ...block, hash: ++calls === 1 ? hash : `0x${'c'.repeat(64)}` }) }; };
  await assert.rejects(create(changing(), changing()).prepare({ requestId }), /block changed/);
});
test('unsupported chain and shared client are refused; testnet is explicit', async () => {
  assert.throws(() => create({}, {}, { chainId: 1 }), /Arc mainnet or testnet/);
  const c = client(); assert.throws(() => createShadowArcWalletService({ clients: [c, c] }), /separate/);
  const service = create({ getChainId: async () => 5042002 }, { getChainId: async () => 5042002 }, { chainId: 5042002 });
  assert.equal(JSON.parse((await service.prepare({ requestId })).result).chainId, 5042002);
});

test('prepared report cannot receive a new acceptance after expiry or a canonical block change', async () => {
  let timestamp = 1010, orphaned = false;
  const overrides = { getBlock: async () => ({ ...block, hash: orphaned ? `0x${'c'.repeat(64)}` : hash }) };
  const service = create(overrides, overrides, { now: () => timestamp });
  const result = await service.prepare({ requestId });
  await service.validatePrepared({ requestId, ...result });
  timestamp = 1301;
  await assert.rejects(service.validatePrepared({ requestId, ...result }), /expired/);
  timestamp = 1010; orphaned = true;
  await assert.rejects(service.validatePrepared({ requestId, ...result }), /no longer canonical/);
  orphaned = false;
  await assert.rejects(service.validatePrepared({ requestId: `${requestId}:other`, ...result }), /identity/);
});

async function rpcFixture(t, { balanceFailures = 0, chainId = 5042 } = {}) {
  const calls = []; let balanceAttempts = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls.push({ method: request.method, at: Date.now() });
    let result, error;
    switch (request.method) {
      case 'eth_chainId': result = `0x${chainId.toString(16)}`; break;
      case 'eth_blockNumber': result = '0x78'; break;
      case 'eth_getBlockByNumber': result = { number: '0x64', hash, timestamp: '0x3e8', transactions: [] }; break;
      case 'eth_call':
        assert.equal(request.params[1], '0x64');
        if (++balanceAttempts <= balanceFailures) error = { code: -32005, message: 'rate limit exceeded' };
        else result = `0x${10000001n.toString(16).padStart(64, '0')}`;
        break;
      case 'eth_getBalance': assert.equal(request.params[1], '0x64'); result = `0x${10000001000000000001n.toString(16)}`; break;
      default: error = { code: -32601, message: 'unexpected fixture method' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, get balanceAttempts() { return balanceAttempts; } };
}

test('real report RPCs pace reads and recover from a quota rejection before freezing a report', async t => {
  const a = await rpcFixture(t, { balanceFailures: 1 }), b = await rpcFixture(t);
  const service = createShadowArcWalletService({ rpcUrls: [a.url, b.url], now: () => 1010 });
  const prepared = await service.prepare({ requestId });
  await service.validatePrepared({ requestId, ...prepared });
  assert.equal(a.balanceAttempts, 2); assert.equal(b.balanceAttempts, 1);
  const report = JSON.parse(prepared.result); assert.equal(report.checks.twoRpcBalancesMatch, true);
  for (const rpc of [a, b]) {
    const lastCall = rpc.calls.findLastIndex(call => call.method === 'eth_call');
    const native = rpc.calls.findIndex((call, index) => index > lastCall && call.method === 'eth_getBalance');
    assert(native > lastCall);
    assert(rpc.calls[native].at - rpc.calls[lastCall].at >= 250, 'balance reads must share the paced queue');
    assert(rpc.calls.every(call => !/send|sign/.test(call.method)));
  }
});

test('persistent quota failure is bounded and cannot produce a report', async t => {
  const a = await rpcFixture(t, { balanceFailures: 99 }), b = await rpcFixture(t);
  const service = createShadowArcWalletService({ rpcUrls: [a.url, b.url], now: () => 1010 });
  await assert.rejects(service.prepare({ requestId }), /rate limit/i);
  assert.equal(a.balanceAttempts, 3);
  assert.equal(a.calls.some(call => call.method === 'eth_getBalance'), false);
});

test('a report read endpoint on the wrong chain is refused without balance reads', async t => {
  const a = await rpcFixture(t), b = await rpcFixture(t, { chainId: 5042002 });
  const service = createShadowArcWalletService({ rpcUrls: [a.url, b.url], now: () => 1010 });
  await assert.rejects(service.prepare({ requestId }), /unexpected chain|network mismatch/);
  assert.equal(b.balanceAttempts, 0);
});

test('report RPC configuration rejects duplicate, insecure and credentialed endpoints', () => {
  for (const urls of [[], ['https://rpc.testnet.arc.io'], ['https://rpc.testnet.arc.io', 'https://rpc.testnet.arc.io/'],
    ['http://example.com', 'https://rpc.testnet.arc.io'], ['https://user:secret@example.com', 'https://rpc.testnet.arc.io'],
    ['https://example.com/#different', 'https://example.com/']]) {
    assert.throws(() => createShadowArcWalletService({ rpcUrls: urls }), /RPC/);
  }
});
