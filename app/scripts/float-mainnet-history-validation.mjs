/**
 * artifacts/approved-history.mjs
 *
 * Self-contained ESM Node.js helper for the Shadow Float monitor's optional
 * frozen-prefix design.  Uses only Node.js built-ins.
 *
 * ─── TRUST BOUNDARIES (read before integrating) ──────────────────────────────
 *
 * 1. ROOT TRUST: A root administrator who can overwrite the baseline file,
 *    the prefix file, AND the monitor code simultaneously can produce any
 *    result.  This module does NOT protect against root compromise.  It
 *    protects the monitor service's own write-path from self-approving an
 *    altered prefix.
 *
 * 2. CHECKSUM ≠ APPROVAL: A SHA-256 digest stored INSIDE the prefix file is
 *    self-referential and provides no external approval.  An attacker with
 *    filesystem access can delete events, recompute the checksum, and retain
 *    a still-canonical block hash.  The ONLY approved digest is the one held
 *    in the separately-protected maintainer baseline and passed into
 *    verifyAndMerge() as `approvedDigest`.  This function never reads a digest
 *    from the prefix bytes themselves.
 *
 * 3. CANONICAL BLOCK HASH ≠ COMPLETENESS: Verifying that the anchor block hash
 *    matches the chain proves the block exists on the canonical chain.  It does
 *    NOT prove that all logs between deployBlock and anchorBlock are present in
 *    the prefix.  A transient OperatorSet grant/revoke pair can be deleted,
 *    leaving accounting and current-role-state unchanged, with a still-canonical
 *    block hash.  Only the maintainer-approved external digest prevents this.
 *
 * 4. PROVENANCE: This helper cannot establish that a prefix was produced by a
 *    complete canonical scan.  Initial prefix approval requires a separate,
 *    operator-supervised complete canonical scan and explicit maintainer review.
 *    A monitor snapshot alone does not confer provenance.
 *
 * 5. NO AUTOMATIC MUTATIONS: This module never writes files, advances the
 *    deployment start, clears a hold, recreates a prefix, or infers "no events"
 *    from an RPC error.  All mutation decisions belong to the caller.
 *
 * ─── PUBLIC API ──────────────────────────────────────────────────────────────
 *
 *  buildNormalizedContent(logs, identity, anchor)
 *    → { bytes: Buffer, parsed: object }
 *    Normalizes raw viem log objects into the canonical prefix file shape.
 *    Does NOT approve them.  The caller must pass the resulting bytes to a
 *    maintainer for digest approval before the prefix can be used.
 *
 *  hashBytes(buf)
 *    → string (lowercase hex SHA-256)
 *    Computes the exact SHA-256 over the supplied Buffer or Uint8Array.
 *
 *  validateApprovedBytes(bytes, approvedDigest, expectedIdentity)
 *    → { parsed, logs }
 *    Synchronous structural validator.  Checks the digest FIRST (before
 *    parsing).  Throws ApprovedHistoryError on any violation.
 *
 *  verifyAndMerge(options)
 *    → Promise<MergeResult>
 *    Full async pipeline: validates bytes, enforces identity bindings, checks
 *    anchor canonicality before AND after suffix retrieval, fetches the
 *    complete suffix [anchor+1, pinnedBlock], merges, validates cross-boundary
 *    tx bindings, and returns full coverage metadata.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";

// ── constants ─────────────────────────────────────────────────────────────────

export const FILE_KIND    = "ShadowMonitor.ApprovedHistory";
export const FILE_SCHEMA  = 1;
export const MAX_BYTES    = 8 * 1024 * 1024; // 8 MiB
export const MAX_TOPICS   = 4;               // EVM maximum topics per log

// ── error type ────────────────────────────────────────────────────────────────

export class ApprovedHistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name  = "ApprovedHistoryError";
    this.code  = code;
  }
}

function fail(code, msg) { throw new ApprovedHistoryError(code, msg); }

// ── formatting helpers ────────────────────────────────────────────────────────

/**
 * Canonical decimal string for a value that may be a bigint, safe integer, or
 * canonical decimal string.  Rejects negative values, unsafe numbers (which
 * cannot be represented as exact integers in JS), non-integers, and strings
 * with leading zeros.
 */
function toDecimalString(value, label) {
  let s;
  if (typeof value === "bigint") {
    if (value < 0n) fail("INVALID_VALUE", `${label}: bigint must be non-negative`);
    s = value.toString(10);
  } else if (typeof value === "number") {
    // Number.isInteger accepts values beyond MAX_SAFE_INTEGER (e.g. 2**53 + 1
    // is "an integer" but is not representable exactly).  Reject those.
    if (!Number.isSafeInteger(value) || value < 0)
      fail("INVALID_VALUE", `${label}: number must be a safe non-negative integer`);
    s = String(value);
  } else if (typeof value === "string") {
    s = value;
  } else {
    fail("INVALID_VALUE", `${label}: expected bigint, number or string`);
  }
  if (!/^(0|[1-9]\d*)$/.test(s))
    fail("INVALID_VALUE", `${label}: not a canonical decimal string (got ${JSON.stringify(s)})`);
  return s;
}

