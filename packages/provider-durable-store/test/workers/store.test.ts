import { env, exports } from 'cloudflare:workers';
import { evictAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderStoreAdmin, ProviderStoreService } from '../../src/worker.ts';
import { bootstrapStore } from '../../src/admin.ts';
import { sha256Hex } from '../../src/bytes.ts';
import { inventoryFingerprint, reconcileFingerprint, storeObjectName, type ProviderStoreIdentity } from '../../src/identity.ts';

// These run in workerd against the real Durable Object classes and SQLite storage.
// They do not reach any Cloudflare account, network or chain.
// The deployed Worker serves exactly this identity (wrangler vars). Tests that talk to
// the Durable Objects directly use a distinct deployment label each, so they never share state.
const configured: ProviderStoreIdentity = {
  deployment: env.DEPLOYMENT, provider: env.PROVIDER, chainId: env.CHAIN_ID, contract: env.CONTRACT, endpointHash: env.ENDPOINT_HASH,
};
let identity: ProviderStoreIdentity = configured;
let counter = 0;
beforeEach(() => { identity = { ...configured, deployment: `t${++counter}` }; });
const hex64 = (n: number) => n.toString(16).padStart(64, '0');
const name = (n: number) => `0x${hex64(n)}.result.json`;
const utf8 = (s: string) => new TextEncoder().encode(s);

async function stubs() {
  const objectName = await storeObjectName(identity);
  return {
    records: env.RECORD_STORE.get(env.RECORD_STORE.idFromName(objectName)),
    witness: env.STORE_WITNESS.get(env.STORE_WITNESS.idFromName(objectName)),
  };
}

async function ready() {
  const s = await stubs();
  await bootstrapStore({ records: s.records, witness: s.witness }, identity, [], await inventoryFingerprint(identity, []));
  return s;
}

const failure = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return (e as Error).message; }
  throw new Error('expected a rejection');
};

