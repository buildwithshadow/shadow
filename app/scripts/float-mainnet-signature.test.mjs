import assert from "node:assert/strict";
import { test } from "node:test";
import { CallExecutionError, ExecutionRevertedError, HttpRequestError, keccak256, stringToBytes } from "viem";
import { account } from "./float-mainnet-e2e.mjs";
import { SECP256K1_HALF_ORDER, SignatureCheckUnavailable, checkSignature, eoaSignatureIssue } from "./float-mainnet-intent.mjs";

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

test("malformed EOA r and s values produce invalid verdicts, while valid recovery still works", async () => {
  const connected = { client: { getCode: async () => "0x" } };
  const scalar = (value) => value.toString(16).padStart(64, "0");
  const signatureOf = (r, s, v = "1b") => `0x${scalar(r)}${scalar(s)}${v}`;
  const order = SECP256K1_HALF_ORDER * 2n + 1n;
  for (const r of [0n, order]) {
    const signature = signatureOf(r, 1n);
    assert.equal(eoaSignatureIssue(signature), null, "this must reach local ECDSA recovery");
    const verdict = await checkSignature(connected, signer, digest, signature);
    assert.deepEqual([verdict.signerKind, verdict.valid], ["eoa", false]);
    assert.match(verdict.detail, /no key recovers from the signature/);
  }
  for (const signature of [signatureOf(1n, 0n), signatureOf(1n, SECP256K1_HALF_ORDER + 1n), signatureOf(1n, 1n, "00")]) {
    const verdict = await checkSignature(connected, signer, digest, signature);
    assert.deepEqual([verdict.signerKind, verdict.valid], ["eoa", false]);
    assert.match(verdict.detail, /low-s|v is 0/);
  }
  const signature = await account(7).sign({ hash: digest });
  assert.equal((await checkSignature(connected, signer, digest, signature)).valid, true);
  assert.equal((await checkSignature(connected, account(8).address, digest, signature)).valid, false);
});
