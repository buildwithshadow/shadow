import { afterAll, describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { coordinator, edge, importThroughCoordinator, jsonOf } from './helpers.ts';
import workerSource from '../src/worker.ts?raw';
import activeSource from '../src/active-worker.ts?raw';
import coordinatorSource from '../src/coordinator.ts?raw';
import edgeSource from '../src/edge.ts?raw';
import mainnetSource from '../src/mainnet-signing-source.ts?raw';

// The public testnet capability is opt-in and separate. The default recovery Worker and the mainnet active Worker never reach it.
describe('public testnet capability isolation', () => {
  it('is not imported by the recovery Worker, the mainnet active Worker, the coordinator, the edge or the mainnet signing source', () => {
    for (const source of [workerSource, activeSource, coordinatorSource, edgeSource, mainnetSource]) {
      expect(source).not.toMatch(/public-testnet/);
      expect(source).not.toMatch(/shadow-v2-cycle/);
    }
  });

  afterAll(async () => { await (await coordinator()).__override(null); });
  it('the default recovery coordinator ignores every public testnet activation setting', async () => {
    await importThroughCoordinator([]);
    const c = await coordinator();
    const key = generatePrivateKey();
    await c.__override({
      PROVIDER_MODE: 'public-testnet-active', PROVIDER_ADMISSION_MODE: 'testnet-unmonitored', PROVIDER_SERVICE: 'shadow-v2-cycle',
      PROVIDER_SIGNING_KEY: key,
      SHADOW_V2_PAYMENT_TX: '0x28d70ae57f6eda6ff27e0c2a5a13c3074ecf6792f79c726bae02f6f7c9c53b38',
      SHADOW_V2_REPAYMENT_TX: '0xc2290754ac4827fd0f214a205fa2aabf235180328f55b4dcbade29cf37f5b8f0',
      SHADOW_V2_REPORT_RPC_URLS: 'https://rpc-a.invalid,https://rpc-b.invalid',
    });
    const r = await edge('/accept', { method: 'POST', body: JSON.stringify({ requestId: 'must-not-sign', intent: {} }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(503);
    expect(jsonOf(r).error).toBe('Provider is in recovery-only mode; no new acceptances or purchases are offered');
  });
});
