import assert from 'node:assert/strict';
import { ReadonlyTransportError, createReadonlyTransport, type ErrorReason, type TransportOptions } from '../src/transport.ts';
import { ManualTimers, factory } from './fakes.ts';

export function setup(overrides: Partial<TransportOptions> = {}, autoOpen = true) {
  const timers = new ManualTimers();
  const f = factory(autoOpen);
  const transport = createReadonlyTransport({ connect: f.connect, timers, ...overrides });
  return { transport, timers, f, socket: () => f.sockets[f.sockets.length - 1] };
}

export const rejection = async (p: Promise<unknown>): Promise<ReadonlyTransportError> => {
  try { await p; } catch (e) { assert.ok(e instanceof ReadonlyTransportError, `unexpected ${String(e)}`); return e; }
  throw new assert.AssertionError({ message: 'expected a rejection' });
};
export const expectReason = async (p: Promise<unknown>, reason: ErrorReason, sent?: boolean) => {
  const e = await rejection(p);
  assert.equal(e.reason, reason);
  if (sent !== undefined) assert.equal(e.sent, sent, `sent flag for ${reason}`);
  return e;
};


/**
 * A REAL-clock bound for awaiting something that should already be settleable. The transport tests drive a manual
 * clock, so a request nobody answers and nobody times out would otherwise wait forever; this fails it by name.
 */
export function within<T>(promise: Promise<T>, label: string, ms = 2000): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => { handle = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for: ${label}`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(handle));
}
