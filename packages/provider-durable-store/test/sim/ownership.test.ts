import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRpcProviderStore, type ProviderStoreRpc } from '../../src/client.ts';
import { sha256Hex } from '../../src/bytes.ts';
import { LIMITS } from '../../src/limits.ts';
import { reconcileFingerprint, type ProviderStoreIdentity } from '../../src/identity.ts';
import { IDENTITY, World, gate, resultName, utf8, type Hooks } from './harness.ts';
import { assertFull, assertHold, assertInvalid, flush, until } from './helpers.ts';

// Ownership: caller-owned inputs are copied before the first await. Every test
// suspends the operation inside a real await window, then corrupts what the
// caller still holds (same length, different bytes) and resumes.

const ORIGINAL = '{"record":"ORIGINAL"}\n';
const scribble = (b: Uint8Array) => b.fill(0x58); // 'X': still valid UTF-8, same length, different digest

async function rawBytes(w: World, name: string): Promise<Uint8Array> {
  return new Uint8Array(w.recordsStorage.sql.exec('SELECT bytes FROM records WHERE name = ?', name).toArray()[0].bytes as ArrayBuffer);
}

for (const point of ['beforeList', 'beforePublish', 'afterPublish'] as const) {
  test(`putOnce keeps the original bytes when the caller mutates input at ${point}`, async () => {
    const w = await World.ready();
    const caller = utf8(ORIGINAL);
    const hold = gate();
    let entered = false;
    const hooks: Hooks = w.hooks;
    hooks[point] = async () => { hooks[point] = undefined; entered = true; await hold.promise; };

    const pending = w.records.putOnce(w.identity, resultName(1), caller);
    await until(() => entered, `${point} reached (sha256 already completed)`);
    scribble(caller);
    hold.open();
    const out = await pending;

    assert.equal(out.created, true);
    assert.deepEqual(out.bytes, utf8(ORIGINAL));
    assert.deepEqual(await rawBytes(w, resultName(1)), utf8(ORIGINAL), 'stored bytes are the original');
    assert.deepEqual(await w.records.read(w.identity, resultName(1)), utf8(ORIGINAL), 'read does not hold');
    assert.equal(out.sha256, await sha256Hex(utf8(ORIGINAL)));
    await w.records.assertConsistent(w.identity, { deep: true });
  });
}

test('views, Buffers and subclasses with overridden members are copied by their real contents', async () => {
  const w = await World.ready();
  const backing = new Uint8Array(64).fill(0x2e);
  backing.set(utf8(ORIGINAL), 10);
  const view = backing.subarray(10, 10 + utf8(ORIGINAL).byteLength);
  class Liar extends Uint8Array {
    override get byteLength(): number { return 1 << 30; }
    override get length(): number { return 3; }
    override slice(): Uint8Array<ArrayBuffer> { return new Uint8Array(utf8('{"lie":true}\n')); }
  }
  const lying = Liar.from(utf8('{"real":1}\n'));
  const buffer = Buffer.from('{"buffer":1}\n');

  const hold = gate();
  let entered = false;
  w.hooks.beforeList = async () => { w.hooks.beforeList = undefined; entered = true; await hold.promise; };
  const first = w.records.putOnce(w.identity, resultName(1), view);
  await until(() => entered, 'suspended');
  backing.fill(0x59); // the whole backing store, including the view window
  hold.open();
  await first;
  assert.deepEqual(await w.records.read(w.identity, resultName(1)), utf8(ORIGINAL));

  await w.records.putOnce(w.identity, resultName(2), lying);
  assert.deepEqual(await w.records.read(w.identity, resultName(2)), utf8('{"real":1}\n'));
  await w.records.putOnce(w.identity, resultName(3), buffer);
  assert.deepEqual(await w.records.read(w.identity, resultName(3)), utf8('{"buffer":1}\n'));
});

test('input that is not a plain, unshared Uint8Array is refused', async () => {
  const w = await World.ready();
  const text = utf8('{"a":1}\n');
  const shared = new Uint8Array(new SharedArrayBuffer(8)).fill(0x61);
  for (const bad of [new Uint16Array(4), new DataView(new ArrayBuffer(4)), text.buffer.slice(0), [123, 125], 'text', null, shared]) {
    await assertInvalid(w.records.putOnce(w.identity, resultName(1), bad as unknown as Uint8Array));
  }
  assert.equal(w.recordsStorage.rawCount('records'), 0);
});

