/**
 * artifacts/approved-history.test.mjs
 *
 * Node.js built-in test suite for approved-history.mjs.
 * Run with:  node --test artifacts/approved-history.test.mjs
 *
 * No external dependencies.  All tests are self-contained.
 */

import { createHash }        from "node:crypto";
import { describe, it }      from "node:test";
import assert                from "node:assert/strict";

import {
  FILE_KIND,
  FILE_SCHEMA,
  MAX_BYTES,
  MAX_TOPICS,
  ApprovedHistoryError,
  buildNormalizedContent,
  hashBytes,
  validateApprovedBytes,
  verifyAndMerge,
} from "./float-mainnet-history-validation.mjs";

// node:assert/strict `assert.rejects` returns undefined, not the error.
// Use these helpers to capture the thrown error for code inspection.
function throwsSync(fn) {
  try { fn(); }
  catch (e) { return e; }
  throw new Error("Expected function to throw but it did not");
}
async function rejectsAsync(fn) {
  try { await fn(); }
  catch (e) { return e; }
  throw new Error("Expected async function to reject but it resolved");
}

// ── shared fixtures ────────────────────────────────────────────────────────────

const CONTRACT = "0xabcdef1234567890abcdef1234567890abcdef12";
const OTHER    = "0x1111111111111111111111111111111111111111";
const HASH_A   = "0x" + "aa".repeat(32);
const HASH_B   = "0x" + "bb".repeat(32);
const HASH_C   = "0x" + "cc".repeat(32);
const TX_1     = "0x" + "11".repeat(32);
const TX_2     = "0x" + "22".repeat(32);
const TOPIC_1  = "0x" + "11".repeat(32);

const IDENTITY = {
  address:         CONTRACT,
  chainId:         "1",
  deployBlock:     "100",
  manifestHash:    HASH_A,
  runtimeCodeHash: HASH_B,
};

const ANCHOR = { blockNumber: "200", blockHash: HASH_C };

function makeLog(overrides = {}) {
  return {
    address:          CONTRACT,
    blockNumber:      "150",
    blockHash:        "0x" + "15".repeat(32),
    transactionHash:  TX_1,
    transactionIndex: 0,
    logIndex:         0,
    data:             "0x",
    topics:           [TOPIC_1],
    removed:          false,
    ...overrides,
  };
}

// Build a valid prefix and return { bytes, approvedDigest, parsed }
function buildValid(logs = [], anchor = ANCHOR, identity = IDENTITY) {
  const { bytes, parsed } = buildNormalizedContent(logs, identity, anchor);
  const approvedDigest = hashBytes(bytes);
  return { bytes, approvedDigest, parsed };
}

// ── hashBytes ─────────────────────────────────────────────────────────────────

