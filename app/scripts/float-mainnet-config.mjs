import { readFileSync } from "node:fs";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToBytes,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { errorMessage, redactUrl, stableStringify } from "./float-mainnet-preflight.mjs";
import { createRpcReadTransport } from "./rpc-read-transport.mjs";

// Shared configuration for the ShadowFloatMainnet candidate participant tools.
// Kept apart from every V2 module: the candidate has its own domain, intent
// type, ABI and events, and a V2 address must never pass for it.

export const floatAbi = JSON.parse(readFileSync(new URL("./float-mainnet-abi.json", import.meta.url), "utf8"));

export const DOMAIN_NAME = "ShadowFloatMainnet";
export const DOMAIN_VERSION = "1";
export const SPEND_INTENT_TYPES = {
  SpendIntent: [
    { name: "agent", type: "address" },
    { name: "sponsor", type: "address" },
    { name: "lineId", type: "bytes32" },
    { name: "lineEpoch", type: "uint64" },
    { name: "termsHash", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "principal", type: "uint256" },
    { name: "maximumTotalDebt", type: "uint256" },
    { name: "dueAt", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "signatureExpiry", type: "uint256" },
    { name: "executor", type: "address" },
  ],
};
export const SPEND_INTENT_TYPE_STRING = `SpendIntent(${SPEND_INTENT_TYPES.SpendIntent.map(
  ({ name, type }) => `${type} ${name}`,
).join(",")})`;

// Enum order as declared in ShadowFloatMainnet.sol.
export const LINE_STATES = ["NONE", "OPEN", "DRAWN", "DEFAULTED", "CLOSED"];
export const BLOCK_REASONS = [
  "NONE",
  "SPENDS_PAUSED",
  "SPONSOR_NOT_ALLOWED",
  "LINE_EXPIRED",
  "PROVIDER_NOT_ALLOWED",
  "ENDPOINT_NOT_ALLOWED",
  "PROTOCOL_CAP",
  "LINE_RESERVE_CAP",
  "LINE_SPEND_CAP",
  "PER_SPEND_CAP",
  "DAILY_SPEND_CAP",
];
export const RECEIPT_STATUSES = ["none", "blocked", "paid"];
export const ERC1271_MAGIC = "0x1626ba7e";
// Seconds an intent's signature stays valid unless --signature-ttl says otherwise.
export const DEFAULT_SIGNATURE_TTL = 900n;

export function eip712Domain(chainId, verifyingContract) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: getAddress(verifyingContract),
  };
}

// The contract compares endpoint hashes for equality only. Candidate convention:
// keccak256 of the exact UTF-8 endpoint string agreed with the provider. A string
// that looks like hex ("0x61") is still hashed as UTF-8 text, never decoded.
export function endpointHashFrom({ endpoint, endpointHash }) {
  if (endpoint !== undefined && endpointHash !== undefined) {
    throw new Error("pass --endpoint or --endpoint-hash, not both");
  }
  if (endpointHash !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(endpointHash)) throw new Error("--endpoint-hash must be a 0x-prefixed bytes32");
    return endpointHash.toLowerCase();
  }
  if (endpoint === undefined || endpoint === "") throw new Error("pass --endpoint <string> or --endpoint-hash <bytes32>");
  return keccak256(stringToBytes(endpoint));
}

