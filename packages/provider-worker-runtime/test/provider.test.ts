import { env } from 'cloudflare:workers';
import { evictAllDurableObjects } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RECEIPT_STATUSES, canonical, configuredIdentity, coordinator, digestOf, edge, fileOf, importThroughCoordinator, jsonOf, recordStoreFor,
  syntheticAcceptance, syntheticDelivery, syntheticResult,
} from './helpers.ts';
import { storeObjectName } from '../../provider-durable-store/src/identity.ts';

// The ACTUAL provider server (pinned source, recovery-only) in a coordinator Durable Object in local workerd,
// reached through the public edge Worker, over the byte-exact store. Chain data is a synthetic in-memory client:
// no RPC, no signer, no real receipt signature. Every test has a real timeout.
const BOUND = 12_000;

// Retained synthetic records: 1 accepted only, 2 accepted + delivered (placeholder signatures), 3 accepted with a mismatching result.
const retained = [
  { name: fileOf(1, 'acceptance'), bytes: canonical(syntheticAcceptance(1)) },
  { name: fileOf(2, 'acceptance'), bytes: canonical(syntheticAcceptance(2)) },
  { name: fileOf(2, 'delivery'), bytes: canonical(syntheticDelivery(2)) },
  { name: fileOf(2, 'result'), bytes: canonical(syntheticResult(2)) },
];

const bytesOf = async (name: string) => (await (await recordStoreFor(configuredIdentity())).read(configuredIdentity(), name)) as Uint8Array | null;
const same = (a: Uint8Array | null, b: Uint8Array) => a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

async function reset() { await (await coordinator()).__override(null); }

describe('held: missing or unsupported configuration never builds the server', () => {
  beforeEach(reset);
  const cases: Array<[string, Record<string, unknown>, { manifest?: string; noConnection?: boolean }, string]> = [
    ['no price', { PRICE: null }, {}, 'configuration-incomplete'],
    ['malformed chain id', { CHAIN_ID: '5042002x' }, {}, 'configuration-incomplete'],
    ['no endpoint hash', { ENDPOINT_HASH: null }, {}, 'configuration-incomplete'],
    ['no approved manifest', { MANIFEST_APPROVED_SHA256: null }, {}, 'manifest-not-approved'],
    ['approved manifest not 64 hex', { MANIFEST_APPROVED_SHA256: 'ABCD' }, {}, 'configuration-incomplete'],
    ['connection reports a different manifest', {}, { manifest: 'cd'.repeat(32) }, 'manifest-mismatch'],
    ['no verified deployment connection', {}, { noConnection: true }, 'no-verified-connection'],
    ['recoveryOnly switched off', { RECOVERY_ONLY: 'false' }, {}, 'configuration-unsupported'],
    ['new acceptance enabled', { ALLOW_NEW_ACCEPTANCE: 'true' }, {}, 'configuration-unsupported'],
    ['a signer key configured', { SIGNER_PRIVATE_KEY: '0x00' }, {}, 'configuration-unsupported'],
  ];
  for (const [label, overrides, extra, reason] of cases) {
    it(`${label} -> held (${reason})`, { timeout: BOUND }, async () => {
      const c = await coordinator();
      await c.__override(overrides, extra);
      for (const [method, path, body] of [['GET', `/status/${digestOf(1)}`, undefined], ['POST', '/accept', '{}'], ['POST', '/serve', `{"digest":"${digestOf(1)}"}`]] as const) {
        const r = await edge(path, { method, body, headers: body ? { 'content-type': 'application/json' } : {} });
        expect(r.status, `${method} ${path}`).toBe(503);
        expect(jsonOf(r).reason).toBe(reason);
        expect(r.text).not.toMatch(/0x[0-9a-f]{40}/i); // no configuration values in a hold
      }
      expect((await c.__counters()).clientCalls).toEqual([]); // the server was never built, so no chain client was touched
    });
  }

  it('the unmodified production-shaped coordinator has no verified connection, so with full valid config it still only holds', { timeout: BOUND }, async () => {
    const id = configuredIdentity();
    const stub = env.PRODUCTION_SHAPED.get(env.PRODUCTION_SHAPED.idFromName(await storeObjectName(id)));
    const r = await stub.fetch(new Request(`https://provider.internal/status/${digestOf(1)}`, { headers: { 'cf-connecting-ip': '203.0.113.5' } }));
    expect(r.status).toBe(503);
    expect(jsonOf({ text: await r.text() }).reason).toBe('no-verified-connection');
  });
});

