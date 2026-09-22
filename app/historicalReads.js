// Share in-flight reads, but never let a temporary failure poison a warm worker.
export function cachedHistoricalRead(cache, key, read) {
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = Promise.resolve().then(read).catch((error) => {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

// The timer bounds the complete operation, including response body consumption.
// A late read cannot extend the caller's deadline even if it ignores cancellation.
export async function readBeforeDeadline(read, deadlineAt, message) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(message);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, remainingMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => read(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
    // Closing a parent read also cancels any still-pending child requests.
    controller.abort(new Error("Read scope closed"));
  }
}

export async function readExplorerLogPages({ url, deadlineAt, maxPages = 20, fetchPage = fetch }) {
  const items = [];
  const warnings = [];
  let pages = 0;
  let query = "";
  try {
    await readBeforeDeadline(async (signal) => {
      while (pages < maxPages) {
        signal.throwIfAborted();
        if (Date.now() >= deadlineAt) throw new Error("explorer log crawl deadline exceeded");
        const response = await fetchPage(`${url}${query}`, {
          headers: { "User-Agent": "shadow-float-api" },
          signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        signal.throwIfAborted();
        if (Date.now() >= deadlineAt) throw new Error("explorer log crawl deadline exceeded");
        if (!Array.isArray(body?.items)) throw new Error("invalid explorer log response");
        items.push(...body.items);
        pages += 1;
        if (!body.next_page_params) return;
        query = `?${new URLSearchParams(body.next_page_params).toString()}`;
      }
      warnings.push(`explorer logs: stopped at the ${maxPages} page cap`);
    }, deadlineAt, "explorer log crawl deadline exceeded");
  } catch (error) {
    warnings.push(`explorer logs: ${error?.shortMessage || error?.message || String(error)}`);
  }
  return { items, warnings, pages };
}
