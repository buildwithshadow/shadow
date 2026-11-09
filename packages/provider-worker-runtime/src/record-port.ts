import { storeObjectName, type ProviderStoreIdentity } from '../../provider-durable-store/src/identity.ts';

/**
 * The raw, byte-level surface the adapter needs. It has NO identity parameter: the identity is fixed when
 * the port is created, so nothing a request says can select another store.
 */
export interface RecordPort {
  read(name: string): Promise<Uint8Array | null>;
  putOnce(name: string, bytes: Uint8Array): Promise<{ created: boolean }>;
  list(after: string | null, limit: number): Promise<{ names: string[]; next: string | null }>;
  check(): Promise<unknown>;
}

/** Binds the byte-exact record store Durable Object for exactly one identity. */
export async function createDoRecordPort(env: Env, identity: ProviderStoreIdentity): Promise<RecordPort> {
  const stub = env.RECORD_STORE.get(env.RECORD_STORE.idFromName(await storeObjectName(identity)));
  return {
    read: name => stub.read(identity, name),
    putOnce: async (name, bytes) => { const out = await stub.putOnce(identity, name, bytes); return { created: out.created }; },
    list: (after, limit) => stub.list(identity, after, limit),
    check: () => stub.assertConsistent(identity, { deep: true }),
  };
}
