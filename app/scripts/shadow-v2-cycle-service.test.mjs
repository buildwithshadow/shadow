import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoInterveningDebtChange, createShadowV2CycleService, verifyCanonicalBlocks } from "../../examples/float-mainnet-provider-server/shadow-v2-cycle-service.mjs";

const paymentTx = `0x${"a".repeat(64)}`;
const repaymentTx = `0x${"b".repeat(64)}`;

test("a request for another cycle is refused without reading either RPC", async () => {
  let calls = 0;
  const client = { getChainId: async () => { calls++; return 5042002; } };
  const service = createShadowV2CycleService({ paymentTx, repaymentTx, clients: [client, { ...client }] });
  assert.equal(await service.prepare({ requestId: repaymentTx }), null);
  assert.equal(calls, 0);
});

test("conflicting RPC receipts stop the provider before acceptance", async () => {
  const receipt = (blockHash) => ({ transactionHash: paymentTx, status: "success", blockNumber: 1n, blockHash, logs: [] });
  const client = (blockHash) => ({
    getChainId: async () => 5042002,
    getTransactionReceipt: async () => receipt(blockHash),
  });
  const service = createShadowV2CycleService({ paymentTx, repaymentTx, clients: [client(`0x${"1".repeat(64)}`), client(`0x${"2".repeat(64)}`)] });
  await assert.rejects(service.prepare({ requestId: paymentTx }), /independent RPC receipts disagree/);
});

test("a different transaction identity cannot pass as two-RPC agreement", async () => {
  const client = (hash) => ({
    getChainId: async () => 5042002,
    getTransactionReceipt: async () => ({ transactionHash: hash, status: "success", blockNumber: 1n,
      blockHash: `0x${"1".repeat(64)}`, logs: [] }),
  });
  const service = createShadowV2CycleService({ paymentTx, repaymentTx, clients: [client(paymentTx), client(repaymentTx)] });
  await assert.rejects(service.prepare({ requestId: paymentTx }), /independent RPC receipts disagree/);
});

test("an RPC on a different chain stops the provider before acceptance", async () => {
  const wrong = { getChainId: async () => 1, getTransactionReceipt: async () => { throw new Error("should not read"); } };
  const service = createShadowV2CycleService({ paymentTx, repaymentTx, clients: [wrong, { ...wrong }] });
  await assert.rejects(service.prepare({ requestId: paymentTx }), /not Arc testnet/);
});

test("the report cannot freeze a shallow or orphaned receipt", async () => {
  const blockHash = `0x${"1".repeat(64)}`;
  const receipt = { blockNumber: 100n, blockHash };
  const client = (head, hash) => ({ getBlockNumber: async () => head, getBlock: async () => ({ hash }) });
  await assert.rejects(verifyCanonicalBlocks([client(119n, blockHash), client(120n, blockHash)], [receipt]), /fewer than 20 confirmations/);
  await assert.rejects(verifyCanonicalBlocks([client(120n, blockHash), client(120n, `0x${"2".repeat(64)}`)], [receipt]), /no longer canonical/);
  await assert.doesNotReject(verifyCanonicalBlocks([client(120n, blockHash), client(121n, blockHash)], [receipt]));
});

test("a same-sized intervening debt cycle cannot be represented as one restored debt", () => {
  const report = { agent: `0x${"1".repeat(40)}`, payment: { tx: paymentTx, debtOpenedReceiptHash: `0x${"c".repeat(64)}` },
    repayment: { tx: repaymentTx, receiptHash: `0x${"d".repeat(64)}` } };
  const log = (transactionHash, receiptHash, receiptType, debtBefore, debtAfter) => ({
    transactionHash, receiptHash, receiptType, agent: report.agent, debtBefore, debtAfter,
    creditBefore: debtAfter, creditAfter: debtBefore, logIndex: 1, removed: false,
  });
  const start = log(paymentTx, report.payment.debtOpenedReceiptHash, 5, "0", "1000");
  const end = log(repaymentTx, report.repayment.receiptHash, 6, "1000", "0");
  assert.doesNotThrow(() => assertNoInterveningDebtChange([start, end], report));
  const earlierRepayment = log(`0x${"e".repeat(64)}`, `0x${"f".repeat(64)}`, 6, "1000", "0");
  const laterPayment = log(`0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`, 5, "0", "1000");
  assert.throws(() => assertNoInterveningDebtChange([start, earlierRepayment, laterPayment, end], report), /intervened/);
});
