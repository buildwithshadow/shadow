// MODEL ONLY. This is an executable model of the admission and reclaim ordering in
// server.mjs (as read from the source), written against the async store. It is NOT
// the provider server, has no HTTP adapter, no signer and no chain access, and is
// not wired into the Worker entrypoints. Externals (guard, prepare, sign, chain
// evidence) are injected so tests can suspend them at chosen points.
//
// It exists to reproduce interleaving risks and to demonstrate the proposed
// invariants for ONE coordinator per provider identity (a single Durable Object).
import { ProviderStoreFull } from '../../src/errors.ts';
import type { DigestBudget } from '../../src/record-ledger.ts';

export interface CoordinatorStore {
  list(after: string | null, limit: number): Promise<{ names: string[]; next: string | null }>;
  read(name: string): Promise<Uint8Array | null>;
  putOnce(name: string, bytes: Uint8Array, options?: { budgetDigest?: string }): Promise<{ created: boolean }>;
  assertConsistent(): Promise<unknown>;
  reserveBudget(digest: string, records: number, bytes: number): Promise<unknown>;
  releaseBudget(digest: string): Promise<{ released: boolean }>;
}

export interface AdmissionPolicy {
  maxOutstanding: number; maxPerAgent: number; maxPerLine: number;
  /** Capacity one admitted digest may still need in the store. */
  budget: DigestBudget;
  pageSize: number;
}

/**
 * naive-scan:       count by paging, then reserve after the awaits. WRONG. Kept to reproduce overbooking.
 * generation-scan:  count by paging, reserve only if no local event happened meanwhile; else rescan (bounded).
 * index:            page once into an in-memory index that every local publication also updates (monotone merge).
 */
export type CountStrategy = 'naive-scan' | 'generation-scan' | 'index';

/** reserved: slot taken, before any record. recorded: admission/prepared exist (durable). signing: signer invoked. reclaiming: a release is being written. */
export type Phase = 'reserved' | 'recorded' | 'signing' | 'reclaiming';

export class AdmissionRefused extends Error { constructor(m: string) { super(m); this.name = 'AdmissionRefused'; } }
export class AdmissionBusy extends Error { constructor(m: string) { super(m); this.name = 'AdmissionBusy'; } }
export class AdmissionConflict extends Error { constructor(m: string) { super(m); this.name = 'AdmissionConflict'; } }

export interface Externals {
  guard(stage: 'start' | 'final'): Promise<void>;
  /** service.prepare: returns the prepared record bytes, or null when the service has no prepare step. */
  prepare(): Promise<Uint8Array | null>;
  sign(): Promise<Uint8Array>;
  /** Test hook, awaited at named points. */
  step?(label: string): Promise<void>;
}

export interface AcceptRequest { digest: string; agent: string; lineId: string; requestName: string }

export interface ModelOptions {
  strategy: CountStrategy;
  /**
   * true reproduces server.mjs as read: a retry of an already-outstanding digest is not
   * registered as in flight, and reclaim does not re-check after its chain read.
   */
  legacyRetries?: boolean;
  maxScanRetries?: number;
}

interface Meta { state: 'outstanding' | 'terminal'; agent?: string; lineId?: string }
interface Entry { phase: Phase; agent: string; lineId: string }