describe('Durable Object runtime', () => {
  it('has no public HTTP surface', async () => {
    for (const path of ['/', '/bootstrap', '/admin/import', '/v1/records']) {
      for (const method of ['GET', 'POST', 'PUT']) {
        const res = await exports.default.fetch(`https://store.example/${path}`, { method });
        expect(res.status).toBe(404);
      }
    }
  });

  it('keeps exact bytes through real RPC and an eviction', async () => {
    const s = await ready();
    const bytes = utf8('\uFEFF{"b":1,"a":"é😀"}\r\n\n');
    expect((await s.records.putOnce(identity, name(1), bytes)).created).toBe(true);
    await evictAllDurableObjects();
    const kept = await s.records.read(identity, name(1));
    expect(kept && Array.from(kept)).toEqual(Array.from(bytes));
    await s.records.assertConsistent(identity, { deep: true });
  });

  it('arbitrates competing writes across the RPC boundary', async () => {
    const s = await ready();
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => s.records.putOnce(identity, name(7), utf8(`{"c":${i}}\n`))));
    expect(outs.filter(o => o.created)).toHaveLength(1);
    const kept = await s.records.read(identity, name(7));
    const winner = outs.find(o => o.created)!;
    expect(Array.from(kept!)).toEqual(Array.from(winner.bytes));
    for (const o of outs) expect(Array.from(o.bytes)).toEqual(Array.from(kept!));
  });

  it('holds on a rolled-back record database and does not heal it', async () => {
    const s = await ready();
    await s.records.putOnce(identity, name(1), utf8('{"a":1}\n'));
    await runInDurableObject(s.records, (_i, state) => {
      state.storage.sql.exec('DROP TRIGGER records_no_delete');
      state.storage.sql.exec('DELETE FROM records WHERE name = ?', name(1));
    });
    expect(await failure(s.records.assertConsistent(identity, {}))).toContain('[provider-store:hold]');
    expect(await failure(s.records.putOnce(identity, name(2), utf8('{"a":2}\n')))).toContain('witness ahead of record');
  });

  it('holds on a pending claim left behind by an interruption', async () => {
    const s = await ready();
    await runInDurableObject(s.records, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO records (name, state, sha256, size, bytes, claim_id) VALUES (?, 'pending', ?, 1, x'41', ?)",
        name(3), 'ab'.repeat(32), crypto.randomUUID(),
      );
    });
    expect(await failure(s.records.putOnce(identity, name(3), utf8('{"a":3}\n')))).toContain('interrupted publication');
  });

  it('never recreates a missing witness or identity', async () => {
    const fresh = await stubs();
    expect(await failure(fresh.records.putOnce(identity, name(1), utf8('{"a":1}\n')))).toContain('identity is missing');

    const s = await ready();
    await s.records.putOnce(identity, name(1), utf8('{"a":1}\n'));
    await runInDurableObject(s.witness, (_i, state) => {
      state.storage.sql.exec('DROP TRIGGER entries_no_delete');
      state.storage.sql.exec('DELETE FROM entries');
      state.storage.sql.exec('DELETE FROM meta');
    });
    expect(await failure(s.records.putOnce(identity, name(2), utf8('{"a":2}\n')))).toContain('identity is missing');
    const sha = await sha256Hex(utf8('{"a":1}\n'));
    expect(sha).toHaveLength(64);
    expect(await failure(bootstrapStore({ records: s.records, witness: s.witness }, identity, [], await inventoryFingerprint(identity, [])))).toContain('completely empty');
  });

  it('rejects an unapproved import fingerprint without writing', async () => {
    const s = await stubs();
    const records = [{ name: name(1), bytes: utf8('{"a":1}\n') }];
    expect(await failure(bootstrapStore({ records: s.records, witness: s.witness }, identity, records, '0'.repeat(64)))).toContain('approved fingerprint');
    expect(await s.records.isEmpty()).toBe(true);
    expect(await s.witness.isEmpty()).toBe(true);
  });

  it('stores the original bytes when the caller mutates its buffers right after calling', async () => {
    const s = await stubs();
    const original = utf8('{"i":1}\n');
    const records = [{ name: name(1), bytes: utf8('{"i":1}\n') }];
    const approved = await inventoryFingerprint(identity, [{ name: name(1), sha256: await sha256Hex(original) }]);
    const boot = bootstrapStore({ records: s.records, witness: s.witness }, identity, records, approved);
    records[0].bytes.fill(0x58); records[0].name = name(9); records.push({ name: name(7), bytes: utf8('{"x":1}\n') });
    await boot;

    const caller = utf8('{"record":"ORIGINAL"}\n');
    const put = s.records.putOnce(identity, name(2), caller);
    caller.fill(0x58);
    await put;
    expect(Array.from((await s.records.read(identity, name(2)))!)).toEqual(Array.from(utf8('{"record":"ORIGINAL"}\n')));
    expect(Array.from((await s.records.read(identity, name(1)))!)).toEqual(Array.from(original));
    await s.records.assertConsistent(identity, { deep: true });
  });

  it('exposes only the narrow service entrypoint for the Pages Function', async () => {
    identity = configured; // the entrypoints serve the configured identity only
    const admin = exports.ProviderStoreAdmin;
    const service = exports.ProviderStoreService;
    await admin.bootstrap([], await inventoryFingerprint(identity, []));
    const put = await service.putOnce(name(5), utf8('{"via":"service"}\n'));
    expect(put.created).toBe(true);
    const caller = utf8('{"via":"service2"}\n');
    const second = service.putOnce(name(6), caller);
    caller.fill(0x58);
    await second;
    expect(Array.from((await service.read(name(6)))!)).toEqual(Array.from(utf8('{"via":"service2"}\n')));
    expect(Array.from((await service.read(name(5)))!)).toEqual(Array.from(utf8('{"via":"service"}\n')));
    // The Pages Function binds ProviderStoreService only. Its whole RPC surface:
    const surface = (cls: { prototype: object }) => Object.getOwnPropertyNames(cls.prototype).filter(n => n !== 'constructor').sort();
    expect(surface(ProviderStoreService)).toEqual(['check', 'list', 'putOnce', 'read']);
    expect(surface(ProviderStoreAdmin)).toEqual(['bootstrap', 'completeFromWitness', 'inspect']);
    // The operator entrypoint must forward both reservation policy and the
    // request alias attribution through actual Durable Object RPC.
    const s=await stubs(), digest=`0x${hex64(91)}`, admission=`${digest}.admission.json`, alias=`request-0x${hex64(91)}.json`;
    const bytes=utf8('{"reconcile":true}\n');
    await s.records.reserveBudget(identity,digest,8,800);
    await s.records.putOnce(identity,admission,bytes);
    await s.records.putOnce(identity,alias,bytes,{budgetDigest:digest});
    await runInDurableObject(s.records,(_i,state)=>{
      state.storage.sql.exec('DROP TRIGGER records_no_delete');
      state.storage.sql.exec('DELETE FROM records WHERE name IN (?,?)',admission,alias);
      state.storage.sql.exec('DELETE FROM budgets WHERE digest = ?',digest);
    });
    const approve=async(n:string)=>reconcileFingerprint(identity,n,await sha256Hex(bytes));
    expect(await failure(admin.completeFromWitness(admission,bytes,await approve(admission)))).toContain('reservation');
    await admin.completeFromWitness(admission,bytes,await approve(admission),{perDigest:{records:8,bytes:800}});
    await admin.completeFromWitness(alias,bytes,await approve(alias),{budgetDigest:digest});
    expect((await s.records.budgetUsage(identity)).reserved.records).toBe(6);
    await service.check({deep:true});
  });
});
