// Read-only continuation. This module deliberately has no payment/signing API.
export async function recoverOriginalPurchase({ recover, isCurrent, onResult, onStop,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const started = now();
  for (let attempt = 0; attempt < 6 && now() - started < 60000; attempt++) {
    if (!isCurrent()) return;
    try {
      const result = await recover();
      if (!isCurrent()) return;
      onResult(result);
      if (result.status === 'delivered' || result.status === 'blocked') return;
    } catch (error) {
      if (!isCurrent()) return;
      // Invalid identity, signed delivery or result bytes require manual review.
      const transient = /^Provider unavailable \((502|503|504)\)/.test(error?.message ?? '')
        || error?.name === 'TimeoutError'
        || (error?.name === 'TypeError' && /^(Failed to fetch|fetch failed|Load failed)$/.test(error.message));
      if (!transient) { onStop(error); return; }
    }
    if (attempt < 5 && now() - started < 50000) await wait(10000);
    else break;
  }
  if (isCurrent()) onStop(null);
}