/** Lowercase, 0x-prefixed hex string of exactly `byteLen` bytes. */
function toHexBytes(value, byteLen, label) {
  if (typeof value !== "string")
    fail("INVALID_VALUE", `${label}: expected a hex string`);
  const norm = value.toLowerCase();
  const expectedLen = 2 + byteLen * 2;
  if (!/^0x[0-9a-f]*$/.test(norm) || norm.length !== expectedLen)
    fail("INVALID_VALUE",
      `${label}: expected 0x-prefixed ${byteLen}-byte hex, got length ${norm.length}`);
  return norm;
}

const toBytes32 = (v, l) => toHexBytes(v, 32, l);
const toAddress  = (v, l) => toHexBytes(v, 20, l);

/** Safe non-negative integer (not bigint, not float, not unsafe). */
function toSafeNonNeg(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("INVALID_VALUE", `${label}: expected a safe non-negative integer, got ${value}`);
  return value;
}

// ── canonical JSON (key-sorted, bigints as decimal strings) ──────────────────

function canonicalJson(value) {
  if (typeof value === "bigint")  return JSON.stringify(value.toString(10));
  if (Array.isArray(value))       return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// ── field-set enforcement ─────────────────────────────────────────────────────

const IDENTITY_FIELDS  = ["address","chainId","deployBlock","manifestHash","runtimeCodeHash"].sort();
const ANCHOR_FIELDS    = ["blockHash","blockNumber"].sort();
const LOG_FIELDS       = ["address","blockHash","blockNumber","data","logIndex",
                          "removed","topics","transactionHash","transactionIndex"].sort();
const TOP_FIELDS       = ["anchor","identity","kind","logs","schemaVersion"].sort();

function exactFields(obj, expected, label) {
  const actual = Object.keys(obj).sort();
  const missing = expected.filter(k => !actual.includes(k));
  const extra   = actual.filter(k => !expected.includes(k));
  if (missing.length) fail("INVALID_SHAPE", `${label}: missing fields: ${missing.join(", ")}`);
  if (extra.length)   fail("INVALID_SHAPE", `${label}: extra fields: ${extra.join(", ")}`);
}

// ── log normalization (builder helper) ───────────────────────────────────────

/**
 * Normalize a single raw viem log into the canonical stored shape.
 * Accepts bigint blockNumber / logIndex / transactionIndex (viem style).
 * Does NOT approve or validate range membership; call buildNormalizedContent
 * to assemble a complete file.
 */
export function normalizeLog(raw, contractAddress) {
  const normAddr = toAddress(contractAddress, "contractAddress");

  // blockNumber: bigint or decimal string → canonical decimal string
  const blockNumber = toDecimalString(raw.blockNumber, "log.blockNumber");

  // blockHash / transactionHash: 32-byte hex
  const blockHash       = toBytes32(raw.blockHash,       "log.blockHash");
  const transactionHash = toBytes32(raw.transactionHash, "log.transactionHash");

  // logIndex / transactionIndex: safe non-neg integer or bigint
  const logIndex = typeof raw.logIndex === "bigint"
    ? toSafeNonNeg(Number(raw.logIndex), "log.logIndex")
    : toSafeNonNeg(raw.logIndex,         "log.logIndex");
  const transactionIndex = typeof raw.transactionIndex === "bigint"
    ? toSafeNonNeg(Number(raw.transactionIndex), "log.transactionIndex")
    : toSafeNonNeg(raw.transactionIndex,         "log.transactionIndex");

  // address must match the contract
  const logAddr = toAddress(raw.address, "log.address");
  if (logAddr !== normAddr)
    fail("ADDRESS_MISMATCH",
      `log.address ${logAddr} does not match contractAddress ${normAddr}`);

  // removed must be exactly false
  if (raw.removed !== false)
    fail("INVALID_REMOVED", "log.removed must be exactly false");

  // data: 0x-prefixed even-length hex
  if (typeof raw.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(raw.data))
    fail("INVALID_VALUE", "log.data must be 0x-prefixed even-length hex");
  const data = raw.data.toLowerCase();

  // topics: array of at most MAX_TOPICS (4) 32-byte hashes
  if (!Array.isArray(raw.topics))
    fail("INVALID_VALUE", "log.topics must be an array");
  if (raw.topics.length > MAX_TOPICS)
    fail("INVALID_VALUE",
      `log.topics has ${raw.topics.length} entries; EVM maximum is ${MAX_TOPICS}`);
  const topics = raw.topics.map((t, i) => toBytes32(t, `log.topics[${i}]`));

  return {
    address:          normAddr,
    blockNumber,
    blockHash,
    transactionHash,
    transactionIndex,
    logIndex,
    data,
    topics,
    removed:          false,
  };
}

// ── shared intra-sequence validators ─────────────────────────────────────────

/**
 * Validate ordering, uniqueness, intra-block hash consistency, and
 * intra/inter-transaction slot binding for an ordered sequence of
 * already-normalized logs.
 *
 * Invariants enforced:
 *  a) (blockNumber, logIndex) is unique and strictly increases.
 *  b) Within a block, transactionIndex is non-decreasing as logIndex increases.
 *  c) All logs in the same block share the same blockHash.
 *  d) A transactionHash always maps to exactly one (blockNumber, transactionIndex)
 *     slot — enforced both ways:
 *       • same txHash → same (blockNumber, blockHash, transactionIndex)
 *       • same (blockNumber, transactionIndex) slot → same txHash
 *
 * @param {object[]} logs      — already-normalized log objects
 * @param {string}   prefix    — label prefix for error messages ("" or "suffix ")
 * @param {Map}      [existingTxBindings]  — optional map from prior segment to
 *                                           detect cross-boundary tx reuse
 * @param {Map}      [existingSlotBindings]
 */
function validateSequence(logs, prefix, existingTxBindings, existingSlotBindings) {
  const blockHashes   = new Map();
  const txBindings    = existingTxBindings  ?? new Map(); // txHash → {blockNumber,blockHash,txIndex}
  const slotBindings  = existingSlotBindings ?? new Map(); // "blockNumber:txIndex" → txHash
  const positions     = new Map(); // "blockNumber:logIndex" → index i

  // Track (blockNumber, lastTxIndex) for within-block non-decreasing check
  const blockLastTx   = new Map(); // blockNumber → last transactionIndex seen

  const P = prefix;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const { blockNumber, blockHash, transactionHash, transactionIndex, logIndex } = log;

    // ── (a) uniqueness first, then ordering ──────────────────────────────────
    const posKey = `${blockNumber}:${logIndex}`;
    if (positions.has(posKey))
      fail(`${P}DUPLICATE_POSITION`,
        `${P}logs[${i}] (${blockNumber}:${logIndex}) duplicates logs[${positions.get(posKey)}]`);
    positions.set(posKey, i);

    if (i > 0) {
      const prev  = logs[i - 1];
      const prevBN = BigInt(prev.blockNumber);
      const curBN  = BigInt(blockNumber);
      if (curBN < prevBN || (curBN === prevBN && logIndex < prev.logIndex))
        fail(`${P}OUT_OF_ORDER`,
          `${P}logs[${i}] (${blockNumber}:${logIndex}) is not strictly after logs[${i-1}] (${prev.blockNumber}:${prev.logIndex})`);
    }

    // ── (b) within-block: transactionIndex non-decreasing ───────────────────
    if (blockLastTx.has(blockNumber)) {
      const lastTx = blockLastTx.get(blockNumber);
      if (transactionIndex < lastTx)
        fail(`${P}TX_ORDER`,
          `${P}logs[${i}] transactionIndex ${transactionIndex} is less than the previous transactionIndex ${lastTx} within block ${blockNumber}`);
    }
    blockLastTx.set(blockNumber, transactionIndex);

    // ── (c) intra-block hash consistency ─────────────────────────────────────
    if (!blockHashes.has(blockNumber)) {
      blockHashes.set(blockNumber, blockHash);
    } else if (blockHashes.get(blockNumber) !== blockHash) {
      fail(`${P}INCONSISTENT_BLOCK_HASH`,
        `${P}logs[${i}] blockNumber ${blockNumber} has blockHash ${blockHash} but an earlier log in the same block has ${blockHashes.get(blockNumber)}`);
    }

    // ── (d1) txHash → slot binding (forward: same hash must have same slot) ──
    if (!txBindings.has(transactionHash)) {
      txBindings.set(transactionHash, { blockNumber, blockHash, transactionIndex });
    } else {
      const b = txBindings.get(transactionHash);
      if (b.blockNumber !== blockNumber || b.blockHash !== blockHash || b.transactionIndex !== transactionIndex)
        fail(`${P}INCONSISTENT_TX_BINDING`,
          `${P}logs[${i}] transactionHash ${transactionHash} has inconsistent block/transactionIndex binding`);
    }

    // ── (d2) slot → txHash binding (reverse: same slot must have same hash) ──
    const slotKey = `${blockNumber}:${transactionIndex}`;
    if (!slotBindings.has(slotKey)) {
      slotBindings.set(slotKey, transactionHash);
    } else if (slotBindings.get(slotKey) !== transactionHash) {
      fail(`${P}INCONSISTENT_SLOT_BINDING`,
        `${P}logs[${i}] (${blockNumber}:txIndex=${transactionIndex}) has transactionHash ${transactionHash} but the same slot was previously occupied by ${slotBindings.get(slotKey)}`);
    }
  }

  // Return the maps so the caller can pass them to a subsequent segment for
  // cross-boundary validation.
  return { txBindings, slotBindings };
}

