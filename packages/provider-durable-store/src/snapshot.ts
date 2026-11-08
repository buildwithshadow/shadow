import { SHA256_HEX, assertRecordName, ownRecordBytes } from './bytes.ts';
import { ProviderStoreFull, ProviderStoreInvalid } from './errors.ts';
import type { InventoryEntry } from './identity.ts';
import { LIMITS } from './limits.ts';

// Snapshots of caller-owned collections. Each runs synchronously and must be the
// FIRST thing an async entry point does: count and size bounds are checked before
// any copy, each element is read exactly once, and the result is frozen and
// private. Mutating, extending or replacing the caller's array, its objects or
// its buffers afterwards has no effect on the operation.

export interface OwnedRecord { readonly name: string; readonly bytes: Uint8Array }

function elements(value: unknown, what: string): { length: number; at(i: number): unknown } {
  if (!Array.isArray(value)) throw new ProviderStoreInvalid(`${what} must be an array`);
  const length = value.length;
  if (length > LIMITS.maxRecords) throw new ProviderStoreFull(`${what} exceeds the record limit`);
  return { length, at: i => value[i] as unknown };
}

export function snapshotRecords(input: unknown): readonly OwnedRecord[] {
  const list = elements(input, 'Import');
  const out: OwnedRecord[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list.at(i) as { name?: unknown; bytes?: unknown } | null;
    const name = item?.name, bytesIn = item?.bytes; // one read each
    assertRecordName(name);
    if (seen.has(name)) throw new ProviderStoreInvalid('Import contains a duplicate record name');
    seen.add(name);
    const bytes = ownRecordBytes(bytesIn, LIMITS.maxTotalBytes - total);
    total += bytes.byteLength;
    out.push(Object.freeze({ name, bytes }));
  }
  return Object.freeze(out);
}

export function snapshotInventory(input: unknown): readonly InventoryEntry[] {
  const list = elements(input, 'Inventory');
  const out: InventoryEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const item = list.at(i) as { name?: unknown; sha256?: unknown } | null;
    const name = item?.name, sha256 = item?.sha256;
    assertRecordName(name);
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) throw new ProviderStoreInvalid('Inventory contains an invalid digest');
    if (seen.has(name)) throw new ProviderStoreInvalid('Inventory contains a duplicate record name');
    seen.add(name);
    out.push(Object.freeze({ name, sha256 }));
  }
  return Object.freeze(out);
}
