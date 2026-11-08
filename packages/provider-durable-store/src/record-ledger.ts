import {
  SHA256_HEX, UUID, assertRecordName, bindable, blobToBytes, ownRecordBytes, sha256Hex,
} from './bytes.ts';
import { ProviderStoreBusy, ProviderStoreFull, ProviderStoreHold, ProviderStoreInvalid } from './errors.ts';
import {
  canonicalIdentity, inventoryFingerprint, normalizeIdentity, reconcileFingerprint,
  type InventoryEntry, type ProviderStoreIdentity,
} from './identity.ts';
import { LIMITS } from './limits.ts';
import { snapshotRecords } from './snapshot.ts';
import { ensureRecordSchema, metaGet, metaSet, type StorageLike } from './sql.ts';
import type { LedgerState, WitnessPeer, WitnessStatus } from './witness-ledger.ts';

/** Hard storage capacity. The defaults are prototype placeholders, not measured quotas. */
export interface Capacity { maxRecords: number; maxTotalBytes: number }
/** Records and bytes one admitted digest may still need: request binding, admission, prepared, acceptance, started, result, payment, delivery|released. */
export interface DigestBudget { records: number; bytes: number }
export interface PutOptions { budgetDigest?: string }
/** Operator-approved remaining envelope, including a missing record being restored. */
export interface ReconcileOptions { budgetDigest?: string; perDigest?: DigestBudget }
export interface BudgetUsage {
  capacity: Capacity; records: number; bytes: number; budgets: number;
  reserved: DigestBudget; free: DigestBudget;
}
const DIGEST = /^0x[0-9a-f]{64}$/;
const DIGEST_PREFIX = /^(0x[0-9a-f]{64})\./;
const TERMINAL_NAME = /^(0x[0-9a-f]{64})\.(?:delivery|released)\.json$/;
const SLOT_NAME = /^(0x[0-9a-f]{64})\.([a-z]+)\.json$/;

export interface PutResult { created: boolean; sha256: string; bytes: Uint8Array }
export interface CheckReport { records: number; witnessEntries: number; inFlight: number }
export interface InspectReport {
  state: LedgerState; healthy: boolean; committed: number; pending: string[];
  witness: WitnessStatus | null; issues: string[]; issuesTruncated: boolean;
}

interface Row { name: string; state: 'pending' | 'committed'; sha256: string; size: number; claimId: string }

const noop = (): void => undefined;
const MAX_ISSUES = 50;

/**
 * Immutable record store. Rules that keep it correct under interleaving:
 *  - A synchronous section never awaits, so check-then-claim is atomic.
 *  - The durable claim row is written BEFORE any await on the witness.
 *  - The witness digest is published BEFORE the record becomes committed.
 *  - A pending claim with no live in-flight publication means an interrupted
 *    write. It holds the store; it is never resumed, retried or healed here.
 */
export class RecordLedger {
  private readonly storage: StorageLike;
  private readonly witnessFor: (identity: ProviderStoreIdentity) => WitnessPeer;
  private readonly inflight = new Map<string, Promise<void>>();
  private epoch = 0;
  private readonly capacity: Capacity;

  constructor(
    storage: StorageLike, witnessFor: (identity: ProviderStoreIdentity) => WitnessPeer,
    capacity: Capacity = { maxRecords: LIMITS.maxRecords, maxTotalBytes: LIMITS.maxTotalBytes },
  ) {
    for (const v of [capacity.maxRecords, capacity.maxTotalBytes]) if (!Number.isSafeInteger(v) || v < 1) throw new ProviderStoreInvalid('Capacity must be positive integers');
    this.storage = storage;
    this.witnessFor = witnessFor;
    this.capacity = { maxRecords: capacity.maxRecords, maxTotalBytes: capacity.maxTotalBytes };
  }

  /** Schema only (safe inside blockConcurrencyWhile: no network). */
  init(): void { ensureRecordSchema(this.storage); }

  // ---- synchronous helpers -------------------------------------------------

  private state(): LedgerState {
    const value = metaGet(this.storage, 'state');
    return value === 'initializing' || value === 'ready' ? value : 'uninitialized';
  }

  private assertReady(identity: ProviderStoreIdentity): void {
    const canon = canonicalIdentity(identity);
    const stored = metaGet(this.storage, 'identity');
    if (stored === null) throw new ProviderStoreHold('store identity is missing; it is never recreated implicitly');
    if (stored !== canon || metaGet(this.storage, 'role') !== 'records') throw new ProviderStoreHold('store identity does not match this provider deployment');
    const state = this.state();
    if (state !== 'ready') throw new ProviderStoreHold(`store initialization is ${state}; reset is not available`);
  }

