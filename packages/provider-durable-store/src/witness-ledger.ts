import { SHA256_HEX, UUID, assertRecordName } from './bytes.ts';
import { ProviderStoreFull, ProviderStoreHold, ProviderStoreInvalid } from './errors.ts';
import { canonicalIdentity, inventoryFingerprint, normalizeIdentity, type InventoryEntry, type ProviderStoreIdentity } from './identity.ts';
import { LIMITS } from './limits.ts';
import { snapshotInventory } from './snapshot.ts';
import { ensureWitnessSchema, metaGet, metaSet, type StorageLike } from './sql.ts';

export interface WitnessEntry { name: string; sha256: string; claimId: string }
export type LedgerState = 'uninitialized' | 'initializing' | 'ready';

export interface WitnessStatus { state: LedgerState; identityMatches: boolean; count: number }

/** What the record store may ask of the witness. Every call carries the identity. */
export interface WitnessPeer {
  publish(identity: ProviderStoreIdentity, entry: WitnessEntry): Promise<{ firstWrite: boolean }>;
  get(identity: ProviderStoreIdentity, name: string): Promise<WitnessEntry | null>;
  list(identity: ProviderStoreIdentity, after: string | null, limit: number): Promise<{ entries: WitnessEntry[]; next: string | null }>;
  status(identity: ProviderStoreIdentity): Promise<WitnessStatus>;
}

/**
 * Append-only digest ledger. It lives in its own Durable Object namespace and
 * its own SQLite database, so a restore of the record database does not touch
 * it. It never initializes itself: only an approved bootstrap creates identity.
 */
export class WitnessLedger {
  private readonly storage: StorageLike;
  constructor(storage: StorageLike) { this.storage = storage; }

  /** Schema only (safe inside blockConcurrencyWhile: no network). */
  init(): void { ensureWitnessSchema(this.storage); }

  private count(): number { return Number(this.storage.sql.exec('SELECT COUNT(*) AS n FROM entries').toArray()[0].n); }

  private state(): LedgerState {
    const value = metaGet(this.storage, 'state');
    return value === 'initializing' || value === 'ready' ? value : 'uninitialized';
  }

  private assertReady(identity: ProviderStoreIdentity): void {
    const canon = canonicalIdentity(identity);
    const stored = metaGet(this.storage, 'identity');
    if (stored === null) throw new ProviderStoreHold('witness identity is missing; it is never recreated implicitly');
    if (stored !== canon || metaGet(this.storage, 'role') !== 'witness') throw new ProviderStoreHold('witness identity does not match this provider deployment');
    const state = this.state();
    if (state !== 'ready') throw new ProviderStoreHold(`witness initialization is ${state}; reset is not available`);
  }

  /** True only for a database with no identity, no state and no entries at all. */
  isEmpty(): boolean {
    return Number(this.storage.sql.exec('SELECT COUNT(*) AS n FROM meta').toArray()[0].n) === 0 && this.count() === 0;
  }

  status(identity: ProviderStoreIdentity): WitnessStatus {
    const stored = metaGet(this.storage, 'identity');
    return { state: this.state(), identityMatches: stored !== null && stored === canonicalIdentity(identity), count: this.count() };
  }

  /** First write wins. Never overwrites; a differing digest or claim is a hold, not a retry. */
  publish(identity: ProviderStoreIdentity, entry: WitnessEntry): { firstWrite: boolean } {
    assertRecordName(entry?.name);
    if (!SHA256_HEX.test(entry.sha256) || !UUID.test(entry.claimId)) throw new ProviderStoreInvalid('Malformed witness entry');
    this.assertReady(identity);
    const existing = this.storage.sql.exec('SELECT sha256, claim_id FROM entries WHERE name = ?', entry.name).toArray();
    if (existing.length) {
      if (existing[0].sha256 !== entry.sha256) throw new ProviderStoreHold(`conflicting witnessed write: ${entry.name}`);
      if (existing[0].claim_id !== entry.claimId) {
        throw new ProviderStoreHold(`witness already holds ${entry.name} from an earlier claim; an interrupted publication is never healed`);
      }
      return { firstWrite: false };
    }
    if (this.count() >= LIMITS.maxRecords) throw new ProviderStoreFull('Witness record limit reached');
    this.storage.sql.exec('INSERT INTO entries (name, sha256, claim_id) VALUES (?, ?, ?)', entry.name, entry.sha256, entry.claimId);
    return { firstWrite: true };
  }

  get(identity: ProviderStoreIdentity, name: string): WitnessEntry | null {
    assertRecordName(name);
    this.assertReady(identity);
    const rows = this.storage.sql.exec('SELECT name, sha256, claim_id FROM entries WHERE name = ?', name).toArray();
    return rows.length ? { name, sha256: String(rows[0].sha256), claimId: String(rows[0].claim_id) } : null;
  }

  list(identity: ProviderStoreIdentity, after: string | null, limit: number): { entries: WitnessEntry[]; next: string | null } {
    this.assertReady(identity);
    const n = Math.min(Math.max(1, Math.trunc(limit)), LIMITS.maxListLimit);
    const rows = this.storage.sql.exec(
      'SELECT name, sha256, claim_id FROM entries WHERE name > ? ORDER BY name LIMIT ?', after ?? '', n + 1,
    ).toArray();
    const page = rows.slice(0, n).map(r => ({ name: String(r.name), sha256: String(r.sha256), claimId: String(r.claim_id) }));
    return { entries: page, next: rows.length > n ? page[page.length - 1].name : null };
  }

  /**
   * Step 1 of the approved bootstrap. Requires a completely empty database and a
   * fingerprint approved by the operator for exactly this inventory.
   */
  async beginBootstrap(identityIn: ProviderStoreIdentity, nonce: string, inventoryIn: InventoryEntry[], approvedFingerprint: string): Promise<void> {
    // Ownership first: identity and inventory are copied before the first await, and the
    // copies, not the caller's objects, are hashed, compared and finally written.
    const identity = normalizeIdentity(identityIn);
    const canon = canonicalIdentity(identity);
    const inventory = snapshotInventory(inventoryIn);
    if (!UUID.test(nonce)) throw new ProviderStoreInvalid('Malformed bootstrap nonce');
    const fingerprint = await inventoryFingerprint(identity, inventory);
    if (!SHA256_HEX.test(approvedFingerprint ?? '') || fingerprint !== approvedFingerprint) {
      throw new ProviderStoreHold('inventory lacks its independently approved fingerprint');
    }
    this.storage.transactionSync(() => {
      const metaRows = Number(this.storage.sql.exec('SELECT COUNT(*) AS n FROM meta').toArray()[0].n);
      if (metaRows > 0 || this.count() > 0) throw new ProviderStoreHold('witness is not empty; initialization and reset are refused');
      metaSet(this.storage, 'identity', canon);
      metaSet(this.storage, 'role', 'witness');
      metaSet(this.storage, 'nonce', nonce);
      metaSet(this.storage, 'state', 'initializing');
      for (const e of inventory) {
        this.storage.sql.exec('INSERT INTO entries (name, sha256, claim_id) VALUES (?, ?, ?)', e.name, e.sha256, crypto.randomUUID());
      }
    });
  }

  commitBootstrap(identity: ProviderStoreIdentity, nonce: string): void {
    if (metaGet(this.storage, 'identity') !== canonicalIdentity(identity) || this.state() !== 'initializing' || metaGet(this.storage, 'nonce') !== nonce) {
      throw new ProviderStoreHold('witness bootstrap cannot be committed in this state');
    }
    metaSet(this.storage, 'state', 'ready');
  }
}
