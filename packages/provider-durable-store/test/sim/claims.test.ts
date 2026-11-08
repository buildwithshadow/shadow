import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textToBytes } from '../../src/bytes.ts';
import { createRpcProviderStore } from '../../src/client.ts';
import { ProviderStoreHold, rehydrate } from '../../src/errors.ts';
import { World, requestName, resultName, utf8, gate } from './harness.ts';
import { assertBusy, flush, until } from './helpers.ts';

test('keeps the exact serialized bytes, including terminal newline, across restart', async () => {
  const w = await World.ready();
  const samples = [
    '{"b":1,"a":"é\u2028😀"}\n', // key order and spacing are the caller's, never normalized
    '{"a":1}',                     // no terminal newline stays without one
    '{"a":1}\n',                   // and this one keeps it: different bytes, different digest
    '\uFEFF{"x":1}\r\n\n',         // BOM, CRLF and a blank line
    '{ "spaced" : [1,2 ,3] }\n\n',
  ];
  for (const [i, text] of samples.entries()) {
    const out = await w.records.putOnce(w.identity, resultName(i + 1), utf8(text));
    assert.equal(out.created, true);
  }
  for (const restart of [false, true]) {
    if (restart) w.restartRecords();
    for (const [i, text] of samples.entries()) {
      const bytes = await w.records.read(w.identity, resultName(i + 1));
      assert.deepEqual(bytes, utf8(text), `sample ${i} must be byte-identical (restart=${restart})`);
      assert.equal(new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes!), text);
    }
    await w.records.assertConsistent(w.identity, { deep: true });
  }
  const raw = w.recordsStorage.sql.exec('SELECT bytes FROM records WHERE name = ?', resultName(2)).toArray()[0].bytes as ArrayBuffer;
  assert.deepEqual(new Uint8Array(raw), utf8(samples[1]));
});

test('text with no exact UTF-8 form is refused instead of being silently altered', () => {
  assert.throws(() => textToBytes('{"x":"\ud800"}\n'), /unpaired surrogates/);
});

test('competing writes to one key: exactly one winner, everyone observes the winner bytes', async () => {
  const w = await World.ready();
  const name = resultName(1);
  const contenders = Array.from({ length: 6 }, (_, i) => utf8(`{"contender":${i}}\n`));
  const outs = await Promise.all(contenders.map(bytes => w.records.putOnce(w.identity, name, bytes)));
  const winners = outs.filter(o => o.created);
  assert.equal(winners.length, 1);
  const kept = await w.records.read(w.identity, name);
  assert.deepEqual(kept, winners[0].bytes);
  for (const o of outs) assert.deepEqual(o.bytes, kept, 'losers receive the winner bytes, not their own');
  assert.equal(w.recordsStorage.rawCount('records'), 1);
  assert.equal(w.witnessStorage.rawCount('entries'), 1);
  await w.records.assertConsistent(w.identity, { deep: true });
});

test('competing identical writes: one creation, no duplicates', async () => {
  const w = await World.ready();
  const bytes = utf8('{"same":true}\n');
  const outs = await Promise.all(Array.from({ length: 5 }, () => w.records.putOnce(w.identity, resultName(1), bytes)));
  assert.equal(outs.filter(o => o.created).length, 1);
  assert.equal(w.witnessStorage.rawCount('entries'), 1);
});

test('request bindings: competing digests for one request, then later attempts, never overwrite', async () => {
  const w = await World.ready();
  const binding = (digest: string) => utf8(`${JSON.stringify({ requestId: 'req-1', digest })}\n`);
  const d1 = `0x${'a1'.repeat(32)}`, d2 = `0x${'b2'.repeat(32)}`, d3 = `0x${'c3'.repeat(32)}`;
  const [one, two] = await Promise.all([
    w.records.putOnce(w.identity, requestName(1), binding(d1)),
    w.records.putOnce(w.identity, requestName(1), binding(d2)),
  ]);
  assert.notEqual(one.created, two.created);
  const winner = one.created ? binding(d1) : binding(d2);
  const third = await w.records.putOnce(w.identity, requestName(1), binding(d3)); // a second request, a third digest
  assert.equal(third.created, false);
  assert.deepEqual(third.bytes, winner);
  assert.deepEqual(await w.records.read(w.identity, requestName(1)), winner);
  assert.equal(w.recordsStorage.rawCount('records'), 1);
});