  private toRow(r: Record<string, unknown>): Row {
    return { name: String(r.name), state: r.state === 'pending' ? 'pending' : 'committed', sha256: String(r.sha256), size: Number(r.size), claimId: String(r.claim_id) };
  }

  private row(name: string): Row | null {
    const rows = this.storage.sql.exec('SELECT name, state, sha256, size, claim_id FROM records WHERE name = ?', name).toArray();
    return rows.length ? this.toRow(rows[0]) : null;
  }

  private rows(): Row[] {
    return this.storage.sql.exec('SELECT name, state, sha256, size, claim_id FROM records ORDER BY name').toArray().map(r => this.toRow(r));
  }

  private bytesOf(name: string): Uint8Array | null {
    const rows = this.storage.sql.exec('SELECT bytes FROM records WHERE name = ?', name).toArray();
    return rows.length ? blobToBytes(rows[0].bytes) : null;
  }

  private usage(): { count: number; total: number } {
    const r = this.storage.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM records').toArray()[0];
    return { count: Number(r.n), total: Number(r.s) };
  }

  // ---- capacity and per-digest budgets ----------------------------------------

  private pool() {
    const u = this.usage();
    const r = this.storage.sql.exec(
      'SELECT COALESCE(SUM(MAX(records - used_records, 0)), 0) AS r, COALESCE(SUM(MAX(bytes - used_bytes, 0)), 0) AS b, COUNT(*) AS n FROM budgets',
    ).toArray()[0];
    const reservedRecords = Number(r.r), reservedBytes = Number(r.b);
    return {
      rows: u.count, bytes: u.total, budgets: Number(r.n), reservedRecords, reservedBytes,
      freeRecords: this.capacity.maxRecords - u.count - reservedRecords,
      freeBytes: this.capacity.maxTotalBytes - u.total - reservedBytes,
    };
  }

  private budgetRow(digest: string): { records: number; bytes: number; usedRecords: number; usedBytes: number } | null {
    const rows = this.storage.sql.exec('SELECT records, bytes, used_records, used_bytes FROM budgets WHERE digest = ?', digest).toArray();
    return rows.length ? { records: Number(rows[0].records), bytes: Number(rows[0].bytes), usedRecords: Number(rows[0].used_records), usedBytes: Number(rows[0].used_bytes) } : null;
  }

  /**
   * One new record must fit. It may draw on the reservation of the digest it is
   * charged to (explicit `budgetDigest`, else the digest in its name). Anything
   * beyond that reservation, and every uncharged record, may only use capacity
   * that no admitted digest has reserved. Synchronous: callers rely on that.
   */
  private admit(name: string, size: number, budgetDigest: string | null): void {
    const digest = budgetDigest ?? DIGEST_PREFIX.exec(name)?.[1] ?? null;
    const budget = digest ? this.budgetRow(digest) : null;
    const pool = this.pool();
    const fromRecords = budget ? Math.min(1, Math.max(budget.records - budget.usedRecords, 0)) : 0;
    const fromBytes = budget ? Math.min(size, Math.max(budget.bytes - budget.usedBytes, 0)) : 0;
    if (1 - fromRecords > pool.freeRecords) throw new ProviderStoreFull('Record capacity is exhausted or reserved for accepted work');
    if (size - fromBytes > pool.freeBytes) throw new ProviderStoreFull('Byte capacity is exhausted or reserved for accepted work');
    if (budget && digest) {
      this.storage.sql.exec('UPDATE budgets SET used_records = used_records + 1, used_bytes = used_bytes + ? WHERE digest = ?', size, digest);
    }
  }

  /** A delivery or release ends the digest: whatever it did not use returns to the pool, atomically with the commit. */
  private releaseOnTerminal(name: string): void {
    const terminal = TERMINAL_NAME.exec(name);
    if (terminal) this.storage.sql.exec('DELETE FROM budgets WHERE digest = ?', terminal[1]);
  }

