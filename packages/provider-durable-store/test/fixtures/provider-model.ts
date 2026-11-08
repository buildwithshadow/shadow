import { DurableObject } from 'cloudflare:workers';
import {
  ProviderCoordinatorModel, type AdmissionPolicy, type CoordinatorStore, type CountStrategy, type Externals,
} from '../model/admission-model.ts';
import { ProviderStoreHold } from '../../src/errors.ts';
import { canonicalIdentity, normalizeIdentity, storeObjectName, type ProviderStoreIdentity } from '../../src/identity.ts';

/**
 * TEST VEHICLE for the admission MODEL inside a real Durable Object. All protocol
 * requests for one provider identity route to this single actor. It is not the
 * provider server: no HTTP, no real signer (a counter stands in), no chain reads.
 * In-memory reservations live in the model and are private to this actor; the
 * record store stays authoritative after an eviction.
 *
 * The constructor does no I/O and never uses blockConcurrencyWhile. External
 * waits (the stand-in for service.prepare) are plain awaits, so other requests,
 * including paid recovery, are delivered while a purchase is suspended.
 */
export class ProviderCoordinatorDO extends DurableObject<Env> {
  private model: ProviderCoordinatorModel | null = null;
  private canonical: string | null = null;
  private signs = 0;
  private readonly gates = new Map<string, { promise: Promise<void>; open: () => void }>();

  async configure(identityIn: ProviderStoreIdentity, policy: AdmissionPolicy, strategy: CountStrategy = 'index') {
    const identity = normalizeIdentity(identityIn);
    const canon = canonicalIdentity(identity);
    if (this.canonical !== null && this.canonical !== canon) throw new ProviderStoreHold('this coordinator already serves a different provider identity');
    if (this.model) return { configured: false };
    const records = this.env.RECORD_STORE.get(this.env.RECORD_STORE.idFromName(await storeObjectName(identity)));
    const store: CoordinatorStore = {
      list: (after, limit) => records.list(identity, after, limit),
      read: name => records.read(identity, name),
      putOnce: (name, bytes, options) => records.putOnce(identity, name, bytes, options),
      assertConsistent: () => records.assertConsistent(identity, { deep: true }),
      reserveBudget: (digest, r, b) => records.reserveBudget(identity, digest, r, b),
      releaseBudget: digest => records.releaseBudget(identity, digest),
    };
    if (this.model) return { configured: false }; // another configure won the race during the await
    this.canonical = canon;
    this.model = new ProviderCoordinatorModel(store, policy, { strategy });
    return { configured: true };
  }

  private gate(name: string) {
    let g = this.gates.get(name);
    if (!g) {
      let open!: () => void;
      const promise = new Promise<void>(resolve => { open = resolve; });
      g = { promise, open };
      this.gates.set(name, g);
    }
    return g;
  }

  private need(): ProviderCoordinatorModel {
    if (!this.model) throw new ProviderStoreHold('coordinator is not configured');
    return this.model;
  }

  /** Runs the modelled acceptance. `prepareGate` suspends the stand-in for service.prepare until openGate(name). */
  async accept(req: { digest: string; agent: string; lineId: string; requestName: string }, behavior: { prepareGate?: string } = {}) {
    const model = this.need();
    const gateName = behavior.prepareGate;
    const ext: Externals = {
      guard: () => Promise.resolve(),
      prepare: async () => {
        if (gateName) await this.gate(gateName).promise;
        return new TextEncoder().encode('{"prepared":"result"}\n');
      },
      sign: () => { this.signs++; return Promise.resolve(new TextEncoder().encode('{"acceptance":true}\n')); },
    };
    try {
      const out = await model.acceptNew(req, ext);
      return { outcome: out.signed ? 'signed' : 'stored' } as const;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      if (name === 'AdmissionRefused') return { outcome: 'refused' } as const;
      if (name === 'AdmissionBusy') return { outcome: 'busy' } as const;
      if (name === 'AdmissionConflict') return { outcome: 'conflict' } as const;
      throw error;
    }
  }

  openGate(name: string) { this.gate(name).open(); }
  recover(digest: string) { return this.need().recover(digest); }
  record(name: string, text: string) { return this.need().record(name, new TextEncoder().encode(text)); }
  stats() { return { signs: this.signs, inFlight: this.model?.inFlight() ?? 0 }; }
}
