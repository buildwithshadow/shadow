import { DurableObject } from 'cloudflare:workers';
import { normalizeIdentity, storeObjectName, type ProviderStoreIdentity } from './identity.ts';
import { RecordLedger, type ReconcileOptions } from './record-ledger.ts';
import type { WitnessEntry, WitnessPeer } from './witness-ledger.ts';

/** Reaches the witness namespace. The record store never writes witness state any other way. */
function witnessPeer(env: Env, identity: ProviderStoreIdentity): WitnessPeer {
  const stub = async () => env.STORE_WITNESS.get(env.STORE_WITNESS.idFromName(await storeObjectName(identity)));
  return {
    // Arguments are copied before the first await of each call.
    publish: async (id, entry: WitnessEntry) => {
      const i = normalizeIdentity(id), e = { name: entry.name, sha256: entry.sha256, claimId: entry.claimId };
      return (await stub()).publish(i, e);
    },
    get: async (id, name) => { const i = normalizeIdentity(id); return (await stub()).get(i, name); },
    list: async (id, after, limit) => { const i = normalizeIdentity(id); return (await stub()).list(i, after, limit); },
    status: async id => { const i = normalizeIdentity(id); return (await stub()).status(i); },
  };
}

export class RecordStoreDO extends DurableObject<Env> {
  private readonly ledger: RecordLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new RecordLedger(ctx.storage, identity => witnessPeer(env, identity));
    // Initialization only. Network IO (the witness calls) never runs inside blockConcurrencyWhile.
    void ctx.blockConcurrencyWhile(() => Promise.resolve(this.ledger.init()));
  }

  putOnce(identity: ProviderStoreIdentity, name: string, bytes: Uint8Array, options?: { budgetDigest?: string }) { return this.ledger.putOnce(identity, name, bytes, options); }
  reserveBudget(identity: ProviderStoreIdentity, digest: string, records: number, bytes: number) { return this.ledger.reserveBudget(identity, digest, records, bytes); }
  releaseBudget(identity: ProviderStoreIdentity, digest: string) { return this.ledger.releaseBudget(identity, digest); }
  budgetUsage(identity: ProviderStoreIdentity) { return this.ledger.budgetUsage(identity); }
  read(identity: ProviderStoreIdentity, name: string) { return this.ledger.read(identity, name); }
  list(identity: ProviderStoreIdentity, after: string | null, limit: number) { return this.ledger.list(identity, after, limit); }
  assertConsistent(identity: ProviderStoreIdentity, options: { deep?: boolean; requireQuiescent?: boolean }) {
    return this.ledger.assertConsistent(identity, options);
  }

  // Administrative. Reachable only through a namespace binding, never through fetch.
  inspect(identity: ProviderStoreIdentity) { return this.ledger.inspect(identity); }
  beginBootstrap(identity: ProviderStoreIdentity, nonce: string, records: Array<{ name: string; bytes: Uint8Array }>, approvedFingerprint: string, options?: { perDigest?: { records: number; bytes: number } }) {
    return this.ledger.beginBootstrap(identity, nonce, records, approvedFingerprint, options);
  }
  isEmpty() { return this.ledger.isEmpty(); }
  commitBootstrap(identity: ProviderStoreIdentity, nonce: string) { return this.ledger.commitBootstrap(identity, nonce); }
  completeFromWitness(identity: ProviderStoreIdentity, name: string, bytes: Uint8Array, approvedFingerprint: string, options?: ReconcileOptions) {
    return this.ledger.completeFromWitness(identity, name, bytes, approvedFingerprint, options);
  }
}
