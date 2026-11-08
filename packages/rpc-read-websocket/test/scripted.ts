import { FakeSocket } from './fakes.ts';

/** A fake server: every request is answered (or dropped) by `handler`, after one microtask, like a real socket. */
export type Script = (m: { id: number; method: string; params: unknown[] }, socket: ScriptedSocket) => unknown;

export class ScriptedSocket extends FakeSocket {
  readonly requests: Array<{ id: number; method: string }> = [];
  handler: Script;
  constructor(handler: Script = () => '0x1') { super(); this.readyState = 1; this.handler = handler; }
  override send(data: string): void {
    super.send(data);
    const m = JSON.parse(data) as { id: number; method: string; params: unknown[] };
    this.requests.push({ id: m.id, method: m.method });
    queueMicrotask(() => {
      const out = this.handler(m, this);
      if (out === DROP) return;
      if (out === LOSE_CONNECTION) { this.serverClose(); return; }
      if (out instanceof RemoteFailure) this.remoteError(m.id, out.code, out.message, out.data);
      else this.reply(m.id, out);
    });
  }
}

export const DROP = Symbol('never answer');
export const LOSE_CONNECTION = Symbol('server closes the socket');
export class RemoteFailure {
  readonly code: number; readonly message: string; readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) { this.code = code; this.message = message; this.data = data; }
}

/** Hands out one ScriptedSocket per connect and counts every request that reached any of them. */
export function scriptedFactory(handler: Script) {
  const sockets: ScriptedSocket[] = [];
  return {
    connect: (): ScriptedSocket => { const s = new ScriptedSocket(handler); sockets.push(s); return s; },
    sockets,
    totalRequests: (): number => sockets.reduce((n, s) => n + s.requests.length, 0),
  };
}
