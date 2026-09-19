import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToBytes,
  toBytes,
  zeroAddress,
} from "viem";
import { createRpcReadQueue } from "./rpc-read-queue.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const contractsRoot = resolve(repoRoot, "contracts");
const artifactPath = resolve(contractsRoot, "out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json");
export const MAX_RUNTIME_BYTES = 18_432;
export const EXPECTED_COMPILER = {
  version: "0.8.24+commit.e11b9ed9",
  settings: {
    evmVersion: "cancun",
    metadata: { appendCBOR: false, bytecodeHash: "none" },
    optimizer: { enabled: true, runs: 1 },
    viaIR: true,
  },
};
// The reviewed source lineage. Changing the contract means consciously moving
// these pins after review and pilot revalidation (runbook section 2).
export const PINNED_SOURCE_COMMIT = "2ebae7f63f6bdeed7ec9ad522f680af7b91b62ec";
export const PINNED_SOURCE_BLOBS = {
  "contracts/src/ShadowFloatMainnet.sol": "27964464803f73c7f451ad12e85a2bce5c6c4691",
  "contracts/src/interfaces/IERC20.sol": "20179c34a546c745efaa371ee2984e8dbcac60e4",
};
const LIMIT_FIELDS = [
  ["protocolReserve", "PROTOCOL_RESERVE"],
  ["lineReserve", "LINE_RESERVE"],
  ["lineSpend", "LINE_SPEND"],
  ["perSpend", "PER_SPEND"],
  ["dailySpend", "DAILY_SPEND"],
];
export const usdcAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function paused() view returns (bool)",
  "function isBlacklisted(address account) view returns (bool)",
  "function blacklister() view returns (address)",
  "function pauser() view returns (address)",
]);

const MAX_HEAD_LAG_BLOCKS = 64n;
const HASH_CHECK_DEPTH = 10n;
// Circle FiatTokenProxy (AdminUpgradeabilityProxy) implementation slot.
const FIAT_TOKEN_PROXY_IMPLEMENTATION_SLOT = keccak256(toBytes("org.zeppelinos.proxy.implementation"));
const ARC_EVM_DIFFERENCES = "https://docs.arc.io/arc/references/evm-differences";
const ARC_CONTRACT_ADDRESSES = "https://docs.arc.io/arc/references/contract-addresses";
const ARC_CONNECT = "https://docs.arc.io/arc/references/connect-to-arc";

// The preflight runs before the deployer is named; the manifest requires it.
export function parseConfig(env, { requireDeployer = false } = {}) {
  const errors = [];

  const uint = (key, bits) => {
    const raw = env[key]?.trim();
    if (!raw) {
      errors.push(`${key} is required`);
      return null;
    }
    if (!/^\d+$/.test(raw)) {
      errors.push(`${key} must be an unsigned decimal integer`);
      return null;
    }
    const value = BigInt(raw);
    if (value >= 2n ** BigInt(bits)) {
      errors.push(`${key} exceeds uint${bits}`);
      return null;
    }
    return value;
  };

  const address = (key, required) => {
    const raw = env[key]?.trim();
    if (!raw) {
      if (required) errors.push(`${key} is required`);
      return null;
    }
    if (!isAddress(raw)) {
      errors.push(`${key} must be a checksummed or lowercase 20-byte address`);
      return null;
    }
    if (getAddress(raw) === zeroAddress) {
      if (required) errors.push(`${key} must not be the zero address`);
      return null;
    }
    return getAddress(raw);
  };

  const url = (key) => {
    const raw = env[key]?.trim();
    if (!raw) {
      errors.push(`${key} is required`);
      return null;
    }
    if (!URL.canParse(raw) || !["http:", "https:"].includes(new URL(raw).protocol)) {
      errors.push(`${key} must be an http(s) URL`);
      return null;
    }
    return raw;
  };

  const limits = (prefix) =>
    Object.fromEntries(
      LIMIT_FIELDS.map(([field, suffix]) => [field, uint(`FLOAT_MAINNET_${prefix}_${suffix}`, 256)]),
    );

  const config = {
    expectedChainId: uint("FLOAT_MAINNET_EXPECTED_CHAIN_ID", 256),
    usdc: address("FLOAT_MAINNET_USDC", true),
    maxima: limits("MAX"),
    initial: limits("INIT"),
    minimumRepaymentWindow: uint("FLOAT_MAINNET_MIN_REPAYMENT_WINDOW", 64),
    maximumRepaymentWindow: uint("FLOAT_MAINNET_MAX_REPAYMENT_WINDOW", 64),
    governanceDelay: uint("FLOAT_MAINNET_GOVERNANCE_DELAY", 64),
    proposedOwner: address("FLOAT_MAINNET_PROPOSED_OWNER", false),
    expectedDeployer: address("FLOAT_MAINNET_EXPECTED_DEPLOYER", requireDeployer),
    rpcUrls: [url("ARC_RPC_URL"), url("ARC_RPC_URL_2")],
    explorerUrl: url("ARC_EXPLORER_URL"),
  };

  if (config.expectedChainId === 0n) errors.push("FLOAT_MAINNET_EXPECTED_CHAIN_ID must be nonzero");
  validateLimits("MAX", config.maxima, config.maxima, errors);
  validateLimits("INIT", config.initial, config.maxima, errors);
  if (config.minimumRepaymentWindow === 0n) errors.push("FLOAT_MAINNET_MIN_REPAYMENT_WINDOW must be nonzero");
  if (
    config.minimumRepaymentWindow !== null &&
    config.maximumRepaymentWindow !== null &&
    config.maximumRepaymentWindow < config.minimumRepaymentWindow
  ) {
    errors.push("FLOAT_MAINNET_MAX_REPAYMENT_WINDOW must be >= FLOAT_MAINNET_MIN_REPAYMENT_WINDOW");
  }
  if (config.governanceDelay === 0n) errors.push("FLOAT_MAINNET_GOVERNANCE_DELAY must be nonzero");
  const [primaryRpc, secondaryRpc] = config.rpcUrls;
  if (primaryRpc && secondaryRpc && new URL(primaryRpc).hostname === new URL(secondaryRpc).hostname) {
    errors.push("ARC_RPC_URL and ARC_RPC_URL_2 must be on two distinct hosts");
  }

  return { config, errors };
}

