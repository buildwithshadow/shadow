import { ProviderCoordinatorBase, type ConnectionBundle } from '../../src/coordinator.ts';
import type { ProviderConfig } from '../../src/config.ts';
import handler from '../../src/worker.ts';

export { RecordStoreDO, StoreWitnessDO, ProviderAdmin } from '../../src/worker.ts';
export { ProviderCoordinatorDO as ProductionShapedCoordinatorDO } from '../../src/worker.ts';
export default handler;

/**
 * TEST FIXTURE. A coordinator whose "verified deployment" is SYNTHETIC: a fake connection whose client answers
 * only receiptStatus and getCode from memory. There is no RPC, no signer and no manifest verification here; the
 * manifest hash it reports is a constant the test config approves (or a test overrides to prove a mismatch holds).
 */
export class ProviderCoordinatorDO extends ProviderCoordinatorBase {
  private servers:Array<{listening:boolean}>=[];
  private statuses = new Map<string, bigint>();
  private clientCalls: string[] = [];
  private requests = 0;
  private opened=0;
  private closed=0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const originalFactory=this.serverFactory;
    this.serverFactory=(...args)=>{const server=originalFactory(...args);this.servers.push(server);return server;};
    this.hooks = { vars: () => this.#vars(), connectionSource: config => this.#connection(config) };
  }

  #vars(): Record<string, unknown> {
    const raw = this.ctx.storage.kv.get<Record<string, unknown>>('test:overrides') ?? {};
    const merged: Record<string, unknown> = { ...(this.env as unknown as Record<string, unknown>), ...raw };
    for (const [key, value] of Object.entries(raw)) if (value === null) delete merged[key];
    return merged;
  }

  #connection(config: ProviderConfig): Promise<ConnectionBundle | null> {
    return this.#bundle(config);
  }

  async #bundle(config: ProviderConfig): Promise<ConnectionBundle | null> {
    return this.#syntheticConnection(config);
  }

  #syntheticConnection(config: ProviderConfig): Promise<ConnectionBundle | null> {
    const manifest = this.ctx.storage.kv.get<string | null>('test:manifest');
    if (manifest === null && this.ctx.storage.kv.get('test:noConnection') === true) return Promise.resolve(null);
    const calls = this.clientCalls;
    const statuses = this.statuses;
    const client = {
      readContract: ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        calls.push(functionName);
        if (functionName === 'receiptStatus') return Promise.resolve(statuses.get(String(args?.[0])) ?? 0n);
        return Promise.reject(new Error('synthetic client: unsupported read'));
      },
      getCode: () => { calls.push('getCode'); return Promise.resolve('0x'); },
      getBlock: () => { calls.push('getBlock'); return Promise.reject(new Error('synthetic client: no chain')); },
    };
    return Promise.resolve({
      ...(this.ctx.storage.kv.get('test:managed') === true ? {close:()=>{this.closed++;}} : {}),
      manifestSha256: manifest ?? 'abababababababababababababababababababababababababababababababab',
      connect: () => Promise.resolve({ chainId: config.chainId, address: config.contract, client }),
    });
  }

  override async fetch(request: Request): Promise<Response> { this.requests++; return super.fetch(request); }

  // ---- test controls (never present in the production class) ----
  async __override(values: Record<string, unknown> | null, extra: { manifest?: string; noConnection?: boolean } = {}): Promise<void> {
    await this.resetConnection();
    this.ctx.storage.kv.put('test:overrides', values ?? {});
    this.ctx.storage.kv.put('test:manifest', extra.manifest ?? null);
    this.ctx.storage.kv.put('test:noConnection', extra.noConnection === true);
    this.ready = null;
  }
  async __managedConnection(){await this.resetConnection();this.ctx.storage.kv.put('test:managed',true);this.idleDelayMs=5;}
  async __resumeDuringBootstrap(records:Array<{name:string;bytes:Uint8Array}>,approval:string){
    const pending=this.adminBootstrap(records,approval);let resumeError:string|null=null;
    try{this.resume();}catch(error){resumeError=(error as Error).message;}
    try{return {resumeError,result:await pending};}catch(error){return {resumeError,error:(error as Error).message};}
  }
  async __resumeDuringComplete(name:string,bytes:Uint8Array,approval:string){
    const pending=this.adminComplete(name,bytes,approval);let resumeError:string|null=null;
    try{this.resume();}catch(error){resumeError=(error as Error).message;}
    try{return {resumeError,result:await pending};}catch(error){return {resumeError,error:(error as Error).message};}
  }
  __serverStats(){return {created:this.servers.length,listening:this.servers.filter(server=>server.listening).length};}
  __setStatus(digest: string, status: number): void { this.statuses.set(digest, BigInt(status)); }
  __setIdleDelay(ms: number) {this.idleDelayMs=ms;}
  __counters() { return { requests: this.requests, clientCalls: [...this.clientCalls], opened:this.opened, closed:this.closed }; }
}
