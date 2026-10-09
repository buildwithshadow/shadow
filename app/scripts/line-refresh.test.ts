import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { startLineRefresh } from '../src/lineRefresh.ts';

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t: TestContext, read: () => Promise<string>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const focus = new EventTarget();
  const visibility = new EventTarget();
  const values: string[] = [];
  const errors: unknown[] = [];
  const state = { visible: true };
  const stop = startLineRefresh({ read, onValue: value => values.push(value), onError: error => errors.push(error),
    visible: () => state.visible, focusTarget: focus, visibilityTarget: visibility, intervalMs: 15_000 });
  t.after(stop);
  return { focus, visibility, values, errors, state, stop };
}

test('an external purchase and repayment appear on consecutive refreshes without a browser transaction', async t => {
  let chainState = 'OPEN:100000:0';
  const f = fixture(t, async () => chainState);
  chainState = 'DRAWN:50000:50000';
  t.mock.timers.tick(15_000); await settle();
  assert.deepEqual(f.values, ['DRAWN:50000:50000']);
  chainState = 'OPEN:100000:0';
  t.mock.timers.tick(15_000); await settle();
  assert.deepEqual(f.values, ['DRAWN:50000:50000', 'OPEN:100000:0']);
});

test('focus during a slow read queues one immediate fresh read without overlap', async t => {
  const pending = deferred<string>(); let calls = 0;
  const f = fixture(t, () => ++calls === 1 ? pending.promise : Promise.resolve('REPAID'));
  t.mock.timers.tick(15_000);
  f.focus.dispatchEvent(new Event('focus'));
  f.visibility.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(60_000);
  assert.equal(calls, 1);
  pending.resolve('DRAWN'); await settle();
  assert.deepEqual(f.values, ['DRAWN', 'REPAID']);
  assert.equal(calls, 2);
  t.mock.timers.tick(14_999); assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 3);
});

test('focus refreshes immediately and replaces the scheduled tick', async t => {
  let calls = 0; const f = fixture(t, async () => String(++calls));
  t.mock.timers.tick(10_000);
  f.focus.dispatchEvent(new Event('focus')); await settle();
  assert.deepEqual(f.values, ['1']);
  t.mock.timers.tick(5_000); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(10_000); await settle(); assert.equal(calls, 2);
});

test('hidden pages stop reads and becoming visible refreshes immediately', async t => {
  let calls = 0; const f = fixture(t, async () => String(++calls));
  f.state.visible = false;
  f.visibility.dispatchEvent(new Event('visibilitychange'));
  f.focus.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 0);
  f.state.visible = true; f.visibility.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.deepEqual(f.values, ['1']);
});

test('failure retains the last result and subsequent retries recover', async t => {
  let failed = false; const f = fixture(t, async () => { if (failed) throw Error('RPC unavailable'); return 'OPEN'; });
  t.mock.timers.tick(15_000); await settle();
  failed = true; t.mock.timers.tick(15_000); await settle();
  assert.deepEqual(f.values, ['OPEN']); assert.equal(f.errors.length, 1);
  failed = false; t.mock.timers.tick(15_000); await settle();
  assert.deepEqual(f.values, ['OPEN', 'OPEN']);
});

test('stopping for a changed view or wallet review drops late responses and all triggers', async t => {
  const pending = deferred<string>(); let calls = 0;
  const f = fixture(t, () => { calls++; return pending.promise; });
  t.mock.timers.tick(15_000);
  f.focus.dispatchEvent(new Event('focus'));
  f.stop();
  pending.resolve('OLD LINE'); await settle();
  f.focus.dispatchEvent(new Event('focus'));
  f.visibility.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(60_000); await settle();
  assert.deepEqual(f.values, []); assert.equal(calls, 1);
});

test('late errors from a stopped view are discarded', async t => {
  const pending = deferred<string>(); const f = fixture(t, () => pending.promise);
  t.mock.timers.tick(15_000); f.stop(); pending.reject(Error('Old request')); await settle();
  assert.deepEqual(f.errors, []);
});

test('stopping before the first tick prevents any read', async t => {
  let calls = 0; const f = fixture(t, async () => String(++calls));
  f.stop(); t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 0);
});

test('becoming hidden cancels a queued resume until the page is visible again', async t => {
  const pending = deferred<string>(); let calls = 0;
  const f = fixture(t, () => ++calls === 1 ? pending.promise : Promise.resolve('CURRENT'));
  t.mock.timers.tick(15_000);
  f.focus.dispatchEvent(new Event('focus'));
  f.state.visible = false; f.visibility.dispatchEvent(new Event('visibilitychange'));
  pending.resolve('EARLIER'); await settle();
  t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 1);
  f.state.visible = true; f.visibility.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.deepEqual(f.values, ['EARLIER', 'CURRENT']); assert.equal(calls, 2);
});
