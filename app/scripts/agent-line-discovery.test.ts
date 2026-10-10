import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hash } from "viem";
import {
  AGENT_LINE_DISCOVERY_CHUNK_BLOCKS,
  MAX_AGENT_LINE_DISCOVERY_REQUESTS,
  MAX_AGENT_LINE_DISCOVERY_RESULTS,
  discoverAgentLineIds,
  parseAgentLineLogs,
  type AgentLineDiscoveryClient,
  type AgentLineOpenedLog,
} from "../src/agentLineDiscovery.ts";
import {
  getAgentLineDiscoveryContinuationCursor,
  hasResumableDiscoveryProgress,
  mergeAgentLineDiscoveryCache,
  refreshAgentLineDiscoveryPage,
  type AgentLineDiscoveryCache,
} from "../src/agentLineDiscoveryCache.ts";

const contract = "0x1111111111111111111111111111111111111111" as Address;
const agent = "0x2222222222222222222222222222222222222222" as Address;
const otherAgent = "0x3333333333333333333333333333333333333333" as Address;
const lineId = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hash;
const activeDiscovery = { isActive: () => true };

function openedLog(id: Hash, blockNumber: bigint, logIndex: number, forAgent = agent): AgentLineOpenedLog {
  return { args: { lineId: id, agent: forAgent }, blockNumber, logIndex };
}

test("parses only the requested agent's valid line IDs, newest first, without duplicates", () => {
  assert.deepEqual(parseAgentLineLogs([
    openedLog(lineId(1), 10n, 0),
    openedLog(lineId(2), 12n, 0),
    openedLog(lineId(1), 11n, 1),
    openedLog(lineId(3), 13n, 0, otherAgent),
    { args: { lineId: "0x1234" as Hash, agent }, blockNumber: 14n, logIndex: 0 },
    openedLog(lineId(4), 12n, 2),
  ], agent), [lineId(4), lineId(2), lineId(1)]);
});

test("scans newest chunks first and carries extra matches beyond the ten-line page in its cursor", async () => {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const progress: { searchedBlocks: bigint; totalBlocks: bigint }[] = [];
  const client = {
    getBlockNumber: async () => 12_345n,
    getLogs: async ({ address, args, fromBlock, toBlock }: { address?: Address; args?: { agent?: Address }; fromBlock: bigint; toBlock: bigint }) => {
      assert.equal(address, contract);
      assert.equal(args?.agent?.toLowerCase(), agent.toLowerCase());
      ranges.push({ fromBlock, toBlock });
      return fromBlock === 7_346n ? Array.from({ length: MAX_AGENT_LINE_DISCOVERY_RESULTS + 2 }, (_, index) =>
        openedLog(lineId(index + 1), 12_300n - BigInt(index), index)) : [];
    },
  } as unknown as AgentLineDiscoveryClient;

  const first = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, {
    ...activeDiscovery,
    onProgress: value => progress.push(value),
  });

  assert.deepEqual(first.lineIds, Array.from({ length: MAX_AGENT_LINE_DISCOVERY_RESULTS }, (_, index) => lineId(index + 1)));
  assert.notEqual(first.cursor, null);
  assert.deepEqual(first.cursor?.pendingLineIds, [lineId(11), lineId(12)]);
  assert.equal(first.headBlock, 12_345n);
  assert.deepEqual(ranges, [{ fromBlock: 7_346n, toBlock: 12_345n }]);
  assert.ok(ranges.every(({ fromBlock, toBlock }) => toBlock - fromBlock + 1n <= AGENT_LINE_DISCOVERY_CHUNK_BLOCKS));
  assert.deepEqual(progress, [
    { searchedBlocks: 0n, totalBlocks: 12_345n },
    { searchedBlocks: 5_000n, totalBlocks: 12_345n },
  ]);

  const continued = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, {
    ...activeDiscovery,
    cursor: first.cursor!,
  });

  assert.deepEqual(continued.lineIds, [lineId(11), lineId(12)]);
  assert.equal(continued.cursor, null);
  assert.deepEqual(ranges.slice(1), [
    { fromBlock: 2_346n, toBlock: 7_345n },
    { fromBlock: 1n, toBlock: 2_345n },
  ]);
});

