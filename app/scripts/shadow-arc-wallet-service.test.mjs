import assert from 'node:assert/strict';
import { test } from 'node:test';
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
