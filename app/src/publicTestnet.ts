import { getAddress, type Hash } from 'viem'
import manifest from '../../contracts/deployments/public-testnet/arc-testnet.manifest.json' with { type: 'json' }
import { CANDIDATE_FUNDING, type CandidateDeployment } from './candidateFunding'
import type { PublicService } from './PublicPurchase'

if (!manifest.ok || manifest.chainId !== '5042002' || manifest.contract.name !== 'ShadowFloatPublicTestnet') throw new Error('Invalid public testnet deployment manifest')
export const PUBLIC_TESTNET: CandidateDeployment = Object.freeze({
  ...CANDIDATE_FUNDING,
  address: getAddress(manifest.contract.address),
  runtimeHash: manifest.bytecode.onchainRuntimeKeccak256 as Hash,
  selfRegistration: true,
})
export const PUBLIC_TEST_SERVICE: PublicService = Object.freeze({
  name: 'Shadow payment cycle report',
  provider: getAddress('0xFAF237F98f35A86149E901e18EB4BAd67bC0D347'),
  endpoint: 'https://api.shadowbuild.xyz:8443/provider/shadow-v2-cycle',
  providerUrl: 'https://api.shadowbuild.xyz:8443/provider',
  principal: '50000',
  sourcePayment: '0x28d70ae57f6eda6ff27e0c2a5a13c3074ecf6792f79c726bae02f6f7c9c53b38',
})
