import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { createPublicClient, createTestClient, createWalletClient, decodeFunctionData, defineChain, getAddress, http, zeroAddress } from "viem";
import { floatAbi } from "./float-mainnet-config.mjs";
import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";

const PORT = 18655;
const RPC = `http://127.0.0.1:${PORT}`;
const CAP_NAMES = ["protocol-reserve", "line-reserve", "line-spend", "per-spend", "daily-spend"];
const INITIAL = [25_000_000n, 5_000_000n, 5_000_000n, 1_000_000n, 2_000_000n];
const MAXIMA = [50_000_000n, 10_000_000n, 10_000_000n, 2_000_000n, 4_000_000n];
const artifact = (name) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));

describe("candidate owner controls through the CLI on a local chain", { skip: e2eSkip }, () => {
  const [owner, operator, nextOwner, stranger] = [0, 2, 3, 4].map(account);
  const chain = defineChain({ id: Number(CHAIN_ID), name: "anvil", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const client = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });
  const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  const wallet = (signer) => createWalletClient({ account: signer, chain, transport: http(RPC) });
  let anvil;
  let usdc;
  let float;

  const read = (functionName, args = []) => client.readContract({ address: float, abi: floatAbi, functionName, args });
  const cli = (args, keyIndex) => runTool("owner", args, {
    ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(), FLOAT_MAINNET_ADDRESS: float,
    ...(keyIndex === undefined ? {} : { FLOAT_OWNER_PRIVATE_KEY: keyOf(keyIndex) }),
  });
  async function ok(args, keyIndex) {
    const result = await cli(args, keyIndex);
    assert.equal(result.status, 0, JSON.stringify(result.json));
    assert.equal(result.json.ok, true);
    return result.json;
  }
  async function fails(args, keyIndex, pattern, status = 1) {
    const result = await cli(args, keyIndex);
    assert.equal(result.status, status, JSON.stringify(result.json));
    assert.equal(result.json.ok, false);
    assert.match(result.json.error.message, pattern);
    return result.json;
  }
  async function send(functionName, args) {
    const hash = await wallet(owner).writeContract({ address: float, abi: floatAbi, functionName, args });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
  }
  async function deploy(name, args) {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(owner).deployContract({ abi, bytecode: bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return getAddress(receipt.contractAddress);
  }
  async function sentNothing(action) {
    const before = await client.getBlockNumber({ cacheTime: 0 });
    const result = await action();
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before, "dry-run/calldata/invalid action mined a block");
    return result;
  }

  before(async () => {
    anvil = await startAnvil(PORT);
    usdc = await deploy("MockAsset", ["USD Coin", "USDC", 6]);
  });
  beforeEach(async () => {
    float = await deploy("ShadowFloatMainnet", [usdc, CHAIN_ID, MAXIMA, INITIAL, 3_600n, 604_800n, 172_800n]);
  });
  after(() => anvil?.stop());

  test("operator setup defaults to no send; key-free calldata encodes the exact role change", async () => {
    const dry = await sentNothing(() => ok(["allow-operator", "--operator", operator.address], 0));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.allowedBefore, false);
    assert.equal(await read("operators", [operator.address]), false);
    const encoded = await sentNothing(() => ok(["allow-operator", "--operator", operator.address, "--calldata", "--from", owner.address]));
    assert.deepEqual(decodeFunctionData({ abi: floatAbi, data: encoded.calls[0].data }), { functionName: "setOperator", args: [operator.address, true] });
    assert.deepEqual([encoded.calls[0].to, encoded.calls[0].value], [float, "0"]);
    const enabled = await ok(["allow-operator", "--operator", operator.address, "--execute"], 0);
    assert.equal(enabled.events[0].event, "OperatorSet");
    assert.equal(await read("operators", [operator.address]), true);
    await ok(["pause", "--what", "spends", "--execute"], 2);
    assert.equal(await read("spendsPaused"), true);
    await ok(["disallow-operator", "--operator", operator.address, "--execute"], 0);
    assert.equal(await read("operators", [operator.address]), false);
    await sentNothing(() => fails(["pause", "--what", "openings", "--execute"], 2, /is not owner\(\) or an operator/));
  });

  test("operator authority cannot grant roles, unpause, lower caps or propose an owner", async () => {
    await ok(["allow-operator", "--operator", operator.address, "--execute"], 0);
    for (const args of [
      ["allow-operator", "--operator", stranger.address],
      ["disallow-operator", "--operator", operator.address],
      ["allow-sponsor", "--sponsor", stranger.address],
      ["unpause", "--what", "spends"],
      ["reduce-cap", "--cap", "per-spend", "--value", "500000"],
      ["propose-owner", "--owner", nextOwner.address],
    ]) await sentNothing(() => fails([...args, "--execute"], 2, /is not owner\(\)/));
  });

  test("all five named caps encode the matching enum and reduce only the chosen cap", async () => {
    for (const [kind, cap] of CAP_NAMES.entries()) {
      const value = INITIAL[kind] / 2n;
      const encoded = await sentNothing(() => ok(["reduce-cap", "--cap", cap, "--value", value.toString(), "--calldata", "--from", owner.address]));
      assert.deepEqual(decodeFunctionData({ abi: floatAbi, data: encoded.calls[0].data }), { functionName: "reduceCap", args: [kind, value] });
      assert.equal(encoded.oldValue, INITIAL[kind].toString());
      const prior = await read("effectiveLimits");
      const result = await ok(["reduce-cap", "--cap", cap, "--value", value.toString(), "--execute"], 0);
      assert.equal(result.events.at(-1).event, "CapReduced");
      const expected = [...prior]; expected[kind] = value;
      assert.deepEqual(await read("effectiveLimits"), expected);
    }
  });

  test("reducing a cap cancels its queued increase; invalid or increasing values send nothing", async () => {
    await send("proposeCapIncrease", [3, 1_500_000n]);
    const dry = await sentNothing(() => ok(["reduce-cap", "--cap", "per-spend", "--value", "500000"], 0));
    assert.equal(dry.pendingBefore.value, "1500000");
    assert.equal((await read("pendingCaps", [3]))[0], 1_500_000n);
    const reduced = await ok(["reduce-cap", "--cap", "per-spend", "--value", "500000", "--execute"], 0);
    assert.deepEqual(reduced.events.map((event) => event.event), ["CapIncreaseCancelled", "CapReduced"]);
    assert.deepEqual(await read("pendingCaps", [3]), [0n, 0n]);
    for (const [value, pattern, status] of [["0", /must be positive/, 2], ["500001", /cannot increase/, 1], ["0.5", /unsigned decimal integer/, 2], [(2n ** 256n).toString(), /exceeds uint256/, 2]]) {
      await sentNothing(() => fails(["reduce-cap", "--cap", "per-spend", "--value", value, "--execute"], 0, pattern, status));
    }
    await sentNothing(() => fails(["reduce-cap", "--cap", "3", "--value", "1"], 0, /--cap must be one of/, 2));
    assert.equal((await read("effectiveLimits"))[3], 500_000n);
  });

  test("owner or operator can cancel a queued increase, even after its activation time", async () => {
    await ok(["allow-operator", "--operator", operator.address, "--execute"], 0);
    await send("proposeCapIncrease", [4, 3_000_000n]);
    await sentNothing(() => fails(["cancel-cap-increase", "--cap", "daily-spend", "--execute"], 4, /is not owner\(\) or an operator/));
    const encoded = await sentNothing(() => ok(["cancel-cap-increase", "--cap", "daily-spend", "--calldata", "--from", operator.address]));
    assert.deepEqual(decodeFunctionData({ abi: floatAbi, data: encoded.calls[0].data }), { functionName: "cancelCapIncrease", args: [4] });
    await testClient.increaseTime({ seconds: 172_801 });
    await testClient.mine({ blocks: 1 });
    const canceled = await ok(["cancel-cap-increase", "--cap", "daily-spend", "--execute"], 2);
    assert.equal(canceled.events[0].event, "CapIncreaseCancelled");
    assert.deepEqual(await read("pendingCaps", [4]), [0n, 0n]);
    assert.equal((await read("effectiveLimits"))[4], INITIAL[4]);
    await sentNothing(() => fails(["cancel-cap-increase", "--cap", "daily-spend", "--execute"], 0, /no pending cap increase/));
    await send("proposeCapIncrease", [4, 3_000_000n]);
    await ok(["cancel-cap-increase", "--cap", "daily-spend", "--execute"], 0);
    assert.deepEqual(await read("pendingCaps", [4]), [0n, 0n]);
  });

  test("ownership proposal preserves old authority until the exact pending owner accepts", async () => {
    await sentNothing(() => fails(["accept-owner", "--execute"], 3, /no pending ownership proposal/));
    const proposed = await sentNothing(() => ok(["propose-owner", "--owner", nextOwner.address, "--calldata", "--from", owner.address]));
    assert.deepEqual(decodeFunctionData({ abi: floatAbi, data: proposed.calls[0].data }), { functionName: "proposeOwner", args: [nextOwner.address] });
    assert.equal(await read("pendingOwner"), zeroAddress);
    await ok(["propose-owner", "--owner", nextOwner.address, "--execute"], 0);
    assert.equal(await read("owner"), owner.address);
    assert.equal(await read("pendingOwner"), nextOwner.address);
    await sentNothing(() => fails(["allow-operator", "--operator", operator.address, "--execute"], 3, /is not owner\(\)/));
    await sentNothing(() => fails(["accept-owner", "--execute"], 0, /is not pendingOwner\(\)/));
    const acceptance = await sentNothing(() => ok(["accept-owner", "--calldata", "--from", nextOwner.address]));
    assert.equal(decodeFunctionData({ abi: floatAbi, data: acceptance.calls[0].data }).functionName, "acceptOwnership");
    assert.equal(await read("owner"), owner.address);
    const accepted = await ok(["accept-owner", "--execute"], 3);
    assert.equal(accepted.events[0].event, "OwnershipAccepted");
    assert.equal(await read("owner"), nextOwner.address);
    assert.equal(await read("pendingOwner"), zeroAddress);
    await sentNothing(() => fails(["reduce-cap", "--cap", "line-spend", "--value", "1000000", "--execute"], 0, /is not owner\(\)/));
    await ok(["reduce-cap", "--cap", "line-spend", "--value", "1000000", "--execute"], 3);
  });

  test("invalid role addresses, omitted amounts and conflicting write modes fail before a send", async () => {
    for (const [args, pattern] of [
      [["allow-operator", "--operator", zeroAddress], /must not be the zero address/],
      [["propose-owner", "--owner", zeroAddress], /must not be the zero address/],
      [["allow-operator", "--operator", "nope"], /must be a 20-byte hex address/],
      [["reduce-cap", "--cap", "line-reserve"], /--value is required/],
      [["accept-owner", "--execute", "--calldata", "--from", owner.address], /exclusive/],
    ]) await sentNothing(() => fails(args, 0, pattern, 2));
  });
});
