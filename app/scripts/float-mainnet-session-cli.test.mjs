import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, getAddress, http, keccak256, stringToHex } from "viem";
import { eip712Domain, floatAbi, SPEND_INTENT_TYPES } from "./float-mainnet-config.mjs";
import { intentFile, structFromMessage } from "./float-mainnet-intent.mjs";
import { account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { loadContext, runMonitorOnce } from "./float-mainnet-monitor-runner.mjs";

// Local Anvil only. Chain 5042 exercises the mandatory policy boundary, using
// public deterministic test accounts and a locally deployed mock token.
const PORT = 18631;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN = 5042n;
const ENDPOINT = "https://provider.example/answer";
const PRINCIPAL = 300_000n;
const LIMITS = { protocolReserve: 20_000_000n, lineReserve: 3_000_000n, lineSpend: 4_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };

describe("durable execution session through real CLIs and local chain", { skip: e2eSkip }, () => {
  const [owner, sponsor, agent, executor, provider] = [0, 6, 7, 8, 9].map(account);
  const chain = defineChain({ id: Number(CHAIN), name: "local session test", nativeCurrency: { name: "test", symbol: "test", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const client = createPublicClient({ chain, transport: http(RPC) });
  const wallet = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });
  const artifact = (path) => JSON.parse(readFileSync(new URL(`../../contracts/out/${path}`, import.meta.url), "utf8"));
  let anvil, dir, usdc, float, lineId, policy, deployBlock, monitorArgs = [], monitorCycle = 0;
  const path = (name) => join(dir, name);
  const AGENT = { FLOAT_AGENT_PRIVATE_KEY: keyOf(7) };
  const EXECUTOR = { FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(8) };
  const cli = (tool, args, env = {}) => runTool(tool, args, { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN.toString(), FLOAT_MAINNET_ADDRESS: float, ...env });
  async function ok(tool, args, env) {
    const result = await cli(tool, args, env);
    assert.equal(result.status, 0, JSON.stringify(result.json));
    assert.equal(result.json.ok, true);
    return result.json;
  }
  async function fails(tool, args, pattern, env) {
    const result = await cli(tool, args, env);
    assert.equal(result.status, 1, JSON.stringify(result.json));
    assert.match(result.json.error.message, pattern);
    return result.json;
  }
  async function write(a, address, abi, functionName, args) {
    const hash = await wallet(a).writeContract({ address, abi, functionName, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt;
  }
  async function deploy(name, args) {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(owner).deployContract({ abi, bytecode: bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    if (name.startsWith("ShadowFloatMainnet")) deployBlock = receipt.blockNumber.toString();
    return getAddress(receipt.contractAddress);
  }
  async function open() {
    await write(owner, float, floatAbi, "setOpeningsPaused", [false]);
    const now = (await client.getBlock()).timestamp;
    await write(sponsor, float, floatAbi, "openLine", [{ agent: agent.address, reserve: 1_000_000n, lineSpendCap: 1_000_000n, dailySpendCap: 1_000_000n, lineExpiry: now + 604_800n, maximumRepaymentWindow: 86400n, provider: provider.address, endpointHash: keccak256(stringToHex(ENDPOINT)), providerPerSpendCap: 1_000_000n, providerDailyCap: 1_000_000n, providerExpiry: now + 604_800n }]);
    lineId = await client.readContract({ address: float, abi: floatAbi, functionName: "activeLineId", args: [sponsor.address, agent.address] });
    await write(owner, float, floatAbi, "setOpeningsPaused", [true]);
  }
  async function repayCloseOpen() {
    await write(agent, usdc, erc20Abi, "approve", [float, PRINCIPAL]);
    await write(agent, float, floatAbi, "repay", [lineId, PRINCIPAL]);
    await write(sponsor, float, floatAbi, "closeLine", [lineId]);
    await open();
  }
  const buildArgs = (name, extra = []) => ["build", "--sponsor", sponsor.address, "--agent", agent.address, "--provider", provider.address, "--endpoint", ENDPOINT, "--principal", PRINCIPAL.toString(), "--out", path(name), ...extra];
  async function signed(name) {
    const built = await ok("intent", buildArgs(name, ["--executor", executor.address, "--session", path("policy.json")]));
    await ok("intent", ["sign", "--intent", path(name), "--session", path("policy.json")], AGENT);
    return built;
  }
  const submitArgs = (name) => ["submit", "--intent", path(name), "--session", path("policy.json"), ...monitorArgs];
  const balance = () => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [provider.address] });
  async function refreshMonitor() {
    const manifestPath = path("manifest.json"), baselinePath = path("baseline.json"), stateDir = path(`monitor-${++monitorCycle}`);
    writeFileSync(manifestPath, JSON.stringify({ ok: true, chainId: CHAIN.toString(), contract: { address: float }, bytecode: { onchainRuntimeKeccak256: policy.runtimeKeccak256 }, deployment: { blockNumber: deployBlock } }));
    const snapshot = await ok("monitor", ["snapshot", "--manifest", manifestPath, "--executor-from-block", deployBlock]);
    // Explicit local fixture baseline; production tools never learn one from a snapshot.
    const baseline = { schemaVersion: 1, identity: { chainId: CHAIN.toString(), address: float, runtimeCodeHash: policy.runtimeKeccak256, usdc, deployBlock },
      owner: owner.address, operators: [], sponsors: [sponsor.address], effectiveLimits: Object.fromEntries(Object.entries(LIMITS).map(([k,v]) => [k,String(v)])),
      pauses: { openingsPaused: true, spendsPaused: false }, executor: { address: executor.address, fromBlock: deployBlock },
      policy: { intervalMs: 1000, runTimeoutMs: 30000, maxHeartbeatAgeMs: 60000, maxBlockAgeSeconds: 300, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false },
      lines: snapshot.lines.map(line => ({ lineId: line.lineId, sponsor: sponsor.address, agent: agent.address, epoch: line.epoch, reserveCap: line.reserveCap,
        lineSpendCap: line.lineSpendCap, dailySpendCap: line.dailySpendCap, maximumRepaymentWindow: line.maximumRepaymentWindow, termsVersion: line.termsVersion,
        expiry: line.expiry, allowedStates: ["OPEN", "DRAWN", "CLOSED"], providers: line.providers.map(p => Object.fromEntries(["provider", "active", "endpointHash", "expiry", "perSpendCap", "dailySpendCap"].map(k => [k,p[k]]))) })) };
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const context = loadContext({ baselinePath, manifestPath, stateDir });
    const result = await runMonitorOnce(context, { collect: async () => snapshot });
    assert.equal(result.ok, true, JSON.stringify(result));
    monitorArgs = ["--manifest", manifestPath, "--monitor-baseline", baselinePath, "--monitor-state-dir", stateDir];
    return { stateDir };
  }

  before(async () => {
    anvil = await startAnvil(PORT, [], CHAIN);
    dir = mkdtempSync(join(tmpdir(), "shadow-session-cli-"));
    usdc = await deploy("MockAsset.sol/MockAsset.json", ["test USD", "USDC", 6]);
    float = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [usdc, CHAIN, LIMITS, LIMITS, 3600n, 86400n, 172800n]);
    const mockAbi = artifact("MockAsset.sol/MockAsset.json").abi;
    await write(owner, usdc, mockAbi, "mint", [sponsor.address, 10_000_000n]);
    await write(owner, usdc, mockAbi, "mint", [agent.address, 2_000_000n]);
    await write(owner, float, floatAbi, "setSponsorAllowed", [sponsor.address, true]);
    await write(sponsor, usdc, erc20Abi, "approve", [float, 10_000_000n]);
    await open();
    policy = { kind: "ShadowFloatMainnet.ExecutionSession", sessionId: "local-cli-session", chainId: CHAIN.toString(), verifyingContract: float, runtimeKeccak256: keccak256(await client.getCode({ address: float })), executor: executor.address, sponsor: sponsor.address, agent: agent.address, provider: provider.address, endpointHash: keccak256(stringToHex(ENDPOINT)), maxGrossPrincipal: "600000", ledgerDirectory: "./ledger" };
    writeFileSync(path("policy.json"), JSON.stringify(policy));
  });
  after(() => { anvil?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("mainnet refuses wildcard intent and missing session before a send; dry run does not reserve", async () => {
    await fails("intent", buildArgs("wildcard.json"), /nonzero named --executor/);
    await fails("intent", buildArgs("missing-policy.json", ["--executor", executor.address]), /requires --session/);
    await ok("submit", ["init-session", "--session", path("policy.json")]);
    await signed("first.json");
    await fails("submit", ["submit", "--intent", path("first.json"), "--execute"], /requires --session/, EXECUTOR);
    await fails("submit", ["submit", "--intent", path("first.json"), "--session", path("missing-policy.json")], /ENOENT/, EXECUTOR);
    await fails("intent", buildArgs("wrong-executor.json", ["--executor", provider.address, "--session", path("policy.json")]), /intent executor does not match/);
    const first = structFromMessage(JSON.parse(readFileSync(path("first.json"), "utf8")).typedData.message);
    writeFileSync(path("wrong-executor.json"), JSON.stringify(intentFile({ chainId: CHAIN, verifyingContract: float, struct: { ...first, executor: provider.address } })));
    await fails("intent", ["sign", "--intent", path("wrong-executor.json"), "--session", path("policy.json")], /intent executor does not match/, AGENT);
    await fails("intent", ["verify", "--intent", path("wrong-executor.json"), "--session", path("policy.json")], /intent executor does not match/);
    const dry = await ok("submit", submitArgs("first.json"), EXECUTOR);
    assert.equal(dry.session.reservedGrossPrincipal, "0");
    assert.equal(await balance(), 0n);
  });

  test("a confirmed payment is counted once across separate submit processes", async () => {
    await fails("submit", [...submitArgs("first.json"), "--execute"], /healthy approved monitor/, EXECUTOR);
    assert.equal(JSON.parse(readFileSync(path("ledger/ledger.json"))).entries.length, 0);
    const { stateDir } = await refreshMonitor();
    const heartbeatPath = join(stateDir, "heartbeat.json"), heartbeat = JSON.parse(readFileSync(heartbeatPath));
    writeFileSync(heartbeatPath, JSON.stringify({ ...heartbeat, completedAt: "2000-01-01T00:00:00.000Z" }));
    await fails("submit", [...submitArgs("first.json"), "--execute"], /monitor/i, EXECUTOR);
    assert.equal(JSON.parse(readFileSync(path("ledger/ledger.json"))).entries.length, 0, "monitor rejection reserved an unsent attempt");
    await refreshMonitor();
    const paid = await ok("submit", [...submitArgs("first.json"), "--execute"], EXECUTOR);
    assert.equal(paid.status, "paid");
    assert.equal(paid.session.acceptedPrincipal, "300000");
    const nonce = await client.getTransactionCount({ address: executor.address });
    const retry = await ok("submit", [...submitArgs("first.json"), "--execute"], EXECUTOR);
    assert.equal(retry.status, "already-paid");
    assert.equal(retry.session.reservedGrossPrincipal, "300000");
    assert.equal(await client.getTransactionCount({ address: executor.address }), nonce);
    assert.equal(await balance(), PRINCIPAL);
  });

  test("broadcast interruption preserves the hash and reservation; restart reconciles without another payment", async () => {
    await repayCloseOpen();
    await signed("second.json");
    await refreshMonitor();
    let broadcast = false;
    const proxy = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const call = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      if (!broadcast) {
        const forwarded = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
        const text = await forwarded.text();
        if (call.method !== "eth_sendRawTransaction") return response.end(text);
        broadcast = true;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32603, message: "simulated interrupted confirmation" } }));
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    let uncertain;
    try {
      uncertain = await fails("submit", [...submitArgs("second.json"), "--execute"], /outcome.*unknown/, { ...EXECUTOR, ARC_RPC_URL: `http://127.0.0.1:${proxy.address().port}` });
    } finally { await new Promise((resolve) => proxy.close(resolve)); }
    assert.equal(broadcast, true);
    assert.equal(uncertain.status, "unknown");
    const entry = JSON.parse(readFileSync(path("ledger/ledger.json"), "utf8")).entries[1];
    assert.equal(entry.status, "pending");
    assert.equal(entry.txHash, uncertain.txHash);
    assert.equal(await balance(), 2n * PRINCIPAL);
    const nonce = await client.getTransactionCount({ address: executor.address });
    const recovered = await ok("submit", [...submitArgs("second.json"), "--execute"], EXECUTOR);
    assert.equal(recovered.status, "already-paid");
    assert.equal(recovered.session.acceptedPrincipal, "600000");
    assert.equal(recovered.session.remainingGrossPrincipal, "0");
    assert.equal(await client.getTransactionCount({ address: executor.address }), nonce);
  });

  test("repaid/closed/new epoch cannot reset the budget", async () => {
    await repayCloseOpen();
    await fails("intent", buildArgs("third.json", ["--executor", executor.address, "--session", path("policy.json")]), /budget exhausted/);
    // A separately produced signature must not bypass the executor boundary.
    // This is test harness code using public deterministic accounts, not a tool override.
    const previous = structFromMessage(JSON.parse(readFileSync(path("second.json"), "utf8")).typedData.message);
    const line = await client.readContract({ address: float, abi: floatAbi, functionName: "getLine", args: [lineId] });
    const termsHash = await client.readContract({ address: float, abi: floatAbi, functionName: "currentTermsHash", args: [lineId, provider.address] });
    const now = (await client.getBlock()).timestamp;
    const struct = { ...previous, lineId, lineEpoch: line.epoch, termsHash, nonce: previous.nonce + 1n, signatureExpiry: now + 600n, dueAt: now + 7200n };
    const signature = await agent.signTypedData({ domain: eip712Domain(CHAIN, float), types: SPEND_INTENT_TYPES, primaryType: "SpendIntent", message: struct });
    writeFileSync(path("third.json"), JSON.stringify(intentFile({ chainId: CHAIN, verifyingContract: float, struct, signature, signerKind: "eoa" })));
    const nonce = await client.getTransactionCount({ address: executor.address });
    await fails("submit", [...submitArgs("third.json"), "--execute"], /budget exhausted/, EXECUTOR);
    assert.equal(await client.getTransactionCount({ address: executor.address }), nonce);
    assert.equal(await balance(), 2n * PRINCIPAL);
  });

  test("calldata reservation persists with no hash and prevents unsafe resubmission", async () => {
    await refreshMonitor();
    writeFileSync(path("calldata-policy.json"), JSON.stringify({ ...policy, sessionId: "local-calldata-case", ledgerDirectory: "./calldata-ledger" }));
    const selected = ["--session", path("calldata-policy.json")];
    await ok("submit", ["init-session", ...selected]);
    const result = await ok("submit", ["submit", "--intent", path("third.json"), ...selected, ...monitorArgs, "--calldata", "--from", executor.address]);
    assert.equal(result.calls.length, 1);
    assert.equal(result.session.pending[0].txHash, null);
    await fails("submit", ["submit", "--intent", path("third.json"), ...selected, "--execute"], /unresolved attempt.*no resend/, EXECUTOR);
    const held = await fails("submit", ["reconcile-session", ...selected], /Original outcome remains unresolved/);
    assert.equal(held.status, "session-held");
    assert.equal(held.session.reservedGrossPrincipal, "300000");
  });
});
