import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  LEPTON_M1_DEPLOYMENTS,
  LEPTON_WRITE_REASON,
  classifyLeptonV4Readiness,
  readHistoricalProofInput,
  readWithCanonicalFallback,
  runLeptonWalletAction,
  transactionInputContainsAddress,
} from "../leptonM1Config.js";

const current = LEPTON_M1_DEPLOYMENTS.currentRead;

function readyInput(overrides = {}) {
  return {
    readConfigured: true,
    rpcOk: true,
    adapterHasCode: true,
    sinkHasCode: true,
    adapterBondUSDC: 10_000_000n,
    minBondUSDC: 10_000_000n,
    generationWriteAllowlisted: true,
    generationSourceVerified: true,
    actualEnforcer: current.bondedEnforcer,
    expectedEnforcer: current.bondedEnforcer,
    actualSink: current.v4StyleSink,
    expectedSink: current.v4StyleSink,
    sinkAdapter: current.v4StyleAdapter,
    expectedAdapter: current.v4StyleAdapter,
    sinkRecoverable: true,
    ...overrides,
  };
}

test("zero and sub-minimum bonds disable V4 writes", () => {
  const zero = classifyLeptonV4Readiness(readyInput({ adapterBondUSDC: 0n }));
  const low = classifyLeptonV4Readiness(readyInput({ adapterBondUSDC: 9_999_999n }));
  assert.equal(zero.writeReady, false);
  assert.ok(zero.reasonCodes.includes(LEPTON_WRITE_REASON.BOND_ZERO));
  assert.equal(low.writeReady, false);
  assert.ok(low.reasonCodes.includes(LEPTON_WRITE_REASON.BOND_BELOW_MINIMUM));
});

test("RPC failure disables V4 writes", () => {
  const result = classifyLeptonV4Readiness(readyInput({ rpcOk: false }));
  assert.equal(result.writeReady, false);
  assert.ok(result.reasonCodes.includes(LEPTON_WRITE_REASON.RPC_READ_FAILED));
});

test("sufficient bond cannot make an unverified or nonrecoverable generation write-ready", () => {
  const result = classifyLeptonV4Readiness(
    readyInput({
      generationWriteAllowlisted: false,
      generationSourceVerified: false,
      sinkRecoverable: false,
    }),
  );
  assert.equal(result.writeReady, false);
  assert.deepEqual(result.reasonCodes, [
    LEPTON_WRITE_REASON.GENERATION_NOT_ALLOWLISTED,
    LEPTON_WRITE_REASON.SOURCE_NOT_VERIFIED,
    LEPTON_WRITE_REASON.SINK_NOT_RECOVERABLE,
  ]);
});

test("wrong enforcer or sink binding disables V4 writes", () => {
  const wrongEnforcer = classifyLeptonV4Readiness(
    readyInput({ actualEnforcer: "0x0000000000000000000000000000000000000001" }),
  );
  const wrongSink = classifyLeptonV4Readiness(
    readyInput({ sinkAdapter: "0x0000000000000000000000000000000000000002" }),
  );
  assert.ok(wrongEnforcer.reasonCodes.includes(LEPTON_WRITE_REASON.WRONG_ENFORCER));
  assert.ok(wrongSink.reasonCodes.includes(LEPTON_WRITE_REASON.WRONG_SINK_BINDING));
});

test("disabled readiness produces zero wallet, bundler, or transaction calls", async () => {
  const calls = { wallet: 0, bundler: 0, transaction: 0 };
  const disabled = classifyLeptonV4Readiness(readyInput({ adapterBondUSDC: 0n }));
  await assert.rejects(
    runLeptonWalletAction(disabled, async () => {
      calls.wallet += 1;
      calls.bundler += 1;
      calls.transaction += 1;
    }),
    /No wallet request will be made/,
  );
  assert.deepEqual(calls, { wallet: 0, bundler: 0, transaction: 0 });
});

