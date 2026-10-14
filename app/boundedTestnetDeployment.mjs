// Separate bounded engineering deployment. Does not replace the public routes.
export const BOUNDED_TESTNET = Object.freeze({
  chainId: 5042002,
  address: '0xCb4958BbF9cB6C6EE47590E8CF3EDD228035d356',
  runtimeHash: '0xee9965695348961b9e84e59cbc87fcb0264eddcca1b4b41f4eb0d5dbe97c98b2',
  usdc: '0x3600000000000000000000000000000000000000',
  deployBlock: 67164997n,
  signatureTtl: 600n,
  maxReserve: 100000n, maxLineSpend: 5000n, maxDailySpend: 5000n, maxPerSpend: 5000n,
  drawBoundRepayment: true, selfRegistration: true,
});
export const BOUNDED_TESTNET_SERVICE = Object.freeze({
  provider: '0xFAF237F98f35A86149E901e18EB4BAd67bC0D347',
  providerUrl: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-testnet-bounded',
  endpoint: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-testnet-bounded',
  principal: '5000',
});
