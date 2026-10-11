import type { CandidateOpenInput, CandidatePrepared, CandidateResolution } from './candidateFunding';

// A confirmed allowance can prepare the next review, never send another transaction.
export async function prepareFundingContinuation({ approval, resolution, input, isCurrent, originRoute, currentRoute, prepareOpen }: {
  approval: CandidatePrepared;
  resolution: CandidateResolution;
  input: CandidateOpenInput | null;
  isCurrent: () => boolean;
  originRoute: string;
  currentRoute: () => string;
  prepareOpen: (account: string, input: CandidateOpenInput) => Promise<CandidatePrepared>;
}): Promise<CandidatePrepared | null> {
  if (approval.kind !== 'approve' || approval.nextAction !== 'open' || resolution.status !== 'confirmed') return null;
  if (!input || !isCurrent() || currentRoute() !== originRoute) return null;
  const reviewedInput = { ...input };
  const next = await prepareOpen(approval.account, reviewedInput);
  if (!isCurrent() || currentRoute() !== originRoute) return null;
  if (next.kind !== 'open' || next.amount !== approval.amount || next.account.toLowerCase() !== approval.account.toLowerCase()
    || next.agent?.toLowerCase() !== reviewedInput.agent.trim().toLowerCase()) {
    throw new Error('The confirmed allowance is preserved, but funding conditions changed. Review the line again before funding.');
  }
  return next;
}
