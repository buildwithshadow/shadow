// Public network settings: https://docs.arc.io/arc/references/rpc-endpoints
export const ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io';
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
