import test from 'node:test';
import assert from 'node:assert/strict';
import { cancellableFundingReads } from '../src/cancellableFundingReads.ts';
import type { CandidateReadClient } from '../src/candidateFunding.ts';

test('a stopped background identity check cannot enqueue more reads while a review continues', async () => {
  let release!: (value: number) => void;
  const first = new Promise<number>(resolve => { release = resolve; });
  const calls: string[] = [];
  const client = {
    getChainId: () => { calls.push('background:chain'); return first; },
    getCode: async () => { calls.push('code'); return '0x1234'; },
  } as unknown as CandidateReadClient;
  const controller = new AbortController();
  const background = cancellableFundingReads(client, controller.signal);
  const refresh = (async () => {
    await background.getChainId();
    await background.getCode({ address: '0x1111111111111111111111111111111111111111' });
  })();
  const rejection = assert.rejects(refresh, { name: 'AbortError' });
  controller.abort();
  // Foreground uses the original client and remains fully operational.
  assert.equal(await client.getCode({ address: '0x1111111111111111111111111111111111111111' }), '0x1234');
  release(5042);
  await rejection;
  assert.deepEqual(calls, ['background:chain', 'code']);
});

test('an active refresh preserves method context, arguments and the full read sequence', async () => {
  const calls: unknown[] = [];
  const client = {
    marker: 'original',
    async getBlock(this: { marker: string }, args: unknown) { calls.push([this.marker, args]); return { number: 9n }; },
    async readContract(args: unknown) { calls.push(args); return 7n; },
  } as unknown as CandidateReadClient;
  const wrapped = cancellableFundingReads(client, new AbortController().signal);
  assert.equal((await wrapped.getBlock({ blockNumber: 9n })).number, 9n);
  assert.equal(await wrapped.readContract({ address: '0x1111111111111111111111111111111111111111', abi: [], functionName: 'limit', blockNumber: 9n }), 7n);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['original', { blockNumber: 9n }]);
});

test('already cancelled refresh issues no RPC and an active RPC error is not hidden', async () => {
  let calls = 0;
  const client = { async getChainId() { calls++; throw Error('wrong chain endpoint'); } } as unknown as CandidateReadClient;
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(cancellableFundingReads(client, stopped.signal).getChainId(), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(cancellableFundingReads(client, new AbortController().signal).getChainId(), /wrong chain endpoint/);
  assert.equal(calls, 1);
});
