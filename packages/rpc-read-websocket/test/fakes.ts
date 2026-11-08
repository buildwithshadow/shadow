import type { SocketEvent, SocketLike } from '../src/transport.ts';

// All endpoints, keys and URLs in this file are synthetic strings that exist only to
// prove they never come back out of the transport.
export const SECRET = 'SYNTHETIC_KEY_0123456789abcdef';
export const FAKE_URL = `wss://rpc.example.invalid/v2/${SECRET}`;

export class FakeSocket implements SocketLike {
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  closeCalls: Array<number | undefined> = [];
  private readonly listeners = new Map<string, Set<(e: SocketEvent) => void>>();

  addEventListener(type: string, listener: (e: SocketEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (e: SocketEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  listenerCount(): number { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0); }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error(`send on closed socket ${FAKE_URL}`);
    this.sent.push(data);
  }
  close(code?: number): void { this.closeCalls.push(code); if (this.readyState !== 3) this.readyState = 3; }

  private emit(type: string, event: SocketEvent = {}): void { for (const l of [...(this.listeners.get(type) ?? [])]) l(event); }
  open(): void { this.readyState = 1; this.emit('open'); }
  receive(data: unknown): void { this.emit('message', { data }); }
  reply(id: number, result: unknown): void { this.receive(JSON.stringify({ jsonrpc: '2.0', id, result })); }
  remoteError(id: number, code: number, message: string, data?: unknown): void {
    this.receive(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }));
  }
  serverClose(): void { this.readyState = 3; this.emit('close'); }
  fail(): void { this.emit('error', { data: FAKE_URL }); }
  /** The ids of requests written to the wire, in order. */
  ids(): number[] { return this.sent.map(s => (JSON.parse(s) as { id: number }).id); }
  methods(): string[] { return this.sent.map(s => (JSON.parse(s) as { method: string }).method); }
}

/** A hand-driven clock so deadlines are deterministic and leaked timers are visible. */
export class ManualTimers {
  private now = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): unknown => { const h = ++this.seq; this.tasks.set(h, { at: this.now + ms, fn }); return h; };
  clearTimeout = (h: unknown): void => { this.tasks.delete(h as number); };
  get outstanding(): number { return this.tasks.size; }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.now = due[1].at;
      this.tasks.delete(due[0]);
      due[1].fn();
    }
    this.now = target;
  }
}

export const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A socket factory that hands out FakeSockets and records them. `autoOpen` makes each one open on creation. */
export function factory(autoOpen = true) {
  const sockets: FakeSocket[] = [];
  let calls = 0;
  const connect = (): FakeSocket => {
    calls++;
    const s = new FakeSocket();
    sockets.push(s);
    if (autoOpen) s.readyState = 1;
    return s;
  };
  return { connect, sockets, calls: () => calls };
}
