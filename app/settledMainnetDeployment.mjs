import { SETTLED_MAINNET_CANDIDATE } from './settledMainnetCandidate.mjs';

// Prepared release profile, not a live deployment or provider admission claim.
// Runtime verification, monitoring and explicit spending consent remain required.
export const SETTLED_MAINNET = Object.freeze({
  ...SETTLED_MAINNET_CANDIDATE,
  usdc: '0x3600000000000000000000000000000000000000',
  signatureTtl: 900n,
  maxReserve: 100000n, maxLineSpend: 50000n, maxDailySpend: 50000n, maxPerSpend: 50000n,
  drawBoundRepayment: true, selfRegistration: true, accountingModel: 'settled-v1',
});
// Dedicated report route must be configured and admitted before any purchase.
export const SETTLED_MAINNET_SERVICE = Object.freeze({
  name: 'Shadow Arc wallet balance report',
  provider: '0x3b233d4b9126e6020D3A5fb6a215846916050498',
  endpoint: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-mainnet-settled',
  providerUrl: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-mainnet-settled',
  principal: '5000', requestKind: 'arc-wallet', sourcePayment: '',
});
