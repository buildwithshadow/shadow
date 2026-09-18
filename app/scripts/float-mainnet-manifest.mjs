import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  isAddress,
  isHash,
  keccak256,
  pad,
  toHex,
  zeroAddress,
} from "viem";
import {
  EXPECTED_COMPILER,
  MAX_RUNTIME_BYTES,
  PINNED_SOURCE_BLOBS,
  PINNED_SOURCE_COMMIT,
  compilerSettings,
  contractsRoot,
  createRpc,
  errorMessage,
  isEntrypoint,
  loadArtifact,
  parseConfig,
  pinnedLineageMismatches,
  readOptional,
  readSourceState,
  runtimeBytes,
  sameJson,
  stableStringify,
  usdcAbi,
} from "./float-mainnet-preflight.mjs";

const MANIFEST_SCHEMA = "shadow-float-mainnet-release-manifest/v1";
export const IMMUTABLE_GETTERS = [
  ["usdc", (config) => config.usdc],
  ["deploymentChainId", (config) => config.expectedChainId],
  ["minimumRepaymentWindow", (config) => config.minimumRepaymentWindow],
  ["maximumRepaymentWindow", (config) => config.maximumRepaymentWindow],
  ["governanceDelay", (config) => config.governanceDelay],
  ["maximumProtocolReserve", (config) => config.maxima.protocolReserve],
  ["maximumLineReserve", (config) => config.maxima.lineReserve],
  ["maximumLineSpend", (config) => config.maxima.lineSpend],
  ["maximumPerSpend", (config) => config.maxima.perSpend],
  ["maximumDailySpend", (config) => config.maxima.dailySpend],
];
const STATE_GETTERS = ["owner", "pendingOwner", "openingsPaused", "spendsPaused", "totalCommittedCapital", "totalSponsorObligations"];
const LOG_CHUNK_BLOCKS = 5_000n;
const scopeGatePath = resolve(contractsRoot, "test/mainnet-scope.test.mjs");

export function immutableRanges(artifact) {
  return Object.entries(artifact.deployedBytecode.immutableReferences)
    .flatMap(([astId, references]) => references.map(({ start, length }) => ({ astId, start, length })))
    .sort((a, b) => a.start - b.start);
}

export function maskImmutables(code, artifact) {
  let hex = code.toLowerCase().replace(/^0x/, "");
  for (const { start, length } of immutableRanges(artifact)) {
    hex = hex.slice(0, start * 2) + "0".repeat(length * 2) + hex.slice((start + length) * 2);
  }
  return `0x${hex}`;
}

// AST ids differ between compilation units, so values are attributed to names
// through the on-chain getters, not through the astId keys.
export function decodeImmutables(code, artifact) {
  const hex = code.toLowerCase().replace(/^0x/, "");
  return Object.entries(artifact.deployedBytecode.immutableReferences)
    .map(([astId, references]) => {
      const words = references.map(({ start, length }) => `0x${hex.slice(start * 2, (start + length) * 2)}`);
      return {
        astId,
        consistent: words.every((word) => word === words[0]),
        offsets: references.map(({ start }) => start),
        value: words[0],
      };
    })
    .sort((a, b) => Number(a.astId) - Number(b.astId));
}

export function immutableWord(value) {
  return typeof value === "string" ? pad(value.toLowerCase(), { size: 32 }) : toHex(value, { size: 32 });
}

export function encodeConstructorArgs(artifact, config) {
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  return encodeAbiParameters(constructor.inputs, [
    config.usdc,
    config.expectedChainId,
    config.maxima,
    config.initial,
    config.minimumRepaymentWindow,
    config.maximumRepaymentWindow,
    config.governanceDelay,
  ]);
}