const SLOT = /^(0x[0-9a-f]{64})\.(admission|prepared|acceptance|delivery|released|started|result|payment)\.json$/;
const fileOf = (digest: string, slot: string): string => `${digest}.${slot}.json`;
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(v)}\n`);

export class ProviderCoordinatorModel {
  readonly trace: string[] = [];
  private readonly store: CoordinatorStore;
  private readonly policy: AdmissionPolicy;
  private readonly strategy: CountStrategy;
  private readonly legacy: boolean;
  private readonly maxScanRetries: number;
  private readonly admitting = new Map<string, Entry>();
  private readonly accepting = new Map<string, Promise<{ acceptance: Uint8Array; signed: boolean }>>();
  private readonly index = new Map<string, Meta>();
  private indexReady: Promise<void> | null = null;
  private gen = 0;

  constructor(store: CoordinatorStore, policy: AdmissionPolicy, options: ModelOptions) {
    this.store = store;
    this.policy = policy;
    this.strategy = options.strategy;
    this.legacy = options.legacyRetries === true;
    this.maxScanRetries = options.maxScanRetries ?? 3;
  }

  inFlight(): number { return this.admitting.size; }
  phaseOf(digest: string): Phase | null { return this.admitting.get(digest)?.phase ?? null; }

  // ---- counting ------------------------------------------------------------

  private apply(target: Map<string, Meta>, digest: string, state: Meta['state'], meta?: { agent?: string; lineId?: string }): void {
    const cur = target.get(digest);
    if (cur?.state === 'terminal') return; // a digest only ever moves forward
    if (state === 'terminal') { target.set(digest, { state: 'terminal' }); return; }
    target.set(digest, { state: 'outstanding', agent: meta?.agent ?? cur?.agent, lineId: meta?.lineId ?? cur?.lineId });
  }

  private async scanInto(target: Map<string, Meta>): Promise<void> {
    let after: string | null = null;
    do {
      const page: { names: string[]; next: string | null } = await this.store.list(after, this.policy.pageSize);
      for (const name of page.names) {
        const m = SLOT.exec(name);
        if (!m) continue;
        if (m[2] === 'delivery' || m[2] === 'released') this.apply(target, m[1], 'terminal');
        else if (m[2] === 'admission' || m[2] === 'prepared' || m[2] === 'acceptance') this.apply(target, m[1], 'outstanding');
      }
      after = page.next;
    } while (after !== null);
    for (const [digest, meta] of [...target]) {
      if (meta.state !== 'outstanding' || meta.agent !== undefined) continue;
      const raw = await this.store.read(fileOf(digest, 'admission'));
      if (!raw) continue;
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as { agent?: string; lineId?: string };
      this.apply(target, digest, 'outstanding', { agent: parsed.agent, lineId: parsed.lineId });
    }
  }

  private async scan(): Promise<Map<string, Meta>> { const m = new Map<string, Meta>(); await this.scanInto(m); return m; }

  private ensureIndex(): Promise<void> {
    this.indexReady ??= this.scanInto(this.index).catch(error => { this.indexReady = null; throw error; });
    return this.indexReady;
  }

  /** Records the effect of a publication that just landed. Synchronous, in the same turn as the await that observed it. */
  private noted(name: string, meta?: { agent: string; lineId: string }): void {
    this.gen++;
    const m = SLOT.exec(name);
    if (!m) return;
    if (m[2] === 'delivery' || m[2] === 'released') this.apply(this.index, m[1], 'terminal');
    else if (m[2] === 'admission' || m[2] === 'prepared' || m[2] === 'acceptance') this.apply(this.index, m[1], 'outstanding', meta);
  }

  private async publish(name: string, bytes: Uint8Array, options?: { budgetDigest?: string }, meta?: { agent: string; lineId: string }): Promise<void> {
    await this.store.putOnce(name, bytes, options);
    this.noted(name, meta);
  }

  /** Public so a test or the serve path can add payment/result/delivery records through the same bookkeeping. */
  record(name: string, bytes: Uint8Array): Promise<void> { return this.publish(name, bytes); }

  // ---- the synchronous reservation ------------------------------------------

  private tryReserve(known: Map<string, Meta>, digest: string, agent: string, lineId: string): void {
    const state = known.get(digest)?.state;
    if (state === 'terminal') throw new AdmissionConflict(`digest ${digest} has already ended`);
    const reclaiming = this.admitting.get(digest);
    if (reclaiming?.phase === 'reclaiming') throw new AdmissionBusy(`digest ${digest} is being released; retry`);
    if (state === 'outstanding') { // an interrupted retry already occupies its slot
      if (!this.legacy) this.admitting.set(digest, { phase: 'reserved', agent, lineId });
      this.gen++;
      return;
    }
    const union = new Map<string, { agent?: string; lineId?: string }>();
    for (const [d, m] of known) if (m.state === 'outstanding') union.set(d, m);
    for (const [d, e] of this.admitting) union.set(d, e);
    const all = [...union.values()];
    if (union.size >= this.policy.maxOutstanding ||
        all.filter(e => e.agent?.toLowerCase() === agent.toLowerCase()).length >= this.policy.maxPerAgent ||
        all.filter(e => e.lineId?.toLowerCase() === lineId.toLowerCase()).length >= this.policy.maxPerLine) {
      throw new AdmissionRefused('New purchases are temporarily at capacity; existing purchases can still be recovered');
    }
    this.admitting.set(digest, { phase: 'reserved', agent, lineId });
    this.gen++;
  }

  private async reserve(digest: string, agent: string, lineId: string): Promise<void> {
    if (this.strategy === 'index') {
      await this.ensureIndex();
      this.tryReserve(this.index, digest, agent, lineId); // no await between the counts and the registration
      return;
    }
    if (this.strategy === 'naive-scan') {
      const known = await this.scan();
      this.tryReserve(known, digest, agent, lineId); // stale: other requests ran during the awaits above
      return;
    }
    for (let attempt = 0; attempt < this.maxScanRetries; attempt++) {
      const before = this.gen;
      const known = await this.scan();
      if (this.gen !== before) continue; // any local publication or reservation change invalidates the snapshot
      this.tryReserve(known, digest, agent, lineId);
      return;
    }
    throw new AdmissionBusy('capacity snapshot kept changing; retry');
  }

  // ---- acceptance (models acceptOnce) -----------------------------------------

  acceptNew(req: AcceptRequest, ext: Externals): Promise<{ acceptance: Uint8Array; signed: boolean }> {
    const running = this.accepting.get(req.digest); // server.mjs `once(accepting, digest, ...)`
    if (running) return running;
    const p = this.acceptOnce(req, ext).finally(() => { this.accepting.delete(req.digest); });
    this.accepting.set(req.digest, p);
    return p;
  }

  private async acceptOnce(req: AcceptRequest, ext: Externals): Promise<{ acceptance: Uint8Array; signed: boolean }> {
    const { digest, agent, lineId } = req;
    const stored = await this.store.read(fileOf(digest, 'acceptance'));
    if (stored) return { acceptance: stored, signed: false }; // recovery: no reservation, no index, never blocked by new-purchase work
    await ext.guard('start');
    await this.reserve(digest, agent, lineId);
    let admissionLanded = false;
    try {
      await ext.step?.('reserved');
      try { await this.store.reserveBudget(digest, this.policy.budget.records, this.policy.budget.bytes); } catch (error) {
        if (error instanceof ProviderStoreFull || (error as Error).message?.includes('[provider-store:full]')) {
          throw new AdmissionRefused('New purchases are temporarily at capacity; stored capacity is reserved for accepted work');
        }
        throw error;
      }
      const prepared = await ext.prepare();
      await ext.step?.('prepared');
      await this.publish(req.requestName, enc({ digest }), { budgetDigest: digest });
      await this.publish(fileOf(digest, 'admission'), enc({ digest, agent, lineId }), undefined, { agent, lineId });
      admissionLanded = true;
      const entry = this.admitting.get(digest);
      if (entry && entry.phase === 'reserved') entry.phase = 'recorded';
      if (prepared) await this.publish(fileOf(digest, 'prepared'), prepared);
      await ext.step?.('recorded');
      await this.store.assertConsistent();
      await ext.guard('final');
      await ext.step?.('final');
      // ---- synchronous: nothing is awaited between this check and the signer call ----
      const now = this.admitting.get(digest);
      if (!this.legacy && (!now || now.phase === 'reclaiming')) throw new AdmissionConflict(`reservation for ${digest} was invalidated; nothing was signed`);
      if (!this.legacy && this.index.get(digest)?.state === 'terminal') throw new AdmissionConflict(`digest ${digest} has ended; nothing was signed`);
      if (now) now.phase = 'signing';
      this.trace.push(`sign:${digest}`);
      const signing = ext.sign();
      const acceptance = await signing;
      await this.publish(fileOf(digest, 'acceptance'), acceptance);
      return { acceptance, signed: true };
    } catch (error) {
      if (!admissionLanded) await this.store.releaseBudget(digest).catch(() => undefined); // nothing durable was committed against it
      throw error;
    } finally {
      this.admitting.delete(digest);
      this.gen++;
    }
  }

  // ---- reclaim (models reclaimExpired) -----------------------------------------

  /** `evidence(digest)` is the finalized-chain read; it returns a reason to release, or null. */
  async reclaim(evidence: (digest: string) => Promise<string | null>, batch = 32): Promise<string[]> {
    let known: Map<string, Meta>;
    if (this.strategy === 'index') { await this.ensureIndex(); known = this.index; } else known = await this.scan();
    const candidates = [...known].filter(([d, m]) => m.state === 'outstanding' && !this.admitting.has(d)).map(([d]) => d).slice(0, batch);
    const released: string[] = [];
    for (const digest of candidates) {
      const reason = await evidence(digest); // external, slow: other requests run meanwhile
      if (!reason) continue;
      if (!this.legacy) {
        // The decision and the exclusion happen in one synchronous section.
        if (this.admitting.has(digest) || this.index.get(digest)?.state === 'terminal') continue;
        this.admitting.set(digest, { phase: 'reclaiming', agent: '', lineId: '' });
      }
      try {
        await this.publish(fileOf(digest, 'released'), enc({ digest, reason }));
        this.trace.push(`released:${digest}`);
        released.push(digest);
      } finally {
        if (!this.legacy) this.admitting.delete(digest);
        this.gen++;
      }
    }
    return released;
  }

  /** Paid recovery: reads stored records only. It never waits for the index, a reservation or a purchase. */
  recover(digest: string): Promise<Uint8Array | null> { return this.store.read(fileOf(digest, 'acceptance')); }
}
