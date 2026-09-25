import assert from "node:assert/strict";
import { test } from "node:test";
import { hashTypedData } from "viem";
import { assertCircleIntentWindow, parseBoundedCircleIntent, signedCircleIntentJson, MAX_TEST_PRINCIPAL, TEST_PROVIDER } from "../src/walletPayableIntent.ts";
import { intentFile, structFromMessage, validateIntentFile } from "./float-mainnet-intent.mjs";
import { DIAGNOSTIC_WALLET } from "../src/walletDiagnosticPayload.ts";
import { CANDIDATE_SPEND_INTENT_TYPES } from "../src/walletCandidateProbePayload.ts";

const candidate = "0xFeDb5c8c29792d49947492F357f21dc8405F08fc";
const now = 1_790_300_000n;
const sponsor = "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8";
const domain = { name: "ShadowFloatMainnet", version: "1", chainId: "5042002", verifyingContract: candidate };
const message = {
  agent: DIAGNOSTIC_WALLET, sponsor,
  lineId: `0x${"11".repeat(32)}`, lineEpoch: "1", termsHash: `0x${"22".repeat(32)}`,
  provider: TEST_PROVIDER, endpointHash: `0x${"33".repeat(32)}`,
  principal: "50000", maximumTotalDebt: "50000", dueAt: String(now + 86_400n),
  nonce: "12345678901234567890", signatureExpiry: String(now + 900n), executor: sponsor,
};
const types = {
  EIP712Domain: [
    { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ],
  SpendIntent: CANDIDATE_SPEND_INTENT_TYPES.SpendIntent,
};

function fixture(change = () => {}) {
  const external = { domain: structuredClone(domain), types: structuredClone(types), primaryType: "SpendIntent", message: structuredClone(message) };
  change(external);
  return {
    kind: "ShadowFloatMainnet.SpendIntent", chainId: "5042002", verifyingContract: candidate,
    digest: hashTypedData(external), signature: null,
    typedData: { domain: structuredClone(external.domain), types: { SpendIntent: structuredClone(external.types.SpendIntent) }, primaryType: "SpendIntent", message: structuredClone(external.message) },
    externalSignerTypedData: JSON.stringify(external),
  };
}

test("accepts only a matching, bounded payable Circle wallet intent", () => {
  const parsed = parseBoundedCircleIntent(JSON.stringify(fixture()), candidate, now);
  assert.equal(parsed.principal, MAX_TEST_PRINCIPAL);
  assert.equal(parsed.typedData.message.agent.toLowerCase(), DIAGNOSTIC_WALLET.toLowerCase());
  assert.equal(parsed.digest, hashTypedData(parsed.typedData));
});

test("rejects a wrong recipient, chain, amount, or stale authorization", () => {
  assert.throws(() => parseBoundedCircleIntent(JSON.stringify(fixture(x => { x.message.provider = sponsor; })), candidate, now), /Provider is outside/);
  assert.throws(() => parseBoundedCircleIntent(JSON.stringify(fixture(x => { x.domain.chainId = "5042"; })), candidate, now), /Arc testnet/);
  assert.throws(() => parseBoundedCircleIntent(JSON.stringify(fixture(x => { x.message.principal = "50001"; x.message.maximumTotalDebt = "50001"; })), candidate, now), /outside this bounded test/);
  assert.throws(() => parseBoundedCircleIntent(JSON.stringify(fixture(x => { x.message.signatureExpiry = String(now - 1n); })), candidate, now), /outside this bounded test/);
});

test("rejects conflicting file fields or a pre-existing signature", () => {
  const mismatched = fixture();
  mismatched.typedData.message.provider = sponsor;
  assert.throws(() => parseBoundedCircleIntent(JSON.stringify(mismatched), candidate, now), /conflicting message fields/);
  const signed = fixture();
  signed.signature = "0xdeadbeef";
  assert.throws(() => parseBoundedCircleIntent(JSON.stringify(signed), candidate, now), /already contains a signature/);
});

test("downloaded signed intent is directly accepted by the executor parser", () => {
  const unsigned = JSON.stringify(intentFile({ chainId: 5042002n, verifyingContract: candidate, struct: structFromMessage(message) }));
  parseBoundedCircleIntent(unsigned, candidate, now);
  const signed = JSON.parse(signedCircleIntentJson(unsigned, "0x1234"));
  const accepted = validateIntentFile(signed, { chainId: 5042002n, address: candidate });
  assert.equal(accepted.digest, signed.digest);
  assert.equal(accepted.signature, "0x1234");
});

test("download canonicalizes equivalent display data for the executor", () => {
  const nonCanonical = structuredClone(intentFile({ chainId: 5042002n, verifyingContract: candidate, struct: structFromMessage(message) }));
  nonCanonical.typedData.types.ExtraType = [{ name: "unused", type: "uint256" }];
  nonCanonical.externalSignerTypedData = JSON.stringify(JSON.parse(nonCanonical.externalSignerTypedData), null, 2);
  const source = JSON.stringify(nonCanonical);
  parseBoundedCircleIntent(source, candidate, now);
  const signed = JSON.parse(signedCircleIntentJson(source, "0x1234"));
  const accepted = validateIntentFile(signed, { chainId: 5042002n, address: candidate });
  assert.equal(accepted.digest, signed.digest);
  assert.equal(signed.externalSignerTypedData, undefined);
  assert.deepEqual(Object.keys(signed.typedData.types), ["SpendIntent"]);
});

test("payable window stays valid until the signature expires", () => {
  const signedUntil = now + 900n;
  const minimumWindow = 3600n;
  assert.doesNotThrow(() => assertCircleIntentWindow({ signatureExpiry: signedUntil, dueAt: signedUntil + minimumWindow }, signedUntil, minimumWindow, now));
  assert.throws(() => assertCircleIntentWindow({ signatureExpiry: signedUntil, dueAt: signedUntil + minimumWindow }, signedUntil - 1n, minimumWindow, now), /full signature lifetime/);
  assert.throws(() => assertCircleIntentWindow({ signatureExpiry: signedUntil, dueAt: signedUntil + minimumWindow - 1n }, signedUntil, minimumWindow, now), /full signature lifetime/);
});

test("chain time rejects a long authorization despite a fast browser clock", () => {
  const longTtl = fixture(x => { x.message.signatureExpiry = String(now + 1_800n); });
  const source = JSON.stringify(longTtl);
  assert.doesNotThrow(() => parseBoundedCircleIntent(source, candidate, now + 700n));
  assert.throws(() => parseBoundedCircleIntent(source, candidate, now), /outside this bounded test/);
});

test("a slow browser clock cannot reject a valid intent before Arc time is read", () => {
  const source = JSON.stringify(fixture(x => { x.message.signatureExpiry = String(now + 900n); }));
  assert.doesNotThrow(() => parseBoundedCircleIntent(source, candidate, null));
  assert.doesNotThrow(() => parseBoundedCircleIntent(source, candidate, now));
  assert.throws(() => parseBoundedCircleIntent(source, candidate, now - 600n), /outside this bounded test/);
});

test("a signed intent must still have more than 60 seconds for handoff", () => {
  const source = JSON.stringify(fixture());
  assert.doesNotThrow(() => parseBoundedCircleIntent(source, candidate, now + 839n));
  assert.throws(() => parseBoundedCircleIntent(source, candidate, now + 840n), /outside this bounded test/);
});