test('size is checked before any large copy is made', async () => {
  const w = await World.ready();
  const huge = new Uint8Array(64 * 1024 * 1024).fill(0x61);
  const before = process.memoryUsage().arrayBuffers;
  await assertInvalid(w.records.putOnce(w.identity, resultName(1), huge), /exceeds/);
  await assertInvalid(w.records.completeFromWitness(w.identity, resultName(1), huge, 'a'.repeat(64)), /exceeds/);
  const growth = process.memoryUsage().arrayBuffers - before;
  assert.ok(growth < 4 * 1024 * 1024, `no copy of the oversized input was allocated (grew ${growth} bytes)`);

  const big = new Uint8Array(LIMITS.maxRecordBytes).fill(0x62);
  const tooMany = Array.from({ length: LIMITS.maxTotalBytes / LIMITS.maxRecordBytes + 1 }, (_, i) => ({ name: resultName(i + 1), bytes: big }));
  await assertFull(new World().bootstrap(tooMany, '0'.repeat(64)), /total bytes/);
  const tooLong = Array.from({ length: LIMITS.maxRecords + 1 }, (_, i) => ({ name: resultName(i + 1), bytes: big }));
  await assertFull(new World().bootstrap(tooLong, '0'.repeat(64)), /record limit/);
});

test('completeFromWitness keeps the original bytes when the caller mutates input during the witness await', async () => {
  const w = await World.ready();
  w.hooks.afterPublish = () => { w.hooks.afterPublish = undefined; throw new Error('crash'); };
  await assert.rejects(w.records.putOnce(w.identity, resultName(1), utf8(ORIGINAL)), /crash/);
  const approval = await reconcileFingerprint(w.identity, resultName(1), await sha256Hex(utf8(ORIGINAL)));

  const caller = utf8(ORIGINAL);
  const hold = gate();
  let entered = false;
  w.hooks.beforeGet = async () => { w.hooks.beforeGet = undefined; entered = true; await hold.promise; };
  const pending = w.records.completeFromWitness(w.identity, resultName(1), caller, approval);
  await until(() => entered, 'witness lookup reached');
  scribble(caller);
  hold.open();
  assert.deepEqual(await pending, { completed: true });
  assert.deepEqual(await rawBytes(w, resultName(1)), utf8(ORIGINAL));
  await w.records.assertConsistent(w.identity, { deep: true });
});

const mutableImport = () => [
  { name: resultName(1), bytes: utf8('{"i":1}\n') },
  { name: resultName(2), bytes: utf8('{"i":2}\n') },
];
const corruptImport = (records: Array<{ name: string; bytes: Uint8Array }>) => {
  for (const r of records) scribble(r.bytes);
  records[0].name = resultName(9);
  records.push({ name: resultName(8), bytes: utf8('{"extra":1}\n') });
  records.reverse();
};
const corruptIdentity = (id: ProviderStoreIdentity) => { id.chainId = '1'; id.provider = '0x00000000000000000000000000000000000000ff'; };

test('RecordLedger.beginBootstrap snapshots records and identity before its first await', async () => {
  const w = new World();
  const records = mutableImport();
  const identity = { ...IDENTITY };
  const approved = await w.approvalFor(mutableImport());
  const pending = w.records.beginBootstrap(identity, crypto.randomUUID(), records, approved); // runs to its first await
  corruptImport(records);
  corruptIdentity(identity);
  await pending;
  const rows = w.recordsStorage.sql.exec('SELECT name, bytes FROM records ORDER BY name').toArray();
  assert.deepEqual(rows.map(r => r.name), [resultName(1), resultName(2)]);
  assert.deepEqual(new Uint8Array(rows[0].bytes as ArrayBuffer), utf8('{"i":1}\n'));
  assert.deepEqual(new Uint8Array(rows[1].bytes as ArrayBuffer), utf8('{"i":2}\n'));
  assert.equal(w.recordsStorage.sql.exec("SELECT value FROM meta WHERE key = 'identity'").toArray()[0].value, JSON.stringify(['provider-store-identity/v1', 'sim-a', IDENTITY.provider, '5042002', IDENTITY.contract, IDENTITY.endpointHash]));
});

test('WitnessLedger.beginBootstrap snapshots inventory and identity before its first await', async () => {
  const w = new World();
  const inventory = [
    { name: resultName(1), sha256: await sha256Hex(utf8('{"i":1}\n')) },
    { name: resultName(2), sha256: await sha256Hex(utf8('{"i":2}\n')) },
  ];
  const approved = await w.approvalFor(mutableImport());
  const identity = { ...IDENTITY };
  const pending = w.witness.beginBootstrap(identity, crypto.randomUUID(), inventory, approved);
  inventory[0].name = resultName(9);
  inventory[1].sha256 = 'ee'.repeat(32);
  inventory.push({ name: resultName(7), sha256: 'dd'.repeat(32) });
  corruptIdentity(identity);
  await pending;
  const rows = w.witnessStorage.sql.exec('SELECT name, sha256 FROM entries ORDER BY name').toArray();
  assert.deepEqual(rows.map(r => [r.name, r.sha256]), [[resultName(1), await sha256Hex(utf8('{"i":1}\n'))], [resultName(2), await sha256Hex(utf8('{"i":2}\n'))]]);
  assert.equal(w.witness.status(IDENTITY).identityMatches, true);
});

