import { ownRecordBytes, sha256Hex, textToBytes } from './bytes.ts';
import { ProviderStoreHold, rehydrate } from './errors.ts';
import type { CheckReport } from './record-ledger.ts';

/**
 * Async replacement for the synchronous file-store boundary. Every method that
 * touches storage returns a promise and MUST be awaited before the caller signs
 * or responds. Records are exact bytes; callers serialize once (for example
 * `${stableStringify(value)}\n` encoded as UTF-8) and parse what they read.
 */
export interface ProviderStore {
  readonly witnessed: true;
  describe(name: string): string;
  /** Deep, witness-checked consistency. Throws ProviderStoreHold; never resolves while inconsistent. */
  assertConsistent(options?: { deep?: boolean; requireQuiescent?: boolean }): Promise<CheckReport>;
  /** One bounded page of committed record names. */
  list(after?: string | null, limit?: number): Promise<{ names: string[]; next: string | null }>;
  has(name: string): Promise<boolean>;
  /** Exact stored bytes, verified against the witness, or null. */
  read(name: string): Promise<Uint8Array | null>;
  /**
   * Atomic first write. `created` is false when the name is already claimed,
   * and `bytes` is then the winner's bytes, never the caller's. A stored name
   * is never overwritten, whatever the digest or requester.
   */
  putOnce(name: string, value: Uint8Array | string): Promise<{ created: boolean; sha256: string; bytes: Uint8Array }>;
}

/** The narrow RPC surface a Worker entrypoint (service binding) exposes. No admin methods. */
export interface ProviderStoreRpc {
  putOnce(name: string, bytes: Uint8Array): Promise<{ created: boolean; sha256: string; bytes?: Uint8Array }>;
  read(name: string): Promise<Uint8Array | null>;
  list(after: string | null, limit: number): Promise<{ names: string[]; next: string | null }>;
  check(options: { deep?: boolean; requireQuiescent?: boolean }): Promise<CheckReport>;
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw rehydrate(error); }
}

/**
 * The client takes its own copy of caller bytes before its first await, sends only
 * that copy, and answers from that copy. A caller that mutates its buffer while
 * the call is in flight changes nothing that is stored or returned. The digest the
 * store acknowledges must match the bytes returned; a mismatch is a hold.
 */
export function createRpcProviderStore(rpc: ProviderStoreRpc, label = 'durable-provider-store'): ProviderStore {
  const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
  return Object.freeze({
    witnessed: true as const,
    describe: (name: string) => `${label}:${name}`,
    assertConsistent: (options: { deep?: boolean; requireQuiescent?: boolean } = {}) => {
      const copy = { deep: flag(options?.deep), requireQuiescent: flag(options?.requireQuiescent) }; // before any await
      return call(() => rpc.check(copy));
    },
    list: (after: string | null = null, limit = 100) => call(() => rpc.list(after, limit)),
    async has(name: string) { return (await call(() => rpc.read(name))) !== null; },
    read: (name: string) => call(() => rpc.read(name)),
    async putOnce(name: string, value: Uint8Array | string) {
      const bytes = typeof value === 'string' ? textToBytes(value) : ownRecordBytes(value); // before the first await
      const out = await call(() => rpc.putOnce(name, bytes));
      const answer = out.created ? new Uint8Array(bytes) : ownRecordBytes(out.bytes);
      if (typeof out.sha256 !== 'string' || out.sha256 !== await sha256Hex(answer)) {
        throw new ProviderStoreHold('the store acknowledged a digest that does not match the returned bytes');
      }
      return { created: out.created === true, sha256: out.sha256, bytes: answer };
    },
  });
}
