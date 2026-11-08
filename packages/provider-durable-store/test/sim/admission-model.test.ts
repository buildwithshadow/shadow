import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdmissionBusy, AdmissionConflict, AdmissionRefused, ProviderCoordinatorModel,
  type AdmissionPolicy, type CoordinatorStore, type CountStrategy, type Externals,
} from '../model/admission-model.ts';
import { World, gate, hex64, requestName, utf8 } from './harness.ts';
import { flush, until } from './helpers.ts';

// MODEL TESTS. They exercise src/admission-model.ts (an executable model of the
// ordering in server.mjs, as read) on top of the REAL RecordLedger and witness
// from the simulation harness. They are not the provider server and not workerd.
// The real Durable Object behavior of the same model is in test/workers.

const digest = (n: number) => `0x${hex64(n)}`;
const fileOf = (n: number, slot: string) => `${digest(n)}.${slot}.json`;
const POLICY: AdmissionPolicy = { maxOutstanding: 3, maxPerAgent: 2, maxPerLine: 2, budget: { records: 8, bytes: 800 }, pageSize: 2 };

interface StoreHooks {
  afterPage?: (page: { names: string[]; next: string | null }) => Promise<void> | void;
  beforePut?: (name: string) => Promise<void> | void;
  puts: string[];
}

function storeFor(w: World, hooks: StoreHooks = { puts: [] }): CoordinatorStore & { hooks: StoreHooks } {
  return {
    hooks,
    list: async (after, limit) => {
      const page = w.records.list(w.identity, after, limit);
      await flush(); // the awaits that let other requests run between pages
      await hooks.afterPage?.(page);
      return page;
    },
    read: name => w.records.read(w.identity, name),
    putOnce: async (name, bytes, options) => {
      await hooks.beforePut?.(name);
      const out = await w.records.putOnce(w.identity, name, bytes, options);
      hooks.puts.push(name);
      return out;
    },
    assertConsistent: () => w.records.assertConsistent(w.identity, { deep: true }),
    reserveBudget: (d, r, b) => Promise.resolve().then(() => w.records.reserveBudget(w.identity, d, r, b)),
    releaseBudget: d => Promise.resolve().then(() => w.records.releaseBudget(w.identity, d)),
  };
}

function externals(overrides: Partial<Externals> = {}): Externals & { signs: string[] } {
  const signs: string[] = [];
  return {
    signs,
    guard: () => Promise.resolve(),
    prepare: () => Promise.resolve(utf8('{"prepared":"result"}\n')),
    sign: () => { signs.push('sign'); return Promise.resolve(utf8('{"acceptance":true}\n')); },
    ...overrides,
  };
}