test("continues to older chunks when needed and orders their lines newest first", async () => {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getBlockNumber: async () => 10_001n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push({ fromBlock, toBlock });
      return fromBlock === 5_002n
        ? [openedLog(lineId(2), 8_000n, 0), openedLog(lineId(1), 9_000n, 0)]
        : fromBlock === 2n ? [openedLog(lineId(3), 4_000n, 0)] : [];
    },
  } as unknown as AgentLineDiscoveryClient;

  assert.deepEqual((await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery)).lineIds, [lineId(1), lineId(2), lineId(3)]);
  assert.deepEqual(ranges, [
    { fromBlock: 5_002n, toBlock: 10_001n },
    { fromBlock: 2n, toBlock: 5_001n },
    { fromBlock: 1n, toBlock: 1n },
  ]);
});

test("splits a request only when the RPC reports an explicit block range limit", async () => {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getBlockNumber: async () => 5_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push({ fromBlock, toBlock });
      if (ranges.length === 1) throw new Error("ranges over 10000 blocks are not supported on free plan");
      return fromBlock === 2_501n ? [openedLog(lineId(1), 4_000n, 0)] : [];
    },
  } as unknown as AgentLineDiscoveryClient;

  assert.deepEqual((await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery)).lineIds, [lineId(1)]);
  assert.deepEqual(ranges, [
    { fromBlock: 1n, toBlock: 5_000n },
    { fromBlock: 2_501n, toBlock: 5_000n },
    { fromBlock: 1n, toBlock: 2_500n },
  ]);
});

test("propagates an RPC failure so the caller can keep manual line lookup available", async () => {
  let calls = 0;
  const client: AgentLineDiscoveryClient = {
    getBlockNumber: async () => 10n,
    getLogs: async () => { calls++; throw new Error("RPC log request failed"); },
  };

  await assert.rejects(discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery), /RPC log request failed/);
  assert.equal(calls, 1);
});

test("does not split a range error when a nested cause identifies a rate limit", async () => {
  let calls = 0;
  const client: AgentLineDiscoveryClient = {
    getBlockNumber: async () => 5_000n,
    getLogs: async () => {
      calls++;
      throw Object.assign(new Error("RPC error"), { cause: Object.assign(new Error("block range is too large"), { cause: new Error("rate limit reached") }) });
    },
  };

  await assert.rejects(discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery), /RPC error/);
  assert.equal(calls, 1);
});

test("returns an empty complete search across current history within the fixed request budget", async () => {
  let calls = 0;
  const client: AgentLineDiscoveryClient = {
    getBlockNumber: async () => BigInt(MAX_AGENT_LINE_DISCOVERY_REQUESTS - 1) * AGENT_LINE_DISCOVERY_CHUNK_BLOCKS,
    getLogs: async () => {
      calls++;
      return [];
    },
  };

  const result = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery);

  assert.deepEqual(result.lineIds, []);
  assert.equal(result.cursor, null);
  assert.equal(result.searchedBlocks, result.totalBlocks);
  assert.equal(calls, MAX_AGENT_LINE_DISCOVERY_REQUESTS - 1);
});

test("returns partial matches and resumes from the continuation cursor within a fixed request budget", async () => {
  let blockNumberCalls = 0;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getBlockNumber: async () => { blockNumberCalls++; return 85_000n; },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push({ fromBlock, toBlock });
      if (fromBlock === 80_001n) return [openedLog(lineId(1), 84_000n, 0)];
      if (fromBlock === 1n) return [openedLog(lineId(2), 2_000n, 0)];
      return [];
    },
  } as unknown as AgentLineDiscoveryClient;

  const first = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery);

  assert.deepEqual(first.lineIds, [lineId(1)]);
  assert.notEqual(first.cursor, null);
  assert.equal(first.cursor?.nextBlock, 10_000n);
  assert.equal(ranges.length, MAX_AGENT_LINE_DISCOVERY_REQUESTS - 1);

  const continued = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, {
    ...activeDiscovery,
    cursor: first.cursor!,
  });

  assert.deepEqual(continued.lineIds, [lineId(2)]);
  assert.equal(continued.cursor, null);
  assert.equal(blockNumberCalls, 1);
  assert.deepEqual(ranges.slice(-2), [
    { fromBlock: 5_001n, toBlock: 10_000n },
    { fromBlock: 1n, toBlock: 5_000n },
  ]);
});