  /**
   * Reserves capacity for everything an admitted digest may still store. Refuses
   * (ProviderStoreFull) when the unreserved pool cannot hold it, so new work can
   * never take capacity that accepted work needs. Idempotent per digest.
   */
  reserveBudget(identityIn: ProviderStoreIdentity, digest: string, records: number, bytes: number): { reserved: boolean } {
    const identity = normalizeIdentity(identityIn);
    if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new ProviderStoreInvalid('Malformed budget digest');
    if (!Number.isSafeInteger(records) || records < 1 || records > this.capacity.maxRecords) throw new ProviderStoreInvalid('Malformed budget record count');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.capacity.maxTotalBytes) throw new ProviderStoreInvalid('Malformed budget byte count');
    this.assertReady(identity);
    // Terminal commits already released this digest. A late duplicate request
    // binding cannot recreate a reservation after that atomic release.
    if (['delivery','released'].some(slot => this.row(`${digest}.${slot}.json`)?.state === 'committed')) return { reserved: false };
    if (this.budgetRow(digest)) return { reserved: false };
    const pool = this.pool();
    if (records > pool.freeRecords || bytes > pool.freeBytes) throw new ProviderStoreFull('Not enough unreserved capacity for another accepted request');
    this.storage.sql.exec('INSERT INTO budgets (digest, records, bytes) VALUES (?, ?, ?)', digest, records, bytes);
    return { reserved: true };
  }

  /**
   * Gives back a reservation, only while the digest has no admission, prepared,
   * acceptance or terminal record. Once any of those exist the reservation stays
   * until a delivery or release ends the digest.
   */
  releaseBudget(identityIn: ProviderStoreIdentity, digest: string): { released: boolean } {
    const identity = normalizeIdentity(identityIn);
    if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new ProviderStoreInvalid('Malformed budget digest');
    this.assertReady(identity);
    const committing = ['admission', 'prepared', 'acceptance', 'delivery', 'released'].map(slot => `${digest}.${slot}.json`);
    const held = this.storage.sql.exec(
      `SELECT COUNT(*) AS n FROM records WHERE name IN (${committing.map(() => '?').join(',')})`, ...committing,
    ).toArray()[0];
    if (Number(held.n) > 0) return { released: false };
    this.storage.sql.exec('DELETE FROM budgets WHERE digest = ?', digest);
    return { released: true };
  }

  budgetUsage(identityIn: ProviderStoreIdentity): BudgetUsage {
    const identity = normalizeIdentity(identityIn);
    this.assertReady(identity);
    const p = this.pool();
    return {
      capacity: { ...this.capacity }, records: p.rows, bytes: p.bytes, budgets: p.budgets,
      reserved: { records: p.reservedRecords, bytes: p.reservedBytes }, free: { records: p.freeRecords, bytes: p.freeBytes },
    };
  }

  // ---- writes --------------------------------------------------------------

  async putOnce(identityIn: ProviderStoreIdentity, name: string, bytesIn: Uint8Array, options?: PutOptions): Promise<PutResult> {
    // Ownership first: everything caller-owned is copied or validated before the first await.
    assertRecordName(name);
    const budgetDigest = options?.budgetDigest ?? null;
    if (budgetDigest !== null && (typeof budgetDigest !== 'string' || !DIGEST.test(budgetDigest))) throw new ProviderStoreInvalid('Malformed budget digest');
    const identity = normalizeIdentity(identityIn);
    const bytes = ownRecordBytes(bytesIn);
    const digest = await sha256Hex(bytes); // hashing is async, so it happens before the atomic claim
    // Deep, like the file store: every write re-verifies stored bytes against the
    // witness before it can add to them. Cost is bounded by LIMITS but unmeasured.
    await this.assertConsistent(identity, { deep: true });
    for (let attempt = 0; attempt < 4; attempt++) {
      // ---- synchronous section: no await until the claim row exists ----
      this.assertReady(identity);
      const existing = this.row(name);
      if (existing?.state === 'committed') {
        const kept = await this.read(identity, name); // verified against the witness
        if (kept === null) throw new ProviderStoreHold(`record vanished: ${name}`);
        return { created: false, sha256: existing.sha256, bytes: kept };
      }
      if (existing) {
        const flight = this.inflight.get(name);
        if (!flight) throw new ProviderStoreHold(`interrupted publication of ${name}; it is not resumed automatically`);
        await flight.catch(noop); // the winner decides; re-evaluate afterwards
        continue;
      }
      this.admit(name, bytes.byteLength, budgetDigest); // capacity check and budget draw, in this same synchronous section
      const claimId = crypto.randomUUID();
      this.storage.sql.exec(
        "INSERT INTO records (name, state, sha256, size, bytes, claim_id) VALUES (?, 'pending', ?, ?, ?, ?)",
        name, digest, bytes.byteLength, bindable(bytes), claimId,
      );
      this.epoch++;
      const flight: Promise<void> = this.publish(identity, name, digest, claimId).finally(() => {
        if (this.inflight.get(name) === flight) this.inflight.delete(name);
      });
      this.inflight.set(name, flight);
      await flight;
      return { created: true, sha256: digest, bytes };
    }
    throw new ProviderStoreBusy(`competing publication of ${name} did not settle; retry`);
  }

  private async publish(identity: ProviderStoreIdentity, name: string, digest: string, claimId: string): Promise<void> {
    const out = await this.witnessFor(identity).publish(identity, { name, sha256: digest, claimId });
    if (!out.firstWrite) throw new ProviderStoreHold(`witness already held ${name} before this claim`);
    this.storage.transactionSync(() => {
      const row = this.row(name);
      if (row?.state !== 'pending' || row.claimId !== claimId || row.sha256 !== digest) {
        throw new ProviderStoreHold(`claim for ${name} changed during publication`);
      }
      this.storage.sql.exec("UPDATE records SET state = 'committed' WHERE name = ? AND state = 'pending' AND claim_id = ?", name, claimId);
      this.releaseOnTerminal(name);
    });
    this.epoch++;
  }

  // ---- reads ---------------------------------------------------------------

  async read(identityIn: ProviderStoreIdentity, name: string): Promise<Uint8Array | null> {
    assertRecordName(name);
    const identity = normalizeIdentity(identityIn);
    for (let attempt = 0; attempt < 4; attempt++) {
      this.assertReady(identity);
      const row = this.row(name);
      if (row?.state === 'pending') {
        const flight = this.inflight.get(name);
        if (!flight) throw new ProviderStoreHold(`interrupted publication of ${name}`);
        await flight.catch(noop);
        continue;
      }
      const witness = this.witnessFor(identity);
      if (row) {
        const bytes = this.bytesOf(name);
        if (!bytes || bytes.byteLength !== row.size || await sha256Hex(bytes) !== row.sha256) {
          throw new ProviderStoreHold(`stored record was altered or is missing: ${name}`);
        }
        const kept = await witness.get(identity, name);
        if (!kept) throw new ProviderStoreHold(`unwitnessed record: ${name}`);
        if (kept.sha256 !== row.sha256) throw new ProviderStoreHold(`record differs from durable witness: ${name}`);
        return bytes;
      }
      const kept = await witness.get(identity, name);
      if (this.row(name)) continue; // a publication landed while we awaited; evaluate it
      if (kept) throw new ProviderStoreHold(`witness holds ${name} but the record is missing`);
      return null;
    }
    throw new ProviderStoreBusy(`record ${name} kept changing; retry`);
  }

  list(identityIn: ProviderStoreIdentity, after: string | null, limit: number = LIMITS.defaultListLimit): { names: string[]; next: string | null } {
    const identity = normalizeIdentity(identityIn);
    this.assertReady(identity);
    const n = Math.min(Math.max(1, Math.trunc(Number(limit) || LIMITS.defaultListLimit)), LIMITS.maxListLimit);
    const interrupted = this.rows().find(r => r.state === 'pending' && !this.inflight.has(r.name));
    if (interrupted) throw new ProviderStoreHold(`interrupted publication of ${interrupted.name}`);
    const rows = this.storage.sql.exec(
      "SELECT name FROM records WHERE state = 'committed' AND name > ? ORDER BY name LIMIT ?", after ?? '', n + 1,
    ).toArray();
    const names = rows.slice(0, n).map(r => String(r.name));
    return { names, next: rows.length > n ? names[names.length - 1] : null };
  }

  // ---- consistency ---------------------------------------------------------

  /**
   * Point-in-time comparison of this database with the witness. Awaiting the
   * witness lets other requests run, so a witness entry unknown at snapshot
   * time is re-read against the live table. Anything not explained by a live
   * in-flight claim is reported, never tolerated.
   */
  private async collectIssues(identity: ProviderStoreIdentity, deep: boolean): Promise<{ issues: string[]; committed: number; witnessEntries: number }> {
    this.assertReady(identity);
    const snapshot = this.rows();
    const live = new Set(this.inflight.keys());
    const issues: string[] = [];
    const byName = new Map(snapshot.map(r => [r.name, r]));
    for (const r of snapshot) if (r.state === 'pending' && !live.has(r.name)) issues.push(`interrupted publication: ${r.name}`);

    const witness = this.witnessFor(identity);
    const seen = new Map<string, { sha256: string; claimId: string }>();
    let after: string | null = null;
    for (let page = 0; ; page++) {
      if (page > LIMITS.maxRecords / LIMITS.witnessPageSize + 2) throw new ProviderStoreHold('witness listing did not terminate');
      const out = await witness.list(identity, after, LIMITS.witnessPageSize);
      for (const e of out.entries) seen.set(e.name, e);
      if (seen.size > LIMITS.maxRecords) throw new ProviderStoreHold('witness holds more records than the configured limit');
      if (!out.next) break;
      after = out.next;
    }
    for (const [name, entry] of seen) {
      const was = byName.get(name);
      if (was) {
        if (was.sha256 !== entry.sha256) issues.push(`record differs from durable witness: ${name}`);
        else if (was.state === 'pending' && was.claimId !== entry.claimId) issues.push(`pending claim differs from witness: ${name}`);
        continue;
      }
      const now = this.row(name); // not in the snapshot: explained only by a live claim or a fresh commit
      const explained = now && now.sha256 === entry.sha256 &&
        (now.state === 'committed' || (this.inflight.has(name) && now.claimId === entry.claimId));
      if (!explained) issues.push(`witness ahead of record: ${name}`);
    }
    for (const r of snapshot) if (r.state === 'committed' && !seen.has(r.name)) issues.push(`unwitnessed record: ${r.name}`);

    if (deep) {
      for (const r of snapshot) {
        if (r.state !== 'committed') continue;
        const bytes = this.bytesOf(r.name);
        if (!bytes || bytes.byteLength !== r.size || await sha256Hex(bytes) !== r.sha256) issues.push(`record altered or missing: ${r.name}`);
      }
    }
    return { issues, committed: snapshot.filter(r => r.state === 'committed').length, witnessEntries: seen.size };
  }

  /**
   * Throws ProviderStoreHold on any inconsistency. `deep` re-hashes every
   * stored record. `requireQuiescent` additionally refuses to answer while a
   * publication is in flight or started during the check (ProviderStoreBusy).
   */
  async assertConsistent(identityIn: ProviderStoreIdentity, options: { deep?: boolean; requireQuiescent?: boolean } = {}): Promise<CheckReport> {
    const identity = normalizeIdentity(identityIn);
    const startEpoch = this.epoch;
    const report = await this.collectIssues(identity, options.deep ?? true);
    if (report.issues.length) throw new ProviderStoreHold(report.issues.slice(0, 5).join('; '));
    if (options.requireQuiescent && (this.inflight.size > 0 || this.epoch !== startEpoch)) {
      throw new ProviderStoreBusy('a publication is in flight; the check cannot certify a quiescent store');
    }
    return { records: report.committed, witnessEntries: report.witnessEntries, inFlight: this.inflight.size };
  }

  /** Read-only diagnosis for the operator. Never throws a hold; never changes state. */
  async inspect(identityIn: ProviderStoreIdentity): Promise<InspectReport> {
    const identity = normalizeIdentity(identityIn);
    const issues: string[] = [];
    let witness: WitnessStatus | null = null;
    try { witness = await this.witnessFor(identity).status(identity); } catch (e) { issues.push(`witness unreachable: ${(e as Error).message}`); }
    if (witness && witness.state !== 'ready') issues.push(`witness is ${witness.state}`);
    if (witness && !witness.identityMatches) issues.push('witness identity does not match');
    try { this.assertReady(identity); } catch (e) { issues.push((e as Error).message); }
    if (!issues.length) {
      try { issues.push(...(await this.collectIssues(identity, true)).issues); } catch (e) { issues.push((e as Error).message); }
    }
    const rows = this.rows();
    return {
      state: this.state(), healthy: issues.length === 0, committed: rows.filter(r => r.state === 'committed').length,
      pending: rows.filter(r => r.state === 'pending').map(r => r.name), witness,
      issues: issues.slice(0, MAX_ISSUES), issuesTruncated: issues.length > MAX_ISSUES,
    };
  }

  // ---- approved administrative operations (never reachable over HTTP) -------

  /** True only for a database with no identity, no state and no records at all. */
  isEmpty(): boolean {
    return Number(this.storage.sql.exec('SELECT COUNT(*) AS n FROM meta').toArray()[0].n) === 0 && this.usage().count === 0;
  }

  async beginBootstrap(
    identityIn: ProviderStoreIdentity, nonce: string, recordsIn: Array<{ name: string; bytes: Uint8Array }>, approvedFingerprint: string,
    options?: { perDigest?: DigestBudget },
  ): Promise<void> {
    const identity = normalizeIdentity(identityIn);
    const perDigest = options?.perDigest ? { records: options.perDigest.records, bytes: options.perDigest.bytes } : null; // copied before the first await
    if (perDigest && (!Number.isSafeInteger(perDigest.records) || perDigest.records < 1 || !Number.isSafeInteger(perDigest.bytes) || perDigest.bytes < 0)) {
      throw new ProviderStoreInvalid('Malformed per-digest budget');
    }
    const records = snapshotRecords(recordsIn); // bounds, then private copies, before any await
    if (!UUID.test(nonce)) throw new ProviderStoreInvalid('Malformed bootstrap nonce');
    const entries: InventoryEntry[] = [];
    const prepared: Array<{ name: string; bytes: Uint8Array; sha256: string }> = [];
    for (const r of records) {
      const sha256 = await sha256Hex(r.bytes);
      entries.push({ name: r.name, sha256 });
      prepared.push({ name: r.name, bytes: r.bytes, sha256 });
    }
    const fingerprint = await inventoryFingerprint(identity, entries);
    if (!SHA256_HEX.test(approvedFingerprint ?? '') || fingerprint !== approvedFingerprint) {
      throw new ProviderStoreHold('inventory lacks its independently approved fingerprint');
    }
    this.storage.transactionSync(() => {
      const metaRows = Number(this.storage.sql.exec('SELECT COUNT(*) AS n FROM meta').toArray()[0].n);
      if (metaRows > 0 || this.usage().count > 0) throw new ProviderStoreHold('store is not empty; initialization and reset are refused');
      metaSet(this.storage, 'identity', canonicalIdentity(identity));
      metaSet(this.storage, 'role', 'records');
      metaSet(this.storage, 'nonce', nonce);
      metaSet(this.storage, 'state', 'initializing');
      for (const p of prepared) {
        this.storage.sql.exec(
          "INSERT INTO records (name, state, sha256, size, bytes, claim_id) VALUES (?, 'committed', ?, ?, ?, ?)",
          p.name, p.sha256, p.bytes.byteLength, bindable(p.bytes), `import:${nonce}`,
        );
      }
      if (perDigest) this.deriveBudgets(prepared, perDigest);
      const pool = this.pool();
      if (pool.freeRecords < 0 || pool.freeBytes < 0) {
        throw new ProviderStoreFull('Import does not fit the store capacity together with the reservations outstanding work needs');
      }
    });
  }

  /**
   * Imported digests that are still outstanding (admission, prepared or acceptance
   * present, no delivery or release) get their remaining reservation back, derived
   * only from record names and sizes. The policy is operator input and is NOT part
   * of the approved inventory fingerprint; a wrong policy mis-sizes capacity, it
   * cannot change any record.
   */
  private deriveBudgets(prepared: Array<{ name: string; bytes: Uint8Array }>, perDigest: DigestBudget): void {
    const byDigest = new Map<string, { slots: Set<string>; records: number; bytes: number }>();
    for (const p of prepared) {
      const m = SLOT_NAME.exec(p.name);
      if (!m) continue;
      const entry = byDigest.get(m[1]) ?? { slots: new Set<string>(), records: 0, bytes: 0 };
      entry.slots.add(m[2]); entry.records++; entry.bytes += p.bytes.byteLength;
      byDigest.set(m[1], entry);
    }
    for (const [digest, e] of byDigest) {
      const outstanding = (e.slots.has('admission') || e.slots.has('prepared') || e.slots.has('acceptance')) && !e.slots.has('delivery') && !e.slots.has('released');
      if (!outstanding) continue;
      this.storage.sql.exec('INSERT INTO budgets (digest, records, bytes, used_records, used_bytes) VALUES (?, ?, ?, ?, ?)', digest, perDigest.records, perDigest.bytes, e.records, e.bytes);
    }
  }

  commitBootstrap(identityIn: ProviderStoreIdentity, nonce: string): void {
    const identity = normalizeIdentity(identityIn);
    if (metaGet(this.storage, 'identity') !== canonicalIdentity(identity) || this.state() !== 'initializing' || metaGet(this.storage, 'nonce') !== nonce) {
      throw new ProviderStoreHold('store bootstrap cannot be committed in this state');
    }
    metaSet(this.storage, 'state', 'ready');
  }

  /**
   * Completes ONE record that the witness already holds, from original bytes the
   * operator supplies. The bytes must hash to the witness digest and the call
   * needs the operator's approval value for exactly (identity, name, digest).
   * It cannot create a record the witness has not seen, cannot change a
   * committed record, and does nothing about a record without a witness.
   */
  async completeFromWitness(identityIn: ProviderStoreIdentity, name: string, bytesIn: Uint8Array, approvedFingerprint: string, options?: ReconcileOptions): Promise<{ completed: boolean }> {
    assertRecordName(name);
    const identity = normalizeIdentity(identityIn);
    const bytes = ownRecordBytes(bytesIn); // copy before the first await
    const budgetDigest = options?.budgetDigest ?? null;
    const perDigest = options?.perDigest ? { records: options.perDigest.records, bytes: options.perDigest.bytes } : null;
    const namedDigest = DIGEST_PREFIX.exec(name)?.[1] ?? null;
    if (budgetDigest !== null && (typeof budgetDigest !== 'string' || !DIGEST.test(budgetDigest) || (namedDigest !== null && namedDigest !== budgetDigest))) throw new ProviderStoreInvalid('Malformed or conflicting reconciliation budget digest');
    if (perDigest && (!Number.isSafeInteger(perDigest.records) || perDigest.records < 1 || !Number.isSafeInteger(perDigest.bytes) || perDigest.bytes < 0)) throw new ProviderStoreInvalid('Malformed reconciliation reservation');
    const attributedDigest = budgetDigest ?? namedDigest;
    if (perDigest && attributedDigest === null) throw new ProviderStoreInvalid('Reconciliation budget needs explicit request attribution');
    const digest = await sha256Hex(bytes);
    if (!SHA256_HEX.test(approvedFingerprint ?? '') || await reconcileFingerprint(identity, name, digest) !== approvedFingerprint) {
      throw new ProviderStoreHold('reconciliation lacks its independently approved fingerprint');
    }
    this.assertReady(identity);
    const witnessed = await this.witnessFor(identity).get(identity, name);
    if (!witnessed || witnessed.sha256 !== digest) throw new ProviderStoreHold(`supplied bytes do not match the witness digest for ${name}`);
    if (this.inflight.has(name)) throw new ProviderStoreBusy(`publication of ${name} is still in flight`);
    return this.storage.transactionSync(() => {
      // A rollback may precede the original reservation. Do not restore an
      // outstanding acceptance as healthy while leaving its delivery unreserved.
      const outstandingSlot = /\.(?:admission|prepared|acceptance)\.json$/.test(name);
      const terminal = attributedDigest !== null && ['delivery', 'released'].some(slot => this.row(`${attributedDigest}.${slot}.json`)?.state === 'committed');
      if (attributedDigest !== null && !terminal && !this.budgetRow(attributedDigest) && (outstandingSlot || budgetDigest !== null || perDigest !== null)) {
        if (!perDigest) throw new ProviderStoreHold('restoring outstanding work requires an operator-approved remaining reservation');
        this.reserveBudget(identity, attributedDigest, perDigest.records, perDigest.bytes);
      }
      const row = this.row(name);
      if (row?.state === 'committed') {
        if (row.sha256 !== digest) throw new ProviderStoreHold(`committed record differs from the supplied bytes: ${name}`);
        return { completed: false };
      }
      if (row) {
        if (row.sha256 !== digest) throw new ProviderStoreHold(`pending claim differs from the supplied bytes: ${name}`);
        this.storage.sql.exec("UPDATE records SET state = 'committed' WHERE name = ? AND state = 'pending'", name);
        this.releaseOnTerminal(name);
        return { completed: true };
      }
      this.admit(name, bytes.byteLength, budgetDigest);
      this.storage.sql.exec(
        "INSERT INTO records (name, state, sha256, size, bytes, claim_id) VALUES (?, 'committed', ?, ?, ?, ?)",
        name, digest, bytes.byteLength, bindable(bytes), `reconcile:${witnessed.claimId}`,
      );
      this.releaseOnTerminal(name);
      return { completed: true };
    });
  }
}
