import { hashTypedData, type Hex } from "viem";

export const DIAGNOSTIC_WALLET = "0x6994ebdef63aa0e665e3c781ed54e2e181869a7a" as const;
export const DIAGNOSTIC_RP_ID = "shadow-two-opal.vercel.app";
export const DIAGNOSTIC_CHAIN_ID = 5042002;
export const ERC1271_MAGIC = "0x1626ba7e";

// Deliberately not Shadow's SpendIntent schema or domain. This message cannot
// authorize a purchase, approval, transfer, or user operation.
export const WALLET_DIAGNOSTIC = {
  domain: {
    name: "Shadow Wallet Diagnostic",
    version: "1",
    chainId: DIAGNOSTIC_CHAIN_ID,
    verifyingContract: DIAGNOSTIC_WALLET,
  },
  primaryType: "WalletDiagnostic",
  types: {
    WalletDiagnostic: [
      { name: "wallet", type: "address" },
      { name: "purpose", type: "string" },
      { name: "expiresAt", type: "uint256" },
    ],
  },
  message: {
    wallet: DIAGNOSTIC_WALLET,
    purpose: "Verify existing Circle passkey account signing for Shadow. This is not a purchase, transfer, approval, login credential, or candidate SpendIntent.",
    expiresAt: 1n,
  },
} as const;

export const diagnosticDigest = hashTypedData(WALLET_DIAGNOSTIC);
export const diagnosticJson = JSON.stringify(WALLET_DIAGNOSTIC, (_, value) => typeof value === "bigint" ? value.toString() : value, 2);

export function assertDiagnosticContext(rpId: string | undefined, chainId: number, code: Hex | undefined) {
  if (rpId !== DIAGNOSTIC_RP_ID) throw new Error("The returned passkey domain does not match this wallet. No diagnostic was signed.");
  if (chainId !== DIAGNOSTIC_CHAIN_ID) throw new Error("The RPC is not Arc testnet. No diagnostic was signed.");
  if (!code || code === "0x") throw new Error("The expected smart account has no deployed code. No diagnostic was signed.");
}

export function assertDiagnosticSignature(result: Hex) {
  if (result.toLowerCase() !== ERC1271_MAGIC) throw new Error("This signature did not verify for the expected Circle account.");
}
