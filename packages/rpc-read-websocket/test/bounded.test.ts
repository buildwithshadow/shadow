import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectReason, setup, within } from './helpers.ts';

// The failure the supervisor hit: a request that nobody answers, on a hand-driven clock that nobody advances,
// waits forever. Every test now runs under a real node:test timeout (see package.json) and awaits like this
// can name what they were waiting for.
test('an unanswered request on a manual clock fails by name within a real bound instead of hanging', { timeout: 5000 }, async () => {
  const { transport, timers } = setup(); // socket opens, no reply is ever sent, the manual clock is never advanced
  const unanswered = transport.request({ method: 'eth_chainId' });
  await assert.rejects(within(unanswered, 'eth_chainId reply', 50), /timed out after 50ms waiting for: eth_chainId reply/);
  assert.equal(timers.outstanding, 1, 'its request deadline is still pending on the manual clock');
  timers.advance(30_000); // the way to finish it deterministically
  await expectReason(unanswered, 'request-timeout', true);
  assert.equal(timers.outstanding, 0);
  transport.close();
});