// Mirrors ShadowFloatMainnet._validateLimits(value, maxima).
function validateLimits(prefix, value, maxima, errors) {
  const parsed = Object.values(value).every((entry) => entry !== null) && Object.values(maxima).every((entry) => entry !== null);
  if (!parsed) return;
  for (const [field, suffix] of LIMIT_FIELDS) {
    if (value[field] === 0n) errors.push(`FLOAT_MAINNET_${prefix}_${suffix} must be nonzero`);
    if (value[field] > maxima[field]) {
      errors.push(`FLOAT_MAINNET_${prefix}_${suffix} must be <= FLOAT_MAINNET_MAX_${suffix}`);
    }
  }
  if (value.lineReserve > value.protocolReserve) {
    errors.push(`FLOAT_MAINNET_${prefix}_LINE_RESERVE must be <= FLOAT_MAINNET_${prefix}_PROTOCOL_RESERVE`);
  }
  if (value.perSpend > value.lineReserve) {
    errors.push(`FLOAT_MAINNET_${prefix}_PER_SPEND must be <= FLOAT_MAINNET_${prefix}_LINE_RESERVE`);
  }
}

export function redactUrl(value) {
  if (!URL.canParse(value)) return "[unparseable url]";
  const url = new URL(value);
  const hidden = url.username || url.password || url.search || url.hash || url.pathname !== "/";
  return `${url.protocol}//${url.host}${hidden ? "/[redacted]" : ""}`;
}

export function scrubUrls(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/g, (match) => redactUrl(match));
}

export function createRpc(url, label) {
  const name = `${label} ${redactUrl(url)}`;
  const client = createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 0 }) });
  const read = createRpcReadQueue({
    spacingMs: 100,
    onRetry: ({ label: readLabel, attempt, maxAttempts, delayMs, error }) => {
      console.error(
        `transient RPC read failure on ${name} for ${readLabel}; retry ${attempt + 1}/${maxAttempts} in ${delayMs}ms: ${errorMessage(error)}`,
      );
    },
  });
  return { name, client, read };
}

export async function readOptional(rpc, label, request) {
  try {
    return { exposed: true, value: await rpc.read(label, () => rpc.client.readContract(request)) };
  } catch (error) {
    const missing =
      error instanceof BaseError &&
      error.walk((cause) => cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError);
    if (missing) return { exposed: false, value: null };
    throw error;
  }
}

