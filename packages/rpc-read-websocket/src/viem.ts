// Adapter, not part of the transport: gives viem a transport that can never replay a read.
// viem's own retry loop (default 3 retries, and it retries every error that has no numeric
// `code`, plus -32603, -32005 and -1) would otherwise re-send a request the node may already
// have executed. Retries are forced to 0 both in the transport config and on every call, so a
// per-call `{ retryCount: n }` cannot switch them back on.
import { custom, type Transport } from 'viem';
import type { ReadonlyTransport } from './transport.ts';

export function readonlyViemTransport(transport: ReadonlyTransport): Transport {
  const make = custom(transport, { retryCount: 0 });
  return params => {
    const built = make(params);
    const request = built.request;
    return { ...built, request: ((args, options) => request(args, { ...options, retryCount: 0 })) as typeof request };
  };
}
