import { textToBytes } from '../../provider-durable-store/src/bytes.ts';
import { ProviderStoreError, rehydrate } from '../../provider-durable-store/src/errors.ts';
import { LIMITS } from '../../provider-durable-store/src/limits.ts';
// The ACTUAL provider's own serializer and hold type, imported from the pinned source, never re-implemented.
import { stableStringify } from '../../../app/scripts/float-mainnet-format.mjs';
import { ProviderStoreHold } from '../../../examples/float-mainnet-provider-server/store-witness.mjs';
import type { RecordPort } from './record-port.ts';

const PAGE = 200;
const MAX_PAGES = Math.ceil(LIMITS.maxRecords / PAGE) + 2;

/** The `recordStore` the provider accepts (server.mjs: read, putOnce, list, has, assertConsistent, describe, witnessed). */
export interface ProviderRecordStore {
  readonly witnessed: true;
  describe(name: string): string;
  assertConsistent(): Promise<void>;
  list(): Promise<string[]>;
  has(name: string): Promise<boolean>;
  read(name: string): Promise<unknown>;
  putOnce(name: string, value: unknown): Promise<boolean>;
}

/**
 * Upstream diagnostics (record names, digests, witness state, marker text, stacks) never cross this line.
 * A hold becomes the provider's own ProviderStoreHold with a fixed sentence; every other failure becomes a
 * bare Error with a fixed sentence and no cause. The provider logs 500s with `inspect(error)`, so what is
 * thrown here is what reaches its log.
 */
function sanitize(error: unknown): Error {
  if (error instanceof ProviderStoreHold) return error;
  const mapped = rehydrate(error);
  if (mapped instanceof ProviderStoreError && mapped.kind === 'hold') {
    return new ProviderStoreHold('the record store is held and needs operator reconciliation');
  }
  return new Error('record store unavailable');
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw sanitize(error); }
}

/**
 * Fixed-identity JSON adapter over the byte-exact store. Serialization is the provider's own
 * `stableStringify(value) + "\n"` encoded as UTF-8, written once. Reads parse only the bytes the store
 * returns after verifying them against the witness; nothing is re-serialized, normalized or re-signed.
 */
export function createIdentityRecordStore(port: RecordPort): ProviderRecordStore {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return Object.freeze({
    witnessed: true as const,
    describe: (name: string) => `provider record ${name}`,
    assertConsistent: () => guarded(async () => { await port.check(); }),
    async list() {
      return guarded(async () => {
        const names: string[] = [];
        let after: string | null = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const out: { names: string[]; next: string | null } = await port.list(after, PAGE);
          names.push(...out.names);
          if (names.length > LIMITS.maxRecords) throw new ProviderStoreHold('the record store is held and needs operator reconciliation');
          if (out.next === null) return names;
          after = out.next;
        }
        throw new ProviderStoreHold('the record store is held and needs operator reconciliation'); // the listing never ended: refuse a partial answer
      });
    },
    async has(name: string) { return guarded(async () => (await port.read(name)) !== null); },
    async read(name: string) {
      return guarded(async () => {
        const bytes = await port.read(name);
        return bytes === null ? null : JSON.parse(decoder.decode(bytes)) as unknown;
      });
    },
    async putOnce(name: string, value: unknown) {
      return guarded(async () => {
        const bytes = textToBytes(`${stableStringify(value)}\n`);
        return (await port.putOnce(name, bytes)).created;
      });
    },
  });
}
