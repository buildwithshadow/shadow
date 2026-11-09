import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createReadonlyTransport, type ReadonlyTransport, type SocketEvent, type SocketLike } from '../../rpc-read-websocket/src/transport.ts';
import { connectCandidate, readDeployment } from '../../../app/scripts/float-mainnet-config.mjs';
import type { ConnectionBundle } from './coordinator.ts';
import type { ProviderConfig } from './config.ts';

export const MAX_MANIFEST_BYTES = 65_536;
export const hashManifest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Manifest parsing may use request-local scratch files; no durable record is stored in /tmp. */
export function approvedDeployment(manifest: string, config: ProviderConfig) {
  if (typeof manifest !== 'string' || manifest.length > MAX_MANIFEST_BYTES) throw Error('invalid release manifest');
  const bytes = new TextEncoder().encode(manifest);
  if (bytes.length > MAX_MANIFEST_BYTES || hashManifest(bytes) !== config.manifestApprovedSha256) throw Error('release manifest not approved');
  const path = `/tmp/shadow-provider-manifest-${config.manifestApprovedSha256}.json`;
  try { writeFileSync(path, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw Error('manifest scratch unavailable');
    if (!Buffer.from(readFileSync(path)).equals(Buffer.from(bytes))) throw Error('manifest scratch conflict');
  }
  return readDeployment({ ARC_RPC_URL: 'owned-read-provider', FLOAT_MAINNET_EXPECTED_CHAIN_ID: config.chainId.toString(), FLOAT_MAINNET_ADDRESS: config.contract }, { manifest: path });
}

/** Credentials remain inside this closure and are never returned in a diagnostic. Redirects are refused. */
export function websocketConnector(raw: string): () => Promise<SocketLike> {
  let url: URL;
  try { url = new URL(raw); } catch { throw Error('invalid read endpoint'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash) throw Error('invalid read endpoint');
  return async () => {
    let response: Response;
    try { response = await fetch(raw.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket' }, redirect: 'manual' }); }
    catch { throw Error('read connection unavailable'); }
    if (response.status !== 101 || !response.webSocket) throw Error('read connection unavailable');
    response.webSocket.accept();
    return workerSocket(response.webSocket);
  };
}

export function productionConnectionSource(vars: Record<string, unknown>, config: ProviderConfig): Promise<ConnectionBundle | null> {
  if (typeof vars.MANIFEST_JSON !== 'string' || typeof vars.RPC_WSS_URL !== 'string') return Promise.resolve(null);
  // Approval and identity are checked before creating any external connection.
  const deployment = approvedDeployment(vars.MANIFEST_JSON, config);
  const connect = websocketConnector(vars.RPC_WSS_URL);
  let transport: ReadonlyTransport | null = null;
  return Promise.resolve({
    manifestSha256: config.manifestApprovedSha256,
    connect: async () => {
      if (transport !== null) throw Error('connection already initialized');
      transport = createReadonlyTransport({ connect, connectAttempts: 1, connectTimeoutMs: 5_000, requestTimeoutMs: 20_000 });
      try { return await connectCandidate(deployment, { readOnly: true, readProvider: transport }); }
      catch { transport.close(); throw Error('deployment verification failed'); }
    },
    close: () => transport?.close(),
  });
}

/** Adapt Workers event types without changing the transport event or cleanup contract. */
export function workerSocket(socket: WebSocket): SocketLike {
  const listeners = new Map<(event: SocketEvent) => void, Map<string, (event: Event) => void>>();
  return {
    get readyState() { return socket.readyState; },
    send: data => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener(type, listener) {
      if (type !== 'message' && type !== 'close' && type !== 'error') throw Error('unsupported socket event');
      let typed = listeners.get(listener);
      if (!typed) { typed = new Map(); listeners.set(listener, typed); }
      if (typed.has(type)) return;
      const adapted = (event: Event) => listener(type === 'message' ? {data: (event as MessageEvent).data} : {});
      typed.set(type, adapted);
      socket.addEventListener(type, adapted);
    },
    removeEventListener(type, listener) {
      if (type !== 'message' && type !== 'close' && type !== 'error') return;
      const typed = listeners.get(listener), adapted = typed?.get(type);
      if (!adapted) return;
      socket.removeEventListener(type, adapted);
      typed!.delete(type);
      if (typed!.size === 0) listeners.delete(listener);
    },
  };
}
