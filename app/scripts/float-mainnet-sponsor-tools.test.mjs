import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  toBytes,
  zeroAddress,
} from "viem";

import { BLOCK_REASONS, LINE_STATES, SPEND_INTENT_TYPES, eip712Domain, floatAbi, revertName } from "./float-mainnet-config.mjs";
import { MAX_LOOKBACK_BLOCKS, afterSend, findLatestLog, findLogs, predictSpend, remainingCapacity } from "./float-mainnet-cli.mjs";
import { account, e2eSkip, keyOf, startAnvil } from "./float-mainnet-e2e.mjs";

const DAY = 86_400n;
const NOW = 1_800_000_000n;
const TODAY = NOW / DAY;
const ROOMY = 10_000_000n;
const ENDPOINT = "https://provider.example/api/answer";
const ENDPOINT_HASH = keccak256(toBytes(ENDPOINT));

// The pilot line right after openLine, under the pinned initial caps.
function pilot({ line, policy, effectiveLimits, ...rest } = {}) {
  return {
    now: NOW,
    spendsPaused: false,
    sponsorAllowed: true,
    totalCommittedCapital: 1_000_000n,
    minimumRepaymentWindow: 3_600n,
    ...rest,
    effectiveLimits: {
      protocolReserve: 25_000_000n,
      lineReserve: 5_000_000n,
      lineSpend: 5_000_000n,
      perSpend: 1_000_000n,
      dailySpend: 2_000_000n,
      ...effectiveLimits,
    },
    line: {
      state: LINE_STATES.indexOf("OPEN"),
      expiry: NOW + 60n * DAY,
      reserveCap: 1_000_000n,
      availableReserve: 1_000_000n,
      lineSpendCap: 3_000_000n,
      cumulativePrincipalPaid: 0n,
      dailySpendCap: 1_000_000n,
      day: 0n,
      spentToday: 0n,
      ...line,
    },
    policy: {
      endpointHash: ENDPOINT_HASH,
      active: true,
      expiry: NOW + 60n * DAY,
      perSpendCap: 1_000_000n,
      dailySpendCap: 1_000_000n,
      day: 0n,
      spentToday: 0n,
      ...policy,
    },
  };
}

// Every amount at ROOMY, so a case lowers exactly one limit to make it bind.
function roomy({ line, policy, effectiveLimits, ...rest } = {}) {
  return pilot({
    ...rest,
    effectiveLimits: { protocolReserve: 50_000_000n, lineReserve: ROOMY, lineSpend: ROOMY, perSpend: ROOMY, dailySpend: ROOMY, ...effectiveLimits },
    line: { reserveCap: ROOMY, availableReserve: ROOMY, lineSpendCap: ROOMY, dailySpendCap: ROOMY, ...line },
    policy: { perSpendCap: ROOMY, dailySpendCap: ROOMY, ...policy },
  });
}

// A second, independent transliteration of ShadowFloatMainnet._blockReason.
function blockReason({ now, line, policy, effectiveLimits: limits, ...input }, principal, endpointHash = ENDPOINT_HASH) {
  if (input.spendsPaused) return "SPENDS_PAUSED";
  if (!input.sponsorAllowed) return "SPONSOR_NOT_ALLOWED";
  if (now > line.expiry) return "LINE_EXPIRED";
  if (!policy.active || now > policy.expiry) return "PROVIDER_NOT_ALLOWED";
  if (endpointHash !== policy.endpointHash) return "ENDPOINT_NOT_ALLOWED";
  if (input.totalCommittedCapital > limits.protocolReserve) return "PROTOCOL_CAP";
  if (line.reserveCap > limits.lineReserve || principal > line.availableReserve) return "LINE_RESERVE_CAP";
  if (
    principal > limits.lineSpend ||
    line.cumulativePrincipalPaid + principal > line.lineSpendCap ||
    line.cumulativePrincipalPaid + principal > limits.lineSpend
  ) {
    return "LINE_SPEND_CAP";
  }
  if (principal > policy.perSpendCap || principal > limits.perSpend) return "PER_SPEND_CAP";
  const today = now / DAY;
  const lineSpent = line.day === today ? line.spentToday : 0n;
  const providerSpent = policy.day === today ? policy.spentToday : 0n;
  if (
    lineSpent + principal > line.dailySpendCap ||
    lineSpent + principal > limits.dailySpend ||
    providerSpent + principal > policy.dailySpendCap
  ) {
    return "DAILY_SPEND_CAP";
  }
  return "NONE";
}

