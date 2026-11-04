import type { CandidateReadClient } from './candidateFunding';

// Background refreshes share the paced transport with interactive reviews.
// Finish an already queued read, but do not enqueue the rest of a superseded
// refresh. Never use this wrapper for transaction preparation or execution.
export function cancellableFundingReads(client: CandidateReadClient, signal: AbortSignal): CandidateReadClient {
  const methods = new Set(['getChainId', 'getCode', 'readContract', 'getBlock']);
  const check = () => {
    if (signal.aborted) throw new DOMException('Background refresh stopped.', 'AbortError');
  };
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || !methods.has(key) || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        check();
        const result = await Reflect.apply(value, target, args);
        check();
        return result;
      };
    },
  });
}
