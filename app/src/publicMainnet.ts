import manifest from '../../contracts/deployments/float-mainnet-settled/arc-mainnet.manifest.json' with { type: 'json' }
import { SETTLED_MAINNET, SETTLED_MAINNET_SERVICE } from '../settledMainnetDeployment.mjs'
import type { CandidateDeployment } from './candidateFunding'
import type { PublicService } from './PublicPurchase'

// Identity is published only after deployment, source verification and the founder cycle.
// Runtime, limits, pauses and provider admission are still checked before each action.
if (!manifest.ok || manifest.chainId !== '5042' || !manifest.publicRegistration ||
    manifest.repaymentBindingVersion !== 2 || manifest.contract.accountingModel !== 'settled-v1' ||
    manifest.contract.address !== SETTLED_MAINNET.address ||
    manifest.bytecode.onchainRuntimeKeccak256 !== SETTLED_MAINNET.runtimeHash ||
    BigInt(manifest.deployment.blockNumber) <= 0n || !manifest.sourceVerification.ok) {
  throw new Error('Invalid settled mainnet deployment identity')
}
for (const [field, limit] of Object.entries({ maxReserve: 'lineReserve', maxLineSpend: 'lineSpend', maxDailySpend: 'dailySpend', maxPerSpend: 'perSpend' })) {
  if (SETTLED_MAINNET[field as keyof typeof SETTLED_MAINNET] !== BigInt(manifest.config.initial[limit as keyof typeof manifest.config.initial])) throw new Error('Settled release limits differ')
}
export const PUBLIC_MAINNET: CandidateDeployment = SETTLED_MAINNET
export const PUBLIC_MAINNET_SERVICE: PublicService = SETTLED_MAINNET_SERVICE
