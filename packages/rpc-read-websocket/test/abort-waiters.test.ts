import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { ReadonlyTransportError } from '../src/transport.ts';
import { tick } from './fakes.ts';
import { expectReason, setup, within } from './helpers.ts';

// Aborts while the connection is hung (the socket never opens). Real-clock bounded per test.
const BOUND = { timeout: 8000 };

test('an aborted request leaves the connection queue and drops its listener immediately, before anything else runs', BOUND, async () => {
  const { transport, f } = setup({}, false); // the socket never opens
  const ac = new AbortController();
  const parked = transport.request({ method: 'eth_chainId' }, { signal: ac.signal });
  assert.equal(transport.stats().waiters, 1);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 1);

  ac.abort(); // synchronous checks right after abort(): no tick, no await
  assert.equal(transport.stats().waiters, 0, 'the waiter is gone at once');
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'the listener is gone at once');
  await within(expectReason(parked, 'aborted', false), 'aborted request settles');
  assert.equal(transport.stats().slots, 0);
  assert.equal(f.calls(), 1, 'the shared connection attempt is still the only one');
  transport.close();
});

test('requests that share one signal all leave on abort, and the signal keeps no listener', BOUND, async () => {
  const { transport } = setup({ maxPending: 8 }, false);
  const ac = new AbortController();
  const calls = Array.from({ length: 8 }, () => transport.request({ method: 'eth_chainId' }, { signal: ac.signal }));
  assert.equal(transport.stats().waiters, 8);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 8);
  ac.abort();
  assert.equal(transport.stats().waiters, 0);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  for (const c of calls) await within(expectReason(c, 'aborted', false), 'shared-signal request settles');
  assert.equal(transport.stats().slots, 0);
  transport.close();
});

test('thousands of aborted requests during a hung connection retain nothing', BOUND, async () => {
  const unhandled: unknown[] = [];
  const watch = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', watch);
  try {
    const { transport, f, timers } = setup({ maxPending: 4 }, false);
    const signals: AbortSignal[] = [];
    let maxWaiters = 0, maxSlots = 0;
    const outcomes: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5000; i++) {
      const ac = new AbortController();
      signals.push(ac.signal);
      outcomes.push(transport.request({ method: 'eth_chainId' }, { signal: ac.signal }).catch((e: unknown) => e));
      const s = transport.stats();
      maxWaiters = Math.max(maxWaiters, s.waiters);
      maxSlots = Math.max(maxSlots, s.slots);
      ac.abort();
    }
    assert.ok(maxWaiters <= 1 && maxSlots <= 1, `at most one live waiter at a time (saw ${maxWaiters}/${maxSlots})`);
    assert.deepEqual({ waiters: transport.stats().waiters, slots: transport.stats().slots }, { waiters: 0, slots: 0 });
    assert.ok(signals.every(s => getEventListeners(s, 'abort').length === 0), 'no abort listener retained on any signal');
    const results = await within(Promise.all(outcomes), 'all aborted requests settle');
    assert.ok(results.every(r => r instanceof ReadonlyTransportError && r.reason === 'aborted' && !r.sent));
    assert.equal(f.calls(), 1, 'one connection attempt for all of them');
    assert.equal(timers.outstanding, 1, 'only the connect deadline is pending');
    assert.equal(transport.stats().pending, 0);

    // The hung attempt then fails; nobody is parked, and nothing reports an unhandled rejection.
    timers.advance(10_000); await tick(); timers.advance(10_000); await tick();
    assert.equal(unhandled.length, 0, 'no unhandled rejection from the shared attempt');
    assert.equal(timers.outstanding, 0);
    transport.close();
  } finally { process.off('unhandledRejection', watch); }
});

test('parked waiters are bounded by maxPending even without any abort', BOUND, async () => {
  const { transport } = setup({ maxPending: 16 }, false);
  const acs = Array.from({ length: 100 }, () => new AbortController());
  const calls = acs.map(ac => transport.request({ method: 'eth_chainId' }, { signal: ac.signal }).catch((e: unknown) => e));
  assert.equal(transport.stats().waiters, 16);
  assert.equal(transport.stats().slots, 16);
  const excess = await within(Promise.all(calls.slice(16)), 'excess requests are refused');
  assert.ok(excess.every(e => e instanceof ReadonlyTransportError && e.reason === 'too-many-pending' && !e.sent));
  assert.equal(acs.slice(16).filter(ac => getEventListeners(ac.signal, 'abort').length > 0).length, 0, 'refused requests never attached a listener');
  acs.forEach(ac => ac.abort());
  assert.equal(transport.stats().waiters, 0);
  await within(Promise.all(calls), 'all settle');
  transport.close();
});

test('survivors still get the connection after others aborted; the aborted are never sent', BOUND, async () => {
  const { transport, socket } = setup({}, false);
  const gone = Array.from({ length: 50 }, () => { const ac = new AbortController(); const p = transport.request({ method: 'eth_getCode', params: ['0x9'] }, { signal: ac.signal }).catch((e: unknown) => e); ac.abort(); return p; });
  const stays = transport.request({ method: 'eth_chainId' }, { signal: new AbortController().signal });
  await tick();
  socket().open();
  await tick();
  assert.deepEqual(socket().methods(), ['eth_chainId']);
  socket().reply(socket().ids()[0], '0x1');
  assert.equal(await within(stays, 'survivor answered'), '0x1');
  await within(Promise.all(gone), 'aborted settle');
  assert.equal(transport.stats().waiters, 0);
  transport.close();
});

test('close() releases every parked waiter and signal listener', BOUND, async () => {
  const { transport } = setup({ maxPending: 6 }, false);
  const acs = Array.from({ length: 6 }, () => new AbortController());
  const calls = acs.map(ac => transport.request({ method: 'eth_chainId' }, { signal: ac.signal }));
  transport.close();
  assert.equal(transport.stats().waiters, 0);
  assert.ok(acs.every(ac => getEventListeners(ac.signal, 'abort').length === 0));
  for (const c of calls) await within(expectReason(c, 'closed', false), 'parked request rejected on close');
});

test('a normal completion also detaches the listener', BOUND, async () => {
  const { transport, socket } = setup();
  const ac = new AbortController();
  const p = transport.request({ method: 'eth_chainId' }, { signal: ac.signal });
  await tick();
  assert.equal(getEventListeners(ac.signal, 'abort').length, 1, 'one listener while the request is in flight');
  socket().reply(socket().ids()[0], '0x1');
  assert.equal(await within(p, 'answer'), '0x1');
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  transport.close();
});
