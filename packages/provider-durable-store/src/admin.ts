import { sha256Hex } from './bytes.ts';
import { ProviderStoreError, ProviderStoreHold } from './errors.ts';
import { normalizeIdentity, type InventoryEntry, type ProviderStoreIdentity } from './identity.ts';
import { snapshotRecords } from './snapshot.ts';

// Ports are structural so the same coordinator runs against Durable Object stubs
// (src/worker.ts) and against the in-process ledgers (test/sim).
export interface RecordsAdminPort {
  isEmpty(): Promise<boolean>;
  beginBootstrap(identity: ProviderStoreIdentity, nonce: string, records: Array<{ name: string; bytes: Uint8Array }>, approvedFingerprint: string, options?: { perDigest?: { records: number; bytes: number } }): Promise<void>;
  commitBootstrap(identity: ProviderStoreIdentity, nonce: string): Promise<void>;
  assertConsistent(identity: ProviderStoreIdentity, options: { deep?: boolean; requireQuiescent?: boolean }): Promise<unknown>;
}
export interface WitnessAdminPort {
  isEmpty(): Promise<boolean>;
  beginBootstrap(identity: ProviderStoreIdentity, nonce: string, inventory: InventoryEntry[], approvedFingerprint: string): Promise<void>;
  commitBootstrap(identity: ProviderStoreIdentity, nonce: string): Promise<void>;
}

/**
 * Creates a store identity on BOTH sides, with the exact approved inventory
 * (possibly empty). The approved fingerprint must come from the operator; each
 * side recomputes the inventory fingerprint itself and refuses a mismatch.
 *
 * Ordering: witness begin, records begin, witness commit, records commit. An
 * interruption leaves a visible `initializing` marker that no operation
 * accepts and bootstrap refuses to restart. There is deliberately no reset.
 */
export async function bootstrapStore(
  ports: { records: RecordsAdminPort; witness: WitnessAdminPort },
  identityIn: ProviderStoreIdentity,
  recordsIn: Array<{ name: string; bytes: Uint8Array }>,
  approvedFingerprint: string,
  options?: { perDigest?: { records: number; bytes: number } },
): Promise<{ records: number }> {
  // Ownership first. Identity, the record list and every record's bytes are copied
  // before the first await; nothing the caller keeps a reference to is used afterwards.
  const identity = normalizeIdentity(identityIn);
  const records = snapshotRecords(recordsIn);
  const perDigest = options?.perDigest ? { records: options.perDigest.records, bytes: options.perDigest.bytes } : undefined;
  const nonce = crypto.randomUUID();
  const inventory: InventoryEntry[] = [];
  for (const r of records) inventory.push({ name: r.name, sha256: await sha256Hex(r.bytes) });
  // A wiped side next to a populated side is a lost identity, not a fresh install.
  // Refuse before writing anything; each side re-checks atomically when it begins.
  if (!(await ports.witness.isEmpty()) || !(await ports.records.isEmpty())) {
    throw new ProviderStoreHold('bootstrap requires both sides to be completely empty; a half-present store is never re-initialized');
  }
  try {
    await ports.witness.beginBootstrap(identity, nonce, inventory, approvedFingerprint);
    await ports.records.beginBootstrap(identity, nonce, [...records], approvedFingerprint, perDigest ? { perDigest: { ...perDigest } } : undefined);
    await ports.witness.commitBootstrap(identity, nonce);
    await ports.records.commitBootstrap(identity, nonce);
    await ports.records.assertConsistent(identity, { deep: true });
  } catch (error) {
    if (error instanceof ProviderStoreError) throw error;
    throw new ProviderStoreHold(`bootstrap interrupted (${error instanceof Error ? error.message : String(error)}); both sides stay held until reconciled`);
  }
  return { records: records.length };
}
