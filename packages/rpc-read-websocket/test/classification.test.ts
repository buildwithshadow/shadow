import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { createReadonlyTransport, RemoteRpcError } from '../src/transport.ts';
import { factory, tick, SECRET } from './fakes.ts';

test('wire errors retain only safe behavioral classification before discarding text', async () => {
  for (const [code, message, details] of [
    [-32005,'block range exceeds provider maximum','block range exceeds maximum'],
    [-32603,'pruned history unavailable','RPC request failed'],
    [-32603,'internal error','RPC temporarily unavailable'],
    [-32005,'rate limit exceeded','RPC temporarily unavailable'],
    [-32603,'internal error: unknown historical failure','RPC request failed'],
  ] as const) {
    const f=factory(true);const transport=createReadonlyTransport({connect:f.connect});
    const result=transport.request({method:'eth_getLogs',params:[{}]}).catch(error=>error);
    await tick();const socket=f.sockets[0];
    socket.remoteError(socket.ids()[0],code,`${message} wss://rpc.invalid/${SECRET}`);
    const error=await result;
    assert.ok(error instanceof RemoteRpcError);
    // The exact internal-backend message is intentionally narrow: adding any
    // suffix changes that classification, as it does in the existing queue.
    const expected=message==='internal error'?'RPC request failed':details;
    assert.equal(error.details,expected);
    assert.doesNotMatch(inspect(error,{depth:10}),new RegExp(SECRET));
    transport.close();
  }
});