test('bootstrapStore uses snapshots at every await, including each admin/witness port call', async () => {
  const labels = ['hash-loop', 'witness.isEmpty', 'records.isEmpty', 'witness.begin', 'records.begin', 'witness.commit', 'records.commit', 'records.check'];
  for (const label of labels) {
    const w = new World();
    const records = mutableImport();
    const identity = { ...IDENTITY };
    const approved = await w.approvalFor(mutableImport());
    let done = false;
    w.hooks.atPort = async l => { if (l === label && !done) { done = true; corruptImport(records); corruptIdentity(identity); await flush(); } };
    const pending = w.bootstrap(records, approved, identity);
    if (label === 'hash-loop') { corruptImport(records); corruptIdentity(identity); done = true; } // the first await is the hash loop
    await pending;
    assert.equal(done, true, label);
    assert.deepEqual(await w.records.read(IDENTITY, resultName(1)), utf8('{"i":1}\n'), label);
    assert.deepEqual(await w.records.read(IDENTITY, resultName(2)), utf8('{"i":2}\n'), label);
    assert.equal(w.records.list(IDENTITY, null, 10).names.length, 2, label);
    await w.records.assertConsistent(IDENTITY, { deep: true });
  }
});

test('a mutated-after-approval import is still refused when the approval no longer matches the data', async () => {
  const w = new World();
  const records = mutableImport();
  const approved = await w.approvalFor(mutableImport());
  scribble(records[0].bytes); // mutated BEFORE the call: the snapshot is of the mutated data
  await assertHold(w.bootstrap(records, approved), /approved fingerprint/);
  assert.equal(w.recordsStorage.rawCount('meta') + w.witnessStorage.rawCount('meta'), 0);
});

function fakeRpc(handler: ProviderStoreRpc['putOnce']): { rpc: ProviderStoreRpc; seen: { check?: unknown } } {
  const seen: { check?: unknown } = {};
  return {
    seen,
    rpc: {
      putOnce: handler,
      read: () => Promise.resolve(null),
      list: () => Promise.resolve({ names: [], next: null }),
      check: o => { seen.check = o; return Promise.resolve({ records: 0, witnessEntries: 0, inFlight: 0 }); },
    },
  };
}

test('RPC client: created=true answers from its own copy, not the mutated caller buffer', async () => {
  const hold = gate();
  let received: Uint8Array | undefined;
  const { rpc } = fakeRpc(async (_name, bytes) => {
    received = bytes;
    await hold.promise;
    return { created: true, sha256: await sha256Hex(bytes) }; // created=true omits bytes
  });
  const store = createRpcProviderStore(rpc);
  const caller = utf8(ORIGINAL);
  const pending = store.putOnce(resultName(1), caller);
  await flush();
  scribble(caller);
  hold.open();
  const out = await pending;
  assert.deepEqual(out.bytes, utf8(ORIGINAL), 'returns the bytes that were sent');
  assert.notEqual(out.bytes, caller);
  assert.notEqual(received, caller, 'the caller buffer is never sent');
  assert.notEqual(out.bytes, received, 'the caller cannot reach the buffer the transport saw');
  assert.equal(out.sha256, await sha256Hex(utf8(ORIGINAL)));
});

test('RPC client: a wrong acknowledged digest, text input and options are handled safely', async () => {
  const liar = createRpcProviderStore(fakeRpc(() => Promise.resolve({ created: true, sha256: 'ab'.repeat(32) })).rpc);
  await assertHold(liar.putOnce(resultName(1), utf8(ORIGINAL)), /does not match/);
  const loser = createRpcProviderStore(fakeRpc(() => Promise.resolve({ created: false, sha256: 'ab'.repeat(32), bytes: utf8(ORIGINAL) })).rpc);
  await assertHold(loser.putOnce(resultName(1), utf8(ORIGINAL)), /does not match/);

  const honest = createRpcProviderStore(fakeRpc(async (_n, b) => ({ created: false, sha256: await sha256Hex(b), bytes: b })).rpc);
  assert.equal((await honest.putOnce(resultName(1), ORIGINAL)).created, false);
  await assertInvalid(honest.putOnce(resultName(1), 'x'.repeat(LIMITS.maxRecordBytes + 1)), /exceeds/);
  await assertInvalid(honest.putOnce(resultName(1), '{"x":"\ud800"}\n'), /surrogates/);

  const { rpc, seen } = fakeRpc(() => Promise.resolve({ created: true, sha256: '' }));
  const store = createRpcProviderStore(rpc);
  const options = { deep: true, requireQuiescent: false };
  const pending = store.assertConsistent(options);
  options.deep = false; options.requireQuiescent = true;
  await pending;
  assert.deepEqual(seen.check, { deep: true, requireQuiescent: false });
});
