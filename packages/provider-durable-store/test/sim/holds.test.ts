import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileFingerprint, storeObjectName, type ProviderStoreIdentity } from '../../src/identity.ts';
import { sha256Hex } from '../../src/bytes.ts';
import { IDENTITY, World, resultName, utf8 } from './harness.ts';
import { assertHold, assertInvalid } from './helpers.ts';

const A = utf8('{"record":"A"}\n'), B = utf8('{"record":"B"}\n'), C = utf8('{"record":"C"}\n');

async function expectHeld(w: World, names: string[]): Promise<void> {
  await assertHold(w.records.assertConsistent(w.identity, { deep: true }));
  for (const n of names) {
    await assertHold(w.records.read(w.identity, n));
    await assertHold(w.records.putOnce(w.identity, n, A));
    await assertHold(w.records.putOnce(w.identity, n, B));
  }
  await assertHold(w.records.putOnce(w.identity, resultName(99), C), undefined); // unrelated names are held too
}

test('witness-only interrupted publication holds, is never healed, and survives restart', async () => {
  const w = await World.ready();
  w.hooks.afterPublish = () => { w.hooks.afterPublish = undefined; throw new Error('simulated crash after the witness became durable'); };
  await assert.rejects(w.records.putOnce(w.identity, resultName(1), A), /simulated crash/);

  assert.equal(w.witnessStorage.rawCount('entries'), 1, 'witness published first');
  assert.equal(w.recordsStorage.sql.exec("SELECT COUNT(*) AS n FROM records WHERE state = 'committed'").toArray()[0].n, 0);
  await expectHeld(w, [resultName(1)]);
  await assertHold(async () => w.records.list(w.identity, null, 10), /interrupted publication/);

  w.restartRecords(); // eviction: the in-flight map is gone, the durable claim is not
  await expectHeld(w, [resultName(1)]);
  assert.equal(w.witnessStorage.rawCount('entries'), 1, 'nothing healed the witness');
  assert.equal(w.recordsStorage.sql.exec("SELECT COUNT(*) AS n FROM records WHERE state = 'committed'").toArray()[0].n, 0);
});

test('a crash after the claim but before the witness also holds', async () => {
  const w = await World.ready();
  w.hooks.beforePublish = () => { w.hooks.beforePublish = undefined; throw new Error('witness unreachable'); };
  await assert.rejects(w.records.putOnce(w.identity, resultName(1), A), /witness unreachable/);
  assert.equal(w.witnessStorage.rawCount('entries'), 0);
  await expectHeld(w, [resultName(1)]);
});

test('explicit reconciliation needs the operator approval and the original bytes', async () => {
  const w = await World.ready();
  w.hooks.afterPublish = () => { w.hooks.afterPublish = undefined; throw new Error('crash'); };
  await assert.rejects(w.records.putOnce(w.identity, resultName(1), A), /crash/);
  const digest = await sha256Hex(A);
  const approval = await reconcileFingerprint(w.identity, resultName(1), digest);

  await assertHold(w.records.completeFromWitness(w.identity, resultName(1), A, 'f'.repeat(64)), /approved fingerprint/);
  await assertHold(w.records.completeFromWitness(w.identity, resultName(1), B, await reconcileFingerprint(w.identity, resultName(1), await sha256Hex(B))), /do not match the witness/);
  await assertHold(w.records.assertConsistent(w.identity, { deep: true }));

  assert.deepEqual(await w.records.completeFromWitness(w.identity, resultName(1), A, approval), { completed: true });
  await w.records.assertConsistent(w.identity, { deep: true });
  assert.deepEqual(await w.records.read(w.identity, resultName(1)), A);
  assert.deepEqual(await w.records.completeFromWitness(w.identity, resultName(1), A, approval), { completed: false });
});

test('restored OLD record storage: the witness is ahead, the store holds, nothing is recreated', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), A);
  const old = w.recordsStorage.snapshot();
  await w.records.putOnce(w.identity, resultName(2), B);
  w.recordsStorage.restore(old);
  w.restartRecords();

  await assertHold(w.records.assertConsistent(w.identity), /witness ahead of record/);
  await assertHold(w.records.read(w.identity, resultName(2)), /missing/);
  await assertHold(w.records.putOnce(w.identity, resultName(2), B));
  await assertHold(w.records.putOnce(w.identity, resultName(3), C));
  assert.equal(w.witnessStorage.rawCount('entries'), 2, 'witness untouched');

  // Operator completes the one missing record from the trusted original.
  const approval = await reconcileFingerprint(w.identity, resultName(2), await sha256Hex(B));
  await w.records.completeFromWitness(w.identity, resultName(2), B, approval);
  await w.records.assertConsistent(w.identity);
});

test('restored OLD witness storage: records become unwitnessed and the store holds', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), A);
  const old = w.witnessStorage.snapshot();
  await w.records.putOnce(w.identity, resultName(2), B);
  w.witnessStorage.restore(old);
  await assertHold(w.records.assertConsistent(w.identity), /unwitnessed record/);
  await assertHold(w.records.putOnce(w.identity, resultName(3), C));
  await assertHold(w.records.read(w.identity, resultName(2)), /unwitnessed/);
});

test('OUT OF SCOPE: rolling back records AND witness together is not detectable', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), A);
  const r = w.recordsStorage.snapshot(), x = w.witnessStorage.snapshot();
  await w.records.putOnce(w.identity, resultName(2), B);
  w.recordsStorage.restore(r); w.witnessStorage.restore(x);
  w.restartRecords();
  await w.records.assertConsistent(w.identity); // healthy. Same blind spot as restoring both local directories.
  assert.equal(await w.records.read(w.identity, resultName(2)), null);
});

