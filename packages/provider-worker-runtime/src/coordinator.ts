import {durableRouteQuotas} from './route-quotas.ts';
import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import {snapshotRecords} from '../../provider-durable-store/src/snapshot.ts';
import {ownRecordBytes} from '../../provider-durable-store/src/bytes.ts';
import type {ReconcileOptions,DigestBudget} from '../../provider-durable-store/src/record-ledger.ts';
import { bootstrapStore } from '../../provider-durable-store/src/admin.ts';
import { ProviderStoreHold } from '../../provider-durable-store/src/errors.ts';
import { storeObjectName, type ProviderStoreIdentity } from '../../provider-durable-store/src/identity.ts';
// The actual provider server and its compatible HTTP factory, from the same repository release. Not reimplemented.
import { createProviderServer } from '../../../examples/float-mainnet-provider-server/server.mjs';
import { createCompatibleProviderHttpServer } from '../../../examples/float-mainnet-provider-server/compatible-http.mjs';
import { trustedClientAddress, UNTRUSTED_FORWARDING_HEADERS } from './client-address.ts';
import { readProviderConfig, type HeldReason, type ProviderConfig } from './config.ts';
import { createIdentityRecordStore } from './record-adapter.ts';
import { createDoRecordPort } from './record-port.ts';

/** What a verified deployment provides. The real one comes from the provider's own manifest check, which the connection module verifies. */
export interface ConnectionBundle {
  /** Hash of the manifest bytes the connection WOULD be verified against. Compared with the operator's approved hash first. */
  manifestSha256: string;
  /** Called only after that hash matches the approval. Returns { chainId: bigint, address, client } as server.mjs expects from connectCandidate. */
  close?(): void;
  connect(): Promise<{ chainId: bigint; address: string; client: unknown }>;
}

type CreateProviderServer = (options: Record<string, unknown>) => Parameters<typeof httpServerHandler>[0];

export type Ready =
  | { kind: 'serving'; handler: { fetch(request: Request): Promise<Response> }; dispose(): void; idleManaged: boolean }
  | { kind: 'held'; reason: HeldReason };

const refusal = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

/**
 * One coordinator per configured identity, addressed by the edge from Worker vars only. It hosts the actual
 * provider server in RECOVERY-ONLY mode (hard-coded; no setting turns it off) and is the single path to the
 * record store for that identity: the server reads through it, and administrative store operations run
 * through it only while it is quiesced.
 *
 * Initialization is lazy on the first request outside blockConcurrencyWhile. Deployment verification may
 * perform bounded read-only I/O; maintenance remains available while it is in flight.
 */
