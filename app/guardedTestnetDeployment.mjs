// Explicit engineering deployment. Never silently substitute this for /start.
export const GUARDED_TESTNET = Object.freeze({
  chainId: 5042002,
  address: '0xd39d55Cc0C84408DCC409baDB776459641Dfd4be',
  runtimeHash: '0xa1292988891428761ca7b298cbda208b31b1744637f390a6db1eaea014f3e3c5',
  usdc: '0x3600000000000000000000000000000000000000',
  deployBlock: 65639888n,
  signatureTtl: 600n,
  maxReserve: 100000n, maxLineSpend: 5000n, maxDailySpend: 5000n, maxPerSpend: 5000n,
  drawBoundRepayment: true, selfRegistration: false,
});
export const GUARDED_TESTNET_SERVICE = Object.freeze({
  provider: '0xFAF237F98f35A86149E901e18EB4BAd67bC0D347',
  providerUrl: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-testnet-guarded',
  endpoint: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-testnet-guarded/report',
  principal: '5000',
});
