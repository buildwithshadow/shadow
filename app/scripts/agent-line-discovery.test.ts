import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hash } from "viem";
import {
  AGENT_LINE_DISCOVERY_CHUNK_BLOCKS,
  MAX_AGENT_LINE_DISCOVERY_RESULTS,
  discoverAgentLineIds,
  parseAgentLineLogs,
  type AgentLineDiscoveryClient,
  type AgentLineOpenedLog,
} from "../src/agentLineDiscovery.ts";

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

test("scans newest chunks first, keeps each request within 5000 blocks, and returns at most ten lines", async () => {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const progress: { searchedBlocks: bigint; totalBlocks: bigint }[] = [];
  const client = {
    getBlockNumber: async () => 12_345n,
    getLogs: async ({ address, args, fromBlock, toBlock }: { address?: Address; args?: { agent?: Address }; fromBlock: bigint; toBlock: bigint }) => {
      assert.equal(address, contract);
      assert.equal(args?.agent?.toLowerCase(), agent.toLowerCase());
      ranges.push({ fromBlock, toBlock });
      return Array.from({ length: MAX_AGENT_LINE_DISCOVERY_RESULTS + 2 }, (_, index) =>
        openedLog(lineId(index + 1), 12_300n - BigInt(index), index));
    },
  } as unknown as AgentLineDiscoveryClient;

  const ids = await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, {
    ...activeDiscovery,
    onProgress: value => progress.push(value),
  });

  assert.deepEqual(ids, Array.from({ length: MAX_AGENT_LINE_DISCOVERY_RESULTS }, (_, index) => lineId(index + 1)));
  assert.deepEqual(ranges, [{ fromBlock: 7_346n, toBlock: 12_345n }]);
  assert.ok(ranges.every(({ fromBlock, toBlock }) => toBlock - fromBlock + 1n <= AGENT_LINE_DISCOVERY_CHUNK_BLOCKS));
  assert.deepEqual(progress, [{ searchedBlocks: 0n, totalBlocks: 12_345n }, { searchedBlocks: 5_000n, totalBlocks: 12_345n }]);
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

  assert.deepEqual(await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery), [lineId(1), lineId(2), lineId(3)]);
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

  assert.deepEqual(await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery), [lineId(1)]);
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

test("stops at the bounded request budget after one allowed halving per chunk", async () => {
  let calls = 0;
  const client: AgentLineDiscoveryClient = {
    getBlockNumber: async () => 5_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls++;
      if (toBlock - fromBlock + 1n > 1n) throw new Error("requested range too large");
      return [];
    },
  } as unknown as AgentLineDiscoveryClient;

  await assert.rejects(discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery), /request budget was exhausted/);
  assert.equal(calls, 18);
});

test("cancellation stops before the next getLogs request", async () => {
  let active = true;
  let calls = 0;
  const client: AgentLineDiscoveryClient = {
    getBlockNumber: async () => 10_001n,
    getLogs: async () => { calls++; active = false; return []; },
  };

  assert.deepEqual(await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, { isActive: () => active }), []);
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

  assert.deepEqual(await discovery, []);
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

  assert.deepEqual(await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, { isActive: () => active }), []);
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

  assert.deepEqual(await discoverAgentLineIds(client, { address: contract, agent, deployBlock: 1n }, activeDiscovery), [lineId(1)]);
  assert.deepEqual(calls, ["getBlockNumber", "getLogs"]);
});