test('a stored key is never overwritten by a later different digest', async () => {
  const w = await World.ready();
  const first = utf8('{"digest":"one"}\n');
  await w.records.putOnce(w.identity, resultName(9), first);
  const again = await w.records.putOnce(w.identity, resultName(9), utf8('{"digest":"two"}\n'));
  assert.equal(again.created, false);
  assert.deepEqual(again.bytes, first);
  assert.throws(() => w.recordsStorage.sql.exec("UPDATE records SET bytes = x'00' WHERE name = ?", resultName(9)), /immutable/);
  assert.throws(() => w.recordsStorage.sql.exec('DELETE FROM records WHERE name = ?', resultName(9)), /immutable/);
  assert.throws(() => w.witnessStorage.sql.exec("UPDATE entries SET sha256 = 'x'"), /immutable/);
  assert.throws(() => w.witnessStorage.sql.exec('DELETE FROM entries'), /immutable/);
});

test('interleaving at the witness await: a loser waits for the winner, and checks do not claim quiescence', async () => {
  const w = await World.ready();
  const name = resultName(1), a = utf8('{"w":"A"}\n'), b = utf8('{"w":"B"}\n');
  const hold = gate();
  let used = false;
  w.hooks.beforePublish = () => { if (used) return; used = true; return hold.promise; };

  const first = w.records.putOnce(w.identity, name, a);
  await until(() => w.recordsStorage.rawCount('records') === 1, 'first writer to claim');
  assert.equal(w.witnessStorage.rawCount('entries'), 0, 'witness publication has not happened yet');

  let secondDone = false;
  const second = w.records.putOnce(w.identity, name, b).then(r => { secondDone = true; return r; });
  const reader = w.records.read(w.identity, name);
  await flush(); await flush();
  assert.equal(secondDone, false, 'the loser must wait for the in-flight winner');

  await assertBusy(w.records.assertConsistent(w.identity, { requireQuiescent: true }), /in flight/);
  const live = await w.records.assertConsistent(w.identity, { deep: true });
  assert.equal(live.inFlight, 1, 'a live claim is reported, not hidden');

  hold.open();
  const [one, two, read] = await Promise.all([first, second, reader]);
  assert.equal(one.created, true);
  assert.equal(two.created, false);
  assert.deepEqual(two.bytes, a);
  assert.deepEqual(read, a);
  const quiet = await w.records.assertConsistent(w.identity, { requireQuiescent: true });
  assert.equal(quiet.inFlight, 0);
});

test('a conflicting witness entry that appears during a check is never reported healthy', async () => {
  const w = await World.ready();
  await w.records.putOnce(w.identity, resultName(1), utf8('{"ok":1}\n'));
  const foreign = { name: resultName(2), sha256: 'ab'.repeat(32), claimId: crypto.randomUUID() };

  // Appears before the page is read: the same check must hold.
  w.hooks.beforeList = () => { w.hooks.beforeList = undefined; w.witness.publish(w.identity, foreign); };
  await assert.rejects(w.records.assertConsistent(w.identity, { deep: false }), ProviderStoreHold);

  // Appears after the page was read: that check answered for an earlier point in time, the next one holds.
  const w2 = await World.ready();
  await w2.records.putOnce(w2.identity, resultName(1), utf8('{"ok":1}\n'));
  w2.hooks.afterList = () => { w2.hooks.afterList = undefined; w2.witness.publish(w2.identity, foreign); };
  await w2.records.assertConsistent(w2.identity, { deep: false });
  await assert.rejects(w2.records.assertConsistent(w2.identity, { deep: false }), /witness ahead of record/);
});

test('RPC-style error markers rebuild the hold kind', async () => {
  const w = await World.ready();
  const rpc = {
    putOnce: (n: string, b: Uint8Array) => w.records.putOnce(w.identity, n, b),
    read: (n: string) => w.records.read(w.identity, n),
    list: async (after: string | null, limit: number) => w.records.list(w.identity, after, limit),
    check: (o: { deep?: boolean; requireQuiescent?: boolean }) => w.records.assertConsistent(w.identity, o),
  };
  const store = createRpcProviderStore(rpc);
  const text = '{"via":"client"}\n';
  assert.equal((await store.putOnce(resultName(1), text)).created, true);
  assert.deepEqual(await store.read(resultName(1)), utf8(text));
  assert.equal(await store.has(resultName(2)), false);
  const plain = new Error(new ProviderStoreHold('x').message); // what survives a Durable Object RPC boundary
  assert.ok(rehydrate(plain) instanceof ProviderStoreHold);
});