const CASES = [
  ["the pilot line: reserve, per-spend and both daily caps tie, the reserve check runs first", pilot(), 1_000_000n, "LINE_RESERVE_CAP", "line.availableReserve"],
  ["available reserve", roomy({ line: { availableReserve: 400_000n } }), 400_000n, "LINE_RESERVE_CAP", "line.availableReserve"],
  ["line spend cap", roomy({ line: { lineSpendCap: 5_000_000n, cumulativePrincipalPaid: 4_600_000n } }), 400_000n, "LINE_SPEND_CAP", "line.lineSpendCap"],
  [
    "effective line spend",
    roomy({ line: { cumulativePrincipalPaid: 4_600_000n }, effectiveLimits: { lineSpend: 5_000_000n } }),
    400_000n,
    "LINE_SPEND_CAP",
    "effectiveLimits.lineSpend",
  ],
  ["provider per-spend cap", roomy({ policy: { perSpendCap: 400_000n } }), 400_000n, "PER_SPEND_CAP", "policy.perSpendCap"],
  ["effective per-spend", roomy({ effectiveLimits: { perSpend: 400_000n } }), 400_000n, "PER_SPEND_CAP", "effectiveLimits.perSpend"],
  [
    "line daily cap",
    roomy({ line: { dailySpendCap: 5_000_000n, day: TODAY, spentToday: 4_600_000n } }),
    400_000n,
    "DAILY_SPEND_CAP",
    "line.dailySpendCap",
  ],
  [
    "effective daily",
    roomy({ line: { day: TODAY, spentToday: 4_600_000n }, effectiveLimits: { dailySpend: 5_000_000n } }),
    400_000n,
    "DAILY_SPEND_CAP",
    "effectiveLimits.dailySpend",
  ],
  ["provider daily cap", roomy({ policy: { day: TODAY, spentToday: 9_600_000n } }), 400_000n, "DAILY_SPEND_CAP", "policy.dailySpendCap"],
  ["spends paused", pilot({ spendsPaused: true }), 0n, "SPENDS_PAUSED", "spendsPaused"],
  ["sponsor removed from the allowlist", pilot({ sponsorAllowed: false }), 0n, "SPONSOR_NOT_ALLOWED", "sponsorAllowed"],
  ["provider inactive", pilot({ policy: { active: false } }), 0n, "PROVIDER_NOT_ALLOWED", "policy.active"],
  ["provider policy expired", pilot({ policy: { expiry: NOW - 1n } }), 0n, "PROVIDER_NOT_ALLOWED", "policy.expiry"],
  ["provider policy expiring this second still pays", pilot({ policy: { expiry: NOW } }), 1_000_000n, "LINE_RESERVE_CAP", "line.availableReserve"],
  ["protocol reserve cap reduced below committed capital", pilot({ totalCommittedCapital: 25_000_001n }), 0n, "PROTOCOL_CAP", "effectiveLimits.protocolReserve"],
  ["committed capital at the protocol cap still pays", pilot({ totalCommittedCapital: 25_000_000n }), 1_000_000n, "LINE_RESERVE_CAP", "line.availableReserve"],
  ["line reserve cap reduced below the line's reserve", pilot({ effectiveLimits: { lineReserve: 999_999n } }), 0n, "LINE_RESERVE_CAP", "effectiveLimits.lineReserve"],
  ["reserve fully drawn", pilot({ line: { availableReserve: 0n } }), 0n, "LINE_RESERVE_CAP", "line.availableReserve"],
  [
    "line spend cap lowered below cumulative spend clamps at zero",
    pilot({ line: { lineSpendCap: 1_000_000n, cumulativePrincipalPaid: 2_000_000n } }),
    0n,
    "LINE_SPEND_CAP",
    "line.lineSpendCap",
  ],
  ["line expired", pilot({ line: { expiry: NOW - 1n } }), 0n, "LINE_EXPIRED", "line.expiry"],
  ["no dueAt fits before line expiry", pilot({ line: { expiry: NOW + 3_599n } }), 0n, "NO_DUE_DATE_BEFORE_EXPIRY", "line.expiry"],
  ["a dueAt exactly at line expiry still pays", pilot({ line: { expiry: NOW + 3_600n } }), 1_000_000n, "LINE_RESERVE_CAP", "line.availableReserve"],
];

describe("remainingCapacity mirrors executeSpend and _blockReason", () => {
  for (const [name, input, nextSpendMax, limitedBy, binding] of CASES) {
    test(name, () => {
      assert.deepEqual(remainingCapacity(input), { nextSpendMax, limitedBy, binding });
    });
  }

  test("limitedBy is the reason _blockReason gives nextSpendMax + 1, and nextSpendMax itself passes", () => {
    for (const [name, input, nextSpendMax, limitedBy] of CASES) {
      if (!BLOCK_REASONS.includes(limitedBy)) continue;
      assert.equal(blockReason(input, nextSpendMax + 1n), limitedBy, name);
      if (nextSpendMax > 0n) assert.equal(blockReason(input, nextSpendMax), "NONE", name);
    }
  });

  test("predictSpend records what _blockReason returns for any principal, and ENDPOINT_NOT_ALLOWED in its place", () => {
    const other = keccak256(toBytes("https://provider.example/api/other"));
    for (const [name, input, nextSpendMax] of CASES) {
      if (["LINE_EXPIRED", "NO_DUE_DATE_BEFORE_EXPIRY"].includes(remainingCapacity(input).limitedBy)) {
        assert.equal(predictSpend(input, { principal: 1n, endpointHash: ENDPOINT_HASH }).outcome, "revert", name);
        continue;
      }
      for (const principal of [1n, nextSpendMax, nextSpendMax + 1n, nextSpendMax * 3n + 1n, 25_000_000n]) {
        if (principal === 0n) continue;
        for (const endpointHash of [ENDPOINT_HASH, other]) {
          const expected = blockReason(input, principal, endpointHash);
          const predicted = predictSpend(input, { principal, endpointHash });
          assert.deepEqual(
            [predicted.outcome, predicted.reason],
            [expected === "NONE" ? "pay" : "block", expected],
            `${name}: principal ${principal}, endpoint ${endpointHash === other ? "other" : "approved"}`,
          );
          assert.equal(predicted.nextSpendMax, nextSpendMax, name);
        }
      }
    }
    // A principal well above nextSpendMax can fail an earlier check than limitedBy.
    const input = roomy({ line: { availableReserve: 900_000n }, policy: { perSpendCap: 400_000n } });
    assert.deepEqual(remainingCapacity(input), { nextSpendMax: 400_000n, limitedBy: "PER_SPEND_CAP", binding: "policy.perSpendCap" });
    assert.equal(predictSpend(input, { principal: 400_001n, endpointHash: ENDPOINT_HASH }).reason, "PER_SPEND_CAP");
    assert.equal(predictSpend(input, { principal: 900_001n, endpointHash: ENDPOINT_HASH }).reason, "LINE_RESERVE_CAP");
  });

  test("DRAWN, DEFAULTED, CLOSED and NONE lines have no capacity", () => {
    for (const state of ["NONE", "DRAWN", "DEFAULTED", "CLOSED"]) {
      const input = pilot({ line: { state: LINE_STATES.indexOf(state), availableReserve: 0n, day: TODAY, spentToday: 1_000_000n } });
      assert.deepEqual(remainingCapacity(input), { nextSpendMax: 0n, limitedBy: `LINE_${state}`, binding: "line.state" });
    }
  });

  test("today's spend binds until the UTC day rolls over", () => {
    const repaid = (now) =>
      pilot({
        now,
        line: { cumulativePrincipalPaid: 1_000_000n, day: TODAY, spentToday: 1_000_000n },
        policy: { day: TODAY, spentToday: 1_000_000n },
      });
    const lastSecond = (TODAY + 1n) * DAY - 1n;
    assert.deepEqual(remainingCapacity(repaid(lastSecond)), {
      nextSpendMax: 0n,
      limitedBy: "DAILY_SPEND_CAP",
      binding: "line.dailySpendCap",
    });
    assert.deepEqual(remainingCapacity(repaid(lastSecond + 1n)), {
      nextSpendMax: 1_000_000n,
      limitedBy: "LINE_RESERVE_CAP",
      binding: "line.availableReserve",
    });
  });
});

