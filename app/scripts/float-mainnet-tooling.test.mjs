import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { decodeAbiParameters, getContractAddress, keccak256, zeroAddress } from "viem";

import {
  buildManifest,
  decodeImmutables,
  encodeConstructorArgs,
  immutableRanges,
  immutableWord,
  IMMUTABLE_GETTERS,
  maskImmutables,
  readBroadcast,
  runScopeGate,
} from "./float-mainnet-manifest.mjs";
import {
  PINNED_SOURCE_BLOBS,
  PINNED_SOURCE_COMMIT,
  isEntrypoint,
  loadArtifact,
  parseConfig,
  pinnedLineageMismatches,
  readSourceState,
  redactUrl,
  scrubUrls,
  stableStringify,
} from "./float-mainnet-preflight.mjs";

const PARAMS_EXAMPLE = new URL(
  "../../contracts/deployments/float-mainnet-candidate/arc-testnet.params.example",
  import.meta.url,
);
const PINNED_ENV = {
  FLOAT_MAINNET_EXPECTED_CHAIN_ID: "5042002",
  FLOAT_MAINNET_USDC: "0x3600000000000000000000000000000000000000",
  FLOAT_MAINNET_MAX_PROTOCOL_RESERVE: "50000000",
  FLOAT_MAINNET_MAX_LINE_RESERVE: "10000000",
  FLOAT_MAINNET_MAX_LINE_SPEND: "10000000",
  FLOAT_MAINNET_MAX_PER_SPEND: "2000000",
  FLOAT_MAINNET_MAX_DAILY_SPEND: "4000000",
  FLOAT_MAINNET_INIT_PROTOCOL_RESERVE: "25000000",
  FLOAT_MAINNET_INIT_LINE_RESERVE: "5000000",
  FLOAT_MAINNET_INIT_LINE_SPEND: "5000000",
  FLOAT_MAINNET_INIT_PER_SPEND: "1000000",
  FLOAT_MAINNET_INIT_DAILY_SPEND: "2000000",
  FLOAT_MAINNET_MIN_REPAYMENT_WINDOW: "3600",
  FLOAT_MAINNET_MAX_REPAYMENT_WINDOW: "604800",
  FLOAT_MAINNET_GOVERNANCE_DELAY: "172800",
  ARC_RPC_URL: "http://127.0.0.1:18546",
  ARC_RPC_URL_2: "http://localhost:18546",
  ARC_EXPLORER_URL: "http://127.0.0.1:18547",
};
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const THIRD = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ADDRESS = getContractAddress({ from: DEPLOYER, nonce: 1n });
const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;

const artifact = loadArtifact();

// The manifest requires the expected deployer, so the default config names it.
function config(overrides = {}) {
  const parsed = parseConfig({ ...PINNED_ENV, FLOAT_MAINNET_EXPECTED_DEPLOYER: DEPLOYER, ...overrides }, { requireDeployer: true });
  assert.deepEqual(parsed.errors, []);
  return parsed.config;
}

function errorsFor(overrides) {
  return parseConfig({ ...PINNED_ENV, ...overrides }).errors;
}

// Test fixture only: fills immutable slots in ascending astId order, which is
// declaration order for this contract. The manifest itself never relies on it.
function runtimeWith(values) {
  const references = artifact.deployedBytecode.immutableReferences;
  let hex = artifact.deployedBytecode.object.slice(2).toLowerCase();
  Object.keys(references)
    .sort((a, b) => Number(a) - Number(b))
    .forEach((astId, index) => {
      for (const { start, length } of references[astId]) {
        hex = hex.slice(0, start * 2) + immutableWord(values[index]).slice(2) + hex.slice((start + length) * 2);
      }
    });
  return `0x${hex}`;
}

function flipByte(code, index) {
  const original = code.slice(2 + index * 2, 4 + index * 2);
  return `0x${code.slice(2, 2 + index * 2)}${original === "ff" ? "00" : "ff"}${code.slice(4 + index * 2)}`;
}

function outsideImmutables() {
  const { start } = immutableRanges(artifact)[0];
  return start > 0 ? start - 1 : start + 32;
}

