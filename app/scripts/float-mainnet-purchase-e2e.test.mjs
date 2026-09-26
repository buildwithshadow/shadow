import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, getAddress, http, keccak256, stringToHex } from "viem";
import { createProviderServer } from "../../examples/float-mainnet-provider-server/server.mjs";
import { connectCandidate, eip712Domain, floatAbi, SPEND_INTENT_TYPES } from "./float-mainnet-config.mjs";
import { intentFile, structFromMessage } from "./float-mainnet-intent.mjs";
import { initializeExecutionSession, withExecutionSession } from "./float-mainnet-session.mjs";
import { account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { loadContext, runMonitorOnce } from "./float-mainnet-monitor-runner.mjs";
import { createPurchaseAdapter, loadPurchaseConfiguration, purchaseCatalog } from "./float-mainnet-purchase-adapter.mjs";
import { createPurchaseService } from "./float-mainnet-purchase-service.mjs";
import { initializePurchaseStore } from "./float-mainnet-purchase-store.mjs";

const CHAIN = 5042002n, PORT = 18670, RPC = `http://127.0.0.1:${PORT}`;
const TOKEN = "local-test-enrollment-token-" + "a".repeat(32), ORIGIN = "https://shadow.example";
const ENDPOINT = keccak256(stringToHex("https://provider.example/answer"));
const PRINCIPAL = 50_000n;
const LIMITS = { protocolReserve: 20_000_000n, lineReserve: 3_000_000n, lineSpend: 4_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };

test("real HTTP purchase, signed provider acceptance, monitored testnet payment and restart recovery", { skip: e2eSkip, timeout: 180_000 }, async (t) => {
  const anvil = await startAnvil(PORT, [], CHAIN);
  const dir = mkdtempSync(join(tmpdir(), "shadow-purchase-e2e-")), path = (s) => join(dir, s);
  let service, providerServer;
  t.after(async () => {
    if (service) await service.close();
    if (providerServer) { providerServer.closeAllConnections(); await new Promise((resolve) => providerServer.close(resolve)); }
    anvil.stop(); rmSync(dir, { recursive: true, force: true });
  });
  const [owner, sponsor, agent, executor, provider] = [0, 6, 7, 8, 9].map(account);
  const chain = defineChain({ id: Number(CHAIN), name: "local purchase test", nativeCurrency: { name: "test", symbol: "test", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const client = createPublicClient({ chain, transport: http(RPC) });
  const wallet = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });
  const artifact = (p) => JSON.parse(readFileSync(new URL(`../../contracts/out/${p}`, import.meta.url), "utf8"));
  async function write(a, address, abi, functionName, args) {
    const hash = await wallet(a).writeContract({ address, abi, functionName, args });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
  }
  let deployBlock;
  async function deploy(name, args) {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(owner).deployContract({ abi, bytecode: bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success"); deployBlock = receipt.blockNumber.toString();
    return getAddress(receipt.contractAddress);
  }
  const usdc = await deploy("MockAsset.sol/MockAsset.json", ["test USD", "USDC", 6]);
  const float = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [usdc, CHAIN, LIMITS, LIMITS, 3600n, 86400n, 172800n]);
  const env = { PATH: process.env.PATH, ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN.toString(), FLOAT_MAINNET_ADDRESS: float, FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(8) };
  const tool = async (name, args) => {
    const result = await runTool(name, args, env);
    assert.equal(result.status, 0, JSON.stringify(result.json)); return result.json;
  };
  await write(owner, usdc, artifact("MockAsset.sol/MockAsset.json").abi, "mint", [sponsor.address, 1_000_000n]);
  await write(owner, float, floatAbi, "setSponsorAllowed", [sponsor.address, true]);
  await write(sponsor, usdc, erc20Abi, "approve", [float, 1_000_000n]);
  const now = (await client.getBlock()).timestamp;
  await write(sponsor, float, floatAbi, "openLine", [{ agent: agent.address, reserve: 100_000n, lineSpendCap: 100_000n, dailySpendCap: 100_000n, lineExpiry: now + 604800n, maximumRepaymentWindow: 86400n, provider: provider.address, endpointHash: ENDPOINT, providerPerSpendCap: 100_000n, providerDailyCap: 100_000n, providerExpiry: now + 604800n }]);
  await write(owner, float, floatAbi, "setOpeningsPaused", [true]);
  const runtime = keccak256(await client.getCode({ address: float }));
  const manifest = { ok: true, chainId: CHAIN.toString(), contract: { address: float }, bytecode: { onchainRuntimeKeccak256: runtime }, deployment: { blockNumber: deployBlock } };
  writeFileSync(path("manifest.json"), JSON.stringify(manifest));
  const policy = { kind: "ShadowFloatMainnet.ExecutionSession", sessionId: "http-local-session", chainId: CHAIN.toString(), verifyingContract: float, runtimeKeccak256: runtime, executor: executor.address, sponsor: sponsor.address, agent: agent.address, provider: provider.address, endpointHash: ENDPOINT, maxGrossPrincipal: PRINCIPAL.toString(), ledgerDirectory: "./ledger" };
  writeFileSync(path("session.json"), JSON.stringify(policy));
  await tool("submit", ["init-session", "--session", path("session.json"), "--manifest", path("manifest.json")]);
  const snapshot = await tool("monitor", ["snapshot", "--manifest", path("manifest.json"), "--executor-from-block", deployBlock]);
  const baseline = { schemaVersion: 1, identity: { chainId: CHAIN.toString(), address: float, runtimeCodeHash: runtime, usdc, deployBlock },
    owner: owner.address, operators: [], sponsors: [sponsor.address], effectiveLimits: Object.fromEntries(Object.entries(LIMITS).map(([k,v]) => [k,String(v)])),
    pauses: { openingsPaused: true, spendsPaused: false }, executor: { address: executor.address, fromBlock: deployBlock },
    policy: { intervalMs: 1000, runTimeoutMs: 30000, maxHeartbeatAgeMs: 60000, maxBlockAgeSeconds: 300, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false },
    lines: snapshot.lines.map((line) => ({ lineId: line.lineId, sponsor: sponsor.address, agent: agent.address, epoch: line.epoch, reserveCap: line.reserveCap, lineSpendCap: line.lineSpendCap, dailySpendCap: line.dailySpendCap, maximumRepaymentWindow: line.maximumRepaymentWindow, termsVersion: line.termsVersion, expiry: line.expiry, allowedStates: ["OPEN", "DRAWN", "CLOSED"], providers: line.providers.map((p) => Object.fromEntries(["provider", "active", "endpointHash", "expiry", "perSpendCap", "dailySpendCap"].map((k) => [k,p[k]]))) })) };
  writeFileSync(path("baseline.json"), JSON.stringify(baseline));
  const context = loadContext({ baselinePath: path("baseline.json"), manifestPath: path("manifest.json"), stateDir: path("monitor") });
  assert.equal((await runMonitorOnce(context, { collect: async () => snapshot })).ok, true);
  const connection = await connectCandidate({ rpcUrl: RPC, expectedChainId: CHAIN, address: float, runtimeHash: runtime, deployBlock: BigInt(deployBlock) });
  let jobs = 0;
  providerServer = createProviderServer({ connection, account: provider, endpointHash: ENDPOINT, price: PRINCIPAL, storeDir: path("provider"), service: async ({ requestId }) => { jobs++; return { result: `answer for ${requestId}` }; } });
  await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const spec = { schemaVersion: 1, session: "session.json", manifest: "manifest.json", monitorBaseline: "baseline.json", monitorStateDir: "monitor", storeDir: "purchases", providerUrl: `http://127.0.0.1:${providerServer.address().port}`, serviceName: "local answer", principal: PRINCIPAL.toString(), origins: [ORIGIN] };
  writeFileSync(path("config.json"), JSON.stringify(spec));
  const config = loadPurchaseConfiguration(path("config.json"));
  initializePurchaseStore(config.spec.storeDir, config.binding);
  await assert.rejects(createPurchaseAdapter(config, { ...env, FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(9) }), /executor key does not match enrollment/);
  const adapter = await createPurchaseAdapter(config, env);
  const start = async () => {
    service = createPurchaseService({ directory: config.spec.storeDir, binding: config.binding, token: TOKEN, origins: [ORIGIN], catalog: purchaseCatalog(config), adapter });
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  };
  await start();
  const call = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${service.server.address().port}${route}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { httpStatus: res.status, ...await res.json() };
  };
  const p = await call("/v1/purchases", { requestId: "real-http-job" });
  assert.equal(p.ok, true, JSON.stringify(p));
  const route = `/v1/purchases/${p.id}`;
  const struct = structFromMessage(p.intent.typedData.message);
  const signature = await agent.signTypedData({ domain: eip712Domain(CHAIN, float), types: SPEND_INTENT_TYPES, primaryType: "SpendIntent", message: struct });
  const signatureWrong = await provider.signTypedData({ domain: eip712Domain(CHAIN, float), types: SPEND_INTENT_TYPES, primaryType: "SpendIntent", message: struct });
  assert.equal((await call(`${route}/submit`, { signature: signatureWrong })).httpStatus, 503);
  const heartbeatPath = path("monitor/heartbeat.json"), heartbeat = readFileSync(heartbeatPath, "utf8");
  writeFileSync(heartbeatPath, JSON.stringify({ ...JSON.parse(heartbeat), completedAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal((await call(`${route}/submit`, { signature })).httpStatus, 503);
  assert.equal((await call(route)).attempted, false);
  assert.equal(JSON.parse(readFileSync(path("ledger/ledger.json"))).entries.length, 0);
  // The CLI also enforces monitoring, independently of the HTTP preflight.
  const signedPath = path(`purchases/${p.id}/signed.json`);
  const noSession = await runTool("submit", ["submit", "--intent", signedPath, "--manifest", path("manifest.json"), "--execute", "--require-monitor"], env);
  assert.equal(noSession.status, 1); assert.match(noSession.json.error.message, /--session/);
  const denied = await runTool("submit", ["submit", "--intent", signedPath, "--session", path("session.json"), "--manifest", path("manifest.json"), "--execute", "--require-monitor", "--monitor-baseline", path("baseline.json"), "--monitor-state-dir", path("monitor")], env);
  assert.equal(denied.status, 1); assert.match(denied.json.error.message, /monitor/i);
  assert.equal(JSON.parse(readFileSync(path("ledger/ledger.json"))).entries.length, 0);
  writeFileSync(heartbeatPath, heartbeat);
  // Real transaction completes; deliberately lose the submit tool's response.
  const actualSend = adapter.send;
  let sends = 0;
  adapter.send = async (r) => { sends++; await actualSend(r); throw new Error("lost acknowledgement after real payment"); };
  const paid = await call(`${route}/submit`, { signature });
  assert.equal(paid.payment, "paid", JSON.stringify(paid));
  assert.equal(await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [provider.address] }), PRINCIPAL);
  const line = await client.readContract({ address: float, abi: floatAbi, functionName: "getLine", args: [struct.lineId] });
  assert.equal(line.principalOutstanding, PRINCIPAL);
  assert.equal(line.cumulativePrincipalPaid, PRINCIPAL);
  assert.equal(line.availableReserve, 50_000n);
  const nonce = await client.getTransactionCount({ address: executor.address });
  await service.close(); await start();
  assert.equal((await call(`${route}/submit`, { signature })).payment, "paid");
  const result = await call(`${route}/recover`, {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Buffer.from(result.result.bytes, "base64").toString(), "answer for real-http-job");
  providerServer.closeAllConnections();
  await new Promise((resolve) => providerServer.close(resolve));
  providerServer = undefined;
  await service.close(); await start();
  assert.deepEqual((await call(`${route}/recover`, {})).result, result.result, "durable bytes and signed receipt survive provider outage and API restart");
  assert.equal(jobs, 1); assert.equal(sends, 1);
  assert.equal(await client.getTransactionCount({ address: executor.address }), nonce);
  assert.equal(JSON.parse(readFileSync(path("ledger/ledger.json"))).entries.length, 1);
  assert.equal((await call("/v1/purchases", { requestId: "over-budget" })).httpStatus, 503);
  assert.equal(await client.getTransactionCount({ address: executor.address }), nonce);
  // Separate local fixture models interruption after beforeSend persisted a
  // hash but before broadcast. It must be observable, never eligible to resend.
  writeFileSync(path("pending-session.json"), JSON.stringify({ ...policy, sessionId: "local-pending-observation", ledgerDirectory: "./pending-ledger" }));
  await initializeExecutionSession(path("pending-session.json"), connection);
  const pendingStruct = { ...struct, nonce: struct.nonce + 1n };
  const pendingIntent = intentFile({ chainId: CHAIN, verifyingContract: float, struct: pendingStruct });
  const pendingHash = `0x${"ab".repeat(32)}`;
  await withExecutionSession(path("pending-session.json"), connection, async (ledger) => {
    ledger.reserve(pendingStruct, pendingIntent.digest);
    ledger.beforeSend(pendingIntent.digest, pendingHash);
    assert.throws(() => ledger.check(pendingStruct, pendingIntent.digest), /unresolved attempt/);
    assert.equal(ledger.recorded(pendingIntent.digest).txHash, pendingHash);
  });
  writeFileSync(path("pending-config.json"), JSON.stringify({ ...spec, session: "pending-session.json", storeDir: "pending-purchases" }));
  const pendingAdapter = await createPurchaseAdapter(loadPurchaseConfiguration(path("pending-config.json")), env);
  const observed = await pendingAdapter.status({ intent: pendingIntent });
  assert.equal(observed.payment, "pending"); assert.equal(observed.txHash, pendingHash);
  assert.equal(await client.getTransactionCount({ address: executor.address }), nonce);
  writeFileSync(path("cli-config.json"), JSON.stringify({ ...spec, storeDir: "cli-purchases" }));
  const cliConfig = loadPurchaseConfiguration(path("cli-config.json"));
  initializePurchaseStore(cliConfig.spec.storeDir, cliConfig.binding);
  const failedStart = await new Promise((resolve) => execFile(process.execPath,
    [fileURLToPath(new URL("./float-mainnet-purchase-server.mjs", import.meta.url)), "serve", "--config", path("cli-config.json"), "--port", String(service.server.address().port)],
    { env: { ...env, SHADOW_PURCHASE_TOKEN: TOKEN }, timeout: 10_000 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(failedStart.code, 1, "an occupied listening port must fail startup, not report success");
  assert.match(failedStart.stderr, /could not listen/);
  assert.equal(failedStart.stderr.includes(env.FLOAT_EXECUTOR_PRIVATE_KEY), false);
  // Mutating pinned config is not an implicit new enrollment or budget reset.
  writeFileSync(path("config.json"), JSON.stringify({ ...spec, principal: "1" }));
  assert.equal((await call("/v1/catalog")).httpStatus, 503);
  writeFileSync(path("session.json"), JSON.stringify({ ...policy, chainId: "5042" }));
  assert.throws(() => loadPurchaseConfiguration(path("config.json")), /testnet only/);
});
