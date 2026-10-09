import type { CandidateDeployment } from './src/candidateFunding';
export const GUARDED_TESTNET: Readonly<CandidateDeployment & { chainId: 5042002; deployBlock: bigint; drawBoundRepayment: true; selfRegistration: false }>;
export const GUARDED_TESTNET_SERVICE: Readonly<{
  provider: `0x${string}`; providerUrl: string; endpoint: string; principal: '5000';
}>;