export function errorMessage(error) {
  const message = error && typeof error === "object" ? error.shortMessage || error.message || error.details : error;
  return scrubUrls(message || "unknown error");
}

export function loadArtifact() {
  if (!existsSync(artifactPath)) {
    throw new Error("missing contracts/out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json; run forge build --root contracts");
  }
  return JSON.parse(readFileSync(artifactPath, "utf8"));
}

export function compilerSettings(artifact) {
  const { compiler, settings } = artifact.metadata;
  return {
    version: compiler.version,
    settings: {
      evmVersion: settings.evmVersion,
      metadata: { appendCBOR: settings.metadata?.appendCBOR, bytecodeHash: settings.metadata?.bytecodeHash },
      optimizer: settings.optimizer,
      viaIR: settings.viaIR === true,
    },
  };
}

export function runtimeBytes(artifact) {
  return (artifact.deployedBytecode.object.length - 2) / 2;
}

// git gets no GIT_* variable (GIT_DIR, GIT_INDEX_FILE, ...) that could point it
// at another repository or index. Windows variable names are case-insensitive.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

// Forge compiles LF-normalized sources, so hashes are line-ending independent.
export function readSourceState(artifact) {
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env: gitEnv }).trim();
  const files = {};
  for (const [path, meta] of Object.entries(artifact.metadata.sources)) {
    const content = readFileSync(resolve(contractsRoot, path), "utf8").replace(/\r\n/g, "\n");
    files[`contracts/${path}`] = {
      artifactMatchesWorkingTree: keccak256(stringToBytes(content)) === meta.keccak256,
      gitBlob: createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex"),
      modifiedVsHead: git(["status", "--porcelain", "--", `contracts/${path}`]) !== "",
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }
  return { commit: git(["rev-parse", "HEAD"]), files };
}

// Paths whose compiled git blob differs from PINNED_SOURCE_BLOBS, including a
// compiled source without a pin and a pinned source that was not compiled.
export function pinnedLineageMismatches(files) {
  const paths = new Set([...Object.keys(files), ...Object.keys(PINNED_SOURCE_BLOBS)]);
  return [...paths].sort().filter((path) => files[path]?.gitBlob !== PINNED_SOURCE_BLOBS[path]);
}

// import.meta.main exists from Node 24.2; older Node leaves it undefined. Node
// resolves symlinks in the main module's URL, so compare real paths.
export function isEntrypoint(meta, argv = process.argv) {
  if (meta.main !== undefined) return meta.main;
  return argv[1] !== undefined && existsSync(argv[1]) && realpathSync(argv[1]) === realpathSync(fileURLToPath(meta.url));
}

export function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

export function sameJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}

