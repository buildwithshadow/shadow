import { formatUnits, isAddress, zeroHash, type Hash } from 'viem';
import type { CandidateDeployment, CandidateLine } from './candidateFunding';
import type { PurchaseRecord } from './selfServicePurchase.mjs';

// These observations are produced only after the purchase engine rechecks the
// original payment and signed result. They are visit-local, never imported as
// trusted evidence from localStorage or from a downloaded cycle summary.
export interface CycleReportCheck {
  chainId: number; contract: string; runtimeHash: string; lineId: Hash;
  sponsor: string; agent: string; digest: Hash; principal: string;
  transactionHash: null; checkedAt: string;
}
export function checkedCycleReport(deployment: CandidateDeployment, record: PurchaseRecord): CycleReportCheck {
  if (record.stage !== 'delivered') throw new Error('Only a rechecked delivered report can enter the cycle summary.');
  const message = record.intent.typedData.message;
  return { chainId: deployment.chainId, contract: deployment.address, runtimeHash: deployment.runtimeHash,
    lineId: message.lineId, sponsor: message.sponsor, agent: message.agent, digest: record.intent.digest,
    // The wallet request hash may be replaced or edited in browser storage.
    // Recovery verifies the paid digest and signed result, not this local hash.
    principal: String(message.principal), transactionHash: null, checkedAt: new Date().toISOString() };
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const validHash = (value: unknown): value is Hash => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !same(value, zeroHash);

export function createCycleSummary(deployment: CandidateDeployment, line: CandidateLine, checks: readonly CycleReportCheck[] = []) {
  if (!isAddress(deployment.address) || !validHash(deployment.runtimeHash) || !validHash(line.lineId)
      || !isAddress(line.sponsor) || !isAddress(line.agent)) throw new Error('Funding cycle identity is unavailable. Refresh the line.');
  const amounts = [line.reserveCap, line.availableReserve, line.principalOutstanding, line.recoveryAvailable, line.cumulativePrincipalPaid];
  if (amounts.some(value => typeof value !== 'bigint' || value < 0n) || line.principalOutstanding > line.cumulativePrincipalPaid
      || !['OPEN', 'DRAWN', 'DEFAULTED', 'CLOSED'].includes(line.stateName)) throw new Error('Funding cycle values are inconsistent. Refresh the line.');
  const unique = new Map<string, CycleReportCheck>();
  for (const check of checks) {
    if (check.chainId !== deployment.chainId || !same(check.contract, deployment.address) || !same(check.runtimeHash, deployment.runtimeHash)
        || !same(check.lineId, line.lineId) || !same(check.sponsor, line.sponsor) || !same(check.agent, line.agent)
        || !validHash(check.digest) || !/^\d+$/.test(check.principal) || BigInt(check.principal) <= 0n
        || !Number.isFinite(Date.parse(check.checkedAt))) continue;
    // Explicit allowlist: no result content, acceptance, signature or arbitrary
    // caller fields can enter this downloadable summary.
    unique.set(check.digest.toLowerCase(), { chainId: check.chainId, contract: check.contract, runtimeHash: check.runtimeHash,
      lineId: check.lineId, sponsor: check.sponsor, agent: check.agent, digest: check.digest, principal: check.principal,
      transactionHash: null, checkedAt: check.checkedAt });
  }
  const reports = [...unique.values()];
  const spent = line.cumulativePrincipalPaid;
  const repaid = spent - line.principalOutstanding;
  const money = (value: bigint) => `${formatUnits(value, 6)} ${deployment.chainId === 5042 ? 'USDC' : 'test USDC'}`;
  const stages = [
    { title: 'Funding', state: 'observed', detail: `Line opened with ${money(line.reserveCap)} of reserve.` },
    { title: 'Purchases', state: spent > 0n ? 'observed' : 'none', detail: spent > 0n ? `${money(spent)} paid to providers in total.` : 'No purchase recorded in this line state.' },
    { title: 'Delivery', state: reports.length ? 'checked' : 'unknown', detail: reports.length
      ? `${reports.length} report receipt${reports.length === 1 ? '' : 's'} rechecked during this visit. These checks do not establish full delivery coverage or share the balance snapshot time.`
      : 'Not checked in this visit. Open or recover the original report in service records.' },
    { title: 'Repayment', state: spent === 0n ? 'none' : line.principalOutstanding > 0n ? 'pending' : 'observed', detail: spent === 0n
      ? 'No purchase debt to repay.' : `${money(repaid)} of principal repaid; ${money(line.principalOutstanding)} still owed.` },
    { title: 'Closure', state: line.stateName === 'CLOSED' ? 'observed' : 'pending', detail: line.stateName === 'CLOSED'
      ? 'Line closed. See transaction history for the amount returned to the sponsor.'
      : line.stateName === 'DEFAULTED' ? 'Defaulted. Eligible recovery claims and repayment remain separate actions.' : 'Line not closed. Repay outstanding debt before eligible close and reclaim.' },
  ];
  return {
    kind: 'shadow.funding-cycle-summary', version: 1,
    scope: 'Observed funding line state plus report checks from this browser visit. Not a complete transaction history or a standalone proof of service delivery.',
    chainId: deployment.chainId, contract: deployment.address, runtimeHash: deployment.runtimeHash,
    observedBlock: line.observedBlock.toString(), observedTimestamp: line.observedTimestamp.toString(),
    line: { lineId: line.lineId, sponsor: line.sponsor, agent: line.agent, state: line.stateName,
      reserveOpened: line.reserveCap.toString(), availableReserve: line.availableReserve.toString(),
      principalOutstanding: line.principalOutstanding.toString(), cumulativePrincipalPaid: spent.toString(),
      principalRepaid: repaid.toString(), recoveryAvailable: line.recoveryAvailable.toString() },
    amountUnit: 'USDC base units, 6 decimals',
    repaymentBasis: 'Principal repaid is derived from cumulative principal paid minus principal outstanding. Payers and transaction dates are not established by this calculation.',
    reclaimAmount: null,
    deliveryCoverage: 'not-established',
    missingEvidence: ['Funding, repayment and reclaim transaction receipts are not included.', 'A closed line does not establish a reclaim amount.', 'Report checks describe a check during this visit; the exported file does not independently reverify those receipts.'],
    reports, stages,
  };
}
export type CycleSummary = ReturnType<typeof createCycleSummary>;