const req = (n: number, agent = `agent-${n}`, lineId = `line-${n}`) => ({ digest: digest(n), agent, lineId, requestName: requestName(n) });
type Outcome = 'signed' | 'refused' | 'busy' | 'conflict';
const outcome = (p: Promise<{ signed: boolean }>): Promise<Outcome> => p.then(
  r => (r.signed ? 'signed' : 'conflict'),
  (e: unknown) => (e instanceof AdmissionRefused ? 'refused' : e instanceof AdmissionBusy ? 'busy' : e instanceof AdmissionConflict ? 'conflict' : Promise.reject(e as Error)),
);
const tally = (xs: Outcome[]) => xs.reduce<Record<string, number>>((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {});

// ---- 1. the real order of operations and the single state machine -------------------

test('state machine: records are written BEFORE the signer runs, signing is a phase on top of recorded', async () => {
  const w = await World.ready();
  const store = storeFor(w);
  const model = new ProviderCoordinatorModel(store, POLICY, { strategy: 'index' });
  const phases: string[] = [];
  const ext = externals({
    step: label => { phases.push(`${label}:${model.phaseOf(digest(1))}`); return Promise.resolve(); },
    sign: () => { phases.push(`sign:${model.phaseOf(digest(1))}:records=${store.hooks.puts.join('|')}`); return Promise.resolve(utf8('{"acceptance":true}\n')); },
  });
  const out = await model.acceptNew(req(1), ext);
  assert.equal(out.signed, true);
  assert.deepEqual(phases.slice(0, 3), ['reserved:reserved', 'prepared:reserved', 'recorded:recorded']);
  // The signer saw the request binding, admission and prepared records already durable, in the server's order.
  assert.equal(phases[phases.length - 1], `sign:signing:records=${requestName(1)}|${fileOf(1, 'admission')}|${fileOf(1, 'prepared')}`);
  assert.deepEqual(store.hooks.puts.slice(-1), [fileOf(1, 'acceptance')]);
  assert.equal(model.phaseOf(digest(1)), null, 'the in-memory entry is gone; the records alone carry the slot');
});

test('an interrupted retry reuses its slot and its budget, and signs again only after re-recording', async () => {
  const w = await World.ready();
  const model1 = new ProviderCoordinatorModel(storeFor(w), POLICY, { strategy: 'index' });
  const crash = externals({ sign: () => Promise.reject(new Error('process died while signing')) });
  await assert.rejects(model1.acceptNew(req(1), crash), /died while signing/);
  assert.equal(w.records.budgetUsage(w.identity).budgets, 1, 'admission is durable, so the reservation stays');

  const model2 = new ProviderCoordinatorModel(storeFor(w), POLICY, { strategy: 'index' }); // a new actor instance after eviction
  const ext = externals();
  const out = await model2.acceptNew(req(1), ext);
  assert.equal(out.signed, true);
  assert.equal(ext.signs.length, 1);
  assert.equal(w.records.budgetUsage(w.identity).budgets, 1, 'no second budget for the same digest');
});

// ---- 2. counting across paginated, interleaved reads ---------------------------------

async function race(strategy: CountStrategy, n: number, cap: number, agentFor: (i: number) => string = i => `agent-${i}`) {
  const w = await World.ready();
  const model = new ProviderCoordinatorModel(storeFor(w), { ...POLICY, maxOutstanding: cap, maxPerAgent: 99, maxPerLine: 99 }, { strategy });
  const ext = externals();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => outcome(model.acceptNew(req(i + 1, agentFor(i)), ext))));
  return { results: tally(results), signs: ext.signs.length };
}

test('generation-validated scan never overbooks, but may answer busy under churn', async () => {
  const { results, signs } = await race('generation-scan', 8, 3);
  assert.ok(signs <= 3, `signed ${signs}`);
  assert.equal((results.signed ?? 0) + (results.refused ?? 0) + (results.busy ?? 0), 8);
  assert.ok((results.busy ?? 0) > 0 || signs === 3, 'either some requests were told to retry, or the cap was reached exactly');
});

test('index with an atomic final reservation admits exactly the cap and never answers busy', async () => {
  const { results, signs } = await race('index', 8, 3);
  assert.equal(signs, 3);
  assert.deepEqual(results, { signed: 3, refused: 5 });
});

test('per-agent and per-line caps hold under the same interleaving (index)', async () => {
  const w = await World.ready();
  const model = new ProviderCoordinatorModel(storeFor(w), { ...POLICY, maxOutstanding: 50, maxPerAgent: 2, maxPerLine: 50 }, { strategy: 'index' });
  const ext = externals();
  const r = await Promise.all(Array.from({ length: 6 }, (_, i) => outcome(model.acceptNew(req(i + 1, 'same-agent', `line-${i}`), ext))));
  assert.deepEqual(tally(r), { signed: 2, refused: 4 });
  const lines = new ProviderCoordinatorModel(storeFor(await World.ready()), { ...POLICY, maxOutstanding: 50, maxPerAgent: 50, maxPerLine: 2 }, { strategy: 'index' });
  const r2 = await Promise.all(Array.from({ length: 6 }, (_, i) => outcome(lines.acceptNew(req(i + 1, `a-${i}`, 'same-line'), externals()))));
  assert.deepEqual(tally(r2), { signed: 2, refused: 4 });
});