// ── file builder ──────────────────────────────────────────────────────────────

/**
 * buildNormalizedContent(rawLogs, identity, anchor)
 *
 * Assembles a canonical prefix file object from raw viem logs.
 * Validates identity shape and anchor, normalizes every log, enforces range
 * membership, uniqueness, ordering, and all intra/inter-transaction bindings.
 * Returns { bytes: Buffer, parsed }.
 *
 * Does NOT approve the result.  The returned bytes must be passed to a
 * maintainer for digest computation and baseline approval.
 */
export function buildNormalizedContent(rawLogs, identity, anchor) {
  // identity
  const id = {
    address:         toAddress(identity.address,          "identity.address"),
    chainId:         toDecimalString(identity.chainId,    "identity.chainId"),
    deployBlock:     toDecimalString(identity.deployBlock,"identity.deployBlock"),
    manifestHash:    toBytes32(identity.manifestHash,     "identity.manifestHash"),
    runtimeCodeHash: toBytes32(identity.runtimeCodeHash,  "identity.runtimeCodeHash"),
  };

  // anchor
  const anc = {
    blockHash:   toBytes32(anchor.blockHash,           "anchor.blockHash"),
    blockNumber: toDecimalString(anchor.blockNumber,   "anchor.blockNumber"),
  };

  // deployBlock <= anchorBlock
  if (BigInt(anc.blockNumber) < BigInt(id.deployBlock))
    fail("INVALID_RANGE",
      `anchor.blockNumber ${anc.blockNumber} is before deployBlock ${id.deployBlock}`);

  // normalize logs
  if (!Array.isArray(rawLogs))
    fail("INVALID_VALUE", "logs must be an array");

  const logs = rawLogs.map((l, i) => {
    try { return normalizeLog(l, id.address); }
    catch (e) { fail(e.code ?? "INVALID_LOG", `logs[${i}]: ${e.message}`); }
  });

  // range membership: every log in [deployBlock, anchorBlock]
  const deploy = BigInt(id.deployBlock);
  const ancBN  = BigInt(anc.blockNumber);
  for (let i = 0; i < logs.length; i++) {
    const bn = BigInt(logs[i].blockNumber);
    if (bn < deploy || bn > ancBN)
      fail("OUT_OF_RANGE",
        `logs[${i}] blockNumber ${logs[i].blockNumber} is outside [${id.deployBlock}, ${anc.blockNumber}]`);
  }

  // full sequence validation (ordering, uniqueness, block/tx binding)
  validateSequence(logs, "");

  const parsed = {
    schemaVersion: FILE_SCHEMA,
    kind:          FILE_KIND,
    identity:      id,
    anchor:        anc,
    logs,
  };

  const bytes = Buffer.from(canonicalJson(parsed), "utf8");
  if (bytes.length > MAX_BYTES)
    fail("TOO_LARGE",
      `prefix file is ${bytes.length} bytes, exceeding the ${MAX_BYTES}-byte limit`);

  return { bytes, parsed };
}

