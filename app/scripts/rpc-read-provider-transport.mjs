import { BaseError, createTransport } from 'viem';
import { classifyRpcReadFailure } from './rpc-read-classification.mjs';
import { createRpcReadQueue } from './rpc-read-queue.mjs';

const METHODS = new Set(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
// Observer-only seam for an owned read provider (for example one WebSocket).
// The caller owns its lifecycle. No HTTP fallback or broadcast path is added.
export function createReadProviderTransport(provider, { spacingMs = 350, queueOptions = {} } = {}) {
  if (!provider || typeof provider.request !== 'function') throw new TypeError('Read provider needs request');
  return () => {
    const queue = createRpcReadQueue({ spacingMs, ...queueOptions });
    const built = createTransport({
      key: 'observer-read-provider', name: 'Serialized observer reads', type: 'custom', retryCount: 0,
      async request(input) {
        const method = input?.method;
        if (!METHODS.has(method)) throw new BaseError('Observer read transport refuses this method');
        if (input.params !== undefined && !Array.isArray(input.params)) throw new BaseError('Observer read transport requires array parameters');
        let request;
        try { request = structuredClone({ method, params: input.params ?? [] }); }
        catch { throw new BaseError('Observer read transport request cannot be copied'); }
        return queue(method, async () => {
          try { return await provider.request(request); }
          catch (error) {
            // Fixed classification text preserves the existing bounded read
            // queue policy without copying upstream messages or raw causes.
            // Classify before sanitizing. Codes alone do not distinguish a
            // quota from an oversized range, or transient failure from pruning.
            const label = classifyRpcReadFailure(error, method);
            const failure = new BaseError(`Observer RPC read ${method} failed`, { details: label });
            if (Number.isSafeInteger(error?.code)) failure.code = error.code;
            if (method === 'eth_call' && typeof error?.data === 'string' && error.data.length <= 8192 && /^0x(?:[0-9a-fA-F]{2})*$/.test(error.data)) failure.data = error.data;
            throw failure;
          }
        });
      },
    });
    return { ...built, request: (args, options) => built.request(args, { ...options, retryCount: 0 }) };
  };
}
