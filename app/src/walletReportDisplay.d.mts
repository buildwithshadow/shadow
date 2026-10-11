export interface WalletReportDisplay {
  balance: string; currency: string; network: string; account: string;
  blockNumber: string; blockHash: string; checkedAtUtc: string; checks: string[]; scope: string;
}
export function walletReportDisplay(text: string, expected: {account: string; requestId: string; chainId: number}): WalletReportDisplay | null;
