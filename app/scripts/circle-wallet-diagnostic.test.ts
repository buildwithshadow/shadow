import assert from "node:assert/strict";
import test from "node:test";
import { hashTypedData } from "viem";
import {
  assertDiagnosticContext, assertDiagnosticSignature, diagnosticDigest, diagnosticJson,
  DIAGNOSTIC_CHAIN_ID, DIAGNOSTIC_RP_ID, WALLET_DIAGNOSTIC,
} from "../src/walletDiagnosticPayload.ts";

test("refuses a changed RP, wrong chain, or undeployed account before signing", () => {
  assert.throws(() => assertDiagnosticContext("www.shadowbuild.xyz", DIAGNOSTIC_CHAIN_ID, "0x01"), /passkey domain/);
  assert.throws(() => assertDiagnosticContext(undefined, DIAGNOSTIC_CHAIN_ID, "0x01"), /passkey domain/);
  assert.throws(() => assertDiagnosticContext(DIAGNOSTIC_RP_ID, 1, "0x01"), /not Arc testnet/);
  assert.throws(() => assertDiagnosticContext(DIAGNOSTIC_RP_ID, DIAGNOSTIC_CHAIN_ID, "0x"), /no deployed code/);
  assert.doesNotThrow(() => assertDiagnosticContext(DIAGNOSTIC_RP_ID, DIAGNOSTIC_CHAIN_ID, "0x01"));
});

test("requires ERC1271 magic instead of treating any RPC return as success", () => {
  assert.throws(() => assertDiagnosticSignature("0xffffffff"), /did not verify/);
  assert.throws(() => assertDiagnosticSignature("0x"), /did not verify/);
  assert.doesNotThrow(() => assertDiagnosticSignature("0x1626ba7e"));
});

test("displayed payload has the exact digest signed and a separate non-purchase schema", () => {
  const displayed = JSON.parse(diagnosticJson);
  assert.equal(displayed.domain.name, "Shadow Wallet Diagnostic");
  assert.equal(displayed.primaryType, "WalletDiagnostic");
  assert.equal(displayed.message.expiresAt, "1");
  assert.equal(hashTypedData(displayed), diagnosticDigest);
  assert.notEqual(hashTypedData({ ...WALLET_DIAGNOSTIC, message: { ...WALLET_DIAGNOSTIC.message, purpose: "tampered" } }), diagnosticDigest);
});