test("search again scans forward from the cached head and returns newly opened lines", async () => {
  let head = 100n;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push({ fromBlock, toBlock });
      return fromBlock === 101n ? [openedLog(lineId(2), 115n, 0)] : [openedLog(lineId(1), 90n, 0)];
    },
  } as unknown as AgentLineDiscoveryClient;

  const initial = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery);
  head = 120n;
  assert.ok(initial.headBlock !== null);
  const refreshed = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, {
    ...activeDiscovery,
    fromBlock: initial.headBlock + 1n,
  });

  assert.deepEqual(initial.lineIds, [lineId(1)]);
  assert.deepEqual(refreshed.lineIds, [lineId(2)]);
  assert.equal(refreshed.headBlock, 120n);
  assert.deepEqual(ranges, [
    { fromBlock: 1n, toBlock: 100n },
    { fromBlock: 101n, toBlock: 120n },
  ]);
});

test("search again checks blocks after an empty cached result", async () => {
  let head = 100n;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push({ fromBlock, toBlock });
      return fromBlock === 101n ? [openedLog(lineId(2), 115n, 0)] : [];
    },
  } as unknown as AgentLineDiscoveryClient;

  const initial = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery);
  head = 120n;
  assert.deepEqual(initial.lineIds, []);
  assert.equal(initial.cursor, null);
  assert.ok(initial.headBlock !== null);

  const refreshed = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, {
    ...activeDiscovery,
    fromBlock: initial.headBlock + 1n,
  });

  assert.deepEqual(refreshed.lineIds, [lineId(2)]);
  assert.deepEqual(ranges, [
    { fromBlock: 1n, toBlock: 100n },
    { fromBlock: 101n, toBlock: 120n },
  ]);
});

test("restarting a budgeted forward scan keeps the original head until its gap is searched", async () => {
  const oldHead = 100_000n;
  const firstHead = oldHead + 80_001n;
  const secondHead = firstHead + 100n;
  const deployment = { address: contract, agent, deployBlock: 1n };
  const clientAt = (headBlock: bigint): AgentLineDiscoveryClient => ({
    getBlockNumber: async () => headBlock,
    getLogs: async () => [],
  });
  const initial = mergeAgentLineDiscoveryCache("initial", undefined, {
    lineIds: [], headBlock: oldHead, cursor: null,
  });

  const first = await discoverAgentLineIds(clientAt(firstHead), deployment, {
    ...activeDiscovery,
    fromBlock: initial.headBlock + 1n,
  });
  assert.notEqual(first.cursor, null);
  assert.equal(first.searchedBlocks, 75_000n);
  assert.equal(first.cursor?.startBlock, oldHead + 1n);
  assert.ok(first.headBlock !== null);
  const afterFirst = mergeAgentLineDiscoveryCache("again", initial, {
    lineIds: first.lineIds, headBlock: first.headBlock, cursor: first.cursor,
  });

  assert.equal(afterFirst.headBlock, oldHead);
  assert.equal(afterFirst.forwardCursor?.headBlock, firstHead);

  const second = await discoverAgentLineIds(clientAt(secondHead), deployment, {
    ...activeDiscovery,
    fromBlock: afterFirst.headBlock + 1n,
  });
  assert.notEqual(second.cursor, null);
  assert.equal(second.searchedBlocks, 75_000n);
  assert.equal(second.cursor?.startBlock, oldHead + 1n);
  assert.equal(second.cursor?.headBlock, secondHead);
  assert.ok(second.headBlock !== null);
  const afterSecond = mergeAgentLineDiscoveryCache("again", afterFirst, {
    lineIds: second.lineIds, headBlock: second.headBlock, cursor: second.cursor,
  });

  assert.equal(afterSecond.headBlock, oldHead);
  assert.notEqual(afterSecond.forwardCursor, null);
});

