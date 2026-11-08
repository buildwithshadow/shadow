import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom } from 'viem';
import { ReadonlyTransportError, RemoteRpcError, createReadonlyTransport } from '../src/transport.ts';
import { readonlyViemTransport } from '../src/viem.ts';
import { SECRET } from './fakes.ts';
import { DROP, LOSE_CONNECTION, RemoteFailure, scriptedFactory, type Script } from './scripted.ts';
import { within } from './helpers.ts';

// Does viem replay a failed read? Real viem 2.57.5 against a scripted fake server, real (short) timers,
// every test bounded. No network and no provider.
const BOUND = { timeout: 8000 };
const FAST = { retryDelay: 1 }; // viem backs off 150ms * 2^n by default; shortened only so replays show up quickly

function rig(handler: Script, requestTimeoutMs = 2000) {
  const f = scriptedFactory(handler);
  const transport = createReadonlyTransport({ connect: f.connect, requestTimeoutMs });
  return { f, transport };
}

test('premise: viem replays any error that has no numeric code (this is why local errors carry one)', BOUND, async () => {
  let calls = 0;
  const bare = createPublicClient({ transport: custom({ request: () => { calls++; return Promise.reject(new Error('boom')); } }, { retryCount: 3, ...FAST }) });
  await within(bare.getChainId().catch(() => undefined), 'viem gives up');
  assert.equal(calls, 4, 'one call plus three retries');
});

test('local failures after a send are never replayed by viem, even with viem defaults', BOUND, async () => {
  for (const [label, handler, timeout] of [
    ['connection lost after send', (() => LOSE_CONNECTION) as Script, 2000],
    ['request timeout', (() => DROP) as Script, 40],
  ] as const) {
    const { f, transport } = rig(handler, timeout);
    const client = createPublicClient({ transport: custom(transport, FAST) }); // viem's default retryCount (3)
    await within(client.getChainId().then(() => assert.fail('expected a rejection'), (e: Error) => e), label);
    await new Promise(r => setTimeout(r, 30)); // time for any (unwanted) retry to arrive
    assert.equal(f.totalRequests(), 1, `${label}: exactly one request reached any socket`);
    transport.close();
  }
});

test('local error codes are non-retryable for viem and typed', () => {
  const codes = new Map<string, number>();
  for (const reason of ['method-not-allowed', 'invalid-request', 'request-too-large', 'too-many-pending', 'connect-failed', 'connect-timeout', 'request-timeout', 'aborted', 'closed', 'connection-lost', 'protocol-error', 'message-too-large', 'send-failed'] as const) {
    codes.set(reason, new ReadonlyTransportError(reason).code);
  }
  for (const [reason, code] of codes) assert.ok(Number.isInteger(code) && ![-1, -32603, -32005, 429, -32007].includes(code), `${reason} -> ${code}`);
});

test('a remote -32603 IS replayed by plain custom() but not through the read-only adapter, even with a per-call override', BOUND, async () => {
  const handler: Script = () => new RemoteFailure(-32603, `internal error for ${SECRET}`);

  const plain = rig(handler);
  await within(createPublicClient({ transport: custom(plain.transport, FAST) }).getChainId().catch(() => undefined), 'plain viem gives up');
  assert.ok(plain.f.totalRequests() > 1, `plain custom() sent ${plain.f.totalRequests()} copies of one read`);
  plain.transport.close();

  const safe = rig(handler);
  const client = createPublicClient({ transport: readonlyViemTransport(safe.transport) });
  await within(client.getChainId().catch(() => undefined), 'adapter, default options');
  assert.equal(safe.f.totalRequests(), 1);
  await within(client.request({ method: 'eth_chainId' }, { retryCount: 5, retryDelay: 1 }).catch(() => undefined), 'adapter, per-call retryCount 5');
  assert.equal(safe.f.totalRequests(), 2, 'the second call sent one request, not six: the per-call override did not re-enable retries');
  safe.transport.close();
});

test('the adapter still reads, and other failure kinds are single-shot', BOUND, async () => {
  const ok = rig(m => (m.method === 'eth_chainId' ? '0x4ced52' : null));
  const client = createPublicClient({ transport: readonlyViemTransport(ok.transport) });
  assert.equal(await within(client.getChainId(), 'chain id'), 5_041_490);
  ok.transport.close();

  for (const [label, handler] of [['limit exceeded', (() => new RemoteFailure(-32005, 'slow down')) as Script], ['unknown -1', (() => new RemoteFailure(-1, 'x')) as Script]] as const) {
    const r = rig(handler);
    await within(createPublicClient({ transport: readonlyViemTransport(r.transport) }).getChainId().catch(() => undefined), label);
    assert.equal(r.f.totalRequests(), 1, label);
    r.transport.close();
  }
});

test('a forbidden method is refused before the wire, through viem, with a non-retryable error', BOUND, async () => {
  const { f, transport } = rig(() => '0x1');
  const client = createPublicClient({ transport: custom(transport, FAST) }) as unknown as { request(a: { method: string; params: unknown[] }): Promise<unknown> };
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign']) {
    const e = await within(client.request({ method, params: ['0x00'] }).then(() => assert.fail('expected a rejection'), (x: Error) => x), method);
    assert.match(`${e.message} ${(e as { details?: string }).details ?? ''}`, /not allowed/);
  }
  assert.equal(f.sockets.length, 0, 'no connection was even opened');
  transport.close();
});

test('a revert keeps its hex data for viem, and no remote text reaches any error in the chain', BOUND, async () => {
  const revert = '0x08c379a0' + '00'.repeat(64);
  const { transport } = rig(() => new RemoteFailure(3, `execution reverted: ${SECRET} wss://rpc.example.invalid/${SECRET}`, revert));
  const client = createPublicClient({ transport: readonlyViemTransport(transport) });
  const error = await within(client.call({ to: '0x00000000000000000000000000000000000000a1', data: '0x1234' }).then(() => assert.fail('expected a revert'), (e: Error) => e), 'revert');
  const chain: Error[] = [];
  for (let e: unknown = error; e instanceof Error && chain.length < 10; e = (e as { cause?: unknown }).cause) chain.push(e);
  const remote = chain.find((e): e is RemoteRpcError => e instanceof RemoteRpcError);
  assert.ok(remote, 'the original RemoteRpcError is in the cause chain');
  assert.equal(remote.code, 3);
  assert.equal(remote.data, revert);
  const text = chain.map(e => `${e.name} ${e.message} ${String((e as { details?: unknown }).details ?? '')} ${e.stack ?? ''}`).join('\n');
  assert.ok(!text.includes(SECRET) && !text.includes('example.invalid'), 'no remote message text anywhere in the error chain');
  transport.close();
});