function observation(deployed) {
  return {
    block: { hash: BLOCK_HASH, number: "100", timestamp: "1789740000" },
    chainId: deployed.expectedChainId.toString(),
    code: runtimeWith(IMMUTABLE_GETTERS.map(([, value]) => value(deployed))),
    events: [],
    observedAt: { blockHash: BLOCK_HASH, blockNumber: "100" },
    receipt: { blockHash: BLOCK_HASH, blockNumber: "100", contractAddress: ADDRESS, status: "success" },
    state: {
      ...Object.fromEntries(IMMUTABLE_GETTERS.map(([name, value]) => [name, value(deployed).toString()])),
      effectiveLimits: JSON.parse(stableStringify(deployed.initial)),
      openingsPaused: false,
      owner: DEPLOYER,
      pendingOwner: zeroAddress,
      spendsPaused: false,
      totalCommittedCapital: "0",
      totalSponsorObligations: "0",
      floatUsdcBalance: "0",
    },
    transaction: {
      blockHash: BLOCK_HASH,
      blockNumber: "100",
      from: DEPLOYER,
      hash: TX_HASH,
      input: `${artifact.bytecode.object}${encodeConstructorArgs(artifact, deployed).slice(2)}`.toLowerCase(),
      nonce: 1,
      to: null,
    },
    usdcRestrictions: { floatBlacklisted: { exposed: true, value: false }, paused: { exposed: true, value: false } },
  };
}

function sourceState() {
  return {
    commit: "f".repeat(40),
    files: Object.fromEntries(
      Object.entries(PINNED_SOURCE_BLOBS).map(([path, gitBlob]) => [
        path,
        { artifactMatchesWorkingTree: true, gitBlob, modifiedVsHead: false, sha256: "0".repeat(64) },
      ]),
    ),
  };
}

function ownershipProposed(owner, pendingOwner) {
  return { args: { owner, pendingOwner }, blockNumber: "100", event: "OwnershipProposed", logIndex: 1, transactionHash: TX_HASH };
}

function manifest({ expected = config(), primary = observation(config()), secondary = primary, source = sourceState() } = {}) {
  return buildManifest({
    config: expected,
    artifact,
    source,
    scopeGate: { status: 0, output: "ShadowFloatMainnet scope gate PASS" },
    address: ADDRESS,
    txHash: TX_HASH,
    observations: [primary, secondary],
  });
}

function failedIds(result) {
  return result.assertions.filter((entry) => entry.status === "FAIL").map((entry) => entry.id);
}

test("pinned proposed config parses cleanly", () => {
  const parsed = config();
  assert.equal(parsed.expectedChainId, 5_042_002n);
  assert.equal(parsed.maxima.perSpend, 2_000_000n);
  assert.equal(parsed.initial.protocolReserve, 25_000_000n);
  assert.equal(parsed.governanceDelay, 172_800n);
  assert.equal(parsed.proposedOwner, null);
});

test("every required env value is reported when missing", () => {
  const { errors } = parseConfig({});
  for (const key of Object.keys(PINNED_ENV)) {
    assert.ok(errors.includes(`${key} is required`), key);
  }
  assert.ok(!errors.some((error) => error.startsWith("FLOAT_MAINNET_PROPOSED_OWNER")));
});

test("a blank or zero proposed owner means none, matching the deploy script", () => {
  assert.equal(config({ FLOAT_MAINNET_PROPOSED_OWNER: "" }).proposedOwner, null);
  assert.equal(config({ FLOAT_MAINNET_PROPOSED_OWNER: zeroAddress }).proposedOwner, null);
  assert.equal(config({ FLOAT_MAINNET_PROPOSED_OWNER: OTHER.toLowerCase() }).proposedOwner, OTHER);
});