/**
 * The interleaving that defeats "scan pages + in-memory reservations": request A's scan has read
 * the first page. Request X, whose records sort before A's cursor, reserves, publishes, signs and
 * RELEASES its memory entry. A's remaining pages cannot show X's records (behind the cursor) and
 * the memory no longer holds X, so A sees nothing and the cap of one is exceeded.
 */
async function behindTheCursor(strategy: CountStrategy) {
  const w = await World.ready();
  // Two finished digests fill page one so that X (digest 1) sorts before the cursor.
  for (const n of [10, 11]) {
    await w.records.putOnce(w.identity, fileOf(n, 'admission'), utf8('{"x":1}\n'));
    await w.records.putOnce(w.identity, fileOf(n, 'released'), utf8('{"x":1}\n'));
  }
  const hooks: StoreHooks = { puts: [] };
  const paused = gate();
  let armed = true, atPause = false;
  hooks.afterPage = async page => { if (armed && page.next !== null) { armed = false; atPause = true; await paused.promise; } };
  const model = new ProviderCoordinatorModel(storeFor(w, hooks), { ...POLICY, maxOutstanding: 1 }, { strategy, maxScanRetries: 5 });
  const extA = externals(), extX = externals();
  const a = outcome(model.acceptNew(req(99), extA));
  await until(() => atPause, 'A paused after its first page');
  const x = outcome(model.acceptNew(req(1), extX));
  await flush(); await flush();
  if (strategy !== 'index') await x; // X cannot finish before A is released only under the index strategy (it waits for the shared index)
  paused.open();
  const [ra, rx] = await Promise.all([a, x]);
  return { signs: extA.signs.length + extX.signs.length, ra, rx };
}

test('REPRODUCTION: a record published behind the cursor is invisible to scan-then-reserve', async () => {
  const r = await behindTheCursor('naive-scan');
  assert.equal(r.signs, 2, 'both A and X were admitted against a cap of one');
});
test('generation validation sees the same interleaving and rescans', async () => {
  const r = await behindTheCursor('generation-scan');
  assert.equal(r.signs, 1);
});
test('the index merges the local publication and admits one', async () => {
  const r = await behindTheCursor('index');
  assert.equal(r.signs, 1);
});

test('index: a publication that lands while the index is still being built is not lost', async () => {
  const w = await World.ready();
  for (const n of [10, 11, 12]) await w.records.putOnce(w.identity, fileOf(n, 'admission'), utf8('{"x":1}\n'));
  const hooks: StoreHooks = { puts: [] };
  const paused = gate();
  let armed = true, atPause = false;
  hooks.afterPage = async page => { if (armed && page.next !== null) { armed = false; atPause = true; await paused.promise; } };
  const model = new ProviderCoordinatorModel(storeFor(w, hooks), { ...POLICY, maxOutstanding: 4 }, { strategy: 'index' });
  const a = outcome(model.acceptNew(req(99), externals()));
  await until(() => atPause, 'index build paused after page one');
  // Local publications behind the cursor while the build is paused: one outstanding, one ended.
  await model.record(fileOf(1, 'admission'), utf8('{"digest":1}\n')); // outstanding, behind the cursor
  await model.record(fileOf(10, 'released'), utf8('{"x":1}\n')); // ends a digest the scan already saw as outstanding
  paused.open();
  assert.equal(await a, 'signed');
  // 11, 12 and 1 are outstanding, 10 ended, 99 was admitted: the cap of four is reached.
  const ext = externals();
  const blocked = await Promise.all([2, 3].map(n => outcome(model.acceptNew(req(n), ext))));
  assert.deepEqual(tally(blocked), { refused: 2 }, 'outstanding = {11, 12, 1, 99}');
});

// ---- 3. reclaim versus a retry, and invalidation before signing ----------------------

