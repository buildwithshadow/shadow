// Isolated settled engineering deployment, verified on 26 October 2026.
// Source and runtime match Sourcify; public onboarding routes remain separately configured.
export const SETTLED_TESTNET = Object.freeze({
  chainId: 5042002,
  address: '0x7EF717d7F7f47D48ba5330047B32353567331dfA',
  runtimeHash: '0x559456c802439d1132e20d53e3a6ffb05d034b4eda017f3ec5b31414f7fa3d1a',
  usdc: '0x3600000000000000000000000000000000000000',
  deployBlock: 69230096n,
  signatureTtl: 600n,
  maxReserve: 100000n, maxLineSpend: 5000n, maxDailySpend: 5000n, maxPerSpend: 5000n,
  drawBoundRepayment: true, selfRegistration: true,
});
// The isolated provider route must be configured and healthy before funding or purchase.
export const SETTLED_TESTNET_SERVICE = Object.freeze({
  provider: '0xFAF237F98f35A86149E901e18EB4BAd67bC0D347',
  providerUrl: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-testnet-settled',
  endpoint: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-testnet-settled',
  principal: '5000',
});