test("the Lepton handler gates the complete wallet path and does not gate unrelated follower onboarding", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const leptonHandler = source.slice(
    source.indexOf("async function onSponsoredLeptonMandate"),
    source.indexOf("async function onTunePolicy"),
  );
  const followHandler = source.slice(
    source.indexOf("async function onSponsoredFollow"),
    source.indexOf("async function onSponsoredLeptonMandate"),
  );
  assert.ok(leptonHandler.indexOf("runLeptonWalletAction") < leptonHandler.indexOf("loadCredential"));
  assert.ok(leptonHandler.indexOf("runLeptonWalletAction") < leptonHandler.indexOf("sendUserOperation"));
  assert.equal(followHandler.includes("runLeptonWalletAction"), false);
});

test("historical passkey proof and current read deployment remain separate", () => {
  const historical = LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey;
  assert.equal(historical.txHash.startsWith("0x98b8"), true);
  assert.equal(historical.v4StyleAdapter.toLowerCase().startsWith("0x16eb"), true);
  assert.notEqual(historical.v4StyleAdapter.toLowerCase(), current.v4StyleAdapter.toLowerCase());
  assert.equal(LEPTON_M1_DEPLOYMENTS.historicalProofs.morphoStyle.label, "Morpho-style testnet proof");
  assert.equal(LEPTON_M1_DEPLOYMENTS.historicalProofs.morphoStyle.adapter.toLowerCase(), current.morphoStyleAdapter.toLowerCase());
  assert.deepEqual(current.expectedWriteBlockers, [
    LEPTON_WRITE_REASON.BOND_ZERO,
    LEPTON_WRITE_REASON.GENERATION_NOT_ALLOWLISTED,
    LEPTON_WRITE_REASON.SOURCE_NOT_VERIFIED,
    LEPTON_WRITE_REASON.SINK_NOT_RECOVERABLE,
  ]);
});

test("proof input verification fails when the declared generation adapter is absent", () => {
  const historical = LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey;
  const encodedAddress = historical.v4StyleAdapter.slice(2).padStart(64, "0");
  const input = `0x12345678${encodedAddress}`;
  assert.equal(transactionInputContainsAddress(input, historical.v4StyleAdapter), true);
  assert.equal(transactionInputContainsAddress(input, current.v4StyleAdapter), false);
});

test("historical proof read falls back from configured RPC to canonical RPC", async () => {
  let fallbackCalls = 0;
  const value = await readWithCanonicalFallback(
    async () => {
      throw new Error("configured RPC pruned the transaction");
    },
    async () => {
      fallbackCalls += 1;
      return { hash: LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash };
    },
  );

  assert.equal(value.hash, LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash);
  assert.equal(fallbackCalls, 1);
});

test("historical proof read does not call canonical RPC when configured RPC succeeds", async () => {
  let fallbackCalls = 0;
  const value = await readWithCanonicalFallback(
    async () => ({ hash: LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash }),
    async () => {
      fallbackCalls += 1;
      throw new Error("canonical RPC should not be called");
    },
  );

  assert.equal(value.hash, LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash);
  assert.equal(fallbackCalls, 0);
});

test("historical proof read remains fail closed when both RPCs fail", async () => {
  await assert.rejects(
    readWithCanonicalFallback(
      async () => {
        throw new Error("configured RPC failed");
      },
      async () => {
        throw new Error("canonical RPC failed");
      },
    ),
    /failed on both the configured and canonical RPC/,
  );
});

test("historical proof input prefers the RPC and never reaches a later source", async () => {
  const touched = [];
  const result = await readHistoricalProofInput({
    byHash: () => {
      touched.push("byHash");
      return "0xabc0";
    },
    byBlock: () => {
      touched.push("byBlock");
      return "0xdead";
    },
    byExplorer: () => {
      touched.push("byExplorer");
      return "0xbeef";
    },
  });
  assert.deepEqual(result, { input: "0xabc0", source: "RPC" });
  assert.deepEqual(touched, ["byHash"]);
});

test("historical proof input falls through a pruned tx index to the pinned block", async () => {
  let explorerCalls = 0;
  const result = await readHistoricalProofInput({
    byHash: async () => {
      throw new Error("Transaction with hash could not be found.");
    },
    byBlock: async () => "0x765e827f",
    byExplorer: async () => {
      explorerCalls += 1;
      return "0xshouldnotbeused";
    },
  });
  assert.equal(result.input, "0x765e827f");
  assert.equal(result.source, "pinned block");
  assert.equal(explorerCalls, 0, "the explorer must stay untouched once the chain answered");
});

