import { isLogRangeLimit } from './rpc-log-range-limit.mjs';
import { isTransientRpcReadError } from './rpc-read-queue.mjs';

// Capture behavior before discarding remote diagnostics. Only fixed labels
// leave this function, so an upstream transport can preserve classification
// without retaining credentials, tenant identifiers or arbitrary messages.
export function classifyRpcReadFailure(error, method) {
  const range = method === 'eth_getLogs' && isLogRangeLimit(error);
  const retryable = !range && isTransientRpcReadError(error, method);
  return range ? 'block range exceeds maximum'
    : retryable ? 'RPC temporarily unavailable'
    : error?.code === 3 ? 'execution reverted' : 'RPC request failed';
}
