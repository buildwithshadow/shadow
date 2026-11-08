import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { createReadonlyTransport } from '../src/transport.ts';
import { FakeSocket, ManualTimers, tick } from './fakes.ts';
import { expectReason, rejection, setup } from './helpers.ts';

// Lifecycle and failure-ordering tests: deadlines, drops, close, abort and late replies.

test('connection timeout: the attempt is bounded, retried before anything is sent, and cleaned up', async () => {
  const { transport, timers, f } = setup({ connectTimeoutMs: 1000, connectAttempts: 2 }, false); // sockets never open
  const outcome = rejection(transport.request({ method: 'eth_chainId' }));
  await tick();
  assert.equal(f.sockets.length, 1);
  timers.advance(999);
  await tick();
  assert.equal(f.sockets.length, 1, 'still waiting inside the deadline');
  timers.advance(1);
  await tick();
  assert.equal(f.sockets.length, 2, 'second attempt starts only after the first timed out');
  timers.advance(1000);
  const e = await outcome;
  assert.equal(e.reason, 'connect-timeout');
  assert.equal(e.sent, false);
  assert.ok(f.sockets.every(s => s.sent.length === 0 && s.readyState === 3 && s.listenerCount() === 0), 'nothing sent, sockets closed, listeners removed');
  assert.equal(timers.outstanding, 0);
  transport.close();
});

test('reconnects only before anything is sent: a failed first attempt is retried, a request is sent once', async () => {
  const { transport, f } = setup({ connectAttempts: 3 }, false);
  const p = transport.request({ method: 'eth_chainId' });
  await tick();
  f.sockets[0].serverClose(); // the first attempt dies before opening
  await tick();
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open();
  await tick();
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(f.sockets[1].sent.length, 1);
  f.sockets[1].reply(f.sockets[1].ids()[0], '0x1');
  assert.equal(await p, '0x1');
  transport.close();
});

test('a connection that drops after sending fails the requests and is never replayed', async () => {
  const { transport, f, timers } = setup();
  const lost = transport.request({ method: 'eth_getLogs', params: [{}] });
  const other = transport.request({ method: 'eth_chainId' });
  await tick();
  const first = f.sockets[0];
  assert.equal(first.sent.length, 2);
  first.serverClose();
  await expectReason(lost, 'connection-lost', true);
  await expectReason(other, 'connection-lost', true);
  await tick(); await tick();
  assert.equal(f.sockets.length, 1, 'no automatic reconnect or replay');
  assert.equal(first.sent.length, 2);
  assert.equal(transport.stats().pending, 0);
  assert.equal(timers.outstanding, 0);

  // A later, new request is a new read on a new connection; the old ones are not resent.
  const fresh = transport.request({ method: 'eth_chainId' });
  await tick();
  assert.equal(f.sockets.length, 2);
  assert.equal(transport.stats().epoch, 2, 'the epoch tells a caller its snapshot spans connections');
  assert.deepEqual(f.sockets[1].methods(), ['eth_chainId']);
  f.sockets[1].reply(f.sockets[1].ids()[0], '0x1');
  assert.equal(await fresh, '0x1');
  assert.equal(first.sent.length, 2);
  transport.close();
});

test('a socket error event after sending drops the connection the same way', async () => {
  const { transport, socket } = setup();
  const p = transport.request({ method: 'eth_getLogs', params: [{}] });
  await tick();
  socket().fail();
  await expectReason(p, 'connection-lost', true);
  assert.equal(socket().readyState, 3);
  assert.equal(socket().listenerCount(), 0);
  transport.close();
});