test("continues an unfinished forward range before pending history", async () => {
  const deployment = { address: contract, agent, deployBlock: 1n };
  const historyCursor = {
    nextBlock: 25_000n,
    span: AGENT_LINE_DISCOVERY_CHUNK_BLOCKS,
    startBlock: 1n,
    headBlock: 100_000n,
    searchedBlocks: 75_000n,
    totalBlocks: 100_000n,
    pendingLineIds: [],
  };
  const initial: AgentLineDiscoveryCache = {
    lineIds: [],
    forwardWindowCount: 0,
    lines: [],
    headBlock: 100_000n,
    historyCursor,
    forwardCursor: null,
  };
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getBlockNumber: async () => 300_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push({ fromBlock, toBlock });
      return [];
    },
  } as unknown as AgentLineDiscoveryClient;

  const forwardSearch = await discoverAgentLineIds(client, deployment, {
    ...activeDiscovery,
    fromBlock: initial.headBlock + 1n,
  });
  assert.ok(forwardSearch.headBlock !== null);
  assert.ok(forwardSearch.cursor !== null);
  const bothCursors = mergeAgentLineDiscoveryCache("again", initial, {
    lineIds: forwardSearch.lineIds,
    headBlock: forwardSearch.headBlock,
    cursor: forwardSearch.cursor,
  });
  assert.strictEqual(bothCursors.historyCursor, historyCursor);
  assert.ok(bothCursors.forwardCursor !== null);
  assert.equal(ranges.length, MAX_AGENT_LINE_DISCOVERY_REQUESTS - 1);

  const forwardContinuation = getAgentLineDiscoveryContinuationCursor(bothCursors);
  assert.strictEqual(forwardContinuation, bothCursors.forwardCursor);
  const firstContinueStart = ranges.length;
  const firstContinue = await discoverAgentLineIds(client, deployment, {
    ...activeDiscovery,
    cursor: forwardContinuation!,
  });
  assert.ok(firstContinue.cursor !== null);
  assert.equal(ranges[firstContinueStart].toBlock, bothCursors.forwardCursor.nextBlock);
  const afterFirstContinue = mergeAgentLineDiscoveryCache("continue", bothCursors, {
    lineIds: firstContinue.lineIds,
    headBlock: firstContinue.headBlock!,
    cursor: firstContinue.cursor,
  });
  assert.equal(afterFirstContinue.headBlock, initial.headBlock);
  assert.strictEqual(afterFirstContinue.historyCursor, historyCursor);
  assert.ok(afterFirstContinue.forwardCursor !== null);
  assert.strictEqual(getAgentLineDiscoveryContinuationCursor(afterFirstContinue), afterFirstContinue.forwardCursor);

  const nextForwardContinuation = getAgentLineDiscoveryContinuationCursor(afterFirstContinue);
  const secondContinueStart = ranges.length;
  const secondContinue = await discoverAgentLineIds(client, deployment, {
    ...activeDiscovery,
    cursor: nextForwardContinuation!,
  });
  assert.equal(secondContinue.cursor, null);
  assert.equal(ranges[secondContinueStart].toBlock, afterFirstContinue.forwardCursor.nextBlock);
  const afterForwardComplete = mergeAgentLineDiscoveryCache("continue", afterFirstContinue, {
    lineIds: secondContinue.lineIds,
    headBlock: secondContinue.headBlock!,
    cursor: secondContinue.cursor,
  });
  assert.equal(afterForwardComplete.headBlock, 300_000n);
  assert.strictEqual(afterForwardComplete.historyCursor, historyCursor);
  assert.equal(afterForwardComplete.forwardCursor, null);
  assert.strictEqual(getAgentLineDiscoveryContinuationCursor(afterForwardComplete), historyCursor);

  const historyContinueStart = ranges.length;
  await discoverAgentLineIds(client, deployment, {
    ...activeDiscovery,
    cursor: getAgentLineDiscoveryContinuationCursor(afterForwardComplete)!,
  });
  assert.equal(ranges[historyContinueStart].toBlock, historyCursor.nextBlock);
});

