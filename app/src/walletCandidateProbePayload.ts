import { getAddress, hashTypedData, isAddress, zeroAddress, zeroHash, type Address } from "viem";
import { DIAGNOSTIC_CHAIN_ID, DIAGNOSTIC_WALLET } from "./walletDiagnosticPayload.ts";

// Keep this field order identical to ShadowFloatMainnet.SpendIntent and the
// participant tool. The zero principal, nonexistent line and past expiry make
// this a signing-compatibility probe, never a purchase request.
export const CANDIDATE_SPEND_INTENT_TYPES = {
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
} as const;

export function candidateProbe(candidateAddress: string) {
  if (!isAddress(candidateAddress)) throw new Error("The candidate contract address is invalid.");
  const verifyingContract = getAddress(candidateAddress) as Address;
  const message = {
    agent: DIAGNOSTIC_WALLET,
    sponsor: zeroAddress,
    lineId: zeroHash,
    lineEpoch: 0n,
    termsHash: zeroHash,
    provider: zeroAddress,
    endpointHash: zeroHash,
    principal: 0n,
    maximumTotalDebt: 0n,
    dueAt: 1n,
    nonce: 0n,
    signatureExpiry: 1n,
    executor: zeroAddress,
  } as const;
  const typedData = {
    domain: { name: "ShadowFloatMainnet", version: "1", chainId: DIAGNOSTIC_CHAIN_ID, verifyingContract },
    types: CANDIDATE_SPEND_INTENT_TYPES,
    primaryType: "SpendIntent",
    message,
  } as const;
  return {
    typedData,
    digest: hashTypedData(typedData),
    json: JSON.stringify(typedData, (_, value) => typeof value === "bigint" ? value.toString() : value, 2),
  };
}
