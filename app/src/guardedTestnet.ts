import { GUARDED_TESTNET, GUARDED_TESTNET_SERVICE as service } from '../guardedTestnetDeployment.mjs'
import type { PublicService } from './PublicPurchase'

// The browser and Circle runner share one deployment and provider identity.
export { GUARDED_TESTNET }
export const GUARDED_TESTNET_SERVICE: PublicService = Object.freeze({
  ...service, name: 'Shadow Arc wallet balance report', requestKind: 'arc-wallet', sourcePayment: '',
})