test("continued forward matches stay ahead of historical matches", () => {
  const id = (digit: string) => `0x${digit.repeat(64)}` as Hash;
  const cursor = {
    nextBlock: 50_000n,
    span: AGENT_LINE_DISCOVERY_CHUNK_BLOCKS,
    startBlock: 1n,
    headBlock: 100_000n,
    searchedBlocks: 50_000n,
    totalBlocks: 100_000n,
    pendingLineIds: [],
  };
  const history = mergeAgentLineDiscoveryCache("initial", undefined, { lineIds: [id("1")], headBlock: 100_000n, cursor });
  const firstForward = mergeAgentLineDiscoveryCache("again", history, { lineIds: [id("2")], headBlock: 300_000n, cursor: { ...cursor } });
  assert.deepEqual(firstForward.lineIds, [id("2"), id("1")]);

  const secondForward = mergeAgentLineDiscoveryCache("continue", firstForward, { lineIds: [id("3")], headBlock: 300_000n, cursor: { ...cursor } });
  assert.deepEqual(secondForward.lineIds, [id("2"), id("3"), id("1")]);

  const forwardDone = mergeAgentLineDiscoveryCache("continue", secondForward, { lineIds: [id("4")], headBlock: 300_000n, cursor: null });
  assert.deepEqual(forwardDone.lineIds, [id("2"), id("3"), id("4"), id("1")]);
  assert.equal(forwardDone.forwardCursor, null);

  const nextWindow = mergeAgentLineDiscoveryCache("again", forwardDone, { lineIds: [id("5")], headBlock: 400_000n, cursor: null });
  assert.deepEqual(nextWindow.lineIds, [id("5"), id("2"), id("3"), id("4"), id("1")]);

  const olderHistory = mergeAgentLineDiscoveryCache("continue", nextWindow, { lineIds: [id("6")], headBlock: 100_000n, cursor: null });
  assert.deepEqual(olderHistory.lineIds, [id("5"), id("2"), id("3"), id("4"), id("1"), id("6")]);
});

test("a stopped scan is kept only when it searched blocks and can resume or finished its range", async () => {
  const deployment = { address: contract, agent, deployBlock: 1n };
  let active = true;
  let calls = 0;
  const stopDuringSecondChunk: AgentLineDiscoveryClient = {
    getBlockNumber: async () => 50_000n,
    getLogs: async () => { if (++calls === 2) active = false; return []; },
  };
  const midScan = await discoverAgentLineIds(stopDuringSecondChunk, deployment, { isActive: () => active });
  assert.notEqual(midScan.cursor, null);
  assert.equal(midScan.searchedBlocks, AGENT_LINE_DISCOVERY_CHUNK_BLOCKS);
  assert.equal(hasResumableDiscoveryProgress(midScan), true);

  active = true;
  const stopDuringFirstChunk: AgentLineDiscoveryClient = {
    getBlockNumber: async () => 50_000n,
    getLogs: async () => { active = false; return []; },
  };
  const noProgress = await discoverAgentLineIds(stopDuringFirstChunk, deployment, { isActive: () => active });
  assert.equal(noProgress.searchedBlocks, 0n);
  assert.equal(hasResumableDiscoveryProgress(noProgress), false);

  active = true;
  const stopBeforeLogs: AgentLineDiscoveryClient = {
    getBlockNumber: async () => { active = false; return 50_000n; },
    getLogs: async () => { throw new Error("no log request expected"); },
  };
  const beforeLogs = await discoverAgentLineIds(stopBeforeLogs, deployment, { isActive: () => active });
  assert.equal(beforeLogs.cursor, null);
  assert.equal(hasResumableDiscoveryProgress(beforeLogs), false);

  const finished = await discoverAgentLineIds({ getBlockNumber: async () => 3_000n, getLogs: async () => [] }, deployment, activeDiscovery);
  assert.equal(finished.cursor, null);
  assert.equal(hasResumableDiscoveryProgress(finished), true);
});

