import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  erc20Abi,
  getAddress,
  http,
} from "viem";

import { floatAbi } from "./float-mainnet-config.mjs";
import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { structFromMessage } from "./float-mainnet-intent.mjs";

// One pilot run, as the participants would do it: every step is a
// float-mainnet CLI in its own process with only its own role's key. The test
// itself only deploys the local candidate and a mock USDC, funds the sponsor
// and the agent, and reads chain state to check what the tools report.

const PORT = 18563;
const PROXY_PORT = 18565;
const FLAKY_PORT = 18573;
const RPC = `http://127.0.0.1:${PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const ENDPOINT = "https://provider.example/api/answer";
const SIXTY_DAYS = "+5184000";
const PRINCIPAL = 250_000n;
const MINIMUM_REPAYMENT_WINDOW = 3_600n;
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };
const LOG_RANGE_LIMIT = 10_000n;

describe("pilot lifecycle through the participant CLIs", { skip: e2eSkip }, () => {
  // Account index 1 is not used.
  const [owner, sponsor, agent, executor, provider] = [0, 6, 7, 8, 9].map(account);
  const OWNER = { FLOAT_OWNER_PRIVATE_KEY: keyOf(0) };
  const SPONSOR = { FLOAT_SPONSOR_PRIVATE_KEY: keyOf(6) };
  const AGENT = { FLOAT_AGENT_PRIVATE_KEY: keyOf(7) };
  const EXECUTOR = { FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(8) };
  const chain = defineChain({
    id: Number(CHAIN_ID),
    name: "anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC) });
  // Mining 1,000 blocks can take over 10 s once the chain is long.
  const slowTestClient = createTestClient({ chain, mode: "anvil", transport: http(RPC, { timeout: 120_000 }) });
  const walletOf = (signer) => createWalletClient({ account: signer, chain, transport: http(RPC) });
  const artifact = (path) => JSON.parse(readFileSync(new URL(`../../contracts/out/${path}`, import.meta.url), "utf8"));

  let anvil;
  let dir;
  let usdc;
  let float;
  const seen = {};

  async function deploy(path, args) {
    const { abi, bytecode } = artifact(path);
    const hash = await walletOf(owner).deployContract({ abi, bytecode: bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", path);
    return getAddress(receipt.contractAddress);
  }

  const readFloat = (functionName, args = []) => client.readContract({ address: float, abi: floatAbi, functionName, args });
  const balance = (address) => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  const path = (name) => join(dir, name);
  const structOf = (file) => structFromMessage(JSON.parse(readFileSync(file, "utf8")).typedData.message);
  const cli = (tool, args, env = {}) =>
    runTool(tool, args, { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(), FLOAT_MAINNET_ADDRESS: float, ...env });

  async function ok(tool, args, env) {
    const { status, json } = await cli(tool, args, env);
    assert.equal(status, 0, `${tool} ${args[0]}: ${JSON.stringify(json, null, 2)}`);
    assert.equal(json.ok, true);
    return json;
  }

  async function fails(tool, args, env, pattern) {
    const { status, json } = await cli(tool, args, env);
    assert.equal(status, 1, `${tool} ${args[0]}: ${JSON.stringify(json, null, 2)}`);
    assert.equal(json.ok, false);
    assert.match(json.error.message, pattern);
    return json;
  }

  // "Nothing was sent": the sender's nonce and the chain height are unchanged.
  // cacheTime 0: viem otherwise serves a block number up to 4 s old.
  async function sentNothing(address, run) {
    const [count, height] = await Promise.all([client.getTransactionCount({ address }), client.getBlockNumber({ cacheTime: 0 })]);
    const result = await run();
    assert.equal(await client.getTransactionCount({ address }), count, `${address} sent a transaction`);
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), height, "a block was mined");
    return result;
  }

  // Runs run(rpc) behind an RPC that relays everything until a transaction to
  // the Float has its receipt, then fails every later request: the send is
  // mined and confirmed, the reads after it are not answered.
  async function withReadsFailingAfterSend(run) {
    let mined = false;
    const proxy = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const call = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      if (mined) return response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "upstream unavailable" } }));
      const text = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body })).text();
      const receipt = call.method === "eth_getTransactionReceipt" ? JSON.parse(text).result : null;
      if (receipt?.to && getAddress(receipt.to) === float) mined = true;
      response.end(text);
    });
    await new Promise((resolve) => proxy.listen(FLAKY_PORT, "127.0.0.1", resolve));
    let result;
    try {
      result = await run(`http://127.0.0.1:${FLAKY_PORT}`);
    } finally {
      proxy.close();
    }
    assert.equal(mined, true, "no Float transaction was mined behind the proxy");
    return result;
  }

  const lineStatus = () => ok("line", ["status", "--sponsor", sponsor.address, "--agent", agent.address, "--provider", provider.address]);
  const buildArgs = (principal, out, extra = []) => [
    "build",
    "--agent", agent.address,
    "--sponsor", sponsor.address,
    "--provider", provider.address,
    "--endpoint", ENDPOINT,
    "--principal", principal.toString(),
    "--out", out,
    ...extra,
  ];
  const openArgs = (window) => [
    "open",
    "--agent", agent.address,
    "--provider", provider.address,
    "--endpoint", ENDPOINT,
    "--reserve", "1000000",
    "--line-spend-cap", "3000000",
    "--daily-cap", "1000000",
    "--line-expiry", SIXTY_DAYS,
    "--max-repayment-window", window,
    "--provider-per-spend", "1000000",
    "--provider-daily", "1000000",
    "--provider-expiry", SIXTY_DAYS,
    "--execute",
  ];

  before(async () => {
    // Anvil's time per mined block grows with the chain; not keeping every
    // historical state cuts the 12,000-block mine below by about a third.
    anvil = await startAnvil(PORT, ["--prune-history"]);
    dir = mkdtempSync(join(tmpdir(), "float-lifecycle-"));
    usdc = await deploy("MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6]);
    float = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [
      usdc,
      CHAIN_ID,
      MAXIMA,
      INITIAL,
      MINIMUM_REPAYMENT_WINDOW,
      604_800n,
      172_800n,
    ]);
    const { abi } = artifact("MockAsset.sol/MockAsset.json");
    for (const [holder, amount] of [[sponsor, 10_000_000n], [agent, 1_000_000n]]) {
      const hash = await walletOf(owner).writeContract({ address: usdc, abi, functionName: "mint", args: [holder.address, amount] });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    }
  });

  after(() => {
    anvil?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the owner allows the sponsor; the sponsor opens the pilot line, not one with too short a repayment window", async () => {
    await ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], OWNER);
    assert.equal(await readFloat("sponsorAllowed", [sponsor.address]), true);

    const tooShort = (MINIMUM_REPAYMENT_WINDOW + 899n).toString();
    await sentNothing(sponsor.address, () =>
      fails("sponsor", openArgs(tooShort), SPONSOR, /--max-repayment-window 4499 must be at least minimumRepaymentWindow 3600 \+ the default 900s signature validity \(4500\)/),
    );

    const sponsorBefore = await balance(sponsor.address);
    const opened = await ok("sponsor", openArgs("604800"), SPONSOR);
    assert.equal(opened.approvalIncluded, true);
    assert.equal(sponsorBefore - (await balance(sponsor.address)), 1_000_000n);
    seen.lineId = opened.lineId;

    const status = await lineStatus();
    assert.deepEqual([status.lineId, status.state, status.availableReserve, status.principalOutstanding], [seen.lineId, "OPEN", "1000000", "0"]);
    assert.deepEqual(status.providers[0].remaining, { nextSpendMax: "1000000", limitedBy: "LINE_RESERVE_CAP", binding: "line.availableReserve" });
    assert.match(status.remainingExactAt, /^observedAt: .*snapshot/);
  });

  test("the agent builds, signs and verifies; the executor preflights, prepares keyless calldata, and pays exactly once", async () => {
    const built = await ok("intent", buildArgs(PRINCIPAL, path("pilot.json")));
    assert.deepEqual([built.predictedOutcome.outcome, built.predictedOutcome.nextSpendMax], ["pay", "1000000"]);
    await ok("intent", ["sign", "--intent", path("pilot.json"), "--out", path("pilot-signed.json")], AGENT);
    const verified = await ok("intent", ["verify", "--intent", path("pilot-signed.json")]);
    assert.deepEqual([verified.fresh, verified.signatureValid, verified.predictedOutcome.outcome], [true, true, "pay"]);
    const preflight = await ok("submit", ["preflight", "--intent", path("pilot-signed.json"), "--from", executor.address]);
    assert.deepEqual([preflight.outcome, preflight.reason, preflight.from], ["pay", "NONE", executor.address]);

    // A Safe or contract executor has no key here: it takes the calldata.
    const unsigned = await sentNothing(executor.address, () =>
      ok("submit", ["submit", "--intent", path("pilot-signed.json"), "--calldata", "--from", executor.address]),
    );
    const signed = JSON.parse(readFileSync(path("pilot-signed.json"), "utf8"));
    assert.deepEqual([unsigned.calls.length, unsigned.calls[0].to, unsigned.calls[0].value, unsigned.simulation], [1, float, "0", { outcome: "pay", reason: "NONE" }]);
    // The Safe learns which block the simulation held at.
    const head = await client.getBlock();
    assert.deepEqual(unsigned.simulatedAt, { blockNumber: head.number.toString(), timestamp: head.timestamp.toString() });
    assert.deepEqual(decodeFunctionData({ abi: floatAbi, data: unsigned.calls[0].data }), {
      functionName: "executeSpend",
      args: [structOf(path("pilot-signed.json")), signed.signature],
    });

    // An RPC that fails right after the payment is mined does not cost the
    // outcome or its hash: everything after the send comes from the receipt.
    const providerBefore = await balance(provider.address);
    const paid = await withReadsFailingAfterSend((rpc) =>
      ok("submit", ["submit", "--intent", path("pilot-signed.json"), "--execute"], { ...EXECUTOR, ARC_RPC_URL: rpc }),
    );
    assert.deepEqual([paid.status, paid.providerPaid.principal, paid.digest], ["paid", PRINCIPAL.toString(), built.digest]);
    assert.deepEqual(paid.txHashes, [paid.txHash]);
    assert.equal((await client.getTransactionReceipt({ hash: paid.txHash })).status, "success");
    assert.equal((await balance(provider.address)) - providerBefore, PRINCIPAL);
    seen.paid = paid;

    const duplicate = await sentNothing(executor.address, () => ok("submit", ["submit", "--intent", path("pilot-signed.json"), "--execute"], EXECUTOR));
    assert.deepEqual([duplicate.status, duplicate.event.transactionHash, duplicate.txHashes], ["already-paid", paid.txHash, []]);
    assert.equal((await balance(provider.address)) - providerBefore, PRINCIPAL);
  });

  test("a DRAWN line refuses a new draw; repay --full reopens it; receipt finds the payment", async () => {
    await fails("intent", buildArgs(PRINCIPAL, path("x.json")), {}, /outstanding debt \(250000\); repay in full first/);
    const drawn = await lineStatus();
    assert.deepEqual([drawn.state, drawn.principalOutstanding, drawn.availableReserve], ["DRAWN", "250000", "750000"]);
    assert.deepEqual(drawn.providers[0].remaining, { nextSpendMax: "0", limitedBy: "LINE_DRAWN", binding: "line.state" });

    // A read failing after a partial repayment is mined reports status "sent"
    // with both hashes: a blind re-run of --amount would repay twice.
    const sentBefore = await client.getTransactionCount({ address: agent.address });
    const partial = await withReadsFailingAfterSend((rpc) =>
      cli("repay", ["--line-id", seen.lineId, "--amount", "100000", "--execute"], { ...AGENT, ARC_RPC_URL: rpc }),
    );
    assert.equal(partial.status, 1, JSON.stringify(partial.json, null, 2));
    const { json: sent } = partial;
    assert.deepEqual([sent.ok, sent.status, sent.dryRun, sent.amount, sent.txHashes.length, sent.after], [false, "sent", false, "100000", 2, undefined]);
    assert.equal(
      sent.error.message.replace(/follow-up read failed: .*; check/s, "follow-up read failed: <detail>; check"),
      `sent and mined: ${sent.txHashes.join(", ")}; follow-up read failed: <detail>; check these hashes before re-running`,
    );
    assert.match(sent.error.message, /RPC said: upstream unavailable/);
    assert.deepEqual(sent.events.map((entry) => entry.event), ["Repaid"]);
    for (const hash of sent.txHashes) assert.equal((await client.getTransactionReceipt({ hash })).status, "success");
    assert.equal(await client.getTransactionCount({ address: agent.address }), sentBefore + 2);
    assert.equal((await readFloat("getLine", [seen.lineId])).principalOutstanding, PRINCIPAL - 100_000n);

    const repaid = await ok("repay", ["--line-id", seen.lineId, "--full", "--execute"], AGENT);
    assert.equal(repaid.amount, (PRINCIPAL - 100_000n).toString());
    assert.deepEqual(repaid.after, { state: "OPEN", principalOutstanding: "0", availableReserve: "1000000" });
    assert.equal((await lineStatus()).state, "OPEN");

    const receipt = await ok("line", ["receipt", "--digest", seen.paid.digest]);
    assert.deepEqual([receipt.receiptStatus, receipt.event.event, receipt.event.transactionHash], ["paid", "ProviderPaid", seen.paid.txHash]);
  });

  test("an over-cap purchase is refused unless it is recorded deliberately with --allow-block at every step", async () => {
    const { remaining } = (await lineStatus()).providers[0];
    const overCap = BigInt(remaining.nextSpendMax) + 1n;
    const refused = await fails(
      "intent",
      buildArgs(overCap, path("x.json")),
      {},
      new RegExp(`refusing to build .*SpendBlocked\\(${remaining.limitedBy}\\).*principal ${overCap} exceeds nextSpendMax ${remaining.nextSpendMax} \\(limitedBy ${remaining.limitedBy}`),
    );
    assert.match(refused.error.message, /pass --allow-block/);

    const built = await ok("intent", buildArgs(overCap, path("over.json"), ["--allow-block"]));
    assert.deepEqual([built.predictedOutcome.outcome, built.predictedOutcome.reason], ["block", remaining.limitedBy]);
    await fails("intent", ["sign", "--intent", path("over.json"), "--out", path("x.json")], AGENT, /refusing to sign/);
    await ok("intent", ["sign", "--intent", path("over.json"), "--out", path("over-signed.json"), "--allow-block"], AGENT);
    const verified = await ok("intent", ["verify", "--intent", path("over-signed.json")]);
    assert.deepEqual([verified.predictedOutcome.outcome, verified.predictedOutcome.reason], ["block", remaining.limitedBy]);

    const providerBefore = await balance(provider.address);
    await sentNothing(executor.address, () =>
      fails("submit", ["submit", "--intent", path("over-signed.json"), "--execute"], EXECUTOR, /would record SpendBlocked.*Pass --allow-block/),
    );
    await sentNothing(executor.address, () =>
      fails("submit", ["submit", "--intent", path("over-signed.json"), "--calldata", "--from", executor.address], {}, /would record SpendBlocked/),
    );
    const blocked = await ok("submit", ["submit", "--intent", path("over-signed.json"), "--execute", "--allow-block"], EXECUTOR);
    assert.deepEqual([blocked.status, blocked.reason], ["blocked", remaining.limitedBy]);
    assert.equal(await balance(provider.address), providerBefore);
    assert.equal(await readFloat("nonceUsed", [seen.lineId, structOf(path("over-signed.json")).nonce]), true);
    const status = await lineStatus();
    assert.deepEqual([status.state, status.availableReserve, status.principalOutstanding], ["OPEN", "1000000", "0"]);
    seen.blocked = blocked;
  });

  test("a keyless agent cancels a signed intent's nonce with the calldata cancel-nonce prints", async () => {
    await ok("intent", buildArgs(PRINCIPAL, path("spare.json")));
    await ok("intent", ["sign", "--intent", path("spare.json"), "--out", path("spare-signed.json")], AGENT);
    const { nonce } = structOf(path("spare-signed.json"));
    const unsigned = await sentNothing(agent.address, () =>
      ok("cancel-nonce", ["--line-id", seen.lineId, "--nonce", nonce.toString(), "--calldata", "--from", agent.address]),
    );
    assert.deepEqual(decodeFunctionData({ abi: floatAbi, data: unsigned.calls[0].data }), { functionName: "cancelNonce", args: [seen.lineId, nonce] });
    // The agent's own wallet (standing in for a smart account) sends it as printed.
    const hash = await walletOf(agent).sendTransaction({ to: unsigned.calls[0].to, data: unsigned.calls[0].data, value: 0n });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    const verified = await cli("intent", ["verify", "--intent", path("spare-signed.json")]);
    assert.equal(verified.status, 1);
    assert.match(verified.json.error.message, /nonce: nonce cancelled by the agent/);
  });

  test("close returns exactly the reserve to the sponsor", async () => {
    const before = await balance(sponsor.address);
    const closed = await ok("sponsor", ["close", "--line-id", seen.lineId, "--execute"], SPONSOR);
    assert.deepEqual([closed.amount, closed.state], ["1000000", "CLOSED"]);
    assert.equal((await balance(sponsor.address)) - before, 1_000_000n);
    assert.equal(await balance(float), 0n);
    assert.equal(await readFloat("totalCommittedCapital"), 0n);
  });

  test("behind an RPC that limits eth_getLogs ranges, a re-run submit still reports the recorded outcome and sends nothing", async () => {
    // Rejects eth_getLogs spanning more than LOG_RANGE_LIMIT blocks (or with a
    // block tag instead of a number), as Arc's public RPC does; with
    // rejectLogs it rejects every eth_getLogs.
    let rejectLogs = false;
    const proxy = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const call = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      if (call.method === "eth_getLogs") {
        const { fromBlock, toBlock } = call.params[0] ?? {};
        const numeric = [fromBlock, toBlock].every((bound) => typeof bound === "string" && /^0x[0-9a-f]+$/i.test(bound));
        if (rejectLogs || !numeric || BigInt(toBlock) - BigInt(fromBlock) + 1n > LOG_RANGE_LIMIT) {
          const message = rejectLogs ? "eth_getLogs is unavailable" : `eth_getLogs is limited to a ${LOG_RANGE_LIMIT} block range`;
          return response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message } }));
        }
      }
      const upstream = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
      response.end(await upstream.text());
    });
    await new Promise((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve));
    try {
      for (let mined = 0; mined < 12_000; mined += 1_000) await slowTestClient.mine({ blocks: 1_000 });
      const head = await client.getBlockNumber();
      assert.ok(head - BigInt(seen.paid.providerPaid.blockNumber) > 12_000n);
      // The proxy really refuses the single wide query the lookup used to make.
      const limited = createPublicClient({ chain, transport: http(PROXY, { retryCount: 0 }) });
      await assert.rejects(
        limited.getLogs({ address: float, fromBlock: 0n, toBlock: head }),
        (error) => /limited to a 10000 block range/.test(`${error.details} ${error.message}`),
      );

      const viaProxy = { ...EXECUTOR, ARC_RPC_URL: PROXY };
      const rerun = await sentNothing(executor.address, () => ok("submit", ["submit", "--intent", path("pilot-signed.json"), "--execute"], viaProxy));
      assert.deepEqual(
        [rerun.status, rerun.event.event, rerun.event.transactionHash, rerun.event.args.digest, rerun.hint],
        ["already-paid", "ProviderPaid", seen.paid.txHash, seen.paid.digest, undefined],
      );
      const preflight = await ok("submit", ["preflight", "--intent", path("over-signed.json")], viaProxy);
      assert.deepEqual(
        [preflight.outcome, preflight.reason, preflight.event.transactionHash, preflight.event.args.reasonName],
        ["already-blocked", seen.blocked.reason, seen.blocked.txHash, seen.blocked.reason],
      );
      const receipt = await ok("line", ["receipt", "--digest", seen.paid.digest], { ARC_RPC_URL: PROXY });
      assert.equal(receipt.event.transactionHash, seen.paid.txHash);

      // receiptStatus is authoritative: a lookup that finds nothing, or fails,
      // is reported with a hint and the command still succeeds.
      const pastIt = (BigInt(seen.paid.providerPaid.blockNumber) + 1n).toString();
      const notFound = await ok("submit", ["submit", "--intent", path("pilot-signed.json"), "--from-block", pastIt], viaProxy);
      assert.deepEqual([notFound.status, notFound.event], ["already-paid", null]);
      assert.match(notFound.hint, new RegExp(`receiptStatus is paid \\(authoritative\\), but no ProviderPaid log for this digest is in blocks from ${pastIt}; pass --from-block`));
      rejectLogs = true;
      const paidAnyway = await sentNothing(executor.address, () => ok("submit", ["submit", "--intent", path("pilot-signed.json"), "--execute"], viaProxy));
      assert.deepEqual([paidAnyway.status, paidAnyway.reason, paidAnyway.event, paidAnyway.txHashes], ["already-paid", "NONE", null, []]);
      assert.match(paidAnyway.hint, /receiptStatus is paid \(authoritative\); looking up its ProviderPaid log .* failed \(.*; RPC said: eth_getLogs is unavailable\)/s);
      const blockedAnyway = await ok("submit", ["preflight", "--intent", path("over-signed.json")], viaProxy);
      assert.deepEqual([blockedAnyway.outcome, blockedAnyway.reason, blockedAnyway.event], ["already-blocked", null, null]);
      assert.match(blockedAnyway.hint, /receiptStatus is blocked \(authoritative\); looking up its SpendBlocked log/);
      // line receipt, too, reports the authoritative status when its lookup fails.
      const receiptAnyway = await ok("line", ["receipt", "--digest", seen.paid.digest], { ARC_RPC_URL: PROXY });
      assert.deepEqual([receiptAnyway.digest, receiptAnyway.receiptStatus, receiptAnyway.event], [seen.paid.digest, "paid", null]);
      assert.match(
        receiptAnyway.hint,
        /^receiptStatus is paid \(authoritative\); looking up its ProviderPaid log in the last 1000000 blocks failed \(.*; RPC said: eth_getLogs is unavailable\); retry, or narrow the scan with --from-block <n>$/s,
      );
      const bounded = await ok("line", ["receipt", "--digest", seen.blocked.digest, "--from-block", "0"], { ARC_RPC_URL: PROXY });
      assert.deepEqual([bounded.receiptStatus, bounded.event], ["blocked", null]);
      assert.match(bounded.hint, new RegExp(`^receiptStatus is blocked \\(authoritative\\); looking up its SpendBlocked log in blocks 0-${bounded.observedAt.blockNumber} failed`));
    } finally {
      proxy.close();
    }
  });
});