// ── digest ────────────────────────────────────────────────────────────────────

/**
 * hashBytes(buf)  →  lowercase hex SHA-256 of buf.
 * Accepts Buffer or Uint8Array.
 * Used to compute the maintainer-approved digest from the exact prefix bytes.
 */
export function hashBytes(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array))
    fail("INVALID_VALUE", "hashBytes: argument must be a Buffer or Uint8Array");
  return createHash("sha256").update(buf).digest("hex");
}

// ── synchronous validator ─────────────────────────────────────────────────────

/**
 * validateApprovedBytes(bytes, approvedDigest, expectedIdentity)
 *
 * Validates the exact bytes of a prefix file against an externally-approved
 * digest and expected identity bindings.
 *
 * IMPORTANT: The digest is compared against `approvedDigest` (from the
 * separately-protected maintainer baseline).  A digest field inside the file
 * itself would be self-referential and is NOT present in this format.
 *
 * Throws ApprovedHistoryError on any violation.
 * Returns { parsed, logs } where logs are the validated normalized log objects.
 */
export function validateApprovedBytes(bytes, approvedDigest, expectedIdentity) {
  // 0. size guard
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
    fail("INVALID_INPUT", "bytes must be a Buffer or Uint8Array");
  if (bytes.length > MAX_BYTES)
    fail("TOO_LARGE",
      `prefix bytes are ${bytes.length} bytes, exceeding the ${MAX_BYTES}-byte limit`);
  if (bytes.length === 0)
    fail("INVALID_INPUT", "prefix bytes are empty");

  // 1. digest check BEFORE parsing — the canonical guard.
  //    This is the ONLY approved digest; a digest inside the file would be
  //    self-referential and is explicitly not trusted.
  if (typeof approvedDigest !== "string" || !/^[0-9a-f]{64}$/.test(approvedDigest))
    fail("INVALID_DIGEST", "approvedDigest must be a 64-character lowercase hex SHA-256");
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== approvedDigest)
    fail("DIGEST_MISMATCH",
      `approved digest ${approvedDigest} does not match actual digest ${actualDigest} — the prefix bytes have been altered`);

  // 2. parse — convert to Buffer first so .toString("utf8") works for both
  //    Buffer and Uint8Array inputs (Uint8Array does not have .toString("utf8")).
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { fail("PARSE_ERROR", "prefix bytes are not valid JSON"); }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("INVALID_SHAPE", "prefix must be a JSON object");

  // 3. top-level field set
  exactFields(parsed, TOP_FIELDS, "prefix");

  // 4. schemaVersion and kind
  if (parsed.schemaVersion !== FILE_SCHEMA)
    fail("UNSUPPORTED_SCHEMA",
      `unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)}, expected ${FILE_SCHEMA}`);
  if (parsed.kind !== FILE_KIND)
    fail("WRONG_KIND",
      `wrong kind ${JSON.stringify(parsed.kind)}, expected ${FILE_KIND}`);

  // 5. identity field set and values
  const id = parsed.identity;
  if (!id || typeof id !== "object" || Array.isArray(id))
    fail("INVALID_SHAPE", "identity must be an object");
  exactFields(id, IDENTITY_FIELDS, "identity");

  for (const key of ["chainId", "deployBlock"]) if (typeof id[key] !== "string")
    fail("INVALID_VALUE", `identity.${key} must be a canonical decimal string`);
  const normId = {
    address:         toAddress(id.address,              "identity.address"),
    chainId:         toDecimalString(id.chainId,        "identity.chainId"),
    deployBlock:     toDecimalString(id.deployBlock,    "identity.deployBlock"),
    manifestHash:    toBytes32(id.manifestHash,         "identity.manifestHash"),
    runtimeCodeHash: toBytes32(id.runtimeCodeHash,      "identity.runtimeCodeHash"),
  };

  // 6. exact identity bindings against caller-supplied expected values
  const exp            = expectedIdentity;
  const expAddress     = toAddress(exp.address,            "expected.address");
  const expChainId     = toDecimalString(exp.chainId,      "expected.chainId");
  const expDeployBlock = toDecimalString(exp.deployBlock,  "expected.deployBlock");
  const expManHash     = toBytes32(exp.manifestHash,       "expected.manifestHash");
  const expRtHash      = toBytes32(exp.runtimeCodeHash,    "expected.runtimeCodeHash");

  if (normId.address         !== expAddress)     fail("IDENTITY_MISMATCH", "identity.address mismatch");
  if (normId.chainId         !== expChainId)     fail("IDENTITY_MISMATCH", "identity.chainId mismatch");
  if (normId.deployBlock     !== expDeployBlock) fail("IDENTITY_MISMATCH", "identity.deployBlock mismatch");
  if (normId.manifestHash    !== expManHash)     fail("IDENTITY_MISMATCH", "identity.manifestHash mismatch");
  if (normId.runtimeCodeHash !== expRtHash)      fail("IDENTITY_MISMATCH", "identity.runtimeCodeHash mismatch");

  // 7. anchor field set and values
  const anc = parsed.anchor;
  if (!anc || typeof anc !== "object" || Array.isArray(anc))
    fail("INVALID_SHAPE", "anchor must be an object");
  exactFields(anc, ANCHOR_FIELDS, "anchor");

  if (typeof anc.blockNumber !== "string") fail("INVALID_VALUE", "anchor.blockNumber must be a canonical decimal string");
  const normAnc = {
    blockHash:   toBytes32(anc.blockHash,         "anchor.blockHash"),
    blockNumber: toDecimalString(anc.blockNumber, "anchor.blockNumber"),
  };

  // anchorBlock >= deployBlock
  if (BigInt(normAnc.blockNumber) < BigInt(normId.deployBlock))
    fail("INVALID_RANGE",
      `anchor.blockNumber ${normAnc.blockNumber} is before deployBlock ${normId.deployBlock}`);

  // 8. logs
  if (!Array.isArray(parsed.logs))
    fail("INVALID_SHAPE", "logs must be an array");

  const deploy = BigInt(normId.deployBlock);
  const ancBN  = BigInt(normAnc.blockNumber);
  const logs   = [];

  for (let i = 0; i < parsed.logs.length; i++) {
    const raw = parsed.logs[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      fail("INVALID_SHAPE", `logs[${i}] must be an object`);

    exactFields(raw, LOG_FIELDS, `logs[${i}]`);

    // address
    const logAddr = toAddress(raw.address, `logs[${i}].address`);
    if (logAddr !== normId.address)
      fail("ADDRESS_MISMATCH",
        `logs[${i}].address ${logAddr} does not match identity.address ${normId.address}`);

    // blockNumber
    if (typeof raw.blockNumber !== "string") fail("INVALID_VALUE", "stored log.blockNumber must be a canonical decimal string");
    const blockNumber = toDecimalString(raw.blockNumber, `logs[${i}].blockNumber`);
    const bn = BigInt(blockNumber);
    if (bn < deploy || bn > ancBN)
      fail("OUT_OF_RANGE",
        `logs[${i}].blockNumber ${blockNumber} is outside [${normId.deployBlock}, ${normAnc.blockNumber}]`);

    // blockHash
    const blockHash = toBytes32(raw.blockHash, `logs[${i}].blockHash`);

    // transactionHash
    const transactionHash = toBytes32(raw.transactionHash, `logs[${i}].transactionHash`);

    // transactionIndex / logIndex
    const transactionIndex = toSafeNonNeg(raw.transactionIndex, `logs[${i}].transactionIndex`);
    const logIndex         = toSafeNonNeg(raw.logIndex,         `logs[${i}].logIndex`);

    // removed must be exactly false
    if (raw.removed !== false)
      fail("INVALID_REMOVED", `logs[${i}].removed must be exactly false`);

    // data
    if (typeof raw.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(raw.data))
      fail("INVALID_VALUE", `logs[${i}].data must be 0x-prefixed even-length hex`);
    const data = raw.data.toLowerCase();

    // topics: at most MAX_TOPICS entries
    if (!Array.isArray(raw.topics))
      fail("INVALID_VALUE", `logs[${i}].topics must be an array`);
    if (raw.topics.length > MAX_TOPICS)
      fail("INVALID_VALUE",
        `logs[${i}].topics has ${raw.topics.length} entries; EVM maximum is ${MAX_TOPICS}`);
    const topics = raw.topics.map((t, j) => toBytes32(t, `logs[${i}].topics[${j}]`));

    logs.push({ address: logAddr, blockNumber, blockHash, transactionHash,
                transactionIndex, logIndex, data, topics, removed: false });
  }

  // Full sequence validation (ordering, uniqueness, block/tx/slot bindings)
  validateSequence(logs, "");

  return { parsed: { ...parsed, identity: normId, anchor: normAnc }, logs };
}