test("the expected deployer is optional for the preflight and required by the manifest", () => {
  const preflight = parseConfig(PINNED_ENV);
  assert.deepEqual(preflight.errors, []);
  assert.equal(preflight.config.expectedDeployer, null);
  assert.ok(parseConfig(PINNED_ENV, { requireDeployer: true }).errors.includes("FLOAT_MAINNET_EXPECTED_DEPLOYER is required"));
  assert.ok(
    parseConfig({ ...PINNED_ENV, FLOAT_MAINNET_EXPECTED_DEPLOYER: zeroAddress }, { requireDeployer: true }).errors.includes(
      "FLOAT_MAINNET_EXPECTED_DEPLOYER must not be the zero address",
    ),
  );
  assert.equal(config({ FLOAT_MAINNET_EXPECTED_DEPLOYER: DEPLOYER.toLowerCase() }).expectedDeployer, DEPLOYER);
});

test("the Arc testnet params example carries exactly the pinned FLOAT_MAINNET_* values", () => {
  const params = parseEnv(readFileSync(PARAMS_EXAMPLE, "utf8"));
  const pinnedKeys = Object.keys(PINNED_ENV).filter((key) => key.startsWith("FLOAT_MAINNET_"));
  assert.deepEqual(
    Object.keys(params).filter((key) => key.startsWith("FLOAT_MAINNET_")).sort(),
    [...pinnedKeys, "FLOAT_MAINNET_EXPECTED_DEPLOYER", "FLOAT_MAINNET_PROPOSED_OWNER"].sort(),
  );
  for (const key of pinnedKeys) assert.equal(params[key], PINNED_ENV[key], key);
  assert.deepEqual(parseConfig(params).errors, []);
});

test("config validation mirrors the constructor's _validateLimits rules", () => {
  assert.ok(errorsFor({ FLOAT_MAINNET_INIT_PER_SPEND: "2000001" }).includes(
    "FLOAT_MAINNET_INIT_PER_SPEND must be <= FLOAT_MAINNET_MAX_PER_SPEND",
  ));
  assert.ok(errorsFor({ FLOAT_MAINNET_INIT_LINE_RESERVE: "26000000", FLOAT_MAINNET_MAX_LINE_RESERVE: "30000000" }).includes(
    "FLOAT_MAINNET_INIT_LINE_RESERVE must be <= FLOAT_MAINNET_INIT_PROTOCOL_RESERVE",
  ));
  assert.ok(errorsFor({ FLOAT_MAINNET_MAX_PER_SPEND: "11000000" }).includes(
    "FLOAT_MAINNET_MAX_PER_SPEND must be <= FLOAT_MAINNET_MAX_LINE_RESERVE",
  ));
  assert.ok(errorsFor({ FLOAT_MAINNET_INIT_DAILY_SPEND: "0" }).includes("FLOAT_MAINNET_INIT_DAILY_SPEND must be nonzero"));
});

test("config validation rejects bad windows, delay, numbers, addresses and RPC pairs", () => {
  assert.ok(errorsFor({ FLOAT_MAINNET_MIN_REPAYMENT_WINDOW: "0" }).includes("FLOAT_MAINNET_MIN_REPAYMENT_WINDOW must be nonzero"));
  assert.ok(errorsFor({ FLOAT_MAINNET_MIN_REPAYMENT_WINDOW: "604801" }).includes(
    "FLOAT_MAINNET_MAX_REPAYMENT_WINDOW must be >= FLOAT_MAINNET_MIN_REPAYMENT_WINDOW",
  ));
  assert.ok(errorsFor({ FLOAT_MAINNET_GOVERNANCE_DELAY: "0" }).includes("FLOAT_MAINNET_GOVERNANCE_DELAY must be nonzero"));
  assert.ok(errorsFor({ FLOAT_MAINNET_GOVERNANCE_DELAY: (2n ** 64n).toString() }).includes("FLOAT_MAINNET_GOVERNANCE_DELAY exceeds uint64"));
  assert.ok(errorsFor({ FLOAT_MAINNET_MAX_PER_SPEND: "2e6" }).includes("FLOAT_MAINNET_MAX_PER_SPEND must be an unsigned decimal integer"));
  assert.ok(errorsFor({ FLOAT_MAINNET_USDC: zeroAddress }).includes("FLOAT_MAINNET_USDC must not be the zero address"));
  assert.ok(errorsFor({ FLOAT_MAINNET_PROPOSED_OWNER: "0x70997970C51812dc3A010C7d01b50e20d4dc79C8" }).includes(
    "FLOAT_MAINNET_PROPOSED_OWNER must be a checksummed or lowercase 20-byte address",
  ));
  assert.ok(errorsFor({ ARC_RPC_URL_2: "http://127.0.0.1:18546/" }).includes(
    "ARC_RPC_URL and ARC_RPC_URL_2 must be on two distinct hosts",
  ));
  assert.ok(errorsFor({ ARC_RPC_URL: "https://rpc.example/keyA", ARC_RPC_URL_2: "https://rpc.example/keyB" }).includes(
    "ARC_RPC_URL and ARC_RPC_URL_2 must be on two distinct hosts",
  ));
  assert.deepEqual(errorsFor({ ARC_RPC_URL: "http://127.0.0.1:18546", ARC_RPC_URL_2: "http://localhost:18546" }), []);
  assert.ok(errorsFor({ ARC_EXPLORER_URL: "ftp://explorer" }).includes("ARC_EXPLORER_URL must be an http(s) URL"));
});