export class ProviderCoordinatorBase extends DurableObject<Env> {
  /** Memoized lazy initialization. Protected so a test subclass can force a fresh build; there is no production method for it. */
  protected ready: Promise<Ready> | null = null;
  private quiesced = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.quiesced = this.ctx.storage.kv.get<boolean>('maintenance:quiesced') === true;
  }
  private active = 0;
  private administrative = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  protected idleDelayMs = 30000;
  protected resetConnection = async (): Promise<void> => {
    if (this.active !== 0) throw new ProviderStoreHold('connection reset requires drained requests');
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const previous=this.ready;this.ready=null;
    if (previous) {const ready=await previous;if(ready.kind==='serving')ready.dispose();}
  };
  #scheduleIdle(): void {
    if(this.idleTimer!==null)clearTimeout(this.idleTimer);
    const selected=this.ready;
    if(!selected)return;
    void selected.then(ready=>{
      if(this.active!==0||this.ready!==selected||ready.kind!=='serving'||!ready.idleManaged)return;
      this.idleTimer=setTimeout(()=>{
        this.idleTimer=null;
        if(this.active!==0||this.ready!==selected)return;
        this.ready=null;
        ready.dispose();
      },this.idleDelayMs);
    }).catch(()=>{});
  }

  /**
   * Seams, held as FIELDS (not methods) so they are not part of the Durable Object's RPC surface.
   * `vars` is the Worker bindings; `connectionSource` returns the verified deployment, or null to stay held.
   * The base class has no verified connection, unless the deployment installs a verified connection.
   */
  protected hooks: { vars(): Record<string, unknown>; connectionSource(config: ProviderConfig): Promise<ConnectionBundle | null> } = {
    vars: () => this.env as unknown as Record<string, unknown>,
    connectionSource: () => Promise.resolve(null),
  };

  async #build(): Promise<Ready> {
    const parsed = readProviderConfig(this.hooks.vars());
    if (!parsed.ok) return { kind: 'held', reason: parsed.reason };
    const { config } = parsed;
    let bundle: ConnectionBundle | null = null;
    try {
      bundle = await this.hooks.connectionSource(config);
      if (!bundle) return { kind: 'held', reason: 'no-verified-connection' };
      if (bundle.manifestSha256 !== config.manifestApprovedSha256) {bundle.close?.();return { kind: 'held', reason: 'manifest-mismatch' };}
      const connection = await bundle.connect(); // the manifest is approved: now verify it against the chain
      const store = createIdentityRecordStore(await createDoRecordPort(this.env, config.identity));
      const server = (createProviderServer as unknown as CreateProviderServer)({
        connection,
        account: { address: config.provider }, // a public address only; no signTypedData, as recovery mode requires
        endpointHash: config.endpointHash,
        price: config.price,
        storeDir: '/unused-record-store-is-injected',
        service: () => { throw new Error('Recovery mode cannot perform service work'); },
        recoveryOnly: true,
        admissionGuard: null,
        recordStore: store,
        serverFactory: createCompatibleProviderHttpServer,
        maxRequestsPerMinute: config.maxRequestsPerMinute,
        routeQuotaStore: durableRouteQuotas(this.ctx.storage),
        trustLoopbackProxy: false,
        publicOrigin: 'https://www.shadowbuild.xyz',
        maxConcurrent: 4,
        clientAddress: (request: {headers: Record<string, string | string[] | undefined>}) => {
          const value=request.headers['cf-connecting-ip'];
          return typeof value === 'string' ? trustedClientAddress(value) : null;
        },
      });
      return { kind: 'serving', handler: httpServerHandler(server) as { fetch(request: Request): Promise<Response> }, dispose: () => bundle?.close?.(), idleManaged: typeof bundle.close === 'function' };
    } catch { bundle?.close?.();return { kind: 'held', reason: 'initialization-failed' }; }
  }

  override async fetch(request: Request): Promise<Response> {
    // This hop is internal, but it still refuses what the edge would never send: no valid platform address,
    // or any client-style forwarding header, means the request did not come through the edge.
    if (!trustedClientAddress(request.headers.get('cf-connecting-ip'))) return refusal(400, { error: 'Missing trusted client address' });
    if (UNTRUSTED_FORWARDING_HEADERS.some(name => request.headers.has(name))) return refusal(400, { error: 'Untrusted forwarding header' });
    if (this.quiesced) return refusal(503, { error: 'Provider is quiesced for maintenance; retry later' });
    if(this.idleTimer!==null)clearTimeout(this.idleTimer);this.idleTimer=null;
    this.active++; // counted before the first await so a drain cannot miss a request that is initializing
    try {
      const selected = (this.ready ??= this.#build());
      const ready = await selected;
      if (ready.kind === 'held') { if (this.ready === selected) this.ready = null; return refusal(503, { error: 'Provider is held; configuration or reconciliation is required', reason: ready.reason }); }
      return await ready.handler.fetch(request);
    } finally { this.active--;if(this.active===0)this.#scheduleIdle(); }
  }

  // ---- maintenance. Every store-changing operation requires quiesced + drained. Nothing here derives an approval. ----

  async quiesce(timeoutMs = 3000): Promise<{ quiesced: true; drained: boolean; active: number }> {
    this.ctx.storage.kv.put('maintenance:quiesced', true);
    this.quiesced = true;
    const bound = Math.min(Math.max(Math.trunc(Number(timeoutMs)) || 0, 0), 10_000);
    for (let waited = 0; this.active + this.administrative > 0 && waited < bound; waited += 10) await new Promise<void>(resolve => setTimeout(resolve, 10));
    return { quiesced: true, drained: this.active + this.administrative === 0, active: this.active + this.administrative };
  }

  resume(): { quiesced: false } { if(this.administrative!==0)throw new ProviderStoreHold('administrative operations are still active'); this.ctx.storage.kv.put('maintenance:quiesced', false); this.quiesced = false; return { quiesced: false }; }

  #requireQuiet(): ProviderStoreIdentity {
    if (!this.quiesced || this.active > 0) throw new ProviderStoreHold('administrative store operations require the provider to be quiesced and drained');
    const parsed = readProviderConfig(this.hooks.vars());
    if (!parsed.ok) throw new ProviderStoreHold('administrative store operations require a complete configuration');
    return parsed.config.identity;
  }

  #beginAdministrative(): ProviderStoreIdentity {
    const identity=this.#requireQuiet();
    if(this.administrative!==0)throw new ProviderStoreHold('administrative operations are still active');
    this.administrative++;
    return identity;
  }

  /** Import/initialize only with the operator's independent inventory and remaining reservation policy. */
  async adminBootstrap(records: Array<{ name: string; bytes: Uint8Array }>, approvedInventoryFingerprint: string, options?: {perDigest?:DigestBudget}) {
    const identity = this.#beginAdministrative();
    try {
      const owned=[...snapshotRecords(records)];
      const policy=options?.perDigest?{perDigest:{...options.perDigest}}:undefined;
      const name = await storeObjectName(identity);
      const recordsStub = this.env.RECORD_STORE.get(this.env.RECORD_STORE.idFromName(name));
      const witnessStub = this.env.STORE_WITNESS.get(this.env.STORE_WITNESS.idFromName(name));
      return await bootstrapStore({ records: recordsStub, witness: witnessStub }, identity, owned, approvedInventoryFingerprint, policy);
    } finally { this.administrative--; }
  }

  async adminComplete(recordName: string, bytes: Uint8Array, approvedFingerprint: string, options?: ReconcileOptions) {
    const identity = this.#beginAdministrative();
    try {
      const owned=ownRecordBytes(bytes);
      const policy=options?{budgetDigest:options.budgetDigest,perDigest:options.perDigest?{...options.perDigest}:undefined}:undefined;
      const stub = this.env.RECORD_STORE.get(this.env.RECORD_STORE.idFromName(await storeObjectName(identity)));
      return await stub.completeFromWitness(identity, recordName, owned, approvedFingerprint, policy);
    } finally { this.administrative--; }
  }

  async adminInspect() {
    const parsed = readProviderConfig(this.hooks.vars());
    if (!parsed.ok) throw new ProviderStoreHold('inspection requires a complete configuration');
    const stub = this.env.RECORD_STORE.get(this.env.RECORD_STORE.idFromName(await storeObjectName(parsed.config.identity)));
    return stub.inspect(parsed.config.identity);
  }
}