test("historical proof input reaches the Arcscan index only when every chain read fails", async () => {
  const result = await readHistoricalProofInput({
    byHash: async () => {
      throw new Error("pruned");
    },
    byBlock: async () => undefined,
    byExplorer: async () => "0x765e827f",
  });
  assert.deepEqual(result, { input: "0x765e827f", source: "Arcscan index" });
});

test("historical proof input reads the canonical pinned block before the explorer", async () => {
  const touched = [];
  const fail = (name) => async () => {
    touched.push(name);
    throw new Error("configured RPC unavailable or transaction hash pruned");
  };
  const result = await readHistoricalProofInput({
    byHash: fail("configured hash"),
    byCanonicalHash: fail("canonical hash"),
    byBlock: fail("configured block"),
    byCanonicalBlock: async () => {
      touched.push("canonical block");
      return "0x765e827f";
    },
    byExplorer: async () => {
      throw new Error("explorer must not be called");
    },
  });
  assert.deepEqual(result, { input: "0x765e827f", source: "canonical pinned block" });
  assert.deepEqual(touched, ["configured hash", "canonical hash", "configured block", "canonical block"]);
});

test("a canonical block without the transaction does not suppress the explorer fallback", async () => {
  const result = await readHistoricalProofInput({
    byCanonicalBlock: async () => undefined,
    byExplorer: async () => "0x765e827f",
  });
  assert.deepEqual(result, { input: "0x765e827f", source: "Arcscan index" });
});

test("an empty block response cannot win before its peer returns usable calldata", async () => {
  let explorerCalls = 0;
  const result = await readHistoricalProofInput({
    byBlock: async () => "0x",
    byCanonicalBlock: async () => { await delay(10); return "0x765e827f"; },
    byExplorer: async () => { explorerCalls += 1; return "0xbeef"; },
  });
  assert.deepEqual(result, { input: "0x765e827f", source: "canonical pinned block" });
  assert.equal(explorerCalls, 0);
});

test("slow unavailable proof sources share one deadline and cannot start later fallbacks", async () => {
  const touched = [];
  const started = Date.now();
  const result = await readHistoricalProofInput({
    byHash: async () => {
      touched.push("configured hash");
      await delay(20);
      throw new Error("configured RPC unavailable");
    },
    byCanonicalHash: async () => {
      touched.push("canonical hash");
      return new Promise(() => {});
    },
    byBlock: async () => { touched.push("configured block"); return "0xbeef"; },
    byCanonicalBlock: async () => { touched.push("canonical block"); return "0xbeef"; },
    byExplorer: async () => { touched.push("explorer"); return "0xbeef"; },
  }, { deadlineAt: started + 80 });
  assert.equal(result.input, null);
  assert.match(result.source, /historical proof deadline exceeded/);
  assert.deepEqual(touched, ["configured hash", "canonical hash"]);
  assert.ok(Date.now() - started < 500);
});

test("a proof scan with an exhausted parent budget never starts a source", async () => {
  let calls = 0;
  const result = await readHistoricalProofInput({
    byHash: async () => { calls += 1; return "0xbeef"; },
    byExplorer: async () => { calls += 1; return "0xbeef"; },
  }, { deadlineAt: Date.now() - 1 });
  assert.equal(calls, 0);
  assert.equal(result.input, null);
  assert.match(result.source, /deadline exceeded/);
});

test("historical proof input degrades to unusable calldata instead of throwing when every source fails", async () => {
  const result = await readHistoricalProofInput({
    byHash: async () => {
      throw new Error("pruned");
    },
    byBlock: async () => {
      throw new Error("block read failed");
    },
    byExplorer: async () => {
      throw new Error("HTTP 429");
    },
  });
  assert.equal(result.input, null);
  assert.match(result.source, /RPC: pruned/);
  assert.match(result.source, /pinned block: block read failed/);
  assert.match(result.source, /Arcscan index: HTTP 429/);
  const historical = LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey;
  assert.equal(
    transactionInputContainsAddress(result.input, historical.v4StyleAdapter),
    false,
    "absent calldata must never satisfy the containment check",
  );
});

test("the historical passkey proof pins the block its calldata is read from", () => {
  assert.equal(LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.blockNumber, 47710773n);
});