// ── suffix validator ──────────────────────────────────────────────────────────

/**
 * Validate suffix logs returned by the fetchSuffix callback.
 * suffixFrom = anchorBlock + 1n, suffixTo = pinnedBlock.
 * Each log must be in [suffixFrom, suffixTo], pass normalizeLog, be strictly
 * ordered, unique at (blockNumber, logIndex), and have consistent block/tx/slot
 * bindings — including cross-boundary bindings carried in from the prefix.
 *
 * @param {Array}  rawLogs
 * @param {string} contractAddress
 * @param {bigint} suffixFrom
 * @param {bigint} suffixTo
 * @param {Map}    prefixTxBindings   — from the prefix segment (may be empty Map)
 * @param {Map}    prefixSlotBindings — from the prefix segment (may be empty Map)
 * @returns {object[]} normalized suffix logs
 */
function validateSuffixLogs(
  rawLogs, contractAddress, suffixFrom, suffixTo,
  prefixTxBindings, prefixSlotBindings
) {
  if (!Array.isArray(rawLogs))
    fail("INVALID_SUFFIX", "suffix logs must be an array");

  const logs = [];
  for (let i = 0; i < rawLogs.length; i++) {
    let norm;
    try { norm = normalizeLog(rawLogs[i], contractAddress); }
    catch (e) { fail(e.code ?? "INVALID_SUFFIX_LOG", `suffix logs[${i}]: ${e.message}`); }

    const bn = BigInt(norm.blockNumber);
    if (bn < suffixFrom || bn > suffixTo)
      fail("SUFFIX_OUT_OF_RANGE",
        `suffix logs[${i}] blockNumber ${norm.blockNumber} is outside the requested range [${suffixFrom}, ${suffixTo}]`);

    logs.push(norm);
  }

  // Validate the suffix sequence, seeding with prefix bindings for cross-boundary checks.
  // Errors from validateSequence use the "SUFFIX_" prefix.
  validateSequence(logs, "SUFFIX_", prefixTxBindings, prefixSlotBindings);

  return logs;
}

