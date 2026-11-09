import { env, exports } from 'cloudflare:workers';
import { getAddress, keccak256 } from 'viem';
import { bootstrapStore } from '../../provider-durable-store/src/admin.ts';
import { sha256Hex } from '../../provider-durable-store/src/bytes.ts';
import { inventoryFingerprint, storeObjectName, type ProviderStoreIdentity } from '../../provider-durable-store/src/identity.ts';
import { ACCEPTANCE_KIND, DELIVERY_KIND, receiptFile, requestIdHashOf } from '../../../app/scripts/float-mainnet-provider.mjs';
import { stableStringify } from '../../../app/scripts/float-mainnet-format.mjs';
import { RECEIPT_STATUSES } from '../../../app/scripts/float-mainnet-config.mjs';

export { RECEIPT_STATUSES, stableStringify };
export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const canonical = (value: unknown): Uint8Array => encode(`${stableStringify(value)}\n`);

/** The identity the Worker is configured for (wrangler vars). Tests never choose one for the edge or the coordinator. */
export function configuredIdentity(): ProviderStoreIdentity {
  return { deployment: env.DEPLOYMENT, provider: env.PROVIDER, chainId: env.CHAIN_ID, contract: env.CONTRACT, endpointHash: env.ENDPOINT_HASH };
}

export async function coordinator() {
  return env.PROVIDER_COORDINATOR.get(env.PROVIDER_COORDINATOR.idFromName(await storeObjectName(configuredIdentity())));
}
export async function recordStoreFor(identity: ProviderStoreIdentity) {
  return env.RECORD_STORE.get(env.RECORD_STORE.idFromName(await storeObjectName(identity)));
}
export async function witnessFor(identity: ProviderStoreIdentity) {
  return env.STORE_WITNESS.get(env.STORE_WITNESS.idFromName(await storeObjectName(identity)));
}

/** What an OPERATOR does out of band: hash the retained bytes and fingerprint the inventory. Never done by the provider code. */
export async function operatorApproval(identity: ProviderStoreIdentity, records: Array<{ name: string; bytes: Uint8Array }>): Promise<string> {
  const entries = await Promise.all(records.map(async r => ({ name: r.name, sha256: await sha256Hex(r.bytes) })));
  return inventoryFingerprint(identity, entries);
}

/** Initialize or import the configured identity through the coordinator, quiesced as required, then resume. */
export async function importThroughCoordinator(records: Array<{ name: string; bytes: Uint8Array }> = []): Promise<void> {
  const c = await coordinator();
  const q = await c.quiesce(2000);
  if (!q.drained) throw new Error('coordinator did not drain');
  try { await c.adminBootstrap(records, await operatorApproval(configuredIdentity(), records)); } finally { await c.resume(); }
}

/** Initialize or import an arbitrary identity DIRECTLY (adapter tests, no coordinator involved). */
export async function importDirect(identity: ProviderStoreIdentity, records: Array<{ name: string; bytes: Uint8Array }> = []): Promise<void> {
  await bootstrapStore({ records: await recordStoreFor(identity), witness: await witnessFor(identity) }, identity, records, await operatorApproval(identity, records));
}

export async function edge(path: string, init: { method?: string; ip?: string | null; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const headers = new Headers(init.headers);
  if (init.ip !== null) headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
  const response = await exports.default.fetch(`https://provider.example.test${path}`, { method: init.method ?? 'GET', headers, body: init.body });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
export const jsonOf = (r: { text: string }): Record<string, unknown> => JSON.parse(r.text) as Record<string, unknown>;

// ---- SYNTHETIC retained records. Receipt signatures are fixed placeholder bytes, not signatures by any key. ----
export const digestOf = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;
const FAKE_SIGNATURE = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;

export function syntheticAcceptance(n: number, requestId = `request-${n}`) {
  const id = configuredIdentity();
  return receiptFile({
    kind: ACCEPTANCE_KIND, chainId: BigInt(id.chainId), verifyingContract: getAddress(id.contract),
    message: { digest: digestOf(n), provider: getAddress(id.provider), endpointHash: id.endpointHash, principal: 1_000_000n, requestIdHash: requestIdHashOf(requestId), acceptedAt: 1_700_000_000n },
    signature: FAKE_SIGNATURE, requestId, resultRef: undefined,
  }) as Record<string, unknown>;
}
export function syntheticResult(n: number, requestId = `request-${n}`, text = `result ${n}`) {
  return { digest: digestOf(n), requestId, result: btoa(text), resultRef: null };
}
export function syntheticDelivery(n: number, requestId = `request-${n}`, text = `result ${n}`) {
  const id = configuredIdentity();
  return receiptFile({
    kind: DELIVERY_KIND, chainId: BigInt(id.chainId), verifyingContract: getAddress(id.contract),
    message: {
      digest: digestOf(n), provider: getAddress(id.provider), requestIdHash: requestIdHashOf(requestId),
      resultHash: keccak256(encode(text)), resultRefHash: `0x${'0'.repeat(64)}`, deliveredAt: 1_700_000_100n,
    },
    signature: FAKE_SIGNATURE, requestId, resultRef: undefined,
  }) as Record<string, unknown>;
}
export const fileOf = (n: number, slot: string): string => `${digestOf(n)}.${slot}.json`;