async function observeRpc(rpc, config) {
  const { client, read } = rpc;
  const chainId = await read("eth_chainId", () => client.getChainId());
  const head = await read("eth_blockNumber", () => client.getBlockNumber());
  const code = (await read("USDC code", () => client.getCode({ address: config.usdc }))) ?? "0x";
  const observation = { chainId: BigInt(chainId), head, usdcCodeHash: keccak256(code), usdcCodeBytes: (code.length - 2) / 2 };
  if (code === "0x") return observation;

  const token = (functionName, args = []) => ({ address: config.usdc, abi: usdcAbi, functionName, args });
  observation.decimals = await read("USDC.decimals", () => client.readContract(token("decimals")));
  observation.symbol = await read("USDC.symbol", () => client.readContract(token("symbol")));
  const slot = await read("USDC implementation slot", () =>
    client.getStorageAt({ address: config.usdc, slot: FIAT_TOKEN_PROXY_IMPLEMENTATION_SLOT }),
  );
  observation.implementation = slot && BigInt(slot) !== 0n ? getAddress(`0x${slot.slice(-40)}`) : null;
  observation.paused = await readOptional(rpc, "USDC.paused", token("paused"));
  observation.blacklisted = {};
  for (const account of [config.expectedDeployer, config.proposedOwner].filter(Boolean)) {
    observation.blacklisted[account] = await readOptional(rpc, "USDC.isBlacklisted", token("isBlacklisted", [account]));
  }
  observation.blacklister = await readOptional(rpc, "USDC.blacklister", token("blacklister"));
  observation.pauser = await readOptional(rpc, "USDC.pauser", token("pauser"));
  return observation;
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function main() {
  const checks = [];
  const pass = (check, ok, detail = "") => checks.push({ check, status: ok ? "PASS" : "FAIL", detail: String(detail) });
  const manual = (check, detail) => checks.push({ check, status: "MANUAL", detail });

  const { config, errors } = parseConfig(process.env);
  pass(
    "env config is complete and satisfies the constructor rules",
    errors.length === 0,
    errors.join("; ") || "all FLOAT_MAINNET_* and ARC_* values present and valid; RPC URLs on distinct hosts",
  );

  const report = {
    mode: "shadow-float-mainnet-preflight",
    checkedAt: new Date().toISOString(),
    config: {
      expectedChainId: config.expectedChainId,
      usdc: config.usdc,
      maxima: config.maxima,
      initial: config.initial,
      minimumRepaymentWindow: config.minimumRepaymentWindow,
      maximumRepaymentWindow: config.maximumRepaymentWindow,
      governanceDelay: config.governanceDelay,
      proposedOwner: config.proposedOwner,
      expectedDeployer: config.expectedDeployer,
      rpcs: config.rpcUrls.map((url) => url && redactUrl(url)),
      explorer: config.explorerUrl && redactUrl(config.explorerUrl),
    },
  };

  let commonHeight = null;
  const blockHashes = [];
  if (config.rpcUrls.every(Boolean) && config.expectedChainId !== null && config.usdc) {
    const rpcs = config.rpcUrls.map((url, index) => createRpc(url, `rpc${index + 1}`));
    const observations = await Promise.all(
      rpcs.map((rpc) =>
        observeRpc(rpc, config).catch((error) => ({ error: errorMessage(error) })),
      ),
    );
    report.rpcs = rpcs.map((rpc, index) => ({ name: rpc.name, ...observations[index] }));

    rpcs.forEach((rpc, index) => {
      const observed = observations[index];
      if (observed.error) {
        pass(`${rpc.name}: read-only RPC observation`, false, observed.error);
        return;
      }
      pass(`${rpc.name}: chainId equals FLOAT_MAINNET_EXPECTED_CHAIN_ID`, observed.chainId === config.expectedChainId, observed.chainId);
      pass(`${rpc.name}: USDC has code`, observed.usdcCodeBytes > 0, `${observed.usdcCodeBytes} bytes`);
      if (observed.usdcCodeBytes === 0) return;
      pass(`${rpc.name}: USDC decimals() == 6`, observed.decimals === 6, observed.decimals);
      pass(`${rpc.name}: USDC symbol() == "USDC"`, observed.symbol === "USDC", observed.symbol);
      if (observed.paused.exposed) {
        pass(`${rpc.name}: USDC paused() == false`, observed.paused.value === false, observed.paused.value);
      } else {
        manual(`${rpc.name}: USDC pause state`, "token exposes no paused(); confirm its pause semantics from the issuer's documentation");
      }
      for (const [account, probe] of Object.entries(observed.blacklisted)) {
        if (probe.exposed) {
          pass(`${rpc.name}: USDC isBlacklisted(${account}) == false`, probe.value === false, probe.value);
        } else {
          manual(
            `${rpc.name}: USDC blocklist for ${account}`,
            "token exposes no isBlacklisted(address); confirm its restriction semantics from the issuer's documentation",
          );
        }
      }
    });

    const healthy = observations.every((observed) => !observed.error);
    if (healthy) {
      const [first, second] = observations;
      const lag = first.head > second.head ? first.head - second.head : second.head - first.head;
      pass(`RPC heads within ${MAX_HEAD_LAG_BLOCKS} blocks`, lag <= MAX_HEAD_LAG_BLOCKS, `${first.head} / ${second.head}`);
      pass(
        "RPCs agree on USDC code hash and FiatTokenProxy implementation",
        first.usdcCodeHash === second.usdcCodeHash && first.implementation === second.implementation,
        `${first.usdcCodeHash} impl=${first.implementation} / ${second.usdcCodeHash} impl=${second.implementation}`,
      );

      const lower = first.head < second.head ? first.head : second.head;
      commonHeight = lower > HASH_CHECK_DEPTH ? lower - HASH_CHECK_DEPTH : 0n;
      for (const rpc of rpcs) {
        const block = await rpc.read(`block ${commonHeight}`, () => rpc.client.getBlock({ blockNumber: commonHeight }));
        blockHashes.push(block.hash);
      }
      pass(`RPCs agree on block hash at height ${commonHeight}`, blockHashes[0] === blockHashes[1], blockHashes.join(" / "));
    }
  }

  manual(
    "Arc runtime blocklist semantics",
    `native value transfers to or from a blocklisted address revert and still consume gas (${ARC_EVM_DIFFERENCES}); this cannot be exercised read-only. Before funding, confirm the Float address, owner Safe, sponsors and providers are not blocklisted (the manifest re-probes the Float address).`,
  );
  manual(
    "official network values",
    `confirm FLOAT_MAINNET_EXPECTED_CHAIN_ID, FLOAT_MAINNET_USDC, both RPC operators and ARC_EXPLORER_URL against ${ARC_CONNECT} and ${ARC_CONTRACT_ADDRESSES}; this preflight proves the configured values are mutually consistent and the two RPC hosts distinct, not that they are the official ones. That the two hosts are run by independent operators is a human check.`,
  );
  if (!config.expectedDeployer) {
    manual(
      "deployer address not yet named",
      "FLOAT_MAINNET_EXPECTED_DEPLOYER is blank, so the deployer's USDC blocklist status is unchecked. Name the approved deployer's public address before the authorization gate; the deploy script enforces it when set and the manifest requires it.",
    );
  }

  if (config.explorerUrl) {
    try {
      const landing = await fetch(config.explorerUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
      report.explorer = { requested: redactUrl(config.explorerUrl), resolved: redactUrl(landing.url), status: landing.status };
      pass("explorer reachable", landing.ok, `HTTP ${landing.status} at ${redactUrl(landing.url)}`);
      if (commonHeight !== null) {
        const block = await fetchJson(new URL(`/api/v2/blocks/${commonHeight}`, landing.url));
        report.explorer.blockHash = block.hash;
        pass(`explorer indexes the same chain (block ${commonHeight})`, block.hash === blockHashes[0], `${block.hash} vs ${blockHashes[0]}`);
      }
      const verifier = await fetchJson(new URL("/api/v2/smart-contracts/verification/config", landing.url));
      const compiler = `v${EXPECTED_COMPILER.version}`;
      pass(
        `explorer verifier offers solc ${compiler}`,
        Array.isArray(verifier.solidity_compiler_versions) && verifier.solidity_compiler_versions.includes(compiler),
        verifier.solidity_compiler_versions ? `${verifier.solidity_compiler_versions.length} compiler versions listed` : "no compiler list",
      );
    } catch (error) {
      pass("explorer reachable and consistent", false, errorMessage(error));
    }
  }

  if (!existsSync(artifactPath)) {
    pass("local artifact present", false, "run forge build --root contracts");
  } else {
    const artifact = loadArtifact();
    const compiler = compilerSettings(artifact);
    const sources = readSourceState(artifact);
    const size = runtimeBytes(artifact);
    report.artifact = { compiler, runtimeBytes: size };
    report.git = sources;
    pass("artifact compiler version", compiler.version === EXPECTED_COMPILER.version, compiler.version);
    pass(
      "artifact compiler settings match contracts/foundry.toml release profile",
      sameJson(compiler.settings, EXPECTED_COMPILER.settings),
      JSON.stringify(compiler.settings),
    );
    pass(`runtime bytecode <= ${MAX_RUNTIME_BYTES} bytes`, size <= MAX_RUNTIME_BYTES, `${size} bytes`);
    for (const [path, state] of Object.entries(sources.files)) {
      pass(`${path}: artifact built from working tree`, state.artifactMatchesWorkingTree, `sha256 ${state.sha256}`);
      pass(`${path}: unmodified vs HEAD ${sources.commit.slice(0, 12)}`, !state.modifiedVsHead, state.modifiedVsHead ? "modified or untracked" : "clean");
    }
    const mismatches = pinnedLineageMismatches(sources.files);
    pass(
      `compiled sources are the pinned reviewed lineage ${PINNED_SOURCE_COMMIT.slice(0, 12)}`,
      mismatches.length === 0,
      mismatches.length ? `git blob differs from the pin: ${mismatches.join(", ")}` : `${Object.keys(PINNED_SOURCE_BLOBS).length} git blobs match`,
    );
  }

  report.checks = checks;
  report.ok = checks.every((entry) => entry.status !== "FAIL");
  console.log(stableStringify(report));
  if (!report.ok) process.exit(1);
}

if (isEntrypoint(import.meta)) {
  main().catch((error) => {
    console.error(`preflight aborted: ${errorMessage(error)}`);
    process.exit(1);
  });
}