export function readBroadcast(run, expectedChainId) {
  if (run.chain !== undefined && BigInt(run.chain) !== expectedChainId) {
    throw new Error(`broadcast chain ${run.chain} does not match FLOAT_MAINNET_EXPECTED_CHAIN_ID ${expectedChainId}`);
  }
  const deployments = (run.transactions ?? []).filter(
    (tx) => tx.contractName === "ShadowFloatMainnet" && tx.transactionType !== "CALL",
  );
  if (deployments.length !== 1 || deployments[0].transactionType !== "CREATE") {
    const found = deployments.map((tx) => tx.transactionType).join(", ") || "none";
    throw new Error(`broadcast must contain exactly one plain CREATE of ShadowFloatMainnet; found ${found}`);
  }
  // Forge can attach the wrong hash to a transactions[] entry when several
  // transactions land in one block; the receipt that created the address is authoritative.
  const address = getAddress(deployments[0].contractAddress);
  const receipts = (run.receipts ?? []).filter(
    (receipt) => receipt.contractAddress && getAddress(receipt.contractAddress) === address,
  );
  if (receipts.length !== 1) {
    throw new Error(`broadcast must contain exactly one receipt creating ${address}; found ${receipts.length}`);
  }
  return { address, txHash: receipts[0].transactionHash };
}

export function runScopeGate() {
  const result = spawnSync(process.execPath, [scopeGatePath], { encoding: "utf8" });
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    status: result.status,
    output: lines.find((line) => /scope gate PASS|Error/.test(line)) ?? lines.join(" "),
  };
}

async function observeDeployment(rpc, { artifact, address, txHash, blockNumber, usdc }) {
  const { client, read } = rpc;
  const contract = (functionName) =>
    read(`ShadowFloatMainnet.${functionName}`, () =>
      client.readContract({ address, abi: artifact.abi, functionName, blockNumber }),
    );

  const chainId = await read("eth_chainId", () => client.getChainId());
  const transaction = await read("deploy transaction", () => client.getTransaction({ hash: txHash }));
  const receipt = await read("deploy receipt", () => client.getTransactionReceipt({ hash: txHash }));
  const block = await read("deploy block", () => client.getBlock({ blockNumber: receipt.blockNumber }));
  const observed = await read("observation block", () => client.getBlock({ blockNumber }));
  const code = (await read("runtime code", () => client.getCode({ address, blockNumber }))) ?? "0x";

  const state = {};
  for (const [name] of IMMUTABLE_GETTERS) state[name] = await contract(name);
  for (const name of STATE_GETTERS) state[name] = await contract(name);
  const [protocolReserve, lineReserve, lineSpend, perSpend, dailySpend] = await contract("effectiveLimits");
  state.effectiveLimits = { protocolReserve, lineReserve, lineSpend, perSpend, dailySpend };

  const events = [];
  for (let from = receipt.blockNumber; from <= blockNumber; from += LOG_CHUNK_BLOCKS) {
    const to = from + LOG_CHUNK_BLOCKS - 1n < blockNumber ? from + LOG_CHUNK_BLOCKS - 1n : blockNumber;
    const logs = await read(`logs ${from}-${to}`, () => client.getLogs({ address, fromBlock: from, toBlock: to }));
    for (const log of logs) {
      const decoded = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics });
      events.push({
        args: decoded.args,
        blockNumber: log.blockNumber,
        event: decoded.eventName,
        logIndex: log.logIndex,
        transactionHash: log.transactionHash,
      });
    }
  }

  const token = (functionName, args = []) => ({ address: usdc, abi: usdcAbi, functionName, args, blockNumber });
  const usdcRestrictions = {
    floatBlacklisted: await readOptional(rpc, "USDC.isBlacklisted", token("isBlacklisted", [address])),
    paused: await readOptional(rpc, "USDC.paused", token("paused")),
  };
  state.floatUsdcBalance = await read("USDC.balanceOf", () => client.readContract(token("balanceOf", [address])));

  return JSON.parse(
    stableStringify({
      block: { hash: block.hash, number: block.number, timestamp: block.timestamp },
      chainId: BigInt(chainId),
      code: code.toLowerCase(),
      events,
      observedAt: { blockHash: observed.hash, blockNumber: observed.number },
      receipt: {
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
        contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : null,
        status: receipt.status,
      },
      state,
      transaction: {
        blockHash: transaction.blockHash,
        blockNumber: transaction.blockNumber,
        from: getAddress(transaction.from),
        hash: transaction.hash,
        input: transaction.input.toLowerCase(),
        nonce: transaction.nonce,
        to: transaction.to ? getAddress(transaction.to) : null,
      },
      usdcRestrictions,
    }),
  );
}