test("the CLI entrypoint check falls back to argv when import.meta.main is undefined", () => {
  const self = fileURLToPath(import.meta.url);
  const preflight = new URL("./float-mainnet-preflight.mjs", import.meta.url).href;
  assert.equal(isEntrypoint({ main: undefined, url: import.meta.url }, ["node", self]), true);
  assert.equal(isEntrypoint({ main: undefined, url: preflight }, ["node", self]), false);
  assert.equal(isEntrypoint({ main: undefined, url: preflight }, ["node"]), false);
  assert.equal(isEntrypoint({ main: true, url: preflight }, ["node", self]), true);
  assert.equal(isEntrypoint({ main: false, url: import.meta.url }, ["node", self]), false);
});

test("the CLI entrypoint fallback resolves symlinked and junctioned paths", () => {
  const root = mkdtempSync(join(tmpdir(), "float-entry-"));
  try {
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "entry.mjs"), "");
    symlinkSync(real, join(root, "link"), "junction");
    const meta = { main: undefined, url: pathToFileURL(join(real, "entry.mjs")).href };
    assert.equal(isEntrypoint(meta, ["node", join(root, "link", "entry.mjs")]), true);
    assert.equal(isEntrypoint(meta, ["node", join(root, "link", "missing.mjs")]), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RPC URLs never print keys, paths or query strings", () => {
  assert.equal(redactUrl("https://arc-mainnet.g.alchemy.com/v2/SECRETKEY"), "https://arc-mainnet.g.alchemy.com/[redacted]");
  assert.equal(redactUrl("https://user:pass@rpc.example/?key=SECRET"), "https://rpc.example/[redacted]");
  assert.equal(redactUrl("https://rpc.testnet.arc.io"), "https://rpc.testnet.arc.io");
  const scrubbed = scrubUrls("HTTP request failed.\n\nURL: https://rpc.example/v2/SECRET?token=abc\nDetails: fetch failed");
  assert.ok(!scrubbed.includes("SECRET") && !scrubbed.includes("token"));
  assert.ok(scrubbed.includes("https://rpc.example/[redacted]"));
});

test("immutable masking hides exactly the immutable ranges", () => {
  const deployed = config();
  const code = runtimeWith(IMMUTABLE_GETTERS.map(([, value]) => value(deployed)));
  assert.notEqual(keccak256(code), keccak256(artifact.deployedBytecode.object));
  assert.equal(maskImmutables(code, artifact), maskImmutables(artifact.deployedBytecode.object, artifact));

  const tampered = flipByte(code, outsideImmutables());
  assert.notEqual(maskImmutables(tampered, artifact), maskImmutables(artifact.deployedBytecode.object, artifact));
});

