import {snapshotRecords} from '../../provider-durable-store/src/snapshot.ts';
import {ownRecordBytes} from '../../provider-durable-store/src/bytes.ts';
import type {ReconcileOptions,DigestBudget} from '../../provider-durable-store/src/record-ledger.ts';
import { productionConnectionSource } from './verified-connection.ts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ProviderCoordinatorBase } from './coordinator.ts';
import { handleEdge } from './edge.ts';
import { readProviderConfig } from './config.ts';
import { storeObjectName } from '../../provider-durable-store/src/identity.ts';

// The witness is exported for local tests only. Production binds STORE_WITNESS to its own Worker script.
export { RecordStoreDO } from '../../provider-durable-store/src/do-records.ts';
export { StoreWitnessDO } from '../../provider-durable-store/src/do-witness.ts';

/** Recovery coordinator: a missing approved manifest or read endpoint keeps every route held. */
export class ProviderCoordinatorDO extends ProviderCoordinatorBase {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.hooks = { vars: () => this.env as unknown as Record<string, unknown>, connectionSource: config => productionConnectionSource(this.env as unknown as Record<string, unknown>, config) };
  }
}

/**
 * Operator surface, bound only by the operator's tooling and never by the public edge or a Pages Function.
 * Every store-changing call is forwarded to the coordinator, which refuses unless it is quiesced and drained.
 */
const coordinatorFor = async (env: Env) => {
  const parsed = readProviderConfig(env as unknown as Record<string, unknown>);
  if (!parsed.ok) throw new Error('administrative operations require a complete configuration');
  return env.PROVIDER_COORDINATOR.get(env.PROVIDER_COORDINATOR.idFromName(await storeObjectName(parsed.config.identity)));
};

export class ProviderAdmin extends WorkerEntrypoint<Env> {
  async quiesce(timeoutMs?: number) { return (await coordinatorFor(this.env)).quiesce(timeoutMs); }
  async resume() { return (await coordinatorFor(this.env)).resume(); }
  async bootstrap(records: Array<{ name: string; bytes: Uint8Array }>, approvedInventoryFingerprint: string, options?: {perDigest?:DigestBudget}) {
    const owned=[...snapshotRecords(records)],policy=options?.perDigest?{perDigest:{...options.perDigest}}:undefined;
    return (await coordinatorFor(this.env)).adminBootstrap(owned, approvedInventoryFingerprint, policy);
  }
  async completeFromWitness(name: string, bytes: Uint8Array, approvedFingerprint: string, options?: ReconcileOptions) {
    const owned=ownRecordBytes(bytes),policy=options?{budgetDigest:options.budgetDigest,perDigest:options.perDigest?{...options.perDigest}:undefined}:undefined;
    return (await coordinatorFor(this.env)).adminComplete(name, owned, approvedFingerprint, policy);
  }
  async inspect() { return (await coordinatorFor(this.env)).adminInspect(); }
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleEdge(request, env),
} satisfies ExportedHandler<Env>;
