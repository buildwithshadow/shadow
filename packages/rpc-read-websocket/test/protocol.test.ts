import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED_METHODS, RemoteRpcError, ReadonlyTransportError, createReadonlyTransport } from '../src/transport.ts';
import { FAKE_URL, FakeSocket, ManualTimers, SECRET, factory, tick } from './fakes.ts';
import { expectReason, rejection, setup } from './helpers.ts';

// UNIT TESTS OF THE TRANSPORT ONLY, against a fake socket and a hand-driven clock.
// They say nothing about a real provider, Cloudflare, or the completeness of any monitor.

test('allows exactly the seven read methods and sends them with unique ids', async () => {
  const { transport, socket } = setup();
  assert.deepEqual([...ALLOWED_METHODS].sort(), ['eth_call', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
  const calls = ALLOWED_METHODS.map(method => transport.request({ method, params: [] }));
  await tick();
  assert.deepEqual(socket().methods(), [...ALLOWED_METHODS]);
  const ids = socket().ids();
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach((id, i) => socket().reply(id, `r${i}`));
  assert.deepEqual(await Promise.all(calls), ALLOWED_METHODS.map((_, i) => `r${i}`));
  transport.close();
});

test('every other method is rejected before a socket exists or anything is sent', async () => {
  const { transport, f } = setup();
  const rejected = [
    'eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'eth_subscribe', 'eth_unsubscribe',
    'eth_accounts', 'eth_requestAccounts', 'eth_estimateGas', 'eth_getBalance', 'eth_blockNumber', 'eth_getStorageAt', 'eth_newFilter', 'eth_getLogs ',
    'ETH_CALL', 'eth_call\n', ' eth_call', 'debug_traceTransaction', 'wallet_switchEthereumChain', 'net_version', 'web3_clientVersion',
    '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'eth_call,eth_sendRawTransaction',
  ];
  for (const method of rejected) await expectReason(transport.request({ method, params: [] }), 'method-not-allowed', false);
  for (const bad of [undefined, null, 5, {}, ['eth_call'], Symbol('x')]) {
    await expectReason(transport.request({ method: bad as unknown as string }), 'method-not-allowed', false);
  }
  await expectReason(transport.request(undefined as never), 'method-not-allowed', false);
  assert.equal(f.calls(), 0, 'the socket factory was never called');
  assert.equal(transport.stats().timers, 0);
  transport.close();
});

test('invalid parameters and oversize requests are refused before sending', async () => {
  const { transport, f, socket } = setup({ maxRequestBytes: 200 });
  const first = transport.request({ method: 'eth_chainId' }); // params default to []
  await tick();
  assert.equal(socket().sent.length, 1);
  assert.match(socket().sent[0], /"params":\[\]/);
  for (const params of ['0x1', { a: 1 }, 5, null]) await expectReason(transport.request({ method: 'eth_call', params }), 'invalid-request', false).catch(() => undefined);
  await expectReason(transport.request({ method: 'eth_call', params: [10n] }), 'invalid-request', false); // not JSON serialisable
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  await expectReason(transport.request({ method: 'eth_call', params: cyclic }), 'invalid-request', false);
  await expectReason(transport.request({ method: 'eth_call', params: ['x'.repeat(300)] }), 'request-too-large', false);
  await expectReason(transport.request({ method: 'eth_call', params: ['é'.repeat(100)] }), 'request-too-large', false); // bytes, not characters
  assert.equal(socket().sent.length, 1);
  assert.equal(f.calls(), 1);
  socket().reply(socket().ids()[0], '0x1');
  await first;
  transport.close();
});

test('sequential reads reuse one socket', async () => {
  const { transport, f, socket } = setup();
  for (let i = 0; i < 25; i++) {
    const p = transport.request({ method: 'eth_chainId' });
    await tick();
    socket().reply(socket().ids()[i], `0x${i}`);
    assert.equal(await p, `0x${i}`);
  }
  assert.equal(f.calls(), 1);
  assert.equal(transport.stats().epoch, 1);
  assert.equal(new Set(socket().ids()).size, 25);
  transport.close();
});

test('concurrent requests resolve to their own replies when answered out of order', async () => {
  const { transport, socket } = setup();
  const calls = [0, 1, 2, 3, 4].map(i => transport.request({ method: 'eth_getCode', params: [`0x${i}`] }));
  await tick();
  const ids = socket().ids();
  for (const i of [3, 0, 4, 1, 2]) socket().reply(ids[i], `answer-${i}`);
  assert.deepEqual(await Promise.all(calls), ['answer-0', 'answer-1', 'answer-2', 'answer-3', 'answer-4']);
  assert.equal(transport.stats().pending, 0);
  transport.close();
});

test('unknown, duplicate, mistyped and unrelated replies never satisfy another request', async () => {
  const { transport, socket } = setup();
  const a = transport.request({ method: 'eth_chainId' });
  const b = transport.request({ method: 'eth_getCode', params: ['0xabc'] });
  await tick();
  const [ida, idb] = socket().ids();
  socket().reply(9999, 'stranger');                                                              // unknown id
  socket().receive(JSON.stringify({ jsonrpc: '2.0', id: String(idb), result: 'string-id' }));    // "2" is not 2
  socket().receive(JSON.stringify({ jsonrpc: '2.0', id: null, result: 'null-id' }));
  socket().receive(JSON.stringify({ jsonrpc: '2.0', result: 'no-id' }));
  socket().receive(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0x1', result: {} } }));
  socket().reply(ida, 'for-a');
  socket().reply(ida, 'duplicate-for-a');                                                        // second reply for a settled id
  assert.equal(await a, 'for-a');
  assert.equal(transport.stats().pending, 1, 'b is still waiting: nothing above satisfied it');
  socket().reply(idb, 'for-b');
  assert.equal(await b, 'for-b');
  assert.ok(transport.stats().unmatchedReplies >= 4);
  assert.equal(transport.stats().lateReplies, 1);
  transport.close();
});

test('a flood of unmatched replies is treated as a hostile connection', async () => {
  const { transport, socket } = setup({ maxUnmatchedReplies: 3 });
  const p = transport.request({ method: 'eth_chainId' });
  await tick();
  for (let i = 0; i < 4; i++) socket().reply(5000 + i, 'noise');
  await expectReason(p, 'protocol-error', true);
  assert.equal(socket().readyState, 3);
  transport.close();
});

test('reply version, shape and error objects are validated against the matching id', async () => {
  const { transport, socket } = setup();
  const cases: Array<[string, unknown]> = [
    ['wrong version', { jsonrpc: '1.0', result: 'x' }],
    ['missing version', { result: 'x' }],
    ['neither result nor error', { jsonrpc: '2.0' }],
    ['both result and error', { jsonrpc: '2.0', result: 'x', error: { code: 1, message: 'm' } }],
    ['error without code', { jsonrpc: '2.0', error: { message: 'm' } }],
    ['error with string code', { jsonrpc: '2.0', error: { code: '1', message: 'm' } }],
    ['error without message', { jsonrpc: '2.0', error: { code: 1 } }],
    ['error not an object', { jsonrpc: '2.0', error: 'boom' }],
  ];
  for (const [label, body] of cases) {
    const p = transport.request({ method: 'eth_chainId' });
    await tick();
    const id = socket().ids().at(-1)!;
    socket().receive(JSON.stringify({ ...(body as object), id }));
    await expectReason(p, 'protocol-error', true).catch(e => { throw new Error(`${label}: ${String(e)}`); });
    socket().reply(id, 'late-valid'); // the real reply arrives afterwards and is ignored
  }
  const ok = transport.request({ method: 'eth_getTransactionByHash', params: ['0x1'] });
  await tick();
  socket().reply(socket().ids().at(-1)!, null); // null is a legitimate result
  assert.equal(await ok, null);
  assert.equal(socket().readyState, 1, 'a bad reply for one request does not tear down the connection');
  transport.close();
});

test('remote JSON-RPC errors are distinct from local ones and expose only the code and a locally written description', async () => {
  const { transport, socket } = setup();
  const p = transport.request({ method: 'eth_call', params: [{}, 'latest'] });
  await tick();
  socket().remoteError(socket().ids()[0], -32000,
    `bad key for wss://rpc.example.invalid/v2/${SECRET} and https://x.invalid/?k=${SECRET} and WS://UP.invalid/${SECRET}\nline`, `0xdeadbeef ${FAKE_URL}`);
  const e = await p.catch((x: unknown) => x);
  assert.ok(e instanceof RemoteRpcError);
  assert.equal(e.code, -32000);
  assert.equal(e.remote, true);
  assert.ok(!(e instanceof ReadonlyTransportError));
  assert.equal(e.message, 'remote JSON-RPC error -32000: server error');
  assert.equal(e.data, undefined, 'data that is not well-formed hex is dropped, not scrubbed');
  const text = JSON.stringify({ m: e.message, d: e.data, s: e.stack, n: e.name });
  assert.ok(!text.includes(SECRET) && !text.includes('example.invalid') && !text.includes('UP.invalid'), text);
  transport.close();
});

test('local errors are generic: a factory failure, socket errors and send failures never leak the endpoint', async () => {
  const throwing = createReadonlyTransport({ connect: () => { throw new Error(`cannot reach ${FAKE_URL}`); }, timers: new ManualTimers(), connectAttempts: 2 });
  const e1 = await rejection(throwing.request({ method: 'eth_chainId' }));
  assert.equal(e1.reason, 'connect-failed');
  const rejecting = createReadonlyTransport({ connect: () => Promise.reject(new Error(FAKE_URL)), timers: new ManualTimers() });
  const e2 = await rejection(rejecting.request({ method: 'eth_chainId' }));

  const { transport, socket } = setup();
  const p = transport.request({ method: 'eth_chainId' });
  await tick();
  socket().fail(); // the error event carries the URL in its payload
  const e3 = await rejection(p);
  assert.equal(e3.reason, 'connection-lost');
  for (const e of [e1, e2, e3]) {
    const dump = JSON.stringify({ ...e, message: e.message, name: e.name, stack: e.stack, cause: (e as { cause?: unknown }).cause, str: String(e) });
    assert.ok(!dump.includes(SECRET) && !dump.includes('example.invalid'), dump);
    assert.equal((e as { cause?: unknown }).cause, undefined, 'no cause chain is attached');
  }
  transport.close(); throwing.close(); rejecting.close();
});

test('options are validated and creating a transport opens nothing', () => {
  const connect = () => new FakeSocket();
  for (const bad of [{ maxPending: 0 }, { maxMessageBytes: -1 }, { requestTimeoutMs: 1.5 }, { connectTimeoutMs: NaN }, { connectAttempts: 0 }]) {
    assert.throws(() => createReadonlyTransport({ connect, ...bad }), RangeError);
  }
  const f = factory();
  const t = createReadonlyTransport({ connect: f.connect, timers: new ManualTimers() });
  assert.equal(f.calls(), 0);
  t.close();
});
