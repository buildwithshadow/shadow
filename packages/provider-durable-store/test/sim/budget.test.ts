import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDENTITY, World, hex64, requestName, utf8 } from './harness.ts';
import { assertFull } from './helpers.ts';

// Store-level hard capacity with per-digest reservations (RecordLedger only).
// Capacity numbers here are small TEST values chosen to reach the edge quickly.
// They are not production quotas and say nothing about real Cloudflare limits.

const PER_DIGEST = { records: 8, bytes: 800 };
const CAPACITY = { maxRecords: 40, maxTotalBytes: 4000 }; // exactly five admitted digests
const digest = (n: number) => `0x${hex64(n)}`;
const name = (n: number, slot: string) => `${digest(n)}.${slot}.json`;
const rec = (size = 100) => utf8(`{"p":"${'a'.repeat(size - 9)}"}\n`);

async function accept(w: World, n: number, upTo: 'acceptance' | 'none' = 'acceptance'): Promise<void> {
  w.records.reserveBudget(w.identity, digest(n), PER_DIGEST.records, PER_DIGEST.bytes);
  if (upTo === 'none') return;
  await w.records.putOnce(w.identity, requestName(n), rec(), { budgetDigest: digest(n) });
  for (const slot of ['admission', 'prepared', 'acceptance']) await w.records.putOnce(w.identity, name(n, slot), rec());
}

const free = (w: World) => w.records.budgetUsage(w.identity).free;

test('new acceptances cannot exhaust the capacity accepted work still needs', async () => {
  const w = await World.ready([], CAPACITY);
  for (const n of [1, 2, 3]) await accept(w, n);
  w.records.reserveBudget(w.identity, digest(4), PER_DIGEST.records, PER_DIGEST.bytes);
  w.records.reserveBudget(w.identity, digest(5), PER_DIGEST.records, PER_DIGEST.bytes);

  // An attacker floods with more acceptances: every one is refused, none shrinks anyone's reservation.
  for (let n = 100; n < 160; n++) {
    assert.throws(() => w.records.reserveBudget(w.identity, digest(n), PER_DIGEST.records, PER_DIGEST.bytes), /Not enough unreserved capacity/);
  }
  // Unreserved writes (a digest nobody admitted, a request binding without a budget) cannot spend reserved room either.
  await assertFull(w.records.putOnce(w.identity, name(999, 'admission'), rec()), /reserved for accepted work/);
  await assertFull(w.records.putOnce(w.identity, requestName(999), rec()), /reserved for accepted work/);
  assert.deepEqual(free(w), { records: 0, bytes: 0 });

  // Accepted work finishes every remaining record while the store is at capacity.
  for (const n of [1, 2, 3]) {
    for (const slot of ['started', 'result', 'payment', 'delivery']) {
      const out = await w.records.putOnce(w.identity, name(n, slot), rec());
      assert.equal(out.created, true, `${n} ${slot}`);
      const u = w.records.budgetUsage(w.identity);
      assert.ok(u.records + u.reserved.records <= u.capacity.maxRecords, 'rows + reservations never exceed capacity');
      assert.ok(u.bytes + u.reserved.bytes <= u.capacity.maxTotalBytes);
    }
  }
  await w.records.assertConsistent(w.identity, { deep: true });
});

test('a digest cannot spend past its reservation into another digest’s room', async () => {
  const w = await World.ready([], { maxRecords: 16, maxTotalBytes: 2000 });
  await accept(w, 1); // 4 records used, 4 left reserved
  w.records.reserveBudget(w.identity, digest(2), PER_DIGEST.records, PER_DIGEST.bytes); // exactly fills the rest
  assert.equal(free(w).records, 0);
  for (const slot of ['started', 'result', 'payment', 'delivery']) await w.records.putOnce(w.identity, name(1, slot), rec());
  await assertFull(w.records.putOnce(w.identity, name(1, 'released'), rec()), /reserved for accepted work/); // 9th record for digest 1
  // Digest 2's reservation is untouched and still usable in full after digest 1 ended.
  for (const slot of ['admission', 'prepared', 'acceptance', 'started', 'result', 'payment', 'delivery']) {
    await w.records.putOnce(w.identity, name(2, slot), rec(), { budgetDigest: digest(2) });
  }
  await w.records.putOnce(w.identity, requestName(2), rec(), { budgetDigest: digest(2) });
});

test('bytes are reserved too: a large new request cannot take the bytes paid work needs', async () => {
  const w = await World.ready([], { maxRecords: 100, maxTotalBytes: 2000 });
  w.records.reserveBudget(w.identity, digest(1), 8, 1500);
  w.records.reserveBudget(w.identity, digest(2), 8, 500);
  assert.throws(() => w.records.reserveBudget(w.identity, digest(3), 8, 1), /Not enough unreserved capacity/);
  await w.records.putOnce(w.identity, name(1, 'admission'), rec(500));
  await w.records.putOnce(w.identity, name(1, 'result'), rec(1000)); // exactly the reserved remainder
  // Beyond its own reservation, with no unreserved bytes left, the write fails closed rather than taking digest 2's bytes.
  await assertFull(w.records.putOnce(w.identity, name(1, 'delivery'), rec(100)), /Byte capacity/);
  await assertFull(w.records.putOnce(w.identity, name(77, 'admission'), rec(100)), /Byte capacity/);
  await w.records.putOnce(w.identity, name(2, 'admission'), rec(500)); // digest 2's reservation is intact
});

