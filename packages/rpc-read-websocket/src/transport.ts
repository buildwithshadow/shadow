import { classifyRpcReadFailure } from '../../../app/scripts/rpc-read-classification.mjs';
// TRANSPORT ONLY. A bounded, read-only JSON-RPC request/response channel over one
// injected WebSocket, shaped like an EIP-1193 provider so viem's `custom()` can use it.
// It knows nothing about the endpoint: the URL lives only inside the injected `connect`
// factory, so no error or stat produced here can contain it. No dependencies.

export const ALLOWED_METHODS = Object.freeze([
  'eth_chainId', 'eth_getCode', 'eth_call', 'eth_getBlockByNumber', 'eth_getLogs',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt',
] as const);
export type AllowedMethod = (typeof ALLOWED_METHODS)[number];
const ALLOWED = new Set<string>(ALLOWED_METHODS);

export type ErrorReason =
  | 'method-not-allowed' | 'invalid-request' | 'request-too-large' | 'too-many-pending'
  | 'connect-failed' | 'connect-timeout' | 'request-timeout' | 'aborted' | 'closed'
  | 'connection-lost' | 'protocol-error' | 'message-too-large' | 'send-failed';

const TEXT: Record<ErrorReason, string> = {
  'method-not-allowed': 'method is not allowed by the read-only transport',
  'invalid-request': 'request is not a valid read-only JSON-RPC call',
  'request-too-large': 'request exceeds the size limit',
  'too-many-pending': 'too many requests are pending',
  'connect-failed': 'could not establish the connection',
  'connect-timeout': 'connection attempt timed out',
  'request-timeout': 'request timed out; it may have reached the remote end and is not retried',
  'aborted': 'request was aborted',
  'closed': 'transport is closed',
  'connection-lost': 'connection closed before a response; the request is not retried',
  'protocol-error': 'received an invalid response; the connection was closed',
  'message-too-large': 'received a message over the size limit; the connection was closed',
  'send-failed': 'request could not be sent',
};

/**
 * Numeric codes follow EIP-1193 / JSON-RPC and are chosen so that viem's default retry policy does NOT
 * retry them. viem retries every error that has no numeric `code`, so an uncoded local error would be
 * replayed even though the request may already have reached the node.
 */
const LOCAL_CODE: Record<ErrorReason, number> = {
  'method-not-allowed': 4200, 'invalid-request': -32600, 'request-too-large': -32600, 'too-many-pending': -32600,
  'connect-failed': 4900, 'connect-timeout': 4900, 'request-timeout': 4900, 'aborted': 4900, 'closed': 4900,
  'connection-lost': 4900, 'protocol-error': 4900, 'message-too-large': 4900, 'send-failed': 4900,
};

/** Local failure. Fixed text only: never the endpoint, a factory error or remote content. */
export class ReadonlyTransportError extends Error {
  readonly reason: ErrorReason;
  readonly code: number;
  /** True when the request may have reached the remote end, so a caller must not assume it had no effect. */
  readonly sent: boolean;
  constructor(reason: ErrorReason, sent = false) {
    super(TEXT[reason]);
    this.name = 'ReadonlyTransportError';
    this.reason = reason;
    this.code = LOCAL_CODE[reason];
    this.sent = sent;
  }
}

/**
 * Fixed descriptions chosen locally from the numeric code. Nothing the remote node wrote in `message`
 * is ever copied into an error: a node can put anything there (a key, a tenant name, an address, a
 * hostname without a scheme), and no pattern can tell secrets from text.
 */
function describeRemote(code: number): string {
  switch (code) {
    case -32700: return 'parse error';
    case -32600: return 'invalid request';
    case -32601: return 'method not found';
    case -32602: return 'invalid params';
    case -32603: return 'internal error';
    case -32005: return 'limit exceeded';
    case 3: return 'execution reverted';
    default: return code >= -32099 && code <= -32000 ? 'server error' : 'remote error';
  }
}

/** Largest revert payload kept, in characters (including 0x). Longer or non-hex data is dropped, not truncated. */
export const MAX_REMOTE_DATA_CHARS = 8192;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * The remote node answered with a JSON-RPC error. Only the numeric code, a locally written description and,
 * for `eth_call`, well-formed hex revert data (the one remote field viem needs to decode a revert) survive.
 */
