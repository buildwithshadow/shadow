import floatAbi from "./float-mainnet-abi.json" with { type: "json" };
import { getAddress, keccak256, parseAbiItem, stringToBytes } from "viem";

// Runtime-neutral contract schema. No filesystem, CLI or process initialization.
// Guarded repayment emits this companion event alongside Repaid. Keep the
// legacy callable ABI intact while allowing canonical monitor/indexer scans
// to decode the guarded log. It is evidence of draw attribution, not another
// repayment to add to accounting totals. ExpiredLineClosed attributes the
// existing LineClosed reserve return; it is not a second transfer. Unknown
// event signatures still fail.
export { floatAbi };
export const floatEventAbi = [
  ...floatAbi.filter(item => item.type === "event"),
  parseAbiItem("event DrawRepaid(bytes32 indexed lineId, bytes32 indexed drawDigest, address indexed payer, uint256 amount, uint256 principalRemaining)"),
  parseAbiItem("event ExpiredLineClosed(bytes32 indexed lineId, address indexed caller, address indexed sponsor, uint256 amount)"),
  parseAbiItem("event ExpiredLineSettled(bytes32 indexed lineId, address indexed caller, address indexed sponsor, uint256 returned, uint256 principalOutstanding)"),
];

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
