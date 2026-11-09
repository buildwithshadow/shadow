import { env } from 'cloudflare:workers';
import { evictAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { inspect } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../provider-durable-store/src/limits.ts';
import type { ProviderStoreIdentity } from '../../provider-durable-store/src/identity.ts';
import { ProviderStoreHold } from '../../../examples/float-mainnet-provider-server/store-witness.mjs';
import { createIdentityRecordStore } from '../src/record-adapter.ts';
import { createDoRecordPort, type RecordPort } from '../src/record-port.ts';
import { canonical, encode, importDirect, recordStoreFor, stableStringify } from './helpers.ts';

// The fixed-identity JSON adapter over the byte-exact store, against the REAL record and witness Durable
// Objects in local workerd. Each test uses its own deployment label so stores never share state.
const BOUND = 12_000;
let counter = 0;
let identity: ProviderStoreIdentity;
beforeEach(() => {
  identity = { deployment: `adapter-${++counter}`, provider: env.PROVIDER, chainId: env.CHAIN_ID, contract: env.CONTRACT, endpointHash: env.ENDPOINT_HASH };
});

const name = (n: number, slot = 'acceptance') => `0x${n.toString(16).padStart(64, '0')}.${slot}.json`;
const bytesOf = async (n: string) => (await (await recordStoreFor(identity)).read(identity, n)) as Uint8Array | null;
const same = (a: Uint8Array | null, b: Uint8Array) => a !== null && a.length === b.length && a.every((v, i) => v === b[i]);
async function adapter() { return createIdentityRecordStore(await createDoRecordPort(env, identity)); }

describe('record adapter over the byte-exact store', () => {
  it('writes the provider\'s own stableStringify plus a newline, byte for byte, and reads it back', { timeout: BOUND }, async () => {
    await importDirect(identity);
    const store = await adapter();
    const value = { z: 1, a: { y: [3, 2, 1], é: 'naïve 😀 \u2028' }, m: null, n: 12345678901234567890n.toString() };
    expect(await store.putOnce(name(1), value)).toBe(true);

    const raw = await bytesOf(name(1));
    expect(same(raw, encode(`${stableStringify(value)}\n`))).toBe(true);
    expect(raw![raw!.length - 1]).toBe(0x0a); // terminal newline preserved
    expect(await store.read(name(1))).toEqual(JSON.parse(stableStringify(value)));
    expect(await store.has(name(1))).toBe(true);
    expect(await store.has(name(2))).toBe(false);
    expect(await store.read(name(2))).toBeNull();
    expect(await store.list()).toEqual([name(1)]);
    await store.assertConsistent();
  });

  it('keeps retained bytes exactly as imported: never normalized, re-serialized or overwritten', { timeout: BOUND }, async () => {
    // Pretty-printed, keys out of canonical order, CRLF, no trailing newline: valid JSON the provider would parse.
    const retained = encode('{\r\n  "z": 1,\r\n  "a": [ 1,2 ]\r\n}');
    await importDirect(identity, [{ name: name(7), bytes: retained }]);
    const store = await adapter();
    expect(await store.read(name(7))).toEqual({ z: 1, a: [1, 2] });
    expect(await store.putOnce(name(7), { z: 2 })).toBe(false); // first write wins; nothing is rewritten
    expect(await store.putOnce(name(7), { z: 1, a: [1, 2] })).toBe(false); // not even an equal value
    expect(same(await bytesOf(name(7)), retained)).toBe(true);
    await store.assertConsistent();
  });

  it('arbitrates conflicting writes: exactly one winner, the loser is told false and nothing changes', { timeout: BOUND }, async () => {
    await importDirect(identity);
    const store = await adapter();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.putOnce(name(3), { writer: i })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const kept = (await store.read(name(3))) as { writer: number };
    const raw = await bytesOf(name(3));
    expect(same(raw, canonical(kept))).toBe(true);
    expect(await store.putOnce(name(3), { writer: 99 })).toBe(false);
    expect(same(await bytesOf(name(3)), raw!)).toBe(true);
    // The same holds for request bindings, the provider's other claimed record.
    const binding = `request-0x${'ab'.repeat(32)}.json`;
    const claims = await Promise.all([{ requestId: 'r', digest: name(1) }, { requestId: 'r', digest: name(2) }].map(v => store.putOnce(binding, v)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('collects every page into one complete list and refuses a partial one', { timeout: BOUND }, async () => {
    const records = Array.from({ length: 450 }, (_, i) => ({ name: name(i + 1, 'admission'), bytes: canonical({ i }) }));
    await importDirect(identity, records);
    const listed = await (await adapter()).list();
    expect(listed).toHaveLength(450);
    expect(listed).toEqual(records.map(r => r.name).sort());

    const never: RecordPort = { read: () => Promise.resolve(null), putOnce: () => Promise.resolve({ created: true }), check: () => Promise.resolve(), list: () => Promise.resolve({ names: ['x'], next: 'x' }) };
    await expect(createIdentityRecordStore(never).list()).rejects.toBeInstanceOf(ProviderStoreHold);
    const flood: RecordPort = { ...never, list: () => Promise.resolve({ names: Array.from({ length: 200 }, (_, i) => `n${i}`), next: 'more' }) };
    await expect(createIdentityRecordStore(flood).list()).rejects.toBeInstanceOf(ProviderStoreHold);
    expect(LIMITS.maxRecords).toBe(1000);
  });

  it('maps a record-store hold to the provider\'s own hold type and leaks no upstream diagnostics', { timeout: BOUND }, async () => {
    await importDirect(identity);
    const store = await adapter();
    await store.putOnce(name(1), { a: 1 });
    await store.putOnce(name(2), { b: 2 });
    // Simulate a record database rolled back past a witnessed record.
    await runInDurableObject(await recordStoreFor(identity), (_instance, state) => {
      state.storage.sql.exec('DROP TRIGGER IF EXISTS records_no_delete');
      state.storage.sql.exec('DELETE FROM records WHERE name = ?', name(2));
    });
    // The provider calls assertConsistent first on every route; these are the calls the store itself refuses.
    for (const attempt of [() => store.assertConsistent(), () => store.read(name(2)), () => store.putOnce(name(3), { c: 3 }), () => store.has(name(2))]) {
      const error = await attempt().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderStoreHold);
      const hold = error as ProviderStoreHold & { status: number; cause?: unknown };
      expect(hold.status).toBe(409);
      expect(hold.message).toBe('Provider store needs reconciliation: the record store is held and needs operator reconciliation');
      expect(hold.cause).toBeUndefined();
      const dump = `${hold.message} ${inspect(hold)}`;
      for (const leak of [name(1), name(2), '0000000000000000', 'witness', 'provider-store:', 'ahead', 'sha256', 'RecordLedger']) expect(dump).not.toContain(leak);
    }
    // A read of an unaffected record is not what detects the damage; the consistency check before it does.
    expect(await store.read(name(1))).toEqual({ a: 1 });
  });

  it('turns every other failure into a bare generic error with no cause', { timeout: BOUND }, async () => {
    await importDirect(identity);
    const store = await adapter();
    const invalid = await store.read('not-a-record-name').then(() => null, (e: unknown) => e as Error);
    expect(invalid).toBeInstanceOf(Error);
    expect(invalid).not.toBeInstanceOf(ProviderStoreHold);
    expect(invalid!.message).toBe('record store unavailable');
    expect((invalid as { cause?: unknown }).cause).toBeUndefined();

    const SECRET = 'SYNTHETIC_UPSTREAM_SECRET_wss://rpc.invalid/key';
    const failing: RecordPort = {
      read: () => Promise.reject(new Error(SECRET)), putOnce: () => Promise.reject(new Error(SECRET)), list: () => Promise.reject(new Error(SECRET)), check: () => Promise.reject(new Error(SECRET)),
    };
    const broken = createIdentityRecordStore(failing);
    for (const attempt of [() => broken.read(name(1)), () => broken.putOnce(name(1), {}), () => broken.list(), () => broken.assertConsistent()]) {
      const e = await attempt().then(() => null, (x: unknown) => x as Error);
      expect(e!.message).toBe('record store unavailable');
      expect(`${inspect(e)}`).not.toContain('SYNTHETIC_UPSTREAM_SECRET');
    }
  });

  it('survives eviction with identical bytes and a clean consistency check', { timeout: BOUND }, async () => {
    await importDirect(identity);
    const store = await adapter();
    await store.putOnce(name(5), { keep: 'me' });
    const before = await bytesOf(name(5));
    await evictAllDurableObjects();
    const after = await adapter();
    expect(same(await bytesOf(name(5)), before!)).toBe(true);
    expect(await after.read(name(5))).toEqual({ keep: 'me' });
    await after.assertConsistent();
    expect(await after.putOnce(name(5), { keep: 'other' })).toBe(false);
  });

  it('has no way to name another identity: the port is bound at creation and stores are separate', { timeout: BOUND }, async () => {
    const other: ProviderStoreIdentity = { ...identity, deployment: `${identity.deployment}-b` };
    await importDirect(identity);
    await importDirect(other);
    const a = await adapter();
    const b = createIdentityRecordStore(await createDoRecordPort(env, other));
    await a.putOnce(name(9), { owner: 'a' });
    expect(await b.read(name(9))).toBeNull();
    expect(await b.list()).toEqual([]);
    const port = await createDoRecordPort(env, identity);
    expect(Object.keys(port).sort()).toEqual(['check', 'list', 'putOnce', 'read']);
    expect([port.read.length, port.putOnce.length, port.list.length, port.check.length]).toEqual([1, 2, 2, 0]); // no identity parameter anywhere
  });
});
