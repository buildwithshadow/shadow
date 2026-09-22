import assert from "node:assert/strict";
import { test } from "node:test";
import { CallExecutionError, ExecutionRevertedError, HttpRequestError, keccak256, stringToBytes } from "viem";
import { account } from "./float-mainnet-e2e.mjs";
import { SignatureCheckUnavailable, checkSignature } from "./float-mainnet-intent.mjs";

const signer = account(7).address;
const digest = keccak256(stringToBytes("signature transport regression"));
const connection = (call) => ({ address: account(0).address, client: { getCode: async () => "0x6000", call } });
const wrapped = (cause) => new CallExecutionError(cause, { to: signer });

test("an ERC-1271 RPC failure is unavailable, not an invalid agent signature", async () => {
  const transport = new HttpRequestError({ url: "http://rpc.invalid", status: 503 });
  const gasBudget = new ExecutionRevertedError({ message: "gas required exceeds allowance (0)" });
  for (const failure of [transport, wrapped(transport), new Error("RPC connection reset"), new Error("execution reverted: untrusted transport text"), gasBudget, wrapped(gasBudget)]) {
    await assert.rejects(checkSignature(connection(async () => { throw failure; }), signer, digest, "0x1234"), (error) => {
      assert.ok(error instanceof SignatureCheckUnavailable);
      assert.equal(error.cause, failure);
      return true;
    });
  }
});

test("a failed account-code lookup cannot become a permanent signature refusal", async () => {
  const failure = new Error("RPC unavailable during eth_getCode");
  const connected = { client: { getCode: async () => { throw failure; } } };
  await assert.rejects(checkSignature(connected, signer, digest, "0x1234"), (error) => {
    assert.ok(error instanceof SignatureCheckUnavailable);
    assert.equal(error.cause, failure);
    return true;
  });
});

test("a confirmed ERC-1271 execution revert remains an invalid agent signature", async () => {
  const reverted = new ExecutionRevertedError({ message: "execution reverted: signature rejected" });
  for (const failure of [reverted, wrapped(reverted)]) {
    const verdict = await checkSignature(connection(async () => { throw failure; }), signer, digest, "0x1234");
    assert.equal(verdict.valid, false);
    assert.match(verdict.detail, /isValidSignature reverted/);
  }
});

test("an ERC-1271 reply still requires the exact magic word", async () => {
  const accepted = `0x1626ba7e${"0".repeat(56)}`;
  for (const data of [accepted, "0xffffffff", "0x"]) {
    const verdict = await checkSignature(connection(async () => ({ data })), signer, digest, "0x1234");
    assert.equal(verdict.valid, data === accepted);
  }
});
