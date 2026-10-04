import type { CandidateDeployment } from './candidateFunding'
import type { PublicService } from './PublicPurchase'

// Opt-in participant candidate. This does not admit sponsors or unpause writes.
export const GUARDED_MAINNET: CandidateDeployment = Object.freeze({
  chainId: 5042,
  address: '0x708c8c987eb4Cd14445Ac2c65ea712b2084888eB',
  usdc: '0x3600000000000000000000000000000000000000',
  runtimeHash: '0x845c0c3e47bbcf75004e5d47a6788585d57026ce70c08593d112966a6245b4ef',
  signatureTtl: 900n, maxReserve: 100_000n, maxLineSpend: 5_000n, maxDailySpend: 5_000n, maxPerSpend: 5_000n,
  drawBoundRepayment: true, selfRegistration: false,
})
export const GUARDED_MAINNET_SERVICE: PublicService = Object.freeze({
  name: 'Shadow Arc wallet balance report',
  provider: '0x3b233d4b9126e6020D3A5fb6a215846916050498',
  endpoint: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-mainnet-guarded',
  providerUrl: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-mainnet-guarded',
  principal: '5000', requestKind: 'arc-wallet', sourcePayment: '',
})