test('reservations survive restart and terminal records return the unused part', async () => {
  const w = await World.ready([], CAPACITY);
  for (const n of [1, 2, 3, 4, 5]) await accept(w, n);
  w.restartRecords();
  assert.throws(() => w.records.reserveBudget(w.identity, digest(6), PER_DIGEST.records, PER_DIGEST.bytes), /Not enough unreserved capacity/);
  assert.equal(w.records.budgetUsage(w.identity).budgets, 5);

  // Digest 1 is released (e.g. expired unpaid) without ever using started/result/payment.
  await w.records.putOnce(w.identity, name(1, 'released'), rec());
  assert.equal(w.records.budgetUsage(w.identity).budgets, 4);
  assert.equal(free(w).records, 3, 'the four unused slots, less the one the release itself used, came back... (8 reserved - 4 used - 1 terminal)');
  assert.throws(() => w.records.reserveBudget(w.identity, digest(6), PER_DIGEST.records, PER_DIGEST.bytes), /Not enough/); // 3 < 8: still not enough
  for (const n of [2, 3]) await w.records.putOnce(w.identity, name(n, 'released'), rec());
  w.records.reserveBudget(w.identity, digest(6), PER_DIGEST.records, PER_DIGEST.bytes); // now it fits
});

test('releaseBudget only gives back a reservation nothing was committed against', async () => {
  const w = await World.ready([], CAPACITY);
  await accept(w, 1, 'none');
  assert.deepEqual(w.records.releaseBudget(w.identity, digest(1)), { released: true });
  assert.equal(w.records.budgetUsage(w.identity).budgets, 0);
  await accept(w, 2);
  assert.deepEqual(w.records.releaseBudget(w.identity, digest(2)), { released: false });
  assert.equal(w.records.reserveBudget(w.identity, digest(2), PER_DIGEST.records, PER_DIGEST.bytes).reserved, false, 'idempotent per digest');
});

test('racing unreserved writes for the last free records never exceed capacity', async () => {
  const w = await World.ready([], { maxRecords: 10, maxTotalBytes: 100_000 });
  w.records.reserveBudget(w.identity, digest(1), 7, 700);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => w.records.putOnce(w.identity, name(100 + i, 'admission'), rec())));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(results.filter(r => r.status === 'rejected').length, 9);
  const u = w.records.budgetUsage(w.identity);
  assert.equal(u.records, 3);
  assert.equal(u.free.records, 0);
  for (let i = 0; i < 7; i++) await w.records.putOnce(w.identity, `${digest(1)}.${['admission', 'prepared', 'acceptance', 'started', 'result', 'payment', 'delivery'][i]}.json`, rec());
});

test('importing outstanding work restores its reservation, and an import that cannot fit is refused', async () => {
  const outstanding = [
    { name: name(1, 'admission'), bytes: rec() }, { name: name(1, 'prepared'), bytes: rec() }, { name: name(1, 'acceptance'), bytes: rec() },
  ];
  const finished = [{ name: name(2, 'acceptance'), bytes: rec() }, { name: name(2, 'delivery'), bytes: rec() }];
  const records = [...outstanding, ...finished];

  const w = new World(IDENTITY, { maxRecords: 14, maxTotalBytes: 100_000 });
  await w.bootstrap(records, undefined, w.identity, { perDigest: PER_DIGEST });
  const u = w.records.budgetUsage(w.identity);
  assert.equal(u.budgets, 1, 'only the unfinished digest keeps a reservation');
  assert.deepEqual(u.reserved, { records: 5, bytes: 500 }, '8 reserved minus the 3 imported records');
  assert.equal(u.free.records, 14 - 5 - 5, 'rows 5 + reserved 5');
  assert.throws(() => w.records.reserveBudget(w.identity, digest(3), 8, 100), /Not enough unreserved/);
  for (const slot of ['started', 'result', 'payment', 'delivery']) await w.records.putOnce(w.identity, name(1, slot), rec()); // paid delivery fits
  await w.records.putOnce(w.identity, requestName(1), rec(), { budgetDigest: digest(1) });

  const tight = new World(IDENTITY, { maxRecords: 9, maxTotalBytes: 100_000 });
  await assert.rejects(tight.bootstrap(records, undefined, tight.identity, { perDigest: PER_DIGEST }), /does not fit the store capacity/);
  assert.equal(tight.recordsStorage.rawCount('records'), 0, 'nothing written');
  assert.equal(u.capacity.maxRecords, 14);
});

for(const terminal of ['delivery','released'])test(`late ${terminal} retries cannot recreate a retired budget`,async()=>{
 const w=await World.ready([],CAPACITY);await accept(w,1);await w.records.putOnce(w.identity,name(1,terminal),rec());
 const before=w.records.budgetUsage(w.identity);assert.equal(before.budgets,0);
 assert.deepEqual(w.records.reserveBudget(w.identity,digest(1),PER_DIGEST.records,PER_DIGEST.bytes),{reserved:false});
 assert.deepEqual(w.records.budgetUsage(w.identity),before);
 w.restartRecords();assert.deepEqual(w.records.reserveBudget(w.identity,digest(1),PER_DIGEST.records,PER_DIGEST.bytes),{reserved:false});
 assert.deepEqual(w.records.budgetUsage(w.identity),before);
});

test('a failed claim insert does not consume reserved capacity',async()=>{
 const w=await World.ready([],{maxRecords:8,maxTotalBytes:800});
 w.records.reserveBudget(w.identity,digest(1),8,800);
 const before=w.records.budgetUsage(w.identity),file=name(1,'result');
 w.recordsStorage.tamper(`CREATE TRIGGER fail_claim BEFORE INSERT ON records WHEN NEW.name = '${file}' BEGIN SELECT RAISE(ABORT,'injected claim failure'); END`);
 await assert.rejects(w.records.putOnce(w.identity,file,rec()),/injected claim failure/);
 assert.deepEqual(w.records.budgetUsage(w.identity),before);
 await w.records.assertConsistent(w.identity);
});