describe("hashBytes", () => {
  it("returns lowercase 64-char hex", () => {
    const h = hashBytes(Buffer.from("hello"));
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("accepts Uint8Array", () => {
    const h = hashBytes(new Uint8Array([1, 2, 3]));
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const b = Buffer.from("test");
    assert.equal(hashBytes(b), hashBytes(b));
  });

  it("throws on non-buffer", () => {
    const e = throwsSync(() => hashBytes("string"));
    assert(e instanceof ApprovedHistoryError);
  });

  it("matches node crypto independently", () => {
    const b = Buffer.from("shadow monitor");
    const expected = createHash("sha256").update(b).digest("hex");
    assert.equal(hashBytes(b), expected);
  });
});

// ── buildNormalizedContent ────────────────────────────────────────────────────

describe("buildNormalizedContent", () => {
  it("builds a valid file with no logs", () => {
    const { bytes, parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    assert.equal(parsed.kind, FILE_KIND);
    assert.equal(parsed.schemaVersion, FILE_SCHEMA);
    assert.equal(parsed.logs.length, 0);
    assert(Buffer.isBuffer(bytes));
    assert(bytes.length > 0);
  });

  it("builds a valid file with one log", () => {
    const { parsed } = buildNormalizedContent([makeLog()], IDENTITY, ANCHOR);
    assert.equal(parsed.logs.length, 1);
    assert.equal(parsed.logs[0].removed, false);
  });

  it("rejects log with wrong address", () => {
    const e = throwsSync(() => buildNormalizedContent([makeLog({ address: OTHER })], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ADDRESS_MISMATCH");
  });

  it("rejects log with removed:true", () => {
    const e = throwsSync(() => buildNormalizedContent([makeLog({ removed: true })], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
  });

  it("rejects log outside [deployBlock, anchorBlock]", () => {
    const e = throwsSync(() => buildNormalizedContent([makeLog({ blockNumber: "50" })], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "OUT_OF_RANGE");
  });

  it("rejects log after anchorBlock", () => {
    const e = throwsSync(() => buildNormalizedContent([makeLog({ blockNumber: "300" })], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "OUT_OF_RANGE");
  });

  it("rejects duplicate (blockNumber, logIndex)", () => {
    const log = makeLog();
    const e = throwsSync(() => buildNormalizedContent([log, log], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "DUPLICATE_POSITION");
  });

  it("rejects out-of-order logs (blockNumber descending)", () => {
    const a = makeLog({ blockNumber: "150", logIndex: 0, blockHash: "0x" + "15".repeat(32) });
    const b = makeLog({ blockNumber: "120", logIndex: 0, blockHash: "0x" + "12".repeat(32), transactionHash: TX_2 });
    const e = throwsSync(() => buildNormalizedContent([a, b], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "OUT_OF_ORDER");
  });

  it("rejects out-of-order logs (same block, logIndex not increasing)", () => {
    const bh = "0x" + "15".repeat(32);
    const a = makeLog({ blockNumber: "150", logIndex: 1, blockHash: bh });
    const b = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh, transactionHash: TX_2 });
    const e = throwsSync(() => buildNormalizedContent([a, b], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "OUT_OF_ORDER");
  });

  it("rejects inconsistent blockHash within a block", () => {
    const a = makeLog({ blockNumber: "150", logIndex: 0, blockHash: "0x" + "15".repeat(32) });
    const b = makeLog({ blockNumber: "150", logIndex: 1, blockHash: "0x" + "16".repeat(32), transactionHash: TX_2 });
    const e = throwsSync(() => buildNormalizedContent([a, b], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INCONSISTENT_BLOCK_HASH");
  });

  it("rejects inconsistent transactionIndex within a transaction", () => {
    const bh = "0x" + "15".repeat(32);
    const a = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh, transactionIndex: 0 });
    const b = makeLog({ blockNumber: "150", logIndex: 1, blockHash: bh, transactionIndex: 1 });
    // same txHash, different transactionIndex
    const e = throwsSync(() => buildNormalizedContent([a, b], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INCONSISTENT_TX_BINDING");
  });

  it("rejects anchor before deployBlock", () => {
    const e = throwsSync(() => buildNormalizedContent([], IDENTITY, { blockNumber: "50", blockHash: HASH_C }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_RANGE");
  });

  it("rejects file over 8 MiB", () => {
    // synthesize bytes beyond limit by padding the log data
    const bigData = "0x" + "ab".repeat(MAX_BYTES);
    const e = throwsSync(() => buildNormalizedContent([makeLog({ data: bigData })], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
  });

  it("normalizes bigint blockNumber", () => {
    const { parsed } = buildNormalizedContent(
      [makeLog({ blockNumber: 150n })], IDENTITY, ANCHOR
    );
    assert.equal(parsed.logs[0].blockNumber, "150");
  });

  it("accepts anchor equal to deployBlock (minimal anchor)", () => {
    const anc = { blockNumber: "100", blockHash: HASH_C };
    const { parsed } = buildNormalizedContent([], IDENTITY, anc);
    assert.equal(parsed.anchor.blockNumber, "100");
  });
});

// ── validateApprovedBytes ──────────────────────────────────────────────────────

describe("validateApprovedBytes", () => {
  it("validates a well-formed file", () => {
    const { bytes, approvedDigest } = buildValid();
    const { parsed, logs } = validateApprovedBytes(bytes, approvedDigest, IDENTITY);
    assert.equal(parsed.kind, FILE_KIND);
    assert.deepEqual(logs, []);
  });

  // ── DELETION COUNTEREXAMPLE (proposal §3B.3) ────────────────────────────────
  //
  // Scenario: a transient OperatorSet grant/revoke pair is deleted from the
  // accumulated log store.  The canonical anchor block hash is retained.
  // Current role state and accounting are unchanged.  Without the externally
  // approved digest, the deletion would be undetectable by any on-chain check.
  // This test proves the approved digest is the ONLY guard.
  it("COUNTEREXAMPLE: deletion of transient role events with recomputed internal hash fails against approved digest", () => {
    const bh = "0x" + "15".repeat(32);
    // Grant and revoke are in SEPARATE transactions (transactionIndex differs),
    // as would happen with a real OperatorSet grant/revoke pair in two txs.
    const grantLog  = makeLog({ logIndex: 0, blockHash: bh, transactionHash: TX_1, transactionIndex: 0 });
    const revokeLog = makeLog({ logIndex: 1, blockHash: bh, transactionHash: TX_2, transactionIndex: 1 });

    // Build with both events — this is the complete canonical prefix
    const { bytes: originalBytes, approvedDigest: goodDigest } =
      buildValid([grantLog, revokeLog]);

    // Simulate deletion: rebuild without the pair (role now looks clean)
    const { bytes: tamperedBytes } = buildValid([]); // no logs — transient pair removed
    const tamperedDigest = hashBytes(tamperedBytes);

    // The tampered bytes have a different digest — good digest rejects them
    const e = throwsSync(() => validateApprovedBytes(tamperedBytes, goodDigest, IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "DIGEST_MISMATCH");

    // The original bytes still validate correctly
    const { logs } = validateApprovedBytes(originalBytes, goodDigest, IDENTITY);
    assert.equal(logs.length, 2);

    // Using the tampered file's own digest (self-referential "checksum") does NOT
    // help: the approved digest in the baseline is the original one, not the
    // tampered one.  This confirms that an internal checksum inside the file
    // provides no protection.
    assert.notEqual(tamperedDigest, goodDigest);
  });

  it("rejects wrong approved digest", () => {
    const { bytes } = buildValid();
    const e = throwsSync(() => validateApprovedBytes(bytes, "a".repeat(64), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "DIGEST_MISMATCH");
  });

  it("rejects digest check before parsing (corrupted JSON still gets digest error)", () => {
    const buf = Buffer.from("{not json}", "utf8");
    const realDigest = hashBytes(buf);
    // digest matches but parsing should fail, confirming digest is checked first
    // and then parse error is raised rather than a different structural error
    const e = throwsSync(() => validateApprovedBytes(buf, realDigest, IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "PARSE_ERROR");
  });

  it("rejects empty bytes", () => {
    const e = throwsSync(() => validateApprovedBytes(Buffer.alloc(0), "a".repeat(64), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
  });

  it("rejects bytes over 8 MiB", () => {
    const e = throwsSync(() => validateApprovedBytes(Buffer.alloc(MAX_BYTES + 1), "a".repeat(64), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
  });

  it("rejects wrong identity.address", () => {
    const { bytes, approvedDigest } = buildValid();
    const e = throwsSync(() => validateApprovedBytes(bytes, approvedDigest, { ...IDENTITY, address: OTHER }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "IDENTITY_MISMATCH");
  });

  it("rejects wrong identity.chainId", () => {
    const { bytes, approvedDigest } = buildValid();
    const e = throwsSync(() => validateApprovedBytes(bytes, approvedDigest, { ...IDENTITY, chainId: "999" }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "IDENTITY_MISMATCH");
  });

  it("rejects wrong identity.deployBlock", () => {
    const { bytes, approvedDigest } = buildValid();
    const e = throwsSync(() => validateApprovedBytes(bytes, approvedDigest, { ...IDENTITY, deployBlock: "99" }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "IDENTITY_MISMATCH");
  });

  it("rejects wrong identity.manifestHash", () => {
    const { bytes, approvedDigest } = buildValid();
    const e = throwsSync(() => validateApprovedBytes(bytes, approvedDigest, { ...IDENTITY, manifestHash: HASH_B }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "IDENTITY_MISMATCH");
  });

  it("rejects wrong identity.runtimeCodeHash", () => {
    const { bytes, approvedDigest } = buildValid();
    const e = throwsSync(() => validateApprovedBytes(bytes, approvedDigest, { ...IDENTITY, runtimeCodeHash: HASH_A }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "IDENTITY_MISMATCH");
  });

  it("rejects file with extra top-level field", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const tampered = { ...parsed, extra: "field" };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_SHAPE");
  });

  it("rejects file with missing top-level field", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const { logs: _omit, ...noLogs } = parsed; // eslint-disable-line no-unused-vars
    const bytes = Buffer.from(JSON.stringify(noLogs));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_SHAPE");
  });

  it("rejects file with extra identity field", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const tampered = { ...parsed, identity: { ...parsed.identity, extra: "x" } };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_SHAPE");
  });

  it("rejects file with extra log field", () => {
    const { parsed } = buildNormalizedContent([makeLog()], IDENTITY, ANCHOR);
    const tampered = { ...parsed, logs: [{ ...parsed.logs[0], extra: "x" }] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_SHAPE");
  });

  it("rejects log with wrong address in validated file", () => {
    const { parsed } = buildNormalizedContent([makeLog()], IDENTITY, ANCHOR);
    const tampered = { ...parsed, logs: [{ ...parsed.logs[0], address: OTHER }] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ADDRESS_MISMATCH");
  });

  it("rejects log with removed:true in validated file", () => {
    const { parsed } = buildNormalizedContent([makeLog()], IDENTITY, ANCHOR);
    const tampered = { ...parsed, logs: [{ ...parsed.logs[0], removed: true }] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_REMOVED");
  });

  it("rejects log with out-of-range blockNumber in validated file", () => {
    const { parsed } = buildNormalizedContent([makeLog()], IDENTITY, ANCHOR);
    const tampered = { ...parsed, logs: [{ ...parsed.logs[0], blockNumber: "50" }] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "OUT_OF_RANGE");
  });

  it("rejects duplicate (blockNumber, logIndex) in validated file", () => {
    const { parsed } = buildNormalizedContent([makeLog()], IDENTITY, ANCHOR);
    const tampered = { ...parsed, logs: [parsed.logs[0], parsed.logs[0]] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "DUPLICATE_POSITION");
  });

  it("rejects inconsistent block hash within a block", () => {
    // manufacture the JSON directly — bypasses buildNormalizedContent check
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const bh1 = "0x" + "aa".repeat(32);
    const bh2 = "0x" + "bb".repeat(32);
    const logA = { address: CONTRACT, blockNumber: "150", blockHash: bh1,
                   transactionHash: TX_1, transactionIndex: 0, logIndex: 0,
                   data: "0x", topics: [], removed: false };
    const logB = { ...logA, blockHash: bh2, logIndex: 1, transactionHash: TX_2 };
    const tampered = { ...parsed, logs: [logA, logB] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INCONSISTENT_BLOCK_HASH");
  });

  it("rejects inconsistent transactionIndex within a transaction", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const bh = "0x" + "15".repeat(32);
    const logA = { address: CONTRACT, blockNumber: "150", blockHash: bh,
                   transactionHash: TX_1, transactionIndex: 0, logIndex: 0,
                   data: "0x", topics: [], removed: false };
    const logB = { ...logA, transactionIndex: 1, logIndex: 1 }; // same txHash, different idx
    const tampered = { ...parsed, logs: [logA, logB] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INCONSISTENT_TX_BINDING");
  });

  it("rejects wrong schemaVersion", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const tampered = { ...parsed, schemaVersion: 99 };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "UNSUPPORTED_SCHEMA");
  });

  it("rejects wrong kind", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const tampered = { ...parsed, kind: "SomethingElse" };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "WRONG_KIND");
  });
});

// ── verifyAndMerge ─────────────────────────────────────────────────────────────

// Helpers for building standard options
function makeVerifyOptions(overrides = {}) {
  const bh = "0x" + "15".repeat(32);
  const prefixLog = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh });
  const { bytes, approvedDigest } = buildValid([prefixLog]);
  const anchorBN = 200n;

  return {
    prefixBytes:      bytes,
    approvedDigest,
    expectedIdentity: IDENTITY,
    pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
    finalizedBlock:   { blockNumber: 250n },
    verifyAnchorHash: async () => HASH_C,
    fetchSuffix:      async (from, to) => {
      assert.equal(from, anchorBN + 1n);
      assert.equal(to, 250n);
      return [];
    },
    ...overrides,
  };
}

describe("verifyAndMerge", () => {
  it("succeeds with empty prefix and empty suffix", async () => {
    const { bytes, approvedDigest } = buildValid();
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [],
    });
    assert.equal(result.coverage.fromBlock, 100n);
    assert.equal(result.coverage.toBlock,   250n);
    assert.equal(result.prefixLogs.length,  0);
    assert.equal(result.suffixLogs.length,  0);
    assert.equal(result.mergedLogs.length,  0);
    assert.equal(result.anchorBlock,        200n);
    assert.equal(result.pinnedBlock,        250n);
  });

  it("succeeds with prefix logs and suffix logs; merged bigint blockNumbers", async () => {
    const bh = "0x" + "15".repeat(32);
    const prefixLog = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh });
    const { bytes, approvedDigest } = buildValid([prefixLog]);

    const suffixBH = "0x" + "23".repeat(32);
    const suffixLog = makeLog({
      blockNumber: "230", logIndex: 0, blockHash: suffixBH, transactionHash: TX_2,
    });

    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async (from, to) => {
        assert.equal(from, 201n);
        assert.equal(to, 250n);
        return [suffixLog];
      },
    });
    assert.equal(result.prefixLogs.length, 1);
    assert.equal(result.suffixLogs.length, 1);
    assert.equal(result.mergedLogs.length, 2);
    // merged logs have bigint blockNumbers for viem consumers
    assert.equal(typeof result.mergedLogs[0].blockNumber, "bigint");
    assert.equal(result.mergedLogs[0].blockNumber, 150n);
    assert.equal(result.mergedLogs[1].blockNumber, 230n);
  });

  it("does NOT call fetchSuffix when anchor == pinned", async () => {
    const { bytes, approvedDigest } = buildValid();
    let called = false;
    // pinnedBlock.blockHash must match the approved anchor hash (HASH_C) when anchor == pinned
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 200n, blockHash: HASH_C },
      finalizedBlock:   { blockNumber: 200n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => { called = true; return []; },
    });
    assert.equal(called, false, "fetchSuffix must not be called when anchor == pinned");
    assert.equal(result.suffixLogs.length, 0);
    assert.equal(result.anchorBlock, 200n);
    assert.equal(result.pinnedBlock, 200n);
  });

  it("calls verifyAnchorHash exactly twice (before and after fetch)", async () => {
    const calls = [];
    const { bytes, approvedDigest } = buildValid();
    await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async (bn) => { calls.push(bn); return HASH_C; },
      fetchSuffix:      async () => [],
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 200n);
    assert.equal(calls[1], 200n);
  });

  it("exact suffix callback range: from=anchor+1, to=pinned", async () => {
    const { bytes, approvedDigest } = buildValid();
    let capturedFrom, capturedTo;
    await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 350n, blockHash: "0x" + "35".repeat(32) },
      finalizedBlock:   { blockNumber: 350n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async (from, to) => { capturedFrom = from; capturedTo = to; return []; },
    });
    assert.equal(capturedFrom, 201n, "suffix should start at anchor + 1");
    assert.equal(capturedTo,   350n, "suffix should end at pinnedBlock");
  });

  it("rejects anchor ahead of pinnedBlock", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 150n, blockHash: "0x" + "15".repeat(32) },
      finalizedBlock:   { blockNumber: 300n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ANCHOR_AHEAD_OF_PINNED");
  });

  it("rejects anchor ahead of finalizedBlock", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 150n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ANCHOR_AHEAD_OF_FINALIZED");
  });

  it("rejects when anchor hash does not match BEFORE fetch (reorg before)", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => "0x" + "ff".repeat(32),
      fetchSuffix:      async () => [],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ANCHOR_REORGANIZED");
  });

  it("rejects when anchor hash changes AFTER fetch (reorg after)", async () => {
    const { bytes, approvedDigest } = buildValid();
    let callCount = 0;
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => {
        callCount++;
        return callCount === 1 ? HASH_C : "0x" + "ff".repeat(32);
      },
      fetchSuffix: async () => [],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ANCHOR_REORGANIZED_AFTER_FETCH");
  });

  it("rejects when verifyAnchorHash returns null (block missing before fetch)", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => null,
      fetchSuffix:      async () => [],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ANCHOR_BLOCK_MISSING");
  });

  it("rejects suffix log out of range (below anchor+1)", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [
        makeLog({ blockNumber: "200", blockHash: HASH_C }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_OUT_OF_RANGE");
  });

  it("rejects suffix log out of range (above pinned)", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [
        makeLog({ blockNumber: "300", blockHash: "0x" + "30".repeat(32), transactionHash: TX_2 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_OUT_OF_RANGE");
  });

  it("rejects out-of-order suffix logs", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [
        makeLog({ blockNumber: "230", logIndex: 1, blockHash: "0x" + "23".repeat(32), transactionHash: TX_2 }),
        makeLog({ blockNumber: "210", logIndex: 0, blockHash: "0x" + "21".repeat(32), transactionHash: TX_1 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_OUT_OF_ORDER");
  });

  it("rejects duplicate suffix logs", async () => {
    const { bytes, approvedDigest } = buildValid();
    const sLog = makeLog({ blockNumber: "220", logIndex: 0, blockHash: "0x" + "22".repeat(32), transactionHash: TX_2 });
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [sLog, sLog],
    }));
    assert(e instanceof ApprovedHistoryError);
    // validateSequence with "SUFFIX_" prefix emits SUFFIX_DUPLICATE_POSITION
    assert.equal(e.code, "SUFFIX_DUPLICATE_POSITION");
  });

  it("rejects suffix log with wrong contract address", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [
        makeLog({ address: OTHER, blockNumber: "220", blockHash: "0x" + "22".repeat(32), transactionHash: TX_2 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ADDRESS_MISMATCH");
  });

  it("rejects suffix log with removed:true", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [
        makeLog({ removed: true, blockNumber: "220", blockHash: "0x" + "22".repeat(32), transactionHash: TX_2 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_REMOVED");
  });

  it("rejects fetchSuffix RPC error (thrown exception does not silently produce no-events)", async () => {
    const { bytes, approvedDigest } = buildValid();
    // A fetchSuffix that throws simulates an RPC error.  The verifyAndMerge
    // must propagate the error, not silently treat it as an empty log set.
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => { throw new Error("RPC timeout"); },
    }));
    assert(e instanceof Error);
    assert.match(e.message, /RPC timeout/);
  });

  it("prefix logs are passed through unchanged (no mutation)", async () => {
    const bh = "0x" + "15".repeat(32);
    const prefixLog = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh });
    const { bytes, approvedDigest } = buildValid([prefixLog]);

    // anchor == pinned: pinnedBlock.blockHash must equal HASH_C (the approved anchor hash)
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 200n, blockHash: HASH_C },
      finalizedBlock:   { blockNumber: 200n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [],
    });
    // prefix log unchanged (string blockNumber in prefixLogs)
    assert.equal(result.prefixLogs[0].blockNumber, "150");
    assert.equal(result.prefixLogs[0].logIndex, 0);
    assert.equal(result.prefixLogs[0].removed, false);
    // merged has bigint
    assert.equal(result.mergedLogs[0].blockNumber, 150n);
  });

  it("coverage metadata is fromBlock=deployBlock through pinnedBlock", async () => {
    const { bytes, approvedDigest } = buildValid();
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 500n, blockHash: "0x" + "50".repeat(32) },
      finalizedBlock:   { blockNumber: 500n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [],
    });
    assert.equal(result.coverage.fromBlock, 100n); // deployBlock
    assert.equal(result.coverage.toBlock,   500n); // pinnedBlock
  });

  it("rejects inconsistent block hash within a suffix block", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [
        makeLog({ blockNumber: "220", logIndex: 0, blockHash: "0x" + "22".repeat(32), transactionHash: TX_1 }),
        makeLog({ blockNumber: "220", logIndex: 1, blockHash: "0x" + "99".repeat(32), transactionHash: TX_2 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_INCONSISTENT_BLOCK_HASH");
  });

  it("rejects inconsistent transactionIndex within a suffix transaction", async () => {
    const { bytes, approvedDigest } = buildValid();
    const bh = "0x" + "22".repeat(32);
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [
        makeLog({ blockNumber: "220", logIndex: 0, blockHash: bh, transactionHash: TX_1, transactionIndex: 0 }),
        makeLog({ blockNumber: "220", logIndex: 1, blockHash: bh, transactionHash: TX_1, transactionIndex: 1 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_INCONSISTENT_TX_BINDING");
  });

  it("boundary: prefix log at exactly deployBlock", async () => {
    const bh = "0x" + "10".repeat(32);
    const prefixLog = makeLog({ blockNumber: "100", logIndex: 0, blockHash: bh });
    const { bytes, approvedDigest } = buildValid([prefixLog]);
    // anchor == pinned: pinnedBlock.blockHash must equal HASH_C
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 200n, blockHash: HASH_C },
      finalizedBlock:   { blockNumber: 200n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [],
    });
    assert.equal(result.prefixLogs.length, 1);
    assert.equal(result.mergedLogs[0].blockNumber, 100n);
  });

  it("boundary: suffix log at exactly pinnedBlock", async () => {
    const { bytes, approvedDigest } = buildValid();
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [
        makeLog({ blockNumber: "250", logIndex: 0, blockHash: "0x" + "25".repeat(32), transactionHash: TX_2 }),
      ],
    });
    assert.equal(result.suffixLogs.length, 1);
    assert.equal(result.mergedLogs[0].blockNumber, 250n);
  });

  it("validates wrong digest on prefix (before any chain interaction)", async () => {
    const { bytes } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest:   "b".repeat(64),
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => { throw new Error("should not be called"); },
      fetchSuffix:      async () => { throw new Error("should not be called"); },
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "DIGEST_MISMATCH");
  });
});

// ── Regression suite: fixes from supervision round 2 ─────────────────────────
//
// Each test below corresponds directly to one of the six reported issues or
// the three additional requirements (max topics, hash normalisation, cross-
// boundary tx binding).  The issue number is noted in the test description.

describe("regression: issue 1 — slot binding (same blockNumber:txIndex, different txHash)", () => {
  // Issue 1: Two DIFFERENT transactionHash values for the SAME (blockNumber, transactionIndex)
  // must be rejected, even if logIndex differs.  The existing tx-binding check only
  // validates txHash→slot; we also need slot→txHash.

  it("buildNormalizedContent rejects two different txHashes in the same slot", () => {
    const bh = "0x" + "15".repeat(32);
    // Same block, same transactionIndex (0), different txHash, different logIndex
    const a = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh,
                        transactionHash: TX_1, transactionIndex: 0 });
    const b = makeLog({ blockNumber: "150", logIndex: 1, blockHash: bh,
                        transactionHash: TX_2, transactionIndex: 0 }); // different txHash, same slot
    const e = throwsSync(() => buildNormalizedContent([a, b], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INCONSISTENT_SLOT_BINDING");
  });

  it("validateApprovedBytes rejects two different txHashes in the same slot", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const bh = "0x" + "15".repeat(32);
    const logA = { address: CONTRACT, blockNumber: "150", blockHash: bh,
                   transactionHash: TX_1, transactionIndex: 0, logIndex: 0,
                   data: "0x", topics: [], removed: false };
    const logB = { ...logA, transactionHash: TX_2, logIndex: 1 }; // different txHash, same slot
    const tampered = { ...parsed, logs: [logA, logB] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INCONSISTENT_SLOT_BINDING");
  });

  it("suffix validation rejects two different txHashes in the same suffix slot", async () => {
    const { bytes, approvedDigest } = buildValid();
    const bh = "0x" + "22".repeat(32);
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix: async () => [
        makeLog({ blockNumber: "220", logIndex: 0, blockHash: bh, transactionHash: TX_1, transactionIndex: 0 }),
        makeLog({ blockNumber: "220", logIndex: 1, blockHash: bh, transactionHash: TX_2, transactionIndex: 0 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_INCONSISTENT_SLOT_BINDING");
  });
});

describe("regression: issue 2 — non-decreasing transactionIndex within a block", () => {
  // Issue 2: Within one block, transactionIndex must be non-decreasing as
  // logIndex increases.  The old check only enforced global (blockNumber, logIndex) order.

  it("buildNormalizedContent rejects decreasing transactionIndex within a block", () => {
    const bh = "0x" + "15".repeat(32);
    // logIndex increases (0 → 1) but transactionIndex decreases (2 → 1)
    const a = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh,
                        transactionHash: TX_1, transactionIndex: 2 });
    const b = makeLog({ blockNumber: "150", logIndex: 1, blockHash: bh,
                        transactionHash: TX_2, transactionIndex: 1 });
    const e = throwsSync(() => buildNormalizedContent([a, b], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "TX_ORDER");
  });

  it("validateApprovedBytes rejects decreasing transactionIndex in a block", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const bh = "0x" + "15".repeat(32);
    const logA = { address: CONTRACT, blockNumber: "150", blockHash: bh,
                   transactionHash: TX_1, transactionIndex: 2, logIndex: 0,
                   data: "0x", topics: [], removed: false };
    const logB = { address: CONTRACT, blockNumber: "150", blockHash: bh,
                   transactionHash: TX_2, transactionIndex: 1, logIndex: 1,
                   data: "0x", topics: [], removed: false };
    const tampered = { ...parsed, logs: [logA, logB] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "TX_ORDER");
  });

  it("suffix validation rejects decreasing transactionIndex in a suffix block", async () => {
    const { bytes, approvedDigest } = buildValid();
    const bh = "0x" + "22".repeat(32);
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix: async () => [
        makeLog({ blockNumber: "220", logIndex: 0, blockHash: bh, transactionHash: TX_1, transactionIndex: 3 }),
        makeLog({ blockNumber: "220", logIndex: 1, blockHash: bh, transactionHash: TX_2, transactionIndex: 1 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_TX_ORDER");
  });

  it("accepts non-decreasing transactionIndex (equal is valid: multiple logs in same tx)", () => {
    const bh = "0x" + "15".repeat(32);
    // transactionIndex stays the same for both logs — that is valid (two logs in one tx)
    const a = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh,
                        transactionHash: TX_1, transactionIndex: 1 });
    const b = makeLog({ blockNumber: "150", logIndex: 1, blockHash: bh,
                        transactionHash: TX_1, transactionIndex: 1 });
    // should succeed
    const { parsed } = buildNormalizedContent([a, b], IDENTITY, ANCHOR);
    assert.equal(parsed.logs.length, 2);
  });
});

describe("regression: issue 3 — pinnedHash used when anchor == pinned", () => {
  // Issue 3: When anchor == pinned, a mismatched pinned hash must be rejected.
  // Previously verifyAndMerge parsed pinnedHash but never compared it.

  it("rejects when anchor == pinned but pinnedBlock.blockHash != approvedAnchorHash", async () => {
    // Build a prefix with anchor at 200.  Supply pinnedBlock 200 with a WRONG hash.
    const { bytes, approvedDigest } = buildValid(); // anchor = HASH_C at block 200
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 200n, blockHash: "0x" + "ff".repeat(32) }, // wrong!
      finalizedBlock:   { blockNumber: 200n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => { throw new Error("should not be called"); },
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ANCHOR_PINNED_HASH_MISMATCH");
  });

  it("accepts when anchor == pinned and hashes match", async () => {
    const { bytes, approvedDigest } = buildValid(); // anchor HASH_C at block 200
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 200n, blockHash: HASH_C }, // matches
      finalizedBlock:   { blockNumber: 200n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => { throw new Error("should not be called"); },
    });
    assert.equal(result.anchorBlock, 200n);
    assert.equal(result.pinnedBlock, 200n);
  });

  it("rejects suffix log at pinnedBlock with wrong pinned hash", async () => {
    // anchor < pinned; the suffix contains a log at exactly the pinned block
    // but with a different blockHash from pinnedBlock.blockHash.
    const { bytes, approvedDigest } = buildValid(); // anchor 200
    const PINNED_HASH = "0x" + "25".repeat(32);
    const WRONG_HASH  = "0x" + "ff".repeat(32);
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: PINNED_HASH },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix: async () => [
        makeLog({ blockNumber: "250", logIndex: 0, blockHash: WRONG_HASH, transactionHash: TX_2 }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_PINNED_HASH_MISMATCH");
  });

  it("rejects prefix log at anchor block with wrong anchor hash", async () => {
    // Build a prefix where a log at the anchor block carries the WRONG blockHash.
    // We must bypass the builder (which would reject it) and inject directly.
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR); // anchor HASH_C at 200
    const wrongHash = "0x" + "ff".repeat(32);
    const badLog = { address: CONTRACT, blockNumber: "200", blockHash: wrongHash,
                     transactionHash: TX_1, transactionIndex: 0, logIndex: 0,
                     data: "0x", topics: [], removed: false };
    const tampered = { ...parsed, logs: [badLog] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const approvedDigest = hashBytes(bytes);
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "PREFIX_ANCHOR_HASH_MISMATCH");
  });
});

describe("regression: issue 4 — cross-boundary transactionHash reuse", () => {
  // Issue 4: The same transactionHash appearing in the suffix but at a different
  // block or transactionIndex than its appearance in the prefix must be rejected.

  it("rejects suffix txHash that appeared in prefix at a different block", async () => {
    const bh = "0x" + "15".repeat(32);
    // Prefix: TX_1 appears in block 150
    const prefixLog = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh,
                                transactionHash: TX_1, transactionIndex: 0 });
    const { bytes, approvedDigest } = buildValid([prefixLog]);
    // Suffix: TX_1 reused in block 220 (different block)
    const suffixBH = "0x" + "22".repeat(32);
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix: async () => [
        makeLog({ blockNumber: "220", logIndex: 0, blockHash: suffixBH,
                  transactionHash: TX_1, transactionIndex: 0 }), // TX_1 in wrong block
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_INCONSISTENT_TX_BINDING");
  });

  it("rejects suffix txHash that appeared in prefix at a different transactionIndex", async () => {
    const bh = "0x" + "15".repeat(32);
    // Prefix: TX_1 at txIndex 0 in block 150
    const prefixLog = makeLog({ blockNumber: "150", logIndex: 0, blockHash: bh,
                                transactionHash: TX_1, transactionIndex: 0 });
    const { bytes, approvedDigest } = buildValid([prefixLog]);
    // Suffix: TX_1 in a DIFFERENT suffix block but at txIndex 5 (different index)
    const suffixBH = "0x" + "22".repeat(32);
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix: async () => [
        makeLog({ blockNumber: "220", logIndex: 0, blockHash: suffixBH,
                  transactionHash: TX_1, transactionIndex: 5 }), // same txHash, wrong index
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "SUFFIX_INCONSISTENT_TX_BINDING");
  });

  it("accepts valid suffix where txHash first appears in suffix (no prefix collision)", async () => {
    const { bytes, approvedDigest } = buildValid(); // no prefix logs
    const suffixBH = "0x" + "22".repeat(32);
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix: async () => [
        makeLog({ blockNumber: "220", logIndex: 0, blockHash: suffixBH,
                  transactionHash: TX_2, transactionIndex: 0 }),
      ],
    });
    assert.equal(result.suffixLogs.length, 1);
  });
});

describe("regression: issue 5 — unsafe number rejection in toDecimalString", () => {
  // Issue 5: Number.isInteger accepts unsafe numbers (e.g. 2**53 + 1 is
  // "an integer" but cannot be represented exactly).  The fix uses
  // Number.isSafeInteger, which rejects values outside ±2^53-1.

  it("buildNormalizedContent rejects unsafe Number as blockNumber", () => {
    const unsafeNum = Number.MAX_SAFE_INTEGER + 1; // 2^53 — not representable exactly
    const e = throwsSync(() =>
      buildNormalizedContent([], IDENTITY, { blockNumber: unsafeNum, blockHash: HASH_C }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_VALUE");
  });

  it("buildNormalizedContent rejects unsafe Number as deployBlock in identity", () => {
    const e = throwsSync(() =>
      buildNormalizedContent([], { ...IDENTITY, deployBlock: Number.MAX_SAFE_INTEGER + 1 }, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_VALUE");
  });

  it("accepts safe integer Number as blockNumber", () => {
    const { parsed } = buildNormalizedContent(
      [], IDENTITY, { blockNumber: 200, blockHash: HASH_C }  // safe integer
    );
    assert.equal(parsed.anchor.blockNumber, "200");
  });

  it("accepts Number.MAX_SAFE_INTEGER as a valid safe value", () => {
    const { parsed } = buildNormalizedContent(
      [], IDENTITY, { blockNumber: Number.MAX_SAFE_INTEGER, blockHash: HASH_C }
    );
    assert.equal(parsed.anchor.blockNumber, String(Number.MAX_SAFE_INTEGER));
  });

  it("rejects negative Number", () => {
    const e = throwsSync(() =>
      buildNormalizedContent([], IDENTITY, { blockNumber: -1, blockHash: HASH_C }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_VALUE");
  });

  it("rejects float number", () => {
    const e = throwsSync(() =>
      buildNormalizedContent([], IDENTITY, { blockNumber: 1.5, blockHash: HASH_C }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_VALUE");
  });
});

describe("regression: issue 6 — Uint8Array input to validateApprovedBytes", () => {
  // Issue 6: bytes.toString("utf8") does not exist on a plain Uint8Array.
  // The fix converts to Buffer first (Buffer.from(bytes)) before calling toString.
  // The digest must be identical regardless of whether a Buffer or Uint8Array is passed.

  it("accepts a Uint8Array containing valid prefix bytes", () => {
    const { bytes: buf, approvedDigest } = buildValid();
    // Convert to Uint8Array — the approved digest was computed over the same bytes
    const ua = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    // This must NOT throw PARSE_ERROR
    const { parsed, logs } = validateApprovedBytes(ua, approvedDigest, IDENTITY);
    assert.equal(parsed.kind, FILE_KIND);
    assert.deepEqual(logs, []);
  });

  it("digest is identical for Buffer and Uint8Array of the same bytes", () => {
    const { bytes: buf } = buildValid();
    const ua = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    assert.equal(hashBytes(buf), hashBytes(ua));
  });

  it("verifyAndMerge accepts Uint8Array prefixBytes", async () => {
    const { bytes: buf, approvedDigest } = buildValid();
    const ua = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const result = await verifyAndMerge({
      prefixBytes:      ua,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix:      async () => [],
    });
    assert.equal(result.coverage.fromBlock, 100n);
  });
});

describe("regression: max 4 EVM topics", () => {
  it("normalizeLog / buildNormalizedContent reject 5 topics", () => {
    const fiveTopics = Array.from({ length: 5 }, () => "0x" + "aa".repeat(32));
    const e = throwsSync(() =>
      buildNormalizedContent([makeLog({ topics: fiveTopics })], IDENTITY, ANCHOR));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_VALUE");
  });

  it("validateApprovedBytes rejects a stored log with 5 topics", () => {
    const { parsed } = buildNormalizedContent([], IDENTITY, ANCHOR);
    const fiveTopics = Array.from({ length: 5 }, () => "0x" + "aa".repeat(32));
    const badLog = { address: CONTRACT, blockNumber: "150", blockHash: "0x" + "15".repeat(32),
                     transactionHash: TX_1, transactionIndex: 0, logIndex: 0,
                     data: "0x", topics: fiveTopics, removed: false };
    const tampered = { ...parsed, logs: [badLog] };
    const bytes = Buffer.from(JSON.stringify(tampered));
    const e = throwsSync(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_VALUE");
  });

  it(`accepts exactly ${MAX_TOPICS} topics`, () => {
    const maxTopics = Array.from({ length: MAX_TOPICS }, () => "0x" + "aa".repeat(32));
    const { parsed } = buildNormalizedContent([makeLog({ topics: maxTopics })], IDENTITY, ANCHOR);
    assert.equal(parsed.logs[0].topics.length, MAX_TOPICS);
  });

  it("suffix validation rejects a log with 5 topics", async () => {
    const { bytes, approvedDigest } = buildValid();
    const fiveTopics = Array.from({ length: 5 }, () => "0x" + "aa".repeat(32));
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => HASH_C,
      fetchSuffix: async () => [
        makeLog({ blockNumber: "220", blockHash: "0x" + "22".repeat(32),
                  transactionHash: TX_2, topics: fiveTopics }),
      ],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "INVALID_VALUE");
  });
});

describe("regression: anchor hash callback normalisation (mixed-case bytes32)", () => {
  // verifyAnchorHash may return a mixed-case hash from an RPC response.
  // The comparison must normalise before matching.

  it("accepts UPPERCASE anchor hash from verifyAnchorHash callback", async () => {
    const { bytes, approvedDigest } = buildValid(); // anchor is HASH_C (0xcc...cc)
    const upperCC = HASH_C.toUpperCase(); // "0XCC...CC"
    const result = await verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => upperCC,
      fetchSuffix:      async () => [],
    });
    assert.equal(result.anchorBlock, 200n);
  });

  it("rejects when normalised mixed-case hash still does not match approvedAnchorHash", async () => {
    const { bytes, approvedDigest } = buildValid();
    const e = await rejectsAsync(() => verifyAndMerge({
      prefixBytes:      bytes,
      approvedDigest,
      expectedIdentity: IDENTITY,
      pinnedBlock:      { blockNumber: 250n, blockHash: "0x" + "25".repeat(32) },
      finalizedBlock:   { blockNumber: 250n },
      verifyAnchorHash: async () => "0x" + "DD".repeat(32), // normalises to 0xdd..., not HASH_C
      fetchSuffix:      async () => [],
    }));
    assert(e instanceof ApprovedHistoryError);
    assert.equal(e.code, "ANCHOR_REORGANIZED");
  });
});


it("stored decimal fields remain canonical strings even with a matching digest", () => {
  const built = buildNormalizedContent([], IDENTITY, ANCHOR);
  const changed = JSON.parse(built.bytes); changed.anchor.blockNumber = Number(changed.anchor.blockNumber);
  const bytes = Buffer.from(JSON.stringify(changed));
  assert.throws(() => validateApprovedBytes(bytes, hashBytes(bytes), IDENTITY), /canonical decimal string/);
});
