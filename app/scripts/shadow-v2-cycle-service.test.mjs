import assert from "node:assert/strict";
import { test } from "node:test";
import { createShadowV2CycleService } from "../../examples/float-mainnet-provider-server/shadow-v2-cycle-service.mjs";

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
  const receipt = (blockHash) => ({ status: "success", blockNumber: 1n, blockHash, logs: [] });
  const client = (blockHash) => ({
    getChainId: async () => 5042002,
    getTransactionReceipt: async () => receipt(blockHash),
  });
  const service = createShadowV2CycleService({ paymentTx, repaymentTx, clients: [client(`0x${"1".repeat(64)}`), client(`0x${"2".repeat(64)}`)] });
  await assert.rejects(service.prepare({ requestId: paymentTx }), /independent RPC receipts disagree/);
});

test("an RPC on a different chain stops the provider before acceptance", async () => {
  const wrong = { getChainId: async () => 1, getTransactionReceipt: async () => { throw new Error("should not read"); } };
  const service = createShadowV2CycleService({ paymentTx, repaymentTx, clients: [wrong, { ...wrong }] });
  await assert.rejects(service.prepare({ requestId: paymentTx }), /not Arc testnet/);
});