// ── main async entry point ────────────────────────────────────────────────────

/**
 * verifyAndMerge(options) → Promise<MergeResult>
 *
 * options:
 *   prefixBytes       Buffer|Uint8Array — exact bytes of the prefix file
 *   approvedDigest    string    — SHA-256 hex from the maintainer baseline
 *   expectedIdentity  object    — { chainId, address, runtimeCodeHash,
 *                                   deployBlock, manifestHash }
 *   pinnedBlock       object    — { blockNumber: bigint|string, blockHash: string }
 *                                 The block the monitor has pinned for this cycle.
 *   finalizedBlock    object    — { blockNumber: bigint|string }
 *                                 The chain's current finalized block number.
 *   verifyAnchorHash  async fn  — (blockNumber: bigint) => string|null
 *                                 Returns the canonical hash for that block number,
 *                                 or null if the block does not exist.
 *                                 Called BEFORE and AFTER suffix fetch.
 *                                 Return value is normalized as a bytes32 hex for
 *                                 comparison; mixed-case is accepted.
 *   fetchSuffix       async fn  — (fromBlock: bigint, toBlock: bigint) => rawLog[]
 *                                 Returns ALL logs for [fromBlock, toBlock].
 *                                 Called with fromBlock = anchorBlock + 1n,
 *                                 toBlock = pinnedBlock.
 *                                 Only called when anchorBlock < pinnedBlock.
 *
 * Throws ApprovedHistoryError on any violation.  Never writes files, clears
 * holds, or silently discards prefix events.
 *
 * MergeResult:
 *   coverage     { fromBlock: bigint, toBlock: bigint }  — deployBlock..pinned
 *   prefixLogs   normalized log objects (string blockNumbers, unchanged)
 *   suffixLogs   normalized log objects from the suffix scan
 *   mergedLogs   bigint-blockNumber reconstructed logs for viem consumers
 *   anchorBlock  bigint
 *   pinnedBlock  bigint
 */