describe('the actual provider, recovery-only', () => {
  beforeAll(reset);

  it('holds with the provider\'s own hold type while the store has no identity, and names nothing upstream', { timeout: BOUND }, async () => {
    await reset();
    const r = await edge(`/status/${digestOf(1)}`);
    expect(r.status).toBe(409);
    expect(jsonOf(r).error).toBe('Provider store needs reconciliation: the record store is held and needs operator reconciliation');
    expect(r.text).not.toMatch(/witness|identity|provider-store:|0x[0-9a-f]{64}/);
  });

  it('reports what it holds through the retained records without touching their bytes', { timeout: BOUND }, async () => {
    await reset();
    await importThroughCoordinator(retained);
    const status = await edge(`/status/${digestOf(1)}`);
    expect(status.status).toBe(200);
    expect(jsonOf(status)).toEqual({ accepted: true, delivered: false, digest: digestOf(1), paid: false, receiptStatus: RECEIPT_STATUSES[0], requestId: 'request-1' });
    expect(jsonOf(await edge(`/status/${digestOf(2)}`))).toMatchObject({ accepted: true, delivered: true, requestId: 'request-2' });
    expect(jsonOf(await edge(`/status/${digestOf(9)}`))).toMatchObject({ accepted: false, delivered: false, requestId: null });

    const c = await coordinator();
    await c.__setStatus(digestOf(1), 2);
    expect(jsonOf(await edge(`/status/${digestOf(1)}`)).receiptStatus).toBe(RECEIPT_STATUSES[2]);
    for (const r of retained) expect(same(await bytesOf(r.name), r.bytes), r.name).toBe(true);
    expect((await c.__counters()).clientCalls.every(call => call === 'receiptStatus')).toBe(true);
  });

  it('refuses new acceptance and every route it cannot honestly serve', { timeout: BOUND }, async () => {
    const accept = await edge('/accept', { method: 'POST', body: JSON.stringify({ requestId: 'x', intent: {} }), headers: { 'content-type': 'application/json' } });
    expect(accept.status).toBe(503);
    expect(jsonOf(accept).error).toBe('Provider is in recovery-only mode; no new acceptances or purchases are offered');
    expect((await edge('/accept', { method: 'POST', body: 'not json' })).status).toBe(503); // refused before the body is even read

    const unknownDigest = await edge('/serve', { method: 'POST', body: JSON.stringify({ digest: digestOf(8) }), headers: { 'content-type': 'application/json' } });
    expect(unknownDigest.status).toBe(404);
    expect(jsonOf(unknownDigest).error).toBe(`no accepted request for digest ${digestOf(8)}`);

    const undelivered = await edge('/serve', { method: 'POST', body: JSON.stringify({ digest: digestOf(1) }), headers: { 'content-type': 'application/json' } });
    expect(undelivered.status).toBe(409);
    expect(jsonOf(undelivered).error).toBe('Recovery mode cannot create a delivery; restore the original signed delivery and result');

    const forged = await edge('/serve', { method: 'POST', body: JSON.stringify({ digest: digestOf(2) }), headers: { 'content-type': 'application/json' } });
    expect(forged.status).toBe(409); // retained delivery whose signature (a placeholder here) does not verify
    expect(jsonOf(forged).error).toBe('Stored provider signature does not verify; restore trusted records');

    expect((await edge('/nope')).status).toBe(404);
    expect((await edge('/status/not-a-digest')).status).toBe(400);
    expect((await edge('/serve', { method: 'POST', body: '[]' })).status).toBe(400);
    expect((await edge(`/status/${digestOf(1)}`, { method: 'DELETE' })).status).toBe(405);
    for (const r of retained) expect(same(await bytesOf(r.name), r.bytes), r.name).toBe(true);
  });

  it('bounds headers (431) and incomplete bodies (about two seconds) in the actual server', { timeout: BOUND }, async () => {
    const c = await coordinator();
    const calls = (await c.__counters()).clientCalls.length;
    const big = await c.fetch(new Request('https://provider.internal/status/' + digestOf(1), { headers: { 'cf-connecting-ip': '203.0.113.9', 'x-big': 'x'.repeat(9000) } }));
    expect(big.status).toBe(431);
    expect(await big.text()).toBe('{"error":"Request headers exceed the provider limit"}');
    expect((await c.__counters()).clientCalls.length).toBe(calls);

    const stalled = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"digest":')); } }); // never closes
    const started = Date.now();
    const slow = await c.fetch(new Request('https://provider.internal/serve', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json' }, body: stalled, duplex: 'half' } as RequestInit));
    const elapsed = Date.now() - started;
    expect(slow.status).toBe(408);
    expect(await slow.text()).toContain('Request body deadline exceeded');
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(6000);
  });

  it('survives eviction: the coordinator re-initializes lazily and the retained bytes are unchanged', { timeout: BOUND }, async () => {
    await evictAllDurableObjects();
    const r = await edge(`/status/${digestOf(2)}`);
    expect(r.status).toBe(200);
    expect(jsonOf(r)).toMatchObject({ accepted: true, delivered: true });
    for (const rec of retained) expect(same(await bytesOf(rec.name), rec.bytes), rec.name).toBe(true);
    await reset();
  });
});
