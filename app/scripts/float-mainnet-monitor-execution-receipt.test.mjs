import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactionReceiptNotFoundError } from 'viem';
import { readExecutionReceipt } from './float-mainnet-monitor-execution-receipt.mjs';

const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const event = { blockNumber: 100n, blockHash: hash(1), transactionHash: hash(2), transactionIndex: 1 };
  const receipt = { status: 'success', blockNumber: event.blockNumber, blockHash: event.blockHash,
    transactionHash: event.transactionHash, transactionIndex: 1,
    logs: [{ ...event, removed: false, logIndex: 3 }] };
  const receipts = [{ transactionHash: hash(3), transactionIndex: 0 }, receipt];
  const block = { number: 100n, hash: hash(1), transactions: [hash(3), hash(2)] };
  const reads = [];
  const client = {
    getTransactionReceipt: async r => { reads.push(['hash', r]); throw new TransactionReceiptNotFoundError({ hash: r.hash }); },
    getBlock: async r => { reads.push(['block', r]); return block; },
    getBlockReceipts: async r => { reads.push(['receipts', r]); return receipts; },
  };
  return { event, receipt, receipts, block, reads, client, run: () => readExecutionReceipt(client, event) };
}

test('pruned hash lookup recovers only the exact receipt from its canonical block slot', async () => {
  const f = fixture(); assert.equal(await f.run(), f.receipt);
  assert.deepEqual(f.reads, [['hash', { hash: f.event.transactionHash }], ['block', { blockNumber: 100n }],
    ['receipts', { blockNumber: 100n }], ['block', { blockNumber: 100n }]]);
});

test('ordinary receipt lookup retains the existing caller validation path', async () => {
  const f = fixture(); f.client.getTransactionReceipt = async () => f.receipt;
  assert.equal(await f.run(), f.receipt); assert.deepEqual(f.reads, []);
});

test('timeouts, quotas and RPC faults do not trigger a history fallback', async () => {
  for (const message of ['RPC timeout', 'rate limit exceeded', 'invalid parameters']) {
    const f = fixture(); f.client.getTransactionReceipt = async () => { throw Error(message); };
    await assert.rejects(f.run(), new RegExp(message)); assert.deepEqual(f.reads, []);
  }
});

for (const [name, change] of [
  ['wrong canonical block hash', f => f.block.hash = hash(4)],
  ['wrong canonical block height', f => f.block.number = 101n],
  ['wrong block transaction slot', f => f.block.transactions.reverse()],
  ['missing block transaction hashes', f => delete f.block.transactions],
  ['unavailable block receipts', f => f.client.getBlockReceipts = async () => null],
  ['missing receipt', f => f.receipts.pop()],
  ['duplicate receipt hash', f => f.receipts.push(f.receipt)],
  ['duplicate receipt index', f => f.receipts[0].transactionIndex = 1],
  ['wrong receipt array slot', f => f.receipts.reverse()],
  ['reverted receipt', f => f.receipt.status = 'reverted'],
  ['wrong receipt block hash', f => f.receipt.blockHash = hash(4)],
  ['wrong receipt block number', f => f.receipt.blockNumber = 101n],
  ['wrong receipt transaction index', f => f.receipt.transactionIndex = 2],
  ['missing receipt logs', f => delete f.receipt.logs],
  ['wrong log block hash', f => f.receipt.logs[0].blockHash = hash(4)],
  ['wrong log block number', f => f.receipt.logs[0].blockNumber = 101n],
  ['wrong log transaction hash', f => f.receipt.logs[0].transactionHash = hash(4)],
  ['wrong log transaction index', f => f.receipt.logs[0].transactionIndex = 2],
  ['removed receipt log', f => f.receipt.logs[0].removed = true],
]) test(`block receipt recovery rejects ${name}`, async () => {
  const f = fixture(); change(f); await assert.rejects(f.run());
});

test('a canonical block change during receipt retrieval is rejected', async () => {
  const f = fixture(); let calls = 0;
  f.client.getBlock = async () => ++calls === 1 ? f.block : { ...f.block, hash: hash(4) };
  await assert.rejects(f.run(), /changed during recovery/);
});

test('unsupported block receipt RPC remains a failure', async () => {
  const f = fixture(); f.client.getBlockReceipts = async () => { throw Error('method not supported'); };
  await assert.rejects(f.run(), /method not supported/);
});

test('unmined or malformed event binding is rejected before any request', async () => {
  for (const event of [{}, { ...fixture().event, blockNumber: -1n }, { ...fixture().event, transactionIndex: -1 }]) {
    await assert.rejects(readExecutionReceipt({}, event), /mined block binding/);
  }
});
