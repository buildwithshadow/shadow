import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256, zeroAddress } from "viem";
import { evaluateActivation, observeActivation, validateActivationPlan, fileHash } from "./float-mainnet-activation.mjs";
import { CHAIN_ID, account, e2eSkip, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { floatAbi } from "./float-mainnet-config.mjs";
import { stableStringify } from "./float-mainnet-preflight.mjs";

const PORT = 18662, RPC = `http://127.0.0.1:${PORT}`;
const [deployer, sponsor, operator, executor, provider] = [0, 1, 2, 3, 4].map(account);
const chain = defineChain({ id: Number(CHAIN_ID), name: "local", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createPublicClient({ chain, transport: http(RPC), pollingInterval: 10 });
const wallet = (a) => createWalletClient({ chain, account: a, transport: http(RPC) });
const artifact = (name) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name.startsWith("Activation") ? "ActivationFixtures" : name}.sol/${name}.json`, import.meta.url), "utf8"));
const limits = { protocolReserve: "12000000", lineReserve: "3000000", lineSpend: "4000000", perSpend: "750000", dailySpend: "1500000" };
const h = (c) => `0x${c.repeat(64)}`;
let fixture, plan, token, safe, candidate, receipt, anvil;
async function deploy(name, args) {
  const a = artifact(name), tx = await wallet(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const mined = await client.waitForTransactionReceipt({ hash: tx });
  assert.equal(mined.status, "success"); return { address: getAddress(mined.contractAddress), receipt: mined };
}
async function send(address, abi, functionName, args, signer = deployer) {
  const tx = await wallet(signer).writeContract({ address, abi, functionName, args });
  assert.equal((await client.waitForTransactionReceipt({ hash: tx })).status, "success");
}
const ownerCall = (name, args) => send(safe, artifact("ActivationSafeFixture").abi, "execute", [candidate, encodeFunctionData({ abi: floatAbi, functionName: name, args })]);
async function observe(phase) {
  const pinned = await client.getBlock();
  const observation = await observeActivation(client, plan, phase, pinned);
  return JSON.parse(stableStringify(observation));
}
const evaluate = (p, phase, o, extra = {}) => evaluateActivation(p, phase, [o, structuredClone(o)], { now: Number(o.block.timestamp), ...extra });
const failed = (result, id) => assert.ok(result.checks.some((c) => c.id === id && c.status === "FAIL"), stableStringify(result));

describe("read-only activation stages using actual local candidate state", { skip: e2eSkip }, () => {
  before(async () => {
    anvil = await startAnvil(PORT);
    token = (await deploy("ActivationTokenFixture", [])).address;
    const singleton = (await deploy("ActivationSingletonFixture", [])).address;
    safe = (await deploy("ActivationSafeFixture", [singleton, deployer.address])).address;
    ({ address: candidate, receipt } = await deploy("ShadowFloatMainnet", [token, CHAIN_ID, Object.values(limits).map(BigInt), Object.values(limits).map(BigInt), 3600n, 86400n, 172800n]));
    const now = (await client.getBlock()).timestamp;
    plan = {
      schema: "shadow-activation-plan/v1", chainId: String(CHAIN_ID), address: candidate, deploymentBlock: String(receipt.blockNumber),
      runtimeHash: keccak256(await client.getCode({ address: candidate })), usdc: token, tokenCodeHash: keccak256(await client.getCode({ address: token })),
      tokenImplementation: null, tokenImplementationHash: null,
      deployer: deployer.address, sponsor: sponsor.address, operator: operator.address, executor: executor.address, provider: provider.address,
      agent: safe, agentCodeHash: keccak256(await client.getCode({ address: safe })), endpointHash: h("e"),
      effectiveLimits: limits, maximumLimits: limits, minimumRepaymentWindow: "3600", maximumRepaymentWindow: "86400", governanceDelay: "172800", maxAgeSeconds: 120,
      safe: { address: safe, singleton, proxyCodeHash: keccak256(await client.getCode({ address: safe })), singletonCodeHash: keccak256(await client.getCode({ address: singleton })),
        version: "1.5.0", owners: [deployer.address], threshold: "1", fallbackHandler: zeroAddress, fallbackCodeHash: null },
      line: { reserve: "3000000", lineSpendCap: "4000000", dailySpendCap: "1500000", maximumRepaymentWindow: "86400", expiry: String(now + 604800n),
        providerExpiry: String(now + 604800n), providerPerSpendCap: "750000", providerDailySpendCap: "1500000" }, monitorBaselineHash: "b".repeat(64),
    };
  });
  after(() => anvil?.stop());

  test("fresh unfunded deployment passes without inventing paused constructor state; no blocks mined by verifier", async () => {
    const before = await client.getBlockNumber({ cacheTime: 0 });
    const o = await observe("deployed");
    assert.equal(evaluate(plan, "deployed", o).ok, true);
    assert.equal(evaluate(plan, "deployed", o).releaseReady, false);
    failed(evaluate(plan, "contained", o), "pauses");
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
    fixture = o;
  });

  test("wrong runtime/token/network, partial discovery, mismatched providers and stale snapshot fail", () => {
    const cases = [
      ["contract_runtime", o => o.runtimeHash = h("a")], ["token_runtime", o => o.tokenCodeHash = h("a")],
      ["network_and_token", o => o.state.deploymentChainId = "5042"], ["full_discovery", o => o.discoveredFrom = "0"],
      ["exact_sponsors", o => o.state.sponsors = [sponsor.address.toLowerCase()]], ["exact_operators", o => o.state.operators = [operator.address.toLowerCase()]],
      ["zero_residual_allowance", o => o.state.allowance = "1"], ["no_pending_cap_increases", o => o.state.pendingCaps[0] = ["1", "1"]],
      ["token_unrestricted", o => o.state.blacklisted = [sponsor.address]], ["exact_funding_and_obligations", o => o.state.balance = "1"],
    ];
    for (const [id, change] of cases) { const o = structuredClone(fixture); change(o); failed(evaluate(plan, "deployed", o), id); }
    failed(evaluateActivation(plan, "deployed", [fixture, { ...fixture, runtimeHash: h("a") }]), "two_matching_observations");
    failed(evaluateActivation(plan, "deployed", [fixture, fixture], { now: Number(fixture.block.timestamp) + 121 }), "fresh_block");
  });

  test("plan refuses missing funding/roles, over-cap configuration, duplicate owners and malformed amounts", () => {
    for (const edit of [p => p.executor = zeroAddress, p => p.safe.owners.push(p.safe.owners[0]), p => p.line.reserve = "9999999999",
      p => p.line.reserve = "3.0", p => p.monitorBaselineHash = null, p => p.safe.singletonCodeHash = null, p => p.maxAgeSeconds = 301,
      p => p.line.maximumRepaymentWindow = "1", p => p.operator = p.deployer]) {
      const p = structuredClone(plan); edit(p); assert.throws(() => validateActivationPlan(p));
    }
  });

  test("contained deployment requires explicit pauses; proposed ownership is not accepted ownership", async () => {
    await send(candidate, floatAbi, "setOpeningsPaused", [true]);
    await send(candidate, floatAbi, "setSpendsPaused", [true]);
    assert.equal(evaluate(plan, "contained", await observe("contained")).ok, true);
    const dir = mkdtempSync(join(tmpdir(), "shadow-activation-cli-"));
    try {
      const planPath = join(dir, "plan.json"), manifestPath = join(dir, "manifest.json");
      writeFileSync(planPath, JSON.stringify(plan));
      writeFileSync(manifestPath, JSON.stringify({ ok: true, chainId: plan.chainId, contract: { address: candidate }, bytecode: { onchainRuntimeKeccak256: plan.runtimeHash }, deployment: { blockNumber: plan.deploymentBlock, deployer: plan.deployer } }));
      const args = ["check", "--plan", planPath, "--plan-sha256", fileHash(readFileSync(planPath)), "--manifest", manifestPath, "--manifest-sha256", fileHash(readFileSync(manifestPath)), "--phase", "contained"];
      const before = await client.getBlockNumber({ cacheTime: 0 });
      const result = await runTool("activation", args, { ARC_RPC_URL: RPC, ARC_RPC_URL_2: `http://localhost:${PORT}` });
      assert.equal(result.status, 0, stableStringify(result));
      assert.equal(result.json.ok, true); assert.equal(result.json.releaseReady, false);
      assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
      writeFileSync(planPath, JSON.stringify({ ...plan, executor: operator.address }));
      const changed = await runTool("activation", args, { ARC_RPC_URL: RPC, ARC_RPC_URL_2: `http://localhost:${PORT}` });
      assert.equal(changed.status, 1); assert.match(changed.json.error.message, /changed from the reviewed SHA256/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    await send(candidate, floatAbi, "proposeOwner", [safe]);
    const pending = await observe("owned");
    failed(evaluate(plan, "owned", pending), "pending_owner_cleared");
    failed(evaluate(plan, "owned", pending), "owner");
    await ownerCall("acceptOwnership", []);
    await ownerCall("setOperator", [operator.address, true]);
    const owned = await observe("owned");
    assert.equal(evaluate(plan, "owned", owned).ok, true, stableStringify(evaluate(plan, "owned", owned)));
    for (const [id, edit] of [["safe_owners_threshold", o => o.safe.threshold = "2"], ["safe_no_modules_or_guard", o => o.safe.modules = [executor.address]],
      ["safe_code_identity", o => o.safe.singletonCodeHash = h("a")], ["safe_fallback", o => o.safe.fallbackHandler = executor.address]]) {
      const o = structuredClone(owned); edit(o); failed(evaluate(plan, "owned", o), id);
    }
  });

  test("exact first funding and fresh matching monitoring required before enable phase", async () => {
    await ownerCall("setSponsorAllowed", [sponsor.address, true]); await ownerCall("setOpeningsPaused", [false]);
    const tokenAbi = artifact("ActivationTokenFixture").abi;
    await send(token, tokenAbi, "mint", [sponsor.address, 3000000n]);
    await send(token, tokenAbi, "approve", [candidate, 3000000n], sponsor);
    const t = plan.line;
    await send(candidate, floatAbi, "openLine", [{ agent: safe, reserve: BigInt(t.reserve), lineSpendCap: BigInt(t.lineSpendCap), dailySpendCap: BigInt(t.dailySpendCap),
      maximumRepaymentWindow: BigInt(t.maximumRepaymentWindow), lineExpiry: BigInt(t.expiry), provider: provider.address, endpointHash: plan.endpointHash,
      providerPerSpendCap: BigInt(t.providerPerSpendCap), providerDailyCap: BigInt(t.providerDailySpendCap), providerExpiry: BigInt(t.providerExpiry) }], sponsor);
    await ownerCall("setOpeningsPaused", [true]);
    const o = await observe("funded"); o.monitorCanonical = true;
    const manifestHash = "c".repeat(64), heartbeat = { kind: "shadow-monitor-heartbeat", ok: true, hold: false, completedAt: new Date(Number(o.block.timestamp) * 1000).toISOString(),
      chainId: plan.chainId, address: candidate, runtimeCodeHash: plan.runtimeHash, baselineHash: plan.monitorBaselineHash, manifestHash,
      observedAt: { blockNumber: o.block.number, blockHash: o.block.hash, timestamp: o.block.timestamp } };
    assert.equal(evaluate(plan, "funded", o, { heartbeat, manifestHash }).ok, true, stableStringify(evaluate(plan, "funded", o, { heartbeat, manifestHash })));
    failed(evaluate(plan, "funded", o), "fresh_monitor");
    failed(evaluate(plan, "funded", o, { heartbeat: { ...heartbeat, hold: true }, manifestHash }), "fresh_monitor");
    failed(evaluate(plan, "funded", o, { heartbeat: { ...heartbeat, baselineHash: "d".repeat(64) }, manifestHash }), "monitor_identity");
    failed(evaluate(plan, "enabled", o, { heartbeat, manifestHash }), "pauses");
    await ownerCall("setSpendsPaused", [false]);
    const enabled = await observe("enabled"); enabled.monitorCanonical = true;
    assert.equal(evaluate(plan, "enabled", enabled, { heartbeat, manifestHash }).ok, true);
    const drifted = structuredClone(enabled); drifted.state.owner = executor.address;
    failed(evaluate(plan, "enabled", drifted, { heartbeat, manifestHash }), "owner");
  });

  test("CLI refuses missing manifest, wrong manifest and signing flags without sending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-activation-"));
    try {
      const planPath = join(dir, "plan.json"), manifestPath = join(dir, "manifest.json");
      writeFileSync(planPath, JSON.stringify(plan)); writeFileSync(manifestPath, JSON.stringify({ ok: false }));
      const env = { ARC_RPC_URL: RPC, ARC_RPC_URL_2: `http://localhost:${PORT}` };
      for (const args of [["check", "--plan", planPath], ["check", "--plan", planPath, "--manifest", manifestPath, "--phase", "owned"], ["check", "--execute"]]) {
        const result = await runTool("activation", args, env); assert.notEqual(result.status, 0); assert.equal(result.json.ok, false);
      }
      assert.match(fileHash(readFileSync(planPath)), /^[a-f0-9]{64}$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