async function reclaimVersusRetry(legacy: boolean) {
  const w = await World.ready();
  const hooks: StoreHooks = { puts: [] };
  const model = new ProviderCoordinatorModel(storeFor(w, hooks), POLICY, { strategy: 'index', legacyRetries: legacy });
  const dead = externals({ sign: () => Promise.reject(new Error('died')) });
  await assert.rejects(model.acceptNew(req(1), dead), /died/); // digest 1 is now outstanding: admission + prepared, no acceptance
  const traceBase = model.trace.length;
  const evidence = gate();
  const finalGuard = gate();
  let guardReached = false;

  const reclaiming = model.reclaim(async () => { await evidence.promise; return 'expired-unpaid'; });
  await flush(); await flush();
  const ext = externals({ guard: async stage => { if (stage === 'final') { guardReached = true; await finalGuard.promise; } } });
  const retry = outcome(model.acceptNew(req(1), ext));
  await until(() => guardReached, 'retry waiting at its final guard');
  evidence.open(); // the chain read returns while the retry is between its last check and the signer
  const released = await reclaiming;
  finalGuard.open();
  const result = await retry;
  const order = model.trace.slice(traceBase).filter(t => t.endsWith(digest(1)));
  return { released, result, signed: ext.signs.length, order, phase: model.phaseOf(digest(1)) };
}

test('REPRODUCTION (server.mjs as read): reclaim can release a digest while its retry signs afterwards', async () => {
  const r = await reclaimVersusRetry(true);
  assert.deepEqual(r.released, [digest(1)]);
  assert.equal(r.signed, 1, 'the retry still signed');
  assert.deepEqual(r.order, [`released:${digest(1)}`, `sign:${digest(1)}`], 'a signature was produced after the release landed');
});

test('fixed: the retry registers as in flight, so reclaim skips it and nothing is released under it', async () => {
  const r = await reclaimVersusRetry(false);
  assert.deepEqual(r.released, []);
  assert.equal(r.result, 'signed');
  assert.equal(r.signed, 1);
  assert.deepEqual(r.order, [`sign:${digest(1)}`]);
});

test('fixed: once reclaim has claimed the digest a retry waits or is refused, and never signs after the release', async () => {
  const w = await World.ready();
  const hooks: StoreHooks = { puts: [] };
  const model = new ProviderCoordinatorModel(storeFor(w, hooks), POLICY, { strategy: 'index' });
  await assert.rejects(model.acceptNew(req(1), externals({ sign: () => Promise.reject(new Error('died')) })), /died/);
  const landing = gate();
  let atRelease = false;
  hooks.beforePut = async name => { if (name === fileOf(1, 'released')) { atRelease = true; await landing.promise; } };
  const reclaiming = model.reclaim(() => Promise.resolve('expired-unpaid'));
  await until(() => atRelease, 'reclaim about to write the release');
  assert.equal(model.phaseOf(digest(1)), 'reclaiming');
  const ext = externals();
  assert.equal(await outcome(model.acceptNew(req(1), ext)), 'busy');
  landing.open();
  assert.deepEqual(await reclaiming, [digest(1)]);
  assert.equal(await outcome(model.acceptNew(req(1), ext)), 'conflict', 'the digest has ended');
  assert.equal(ext.signs.length, 0, 'never signed after the release');
});

test('fixed: an invalidation between the last guard and the signer stops the signature', async () => {
  const w = await World.ready();
  const model = new ProviderCoordinatorModel(storeFor(w), POLICY, { strategy: 'index' });
  await assert.rejects(model.acceptNew(req(1), externals({ sign: () => Promise.reject(new Error('died')) })), /died/);
  // The retry is held at its final step; the digest ends underneath it through a record published by another path.
  const hold = gate();
  let reached = false;
  const ext = externals({ step: async label => { if (label === 'final') { reached = true; await hold.promise; } } });
  const retry = outcome(model.acceptNew(req(1), ext));
  await until(() => reached, 'retry at final');
  await model.record(fileOf(1, 'delivery'), utf8('{"delivered":true}\n')); // e.g. a paid delivery completed meanwhile
  hold.open();
  assert.equal(await retry, 'conflict');
  assert.equal(ext.signs.length, 0, 'the signer was never called after the digest ended');
});