test("cancellation stops before the next getLogs request", async () => {
  let active = true;
  let calls = 0;
  const client: AgentLineDiscoveryClient = {
    getBlockNumber: async () => 10_001n,
    getLogs: async () => { calls++; active = false; return []; },
  };

  assert.deepEqual((await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, { isActive: () => active })).lineIds, []);
  assert.equal(calls, 1);
});

test("cancellation while getBlockNumber is pending makes no getLogs request", async () => {
  let active = true;
  let calls = 0;
  let resolveBlockNumber!: (value: bigint) => void;
  const blockNumber = new Promise<bigint>(resolve => { resolveBlockNumber = resolve; });
  const client: AgentLineDiscoveryClient = {
    getBlockNumber: async () => blockNumber,
    getLogs: async () => { calls++; return []; },
  };

  const discovery = discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, { isActive: () => active });
  active = false;
  resolveBlockNumber(10_001n);

  assert.deepEqual((await discovery).lineIds, []);
  assert.equal(calls, 0);
});

test("cancellation during a split retry makes no later getLogs request", async () => {
  let active = true;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client: AgentLineDiscoveryClient = {
    getBlockNumber: async () => 20_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push({ fromBlock, toBlock });
      if (ranges.length === 1) throw new Error("ranges over 10000 blocks are not supported on free plan");
      active = false;
      throw new Error("ranges over 10000 blocks are not supported on free plan");
    },
  } as unknown as AgentLineDiscoveryClient;

  assert.deepEqual((await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, { isActive: () => active })).lineIds, []);
  assert.deepEqual(ranges, [
    { fromBlock: 15_001n, toBlock: 20_000n },
    { fromBlock: 17_501n, toBlock: 20_000n },
  ]);
});

test("uses only the read client methods and never calls a write method", async () => {
  const calls: string[] = [];
  const client = {
    getBlockNumber: async () => { calls.push("getBlockNumber"); return 1n; },
    getLogs: async () => { calls.push("getLogs"); return [openedLog(lineId(1), 1n, 0)]; },
    writeContract: async () => { calls.push("writeContract"); throw new Error("unexpected write"); },
    sendTransaction: async () => { calls.push("sendTransaction"); throw new Error("unexpected send"); },
  } as unknown as AgentLineDiscoveryClient;

  assert.deepEqual((await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery)).lineIds, [lineId(1)]);
  assert.deepEqual(calls, ["getBlockNumber", "getLogs"]);
});


test("refreshing a large cached history reads only ten displayed lines and replaces old states", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => lineId(i + 1));
  const reads: Hash[] = [];
  const lines = await refreshAgentLineDiscoveryPage(ids, agent, async id => {
    reads.push(id);
    return { lineId: id, agent, stateName: "CLOSED", availableReserve: 0n, principalOutstanding: 0n } as any;
  }, () => true);
  assert.equal(reads.length, MAX_AGENT_LINE_DISCOVERY_RESULTS);
  assert.deepEqual(reads, ids.slice(0, MAX_AGENT_LINE_DISCOVERY_RESULTS));
  assert.equal(lines?.length, MAX_AGENT_LINE_DISCOVERY_RESULTS);
  assert.ok(lines?.every(line => line.stateName === "CLOSED" && line.availableReserve === 0n && line.principalOutstanding === 0n));
});

test("refreshing the next discovery page does not reread earlier pages", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => lineId(i + 1));
  const page = ids.slice(10, 20);
  const reads: Hash[] = [];
  await refreshAgentLineDiscoveryPage(page, agent, async id => {
    reads.push(id); return { lineId: id, agent } as any;
  }, () => true);
  assert.deepEqual(reads, page);
});

test("cancelled page refresh stops before further reads and never publishes partial stale states", async () => {
  let active = true;
  const reads: Hash[] = [];
  const lines = await refreshAgentLineDiscoveryPage([lineId(1), lineId(2)], agent, async id => {
    reads.push(id); active = false; return { lineId: id, agent } as any;
  }, () => active);
  assert.deepEqual(reads, [lineId(1)]);
  assert.equal(lines, null);
});