test("immutable decoding checks slot consistency and the config multiset", () => {
  const deployed = config();
  const decoded = decodeImmutables(runtimeWith(IMMUTABLE_GETTERS.map(([, value]) => value(deployed))), artifact);
  assert.equal(decoded.length, IMMUTABLE_GETTERS.length);
  assert.ok(decoded.every((entry) => entry.consistent));
  assert.deepEqual(
    decoded.map((entry) => entry.value).sort(),
    IMMUTABLE_GETTERS.map(([, value]) => immutableWord(value(deployed))).sort(),
  );

  const [multiSlot] = decoded.filter((entry) => entry.offsets.length > 1);
  const offset = multiSlot.offsets[1];
  const code = runtimeWith(IMMUTABLE_GETTERS.map(([, value]) => value(deployed)));
  const split = flipByte(code, offset + 31);
  assert.equal(decodeImmutables(split, artifact).find((entry) => entry.astId === multiSlot.astId).consistent, false);
});

test("constructor args encode the config in constructor order", () => {
  const deployed = config();
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  const [usdc, chainId, maxima, initial, minimum, maximum, delay] = decodeAbiParameters(
    constructor.inputs,
    encodeConstructorArgs(artifact, deployed),
  );
  assert.equal(usdc, deployed.usdc);
  assert.equal(chainId, deployed.expectedChainId);
  assert.deepEqual(maxima, deployed.maxima);
  assert.deepEqual(initial, deployed.initial);
  assert.deepEqual([minimum, maximum, delay], [3600n, 604800n, 172800n]);
});

test("broadcast parsing takes the single plain CREATE and rejects CREATE2 or chain drift", () => {
  const create = { transactionType: "CREATE", contractName: "ShadowFloatMainnet", contractAddress: ADDRESS.toLowerCase(), hash: TX_HASH };
  const propose = { transactionType: "CALL", contractName: "ShadowFloatMainnet", contractAddress: ADDRESS.toLowerCase(), hash: BLOCK_HASH };
  const receipts = [
    { transactionHash: TX_HASH, contractAddress: ADDRESS.toLowerCase() },
    { transactionHash: BLOCK_HASH, contractAddress: null },
  ];
  assert.deepEqual(readBroadcast({ chain: 5042002, transactions: [create, propose], receipts }, 5_042_002n), {
    address: ADDRESS,
    txHash: TX_HASH,
  });
  assert.throws(
    () => readBroadcast({ chain: 5042002, transactions: [{ ...create, transactionType: "CREATE2" }], receipts }, 5_042_002n),
    /plain CREATE/,
  );
  assert.throws(() => readBroadcast({ chain: 5042, transactions: [create], receipts }, 5_042_002n), /does not match/);
  assert.throws(() => readBroadcast({ chain: 5042002, transactions: [create], receipts: [] }, 5_042_002n), /exactly one receipt/);
});

test("broadcast parsing trusts the creating receipt when forge swaps transaction hashes", () => {
  const swapped = {
    chain: 5042002,
    transactions: [
      { transactionType: "CREATE", contractName: "ShadowFloatMainnet", contractAddress: ADDRESS.toLowerCase(), hash: BLOCK_HASH },
      { transactionType: "CALL", contractName: "ShadowFloatMainnet", contractAddress: ADDRESS.toLowerCase(), hash: TX_HASH },
    ],
    receipts: [
      { transactionHash: TX_HASH, contractAddress: ADDRESS.toLowerCase() },
      { transactionHash: BLOCK_HASH, contractAddress: null },
    ],
  };
  assert.equal(readBroadcast(swapped, 5_042_002n).txHash, TX_HASH);
});

test("the existing zero-fee scope gate is reused, not duplicated", () => {
  const result = runScopeGate();
  assert.equal(result.status, 0);
  assert.match(result.output, /scope gate PASS/);
});

test("a correct deployment passes every assertion", () => {
  const result = manifest();
  assert.deepEqual(failedIds(result), []);
  assert.equal(result.ok, true);
  assert.equal(result.bytecode.onchainRuntimeMaskedKeccak256, result.bytecode.artifactRuntimeMaskedKeccak256);
  assert.deepEqual(result.observedAt, { blockHash: BLOCK_HASH, blockNumber: "100" });
  assert.deepEqual(result.pinnedLineage, { blobs: PINNED_SOURCE_BLOBS, commit: PINNED_SOURCE_COMMIT });
});