// ---- 4. paid recovery is not queued behind new purchases ------------------------------

test('recovery of accepted work never waits for the index or for a slow purchase', async () => {
  const w = await World.ready();
  const seed = new ProviderCoordinatorModel(storeFor(w), POLICY, { strategy: 'index' });
  await seed.acceptNew(req(1), externals());

  const hooks: StoreHooks = { puts: [] };
  const stuck = gate();
  hooks.afterPage = async () => { await stuck.promise; }; // the index build of this fresh actor never finishes on its own
  const model = new ProviderCoordinatorModel(storeFor(w, hooks), POLICY, { strategy: 'index' });
  const fresh = outcome(model.acceptNew(req(2), externals())); // a new purchase: needs the index, so it waits
  const stored = await model.acceptNew(req(1), externals()); // already accepted: returns the stored acceptance
  assert.equal(stored.signed, false);
  assert.deepEqual(await model.recover(digest(1)), utf8('{"acceptance":true}\n'));
  await model.record(fileOf(1, 'payment'), utf8('{"paid":true}\n')); // serve-path writes are not queued either
  stuck.open();
  assert.equal(await fresh, 'signed');
});

// ---- 5. record/byte budgets end to end through the model -------------------------------

test('capacity reserved for accepted work survives a flood of new acceptances', async () => {
  const w = await World.ready([], { maxRecords: 24, maxTotalBytes: 100_000 }); // room for three admitted digests
  const model = new ProviderCoordinatorModel(storeFor(w), { ...POLICY, maxOutstanding: 100, maxPerAgent: 100, maxPerLine: 100, pageSize: 5 }, { strategy: 'index' });
  const ext = externals();
  const flood = await Promise.all(Array.from({ length: 12 }, (_, i) => outcome(model.acceptNew(req(i + 1), ext))));
  assert.deepEqual(tally(flood), { signed: 3, refused: 9 });
  assert.equal(ext.signs.length, 3, 'only admitted requests ever reached the signer');
  const admitted = Array.from({ length: 12 }, (_, i) => i + 1).filter(n => hasAcceptance(w, n));
  assert.equal(admitted.length, 3);
  for (const n of admitted) {
    for (const slot of ['started', 'result', 'payment', 'delivery']) await model.record(fileOf(n, slot), utf8(`{"${slot}":${n}}\n`)); // paid delivery completes at capacity
  }
  await w.records.assertConsistent(w.identity, { deep: true });
  assert.ok(w.records.budgetUsage(w.identity).free.records >= 0);
});

function hasAcceptance(w: World, n: number): boolean {
  return Number(w.recordsStorage.sql.exec('SELECT COUNT(*) AS c FROM records WHERE name = ?', fileOf(n, 'acceptance')).toArray()[0].c) > 0;
}

test('a prepared result larger than the reserved bytes fails before anything is signed', async () => {
  const w = await World.ready([], { maxRecords: 100, maxTotalBytes: 2600 });
  const model = new ProviderCoordinatorModel(storeFor(w), { ...POLICY, budget: { records: 8, bytes: 2500 } }, { strategy: 'index' });
  const ext = externals({ prepare: () => Promise.resolve(utf8(`{"big":"${'x'.repeat(2600)}"}\n`)) });
  await assert.rejects(model.acceptNew(req(1), ext), /Byte capacity/);
  assert.equal(ext.signs.length, 0);
  // A competing new acceptance is also unable to take what the first one holds.
  const other = await outcome(model.acceptNew(req(2), externals()));
  assert.equal(other, 'refused');
});