describe("chunked log scans", () => {
  const CHUNK = 5_000n;
  const DIGEST = keccak256(toBytes("digest"));

  // A client whose getLogs records every requested range and returns the logs
  // at `blocks` inside it, oldest first. It refuses to run away.
  function scanner(blocks = []) {
    const ranges = [];
    const connection = {
      address: zeroAddress,
      client: {
        getLogs: async ({ address, event, args, fromBlock, toBlock }) => {
          assert.equal(address, connection.address);
          assert.deepEqual([event.type, event.name, args], ["event", "ProviderPaid", { digest: DIGEST }]);
          ranges.push([fromBlock, toBlock]);
          if (ranges.length > 1_000) throw new Error("the scan did not terminate");
          return blocks.filter((block) => block >= fromBlock && block <= toBlock).map((blockNumber) => ({ blockNumber }));
        },
      },
    };
    return { connection, ranges };
  }

  // Every range holds at most CHUNK blocks, and together, in the order asked,
  // they cover [low, high] with no gap and no overlap.
  function assertCovers(ranges, low, high, direction) {
    for (const [from, to] of ranges) assert.ok(from <= to && to - from + 1n <= CHUNK, `range ${from}-${to}`);
    const ordered = direction === "forward" ? ranges : [...ranges].reverse();
    assert.equal(ordered[0][0], low);
    assert.equal(ordered.at(-1)[1], high);
    for (let index = 1; index < ordered.length; index++) assert.equal(ordered[index][0], ordered[index - 1][1] + 1n);
  }

  const latest = (connection, fromBlock, toBlock) => findLatestLog(connection, "ProviderPaid", { digest: DIGEST }, { fromBlock, toBlock });

  test("findLogs scans forward in chunks and finds logs on both sides of every chunk edge", async () => {
    const edges = [0n, 4_999n, 5_000n, 9_999n, 10_000n, 12_345n];
    const { connection, ranges } = scanner(edges);
    const logs = await findLogs(connection, "ProviderPaid", { digest: DIGEST }, 0n, 12_345n);
    assert.deepEqual(logs.map((log) => log.blockNumber), edges);
    assert.deepEqual(ranges, [[0n, 4_999n], [5_000n, 9_999n], [10_000n, 12_345n]]);
    assertCovers(ranges, 0n, 12_345n, "forward");

    for (const [low, high, count] of [[7n, 7n, 1], [1n, 5_000n, 1], [1n, 5_001n, 2], [3n, 1_234_567n, 247]]) {
      const scan = scanner();
      assert.deepEqual(await findLogs(scan.connection, "ProviderPaid", { digest: DIGEST }, low, high), []);
      assert.equal(scan.ranges.length, count, `${low}-${high}`);
      assertCovers(scan.ranges, low, high, "forward");
    }
    const empty = scanner([5n]);
    assert.deepEqual(await findLogs(empty.connection, "ProviderPaid", { digest: DIGEST }, 6n, 5n), []);
    assert.deepEqual(empty.ranges, []);
  });

  test("findLatestLog scans back from toBlock to an explicit lower bound, 0 included", async () => {
    const missing = scanner();
    assert.deepEqual(await latest(missing.connection, 0n, 20_000n), { log: null, fromBlock: 0n, toBlock: 20_000n });
    assert.deepEqual(missing.ranges, [[15_001n, 20_000n], [10_001n, 15_000n], [5_001n, 10_000n], [1n, 5_000n], [0n, 0n]]);
    assertCovers(missing.ranges, 0n, 20_000n, "backward");

    // A log exactly on either side of a chunk edge is found in the chunk holding it.
    for (const [block, requests] of [[20_000n, 1], [15_001n, 1], [15_000n, 2], [5_001n, 3], [1n, 4], [0n, 5]]) {
      const scan = scanner([block]);
      const found = await latest(scan.connection, 0n, 20_000n);
      assert.equal(found.log?.blockNumber, block);
      assert.equal(scan.ranges.length, requests, `log at ${block}`);
    }
    // The latest match in a chunk wins, and the scan stops there.
    const two = scanner([9_000n, 10_001n, 14_000n]);
    assert.equal((await latest(two.connection, 0n, 20_000n)).log.blockNumber, 14_000n);
    assert.equal(two.ranges.length, 2);

    // An explicit 0 is a bound, not "no bound": the scan goes past the lookback cap to block 0.
    const deep = scanner([0n]);
    const head = MAX_LOOKBACK_BLOCKS + 200_000n;
    const found = await latest(deep.connection, 0n, head);
    assert.deepEqual([found.log.blockNumber, found.fromBlock], [0n, 0n]);
    assertCovers(deep.ranges, 0n, head, "backward");

    const above = scanner([5n]);
    assert.deepEqual(await latest(above.connection, 6n, 5n), { log: null, fromBlock: 6n, toBlock: 5n });
    assert.deepEqual(above.ranges, []);
    const single = scanner([0n]);
    assert.equal((await latest(single.connection, 0n, 0n)).log.blockNumber, 0n);
    assert.deepEqual(single.ranges, [[0n, 0n]]);
  });

  test("without a lower bound findLatestLog stops at the 1,000,000-block cap", async () => {
    assert.equal(MAX_LOOKBACK_BLOCKS, 1_000_000n);
    const head = 1_500_000n;
    const floor = head - MAX_LOOKBACK_BLOCKS + 1n;
    const missing = scanner([floor - 1n]);
    assert.deepEqual(await latest(missing.connection, null, head), { log: null, fromBlock: floor, toBlock: head });
    assert.equal(missing.ranges.length, 200);
    assertCovers(missing.ranges, floor, head, "backward");

    const atFloor = scanner([floor]);
    assert.equal((await latest(atFloor.connection, null, head)).log.blockNumber, floor);
    assert.equal(atFloor.ranges.length, 200);

    // A head below the cap scans back to block 0.
    const young = scanner();
    assert.deepEqual(await latest(young.connection, null, 12_000n), { log: null, fromBlock: 0n, toBlock: 12_000n });
    assertCovers(young.ranges, 0n, 12_000n, "backward");
  });
});

