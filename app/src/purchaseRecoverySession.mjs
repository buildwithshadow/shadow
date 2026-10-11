// Per-window coordination survives React unmount/remount. Web Locks remain the
// actual exclusion boundary; this module only prevents overlapping UI reads.
const sessions = new Map(), walletWork = new Map(), listeners = new Set();
export function recoverySession(key) {
  if (!sessions.has(key)) sessions.set(key, {attempts:0, waited:0, stopped:false, deferred:null});
  return sessions.get(key);
}
export function resetRecoverySession(key) { sessions.delete(key); }
export function recoveryWalletBusy(key) { return (walletWork.get(key) ?? 0) > 0; }
export function beginRecoveryWalletWork(key) { walletWork.set(key, (walletWork.get(key) ?? 0) + 1); }
export function finishRecoveryWalletWork(key, notify = true) {
  const count = walletWork.get(key) ?? 0;
  if (count <= 1) walletWork.delete(key); else walletWork.set(key, count - 1);
  if (notify) for (const listener of listeners) { try { listener(); } catch { /* presentation cannot change completion */ } }
}
export function subscribeRecoverySettlement(listener) { listeners.add(listener); return () => {listeners.delete(listener);}; }
