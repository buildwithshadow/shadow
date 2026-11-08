// The smallest slice of Durable Object SQLite storage the ledgers use. The
// real `ctx.storage` satisfies it; test/sim/harness.ts provides a node:sqlite
// stand-in. Everything here is synchronous: a synchronous section cannot
// interleave with another request, which is what makes claims atomic.

export interface SqlCursor {
  toArray(): Array<Record<string, unknown>>;
}

export interface StorageLike {
  readonly sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
  transactionSync<T>(closure: () => T): T;
}

const IMMUTABLE_TRIGGERS = (table: string, immutableCols: string): string[] => [
  // A committed row never changes. A pending row may only be committed with identical content.
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
     WHEN OLD.state = 'committed' OR ${immutableCols}
     BEGIN SELECT RAISE(ABORT, 'immutable record'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
     BEGIN SELECT RAISE(ABORT, 'immutable record'); END`,
];

/** Schema only. It never writes an identity: a missing identity stays missing. */
export function ensureRecordSchema(storage: StorageLike): void {
  const statements = [
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID',
    `CREATE TABLE IF NOT EXISTS records (
       name TEXT PRIMARY KEY,
       state TEXT NOT NULL CHECK (state IN ('pending', 'committed')),
       sha256 TEXT NOT NULL,
       size INTEGER NOT NULL,
       bytes BLOB NOT NULL,
       claim_id TEXT NOT NULL
     ) WITHOUT ROWID`,
    // Capacity reserved for accepted work, per digest. Mutable on purpose (it is accounting, not evidence),
    // and updated in the same transactions as the records it accounts for.
    `CREATE TABLE IF NOT EXISTS budgets (
       digest TEXT PRIMARY KEY,
       records INTEGER NOT NULL CHECK (records >= 1),
       bytes INTEGER NOT NULL CHECK (bytes >= 0),
       used_records INTEGER NOT NULL DEFAULT 0,
       used_bytes INTEGER NOT NULL DEFAULT 0
     ) WITHOUT ROWID`,
    ...IMMUTABLE_TRIGGERS('records', 'NEW.name <> OLD.name OR NEW.sha256 <> OLD.sha256 OR NEW.size <> OLD.size OR NEW.bytes <> OLD.bytes OR NEW.claim_id <> OLD.claim_id'),
  ];
  for (const statement of statements) storage.sql.exec(statement);
}

export function ensureWitnessSchema(storage: StorageLike): void {
  const statements = [
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID',
    `CREATE TABLE IF NOT EXISTS entries (
       name TEXT PRIMARY KEY,
       state TEXT NOT NULL DEFAULT 'committed' CHECK (state = 'committed'),
       sha256 TEXT NOT NULL,
       claim_id TEXT NOT NULL
     ) WITHOUT ROWID`,
    ...IMMUTABLE_TRIGGERS('entries', '1 = 1'),
  ];
  for (const statement of statements) storage.sql.exec(statement);
}

export function metaGet(storage: StorageLike, key: string): string | null {
  const rows = storage.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray();
  return rows.length ? String(rows[0].value) : null;
}

export function metaSet(storage: StorageLike, key: string, value: string): void {
  storage.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
