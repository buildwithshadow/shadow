import { getAddress, hashTypedData, isAddress, isHex, zeroHash, type Address, type Hex } from "viem";
import { CANDIDATE_SPEND_INTENT_TYPES } from "./walletCandidateProbePayload.ts";
import { DIAGNOSTIC_CHAIN_ID, DIAGNOSTIC_WALLET } from "./walletDiagnosticPayload.ts";

// This signer is a bounded founder test on Arc testnet, not a general wallet UI.
export const TEST_SPONSOR = "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8";
export const TEST_PROVIDER = "0xec28bfA6f4BcFf23933E21B7AbfB6D53287976A8";
export const TEST_EXECUTOR = TEST_SPONSOR;
export const MAX_TEST_PRINCIPAL = 50_000n; // 0.05 testnet USDC.

const DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing or malformed.`);
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing or malformed.`);
  return value;
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error(`${label} is not an address.`);
  return getAddress(value);
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) throw new Error(`${label} is not bytes32.`);
  return value as Hex;
}

function unsigned(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is not a decimal integer.`);
  return BigInt(value);
}

function sameAddress(actual: Address, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} is outside this bounded test.`);
}

export function parseBoundedCircleIntent(source: string, candidateAddress: string, nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000))) {
  if (source.length > 64_000) throw new Error("Intent file is too large.");
  if (!isAddress(candidateAddress)) throw new Error("Candidate contract is not configured.");
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error("Intent file is not JSON."); }
  const file = record(parsed, "Intent file");
  if (file.kind !== "ShadowFloatMainnet.SpendIntent") throw new Error("This is not a Shadow candidate SpendIntent.");
  if (file.signature && file.signature !== "0x") throw new Error("This intent already contains a signature.");
  const declaredDigest = hash(file.digest, "Declared digest");
  let external: unknown;
  try { external = JSON.parse(string(file.externalSignerTypedData, "External signer payload")); }
  catch { throw new Error("External signer payload is not JSON."); }
  const typed = record(external, "External signer payload");
  const domain = record(typed.domain, "Domain");
  const types = record(typed.types, "Types");
  const message = record(typed.message, "Message");
  if (typed.primaryType !== "SpendIntent" ||
      JSON.stringify(types.EIP712Domain) !== JSON.stringify(DOMAIN_TYPES) ||
      JSON.stringify(types.SpendIntent) !== JSON.stringify(CANDIDATE_SPEND_INTENT_TYPES.SpendIntent)) {
    throw new Error("Intent type does not match the deployed Shadow contract.");
  }
  if (domain.name !== "ShadowFloatMainnet" || domain.version !== "1" || unsigned(domain.chainId, "Chain") !== BigInt(DIAGNOSTIC_CHAIN_ID)) {
    throw new Error("Intent domain is not Shadow on Arc testnet.");
  }
  const candidate = address(domain.verifyingContract, "Candidate contract");
  sameAddress(candidate, candidateAddress, "Candidate contract");
  const agent = address(message.agent, "Agent");
  const sponsor = address(message.sponsor, "Sponsor");
  const provider = address(message.provider, "Provider");
  const executor = address(message.executor, "Executor");
  sameAddress(agent, DIAGNOSTIC_WALLET, "Agent wallet");
  sameAddress(sponsor, TEST_SPONSOR, "Sponsor");
  sameAddress(provider, TEST_PROVIDER, "Provider");
  sameAddress(executor, TEST_EXECUTOR, "Executor");
  const lineId = hash(message.lineId, "Line ID");
  const termsHash = hash(message.termsHash, "Terms hash");
  const endpointHash = hash(message.endpointHash, "Endpoint hash");
  if (lineId === zeroHash || termsHash === zeroHash || endpointHash === zeroHash) throw new Error("Intent lacks live line or terms data.");
  const lineEpoch = unsigned(message.lineEpoch, "Line epoch");
  const principal = unsigned(message.principal, "Principal");
  const maximumTotalDebt = unsigned(message.maximumTotalDebt, "Maximum debt");
  const dueAt = unsigned(message.dueAt, "Repayment due time");
  const nonce = unsigned(message.nonce, "Nonce");
  const signatureExpiry = unsigned(message.signatureExpiry, "Signature expiry");
  if (lineEpoch === 0n || principal === 0n || principal > MAX_TEST_PRINCIPAL || maximumTotalDebt < principal || maximumTotalDebt > MAX_TEST_PRINCIPAL) {
    throw new Error("Intent amount or line epoch is outside this bounded test.");
  }
  if (signatureExpiry <= nowSeconds + 60n || signatureExpiry > nowSeconds + 1_200n || dueAt <= nowSeconds || dueAt > nowSeconds + 7n * 86_400n) {
    throw new Error("Intent expiry or repayment time is outside this bounded test.");
  }
  const typedData = {
    domain: { name: "ShadowFloatMainnet", version: "1", chainId: BigInt(DIAGNOSTIC_CHAIN_ID), verifyingContract: candidate },
    types: { EIP712Domain: DOMAIN_TYPES, SpendIntent: CANDIDATE_SPEND_INTENT_TYPES.SpendIntent },
    primaryType: "SpendIntent" as const,
    message: { agent, sponsor, lineId, lineEpoch, termsHash, provider, endpointHash, principal, maximumTotalDebt, dueAt, nonce, signatureExpiry, executor },
  };
  const digest = hashTypedData(typedData);
  if (digest.toLowerCase() !== declaredDigest.toLowerCase()) throw new Error("Intent digest differs from the signed payload.");
  const fileTyped = record(file.typedData, "Intent typed data");
  const fileDomain = record(fileTyped.domain, "Intent file domain");
  const fileTypes = record(fileTyped.types, "Intent file types");
  if (fileTyped.primaryType !== "SpendIntent" || JSON.stringify(fileTypes.SpendIntent) !== JSON.stringify(CANDIDATE_SPEND_INTENT_TYPES.SpendIntent) ||
      fileDomain.name !== "ShadowFloatMainnet" || fileDomain.version !== "1" ||
      unsigned(fileDomain.chainId, "Intent file chain") !== BigInt(DIAGNOSTIC_CHAIN_ID) ||
      address(fileDomain.verifyingContract, "Intent file contract").toLowerCase() !== candidate.toLowerCase() ||
      unsigned(file.chainId, "Intent file chain") !== BigInt(DIAGNOSTIC_CHAIN_ID) ||
      address(file.verifyingContract, "Intent file contract").toLowerCase() !== candidate.toLowerCase()) {
    throw new Error("Intent file and signer payload disagree.");
  }
  const fileMessage = record(fileTyped.message, "Intent file message");
  if (Object.keys(fileMessage).length !== Object.keys(message).length ||
      Object.entries(message).some(([key, value]) => fileMessage[key] !== value)) {
    throw new Error("Intent file has conflicting message fields.");
  }
  return { typedData, digest, candidate, principal, maximumTotalDebt, provider, sponsor, executor, signatureExpiry, dueAt, lineId };
}

export function signedCircleIntentJson(source: string, signature: Hex): string {
  if (!isHex(signature, { strict: true }) || signature.length <= 2 || signature.length % 2 !== 0) {
    throw new Error("Verified signature is malformed.");
  }
  const file = JSON.parse(source) as JsonRecord;
  return JSON.stringify({ ...file, signature }, null, 2);
}

export function assertCircleIntentWindow(
  message: { signatureExpiry: bigint; dueAt: bigint },
  providerExpiry: bigint,
  minimumRepaymentWindow: bigint,
  now: bigint,
): void {
  if (message.signatureExpiry <= now || providerExpiry < message.signatureExpiry ||
      message.dueAt < message.signatureExpiry + minimumRepaymentWindow) {
    throw new Error("Provider approval and repayment timing must cover the full signature lifetime. Build a fresh intent.");
  }
}
