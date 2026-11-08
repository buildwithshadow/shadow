import { WorkerEntrypoint } from 'cloudflare:workers';
import { bootstrapStore } from './admin.ts';
import { ownRecordBytes } from './bytes.ts';
import { snapshotRecords } from './snapshot.ts';
import { rehydrate } from './errors.ts';
import { storeObjectName, normalizeIdentity, type ProviderStoreIdentity } from './identity.ts';
import { LIMITS } from './limits.ts';

export { RecordStoreDO } from './do-records.ts';
export { StoreWitnessDO } from './do-witness.ts';

/** The one identity this deployment serves. Callers cannot choose it. */
function identityOf(env: Env): ProviderStoreIdentity {
  return normalizeIdentity({
    deployment: env.DEPLOYMENT, provider: env.PROVIDER, chainId: env.CHAIN_ID, contract: env.CONTRACT, endpointHash: env.ENDPOINT_HASH,
  });
}

async function stubs(env: Env) {
  const identity = identityOf(env);
  const name = await storeObjectName(identity);
  return {
    identity,
    records: env.RECORD_STORE.get(env.RECORD_STORE.idFromName(name)),
    witness: env.STORE_WITNESS.get(env.STORE_WITNESS.idFromName(name)),
  };
}

/**
 * Service-binding surface for the Pages Function. Narrow on purpose: no import,
 * reset, bootstrap or reconciliation. Bind it with `entrypoint: ProviderStoreService`.
 */
export class ProviderStoreService extends WorkerEntrypoint<Env> {
  async putOnce(name: string, bytesIn: Uint8Array) {
    const bytes = ownRecordBytes(bytesIn); // copy before the first await
    const s = await stubs(this.env);
    const out = await s.records.putOnce(s.identity, name, bytes);
    return { created: out.created, sha256: out.sha256, bytes: out.created ? undefined : out.bytes };
  }
  async read(name: string) { const s = await stubs(this.env); return s.records.read(s.identity, name); }
  async list(after: string | null, limit: number) {
    const s = await stubs(this.env);
    return s.records.list(s.identity, after, Math.min(limit, LIMITS.maxListLimit));
  }
  async check(options: { deep?: boolean; requireQuiescent?: boolean }) {
    const s = await stubs(this.env);
    return s.records.assertConsistent(s.identity, { deep: options?.deep ?? true, requireQuiescent: options?.requireQuiescent ?? false });
  }
}

/**
 * Operator surface. Do NOT bind it into any Pages Function or public Worker; it
 * is meant for an operator tool that runs with the operator's own credentials.
 * Every mutation needs a fingerprint the operator approved out of band.
 */
export class ProviderStoreAdmin extends WorkerEntrypoint<Env> {
  async bootstrap(recordsIn: Array<{ name: string; bytes: Uint8Array }>, approvedInventoryFingerprint: string) {
    const records = [...snapshotRecords(recordsIn)]; // bounds and private copies before the first await
    const s = await stubs(this.env);
    try {
      return await bootstrapStore({ records: s.records, witness: s.witness }, s.identity, records, approvedInventoryFingerprint);
    } catch (error) { throw rehydrate(error); }
  }
  async inspect() { const s = await stubs(this.env); return s.records.inspect(s.identity); }
  async completeFromWitness(name: string, bytesIn: Uint8Array, approvedFingerprint: string) {
    const bytes = ownRecordBytes(bytesIn);
    const s = await stubs(this.env);
    return s.records.completeFromWitness(s.identity, name, bytes, approvedFingerprint);
  }
}

/** No HTTP surface. Everything is an RPC entrypoint; deploy with workers_dev and previews off. */
export default {
  fetch(): Response { return new Response('Not found', { status: 404 }); },
} satisfies ExportedHandler<Env>;
