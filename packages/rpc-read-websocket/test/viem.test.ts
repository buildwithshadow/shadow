import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom } from 'viem';
import { createReadonlyTransport } from '../src/transport.ts';
import { FakeSocket } from './fakes.ts';

// viem compatibility, against a scripted fake server. No network, no provider.

class ScriptedSocket extends FakeSocket {
  readonly requests: Array<{ id: number; method: string }> = [];
  handler: (m: { id: number; method: string; params: unknown[] }) => unknown = () => '0x1';
  constructor() { super(); this.readyState = 1; }
  override send(data: string): void {
    super.send(data);
    const m = JSON.parse(data) as { id: number; method: string; params: unknown[] };
    this.requests.push({ id: m.id, method: m.method });
    queueMicrotask(() => {
      const out = this.handler(m);
      if (out instanceof Error) this.remoteError(m.id, -32603, out.message);
      else this.reply(m.id, out);
    });
  }
}

function harness(retry: { retryCount: number; retryDelay?: number }) {
  const socket = new ScriptedSocket();
  const transport = createReadonlyTransport({ connect: () => socket, requestTimeoutMs: 2000 });
  const client = createPublicClient({ transport: custom(transport, retry) });
  return { socket, transport, client };
}

test('viem custom() reads through the transport on one socket', async () => {
  const { socket, transport, client } = harness({ retryCount: 0 });
  socket.handler = m => (m.method === 'eth_chainId' ? '0x4ced52' : m.method === 'eth_getCode' ? '0x6001' : null);
  assert.equal(await client.getChainId(), 5_041_490);
  assert.equal(await client.getCode({ address: '0x00000000000000000000000000000000000000a1' }), '0x6001');
  assert.deepEqual(socket.requests.map(r => r.method), ['eth_chainId', 'eth_getCode']);
  transport.close();
});

test('viem cannot push a mutation through it', async () => {
  const { socket, transport, client } = harness({ retryCount: 0 });
  const raw = client as unknown as { request(a: { method: string; params: unknown[] }): Promise<unknown> };
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign']) {
    await assert.rejects(raw.request({ method, params: ['0x00'] }), (e: Error) => /not allowed/.test(`${e.message} ${(e as { details?: string }).details ?? ''}`));
  }
  assert.equal(socket.requests.length, 0);
  transport.close();
});

test('replay hazard: viem with retries enabled re-sends a failed read; retryCount 0 does not', async () => {
  const failing = (): ReturnType<typeof harness> => {
    const h = harness({ retryCount: 0 });
    h.socket.handler = () => new Error('internal');
    return h;
  };
  const off = failing();
  await assert.rejects(off.client.getChainId());
  assert.equal(off.socket.requests.length, 1, 'exactly one send with retryCount: 0');
  off.transport.close();

  const socket = new ScriptedSocket();
  socket.handler = () => new Error('internal');
  const transport = createReadonlyTransport({ connect: () => socket, requestTimeoutMs: 2000 });
  const retrying = createPublicClient({ transport: custom(transport, { retryCount: 3, retryDelay: 1 }) });
  await assert.rejects(retrying.getChainId());
  assert.ok(socket.requests.length > 1, `viem re-sent the same read ${socket.requests.length} times; integrations must use retryCount: 0`);
  assert.equal(new Set(socket.requests.map(r => r.id)).size, socket.requests.length, 'each resend is a new id, never a reused one');
  transport.close();
});
