import assert from "node:assert/strict";
import { test } from "node:test";
import { hashTypedData, zeroAddress, zeroHash } from "viem";
import { SPEND_INTENT_TYPES } from "./float-mainnet-config.mjs";
import { intentDigest } from "./float-mainnet-intent.mjs";
import { candidateProbe, CANDIDATE_SPEND_INTENT_TYPES } from "../src/walletCandidateProbePayload.ts";

const candidate = "0x1234567890123456789012345678901234567890";

test("the displayed no-spend probe has the exact candidate schema and digest", () => {
  const probe = candidateProbe(candidate);
  const displayed = JSON.parse(probe.json);
  assert.deepEqual(CANDIDATE_SPEND_INTENT_TYPES, SPEND_INTENT_TYPES);
  assert.equal(displayed.domain.name, "ShadowFloatMainnet");
  assert.equal(displayed.domain.version, "1");
  assert.equal(displayed.domain.chainId, 5_042_002);
  assert.equal(displayed.domain.verifyingContract, candidate);
  assert.equal(hashTypedData(displayed), probe.digest);
  assert.equal(intentDigest(5_042_002, candidate, probe.typedData.message), probe.digest);
  assert.equal(displayed.message.agent.toLowerCase(), "0x6994ebdef63aa0e665e3c781ed54e2e181869a7a");
  assert.equal(displayed.message.sponsor, zeroAddress);
  assert.equal(displayed.message.provider, zeroAddress);
  assert.equal(displayed.message.lineId, zeroHash);
  assert.equal(displayed.message.principal, "0");
  assert.equal(displayed.message.signatureExpiry, "1");
  assert.equal(displayed.message.dueAt, "1");
});

test("the candidate probe refuses malformed contract addresses", () => {
  assert.throws(() => candidateProbe("0xnot-a-contract"), /candidate contract address is invalid/);
});
