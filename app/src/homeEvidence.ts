import manifest from "../../contracts/deployments/public-testnet/arc-testnet.manifest.json" with { type: "json" };
import { PUBLIC_TESTNET } from "./publicTestnet";

// Arc testnet explorer base.
export const HOME_EXPLORER = "https://testnet.arcscan.app";

// Contract address from the public testnet deployment config.
export const HOME_CONTRACT = PUBLIC_TESTNET.address;

// Source commit from the public testnet deployment manifest.
export const HOME_SOURCE_COMMIT = manifest.source.commit;

export const HOME_REHEARSAL = {
  // Team rehearsal on the public testnet contract, 27 September 2026.
  date: "27 September 2026",
  // Amounts from the team rehearsal on the public testnet contract.
  amounts: {
    setAside: "0.10",
    purchase: "0.05",
    recovery: "0.00",
    repayment: "0.05",
    reclaim: "0.10",
  },
  // Transactions from the team rehearsal on the public testnet contract.
  transactions: {
    open: "0xcf740546a2ee3a7072f5b6623c03f110cc91b085fc413f9113fd5a63a5c99556",
    purchase: "0x416b4711900cc40f1f597c6aae2ed26ab395d927aa0e43b5d875f84d6d9d014a",
    repayment: "0x909ff728c241922b3ead55beba558a21c87fa5aebb52c4ab843e54503dd18161",
    reclaim: "0xee65408351e17447088753adef03367bdfbcc588b08cf9594324bfb30cae7fc0",
  },
} as const;

// Labels and values from the public testnet contract limits.
export const HOME_LIMITS = [
  { label: "Total set aside across all funding lines", value: "25" },
  { label: "One purchase", value: "1" },
  { label: "Spend per line, per day", value: "2" },
  { label: "Set aside per line", value: "5" },
  { label: "Total spend per line", value: "5" },
  { label: "Time to repay a purchase", value: "1 hour to 7 days" },
  { label: "Raising a contract limit", value: "48 hours' notice, never above a fixed ceiling" },
  {
    label: "Pausing purchases or new lines, lowering a limit or removing a sponsor",
    value: "Immediate, by Shadow. It cannot move anyone's USDC; repaying, closing and reclaiming still work",
  },
] as const;

// The values were re-read by eth_call at this block on 3 October 2026 and match the values above.
export const HOME_LIMITS_BLOCK = "65,247,342";
