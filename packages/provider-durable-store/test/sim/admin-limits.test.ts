import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS } from '../../src/limits.ts';
import { inventoryFingerprint, storeObjectName } from '../../src/identity.ts';
import { sha256Hex } from '../../src/bytes.ts';
import { IDENTITY, World, requestName, resultName, utf8 } from './harness.ts';
import { assertFull, assertHold, assertInvalid } from './helpers.ts';

const A = utf8('{"record":"A"}\n'), B = utf8('{"record":"B"}\n');

test('import needs an operator-approved fingerprint and verifies it on both sides', async () => {
  const records = [{ name: resultName(1), bytes: A }, { name: requestName(2), bytes: B }];
  const entries = [{ name: resultName(1), sha256: await sha256Hex(A) }, { name: requestName(2), sha256: await sha256Hex(B) }];
  const approved = await inventoryFingerprint(IDENTITY, entries); // computed independently by the operator

  for (const bad of ['', 'not-hex', '0'.repeat(64), await inventoryFingerprint(IDENTITY, entries.slice(0, 1))]) {
    const w = new World();
    await assertHold(w.bootstrap(records, bad), /approved fingerprint/);
    assert.equal(w.recordsStorage.rawCount('meta') + w.witnessStorage.rawCount('meta'), 0, 'nothing is written without approval');
  }

  const swapped = [{ name: resultName(1), bytes: B }, records[1]]; // approved inventory, different bytes
  const w0 = new World();
  await assertHold(w0.bootstrap(swapped, approved), /approved fingerprint/);

  const w = new World();
  assert.deepEqual(await w.bootstrap(records, approved), { records: 2 });
  assert.deepEqual(await w.records.read(IDENTITY, resultName(1)), A);
  assert.deepEqual(await w.records.read(IDENTITY, requestName(2)), B);
  await w.records.assertConsistent(IDENTITY, { deep: true });

  await assertHold(w.bootstrap(records, approved), /completely empty/); // no second init, no reset
  await assertHold(w.bootstrap([], await w.approvalFor([])), /completely empty/);
});

test('an interrupted bootstrap stays visibly incomplete and refuses retry', async () => {
  const w = new World();
  const approved = await w.approvalFor([]);
  w.witness.beginBootstrap(IDENTITY, crypto.randomUUID(), [], approved); // witness began, records never did
  await assertHold(w.records.putOnce(IDENTITY, resultName(1), A));
  await assertHold(w.bootstrap([], approved), /completely empty/);
  await assertHold(w.records.assertConsistent(IDENTITY));
  assert.equal(w.witness.status(IDENTITY).state, 'initializing');
});

test('inputs are bounded and validated', async () => {
  const w = await World.ready();
  await assertInvalid(w.records.putOnce(IDENTITY, resultName(1), new Uint8Array(0)));
  await assertInvalid(w.records.putOnce(IDENTITY, resultName(1), new Uint8Array(LIMITS.maxRecordBytes + 1).fill(0x61)), /exceeds/);
  await assertInvalid(w.records.putOnce(IDENTITY, resultName(1), new Uint8Array([0x7b, 0xff, 0x7d])), /UTF-8/);
  for (const bad of ['identity.json', '../x.json', resultName(1).toUpperCase(), 'request-0x12.json', `${resultName(1)}.tmp`, `${resultName(1)}\n`]) {
    await assertInvalid(w.records.putOnce(IDENTITY, bad, A), /Invalid provider record name/);
    await assertInvalid(w.records.read(IDENTITY, bad), /Invalid provider record name/);
  }
  assert.equal(w.recordsStorage.rawCount('records'), 0);
  const max = new Uint8Array(LIMITS.maxRecordBytes).fill(0x61);
  assert.equal((await w.records.putOnce(IDENTITY, resultName(1), max)).created, true);
});

test('list is paged, ordered and clamped', async () => {
  const w = await World.ready();
  for (let i = 1; i <= 7; i++) await w.records.putOnce(IDENTITY, resultName(i), utf8(`{"i":${i}}\n`));
  const seen: string[] = [];
  let after: string | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const page: { names: string[]; next: string | null } = w.records.list(IDENTITY, after, 3);
    assert.ok(page.names.length <= 3);
    seen.push(...page.names);
    if (!page.next) break;
    after = page.next;
  }
  assert.deepEqual(seen, Array.from({ length: 7 }, (_, i) => resultName(i + 1)));
  assert.ok(w.records.list(IDENTITY, null, 1_000_000).names.length <= LIMITS.maxListLimit);
  assert.equal(w.records.list(IDENTITY, null, -5).names.length, 1);
});

test('record count and total byte limits are enforced', async () => {
  const many = Array.from({ length: LIMITS.maxRecords }, (_, i) => ({ name: resultName(i + 1), bytes: utf8(`{"i":${i}}\n`) }));
  const w = await World.ready(many);
  await assertFull(w.records.putOnce(IDENTITY, resultName(LIMITS.maxRecords + 1), A), /Record capacity/);

  const big = Array.from({ length: LIMITS.maxTotalBytes / LIMITS.maxRecordBytes }, (_, i) => ({ name: resultName(i + 1), bytes: new Uint8Array(LIMITS.maxRecordBytes).fill(0x62) }));
  const w2 = await World.ready(big);
  await assertFull(w2.records.putOnce(IDENTITY, resultName(5000), A), /Byte capacity/);
});

test('deployments are namespaced: separate labels never share objects or state', async () => {
  const other = { ...IDENTITY, deployment: 'sim-b' };
  assert.notEqual(await storeObjectName(IDENTITY), await storeObjectName(other));
  assert.match(await storeObjectName(other), /^provider-store\/v1\/sim-b\/[0-9a-f]{64}$/);
  const a = await World.ready();
  const b = new World(other);
  await b.bootstrap();
  await a.records.putOnce(IDENTITY, resultName(1), A);
  assert.equal(await b.records.read(other, resultName(1)), null);
  assert.equal(b.witnessStorage.rawCount('entries'), 0);
});
