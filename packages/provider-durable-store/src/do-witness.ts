import { DurableObject } from 'cloudflare:workers';
import type { InventoryEntry, ProviderStoreIdentity } from './identity.ts';
import { WitnessLedger, type WitnessEntry } from './witness-ledger.ts';

/**
 * Independent digest witness. Bind it in its OWN namespace (and ideally its own
 * Worker script). It shares no database, transaction or migration with the
 * record store, and it never calls the record store.
 */
export class StoreWitnessDO extends DurableObject<Env> {
  private readonly ledger: WitnessLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new WitnessLedger(ctx.storage);
    // Initialization only: synchronous schema creation, no network IO inside the gate.
    void ctx.blockConcurrencyWhile(() => Promise.resolve(this.ledger.init()));
  }

  publish(identity: ProviderStoreIdentity, entry: WitnessEntry) { return this.ledger.publish(identity, entry); }
  get(identity: ProviderStoreIdentity, name: string) { return this.ledger.get(identity, name); }
  list(identity: ProviderStoreIdentity, after: string | null, limit: number) { return this.ledger.list(identity, after, limit); }
  status(identity: ProviderStoreIdentity) { return this.ledger.status(identity); }

  // Administrative. Reachable only through a namespace binding, never through fetch.
  beginBootstrap(identity: ProviderStoreIdentity, nonce: string, inventory: InventoryEntry[], approvedFingerprint: string) {
    return this.ledger.beginBootstrap(identity, nonce, inventory, approvedFingerprint);
  }
  isEmpty() { return this.ledger.isEmpty(); }
  commitBootstrap(identity: ProviderStoreIdentity, nonce: string) { return this.ledger.commitBootstrap(identity, nonce); }
}
