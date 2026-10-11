import type { CandidateDeployment } from './candidateFunding'
import type { PublicService } from './PublicPurchase'

// Verified deployment only. Importing this module does not enable the public route,
// activate the provider or change either onchain pause.
export const PUBLIC_MAINNET: CandidateDeployment = Object.freeze({
  chainId: 5042,
  address: '0xcA819e8713b04a4Bd7e437c04BB97ac9274e2ce5',
  usdc: '0x3600000000000000000000000000000000000000',
  runtimeHash: '0xa210397556c84e50f9f345168fc65fa0bc19d913d513a8b2daf8131330c3d52d',
  signatureTtl: 900n,
  maxReserve: 100_000n,
  maxLineSpend: 5_000n,
  maxDailySpend: 5_000n,
  maxPerSpend: 5_000n,
  drawBoundRepayment: true,
  selfRegistration: true,
})

export const PUBLIC_MAINNET_SERVICE: PublicService = Object.freeze({
  name: 'Shadow Arc wallet balance report',
  provider: '0x3b233d4b9126e6020D3A5fb6a215846916050498',
  endpoint: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-mainnet-public',
  providerUrl: 'https://api.shadowbuild.xyz:8443/provider/arc-wallet-mainnet-public',
  principal: '5000',
  requestKind: 'arc-wallet',
  sourcePayment: '',
})