export function buildManifest({ config, artifact, source, scopeGate, address, txHash, observations }) {
  const assertions = [];
  const assert = (id, pass, detail) => assertions.push({ id, status: pass ? "PASS" : "FAIL", detail: String(detail) });
  const manual = (id, detail) => assertions.push({ id, status: "MANUAL", detail });

  const [primary, secondary] = observations;
  const { transaction, receipt, state, events, usdcRestrictions } = primary;
  const expectedChainId = config.expectedChainId.toString();
  const constructorArgs = encodeConstructorArgs(artifact, config);
  const artifactRuntime = artifact.deployedBytecode.object.toLowerCase();
  const onchainRuntime = primary.code;
  const artifactMaskedHash = keccak256(maskImmutables(artifactRuntime, artifact));
  const onchainMaskedHash = keccak256(maskImmutables(onchainRuntime, artifact));
  const immutables = decodeImmutables(onchainRuntime, artifact);
  const decodedWords = immutables.map((entry) => entry.value).sort();
  const expectedWords = IMMUTABLE_GETTERS.map(([, value]) => immutableWord(value(config))).sort();
  const expectedInput = `${artifact.bytecode.object}${constructorArgs.slice(2)}`.toLowerCase();
  const expectedPendingOwner = config.proposedOwner ?? zeroAddress;
  // The only permitted contract event since deploy is the script's own proposeOwner.
  const unexpectedEvents = events.filter(
    (entry) =>
      !(
        config.proposedOwner &&
        entry.event === "OwnershipProposed" &&
        entry.args.owner === config.expectedDeployer &&
        entry.args.pendingOwner === config.proposedOwner
      ),
  );
  const lineageMismatches = pinnedLineageMismatches(source.files);

  const divergent = Object.keys(primary).filter((key) => !sameJson(primary[key], secondary[key]));
  assert("rpc.observationsIdenticalAcrossRpcs", divergent.length === 0, divergent.join(",") || "identical");
  assert(
    "chain.idMatchesConfig",
    observations.every((observation) => observation.chainId === expectedChainId),
    `${observations.map((observation) => observation.chainId).join(" / ")} (expected ${expectedChainId})`,
  );
  assert("deploy.receiptSucceeded", receipt.status === "success", receipt.status);
  assert(
    "deploy.senderIsExpectedDeployer",
    transaction.from === config.expectedDeployer,
    `${transaction.from} (expected ${config.expectedDeployer})`,
  );
  assert("deploy.plainCreateTransaction", transaction.to === null, `to=${transaction.to}`);
  assert("deploy.receiptContractAddressMatches", receipt.contractAddress === address, `${receipt.contractAddress} (expected ${address})`);
  assert(
    "deploy.addressDerivesFromDeployerNonce",
    getContractAddress({ from: transaction.from, nonce: BigInt(transaction.nonce) }) === address,
    `${transaction.from} nonce ${transaction.nonce}`,
  );
  assert(
    "deploy.inputIsArtifactCreationCodePlusConstructorArgs",
    transaction.input === expectedInput,
    `${(transaction.input.length - 2) / 2} input bytes (expected ${(expectedInput.length - 2) / 2})`,
  );
  assert(
    "code.runtimeLengthMatchesArtifact",
    onchainRuntime.length === artifactRuntime.length,
    `${(onchainRuntime.length - 2) / 2} bytes on-chain, ${runtimeBytes(artifact)} in artifact`,
  );
  assert("code.maskedRuntimeMatchesArtifact", onchainMaskedHash === artifactMaskedHash, `${onchainMaskedHash} vs ${artifactMaskedHash}`);
  assert(
    "code.immutableSlotsInternallyConsistent",
    immutables.every((entry) => entry.consistent),
    immutables.filter((entry) => !entry.consistent).map((entry) => entry.astId).join(",") || `${immutables.length} immutables`,
  );
  assert("code.immutableValuesMatchConfig", sameJson(decodedWords, expectedWords), `${decodedWords.length} decoded words`);
  for (const [name, value] of IMMUTABLE_GETTERS) {
    const expected = value(config).toString();
    assert(`immutable.${name}`, String(state[name]) === expected, `${state[name]} (expected ${expected})`);
  }
  assert(
    "state.effectiveLimitsEqualInitialConfig",
    sameJson(state.effectiveLimits, config.initial),
    `${JSON.stringify(state.effectiveLimits)} (expected ${stableStringify(config.initial).replace(/\s+/g, "")})`,
  );
  assert("state.ownerIsDeployer", state.owner === config.expectedDeployer, `${state.owner} (expected deployer ${config.expectedDeployer})`);
  assert(
    "state.pendingOwnerMatchesConfig",
    state.pendingOwner === expectedPendingOwner,
    `${state.pendingOwner} (expected ${expectedPendingOwner})`,
  );
  assert("state.openingsNotPaused", state.openingsPaused === false, state.openingsPaused);
  assert("state.spendsNotPaused", state.spendsPaused === false, state.spendsPaused);
  assert(
    "state.totalsZero",
    state.totalCommittedCapital === "0" && state.totalSponsorObligations === "0",
    `committed=${state.totalCommittedCapital} obligations=${state.totalSponsorObligations}`,
  );
  assert("state.floatUsdcBalanceZero", state.floatUsdcBalance === "0", `balance=${state.floatUsdcBalance}`);
  assert(
    "events.onlyExpectedEventsSinceDeploy",
    unexpectedEvents.length === 0 && events.length === (config.proposedOwner ? 1 : 0),
    unexpectedEvents.length
      ? `unexpected: ${unexpectedEvents.map((entry) => `${entry.event}@${entry.blockNumber}`).join(", ")}`
      : `${events.length} OwnershipProposed(deployer, proposed owner)`,
  );
  if (usdcRestrictions.paused.exposed) {
    assert("usdc.notPaused", usdcRestrictions.paused.value === false, usdcRestrictions.paused.value);
  } else {
    manual("usdc.notPaused", "token exposes no paused(); confirm pause semantics from the issuer's documentation");
  }
  if (usdcRestrictions.floatBlacklisted.exposed) {
    assert("usdc.floatNotBlacklisted", usdcRestrictions.floatBlacklisted.value === false, usdcRestrictions.floatBlacklisted.value);
  } else {
    manual("usdc.floatNotBlacklisted", "token exposes no isBlacklisted(address); confirm restriction semantics from the issuer's documentation");
  }
  assert("scope.zeroFeeAbiGate", scopeGate.status === 0, scopeGate.output);
  assert(
    "source.artifactBuiltFromWorkingTree",
    Object.values(source.files).every((file) => file.artifactMatchesWorkingTree),
    Object.keys(source.files).join(", "),
  );
  assert(
    "source.unmodifiedVsHead",
    Object.values(source.files).every((file) => !file.modifiedVsHead),
    `HEAD ${source.commit}`,
  );
  assert(
    "source.matchesPinnedLineage",
    lineageMismatches.length === 0,
    lineageMismatches.length ? `git blob differs from the pin: ${lineageMismatches.join(", ")}` : `pinned at ${PINNED_SOURCE_COMMIT}`,
  );
  assert("artifact.compilerSettings", sameJson(compilerSettings(artifact), EXPECTED_COMPILER), stableStringify(compilerSettings(artifact)).replace(/\s+/g, ""));
  assert("artifact.runtimeWithinSizeLimit", runtimeBytes(artifact) <= MAX_RUNTIME_BYTES, `${runtimeBytes(artifact)} <= ${MAX_RUNTIME_BYTES}`);

  return {
    assertions,
    bytecode: {
      artifactRuntimeMaskedKeccak256: artifactMaskedHash,
      immutables,
      onchainRuntimeKeccak256: keccak256(onchainRuntime),
      onchainRuntimeMaskedKeccak256: onchainMaskedHash,
      runtimeBytes: runtimeBytes(artifact),
    },
    chainId: expectedChainId,
    compiler: compilerSettings(artifact),
    config: {
      expectedChainId: config.expectedChainId,
      expectedDeployer: config.expectedDeployer,
      governanceDelay: config.governanceDelay,
      initial: config.initial,
      maxima: config.maxima,
      maximumRepaymentWindow: config.maximumRepaymentWindow,
      minimumRepaymentWindow: config.minimumRepaymentWindow,
      proposedOwner: config.proposedOwner,
      usdc: config.usdc,
    },
    constructorArgs,
    contract: {
      address,
      name: "ShadowFloatMainnet",
      source: "contracts/src/ShadowFloatMainnet.sol:ShadowFloatMainnet",
    },
    deployment: {
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: primary.block.timestamp,
      deployer: transaction.from,
      nonce: transaction.nonce,
      txHash,
    },
    events,
    observedAt: primary.observedAt,
    ok: assertions.every((entry) => entry.status !== "FAIL"),
    pinnedLineage: { blobs: PINNED_SOURCE_BLOBS, commit: PINNED_SOURCE_COMMIT },
    schema: MANIFEST_SCHEMA,
    scopeGate: scopeGate.output,
    source,
    state,
    usdcRestrictions,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      address: { type: "string" },
      tx: { type: "string" },
      broadcast: { type: "string" },
      block: { type: "string" },
    },
  });
  const byBroadcast = values.broadcast !== undefined;
  if (!values.out || (byBroadcast ? values.address || values.tx : !values.address || !values.tx)) {
    throw new Error(
      "usage: node app/scripts/float-mainnet-manifest.mjs --out <manifest.json> (--broadcast <run-latest.json> | --address <0x..> --tx <0x..>) [--block <n>]",
    );
  }

  const { config, errors } = parseConfig(process.env, { requireDeployer: true });
  if (errors.length) throw new Error(`invalid env config: ${errors.join("; ")}`);
  const deployment = byBroadcast
    ? readBroadcast(JSON.parse(readFileSync(values.broadcast, "utf8")), config.expectedChainId)
    : { address: values.address, txHash: values.tx };
  if (!isAddress(deployment.address, { strict: false })) throw new Error(`invalid deployed address ${deployment.address}`);
  if (!isHash(deployment.txHash)) throw new Error(`invalid deploy tx hash ${deployment.txHash}`);
  if (values.block !== undefined && !/^\d+$/.test(values.block)) throw new Error("--block must be a block number");
  const address = getAddress(deployment.address);
  const txHash = deployment.txHash.toLowerCase();

  const artifact = loadArtifact();
  const rpcs = config.rpcUrls.map((url, index) => createRpc(url, `rpc${index + 1}`));
  const heads = await Promise.all(rpcs.map((rpc) => rpc.read("eth_blockNumber", () => rpc.client.getBlockNumber())));
  const slowestHead = heads[0] < heads[1] ? heads[0] : heads[1];
  const blockNumber = values.block === undefined ? slowestHead : BigInt(values.block);
  if (blockNumber > slowestHead) throw new Error(`--block ${blockNumber} is ahead of the slower RPC head ${slowestHead}`);
  console.error(`reading deployment state at block ${blockNumber} from ${rpcs.map((rpc) => rpc.name).join(" and ")}`);

  const observations = await Promise.all(
    rpcs.map((rpc) => observeDeployment(rpc, { artifact, address, txHash, blockNumber, usdc: config.usdc })),
  );
  const manifest = buildManifest({
    config,
    artifact,
    source: readSourceState(artifact),
    scopeGate: runScopeGate(),
    address,
    txHash,
    observations,
  });
  writeFileSync(values.out, `${stableStringify(manifest)}\n`);

  const summary = {
    ok: manifest.ok,
    out: values.out,
    assertions: manifest.assertions.length,
    failed: manifest.assertions.filter((entry) => entry.status === "FAIL"),
    manual: manifest.assertions.filter((entry) => entry.status === "MANUAL"),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!manifest.ok) process.exit(1);
}

if (isEntrypoint(import.meta)) {
  main().catch((error) => {
    console.error(`manifest aborted: ${errorMessage(error)}`);
    process.exit(1);
  });
}
