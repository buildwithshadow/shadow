// IN-PROCESS SIMULATION. This is NOT workerd and NOT Durable Objects. It runs the
// same ledger code against node:sqlite so protocol logic (atomic claims,
// interleaving at awaits, hold rules, rollback detection) is exercised without
// any Cloudflare dependency. It cannot show input/output gates, eviction,
// RPC serialization, quotas or CPU limits. See README "What is and is not proven".
import { DatabaseSync } from 'node:sqlite';
import { bootstrapStore } from '../../src/admin.ts';
import { inventoryFingerprint, type InventoryEntry, type ProviderStoreIdentity } from '../../src/identity.ts';
import { RecordLedger, type Capacity } from '../../src/record-ledger.ts';
import { ensureRecordSchema, ensureWitnessSchema, type SqlCursor, type StorageLike } from '../../src/sql.ts';
import { WitnessLedger, type WitnessEntry, type WitnessPeer } from '../../src/witness-ledger.ts';
import { sha256Hex } from '../../src/bytes.ts';

type Snapshot = Record<string, Array<Record<string, unknown>>>;

export class SimStorage implements StorageLike {
  private db = new DatabaseSync(':memory:');
  private readonly kind: 'records' | 'witness';
  private readonly table: string;
  readonly sql: StorageLike['sql'];

  constructor(kind: 'records' | 'witness') {
    this.kind = kind;
    this.table = kind === 'records' ? 'records' : 'entries';
    this.sql = {
      exec: (query: string, ...bindings: unknown[]): SqlCursor => {
        const args = bindings.map(b => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as never[];
        const stmt = this.db.prepare(query);
        if (stmt.columns().length === 0) { stmt.run(...args); return { toArray: () => [] }; }
        const rows = stmt.all(...args).map(row => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
          return out;
        });
        return { toArray: () => rows };
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.db.exec('BEGIN');
    try { const out = closure(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  private ensure(): void { (this.kind === 'records' ? ensureRecordSchema : ensureWitnessSchema)(this); }

  /** Whole-database copy, as a point-in-time restore would produce. */
  snapshot(): Snapshot {
    const out: Snapshot = {};
    for (const t of ['meta', this.table, ...(this.kind === 'records' ? ['budgets'] : [])]) out[t] = this.db.prepare(`SELECT * FROM ${t}`).all().map(r => ({ ...r }));
    return out;
  }

  /** Replace the live database with an earlier snapshot (rollback). */
  restore(snap: Snapshot): void {
    this.db = new DatabaseSync(':memory:');
    this.ensure();
    for (const [t, rows] of Object.entries(snap)) {
      for (const row of rows) {
        const cols = Object.keys(row);
        this.db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
      }
    }
  }

  /** Corrupt storage behind the ledger's back (dropping the immutability triggers first). */
  tamper(query: string, ...bindings: unknown[]): void {
    this.db.exec(`DROP TRIGGER IF EXISTS ${this.table}_no_update; DROP TRIGGER IF EXISTS ${this.table}_no_delete`);
    this.db.prepare(query).run(...(bindings as never[]));
    this.ensure();
  }

  rawCount(table: string): number { return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n); }
}

export const IDENTITY: ProviderStoreIdentity = {
  deployment: 'sim-a',
  provider: '0x00000000000000000000000000000000000000a1',
  chainId: '5042002',
  contract: '0x00000000000000000000000000000000000000c1',
  endpointHash: `0x${'11'.repeat(32)}`,
};

export interface Hooks {
  beforePublish?: (e: WitnessEntry) => Promise<void> | void;
  afterPublish?: (e: WitnessEntry) => Promise<void> | void;
  beforeList?: () => Promise<void> | void;
  afterList?: () => Promise<void> | void;
  beforeGet?: () => Promise<void> | void;
  /** Called at the start of every bootstrap port call (witness.isEmpty, records.beginBootstrap, ...). */
  atPort?: (label: string) => Promise<void> | void;
}

const tick = () => Promise.resolve();

export class World {
  readonly identity: ProviderStoreIdentity;
  readonly recordsStorage = new SimStorage('records');
  readonly witnessStorage = new SimStorage('witness');
  readonly witness = new WitnessLedger(this.witnessStorage);
  hooks: Hooks = {};
  records: RecordLedger;

  readonly peer: WitnessPeer = {
    publish: async (id, e) => { await tick(); await this.hooks.beforePublish?.(e); const out = this.witness.publish(id, e); await this.hooks.afterPublish?.(e); return out; },
    get: async (id, name) => { await tick(); await this.hooks.beforeGet?.(); return this.witness.get(id, name); },
    list: async (id, after, limit) => { await tick(); await this.hooks.beforeList?.(); const out = this.witness.list(id, after, limit); await this.hooks.afterList?.(); return out; },
    status: async id => { await tick(); return this.witness.status(id); },
  };

  readonly capacity: Capacity | undefined;

  constructor(identity: ProviderStoreIdentity = IDENTITY, capacity?: Capacity) {
    this.identity = identity;
    this.capacity = capacity;
    this.witness.init();
    this.records = this.freshRecords();
  }

  private freshRecords(): RecordLedger {
    const r = new RecordLedger(this.recordsStorage, () => this.peer, this.capacity);
    r.init();
    return r;
  }

  /** New ledger over the SAME database: models eviction/restart, losing all in-memory in-flight state. */
  restartRecords(): void { this.records = this.freshRecords(); }

  async approvalFor(records: Array<{ name: string; bytes: Uint8Array }>): Promise<string> {
    const entries: InventoryEntry[] = [];
    for (const r of records) entries.push({ name: r.name, sha256: await sha256Hex(r.bytes) });
    return inventoryFingerprint(this.identity, entries);
  }

  async bootstrap(records: Array<{ name: string; bytes: Uint8Array }> = [], approved?: string, identityArg: ProviderStoreIdentity = this.identity, options?: { perDigest?: { records: number; bytes: number } }) {
    const fingerprint = approved ?? await this.approvalFor(records);
    const at = async (label: string) => { await tick(); await this.hooks.atPort?.(label); };
    return bootstrapStore({
      records: {
        isEmpty: async () => { await at('records.isEmpty'); return this.records.isEmpty(); },
        beginBootstrap: async (i, n, r, a, o) => { await at('records.begin'); return this.records.beginBootstrap(i, n, r, a, o); },
        commitBootstrap: async (i, n) => { await at('records.commit'); this.records.commitBootstrap(i, n); },
        assertConsistent: async (i, o) => { await at('records.check'); return this.records.assertConsistent(i, o); },
      },
      witness: {
        isEmpty: async () => { await at('witness.isEmpty'); return this.witness.isEmpty(); },
        beginBootstrap: async (i, n, inv, a) => { await at('witness.begin'); return this.witness.beginBootstrap(i, n, inv, a); },
        commitBootstrap: async (i, n) => { await at('witness.commit'); this.witness.commitBootstrap(i, n); },
      },
    }, identityArg, records, fingerprint, options);
  }

  static async ready(records: Array<{ name: string; bytes: Uint8Array }> = [], capacity?: Capacity): Promise<World> {
    const w = new World(IDENTITY, capacity);
    await w.bootstrap(records);
    return w;
  }
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const hex64 = (n: number): string => n.toString(16).padStart(64, '0');
export const resultName = (n: number): string => `0x${hex64(n)}.result.json`;
export const requestName = (n: number): string => `request-0x${hex64(n)}.json`;

/** A promise whose resolution the test controls. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
