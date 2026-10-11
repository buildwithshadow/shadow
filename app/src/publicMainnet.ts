import manifest from '../../contracts/deployments/float-mainnet-public/arc-mainnet.manifest.json' with { type: 'json' }
import type { CandidateDeployment } from './candidateFunding'
import type { PublicService } from './PublicPurchase'

// Verified deployment only. Importing this module does not enable the public route,
// activate the provider or change either onchain pause.
if (!manifest.ok || !manifest.publicRegistration || manifest.repaymentBindingVersion !== 2 || manifest.chainId !== '5042' || BigInt(manifest.deployment.blockNumber) <= 0n) {
  throw new Error('Invalid public mainnet deployment identity')
}

export const PUBLIC_MAINNET: CandidateDeployment = Object.freeze({
  chainId: Number(manifest.chainId),
  address: manifest.contract.address as `0x${string}`,
  usdc: manifest.config.usdc as `0x${string}`,
  runtimeHash: manifest.bytecode.onchainRuntimeKeccak256 as `0x${string}`,
  signatureTtl: 900n,
  maxReserve: BigInt(manifest.config.initial.lineReserve),
  maxLineSpend: BigInt(manifest.config.initial.lineSpend),
  maxDailySpend: BigInt(manifest.config.initial.dailySpend),
  maxPerSpend: BigInt(manifest.config.initial.perSpend),
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