test("RPCs that observed different blocks disagree", () => {
  const drifted = observation(config());
  drifted.observedAt = { blockHash: `0x${"ef".repeat(32)}`, blockNumber: "100" };
  assert.deepEqual(failedIds(manifest({ secondary: drifted })), ["rpc.observationsIdenticalAcrossRpcs"]);
});

test("an identical deployment by anyone but the expected deployer fails", () => {
  const result = manifest({ expected: config({ FLOAT_MAINNET_EXPECTED_DEPLOYER: OTHER }) });
  assert.deepEqual(failedIds(result), ["deploy.senderIsExpectedDeployer", "state.ownerIsDeployer"]);
});

test("the pending owner must equal the configured proposed owner exactly", () => {
  const proposed = config({ FLOAT_MAINNET_PROPOSED_OWNER: OTHER });
  const handedOver = observation(proposed);
  handedOver.state.pendingOwner = OTHER;
  handedOver.events = [ownershipProposed(DEPLOYER, OTHER)];
  assert.deepEqual(failedIds(manifest({ expected: proposed, primary: handedOver })), []);

  assert.deepEqual(failedIds(manifest({ expected: proposed, primary: observation(proposed) })), [
    "state.pendingOwnerMatchesConfig",
    "events.onlyExpectedEventsSinceDeploy",
  ]);

  const unconfigured = observation(config());
  unconfigured.state.pendingOwner = OTHER;
  assert.deepEqual(failedIds(manifest({ primary: unconfigured })), ["state.pendingOwnerMatchesConfig"]);
});

test("only the deploy script's own OwnershipProposed event is allowed since deploy", () => {
  const proposed = config({ FLOAT_MAINNET_PROPOSED_OWNER: OTHER });
  const handedOver = observation(proposed);
  handedOver.state.pendingOwner = OTHER;
  const withEvents = (expected, events) => {
    const primary = structuredClone(handedOver);
    primary.events = events;
    return failedIds(manifest({ expected, primary }));
  };
  const queued = [
    { args: { kind: 0, oldValue: "25000000", newValue: "20000000" }, blockNumber: "101", event: "CapReduced", logIndex: 0, transactionHash: TX_HASH },
    { args: { operator: OTHER, allowed: false }, blockNumber: "101", event: "OperatorSet", logIndex: 1, transactionHash: TX_HASH },
    { args: { paused: false, actor: DEPLOYER }, blockNumber: "101", event: "SpendsPauseSet", logIndex: 2, transactionHash: TX_HASH },
  ];
  for (const event of queued) {
    assert.deepEqual(withEvents(proposed, [ownershipProposed(DEPLOYER, OTHER), event]), ["events.onlyExpectedEventsSinceDeploy"], event.event);
  }
  assert.deepEqual(withEvents(proposed, [ownershipProposed(DEPLOYER, THIRD)]), ["events.onlyExpectedEventsSinceDeploy"]);
  assert.deepEqual(withEvents(proposed, [ownershipProposed(DEPLOYER, OTHER), ownershipProposed(DEPLOYER, OTHER)]), [
    "events.onlyExpectedEventsSinceDeploy",
  ]);
  assert.deepEqual(withEvents(proposed, []), ["events.onlyExpectedEventsSinceDeploy"]);
  assert.deepEqual(withEvents(proposed, [ownershipProposed(OTHER, OTHER)]), ["events.onlyExpectedEventsSinceDeploy"]);
  assert.deepEqual(withEvents(config({ FLOAT_MAINNET_PROPOSED_OWNER: "" }), [ownershipProposed(DEPLOYER, OTHER)]), [
    "state.pendingOwnerMatchesConfig",
    "events.onlyExpectedEventsSinceDeploy",
  ]);
});

test("a Float holding USDC at the observed block fails the non-funding check", () => {
  const funded = observation(config());
  funded.state.floatUsdcBalance = "1";
  assert.deepEqual(failedIds(manifest({ primary: funded })), ["state.floatUsdcBalanceZero"]);
});