test("afterSend keeps every mined hash when a follow-up read fails", async () => {
  const txHashes = [keccak256(toBytes("approve")), keccak256(toBytes("repay"))];
  const output = { ok: true, dryRun: false, txHashes, events: [], amount: 100_000n };
  assert.deepEqual(await afterSend(output, async () => ({ after: { state: "DRAWN" } })), { ...output, after: { state: "DRAWN" } });
  const failed = await afterSend(output, async () => {
    throw new Error("upstream unavailable");
  });
  assert.deepEqual(failed, {
    ...output,
    ok: false,
    status: "sent",
    error: {
      message: `sent and mined: ${txHashes[0]}, ${txHashes[1]}; follow-up read failed: upstream unavailable; check these hashes before re-running`,
      revert: null,
    },
  });
});

const PORT = 18562;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 5_042_002;
const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));
const SIXTY_DAYS = "+5184000";
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };

function artifact(name) {
  return JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
}

// Account index 1 is not used.
describe("participant CLIs drive the full line lifecycle on a local chain", { skip: e2eSkip }, () => {
  const [owner, sponsor, agent, provider, provider2] = [0, 6, 2, 3, 4].map(account);
  const chain = defineChain({
    id: CHAIN_ID,
    name: "anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });
  const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });
  let anvil;
  let usdc;
  let float;
  const seen = {};

  const OWNER = () => ({ FLOAT_OWNER_PRIVATE_KEY: keyOf(0) });
  const SPONSOR = () => ({ FLOAT_SPONSOR_PRIVATE_KEY: keyOf(6) });
  const AGENT_KEY = keyOf(2);
  const readFloat = (functionName, args = []) => publicClient.readContract({ address: float, abi: floatAbi, functionName, args });
  const balance = (address) => publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });

  async function send(account, request) {
    const hash = await wallet(account).writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt;
  }

  // "Nothing was sent": run() leaves the sender's nonce and the chain height as they were.
  async function sentNothing(address, run) {
    const [count, height] = await Promise.all([publicClient.getTransactionCount({ address }), publicClient.getBlockNumber({ cacheTime: 0 })]);
    const result = run();
    assert.equal(await publicClient.getTransactionCount({ address }), count, `${address} sent a transaction`);
    assert.equal(await publicClient.getBlockNumber({ cacheTime: 0 }), height, "a block was mined");
    return result;
  }

  async function deploy(name, args) {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(owner).deployContract({ abi, bytecode: bytecode.object, args });
    return getAddress((await publicClient.waitForTransactionReceipt({ hash })).contractAddress);
  }

  // Runs a participant CLI exactly as a participant would: its own process,
  // env-only configuration and keys, one JSON object on stdout.
  function cli(tool, args, keys = {}) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(FLOAT_|ARC_)/i.test(name)),
    );
    Object.assign(env, { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: String(CHAIN_ID), FLOAT_MAINNET_ADDRESS: float }, keys);
    const run = spawnSync(process.execPath, [join(SCRIPTS, `float-mainnet-${tool}.mjs`), ...args], {
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    let json;
    try {
      json = JSON.parse(run.stdout);
    } catch {
      assert.fail(`${tool} ${args.join(" ")} exited ${run.status} without one JSON object:\n${run.stdout}\n${run.stderr}`);
    }
    return { status: run.status, json };
  }

  function ok(tool, args, keys) {
    const { status, json } = cli(tool, args, keys);
    assert.equal(status, 0, JSON.stringify(json));
    assert.equal(json.ok, true);
    return json;
  }

  function fails(tool, args, keys, exitCode = 1) {
    const { status, json } = cli(tool, args, keys);
    assert.equal(status, exitCode, JSON.stringify(json));
    assert.equal(json.ok, false);
    return json.error;
  }

  const lineStatus = (lineId, extra = []) => ok("line", ["status", "--line-id", lineId, "--from-block", "0", ...extra]);

  const openArgs = (extra) => [
    "open",
    "--agent", agent.address,
    "--provider", provider.address,
    "--endpoint", ENDPOINT,
    "--reserve", "1000000",
    "--line-spend-cap", "3000000",
    "--daily-cap", "1000000",
    "--line-expiry", SIXTY_DAYS,
    "--max-repayment-window", "604800",
    "--provider-per-spend", "1000000",
    "--provider-daily", "1000000",
    "--provider-expiry", SIXTY_DAYS,
    ...extra,
  ];

  const expectedLineId = (epoch) =>
    keccak256(
      encodeAbiParameters(parseAbiParameters("uint256, address, address, address, uint64"), [
        BigInt(CHAIN_ID),
        float,
        sponsor.address,
        agent.address,
        epoch,
      ]),
    );

  // The agent's purchase, signed and submitted with viem directly.
  async function purchase({ lineId, epoch, principal, nonce, submit = true }) {
    const latest = await publicClient.getBlock();
    const intent = {
      agent: agent.address,
      sponsor: sponsor.address,
      lineId,
      lineEpoch: epoch,
      termsHash: await readFloat("currentTermsHash", [lineId, provider.address]),
      provider: provider.address,
      endpointHash: keccak256(toBytes(ENDPOINT)),
      principal,
      maximumTotalDebt: principal,
      dueAt: latest.timestamp + 3_600n + 300n,
      nonce,
      signatureExpiry: latest.timestamp + 3_600n,
      executor: zeroAddress,
    };
    const typed = { domain: eip712Domain(CHAIN_ID, float), types: SPEND_INTENT_TYPES, primaryType: "SpendIntent", message: intent };
    const signature = await agent.signTypedData(typed);
    const digest = hashTypedData(typed);
    assert.equal(await readFloat("hashSpendIntent", [intent]), digest);
    if (!submit) return { intent, signature, digest };
    const receipt = await send(agent, { address: float, abi: floatAbi, functionName: "executeSpend", args: [intent, signature] });
    const [event] = parseEventLogs({ abi: floatAbi, logs: receipt.logs, eventName: ["ProviderPaid", "SpendBlocked"] });
    return { intent, signature, digest, event, receipt };
  }

  before(async () => {
    anvil = await startAnvil(PORT);
    usdc = await deploy("MockAsset", ["USD Coin", "USDC", 6]);
    float = await deploy("ShadowFloatMainnet", [usdc, BigInt(CHAIN_ID), MAXIMA, INITIAL, 3_600n, 604_800n, 172_800n]);
    const { abi } = artifact("MockAsset");
    for (const account of [sponsor, agent]) {
      await send(owner, { address: usdc, abi, functionName: "mint", args: [account.address, 10_000_000n] });
    }
  });

  after(() => {
    anvil?.stop();
  });

  test("owner: a dry run sends nothing, --calldata needs no key, a non-owner key and a missing flag are refused", async () => {
    const dry = await sentNothing(owner.address, () => ok("owner", ["allow-sponsor", "--sponsor", sponsor.address], OWNER()));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.calls[0].functionName, "setSponsorAllowed");
    assert.deepEqual(dry.simulation, [{ functionName: "setSponsorAllowed", status: "ok" }]);
    assert.equal(await readFloat("sponsorAllowed", [sponsor.address]), false);

    const safe = await sentNothing(owner.address, () => ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--calldata", "--from", owner.address]));
    assert.equal(safe.calls.length, 1);
    assert.equal(safe.calls[0].to, float);
    assert.equal(safe.calls[0].value, "0");
    const decoded = decodeFunctionData({ abi: floatAbi, data: safe.calls[0].data });
    assert.equal(decoded.functionName, "setSponsorAllowed");
    assert.deepEqual(decoded.args, [sponsor.address, true]);

    const notOwner = fails("owner", ["allow-sponsor", "--sponsor", sponsor.address], { FLOAT_OWNER_PRIVATE_KEY: keyOf(6) });
    assert.match(notOwner.message, /is not owner\(\)/);
    assert.match(fails("owner", ["allow-sponsor"], OWNER(), 2).message, /--sponsor is required/);
    assert.match(fails("owner", ["pause", "--what", "everything"], OWNER(), 2).message, /openings or spends/);
    assert.match(
      fails("owner", ["allow-sponsor", "--sponsor", sponsor.address.toLowerCase().replace("0x", "0X")], OWNER(), 2).message,
      /--sponsor must be a 20-byte hex address/,
    );
  });

  test("sponsor: open before allowlisting fails with the owner guidance", async () => {
    const error = await sentNothing(sponsor.address, () => fails("sponsor", openArgs([]), SPONSOR()));
    assert.ok(error.message.includes(`ask the owner to run allow-sponsor --sponsor ${sponsor.address}`), error.message);
    assert.equal(error.revert, null);
  });

  test("owner allows the sponsor; the sponsor opens the pilot line", async () => {
    const allowed = ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], OWNER());
    assert.equal(allowed.dryRun, false);
    assert.equal(allowed.txHashes.length, 1);
    assert.deepEqual(allowed.events.map((entry) => [entry.event, entry.args]), [["SponsorAllowed", { sponsor: sponsor.address, allowed: true }]]);

    const unsigned = await sentNothing(sponsor.address, () => ok("sponsor", openArgs(["--calldata", "--from", sponsor.address])));
    assert.deepEqual(unsigned.calls.map((call) => call.to), [usdc, float]);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: unsigned.calls[0].data }).args, [float, 1_000_000n]);
    assert.equal(decodeFunctionData({ abi: floatAbi, data: unsigned.calls[1].data }).functionName, "openLine");

    const sponsorBefore = await balance(sponsor.address);
    const opened = ok("sponsor", openArgs(["--execute"]), SPONSOR());
    assert.equal(opened.lineId, expectedLineId(1n));
    assert.equal(opened.epoch, "1");
    assert.equal(opened.termsVersion, "1");
    assert.equal(opened.endpointHash, keccak256(toBytes(ENDPOINT)));
    assert.equal(opened.termsHash, await readFloat("currentTermsHash", [opened.lineId, provider.address]));
    assert.equal(opened.approvalIncluded, true);
    assert.equal(opened.txHashes.length, 2);
    assert.equal(sponsorBefore - (await balance(sponsor.address)), 1_000_000n);
    seen.line1 = opened.lineId;
  });

  test("status: OPEN with nextSpendMax 1000000; pause and one unit more are both refused as reported", async () => {
    const open = lineStatus(seen.line1);
    assert.equal(open.state, "OPEN");
    assert.equal(open.reserveCap, "1000000");
    assert.equal(open.availableReserve, "1000000");
    assert.equal(open.principalOutstanding, "0");
    assert.equal(open.secondsUntilDue, null);
    assert.deepEqual(open.providers.map((entry) => entry.provider), [provider.address]);
    assert.deepEqual(open.providers[0].remaining, { nextSpendMax: "1000000", limitedBy: "LINE_RESERVE_CAP", binding: "line.availableReserve" });

    const byPair = ok("line", ["status", "--sponsor", sponsor.address, "--agent", agent.address, "--provider", provider.address]);
    assert.equal(byPair.lineId, seen.line1);
    assert.deepEqual(byPair.providers, open.providers);

    ok("owner", ["pause", "--what", "spends", "--execute"], OWNER());
    assert.deepEqual(lineStatus(seen.line1).providers[0].remaining, { nextSpendMax: "0", limitedBy: "SPENDS_PAUSED", binding: "spendsPaused" });
    const unpaused = ok("owner", ["unpause", "--what", "spends", "--execute"], OWNER());
    assert.equal(unpaused.pausedBefore, true);
    assert.equal(await readFloat("spendsPaused"), false);

    const blocked = await purchase({ lineId: seen.line1, epoch: 1n, principal: 1_000_001n, nonce: 1n });
    assert.equal(blocked.event.eventName, "SpendBlocked");
    assert.equal(BLOCK_REASONS[blocked.event.args.reason], open.providers[0].remaining.limitedBy);
    seen.blocked = blocked;
  });

  test("after one purchase the line is DRAWN with nothing left to spend", async () => {
    const paid = await purchase({ lineId: seen.line1, epoch: 1n, principal: 1_000_000n, nonce: 2n });
    assert.equal(paid.event.eventName, "ProviderPaid");
    seen.paid = paid;

    const drawn = lineStatus(seen.line1);
    assert.equal(drawn.state, "DRAWN");
    assert.equal(drawn.principalOutstanding, "1000000");
    assert.equal(drawn.availableReserve, "0");
    assert.equal(drawn.cumulativePrincipalPaid, "1000000");
    assert.equal(drawn.dueAt, paid.intent.dueAt.toString());
    assert.equal(drawn.matured, false);
    assert.ok(BigInt(drawn.secondsUntilDue) > 0n);
    assert.deepEqual(drawn.providers[0].remaining, { nextSpendMax: "0", limitedBy: "LINE_DRAWN", binding: "line.state" });
  });

  test("repay --amount keeps the line DRAWN; repay --full reopens it with cumulative spend unchanged", async () => {
    const repayer = { FLOAT_REPAYER_PRIVATE_KEY: AGENT_KEY };
    const dry = await sentNothing(agent.address, () => ok("repay", ["--line-id", seen.line1, "--amount", "400000"], repayer));
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.calls.map((call) => call.functionName), ["approve", "repay"]);
    assert.deepEqual(dry.simulation.map((entry) => entry.status), ["ok", "skipped"]);

    const partial = ok("repay", ["--line-id", seen.line1, "--amount", "400000", "--execute"], repayer);
    assert.equal(partial.repayer, agent.address);
    assert.equal(partial.keyEnv, "FLOAT_REPAYER_PRIVATE_KEY");
    assert.equal(partial.txHashes.length, 2);
    assert.deepEqual(partial.after, { state: "DRAWN", principalOutstanding: "600000", availableReserve: "400000" });

    const tooMuch = await sentNothing(agent.address, () => fails("repay", ["--line-id", seen.line1, "--amount", "600001"], repayer));
    assert.match(tooMuch.message, /between 1 and principalOutstanding 600000/);

    const full = ok("repay", ["--line-id", seen.line1, "--full", "--execute"], repayer);
    assert.equal(full.amount, "600000");
    assert.deepEqual(full.after, { state: "OPEN", principalOutstanding: "0", availableReserve: "1000000" });

    const reopened = lineStatus(seen.line1);
    assert.equal(reopened.state, "OPEN");
    assert.equal(reopened.dueAt, "0");
    assert.equal(reopened.cumulativePrincipalPaid, "1000000");
    const purchasedAt = (await publicClient.getBlock({ blockNumber: seen.paid.receipt.blockNumber })).timestamp;
    const sameDay = purchasedAt / DAY === BigInt(reopened.observedAt.timestamp) / DAY;
    assert.deepEqual(
      reopened.providers[0].remaining,
      sameDay
        ? { nextSpendMax: "0", limitedBy: "DAILY_SPEND_CAP", binding: "line.dailySpendCap" }
        : { nextSpendMax: "1000000", limitedBy: "LINE_RESERVE_CAP", binding: "line.availableReserve" },
    );
  });

  test("open and update-terms refuse a repayment window too short to draw on with the default signature validity", async () => {
    const minimum = await readFloat("minimumRepaymentWindow");
    const short = (minimum + 899n).toString();
    const tooShort = await sentNothing(sponsor.address, () =>
      fails("sponsor", openArgs(["--execute"]).map((arg, index, args) => (args[index - 1] === "--max-repayment-window" ? short : arg)), SPONSOR()),
    );
    assert.match(tooShort.message, new RegExp(`--max-repayment-window ${short} must be at least minimumRepaymentWindow ${minimum} \\+ the default 900s signature validity \\(${minimum + 900n}\\)`));
    const update = (window) => [
      "update-terms", "--line-id", seen.line1,
      "--line-spend-cap", "3000000", "--daily-cap", "1000000", "--line-expiry", SIXTY_DAYS, "--max-repayment-window", window,
    ];
    const refused = await sentNothing(sponsor.address, () => fails("sponsor", [...update(short), "--execute"], SPONSOR()));
    assert.match(refused.message, /must be at least minimumRepaymentWindow/);
    ok("sponsor", update((minimum + 900n).toString()), SPONSOR());
    assert.match(fails("sponsor", update("+604800"), SPONSOR(), 2).message, /--max-repayment-window must be a number of seconds/);
  });

  test("open, update-terms and set-provider-policy refuse an expiry too soon to draw on with the default signature validity", async () => {
    const minimum = await readFloat("minimumRepaymentWindow");
    const early = `+${minimum + 899n}`;
    const floor = `+${minimum + 900n}`;
    const withFlag = (args, flag, value) => args.map((arg, index) => (args[index - 1] === flag ? value : arg));
    // "<flag> <expiry> must be at least the latest block <t> + minimumRepaymentWindow <m> + ... (<floor>)"
    const refusal = (message, flag) => {
      const match = new RegExp(
        `--${flag} (\\d+) must be at least the latest block (\\d+) \\+ minimumRepaymentWindow ${minimum} \\+ the default 900s signature validity \\((\\d+)\\): the contract accepts an earlier expiry, but ([^;]+)`,
      ).exec(message);
      assert.ok(match, message);
      const [expiry, latest, bound] = match.slice(1, 4).map(BigInt);
      assert.deepEqual([bound, expiry], [latest + minimum + 900n, latest + minimum + 899n]);
      return match[4];
    };
    const lineConsequence = "no intent built with the default --signature-ttl could then be drawn on the line";
    const policyConsequence = /^build and sign refuse an intent whose signature outlives the provider policy, so that would leave less than minimumRepaymentWindow/;

    const opened = await sentNothing(sponsor.address, () =>
      fails("sponsor", withFlag(withFlag(openArgs(["--execute"]), "--line-expiry", early), "--provider-expiry", early), SPONSOR()),
    );
    assert.equal(refusal(opened.message, "line-expiry"), lineConsequence);
    assert.match(refusal(opened.message, "provider-expiry"), policyConsequence);

    const update = (expiry) => [
      "update-terms", "--line-id", seen.line1,
      "--line-spend-cap", "3000000", "--daily-cap", "1000000", "--line-expiry", expiry, "--max-repayment-window", "604800",
    ];
    const updated = await sentNothing(sponsor.address, () => fails("sponsor", [...update(early), "--execute"], SPONSOR()));
    assert.equal(refusal(updated.message, "line-expiry"), lineConsequence);
    ok("sponsor", update(floor), SPONSOR());

    const policy = (expiry, extra = []) => [
      "set-provider-policy", "--line-id", seen.line1, "--provider", provider.address,
      "--endpoint", ENDPOINT, "--per-spend", "1000000", "--daily", "1000000", "--expiry", expiry, ...extra,
    ];
    const set = await sentNothing(sponsor.address, () => fails("sponsor", policy(early, ["--execute"]), SPONSOR()));
    assert.match(refusal(set.message, "expiry"), policyConsequence);
    ok("sponsor", policy(floor), SPONSOR());
    // Deactivating takes any expiry: an inactive policy pays nothing anyway.
    const inactive = ok("sponsor", policy("+10", ["--inactive"]), SPONSOR());
    assert.equal(inactive.active, false);
  });

  test("update-terms and set-provider-policy report invalidation, bump termsVersion and void signed intents", async () => {
    const signedBefore = await purchase({ lineId: seen.line1, epoch: 1n, principal: 1n, nonce: 3n, submit: false });
    const updated = ok(
      "sponsor",
      [
        "update-terms", "--line-id", seen.line1,
        "--line-spend-cap", "3000000", "--daily-cap", "2000000", "--line-expiry", SIXTY_DAYS, "--max-repayment-window", "604800",
        "--execute",
      ],
      SPONSOR(),
    );
    assert.equal(updated.invalidatesOutstandingSignatures, true);
    assert.deepEqual(updated.termsVersion, { before: "1", after: "2" });
    assert.deepEqual(updated.events.map((entry) => entry.event), ["LineTermsUpdated"]);
    await assert.rejects(
      publicClient.simulateContract({
        address: float,
        abi: floatAbi,
        functionName: "executeSpend",
        args: [signedBefore.intent, signedBefore.signature],
        account: agent.address,
      }),
      (error) => revertName(error) === "StaleTerms",
    );

    const policy = ok(
      "sponsor",
      [
        "set-provider-policy", "--line-id", seen.line1, "--provider", provider2.address,
        "--endpoint", "https://second.example/api", "--per-spend", "500000", "--daily", "500000", "--expiry", SIXTY_DAYS,
        "--execute",
      ],
      SPONSOR(),
    );
    assert.equal(policy.invalidatesOutstandingSignatures, true);
    assert.deepEqual(policy.termsVersion, { before: "2", after: "3" });
    assert.equal(policy.termsHash, await readFloat("currentTermsHash", [seen.line1, provider2.address]));

    const listed = lineStatus(seen.line1);
    assert.equal(listed.termsVersion, "3");
    assert.deepEqual(listed.providers.map((entry) => entry.provider), [provider.address, provider2.address]);

    // --inactive needs no endpoint, caps or expiry: the stored values are kept.
    const stored = await readFloat("providerPolicies", [seen.line1, provider2.address]);
    const deactivated = ok("sponsor", ["set-provider-policy", "--line-id", seen.line1, "--provider", provider2.address, "--inactive", "--execute"], SPONSOR());
    assert.deepEqual(deactivated.termsVersion, { before: "3", after: "4" });
    assert.deepEqual(
      [deactivated.active, deactivated.endpointHash, deactivated.perSpendCap, deactivated.dailySpendCap, deactivated.expiry],
      [false, stored[0], "500000", "500000", stored[1].toString()],
    );
    const after = await readFloat("providerPolicies", [seen.line1, provider2.address]);
    assert.deepEqual([after[0], after[1], after[3], after[4], after[5]], [stored[0], stored[1], false, stored[4], stored[5]]);
    const inactive = lineStatus(seen.line1, ["--provider", provider2.address]).providers[0];
    assert.deepEqual([inactive.active, inactive.remaining.limitedBy], [false, "PROVIDER_NOT_ALLOWED"]);
  });

  test("close returns exactly the reserve to the sponsor", async () => {
    const before = await balance(sponsor.address);
    const closed = ok("sponsor", ["close", "--line-id", seen.line1, "--execute"], SPONSOR());
    assert.equal(closed.amount, "1000000");
    assert.equal(closed.state, "CLOSED");
    assert.equal((await balance(sponsor.address)) - before, 1_000_000n);
    const after = lineStatus(seen.line1);
    assert.equal(after.state, "CLOSED");
    assert.equal(after.availableReserve, "0");
    assert.equal(after.providers[0].remaining.limitedBy, "LINE_CLOSED");
  });

  test("receipt finds the ProviderPaid and the SpendBlocked by digest", async () => {
    const paid = ok("line", ["receipt", "--digest", seen.paid.digest, "--from-block", "0"]);
    assert.equal(paid.receiptStatus, "paid");
    assert.equal(paid.event.event, "ProviderPaid");
    assert.equal(paid.event.args.digest, seen.paid.digest);
    assert.equal(paid.event.args.lineId, seen.line1);
    assert.equal(paid.event.args.provider, provider.address);
    assert.equal(paid.event.args.principal, "1000000");

    const blocked = ok("line", ["receipt", "--digest", seen.blocked.digest, "--from-block", "0"]);
    assert.equal(blocked.receiptStatus, "blocked");
    assert.equal(blocked.event.event, "SpendBlocked");
    assert.equal(blocked.event.args.reasonName, "LINE_RESERVE_CAP");

    const unknown = ok("line", ["receipt", "--digest", keccak256(toBytes("never signed"))]);
    assert.equal(unknown.receiptStatus, "none");
    assert.equal(unknown.event, null);
    // Without --from-block the lookup scans back from the head.
    assert.deepEqual(ok("line", ["receipt", "--digest", seen.paid.digest]).event, paid.event);
    assert.deepEqual(ok("line", ["receipt", "--digest", seen.blocked.digest]).event, blocked.event);
    // receiptStatus is authoritative: a scan that misses the log still reports it, with a hint.
    const pastIt = (seen.paid.receipt.blockNumber + 1n).toString();
    const missed = ok("line", ["receipt", "--digest", seen.paid.digest, "--from-block", pastIt]);
    assert.deepEqual([missed.digest, missed.receiptStatus, missed.event], [seen.paid.digest, "paid", null]);
    assert.match(
      missed.hint,
      new RegExp(`^receiptStatus is paid \\(authoritative\\), but no ProviderPaid log for this digest is in blocks ${pastIt}-${missed.observedAt.blockNumber}; pass an earlier --from-block$`),
    );

    // A manifest is trusted only when it passed, is for this chain and records
    // this contract's runtime code.
    const code = await publicClient.getCode({ address: float });
    const release = {
      ok: true,
      chainId: String(CHAIN_ID),
      contract: { address: float },
      bytecode: { onchainRuntimeKeccak256: keccak256(code) },
      deployment: { blockNumber: "0" },
    };
    const dir = mkdtempSync(join(tmpdir(), "float-sponsor-tools-"));
    try {
      const manifest = (name, value) => {
        writeFileSync(join(dir, name), JSON.stringify(value));
        return join(dir, name);
      };
      const good = manifest("manifest.json", release);
      const viaManifest = ok("line", ["receipt", "--digest", seen.paid.digest, "--manifest", good], { FLOAT_MAINNET_ADDRESS: "" });
      assert.deepEqual(viaManifest.event, paid.event);
      const byManifest = (file) => fails("line", ["receipt", "--digest", seen.paid.digest, "--manifest", file], { FLOAT_MAINNET_ADDRESS: "" }).message;
      assert.match(byManifest(manifest("failed.json", { ...release, ok: false })), /not a passing release manifest/);
      assert.match(byManifest(manifest("chain.json", { ...release, chainId: "5042" })), /is for chain 5042, not FLOAT_MAINNET_EXPECTED_CHAIN_ID 5042002/);
      const usdcCode = await publicClient.getCode({ address: usdc });
      const otherCode = manifest("code.json", { ...release, bytecode: { onchainRuntimeKeccak256: keccak256(usdcCode) } });
      assert.match(byManifest(otherCode), /runtime code at .* hashes to .*not the manifest's onchainRuntimeKeccak256/);
      assert.match(byManifest(manifest("nohash.json", { ...release, bytecode: {} })), /has no bytecode.onchainRuntimeKeccak256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default path: refused before dueAt, declared after it, and a later repayment is recovered exactly", async () => {
    const opened = ok("sponsor", openArgs(["--execute"]), SPONSOR());
    assert.equal(opened.epoch, "2");
    assert.equal(opened.lineId, expectedLineId(2n));
    const line2 = opened.lineId;

    const paid = await purchase({ lineId: line2, epoch: 2n, principal: 1_000_000n, nonce: 1n });
    assert.equal(paid.event.eventName, "ProviderPaid");

    const early = await sentNothing(sponsor.address, () => fails("sponsor", ["declare-default", "--line-id", line2], SPONSOR()));
    const remaining = /(\d+) seconds remaining/.exec(early.message);
    assert.ok(remaining && BigInt(remaining[1]) > 0n, early.message);
    await sentNothing(sponsor.address, () => fails("sponsor", ["declare-default", "--line-id", line2, "--execute"], SPONSOR()));
    // A Safe can take the call before dueAt, with the time it becomes executable.
    const prepared = await sentNothing(sponsor.address, () => ok("sponsor", ["declare-default", "--line-id", line2, "--calldata", "--from", sponsor.address]));
    assert.deepEqual([prepared.executableAt, prepared.simulated, prepared.calls.length], [paid.intent.dueAt.toString(), false, 1]);
    assert.deepEqual(decodeFunctionData({ abi: floatAbi, data: prepared.calls[0].data }), { functionName: "declareDefault", args: [line2] });

    const latest = await publicClient.getBlock();
    await testClient.increaseTime({ seconds: Number(paid.intent.dueAt - latest.timestamp + 1n) });
    await testClient.mine({ blocks: 1 });
    const due = ok("sponsor", ["declare-default", "--line-id", line2, "--calldata", "--from", sponsor.address]);
    assert.deepEqual([due.simulated, due.calls], [true, prepared.calls]);
    const declared = ok("sponsor", ["declare-default", "--line-id", line2, "--execute"], SPONSOR());
    assert.equal(declared.state, "DEFAULTED");
    assert.deepEqual(declared.events.map((entry) => entry.event), ["LineDefaulted"]);

    const nothing = await sentNothing(sponsor.address, () => fails("sponsor", ["claim-defaulted", "--line-id", line2], SPONSOR()));
    assert.match(nothing.message, /nothing to claim until repayment arrives/);

    const repaid = ok("repay", ["--line-id", line2, "--full", "--execute"], { FLOAT_AGENT_PRIVATE_KEY: AGENT_KEY });
    assert.equal(repaid.keyEnv, "FLOAT_AGENT_PRIVATE_KEY");
    assert.equal(repaid.repayer, agent.address);
    assert.deepEqual(repaid.after, { state: "DEFAULTED", principalOutstanding: "0", availableReserve: "0", recoveryAvailable: "1000000" });

    const before = await balance(sponsor.address);
    const claimed = ok("sponsor", ["claim-defaulted", "--line-id", line2, "--execute"], SPONSOR());
    assert.equal(claimed.amount, "1000000");
    assert.equal((await balance(sponsor.address)) - before, 1_000_000n);

    const final = lineStatus(line2);
    assert.equal(final.state, "DEFAULTED");
    assert.equal(final.recoveryAvailable, "0");
    assert.equal(final.availableReserve, "0");
    assert.equal(final.principalOutstanding, "0");
    assert.equal(final.providers[0].remaining.limitedBy, "LINE_DEFAULTED");
    assert.equal(await balance(float), 0n);
    assert.equal(await readFloat("totalCommittedCapital"), 0n);
  });
});
