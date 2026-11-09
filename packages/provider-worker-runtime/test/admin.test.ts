import { describe, expect, it } from 'vitest';
import { ProviderCoordinatorBase } from '../src/coordinator.ts';
import edgeHandler, { ProviderAdmin } from '../src/worker.ts';
import {
  canonical, configuredIdentity, coordinator, digestOf, edge, fileOf, jsonOf, operatorApproval, recordStoreFor, syntheticAcceptance,
} from './helpers.ts';

// Administrative store operations (initialize/import/complete) go through the one coordinator and only while it
// is quiesced and drained. The approval is always supplied by the operator; the provider never produces one.
const BOUND = 15_000;
const retained = () => [{ name: fileOf(1, 'acceptance'), bytes: canonical(syntheticAcceptance(1)) }];

const failure = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return (e as Error).message; } throw new Error('expected a rejection'); };

describe('quiesced administration', () => {
  it('refuses every store-changing call unless the coordinator is quiesced and drained', { timeout: BOUND }, async () => {
    const c = await coordinator();
    const approval = await operatorApproval(configuredIdentity(), retained());
    expect(await failure(c.adminBootstrap(retained(), approval))).toMatch(/quiesced and drained/);
    expect(await failure(c.adminComplete(fileOf(1, 'acceptance'), canonical({}), approval))).toMatch(/quiesced and drained/);
    expect((await recordStoreFor(configuredIdentity()).then(s => s.isEmpty())), 'nothing was written').toBe(true);
  });

  it('answers a fixed maintenance refusal while quiesced, then imports only with the operator\'s approval', { timeout: BOUND }, async () => {
    const c = await coordinator();
    expect(await c.quiesce(1000)).toEqual({ quiesced: true, drained: true, active: 0 });
    const r = await edge(`/status/${digestOf(1)}`);
    expect(r.status).toBe(503);
    expect(jsonOf(r).error).toBe('Provider is quiesced for maintenance; retry later');

    const wrong = await operatorApproval(configuredIdentity(), [{ name: fileOf(1, 'acceptance'), bytes: canonical({ other: true }) }]);
    expect(await failure(c.adminBootstrap(retained(), wrong))).toMatch(/approved fingerprint/);
    expect(await failure(c.adminBootstrap(retained(), undefined as unknown as string))).toMatch(/approved fingerprint/);
    expect(await failure(c.adminBootstrap(retained(), 'a'.repeat(64)))).toMatch(/approved fingerprint/);
    expect((await recordStoreFor(configuredIdentity()).then(s => s.isEmpty())), 'refused imports wrote nothing').toBe(true);

    const approval = await operatorApproval(configuredIdentity(), retained());
    expect(await c.adminBootstrap(retained(), approval)).toEqual({ records: 1 });
    expect(await failure(c.adminBootstrap(retained(), approval))).toMatch(/empty|initiali|reset/i); // a second import never overwrites
    await c.resume();
    expect(jsonOf(await edge(`/status/${digestOf(1)}`))).toMatchObject({ accepted: true, requestId: 'request-1' });
  });

  it('does not drain while a request is still in flight, and then refuses administration', { timeout: BOUND }, async () => {
    const c = await coordinator();
    const stalled = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"digest":')); } });
    const inflight = c.fetch(new Request('https://provider.internal/serve', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.60' }, body: stalled, duplex: 'half' } as RequestInit));
    await new Promise(resolve => setTimeout(resolve, 100));
    const q = await c.quiesce(200);
    expect(q.drained).toBe(false);
    expect(q.active).toBeGreaterThan(0);
    const approval = await operatorApproval(configuredIdentity(), []);
    expect(await failure(c.adminBootstrap([], approval))).toMatch(/quiesced and drained/);
    expect((await inflight).status).toBe(408); // the provider's own body deadline ends it
    expect(await c.quiesce(1000)).toMatchObject({ quiesced: true, drained: true });
    await c.resume();
  });
});

describe('the surface cannot approve for the operator', () => {
  it('has no method that computes, derives, returns or auto-applies an inventory approval', () => {
    const names = (cls: { prototype: object }) => Object.getOwnPropertyNames(cls.prototype).filter(n => n !== 'constructor').sort();
    const coordinatorMethods = names(ProviderCoordinatorBase);
    expect(coordinatorMethods).toEqual(['adminBootstrap', 'adminComplete', 'adminInspect', 'fetch', 'quiesce', 'resume']); // the whole RPC surface
    expect(coordinatorMethods.filter(n => /approv|fingerprint|derive|compute|accept|import|reset|clear|heal/i.test(n))).toEqual([]);
    expect(names(ProviderAdmin)).toEqual(['bootstrap', 'completeFromWitness', 'inspect', 'quiesce', 'resume']);
    expect(Object.keys(edgeHandler).sort()).toEqual(['fetch']); // the public edge exposes only fetch
  });
});
