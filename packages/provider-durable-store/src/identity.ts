import { SHA256_HEX, sha256OfText } from './bytes.ts';
import { ProviderStoreInvalid } from './errors.ts';

/**
 * One store identity binds provider, contract, chain and endpoint hash, plus a
 * deployment label so staging/production/forks can never share a store.
 */
export interface ProviderStoreIdentity {
  deployment: string;
  provider: string;
  chainId: string;
  contract: string;
  endpointHash: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DEPLOYMENT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const CHAIN_ID = /^[1-9][0-9]{0,19}$/;

/** Validated, lowercased copy. Throws ProviderStoreInvalid on any malformed field. */
export function normalizeIdentity(input: ProviderStoreIdentity): ProviderStoreIdentity {
  const i = input as Partial<Record<keyof ProviderStoreIdentity, unknown>> | null;
  const text = (key: keyof ProviderStoreIdentity): string => {
    const value = i?.[key];
    if (typeof value !== 'string') throw new ProviderStoreInvalid(`Identity field ${key} must be a string`);
    return value;
  };
  const deployment = text('deployment'), provider = text('provider'), chainId = text('chainId');
  const contract = text('contract'), endpointHash = text('endpointHash');
  if (!DEPLOYMENT.test(deployment)) throw new ProviderStoreInvalid('Identity deployment label is invalid');
  if (!ADDRESS.test(provider)) throw new ProviderStoreInvalid('Identity provider must be an address');
  if (!CHAIN_ID.test(chainId)) throw new ProviderStoreInvalid('Identity chainId must be a decimal string');
  if (!ADDRESS.test(contract)) throw new ProviderStoreInvalid('Identity contract must be an address');
  if (!BYTES32.test(endpointHash)) throw new ProviderStoreInvalid('Identity endpointHash must be 32 bytes');
  return { deployment, provider: provider.toLowerCase(), chainId, contract: contract.toLowerCase(), endpointHash: endpointHash.toLowerCase() };
}

/** Fixed-order encoding. Never depends on object key order. */
export function canonicalIdentity(input: ProviderStoreIdentity): string {
  const i = normalizeIdentity(input);
  return JSON.stringify(['provider-store-identity/v1', i.deployment, i.provider, i.chainId, i.contract, i.endpointHash]);
}

/** Durable Object name. The same name is used in the records and the witness namespaces. */
export async function storeObjectName(input: ProviderStoreIdentity): Promise<string> {
  const i = normalizeIdentity(input);
  return `provider-store/v1/${i.deployment}/${await sha256OfText(canonicalIdentity(i))}`;
}

export interface InventoryEntry { name: string; sha256: string }

/**
 * Fingerprint of an exact inventory. The operator computes and approves it
 * out of band after reconciling with trusted originals. Stores only VERIFY a
 * supplied fingerprint; no code path here supplies its own approval.
 */
export function inventoryFingerprint(identity: ProviderStoreIdentity, entries: readonly InventoryEntry[]): Promise<string> {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].name === sorted[k - 1].name) throw new ProviderStoreInvalid('Inventory contains a duplicate record name');
  }
  for (const e of sorted) if (!SHA256_HEX.test(e.sha256)) throw new ProviderStoreInvalid('Inventory contains an invalid digest');
  return sha256OfText(`${JSON.stringify(['provider-store-inventory/v1', canonicalIdentity(identity), sorted.map(e => [e.name, e.sha256])])}\n`);
}

/** Approval value for completing one interrupted record from operator-held original bytes. */
export function reconcileFingerprint(identity: ProviderStoreIdentity, name: string, sha256: string): Promise<string> {
  return sha256OfText(`${JSON.stringify(['provider-store-reconcile/v1', canonicalIdentity(identity), name, sha256])}\n`);
}
