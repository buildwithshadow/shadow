import assert from "node:assert/strict";
import { test } from "node:test";
import { TransactionNotFoundError } from "viem";
import { readExecutionTransaction } from "./float-mainnet-monitor-execution-transaction.mjs";

const hash = n => `0x${String(n).padStart(64, "0")}`;
const event = { blockNumber: 100n, blockHash: hash(1), transactionHash: hash(2), transactionIndex: 0 };
const tx = { hash: hash(2), blockNumber: 100n, blockHash: hash(1), transactionIndex: 0,
  from: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}`, input: "0x1234" };
const block = { number: 100n, hash: hash(1), transactions: [tx] };

test("missing historical hash index recovers the exact transaction from a full canonical block", async () => {
  let full;
  const actual = await readExecutionTransaction({
    getTransaction: async args => { assert.deepEqual(args, { hash: event.transactionHash }); throw new TransactionNotFoundError({ hash: event.transactionHash }); },
    getBlock: async args => { full = args; return block; },
  }, event);
  assert.deepEqual(full, { blockNumber: 100n, includeTransactions: true });
  assert.deepEqual(actual, tx);
});

test("ordinary indexed transactions retain canonical and event binding checks", async () => {
  const actual = await readExecutionTransaction({ getTransaction: async () => tx,
    getBlock: async args => { assert.equal(args.includeTransactions, false); return { ...block, transactions: [tx.hash] }; },
  }, event);
  assert.equal(actual, tx);
});

test("RPC failure is not mistaken for a pruned transaction index", async () => {
  await assert.rejects(readExecutionTransaction({ getTransaction: async () => { throw new Error("RPC timeout"); },
    getBlock: async () => assert.fail("must not hide the failure"),
  }, event), /RPC timeout/);
});

for (const [name, change] of [
  ["wrong block hash", b => b.hash = hash(3)],
  ["wrong block height", b => b.number = 101n],
  ["missing transaction", b => b.transactions = []],
  ["hash-only block", b => b.transactions = [tx.hash]],
  ["duplicate transaction", b => b.transactions.push(b.transactions[0])],
  ["wrong mined transaction block", b => b.transactions[0].blockHash = hash(3)],
  ["wrong transaction index", b => b.transactions[0].transactionIndex = 1],
  ["missing sender", b => delete b.transactions[0].from],
  ["missing calldata", b => delete b.transactions[0].input],
]) test(`pruned-index recovery rejects ${name}`, async () => {
  const changed = structuredClone(block); change(changed);
  await assert.rejects(readExecutionTransaction({ getTransaction: async () => null, getBlock: async () => changed }, event));
});

test("a log without a canonical block binding is rejected before any RPC call", async () => {
  await assert.rejects(readExecutionTransaction({}, { ...event, blockHash: null }), /block binding/);
});
