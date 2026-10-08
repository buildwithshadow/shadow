export const ARC_TESTNET_CHAIN_ID: 5042002;
export const ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io';
export const ARC_TESTNET_EXPLORER_URL: 'https://explorer.testnet.arc.io';
export function arcTestnetRpcUrl(configured?: unknown): string;
export function arcTestnetWalletParameters(): {
  chainId: '0x4cef52'; chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: 18 };
  rpcUrls: string[]; blockExplorerUrls: string[];
};
export function arcTestnetConnectionHelp(error: unknown): string | null;
