export type FundingNetwork = "mainnet" | "testnet";

export function selectedFundingNetwork(pathname: string, search: string, mainnetAvailable: boolean): FundingNetwork {
  const path = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/start" || path.startsWith("/start/") || path === "/funding" || path === "/guarded-testnet") return "testnet";
  if (!mainnetAvailable) return "testnet";
  if (path === "/mainnet") return "mainnet";
  return new URLSearchParams(search).get("network") === "testnet" ? "testnet" : "mainnet";
}

// Network navigation starts a separate flow. Never copy a line ID, budget,
// signature or transaction from one deployment to the other.
export function fundingNetworkDestination(network: FundingNetwork, home = false): string {
  return home ? `/?network=${network}` : network === "mainnet" ? "/mainnet" : "/start";
}