test('close while waiting: pending and connecting requests are rejected and everything is released', async () => {
  const sent = setup();
  const a = sent.transport.request({ method: 'eth_chainId' });
  const b = sent.transport.request({ method: 'eth_getCode', params: ['0x1'] });
  await tick();
  const ids = sent.socket().ids();
  sent.transport.close();
  await expectReason(a, 'closed', true);
  await expectReason(b, 'closed', true);
  const s = sent.socket();
  assert.equal(s.readyState, 3);
  assert.equal(s.listenerCount(), 0);
  assert.equal(sent.timers.outstanding, 0);
  assert.deepEqual(sent.transport.stats(), { pending: 0, open: false, epoch: 1, timers: 0, lateReplies: 0, unmatchedReplies: 0, waiters: 0, slots: 0 });
  s.reply(ids[0], 'after-close'); // nothing is listening any more
  sent.transport.close(); // idempotent
  await expectReason(sent.transport.request({ method: 'eth_chainId' }), 'closed', false);

  const connecting = setup({}, false);
  const c = connecting.transport.request({ method: 'eth_chainId' });
  await tick();
  connecting.transport.close();
  await expectReason(c, 'closed', false);
  assert.ok(connecting.f.sockets.every(x => x.readyState === 3 && x.listenerCount() === 0 && x.sent.length === 0));
  assert.equal(connecting.timers.outstanding, 0);
});

test('a socket that becomes available after the transport closed is closed, not adopted', async () => {
  const timers = new ManualTimers();
  let release!: (s: FakeSocket) => void;
  const late = new FakeSocket();
  const transport = createReadonlyTransport({ connect: () => new Promise<FakeSocket>(r => { release = r; }), timers });
  const p = transport.request({ method: 'eth_chainId' });
  await tick();
  transport.close();
  release(late); late.readyState = 1;
  await expectReason(p, 'closed', false);
  await tick();
  assert.equal(late.readyState, 3);
  assert.equal(late.sent.length, 0);
  assert.equal(timers.outstanding, 0);
});

test('malformed and oversize incoming messages close the connection with generic errors', async () => {
  const cases = [
    ['not json', '{oops', 'protocol-error'], ['array reply', '[{"jsonrpc":"2.0","id":1,"result":1}]', 'protocol-error'],
    ['number', '5', 'protocol-error'], ['null', 'null', 'protocol-error'], ['binary', new Uint8Array([1, 2]), 'protocol-error'],
    ['oversize', `{"jsonrpc":"2.0","id":1,"result":"${'x'.repeat(2000)}"}`, 'message-too-large'],
    ['oversize multibyte', `{"jsonrpc":"2.0","id":1,"result":"${'é'.repeat(300)}"}`, 'message-too-large'],
  ] as const;
  for (const [label, payload, reason] of cases) {
    const { transport, socket, timers } = setup({ maxMessageBytes: 500 });
    const a = transport.request({ method: 'eth_chainId' });
    const b = transport.request({ method: 'eth_chainId' });
    await tick();
    socket().receive(payload);
    const ea = await expectReason(a, reason, true);
    await expectReason(b, reason, true);
    assert.equal(socket().readyState, 3, label);
    assert.equal(socket().listenerCount(), 0, label);
    assert.ok(!ea.message.includes('x'.repeat(20)), 'the offending payload is not echoed');
    assert.equal(timers.outstanding, 0, label);
    transport.close();
  }
});

test('pending requests are bounded', async () => {
  const { transport, socket } = setup({ maxPending: 3 });
  const held = [1, 2, 3].map(() => transport.request({ method: 'eth_chainId' }));
  await tick();
  await expectReason(transport.request({ method: 'eth_chainId' }), 'too-many-pending', false);
  assert.equal(socket().sent.length, 3);
  socket().reply(socket().ids()[0], 'r');
  await held[0];
  const next = transport.request({ method: 'eth_chainId' }); // a slot was freed
  await tick();
  assert.equal(socket().sent.length, 4);
  socket().ids().forEach(id => socket().reply(id, 'r'));
  await Promise.all([...held.slice(1), next]);
  transport.close();
});

