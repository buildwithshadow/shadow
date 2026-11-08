import { env } from 'cloudflare:workers';
import { evictAllDurableObjects } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdmissionPolicy } from '../model/admission-model.ts';
import { bootstrapStore } from '../../src/admin.ts';
import { inventoryFingerprint, storeObjectName, type ProviderStoreIdentity } from '../../src/identity.ts';

// ACTUAL workerd behavior of the admission MODEL hosted in a Durable Object
// (src/do-provider.ts), over the real record store and witness Durable Objects.
// Not the provider server: the signer is a counter, there is no HTTP and no chain.
// Everything runs locally in Miniflare; nothing reaches a Cloudflare account.

const hex64 = (n: number) => n.toString(16).padStart(64, '0');
const digest = (n: number) => `0x${hex64(n)}`;
const fileOf = (n: number, slot: string) => `${digest(n)}.${slot}.json`;
const req = (n: number, agent = `agent-${n}`) => ({ digest: digest(n), agent, lineId: `line-${n}`, requestName: `request-0x${hex64(n)}.json` });
const POLICY: AdmissionPolicy = { maxOutstanding: 3, maxPerAgent: 99, maxPerLine: 99, budget: { records: 8, bytes: 4096 }, pageSize: 2 };

let counter = 0;
let identity: ProviderStoreIdentity;
beforeEach(() => {
  identity = {
    deployment: `p${++counter}`, provider: env.PROVIDER, chainId: env.CHAIN_ID, contract: env.CONTRACT, endpointHash: env.ENDPOINT_HASH,
  };
});

async function actors(id: ProviderStoreIdentity = identity) {
  const name = await storeObjectName(id);
  const records = env.RECORD_STORE.get(env.RECORD_STORE.idFromName(name));
  const witness = env.STORE_WITNESS.get(env.STORE_WITNESS.idFromName(name));
  await bootstrapStore({ records, witness }, id, [], await inventoryFingerprint(id, []));
  const provider = env.PROVIDER_COORDINATOR.get(env.PROVIDER_COORDINATOR.idFromName(name));
  await provider.configure(id, POLICY);
  return { records, witness, provider };
}

// try/catch rather than expect().rejects: an un-awaited RPC rejection is reported by workerd as an unhandled error.
const failure = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return (e as Error).message; }
  throw new Error('expected a rejection');
};

const until = async (condition: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error(`timed out: ${label}`);
};

describe('provider coordinator Durable Object (model hosted in workerd)', () => {
  it('admits exactly the cap under concurrent purchases suspended in an external await, and still answers RPC meanwhile', async () => {
    const { provider } = await actors();
    const pending = Array.from({ length: 8 }, (_, i) => provider.accept(req(i + 1), { prepareGate: 'slow' }));
    // These calls are delivered while the purchases are suspended in prepare: nothing blocks the actor.
    await until(async () => (await provider.stats()).inFlight === 3, 'three purchases suspended in prepare');
    expect((await provider.stats()).signs).toBe(0);
    await provider.openGate('slow');
    const outcomes = (await Promise.all(pending)).map(r => r.outcome);
    expect(outcomes.filter(o => o === 'signed')).toHaveLength(3);
    expect(outcomes.filter(o => o === 'refused')).toHaveLength(5);
    expect((await provider.stats()).signs).toBe(3);
  });

  it('serves paid recovery while a new purchase is suspended', async () => {
    const { provider } = await actors();
    expect((await provider.accept(req(1))).outcome).toBe('signed');
    const slow = provider.accept(req(2), { prepareGate: 'slow2' });
    await until(async () => (await provider.stats()).inFlight === 1, 'purchase 2 suspended');
    const stored = await provider.recover(digest(1));
    expect(new TextDecoder().decode(stored!)).toBe('{"acceptance":true}\n');
    await provider.record(fileOf(1, 'payment'), '{"paid":true}\n');
    await provider.record(fileOf(1, 'delivery'), '{"delivered":true}\n');
    expect((await provider.stats()).inFlight).toBe(1); // the purchase is still waiting
    await provider.openGate('slow2');
    expect((await slow).outcome).toBe('signed');
  });

  it('keeps provider identities independent', async () => {
    const a = await actors();
    const other = { ...identity, deployment: `${identity.deployment}b`, contract: '0x00000000000000000000000000000000000000c9' };
    const b = await actors(other);
    for (let n = 1; n <= 3; n++) expect((await a.provider.accept(req(n))).outcome).toBe('signed');
    expect((await a.provider.accept(req(4))).outcome).toBe('refused');
    for (let n = 1; n <= 3; n++) expect((await b.provider.accept(req(n))).outcome).toBe('signed'); // same digests, other identity
    expect((await b.provider.stats()).signs).toBe(3);
    expect((await a.provider.stats()).signs).toBe(3);
    expect(await failure(a.provider.configure(other, POLICY))).toMatch(/different provider identity/);
  });

  it('rebuilds its view from the records after an eviction and keeps counting correctly', async () => {
    const { provider } = await actors();
    for (let n = 1; n <= 3; n++) expect((await provider.accept(req(n))).outcome).toBe('signed');
    await evictAllDurableObjects();
    await provider.configure(identity, POLICY); // the in-memory model is gone; the records are authoritative
    expect((await provider.accept(req(4))).outcome).toBe('refused');
    expect((await provider.accept(req(1))).outcome).toBe('stored'); // accepted work is recovered, not re-signed
    await provider.record(fileOf(1, 'delivery'), '{"delivered":true}\n'); // frees a slot
    expect((await provider.accept(req(4))).outcome).toBe('signed');
  });

  it('enforces per-digest capacity reservations in the real record store', async () => {
    const { records } = await actors();
    await records.reserveBudget(identity, digest(1), 600, 1000);
    expect((await records.budgetUsage(identity)).budgets).toBe(1);
    expect(await failure(records.reserveBudget(identity, digest(2), 600, 1000))).toContain('[provider-store:full]');
    expect((await records.releaseBudget(identity, digest(1))).released).toBe(true);
    await records.reserveBudget(identity, digest(2), 600, 1000);
  });
});
