import type {SocketEvent,SocketLike} from '../../rpc-read-websocket/src/transport.ts';
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

/** Adapt Workers event types without changing the transport event or cleanup contract. */
export function workerSocket(socket: WebSocket): SocketLike {
  const listeners = new Map<(event: SocketEvent) => void, Map<string, (event: Event) => void>>();
  return {
    get readyState() { return socket.readyState; },
    send: data => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener(type, listener) {
      if (type !== 'open' && type !== 'message' && type !== 'close' && type !== 'error') throw Error('unsupported socket event');
      let typed = listeners.get(listener);
      if (!typed) { typed = new Map(); listeners.set(listener, typed); }
      if (typed.has(type)) return;
      const adapted = (event: Event) => listener(type === 'message' ? {data: (event as MessageEvent).data} : {});
      typed.set(type, adapted);
      socket.addEventListener(type, adapted);
    },
    removeEventListener(type, listener) {
      if (type !== 'open' && type !== 'message' && type !== 'close' && type !== 'error') return;
      const typed = listeners.get(listener), adapted = typed?.get(type);
      if (!adapted) return;
      socket.removeEventListener(type, adapted);
      typed!.delete(type);
      if (typed!.size === 0) listeners.delete(listener);
    },
  };
}
