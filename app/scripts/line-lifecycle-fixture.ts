import type { CandidateDeployment, CandidateLine } from '../src/candidateFunding';
import type { CycleReportCheck } from '../src/lineLifecycle';
export const deployment: CandidateDeployment = {
  chainId: 5042, address: `0x${'11'.repeat(20)}`, runtimeHash: `0x${'22'.repeat(32)}`,
  usdc: `0x${'33'.repeat(20)}`, signatureTtl: 900n,
  maxReserve: 100000n, maxLineSpend: 5000n, maxDailySpend: 5000n, maxPerSpend: 5000n,
};
export const line: CandidateLine = {
  lineId: `0x${'44'.repeat(32)}`, sponsor: `0x${'55'.repeat(20)}`, agent: `0x${'66'.repeat(20)}`,
  epoch: 1n, expiry: 2000000000n, maximumRepaymentWindow: 86400n, day: 1n, termsVersion: 1n,
  state: 4, stateName: 'CLOSED', reserveCap: 100000n, availableReserve: 0n,
  principalOutstanding: 0n, recoveryAvailable: 0n, lineSpendCap: 5000n, dailySpendCap: 5000n,
  cumulativePrincipalPaid: 5000n, spentToday: 5000n, dueAt: 1900000000n,
  observedBlock: 100n, observedTimestamp: 1900000100n, sponsorAllowed: true, spendsPaused: false,
};
export const report: CycleReportCheck = { chainId: 5042, contract: deployment.address, runtimeHash: deployment.runtimeHash,
  lineId: line.lineId, sponsor: line.sponsor, agent: line.agent, digest: `0x${'77'.repeat(32)}`,
  principal: '5000', transactionHash: `0x${'88'.repeat(32)}`, checkedAt: '2026-10-21T12:00:00Z' };
