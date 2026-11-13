const transientRpcPattern =
  /request limit reached|rate limit|too many requests|\b429\b|-32011|timed? out|timeout|fetch failed|econnreset|etimedout|socket hang up|temporarily unavailable|\b502\b|\b503\b|\b504\b/i;

export function createRpcReadQueue({
  maxAttempts = 6,
  baseDelayMs = 750,
  maxDelayMs = 8_000,
  spacingMs = 350,
  sleep = readDelay,
  random = Math.random,
  onRetry = () => {},
} = {}) {
  validatePositiveInteger(maxAttempts, "maxAttempts");
  validateNonNegativeInteger(baseDelayMs, "baseDelayMs");
  validateNonNegativeInteger(maxDelayMs, "maxDelayMs");
  validateNonNegativeInteger(spacingMs, "spacingMs");

  let tail = Promise.resolve();
  let nextReadAt = 0;

  return function queueRpcRead(label, operation, { signal } = {}) {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("RPC read operation must be a function"));
    }

    const task = tail.then(async () => {
      throwIfReadAborted(signal);
      const spacingDelay = Math.max(0, nextReadAt - Date.now());
      if (spacingDelay > 0) await waitForReadDelay(sleep, spacingDelay, signal);
      throwIfReadAborted(signal);

      try {
        return await retryRpcRead({
          label,
          operation,
          maxAttempts,
          baseDelayMs,
          maxDelayMs,
          sleep,
          random,
          onRetry,
          signal,
        });
      } finally {
        nextReadAt = Date.now() + spacingMs;
      }
    });

    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}

export function isTransientRpcReadError(error, method) {
  const detail = flattenError(error);
  // Internal backend errors have been observed to clear on repeated log reads.
  // Scope this allowance to eth_getLogs; never extend it to calls or sends,
  // and do not hide an explicit history/parameter/chain failure.
  if (method === "eth_getLogs") {
    if (/pruned|missing trie|histor(?:y|ical).*unavailable|invalid (?:argument|param)|execution reverted|unexpected chain|method not found|unsupported method/i.test(detail)) return false;
    // A generic class/code also wraps deterministic history failures. Only
    // the exact backend message we observed is eligible for this new retry.
    if (/internal error|InternalRpcError|-32603/i.test(detail)) {
      let current = error;
      let backendMessage = "";
      const seen = new Set();
      for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
        seen.add(current);
        if (typeof current === "string") { backendMessage = current; break; }
        if (typeof current !== "object") break;
        const message = [current.details, current.shortMessage, current.message]
          .find((value) => typeof value === "string" && value.trim());
        if (message) backendMessage = message;
        current = current.cause;
      }
      return /^internal error[.]?$/i.test(backendMessage.trim())
        || transientRpcPattern.test(backendMessage);
    }
  }
  return transientRpcPattern.test(detail);
}

async function retryRpcRead({
  label,
  operation,
  maxAttempts,
  baseDelayMs,
  maxDelayMs,
  sleep,
  random,
  onRetry,
  signal,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfReadAborted(signal);
    try {
      const value = await operation();
      throwIfReadAborted(signal);
      return value;
    } catch (error) {
      throwIfReadAborted(signal);
      if (attempt === maxAttempts || !isTransientRpcReadError(error, label)) throw error;

      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(exponentialDelay * 0.2 * random());
      const delayMs = exponentialDelay + jitter;
      onRetry({ label, attempt, maxAttempts, delayMs, error });
      await waitForReadDelay(sleep, delayMs, signal);
    }
  }

  throw new Error(`RPC read retry loop exhausted for ${label}`);
}

export function throwIfReadAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('RPC read cancelled', 'AbortError');
}

// Cancel queue waits immediately. An operation already on the wire is awaited
// separately under its transport timeout, so it cannot overlap the next read.
async function waitForReadDelay(sleep, delayMs, signal) {
  throwIfReadAborted(signal);
  if (!signal) return sleep(delayMs);
  let abort;
  try {
    await Promise.race([
      Promise.resolve().then(() => { throwIfReadAborted(signal); return sleep(delayMs, { signal }); }),
      new Promise((_, reject) => { abort = () => reject(signal.reason ?? new DOMException('RPC read cancelled', 'AbortError')); signal.addEventListener('abort', abort, { once: true }); }),
    ]);
    throwIfReadAborted(signal);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function readDelay(delayMs, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason ?? new DOMException('RPC read cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function flattenError(error) {
  const parts = [];
  const seen = new Set();
  let current = error;

  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;

    for (const key of ["name", "message", "shortMessage", "details", "code", "status"]) {
      const value = current[key];
      if (value !== undefined && value !== null) parts.push(String(value));
    }
    current = current.cause;
  }

  return parts.join(" ");
}

function validatePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function validateNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}
