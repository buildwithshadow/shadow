import { BaseError, createTransport, http } from "viem";
import { createRpcReadQueue } from "./rpc-read-queue.mjs";

// A separate read-only transport: never attach retry policy to a wallet/send
// transport. The queue owns retries, so neither inner nor outer viem layers
// may add another retry loop. Browser-safe for read-only participant clients.
const READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getBalance", "eth_getStorageAt",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getTransactionCount",
  "eth_estimateGas", "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas",
]);

function scrubUrls(text) {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try { return `${new URL(value).origin}/[redacted]`; } catch { return "[redacted URL]"; }
  });
}

function safeMessage(error) {
  // Do not print viem's expanded message with request body/parameters.
  const message = error?.shortMessage ?? "RPC request failed";
  const details = typeof error?.details === "string" ? `; RPC said: ${error.details}` : "";
  return scrubUrls(`${message}${details}`);
}

function safeCause(error) {
  // BaseError inherits its cause's details into message/details. Retaining the
  // raw cause would therefore undo safeMessage's redaction, and expose URL,
  // request-body and metaMessages fields to loggers. Copy diagnostic fields
  // only, keeping RPC code + revert bytes for viem's contract-error decoder.
  const chain = [];
  for (let current = error; current && typeof current === "object" && chain.length < 8 && !chain.includes(current); current = current.cause) {
    chain.push(current);
  }
  const revertBytes = (entry) => {
    const data = typeof entry?.data === "object" ? entry.data?.data : entry?.data;
    return typeof data === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(data) ? data : undefined;
  };
  const dataSource = chain.find((entry) => revertBytes(entry) !== undefined);
  const rpcSource = dataSource
    ?? chain.find((entry) => Object.hasOwn(entry, "data") && Number.isSafeInteger(entry.code))
    ?? chain.find((entry) => Number.isSafeInteger(entry.code) && entry.code !== -1)
    ?? chain.find((entry) => Number.isSafeInteger(entry.code));
  const details = typeof rpcSource?.details === "string" ? rpcSource.details : error?.details;
  const safeDetails = typeof details === "string" ? scrubUrls(details) : undefined;
  const sanitized = new BaseError(safeDetails ?? safeMessage(error), { details: safeDetails });
  if (Number.isSafeInteger(rpcSource?.code)) sanitized.code = rpcSource.code;
  const status = chain.find((entry) => Number.isSafeInteger(entry.status))?.status;
  if (status !== undefined) sanitized.status = status;
  if (dataSource) sanitized.data = revertBytes(dataSource);
  return sanitized;
}

export function createRpcReadTransport(url, { queueOptions = {}, ...httpOptions } = {}) {
  const host = new URL(url).hostname;
  // Local Anvil has no shared provider quota; retain serialized reads/retries
  // without adding remote pacing to every contract regression test.
  const spacingMs = ["localhost", "127.0.0.1", "[::1]"].includes(host) ? 0 : 350;
  return (options) => {
    const base = http(url, { timeout: 30_000, ...httpOptions, retryCount: 0 })(options);
    const queue = createRpcReadQueue({ spacingMs, ...queueOptions });
    return createTransport({
      ...base.config,
      key: "queued-read-only-http",
      name: "Queued read-only JSON-RPC",
      retryCount: 0,
      async request(request) {
        if (!READ_METHODS.has(request.method)) throw new BaseError(`read-only RPC transport refuses ${request.method}`);
        try {
          return await queue(request.method, () => base.request(request, { retryCount: 0 }));
        } catch (error) {
          const failure = new BaseError(`RPC read ${request.method} failed: ${safeMessage(error)}`, { cause: safeCause(error) });
          // Preserve classification by the bounded log-range adapter without
          // printing a request body. It walks causes for explicit range limits.
          throw failure;
        }
      },
    }, base.value);
  };
}