export class RemoteRpcError extends Error {
  readonly remote = true as const;
  readonly sent = true as const;
  readonly code: number;
  /** Hex revert data from an `eth_call` error, or undefined. Remote-controlled bytes: never treat as trusted text. */
  readonly data?: string;
  readonly details: string;
  constructor(code: number, data?: string, rawMessage?: string, method?: string) {
    super(`remote JSON-RPC error ${code}: ${describeRemote(code)}`);
    this.details = classifyRpcReadFailure({ code, message: rawMessage }, method);
    this.name = 'RemoteRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export interface SocketEvent { data?: unknown }
/** The subset of the WebSocket API used. Workers' accepted client sockets and DOM WebSocket both fit. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
}
const OPEN = 1;

export interface TransportOptions {
  /** Creates (and for Workers, upgrades and accepts) one socket. May resolve before or after it is open. */
  connect: () => SocketLike | Promise<SocketLike>;
  maxPending?: number;
  maxMessageBytes?: number;
  maxRequestBytes?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Connection attempts per connect, all before anything is sent on that socket. */
  connectAttempts?: number;
  /** Unmatched replies tolerated before the connection is treated as hostile. */
  maxUnmatchedReplies?: number;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

export interface RequestArgs { method: string; params?: unknown }
export interface RequestOptions { signal?: AbortSignal }

export interface ReadonlyTransport {
  request(args: RequestArgs, options?: RequestOptions): Promise<unknown>;
  /** Idempotent. Rejects everything pending, closes the socket, clears every timer and listener. */
  close(): void;
  stats(): { pending: number; open: boolean; epoch: number; timers: number; lateReplies: number; unmatchedReplies: number; waiters: number; slots: number };
}

interface Pending { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: unknown; detach: (() => void) | null; release: () => void }
interface Waiter { resolve(socket: SocketLike): void; reject(error: Error): void; detach(): void }
interface Live { socket: SocketLike; onMessage: (e: SocketEvent) => void; onClose: () => void; onError: () => void }

const positive = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
};
const exceeds = (text: string, max: number): boolean =>
  text.length > max || (text.length * 3 > max && new TextEncoder().encode(text).byteLength > max);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createReadonlyTransport(options: TransportOptions): ReadonlyTransport {
  const maxPending = positive('maxPending', options.maxPending ?? 16);
  const maxMessageBytes = positive('maxMessageBytes', options.maxMessageBytes ?? 4 * 1024 * 1024);
  const maxRequestBytes = positive('maxRequestBytes', options.maxRequestBytes ?? 64 * 1024);
  const connectTimeoutMs = positive('connectTimeoutMs', options.connectTimeoutMs ?? 10_000);
  const requestTimeoutMs = positive('requestTimeoutMs', options.requestTimeoutMs ?? 30_000);
  const connectAttempts = positive('connectAttempts', options.connectAttempts ?? 2);
  const maxUnmatched = positive('maxUnmatchedReplies', options.maxUnmatchedReplies ?? 64);
  const timers = options.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>) };

  const pending = new Map<number, Pending>();
  const settled = new Set<number>(); // recently finished ids, so late or duplicate replies are recognised and dropped
  const timerSet = new Set<unknown>();
  let live: Live | null = null;
  let connecting = false;
  const waiters = new Set<Waiter>(); // requests parked on the one in-progress connection; each leaves the instant it aborts
  let abortConnect: (() => void) | null = null;
  let closed = false;
  let nextId = 1;
  let epoch = 0;
  let slots = 0; // queued + sent requests
  let late = 0, unmatched = 0;

  const startTimer = (ms: number, fn: () => void): unknown => {
    const handle = timers.setTimeout(() => { timerSet.delete(handle); fn(); }, ms);
    timerSet.add(handle);
    return handle;
  };
  const stopTimer = (handle: unknown): void => { timers.clearTimeout(handle); timerSet.delete(handle); };

  /** The single exit for a sent request: settle once, release its timer and abort listener, remember the id. */
  const finish = (id: number, outcome: { value: unknown } | { error: Error }): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    stopTimer(p.timer);
    p.detach?.();
    p.release(); // the slot is free the moment the request settles, not a microtask later
    settled.add(id);
    if (settled.size > 1024) settled.delete(settled.values().next().value as number);
    if ('error' in outcome) p.reject(outcome.error); else p.resolve(outcome.value);
  };

  const failAll = (reason: ErrorReason): void => {
    for (const id of [...pending.keys()]) finish(id, { error: new ReadonlyTransportError(reason, true) });
  };

  const quiet = (socket: SocketLike): void => { try { socket.close(1000, 'done'); } catch { /* already closing */ } };

  /** Tears down the live socket (if it is this one) and fails everything that was sent on it. */
  const drop = (socket: SocketLike, reason: ErrorReason, code = 1000): void => {
    if (live?.socket !== socket) return;
    const l = live;
    live = null;
    socket.removeEventListener('message', l.onMessage);
    socket.removeEventListener('close', l.onClose);
    socket.removeEventListener('error', l.onError);
    try { socket.close(code, 'closed'); } catch { /* already closing */ }
    failAll(reason);
  };

  const onMessage = (socket: SocketLike, event: SocketEvent): void => {
    if (live?.socket !== socket) return;
    const data = event.data;
    if (typeof data !== 'string') return drop(socket, 'protocol-error', 1003);
    if (exceeds(data, maxMessageBytes)) return drop(socket, 'message-too-large', 1009);
    let message: unknown;
    try { message = JSON.parse(data); } catch { return drop(socket, 'protocol-error', 1002); }
    if (!isObject(message)) return drop(socket, 'protocol-error', 1002);
    const id = message.id;
    if (typeof id !== 'number' || !pending.has(id)) {
      // Late (after timeout/abort), duplicate or unknown. It satisfies nothing.
      if (typeof id === 'number' && settled.has(id)) { late++; return; }
      if (++unmatched > maxUnmatched) drop(socket, 'protocol-error', 1008);
      return;
    }
    const fail = (): void => finish(id, { error: new ReadonlyTransportError('protocol-error', true) });
    if (message.jsonrpc !== '2.0') return fail();
    const hasError = Object.hasOwn(message, 'error'), hasResult = Object.hasOwn(message, 'result');
    if (hasError === hasResult) return fail();
    if (!hasError) return finish(id, { value: message.result });
    const e = message.error;
    if (!isObject(e) || typeof e.code !== 'number' || !Number.isSafeInteger(e.code) || typeof e.message !== 'string') return fail();
    const method = pending.get(id)?.method;
    const revertData = method === 'eth_call' && typeof e.data === 'string' && e.data.length <= MAX_REMOTE_DATA_CHARS && HEX.test(e.data) ? e.data : undefined;
    finish(id, { error: new RemoteRpcError(e.code, revertData, e.message, method) });
  };

  const adopt = (socket: SocketLike): void => {
    const l: Live = {
      socket,
      onMessage: e => onMessage(socket, e),
      onClose: () => drop(socket, 'connection-lost'),
      onError: () => drop(socket, 'connection-lost'),
    };
    live = l;
    epoch++;
    socket.addEventListener('message', l.onMessage);
    socket.addEventListener('close', l.onClose);
    socket.addEventListener('error', l.onError);
    if (socket.readyState !== OPEN) drop(socket, 'connection-lost'); // closed between the attempt and adoption
  };

  /** One connection attempt, bounded by the connect deadline. Never sends anything. */
  const attempt = (): Promise<SocketLike> => new Promise<SocketLike>((resolve, reject) => {
    let socket: SocketLike | null = null;
    let done = false;
    const onOpen = (): void => finishAttempt(null);
    const onBad = (): void => finishAttempt('connect-failed');
    const detach = (): void => {
      if (!socket) return;
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onBad);
      socket.removeEventListener('error', onBad);
    };
    const timer = startTimer(connectTimeoutMs, () => finishAttempt('connect-timeout'));
    const finishAttempt = (failure: ErrorReason | null): void => {
      if (done) return;
      done = true;
      stopTimer(timer);
      abortConnect = null;
      detach();
      if (failure === null && socket) return resolve(socket);
      if (socket) quiet(socket);
      reject(new ReadonlyTransportError(failure ?? 'connect-failed'));
    };
    abortConnect = () => finishAttempt('closed');
    Promise.resolve().then(options.connect).then(s => {
      if (done) { quiet(s); return; } // the attempt already timed out or the transport closed
      socket = s;
      try {
        s.addEventListener('open', onOpen);
        s.addEventListener('close', onBad);
        s.addEventListener('error', onBad);
      } catch { finishAttempt('connect-failed'); return; }
      if (s.readyState === OPEN) onOpen(); else if (s.readyState > OPEN) onBad();
    }, () => finishAttempt('connect-failed')); // the factory's error text is dropped: it may contain the endpoint
  });

  const openSocket = async (): Promise<SocketLike> => {
    let reason: ErrorReason = 'connect-failed';
    for (let n = 0; n < connectAttempts; n++) {
      if (closed) throw new ReadonlyTransportError('closed');
      try {
        const socket = await attempt();
        if (closed) { quiet(socket); throw new ReadonlyTransportError('closed'); }
        adopt(socket);
        return socket;
      } catch (error) {
        if (error instanceof ReadonlyTransportError) { if (error.reason === 'closed') throw error; reason = error.reason; }
      }
    }
    throw new ReadonlyTransportError(reason);
  };

  /** Hands the connection outcome to every parked request, once. */
  const settleWaiters = (outcome: { socket: SocketLike } | { error: Error }): void => {
    for (const w of [...waiters]) {
      waiters.delete(w);
      w.detach();
      if ('error' in outcome) w.reject(outcome.error); else w.resolve(outcome.socket);
    }
  };

  /**
   * One connection attempt serves all callers. Each caller is a Waiter in a Set, never a reaction hung on a
   * shared promise: an aborted caller is deleted and its listener removed in the abort handler itself, so a
   * hung connection plus any number of aborted requests retains nothing beyond the live (slot-bounded) ones.
   */
  const acquire = (signal: AbortSignal | undefined, release: () => void): Promise<SocketLike> => {
    // CLOSING/CLOSED may precede the close event. Retire that socket and its
    // outstanding reads before adoption can replace the live identity.
    if (live && live.socket.readyState !== OPEN) drop(live.socket, 'connection-lost');
    if (live && live.socket.readyState === OPEN) return Promise.resolve(live.socket);
    if (!connecting) {
      connecting = true;
      openSocket().then(
        socket => { connecting = false; settleWaiters({ socket }); },
        (error: unknown) => { connecting = false; settleWaiters({ error: error instanceof Error ? error : new ReadonlyTransportError('connect-failed') }); },
      );
    }
    return new Promise<SocketLike>((resolve, reject) => {
      if (signal?.aborted) return reject(new ReadonlyTransportError('aborted'));
      const waiter: Waiter = { resolve, reject, detach: () => signal?.removeEventListener('abort', onAbort) };
      function onAbort(): void { waiters.delete(waiter); waiter.detach(); release(); reject(new ReadonlyTransportError('aborted')); }
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.add(waiter);
    });
  };

  const exchange = (socket: SocketLike, id: number, method: string, text: string, signal: AbortSignal | undefined, release: () => void): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) return reject(new ReadonlyTransportError('closed'));
      if (live?.socket !== socket || socket.readyState !== OPEN) return reject(new ReadonlyTransportError('connection-lost'));
      if (signal?.aborted) return reject(new ReadonlyTransportError('aborted'));
      const p: Pending = { method, resolve, reject, timer: null, detach: null, release };
      p.timer = startTimer(requestTimeoutMs, () => finish(id, { error: new ReadonlyTransportError('request-timeout', true) }));
      if (signal) {
        const onAbort = (): void => finish(id, { error: new ReadonlyTransportError('aborted', true) });
        signal.addEventListener('abort', onAbort, { once: true });
        p.detach = () => signal.removeEventListener('abort', onAbort);
      }
      pending.set(id, p);
      try { socket.send(text); } catch {
        finish(id, { error: new ReadonlyTransportError('send-failed') });
        drop(socket, 'connection-lost');
      }
    });

  return {
    async request(args, requestOptions = {}) {
      // Everything below until the first await is synchronous validation. Nothing is sent or connected on failure.
      if (closed) throw new ReadonlyTransportError('closed');
      const method = args?.method;
      if (typeof method !== 'string' || !ALLOWED.has(method)) throw new ReadonlyTransportError('method-not-allowed');
      const params = args.params === undefined ? [] : args.params;
      if (!Array.isArray(params)) throw new ReadonlyTransportError('invalid-request');
      const signal = requestOptions.signal;
      if (signal?.aborted) throw new ReadonlyTransportError('aborted');
      if (slots >= maxPending) throw new ReadonlyTransportError('too-many-pending');
      const id = nextId++; // never reused, so a reply can only ever match the request that owns it
      let text: string | undefined;
      try { text = JSON.stringify({ jsonrpc: '2.0', id, method, params }); } catch { text = undefined; }
      if (text === undefined) throw new ReadonlyTransportError('invalid-request');
      if (exceeds(text, maxRequestBytes)) throw new ReadonlyTransportError('request-too-large');
      slots++;
      let held = true;
      const release = (): void => { if (held) { held = false; slots--; } }; // idempotent: abort, settle and finally may all call it
      try {
        const socket = await acquire(signal, release);
        return await exchange(socket, id, method, text, signal, release);
      } finally { release(); }
    },

    close() {
      if (closed) return;
      closed = true;
      abortConnect?.();
      settleWaiters({ error: new ReadonlyTransportError('closed') }); // nobody stays parked, even if no attempt was in progress
      if (live) {
        const { socket } = live;
        drop(socket, 'closed'); // fails sent requests with the closed reason
      }
      for (const handle of [...timerSet]) stopTimer(handle);
    },

    stats: () => ({ pending: pending.size, open: live !== null, epoch, timers: timerSet.size, lateReplies: late, unmatchedReplies: unmatched, waiters: waiters.size, slots }),
  };
}