test('abort before send, while connecting, and after send', async () => {
  // before: nothing is created or sent
  const pre = setup();
  const ac0 = new AbortController(); ac0.abort();
  await expectReason(pre.transport.request({ method: 'eth_chainId' }, { signal: ac0.signal }), 'aborted', false);
  assert.equal(pre.f.calls(), 0);

  // while connecting: that request leaves; the connection and the other request continue
  const mid = setup({}, false);
  const ac1 = new AbortController();
  const aborted = mid.transport.request({ method: 'eth_chainId' }, { signal: ac1.signal });
  const stays = mid.transport.request({ method: 'eth_getCode', params: ['0x1'] });
  await tick();
  ac1.abort();
  await expectReason(aborted, 'aborted', false);
  assert.equal(getEventListeners(ac1.signal, 'abort').length, 0, 'abort listener removed');
  mid.socket().open();
  await tick();
  assert.deepEqual(mid.socket().methods(), ['eth_getCode'], 'the aborted request was never sent');
  mid.socket().reply(mid.socket().ids()[0], 'code');
  assert.equal(await stays, 'code');
  mid.transport.close();

  // after send: rejected as possibly-sent, slot and timer freed, a late reply ignored
  const post = setup({ maxPending: 2 });
  const ac2 = new AbortController();
  const gone = post.transport.request({ method: 'eth_chainId' }, { signal: ac2.signal });
  const waiting = post.transport.request({ method: 'eth_getCode', params: ['0x2'] });
  await tick();
  // Sends are not guaranteed to follow call order (a request with a signal takes extra ticks), so find ids by method.
  const sentIds = post.socket().sent.map(t => JSON.parse(t) as { id: number; method: string });
  const goneId = sentIds.find(m => m.method === 'eth_chainId')!.id;
  const waitingId = sentIds.find(m => m.method === 'eth_getCode')!.id;
  ac2.abort();
  await expectReason(gone, 'aborted', true);
  assert.equal(getEventListeners(ac2.signal, 'abort').length, 0);
  assert.equal(post.transport.stats().pending, 1);
  post.socket().reply(goneId, 'late-for-aborted');
  assert.equal(post.transport.stats().lateReplies, 1);
  const third = post.transport.request({ method: 'eth_chainId' }); // the slot was freed
  await tick();
  post.socket().reply(post.socket().ids().at(-1)!, 'third');
  post.socket().reply(waitingId, 'waiting');
  assert.deepEqual(await Promise.all([waiting, third]), ['waiting', 'third']);
  post.transport.close();
  assert.equal(post.timers.outstanding, 0);
});

test('request timeout and a late reply: the late reply satisfies nothing', async () => {
  const { transport, socket, timers } = setup({ requestTimeoutMs: 500 });
  const slowOutcome = rejection(transport.request({ method: 'eth_getLogs', params: [{}] }));
  await tick();
  const slowId = socket().ids()[0];
  timers.advance(500);
  const e = await slowOutcome;
  assert.equal(e.reason, 'request-timeout');
  assert.equal(e.sent, true, 'a caller is told the request may have been executed');
  assert.equal(timers.outstanding, 0);

  const next = transport.request({ method: 'eth_chainId' });
  await tick();
  socket().reply(slowId, 'LATE-ANSWER'); // arrives after the timeout
  assert.equal(transport.stats().pending, 1, 'the late reply did not resolve the new request');
  socket().reply(socket().ids()[1], 'fresh');
  assert.equal(await next, 'fresh');
  assert.equal(transport.stats().lateReplies, 1);
  assert.equal(socket().sent.length, 2, 'the timed-out request was not re-sent');
  transport.close();
});

test('the request deadline is per request and starts when it is sent', async () => {
  const { transport, socket, timers } = setup({ requestTimeoutMs: 100 });
  const a = transport.request({ method: 'eth_chainId' });
  await tick();
  timers.advance(60);
  const b = transport.request({ method: 'eth_chainId' });
  await tick();
  timers.advance(50); // a is at 110ms, b at 50ms
  await expectReason(a, 'request-timeout', true);
  socket().reply(socket().ids()[1], 'b-ok');
  assert.equal(await b, 'b-ok');
  assert.equal(timers.outstanding, 0);
  transport.close();
});