test('altered records are detected on read, on deep check, and before any new write', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), A);
  await w.records.putOnce(w.identity, resultName(2), B);
  w.recordsStorage.tamper('UPDATE records SET bytes = ? WHERE name = ?', utf8('{"record":"X"}\n'), resultName(1));
  await assertHold(w.records.read(w.identity, resultName(1)), /altered/);
  await assertHold(w.records.assertConsistent(w.identity, { deep: true }), /altered/);
  await assertHold(w.records.putOnce(w.identity, resultName(3), C), /altered/);
  assert.deepEqual(await w.records.read(w.identity, resultName(2)), B, 'other records remain readable evidence');
});

test('altered bytes with a matching local digest still differ from the witness', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), A);
  const forged = utf8('{"record":"FORGED"}\n');
  w.recordsStorage.tamper('UPDATE records SET bytes = ?, sha256 = ?, size = ? WHERE name = ?', forged, await sha256Hex(forged), forged.byteLength, resultName(1));
  await assertHold(w.records.read(w.identity, resultName(1)), /differs from durable witness/);
  await assertHold(w.records.assertConsistent(w.identity), /differs from durable witness/);
});

test('missing records, extra unwitnessed records and altered witness digests hold', async () => {
  const missing = await World.ready();
  await missing.records.putOnce(missing.identity, resultName(1), A);
  missing.recordsStorage.tamper('DELETE FROM records WHERE name = ?', resultName(1));
  await assertHold(missing.records.assertConsistent(missing.identity), /witness ahead of record/);
  await assertHold(missing.records.read(missing.identity, resultName(1)), /missing/);

  const extra = await World.ready();
  extra.recordsStorage.tamper("INSERT INTO records (name,state,sha256,size,bytes,claim_id) VALUES (?, 'committed', ?, 1, x'41', 'planted')", resultName(5), 'cd'.repeat(32));
  await assertHold(extra.records.assertConsistent(extra.identity), /unwitnessed record/);

  const altered = await World.ready();
  await altered.records.putOnce(altered.identity, resultName(1), A);
  altered.witnessStorage.tamper('UPDATE entries SET sha256 = ? WHERE name = ?', 'ee'.repeat(32), resultName(1));
  await assertHold(altered.records.read(altered.identity, resultName(1)), /differs from durable witness/);
});

test('a changed identity never reads or writes the store', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), A);
  const variants: ProviderStoreIdentity[] = [
    { ...IDENTITY, deployment: 'sim-b' },
    { ...IDENTITY, provider: '0x00000000000000000000000000000000000000a2' },
    { ...IDENTITY, chainId: '1' },
    { ...IDENTITY, contract: '0x00000000000000000000000000000000000000c2' },
    { ...IDENTITY, endpointHash: `0x${'22'.repeat(32)}` },
  ];
  for (const other of variants) {
    await assertHold(w.records.read(other, resultName(1)), /identity does not match/);
    await assertHold(w.records.putOnce(other, resultName(2), B), /identity does not match/);
    await assertHold(w.records.assertConsistent(other), /identity does not match/);
    assert.notEqual(await storeObjectName(other), await storeObjectName(IDENTITY), 'each identity addresses its own objects');
  }
  assert.deepEqual(await w.records.read({ ...IDENTITY, provider: IDENTITY.provider.toUpperCase().replace('0X', '0x') }, resultName(1)), A, 'address case is not identity');
  await assertInvalid(w.records.read({ ...IDENTITY, chainId: '0x1' }, resultName(1)));
  await assertInvalid(w.records.read({ ...IDENTITY, deployment: '../prod' }, resultName(1)));
  await assertInvalid(w.records.read({ ...IDENTITY, endpointHash: '0x12' }, resultName(1)));
});

test('a witness bound to a different identity holds the store', async () => {
  const w = await World.ready();
  w.witnessStorage.tamper("UPDATE meta SET value = ? WHERE key = 'identity'", JSON.stringify(['provider-store-identity/v1', 'sim-a', IDENTITY.provider, '1', IDENTITY.contract, IDENTITY.endpointHash]));
  await assertHold(w.records.putOnce(w.identity, resultName(1), A), /witness identity does not match/);
});

test('a missing witness is never recreated', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), A);
  w.witnessStorage.restore({ meta: [], entries: [] }); // witness object lost or replaced by a fresh one
  await expectHeld(w, [resultName(1)]);
  assert.equal(w.witnessStorage.rawCount('meta'), 0, 'no identity was recreated');
  assert.equal(w.witnessStorage.rawCount('entries'), 0);
  await assertHold(w.bootstrap(), /completely empty/); // even an approved empty bootstrap cannot adopt a half-present store
  assert.equal(w.witnessStorage.rawCount('meta'), 0);
});

test('a missing record-store identity is never recreated', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), A);
  w.recordsStorage.restore({ meta: [], records: [] });
  w.restartRecords();
  await assertHold(w.records.assertConsistent(w.identity), /identity is missing/);
  await assertHold(w.records.putOnce(w.identity, resultName(2), B), /identity is missing/);
  await assertHold(w.bootstrap(), /completely empty/);
  assert.equal(w.recordsStorage.rawCount('meta'), 0);
});

test('an uninitialized pair does nothing until explicitly bootstrapped', async () => {
  const w = new World();
  await assertHold(w.records.putOnce(w.identity, resultName(1), A), /identity is missing/);
  await assertHold(w.records.read(w.identity, resultName(1)), /identity is missing/);
  assert.equal(w.recordsStorage.rawCount('meta'), 0);
  assert.equal(w.witnessStorage.rawCount('meta'), 0);
});
