// Read-only continuation. This module deliberately has no payment/signing API.
export async function recoverOriginalPurchase({ recover, isCurrent, isBusy = () => false, onResult, onStop,
  budget = {attempts:0, waited:0}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const started = now();
  if (budget.stopped) return;
  while (budget.attempts < 6 && budget.waited < 60000 && now() - started < 60000) {
    if (!isCurrent()) return;
    if (isBusy()) {
      // This is the old read, not another recovery attempt. Its settlement
      // wakes the replacement view even when it takes longer than this batch.
      if (now() - started < 50000) { await wait(10000); continue; }
      return;
    }
    budget.attempts++;
    try {
      const result = await recover();
      if (!isCurrent()) return;
      onResult(result);
      if (result.status === 'delivered' || result.status === 'blocked') return;
    } catch (error) {
      if (!isCurrent()) return;
      // Invalid identity, signed delivery or result bytes require manual review.
      const transient = /^Provider unavailable \((502|503|504)\)/.test(error?.message ?? '')
        || error?.message === 'Another Shadow tab is using this wallet.'
        || error?.message === 'Another tab is using this purchase.'
        || error?.name === 'TimeoutError'
        || (error?.name === 'TypeError' && /^(Failed to fetch|fetch failed|Load failed)$/.test(error.message));
      if (!transient) { budget.stopped = true; onStop(error); return; }
    }
    if (budget.attempts < 6 && budget.waited + 10000 <= 60000 && now() - started < 50000) { budget.waited += 10000; await wait(10000); }
    else break;
  }
  if (isCurrent()) { budget.stopped = true; onStop(null); }
}