test("the pinned blobs are the git blobs at the pinned commit", (t) => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    git(["cat-file", "-e", `${PINNED_SOURCE_COMMIT}^{commit}`]);
  } catch {
    t.skip(`commit ${PINNED_SOURCE_COMMIT} is not in this clone (shallow checkout)`);
    return;
  }
  for (const [path, blob] of Object.entries(PINNED_SOURCE_BLOBS)) {
    assert.equal(git(["rev-parse", `${PINNED_SOURCE_COMMIT}:${path}`]), blob, path);
  }
});

test("the working tree hashes to the pinned git blobs", () => {
  const { files } = readSourceState(artifact);
  assert.deepEqual(Object.keys(files).sort(), Object.keys(PINNED_SOURCE_BLOBS).sort());
  assert.deepEqual(pinnedLineageMismatches(files), []);
});

test("a compiled source outside the pinned lineage fails", () => {
  const drifted = sourceState();
  drifted.files["contracts/src/ShadowFloatMainnet.sol"].gitBlob = "0".repeat(40);
  assert.deepEqual(failedIds(manifest({ source: drifted })), ["source.matchesPinnedLineage"]);

  const unpinned = sourceState();
  unpinned.files["contracts/src/Extra.sol"] = { ...unpinned.files["contracts/src/interfaces/IERC20.sol"] };
  assert.deepEqual(pinnedLineageMismatches(unpinned.files), ["contracts/src/Extra.sol"]);

  const missing = sourceState();
  delete missing.files["contracts/src/interfaces/IERC20.sol"];
  assert.deepEqual(pinnedLineageMismatches(missing.files), ["contracts/src/interfaces/IERC20.sol"]);
});

test("two runs produce a byte-identical manifest with no wall-clock data", () => {
  const first = stableStringify(manifest());
  const reordered = Object.fromEntries(Object.entries(observation(config())).reverse());
  const second = stableStringify(manifest({ primary: reordered, secondary: observation(config()) }));
  assert.equal(first, second);
  assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});

test("a wrong initial limit fails", () => {
  const result = manifest({ expected: config({ FLOAT_MAINNET_INIT_PER_SPEND: "999999" }) });
  assert.equal(result.ok, false);
  assert.ok(failedIds(result).includes("state.effectiveLimitsEqualInitialConfig"));
  assert.ok(failedIds(result).includes("deploy.inputIsArtifactCreationCodePlusConstructorArgs"));
});

test("a wrong owner fails", () => {
  const moved = observation(config());
  moved.state.owner = OTHER;
  const result = manifest({ primary: moved });
  assert.equal(result.ok, false);
  assert.ok(failedIds(result).includes("state.ownerIsDeployer"));
});

test("a wrong chain fails", () => {
  const wrongChain = observation(config());
  wrongChain.chainId = "5042";
  const result = manifest({ primary: wrongChain, secondary: wrongChain });
  assert.equal(result.ok, false);
  assert.deepEqual(failedIds(result), ["chain.idMatchesConfig"]);
});

test("enabled operators, sponsor allowlisting, pauses and RPC disagreement fail", () => {
  const touched = observation(config());
  touched.events = [
    { args: { operator: OTHER, allowed: true }, blockNumber: "101", event: "OperatorSet", logIndex: 0, transactionHash: TX_HASH },
    { args: { sponsor: OTHER, allowed: true }, blockNumber: "101", event: "SponsorAllowed", logIndex: 1, transactionHash: TX_HASH },
  ];
  touched.state.spendsPaused = true;
  const result = manifest({ primary: touched, secondary: observation(config()) });
  assert.deepEqual(failedIds(result), [
    "rpc.observationsIdenticalAcrossRpcs",
    "state.spendsNotPaused",
    "events.onlyExpectedEventsSinceDeploy",
  ]);
});

test("bytecode that differs outside the immutable slots fails", () => {
  const patched = observation(config());
  patched.code = flipByte(patched.code, outsideImmutables());
  const result = manifest({ primary: patched, secondary: patched });
  assert.deepEqual(failedIds(result), ["code.maskedRuntimeMatchesArtifact"]);
});
