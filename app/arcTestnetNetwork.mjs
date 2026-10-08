// Public network settings: https://docs.arc.io/arc/references/rpc-endpoints
// Wallet setup always uses public URLs, never a configured private RPC credential.
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io';
export const ARC_TESTNET_EXPLORER_URL = 'https://explorer.testnet.arc.io';

const legacyHosts = new Map([
  ['rpc.testnet.arc.network', 'rpc.testnet.arc.io'],
  ['rpc.blockdaemon.testnet.arc.network', 'rpc.blockdaemon.testnet.arc.io'],
  ['rpc.drpc.testnet.arc.network', 'rpc.drpc.testnet.arc.io'],
  ['rpc.quicknode.testnet.arc.network', 'rpc.quicknode.testnet.arc.io'],
]);

export function arcTestnetRpcUrl(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (!value) return ARC_TESTNET_RPC_URL;
  try {
    const url = new URL(value);
    const currentHost = legacyHosts.get(url.hostname);
    if (currentHost && url.protocol === 'https:' && !url.port && !url.username && !url.password
        && url.pathname === '/' && !url.search && !url.hash) return `https://${currentHost}`;
  } catch { /* Preserve explicitly configured endpoints for the transport to validate. */ }
  return value;
}

export function arcTestnetWalletParameters() {
  return {
    chainId: '0x4cef52', chainName: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: [ARC_TESTNET_RPC_URL], blockExplorerUrls: [ARC_TESTNET_EXPLORER_URL],
  };
}

export function arcTestnetConnectionHelp(error) {
  const messages = [], seen = new Set();
  for (let current = error, depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current === 'string') { messages.push(current); break; }
    for (const key of ['message', 'shortMessage', 'details']) {
      if (typeof current[key] === 'string') messages.push(current[key]);
    }
    current = current.cause;
  }
  const text = messages.join('\n');
  if (!/https:\/\/rpc(?:\.(?:blockdaemon|drpc|quicknode))?\.testnet\.arc\.(?:io|network)(?:[/:\s]|$)/i.test(text)
      || !/\b403\b|forbidden|fetch failed|failed to fetch|http request failed|timed? ?out/i.test(text)) return null;
  return `Arc testnet connection is unavailable. If your wallet saved an older RPC, update it to ${ARC_TESTNET_RPC_URL}. In Rabby, use Settings > Modify RPC URL > Arc Testnet, then select Refresh wallet in Shadow. Check any saved pending transaction before trying the action again.`;
}
