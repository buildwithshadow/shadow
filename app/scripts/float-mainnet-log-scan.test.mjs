import assert from "node:assert/strict";
import test from "node:test";
import { findLatestLog, findLogs } from "./float-mainnet-cli.mjs";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const DIGEST = `0x${"12".repeat(32)}`;
const args = { digest: DIGEST };
const limitError = (details) => Object.assign(new Error("Request exceeds defined limit."), {
  shortMessage: "Request exceeds defined limit.", code: -32005, details,
});

function scanner({ limit = 5_000n, blocks = [], fail = () => null } = {}) {
  const requests = [];
  const successful = [];
  const connection = { address: ADDRESS, client: { getLogs: async (request) => {
    const { fromBlock: from, toBlock: to } = request;
    assert.equal(request.address, ADDRESS);
    assert.equal(request.event.name, "ProviderPaid");
    assert.deepEqual(request.args, args);
    requests.push([from, to]);
    const failure = fail(from, to);
    if (failure) throw failure;
    if (to - from + 1n > limit) throw limitError(`block range exceeds maximum of ${limit} blocks`);
    successful.push([from, to]);
    return blocks.filter((block) => from <= block && block <= to).map((blockNumber) => ({ blockNumber, blockHash: `canonical-${blockNumber}` }));
  } } };
  return { connection, requests, successful };
}

test("shrinks explicit log range limits, preserving every boundary and canonical log identity", async () => {
  const blocks = [0n, 624n, 625n, 999n, 1249n, 1250n, 4999n, 5000n, 10_002n];
  const scan = scanner({ limit: 1_000n, blocks });
  const result = await findLogs(scan.connection, "ProviderPaid", args, 0n, 10_002n);
  assert.deepEqual(result, blocks.map((blockNumber) => ({ blockNumber, blockHash: `canonical-${blockNumber}` })));
  assert.deepEqual(scan.requests.slice(0, 4), [[0n, 4999n], [0n, 2499n], [0n, 1249n], [0n, 624n]]);
  assert.equal(scan.successful[0][0], 0n);
  assert.equal(scan.successful.at(-1)[1], 10_002n);
  for (let i = 1; i < scan.successful.length; i++) assert.equal(scan.successful[i][0], scan.successful[i - 1][1] + 1n);
});

test("latest-log scan shrinks backwards and stops at the newest matching batch", async () => {
  const scan = scanner({ limit: 1_000n, blocks: [100n, 4375n, 5000n, 5625n] });
  const found = await findLatestLog(scan.connection, "ProviderPaid", args, { fromBlock: 0n, toBlock: 10_000n });
  assert.equal(found.log.blockNumber, 5625n);
  assert.deepEqual([found.fromBlock, found.toBlock], [0n, 10_000n]);
  assert.deepEqual(scan.requests.slice(0, 4), [[5001n, 10000n], [7501n, 10000n], [8751n, 10000n], [9376n, 10000n]]);
  for (let i = 1; i < scan.successful.length; i++) assert.equal(scan.successful[i][1], scan.successful[i - 1][0] - 1n);
  assert.ok(scan.successful.at(-1)[0] <= 5625n && scan.successful.at(-1)[1] >= 5625n);
});

test("result-size limits are split only when explicit; quota and ambiguous -32005 errors never multiply requests", async () => {
  const resultScan = scanner({ fail: (from, to) => to - from >= 3n ? limitError("query returned more than 10000 results") : null });
  assert.deepEqual(await findLogs(resultScan.connection, "ProviderPaid", args, 0n, 5n), []);
  assert.deepEqual(resultScan.successful, [[0n, 2n], [3n, 5n]]);

  for (const details of [undefined, "request limit reached", "rate limit for eth_getLogs block range requests", "HTTP 429 too many requests", "API quota exhausted", "invalid argument"]) {
    const scan = scanner({ fail: () => limitError(details) });
    await assert.rejects(findLogs(scan.connection, "ProviderPaid", args, 0n, 5_000n), /log scan incomplete at blocks 0-4999/);
    assert.equal(scan.requests.length, 1, String(details));
  }
});

test("nested provider errors identify range limits, while nested quota details take precedence", async () => {
  const nested = scanner({ fail: (from, to) => to - from >= 3n
    ? Object.assign(new Error("RPC error"), { cause: limitError("block range is too large") }) : null });
  assert.deepEqual(await findLogs(nested.connection, "ProviderPaid", args, 0n, 5n), []);
  assert.deepEqual(nested.successful, [[0n, 2n], [3n, 5n]]);

  const quota = scanner({ fail: () => Object.assign(limitError("block range limit"), { cause: new Error("rate limit reached") }) });
  await assert.rejects(findLogs(quota.connection, "ProviderPaid", args, 0n, 5n), /log scan incomplete/);
  assert.equal(quota.requests.length, 1);
});

test("a failed later interval rejects the whole scan and exposes sanitized node detail", async () => {
  const scan = scanner({ blocks: [0n], fail: (from) => from >= 5_000n ? limitError("quota reached at https://user:password@rpc.example/private-key?token=secret") : null });
  await assert.rejects(findLogs(scan.connection, "ProviderPaid", args, 0n, 6_000n), (error) => {
    assert.match(error.message, /log scan incomplete at blocks 5000-6000/);
    assert.match(error.message, /RPC said: quota reached at https:\/\/rpc.example\/\[redacted\]/);
    assert.doesNotMatch(error.message, /password|private-key|secret/);
    return true;
  });
  assert.equal(scan.successful.length, 1);
  assert.equal(scan.requests.length, 2);
});

test("an unsplittable block fails closed, and a one-block-only provider cannot exhaust the process", async () => {
  const single = scanner({ fail: () => limitError("log response size exceeded") });
  await assert.rejects(findLogs(single.connection, "ProviderPaid", args, 0n, 4_999n), /log scan incomplete at blocks 0-0/);
  assert.ok(single.requests.length <= 14);

  const restrictive = scanner({ limit: 1n });
  await assert.rejects(findLogs(restrictive.connection, "ProviderPaid", args, 0n, 4_999n), /bounded request budget exhausted after 32 requests/);
  assert.equal(restrictive.requests.length, 32);
});
