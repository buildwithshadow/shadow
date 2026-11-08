import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_REMOTE_DATA_CHARS, RemoteRpcError } from '../src/transport.ts';
import { FAKE_URL, SECRET, tick } from './fakes.ts';
import { setup } from './helpers.ts';

// Remote error text is never surfaced. These tests pin that, rather than a list of secret shapes.

async function remoteFailure(method: string, code: number, message: unknown, data?: unknown): Promise<RemoteRpcError> {
  const { transport, socket } = setup();
  const p = transport.request({ method, params: [] });
  await tick();
  socket().receive(JSON.stringify({ jsonrpc: '2.0', id: socket().ids()[0], error: { code, message, ...(data === undefined ? {} : { data }) } }));
  const e = await p.catch((x: unknown) => x);
  transport.close();
  assert.ok(e instanceof RemoteRpcError, `expected a RemoteRpcError, got ${String(e)}`);
  return e;
}

const dump = (e: RemoteRpcError) => JSON.stringify({ ...e, m: e.message, s: e.stack, n: e.name, str: String(e) });

test('a secret in ANY shape inside the remote message never reaches the error', async () => {
  const shapes = [
    `invalid api key ${SECRET}`,                                  // bare key, no URL around it
    `Authorization: Bearer ${SECRET}`,
    `rpc.example.invalid/v2/${SECRET} refused`,                   // host and path without a scheme
    `tenant=acme-prod key=${SECRET} ip=203.0.113.9`,
    `wss://rpc.example.invalid/v2/${SECRET}`,
    Buffer.from(SECRET).toString('base64'),
    Buffer.from(SECRET).toString('hex'),
    SECRET.split('').join(' '),                                   // split up so no substring survives
    `${'A'.repeat(5000)}${SECRET}`,
    `\u001b[31m${SECRET}\u0000`,
  ];
  for (const message of shapes) {
    const e = await remoteFailure('eth_getCode', -32000, message);
    assert.equal(e.message, 'remote JSON-RPC error -32000: server error', 'fixed text, independent of the remote message');
    const text = dump(e);
    assert.ok(!text.includes(SECRET) && !text.includes('example.invalid') && !text.includes('203.0.113.9') && !text.includes('acme-prod'), text);
    assert.ok(!text.includes(Buffer.from(SECRET).toString('base64')) && !text.includes(Buffer.from(SECRET).toString('hex')), text);
    assert.equal(e.data, undefined);
  }
});

test('descriptions come from the numeric code only', async () => {
  const table: Array<[number, string]> = [
    [-32700, 'parse error'], [-32600, 'invalid request'], [-32601, 'method not found'], [-32602, 'invalid params'],
    [-32603, 'internal error'], [-32005, 'limit exceeded'], [3, 'execution reverted'], [-32000, 'server error'],
    [-32099, 'server error'], [-32100, 'remote error'], [429, 'remote error'], [-1, 'remote error'], [12345, 'remote error'],
  ];
  for (const [code, text] of table) {
    const e = await remoteFailure('eth_chainId', code, `leaks ${SECRET}`);
    assert.equal(e.code, code);
    assert.equal(e.message, `remote JSON-RPC error ${code}: ${text}`);
  }
});

test('only well-formed hex revert data from eth_call is kept, and it is bounded', async () => {
  const kept = await remoteFailure('eth_call', 3, 'execution reverted', '0x08c379a0abcdef');
  assert.equal(kept.data, '0x08c379a0abcdef');
  assert.equal((await remoteFailure('eth_call', 3, 'm', '0x')).data, '0x');

  const dropped: unknown[] = [
    `0xdeadbeef ${FAKE_URL}`, `0x${Buffer.from(SECRET).toString('hex')}zz`, '0xabc', 'deadbeef', `key ${SECRET}`, '',
    `0x${'ab'.repeat(MAX_REMOTE_DATA_CHARS)}`, { secret: SECRET }, [SECRET], 5, null, true,
  ];
  for (const data of dropped) {
    const e = await remoteFailure('eth_call', 3, 'm', data);
    assert.equal(e.data, undefined, `dropped: ${String(JSON.stringify(data)).slice(0, 40)}`);
    assert.ok(!dump(e).includes(SECRET));
  }
  // Right at the bound is kept; it is a size limit, not truncation.
  const edge = `0x${'ab'.repeat((MAX_REMOTE_DATA_CHARS - 2) / 2)}`;
  assert.equal((await remoteFailure('eth_call', 3, 'm', edge)).data, edge);
});

test('data is only kept for eth_call, where it is revert data', async () => {
  for (const method of ['eth_chainId', 'eth_getCode', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']) {
    assert.equal((await remoteFailure(method, -32000, 'm', '0xdeadbeef')).data, undefined, method);
  }
});

test('REVIEW FINDING: the supplied scrubUrls pattern (https?:// only) leaves ws/wss endpoints visible, so no pattern is relied on', () => {
  // Literal copy of the pattern in the supplied float-mainnet-format.mjs scrubUrls, for comparison only.
  const suppliedPattern = /https?:\/\/[^\s"'<>]+/g;
  const message = `WebSocket connection to wss://rpc.example.invalid/v2/${SECRET} failed`;
  assert.equal(message.replace(suppliedPattern, '[matched]'), message, 'wss:// is not matched, so nothing would be redacted');
});