export async function verifyAndMerge({
  prefixBytes,
  approvedDigest,
  expectedIdentity,
  pinnedBlock,
  finalizedBlock,
  verifyAnchorHash,
  fetchSuffix,
}) {
  // ── 1. validate prefix bytes (digest first, then structural) ────────────────
  const { parsed, logs: prefixLogs } = validateApprovedBytes(
    prefixBytes, approvedDigest, expectedIdentity
  );

  const contractAddress    = parsed.identity.address;
  const deployBlockN       = BigInt(parsed.identity.deployBlock);
  const anchorBlockN       = BigInt(parsed.anchor.blockNumber);
  const approvedAnchorHash = parsed.anchor.blockHash; // already lowercase from validator

  // ── 2. pinnedBlock and finalizedBlock normalization ─────────────────────────
  const pinnedBN    = BigInt(toDecimalString(pinnedBlock.blockNumber,    "pinnedBlock.blockNumber"));
  const pinnedHash  = toBytes32(pinnedBlock.blockHash, "pinnedBlock.blockHash");
  const finalizedBN = BigInt(toDecimalString(finalizedBlock.blockNumber, "finalizedBlock.blockNumber"));

  // ── 3. anchor <= pinned and anchor <= finalized ─────────────────────────────
  if (anchorBlockN > pinnedBN)
    fail("ANCHOR_AHEAD_OF_PINNED",
      `anchor.blockNumber ${anchorBlockN} is ahead of pinnedBlock ${pinnedBN}`);
  if (anchorBlockN > finalizedBN)
    fail("ANCHOR_AHEAD_OF_FINALIZED",
      `anchor.blockNumber ${anchorBlockN} is ahead of finalizedBlock ${finalizedBN}`);

  // ── 4. verify anchor hash BEFORE suffix fetch ───────────────────────────────
  //    Normalize the returned hash (toBytes32 handles mixed case).
  const rawBefore = await verifyAnchorHash(anchorBlockN);
  if (rawBefore === null)
    fail("ANCHOR_BLOCK_MISSING",
      `anchor block ${anchorBlockN} does not exist on the chain according to verifyAnchorHash`);
  const anchorHashBefore = toBytes32(rawBefore, "verifyAnchorHash result (before)");
  if (anchorHashBefore !== approvedAnchorHash)
    fail("ANCHOR_REORGANIZED",
      `anchor block ${anchorBlockN} hash is ${anchorHashBefore}, expected ${approvedAnchorHash} — the anchor has been reorganized`);

  // When anchor == pinned the anchor hash must also match the pinned hash.
  if (anchorBlockN === pinnedBN && anchorHashBefore !== pinnedHash)
    fail("ANCHOR_PINNED_HASH_MISMATCH",
      `anchor block ${anchorBlockN} equals pinnedBlock but the pinned hash ${pinnedHash} does not match the approved anchor hash ${approvedAnchorHash}`);

  // ── 5. validate that prefix logs at the anchor block carry the correct hash ─
  for (let i = 0; i < prefixLogs.length; i++) {
    if (prefixLogs[i].blockNumber === String(anchorBlockN) &&
        prefixLogs[i].blockHash   !== approvedAnchorHash)
      fail("PREFIX_ANCHOR_HASH_MISMATCH",
        `prefix logs[${i}] is in the anchor block ${anchorBlockN} but has blockHash ${prefixLogs[i].blockHash}, expected ${approvedAnchorHash}`);
  }

  // ── 6. build prefix tx/slot binding maps to seed cross-boundary validation ─
  const { txBindings: prefixTxBindings, slotBindings: prefixSlotBindings } =
    validateSequence(prefixLogs, "");

  // ── 7. fetch suffix (or skip if anchor == pinned) ──────────────────────────
  let suffixLogs = [];
  if (anchorBlockN < pinnedBN) {
    const suffixFrom = anchorBlockN + 1n;
    const suffixTo   = pinnedBN;
    const rawSuffix  = await fetchSuffix(suffixFrom, suffixTo);
    // Pass copies of the prefix maps so suffix validation can detect cross-boundary
    // tx/slot reuse without mutating the originals.
    suffixLogs = validateSuffixLogs(
      rawSuffix, contractAddress, suffixFrom, suffixTo,
      new Map(prefixTxBindings), new Map(prefixSlotBindings)
    );
  }

  // ── 8. verify anchor hash AFTER suffix fetch ────────────────────────────────
  const rawAfter = await verifyAnchorHash(anchorBlockN);
  if (rawAfter === null)
    fail("ANCHOR_BLOCK_MISSING",
      `anchor block ${anchorBlockN} disappeared after suffix fetch`);
  const anchorHashAfter = toBytes32(rawAfter, "verifyAnchorHash result (after)");
  if (anchorHashAfter !== approvedAnchorHash)
    fail("ANCHOR_REORGANIZED_AFTER_FETCH",
      `anchor block ${anchorBlockN} hash changed to ${anchorHashAfter} after suffix fetch (was ${approvedAnchorHash}) — chain reorganized during the cycle`);

  // ── 9. validate suffix logs at pinnedBlock carry the correct pinned hash ────
  for (let i = 0; i < suffixLogs.length; i++) {
    if (BigInt(suffixLogs[i].blockNumber) === pinnedBN &&
        suffixLogs[i].blockHash !== pinnedHash)
      fail("SUFFIX_PINNED_HASH_MISMATCH",
        `suffix logs[${i}] is in the pinned block ${pinnedBN} but has blockHash ${suffixLogs[i].blockHash}, expected ${pinnedHash}`);
  }

  // ── 10. prefix-suffix boundary: no position overlap ────────────────────────
  //    Prefix covers [deployBlock, anchorBlock]; suffix covers [anchorBlock+1, pinnedBlock].
  if (suffixLogs.length > 0) {
    const firstSuffixBN = BigInt(suffixLogs[0].blockNumber);
    if (firstSuffixBN <= anchorBlockN)
      fail("PREFIX_SUFFIX_OVERLAP",
        `first suffix log is at block ${firstSuffixBN}, which is within the prefix range (anchor ${anchorBlockN})`);
  }

  // ── 11. merge: prefix logs unchanged, suffix appended ──────────────────────
  //    Reconstruct with bigint blockNumbers for viem consumers.
  const toViemLog = (l) => ({
    ...l,
    blockNumber:      BigInt(l.blockNumber),
    logIndex:         l.logIndex,
    transactionIndex: l.transactionIndex,
  });
  const mergedLogs = [...prefixLogs, ...suffixLogs].map(toViemLog);

  return {
    coverage:    { fromBlock: deployBlockN, toBlock: pinnedBN },
    prefixLogs,
    suffixLogs,
    mergedLogs,
    anchorBlock: anchorBlockN,
    pinnedBlock: pinnedBN,
  };
}