// Reads the deployment to talk to. The address comes from FLOAT_MAINNET_ADDRESS
// or a release manifest; there is no default address. A manifest is trusted
// only when it passed (ok: true) on this chain; its recorded runtime code hash
// is checked against the chain by connectCandidate.
export function readDeployment(env = process.env, { manifest } = {}) {
  const rpcUrl = env.ARC_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("ARC_RPC_URL is required");
  const chainRaw = env.FLOAT_MAINNET_EXPECTED_CHAIN_ID?.trim();
  if (!chainRaw || !/^\d+$/.test(chainRaw)) throw new Error("FLOAT_MAINNET_EXPECTED_CHAIN_ID must be a decimal chain id");

  let release = null;
  if (manifest) {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    if (parsed.ok !== true) throw new Error(`${manifest} is not a passing release manifest (ok is ${JSON.stringify(parsed.ok ?? null)})`);
    if (String(parsed.chainId) !== chainRaw) {
      throw new Error(`${manifest} is for chain ${parsed.chainId ?? "(none)"}, not FLOAT_MAINNET_EXPECTED_CHAIN_ID ${chainRaw}`);
    }
    const runtimeHash = parsed.bytecode?.onchainRuntimeKeccak256;
    if (typeof runtimeHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(runtimeHash)) {
      throw new Error(`${manifest} has no bytecode.onchainRuntimeKeccak256`);
    }
    const deployBlock = parsed.deployment?.blockNumber;
    if (!/^\d+$/.test(String(deployBlock))) throw new Error(`${manifest} has no deployment.blockNumber`);
    if (!parsed.contract?.address) throw new Error(`${manifest} has no contract.address`);
    release = { address: parsed.contract.address, runtimeHash: runtimeHash.toLowerCase(), deployBlock: BigInt(deployBlock) };
  }

  const fromEnv = env.FLOAT_MAINNET_ADDRESS?.trim() || undefined;
  const raw = fromEnv ?? release?.address;
  if (!raw || !isAddress(raw)) throw new Error("FLOAT_MAINNET_ADDRESS (or --manifest) must name the candidate address");
  if (fromEnv && release && (!isAddress(release.address) || getAddress(fromEnv) !== getAddress(release.address))) {
    throw new Error("FLOAT_MAINNET_ADDRESS and the manifest's contract.address differ");
  }
  return {
    rpcUrl,
    expectedChainId: BigInt(chainRaw),
    address: getAddress(raw),
    runtimeHash: release?.runtimeHash ?? null,
    deployBlock: release?.deployBlock ?? null,
  };
}

// Connects and proves the address is this contract generation on this chain,
// using the contract's own public domain and type constants.
export async function connectCandidate(deployment, { readOnly = false } = {}) {
  const chain = defineChain({
    id: Number(deployment.expectedChainId),
    name: `chain ${deployment.expectedChainId}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [deployment.rpcUrl] } },
  });
  const transport = readOnly ? createRpcReadTransport(deployment.rpcUrl) : http(deployment.rpcUrl, { timeout: 30_000 });
  const client = createPublicClient({ chain, transport });

  const chainId = BigInt(await client.getChainId());
  if (chainId !== deployment.expectedChainId) {
    throw new Error(`RPC ${redactUrl(deployment.rpcUrl)} is chain ${chainId}, not ${deployment.expectedChainId}`);
  }
  const code = await client.getCode({ address: deployment.address });
  if (!code || code === "0x") throw new Error(`no contract at ${deployment.address}`);
  if (deployment.runtimeHash && keccak256(code) !== deployment.runtimeHash) {
    throw new Error(
      `the runtime code at ${deployment.address} hashes to ${keccak256(code)}, not the manifest's onchainRuntimeKeccak256 ${deployment.runtimeHash}`,
    );
  }

  const read = (functionName) => client.readContract({ address: deployment.address, abi: floatAbi, functionName });
  let identity;
  try {
    identity = await Promise.all(["NAME_HASH", "VERSION_HASH", "SPEND_INTENT_TYPEHASH", "deploymentChainId"].map(read));
  } catch (error) {
    throw new Error(`${deployment.address} is not a ShadowFloatMainnet candidate: ${errorMessage(error)}`);
  }
  const [nameHash, versionHash, typehash, deploymentChainId] = identity;
  const mismatches = [
    nameHash !== keccak256(toBytes(DOMAIN_NAME)) && "NAME_HASH",
    versionHash !== keccak256(toBytes(DOMAIN_VERSION)) && "VERSION_HASH",
    typehash !== keccak256(toBytes(SPEND_INTENT_TYPE_STRING)) && "SPEND_INTENT_TYPEHASH",
    deploymentChainId !== chainId && "deploymentChainId",
  ].filter(Boolean);
  if (mismatches.length) {
    throw new Error(`${deployment.address} is not this ShadowFloatMainnet generation (${mismatches.join(", ")} differ)`);
  }
  return { chain, transport, client, address: deployment.address, chainId, deployBlock: deployment.deployBlock ?? null };
}

// A participant's key, read from env at runtime only. It is never printed:
// viem's own errors for a malformed or out-of-range key quote the key.
export function walletFromEnv(connection, keyName, env = process.env) {
  const raw = env[keyName]?.trim();
  if (!raw) throw new Error(`${keyName} is required for this command`);
  let account;
  try {
    account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
  } catch {
    throw new Error(`${keyName} is not a valid secp256k1 private key`);
  }
  return { account, wallet: createWalletClient({ account, chain: connection.chain, transport: connection.transport }) };
}

// The custom error name of a contract revert, or null when it is not one.
export function revertName(error) {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return reverted?.data?.errorName ?? null;
}

export function printJson(value) {
  console.log(stableStringify(value));
}
