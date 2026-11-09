import { getAddress } from 'viem';
import { normalizeIdentity, type ProviderStoreIdentity } from '../../provider-durable-store/src/identity.ts';

/**
 * Everything the coordinator needs, from Worker vars only (never from a request). Anything missing,
 * malformed or unsupported leaves the provider HELD: it answers a fixed refusal and never builds the server.
 */
export interface ProviderConfig {
  identity: ProviderStoreIdentity;
  provider: `0x${string}`;
  contract: `0x${string}`;
  chainId: bigint;
  endpointHash: `0x${string}`;
  price: bigint;
  manifestApprovedSha256: string;
  maxRequestsPerMinute: number;
}

export type HeldReason =
  | 'configuration-incomplete' | 'configuration-unsupported' | 'manifest-not-approved' | 'manifest-mismatch'
  | 'no-verified-connection' | 'initialization-failed';

export type ConfigResult = { ok: true; config: ProviderConfig } | { ok: false; reason: HeldReason };

type Vars = Partial<Record<string, unknown>>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

export function readProviderConfig(env: Vars): ConfigResult {
  // New acceptance is not enabled in this recovery runtime. Any attempt to configure around that holds the provider.
  if (env.RECOVERY_ONLY !== undefined && env.RECOVERY_ONLY !== 'true') return { ok: false, reason: 'configuration-unsupported' };
  for (const key of Object.keys(env)) if (/^(ALLOW_|ENABLE_)?(NEW_ACCEPTANCE|ACCEPT|SIGNER|PRIVATE_KEY)/.test(key)) return { ok: false, reason: 'configuration-unsupported' };

  const deployment = str(env.DEPLOYMENT), provider = str(env.PROVIDER), chainId = str(env.CHAIN_ID);
  const contract = str(env.CONTRACT), endpointHash = str(env.ENDPOINT_HASH), price = str(env.PRICE);
  if (!deployment || !provider || !chainId || !contract || !endpointHash || !price) return { ok: false, reason: 'configuration-incomplete' };
  const manifest = str(env.MANIFEST_APPROVED_SHA256);
  if (manifest === null) return { ok: false, reason: 'manifest-not-approved' };
  if (!/^[0-9a-f]{64}$/.test(manifest)) return { ok: false, reason: 'configuration-incomplete' };
  if (!/^[0-9]{1,78}$/.test(price)) return { ok: false, reason: 'configuration-incomplete' };
  let limit = 120;
  if (env.RATE_LIMIT_PER_MINUTE !== undefined) {
    const raw = str(env.RATE_LIMIT_PER_MINUTE);
    if (raw === null || !/^[1-9][0-9]{0,4}$/.test(raw)) return { ok: false, reason: 'configuration-incomplete' };
    limit = Number(raw);
  }
  try {
    const identity = normalizeIdentity({ deployment, provider, chainId, contract, endpointHash });
    return {
      ok: true,
      config: {
        identity, provider: getAddress(identity.provider), contract: getAddress(identity.contract), chainId: BigInt(identity.chainId),
        endpointHash: identity.endpointHash as `0x${string}`, price: BigInt(price), manifestApprovedSha256: manifest, maxRequestsPerMinute: limit,
      },
    };
  } catch { return { ok: false, reason: 'configuration-incomplete' }; }
}
