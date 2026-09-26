import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPublicClient, createTestClient, createWalletClient, decodeFunctionData, defineChain, erc20Abi, getAddress, http, keccak256, zeroAddress } from "viem";

import { floatAbi } from "./float-mainnet-config.mjs";
import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { CAP_KINDS, lineMismatches, reconcileState } from "./float-mainnet-monitor.mjs";
import { stableStringify } from "./float-mainnet-preflight.mjs";

// The pilot monitor and reconciliation, driven like a scheduled job next to a
// pilot run through the participant CLIs. The test itself only deploys, funds,
// moves time, sends the owner calls no CLI covers (setOperator,
// proposeCapIncrease, cancelCapIncrease, reduceCap and proposeOwner), makes one
// direct USDC transfer to the Float and edits copies of an index file.

const PORT = 18650;
const RPC = `http://127.0.0.1:${PORT}`;
const ENDPOINT = "https://provider.example/api/answer";
const SIXTY_DAYS = "+5184000";
const PRINCIPAL = 250_000n;
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };
const MINIMUM_REPAYMENT_WINDOW = 3_600n;
const GOVERNANCE_DELAY = 172_800n;

const source = readFileSync(new URL("../../contracts/src/ShadowFloatMainnet.sol", import.meta.url), "utf8");
const alertList = (json) => json.alerts.map((entry) => [entry.code, entry.severity, entry.lineId ?? null]);

test("cap kinds follow the contract's CapKind declaration order", () => {
  const members = source.match(/enum CapKind \{([^}]*)\}/)[1].split(",").map((member) => member.trim()).filter(Boolean);
  assert.deepEqual(CAP_KINDS, members);
});

test("each line state has its identity with reserveCap, and each field breaks it on its own", () => {
  const CAP = 1_000_000n;
  const line = (state, availableReserve, principalOutstanding, recoveryAvailable, sponsorClaimed = 0n) => ({
    state,
    reserveCap: CAP,
    availableReserve,
    principalOutstanding,
    recoveryAvailable,
    sponsorClaimed,
  });
  const consistent = [
    line("OPEN", CAP, 0n, 0n),
    line("DRAWN", 750_000n, 250_000n, 0n),
    line("CLOSED", 0n, 0n, 0n),
    // Just defaulted; claimed with principal left; then recovery repaid after the claim.
    line("DEFAULTED", 750_000n, 250_000n, 0n),
    line("DEFAULTED", 0n, 150_000n, 0n, 850_000n),
    line("DEFAULTED", 0n, 100_000n, 50_000n, 850_000n),
  ];
  for (const entry of consistent) assert.deepEqual(lineMismatches(entry), [], stableStringify(entry));

  const broken = [
    [line("OPEN", CAP - 1n, 0n, 0n), "availableReserve + principalOutstanding 999999 is not reserveCap 1000000"],
    [line("OPEN", CAP - 1n, 1n, 0n), "principalOutstanding 1 is not 0"],
    [line("OPEN", CAP, 0n, 1n), "recoveryAvailable 1 is not 0"],
    [line("DRAWN", 750_000n, 250_001n, 0n), "availableReserve + principalOutstanding 1000001 is not reserveCap 1000000"],
    [line("DRAWN", 750_000n, 250_000n, 1n), "recoveryAvailable 1 is not 0"],
    [line("DRAWN", CAP, 0n, 0n), "principalOutstanding is 0 on a DRAWN line"],
    [line("CLOSED", 1n, 0n, 0n), "availableReserve 1 is not 0"],
    [line("CLOSED", 0n, 1n, 0n), "principalOutstanding 1 is not 0"],
    [line("CLOSED", 0n, 0n, 1n), "recoveryAvailable 1 is not 0"],
  ];
  const defaultedOff = "availableReserve + principalOutstanding + recoveryAvailable + SponsorClaimed amounts 1000001 is not reserveCap 1000000";
  for (const entry of [
    line("DEFAULTED", 1n, 100_000n, 50_000n, 850_000n),
    line("DEFAULTED", 0n, 100_001n, 50_000n, 850_000n),
    line("DEFAULTED", 0n, 100_000n, 50_001n, 850_000n),
    line("DEFAULTED", 0n, 100_000n, 50_000n, 850_001n),
  ]) {
    broken.push([entry, defaultedOff]);
  }
  for (const [entry, mismatch] of broken) assert.deepEqual(lineMismatches(entry), [mismatch], mismatch);
});

test("the line-sum and per-line identities hold for consistent state and FAIL on each mismatch", () => {
  // One line of each shape: OPEN, DRAWN after a partial repayment, and
  // DEFAULTED after a claim of 200000 with principal still unrepaid and new recovery.
  const lines = [
    { lineId: "open", state: "OPEN", reserveCap: 1_000_000n, availableReserve: 1_000_000n, principalOutstanding: 0n, recoveryAvailable: 0n, sponsorClaimed: 0n },
    { lineId: "drawn", state: "DRAWN", reserveCap: 1_000_000n, availableReserve: 600_000n, principalOutstanding: 400_000n, recoveryAvailable: 0n, sponsorClaimed: 0n },
    {
      lineId: "defaulted",
      state: "DEFAULTED",
      reserveCap: 1_000_000n,
      availableReserve: 0n,
      principalOutstanding: 700_000n,
      recoveryAvailable: 100_000n,
      sponsorClaimed: 200_000n,
    },
  ];
  const consistent = { balance: 1_700_000n, totalSponsorObligations: 1_700_000n, totalCommittedCapital: 2_800_000n, lines };
  const status = (result) => Object.fromEntries(result.checks.map((entry) => [entry.id, entry.status]));
  const clean = reconcileState(consistent);
  assert.deepEqual([clean.ok, clean.surplus, status(clean)], [
    true,
    0n,
    { balanceCoversObligations: "PASS", obligationsEqualLines: "PASS", committedCapitalEqualsLines: "PASS", linesMatchReserveCap: "PASS" },
  ]);
  assert.deepEqual(clean.sums, { availableReserve: 1_600_000n, principalOutstanding: 1_100_000n, recoveryAvailable: 100_000n });

  const surplus = reconcileState({ ...consistent, balance: 1_700_001n });
  assert.deepEqual([surplus.ok, surplus.surplus], [true, 1n]);
  assert.match(surplus.checks[0].detail, /surplus of 1: USDC sent to the Float outside its functions/);

  const short = reconcileState({ ...consistent, balance: 1_699_999n });
  assert.deepEqual([short.ok, short.surplus, status(short).balanceCoversObligations], [false, 0n, "FAIL"]);
  assert.match(short.checks[0].detail, /^CAP-02 broken: balance 1699999 is 1 below totalSponsorObligations 1700000$/);

  // A line missing from the discovered set, or one whose fields disagree with
  // the totals, fails the identities it enters.
  const missing = reconcileState({ ...consistent, lines: lines.slice(0, 2) });
  assert.deepEqual([missing.ok, status(missing)], [
    false,
    { balanceCoversObligations: "PASS", obligationsEqualLines: "FAIL", committedCapitalEqualsLines: "FAIL", linesMatchReserveCap: "PASS" },
  ]);
  const principalOff = reconcileState({ ...consistent, lines: [...lines.slice(0, 2), { ...lines[2], principalOutstanding: 699_999n }] });
  assert.deepEqual([principalOff.ok, status(principalOff)], [
    false,
    { balanceCoversObligations: "PASS", obligationsEqualLines: "PASS", committedCapitalEqualsLines: "FAIL", linesMatchReserveCap: "FAIL" },
  ]);
  assert.match(principalOff.checks[2].detail, /^totalCommittedCapital 2800000; sum over 3 lines of availableReserve \+ principalOutstanding \+ recoveryAvailable 2799999$/);
  const recoveryOff = reconcileState({ ...consistent, totalSponsorObligations: 1_600_000n, balance: 1_600_000n });
  assert.deepEqual(status(recoveryOff), {
    balanceCoversObligations: "PASS",
    obligationsEqualLines: "FAIL",
    committedCapitalEqualsLines: "PASS",
    linesMatchReserveCap: "PASS",
  });

  // Equal and opposite errors on two lines (reserve moved from the OPEN line to
  // the DRAWN one, a CAP-01 breach) leave every total intact: only the
  // per-line identities catch them.
  const moved = reconcileState({
    ...consistent,
    lines: [{ ...lines[0], availableReserve: 900_000n }, { ...lines[1], availableReserve: 700_000n }, lines[2]],
  });
  assert.deepEqual([moved.ok, status(moved)], [
    false,
    { balanceCoversObligations: "PASS", obligationsEqualLines: "PASS", committedCapitalEqualsLines: "PASS", linesMatchReserveCap: "FAIL" },
  ]);
  assert.equal(
    moved.checks[3].detail,
    "2 of 3 lines break their identity with reserveCap: open (OPEN): availableReserve + principalOutstanding 900000 is not reserveCap 1000000; drawn (DRAWN): availableReserve + principalOutstanding 1100000 is not reserveCap 1000000",
  );
});

test("check and reconcile require the release manifest", async () => {
  for (const command of ["check", "reconcile"]) {
    const { status, json } = await runTool("monitor", [command], { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString() });
    assert.equal(status, 2);
    assert.match(json.error.message, /^--manifest <release manifest> is required/);
  }
});

describe("pilot monitor and reconciliation through the participant CLIs", { skip: e2eSkip }, () => {
  // Account index 1 never signs: it is only the proposed owner in the last test.
  const [owner, sponsor, agentA, agentB, executor, provider, operator] = [0, 2, 3, 4, 5, 6, 7].map(account);
  const OWNER = { FLOAT_OWNER_PRIVATE_KEY: keyOf(0) };
  const SPONSOR = { FLOAT_SPONSOR_PRIVATE_KEY: keyOf(2) };
  const AGENT_A = { FLOAT_AGENT_PRIVATE_KEY: keyOf(3) };
  const AGENT_B = { FLOAT_AGENT_PRIVATE_KEY: keyOf(4) };
  const EXECUTOR = { FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(5) };
  // The owner tool signs pauses with FLOAT_OWNER_PRIVATE_KEY; an operator uses its own key there.
  const OPERATOR = { FLOAT_OWNER_PRIVATE_KEY: keyOf(7) };
  const chain = defineChain({
    id: Number(CHAIN_ID),
    name: "anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC) });
  const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  const walletOf = (signer) => createWalletClient({ account: signer, chain, transport: http(RPC) });
  const artifact = (path) => JSON.parse(readFileSync(new URL(`../../contracts/out/${path}`, import.meta.url), "utf8"));

  let anvil;
  let dir;
  let usdc;
  let float;
  let deployBlock;
  let manifest;
  const seen = {};
  const path = (name) => join(dir, name);

  async function deploy(name, args) {
    const { abi, bytecode } = artifact(name);
    const receipt = await client.waitForTransactionReceipt({ hash: await walletOf(owner).deployContract({ abi, bytecode: bytecode.object, args }) });
    assert.equal(receipt.status, "success", name);
    return receipt;
  }

  async function ownerCall(functionName, args) {
    const hash = await walletOf(owner).writeContract({ address: float, abi: floatAbi, functionName, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", functionName);
    return receipt;
  }

  // Every command names the deployment by its release manifest.
  const cli = (tool, args, env = {}) =>
    runTool(tool, [...args, "--manifest", manifest], { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(), ...env });

  async function ok(tool, args, env) {
    const { status, json } = await cli(tool, args, env);
    assert.equal(status, 0, `${tool} ${args[0]}: ${JSON.stringify(json, null, 2)}`);
    assert.equal(json.ok, true);
    return json;
  }

  // A monitor run: exit 0 with ok true, or exit 1 with ok false (a critical
  // alert or a reconciliation mismatch), never an error.
  async function monitor(args, expectedStatus = 0) {
    const { status, json } = await cli("monitor", args);
    assert.equal(status, expectedStatus, `monitor ${args.join(" ")}: ${JSON.stringify(json, null, 2)}`);
    assert.equal(json.ok, expectedStatus === 0);
    assert.equal(json.error, undefined);
    return json;
  }

  const lineOf = (json, lineId) => json.lines.find((entry) => entry.lineId === lineId) ?? assert.fail(`no line ${lineId}`);
  // The fields of a reconcile line that its identity with reserveCap uses.
  const identityOf = ({ state, reserveCap, availableReserve, principalOutstanding, recoveryAvailable, sponsorClaimed }) => ({
    state,
    reserveCap,
    availableReserve,
    principalOutstanding,
    recoveryAvailable,
    sponsorClaimed,
  });
  const statuses = (json) => Object.fromEntries(json.checks.map((entry) => [entry.id, entry.status]));
  const ALL_PASS = { balanceCoversObligations: "PASS", obligationsEqualLines: "PASS", committedCapitalEqualsLines: "PASS", linesMatchReserveCap: "PASS" };

  async function reconciles(expected) {
    const json = await monitor(["reconcile"]);
    assert.deepEqual(statuses(json), ALL_PASS, JSON.stringify(json.checks, null, 2));
    assert.deepEqual(
      { balance: json.balance, totalSponsorObligations: json.totalSponsorObligations, totalCommittedCapital: json.totalCommittedCapital, surplus: json.surplus },
      expected,
    );
    assert.equal(json.balance, (await balance(float)).toString());
    return json;
  }

  const balance = (address) => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });

  async function travelTo(timestamp) {
    const { timestamp: now } = await client.getBlock();
    await testClient.increaseTime({ seconds: Number(timestamp - now) });
    await testClient.mine({ blocks: 1 });
  }

  // Mines one block at exactly `timestamp`.
  async function mineAt(timestamp) {
    await testClient.setNextBlockTimestamp({ timestamp });
    await testClient.mine({ blocks: 1 });
  }

  // A copy of index.json with `edit` applied: a damaged index, or one built
  // from an RPC ahead of this one.
  function editedIndex(name, edit) {
    const index = JSON.parse(readFileSync(path("index.json"), "utf8"));
    edit(index);
    writeFileSync(path(name), JSON.stringify(index));
    return path(name);
  }

  const openArgs = (agent) => [
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
    "--execute",
  ];

  // Build, sign and submit one paid purchase on the agent's line.
  async function purchase(agent, key, name) {
    const file = path(`${name}.json`);
    await ok("intent", [
      "build",
      "--agent", agent.address,
      "--sponsor", sponsor.address,
      "--provider", provider.address,
      "--endpoint", ENDPOINT,
      "--principal", PRINCIPAL.toString(),
      "--executor", executor.address,
      "--out", file,
    ]);
    await ok("intent", ["sign", "--intent", file], key);
    const paid = await ok("submit", ["submit", "--intent", file, "--execute"], EXECUTOR);
    assert.equal(paid.status, "paid");
    return paid;
  }

  before(async () => {
    anvil = await startAnvil(PORT);
    dir = mkdtempSync(join(tmpdir(), "float-monitor-"));
    usdc = getAddress((await deploy("MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6])).contractAddress);
    const deployed = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [
      usdc,
      CHAIN_ID,
      MAXIMA,
      INITIAL,
      MINIMUM_REPAYMENT_WINDOW,
      604_800n,
      GOVERNANCE_DELAY,
    ]);
    float = getAddress(deployed.contractAddress);
    deployBlock = deployed.blockNumber;
    manifest = path("manifest.json");
    writeFileSync(
      manifest,
      stableStringify({
        ok: true,
        chainId: CHAIN_ID.toString(),
        contract: { address: float },
        bytecode: { onchainRuntimeKeccak256: keccak256(await client.getCode({ address: float })) },
        deployment: { blockNumber: deployed.blockNumber.toString() },
      }),
    );
    const { abi } = artifact("MockAsset.sol/MockAsset.json");
    for (const [holder, amount] of [[sponsor, 10_000_000n], [agentA, 2_000_000n], [agentB, 2_000_000n]]) {
      const hash = await walletOf(owner).writeContract({ address: usdc, abi, functionName: "mint", args: [holder.address, amount] });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    }
  });

  after(() => {
    anvil?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("check lists every opened line from a canonical scan, with index checkpoint diagnostics and no alert", async () => {
    await ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], OWNER);
    seen.lineA = (await ok("sponsor", openArgs(agentA), SPONSOR)).lineId;
    await ok("indexer", ["index", "--out", path("index.json")]);
    seen.lineB = (await ok("sponsor", openArgs(agentB), SPONSOR)).lineId;

    const checked = await monitor(["check"]);
    assert.deepEqual(checked.alerts, []);
    assert.deepEqual([checked.discovery.lines, checked.discovery.index, checked.lines.map((line) => line.lineId)], [2, null, [seen.lineA, seen.lineB]]);
    const lineA = lineOf(checked, seen.lineA);
    assert.deepEqual(
      [lineA.state, lineA.availableReserve, lineA.principalOutstanding, lineA.recoveryAvailable, lineA.cumulativePrincipalPaid, lineA.secondsToMaturity, lineA.sponsorAllowed],
      ["OPEN", "1000000", "0", "0", "0", null, true],
    );
    assert.deepEqual(
      lineA.providers.map(({ provider: address, active, nextSpendMax, limitedBy, binding }) => ({ address, active, nextSpendMax, limitedBy, binding })),
      [{ address: provider.address, active: true, nextSpendMax: "1000000", limitedBy: "LINE_RESERVE_CAP", binding: "line.availableReserve" }],
    );
    assert.deepEqual(
      [checked.contract.owner, checked.contract.pendingOwner, checked.contract.spendsPaused, checked.contract.openingsPaused, checked.contract.pendingCapIncreases, checked.contract.operators],
      [owner.address, zeroAddress, false, false, [], []],
    );
    assert.deepEqual(
      [checked.contract.totalCommittedCapital, checked.contract.totalSponsorObligations, checked.warnBefore, checked.maxIndexLag],
      ["2000000", "2000000", "86400", "3600"],
    );

    // The index predates line B; canonical discovery still finds both lines.
    const indexed = await monitor(["check", "--index", path("index.json")]);
    const { index, scanned } = indexed.discovery;
    assert.deepEqual([index.canonical, index.note, indexed.discovery.lines, indexed.alerts], [true, null, 2, []]);
    assert.ok(BigInt(index.lagBlocks) > 0n);
    assert.deepEqual(scanned, { fromBlock: deployBlock.toString(), toBlock: indexed.observedAt.blockNumber });
    assert.deepEqual(indexed.lines, checked.lines);

    // An index built from an RPC ahead of this one (a lagging second RPC), and
    // one whose checkpoint was reorganized away: both are noted, and every
    // line is found by a scan from the deployment block.
    const head = BigInt(checked.observedAt.blockNumber);
    const fullScan = { fromBlock: deployBlock.toString(), toBlock: head.toString() };
    const aheadIndex = editedIndex("index-ahead.json", (edited) => {
      edited.checkpoint.blockNumber = (head + 1_000n).toString();
    });
    const ahead = await monitor(["check", "--index", aheadIndex]);
    assert.deepEqual(alertList(ahead), [["INDEX_LAG", "warning", null]]);
    assert.match(ahead.alerts[0].detail, new RegExp(`^the RPC head ${head} is behind the index checkpoint ${head + 1_000n}: this RPC lags the one the index was built from, so the lines were scanned from the deployment block instead`));
    assert.deepEqual(
      [ahead.discovery.index.canonical, ahead.discovery.index.lagBlocks, ahead.discovery.index.note, ahead.discovery.scanned],
      [false, null, ahead.alerts[0].detail, fullScan],
    );
    assert.deepEqual(ahead.lines, checked.lines);
    const aheadReconciled = await monitor(["reconcile", "--index", aheadIndex]);
    assert.deepEqual([statuses(aheadReconciled), aheadReconciled.discovery.index.note, aheadReconciled.discovery.lines], [ALL_PASS, ahead.alerts[0].detail, 2]);

    const reorganized = await monitor([
      "check",
      "--index",
      editedIndex("index-reorganized.json", (edited) => {
        const hash = edited.checkpoint.blockHash;
        edited.checkpoint.blockHash = `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
      }),
    ]);
    assert.deepEqual(alertList(reorganized), [["INDEX_LAG", "warning", null]]);
    assert.match(reorganized.alerts[0].detail, /^the index checkpoint \d+ \(0x[0-9a-f]+\) was reorganized away \(block \d+ is now 0x[0-9a-f]+\), so the lines were scanned from the deployment block instead; run the indexer with --resume to rebuild it$/);
    assert.deepEqual([reorganized.discovery.index.canonical, reorganized.discovery.scanned], [false, fullScan]);
    assert.deepEqual(reorganized.lines, checked.lines);

    // A 60-day horizon reaches both lines' expiry and both provider policies'.
    const horizon = await monitor(["check", "--warn-before", "5184000"]);
    assert.deepEqual(alertList(horizon), [
      ["LINE_EXPIRY_SOON", "warning", seen.lineA],
      ["POLICY_EXPIRY_SOON", "warning", seen.lineA],
      ["LINE_EXPIRY_SOON", "warning", seen.lineB],
      ["POLICY_EXPIRY_SOON", "warning", seen.lineB],
    ]);
    assert.equal(horizon.alerts[1].provider, provider.address);

    // LINE_EXPIRY_SOON fires once purchases stop within the horizon, which is
    // minimumRepaymentWindow before the line's expiry, and not a second earlier.
    const purchasesEnd = BigInt(lineA.expiry) - MINIMUM_REPAYMENT_WINDOW;
    const toEnd = purchasesEnd - BigInt(checked.observedAt.timestamp);
    const ending = await monitor(["check", "--line-id", seen.lineA, "--warn-before", toEnd.toString()]);
    assert.equal(ending.observedAt.timestamp, checked.observedAt.timestamp);
    assert.deepEqual(alertList(ending), [["LINE_EXPIRY_SOON", "warning", seen.lineA]]);
    assert.equal(
      ending.alerts[0].detail,
      `purchases stop after ${purchasesEnd} (in ${toEnd}s), minimumRepaymentWindow before the line expires at ${lineA.expiry} (in ${toEnd + MINIMUM_REPAYMENT_WINDOW}s): no spend can have a dueAt after the expiry`,
    );
    assert.deepEqual((await monitor(["check", "--line-id", seen.lineA, "--warn-before", (toEnd - 1n).toString()])).alerts, []);

    const one = await monitor(["check", "--line-id", seen.lineB]);
    assert.deepEqual([one.discovery.lines, one.lines.map((line) => line.lineId)], [2, [seen.lineB]]);
    await reconciles({ balance: "2000000", totalSponsorObligations: "2000000", totalCommittedCapital: "2000000", surplus: "0" });
  });

  test("failed read-only CLI batches stop at the failed read and a fresh retry keeps canonical accounting", async () => {
    const snapshot = await testClient.snapshot();
    let server;
    try {
      // Two members make operator/provider batches exercise a real sibling,
      // rather than accidentally passing because the fixture has only one.
      await ownerCall("setOperator", [operator.address, true]);
      await ownerCall("setOperator", [account(8).address, true]);
      const existing = await client.readContract({ address: float, abi: floatAbi, functionName: "getLine", args: [seen.lineA] });
      const policyHash = await walletOf(sponsor).writeContract({
        address: float, abi: floatAbi, functionName: "setProviderPolicy",
        args: [seen.lineA, account(9).address, keccak256(new TextEncoder().encode(ENDPOINT)), 1_000_000n, 1_000_000n, existing.expiry, true],
      });
      assert.equal((await client.waitForTransactionReceipt({ hash: policyHash })).status, "success");
      const baselineCheck = await monitor(["check"]);
      const baselineReconcile = await monitor(["reconcile"]);
      assert.equal(baselineCheck.contract.operators.length, 2);
      assert.equal(lineOf(baselineCheck, seen.lineA).providers.length, 2);

      let failFunction;
      let requests = [];
      server = createServer(async (request, response) => {
        try {
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const body = JSON.parse(raw);
          let label = body.method;
          if (body.method === "eth_call" && body.params[0].to.toLowerCase() === float.toLowerCase()) {
            label = decodeFunctionData({ abi: floatAbi, data: body.params[0].data }).functionName;
          }
          requests.push(label);
          response.setHeader("content-type", "application/json");
          if (label === failFunction) {
            response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `injected read failure for ${label}` } }));
            return;
          }
          const upstream = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
          response.end(await upstream.text());
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: String(error) }));
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const proxyRpc = `http://127.0.0.1:${server.address().port}`;
      for (const [tool, args, failing] of [
        ["monitor", ["check"], "NAME_HASH"],
        ["monitor", ["check"], "owner"],
        ["monitor", ["check"], "pendingCaps"],
        ["monitor", ["check"], "operators"],
        ["monitor", ["check"], "providerPolicies"],
        ["monitor", ["reconcile"], "usdc"],
        ["indexer", ["index", "--out", path("failed-index.json")], "NAME_HASH"],
      ]) {
        requests = [];
        failFunction = failing;
        const failure = await cli(tool, args, { ARC_RPC_URL: proxyRpc });
        assert.equal(failure.status, 1, `${tool} ${args[0]} / ${failing}`);
        assert.equal(failure.json.ok, false);
        assert.match(failure.json.error.message, /injected read failure/);
        assert.equal(requests.filter((label) => label === failing).length, 1);
        assert.equal(requests.indexOf(failing), requests.length - 1, `no RPC may run after ${failing} fails: ${requests.join(", ")}`);

        failFunction = undefined;
        requests = [];
        const retry = await cli(tool, args, { ARC_RPC_URL: proxyRpc });
        assert.equal(retry.status, 0);
        assert.equal(retry.json.ok, true);
        if (tool === "monitor") {
          const expected = args[0] === "check" ? baselineCheck : baselineReconcile;
          assert.deepEqual(retry.json, expected, "fresh retry must preserve the pinned block, complete discovery and accounting");
        } else {
          const index = JSON.parse(readFileSync(path("failed-index.json"), "utf8"));
          assert.equal(index.checkpoint.blockHash, baselineCheck.observedAt.blockHash);
          assert.equal(index.checkpoint.blockNumber, baselineCheck.observedAt.blockNumber);
        }
      }
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await testClient.revert({ id: snapshot });
    }
  });

  test("a drawn line warns MATURITY_SOON then DEFAULT_ELIGIBLE; stale and incomplete indexes cannot hide it", async () => {
    const paid = await purchase(agentA, AGENT_A, "a1");
    seen.dueAt = BigInt(paid.providerPaid.dueAt);
    // Line B draws and repays in two parts: back to OPEN.
    await purchase(agentB, AGENT_B, "b1");
    await ok("repay", ["--line-id", seen.lineB, "--amount", "100000", "--execute"], AGENT_B);
    await reconciles({ balance: "1600000", totalSponsorObligations: "1600000", totalCommittedCapital: "2000000", surplus: "0" });
    await ok("repay", ["--line-id", seen.lineB, "--full", "--execute"], AGENT_B);

    const drawn = await monitor(["check"]);
    assert.deepEqual(drawn.alerts, []);
    const lineA = lineOf(drawn, seen.lineA);
    assert.deepEqual([lineA.state, lineA.principalOutstanding, lineA.dueAt, lineA.matured], ["DRAWN", PRINCIPAL.toString(), seen.dueAt.toString(), false]);
    assert.equal(BigInt(lineA.secondsToMaturity), seen.dueAt - BigInt(drawn.observedAt.timestamp));
    assert.equal(lineA.providers[0].limitedBy, "LINE_DRAWN");
    assert.equal(lineOf(drawn, seen.lineB).state, "OPEN");

    await travelTo(seen.dueAt - 3_600n);
    const soon = await monitor(["check"]);
    assert.deepEqual(alertList(soon), [["MATURITY_SOON", "warning", seen.lineA]]);
    assert.match(soon.alerts[0].detail, new RegExp(`^principalOutstanding 250000 is due at ${seen.dueAt} \\(in \\d+s\\)$`));
    assert.deepEqual((await monitor(["check", "--warn-before", "60"])).alerts, []);

    // One second before dueAt the line is not yet eligible; at dueAt itself it
    // is, as the contract's isMatured and declareDefault (block.timestamp >= dueAt).
    await mineAt(seen.dueAt - 1n);
    const almost = await monitor(["check"]);
    assert.equal(almost.observedAt.timestamp, (seen.dueAt - 1n).toString());
    assert.deepEqual(alertList(almost), [["MATURITY_SOON", "warning", seen.lineA]]);
    assert.deepEqual([lineOf(almost, seen.lineA).matured, lineOf(almost, seen.lineA).secondsToMaturity], [false, "1"]);

    await mineAt(seen.dueAt);
    const due = await monitor(["check"], 1);
    assert.equal(due.observedAt.timestamp, seen.dueAt.toString());
    assert.deepEqual(alertList(due), [["DEFAULT_ELIGIBLE", "critical", seen.lineA]]);
    assert.match(due.alerts[0].detail, /the sponsor may declare-default; repayment stays open until it does$/);
    assert.deepEqual([lineOf(due, seen.lineA).matured, lineOf(due, seen.lineA).secondsToMaturity], [true, "0"]);

    // --max-index-lag (default 3600), not --warn-before, sets how far the index may lag.
    const stale = await monitor(["check", "--index", path("index.json")], 1);
    assert.deepEqual(alertList(stale), [["INDEX_LAG", "warning", null], ["DEFAULT_ELIGIBLE", "critical", seen.lineA]]);
    assert.match(stale.alerts[0].detail, /is \d+ blocks and \d+s behind the head, more than 3600s; run the indexer with --resume$/);
    const { lagSeconds } = stale.discovery.index;
    const tolerated = await monitor(["check", "--index", path("index.json"), "--warn-before", "60", "--max-index-lag", lagSeconds], 1);
    assert.deepEqual([alertList(tolerated), tolerated.maxIndexLag], [[["DEFAULT_ELIGIBLE", "critical", seen.lineA]], lagSeconds]);
    const lagging = await monitor(["check", "--index", path("index.json"), "--max-index-lag", (BigInt(lagSeconds) - 1n).toString()], 1);
    assert.deepEqual(alertList(lagging), alertList(stale));

    // An index that lost line A's LineOpened cannot suppress its maturity
    // alert or break reconciliation: discovery uses the canonical logs.
    const withoutA = editedIndex("index-without-a.json", (edited) => {
      edited.events = edited.events.filter((entry) => !(entry.event === "LineOpened" && entry.args.lineId === seen.lineA));
    });
    const complete = await monitor(["check", "--index", withoutA], 1);
    assert.deepEqual(alertList(complete), alertList(stale));
    assert.deepEqual([complete.discovery.lines, complete.lines.map((line) => line.lineId)], [2, [seen.lineA, seen.lineB]]);
    const reconciled = await monitor(["reconcile", "--index", withoutA]);
    assert.deepEqual(statuses(reconciled), ALL_PASS);
    // --line-id checks only the lines named, so it skips the guard.
    assert.deepEqual(alertList(await monitor(["check", "--index", withoutA, "--line-id", seen.lineB])), [["INDEX_LAG", "warning", null]]);
  });

  test("reconcile stays clean through a partial repayment, a default, recovery and two claims", async () => {
    await ok("repay", ["--line-id", seen.lineA, "--amount", "50000", "--execute"], AGENT_A);
    // A: available 800000, principal 200000. B: available 1000000.
    await reconciles({ balance: "1800000", totalSponsorObligations: "1800000", totalCommittedCapital: "2000000", surplus: "0" });

    await ok("sponsor", ["declare-default", "--line-id", seen.lineA, "--execute"], SPONSOR);
    await ok("repay", ["--line-id", seen.lineA, "--amount", "50000", "--execute"], AGENT_A);
    // A: available 800000, principal 150000, recovery 50000.
    await reconciles({ balance: "1850000", totalSponsorObligations: "1850000", totalCommittedCapital: "2000000", surplus: "0" });

    const claimed = await ok("sponsor", ["claim-defaulted", "--line-id", seen.lineA, "--execute"], SPONSOR);
    assert.deepEqual([claimed.amount, claimed.state, claimed.principalOutstanding], ["850000", "DEFAULTED", "150000"]);
    // The unrepaid principal stays committed after the claim.
    await reconciles({ balance: "1000000", totalSponsorObligations: "1000000", totalCommittedCapital: "1150000", surplus: "0" });

    await ok("repay", ["--line-id", seen.lineA, "--amount", "50000", "--execute"], AGENT_A);
    await reconciles({ balance: "1050000", totalSponsorObligations: "1050000", totalCommittedCapital: "1150000", surplus: "0" });
    assert.equal((await ok("sponsor", ["claim-defaulted", "--line-id", seen.lineA, "--execute"], SPONSOR)).amount, "50000");
    const settled = await reconciles({ balance: "1000000", totalSponsorObligations: "1000000", totalCommittedCapital: "1100000", surplus: "0" });
    assert.deepEqual(settled.sums, { availableReserve: "1000000", principalOutstanding: "100000", recoveryAvailable: "0" });
    // A's reserveCap is its unrepaid principal plus the two SponsorClaimed amounts.
    const settledA = { state: "DEFAULTED", reserveCap: "1000000", availableReserve: "0", principalOutstanding: "100000", recoveryAvailable: "0", sponsorClaimed: "900000" };
    assert.deepEqual(identityOf(lineOf(settled, seen.lineA)), settledA);

    // The same from an index that holds both SponsorClaimed events, with their
    // amounts as decimal strings, and nothing left to scan.
    await ok("indexer", ["index", "--out", path("index.json"), "--resume"]);
    const fromIndex = await monitor(["reconcile", "--index", path("index.json")]);
    assert.deepEqual([statuses(fromIndex), fromIndex.discovery.scanned, identityOf(lineOf(fromIndex, seen.lineA))],
      [ALL_PASS, { fromBlock: deployBlock.toString(), toBlock: fromIndex.observedAt.blockNumber }, settledA]);

    // A DEFAULTED line is no longer DEFAULT_ELIGIBLE.
    const checked = await monitor(["check"]);
    assert.deepEqual(checked.alerts, []);
    assert.deepEqual([lineOf(checked, seen.lineA).state, lineOf(checked, seen.lineA).principalOutstanding], ["DEFAULTED", "100000"]);
  });

  test("an operator may pause but not unpause; check alerts while spends and openings are paused", async () => {
    await ownerCall("setOperator", [operator.address, true]);
    await ok("owner", ["pause", "--what", "spends", "--execute"], OPERATOR);
    await ok("owner", ["pause", "--what", "openings", "--execute"], OWNER);

    const paused = await monitor(["check"]);
    assert.deepEqual(alertList(paused), [["SPENDS_PAUSED", "warning", null], ["OPENINGS_PAUSED", "warning", null], ["OPERATOR_CHANGED", "warning", null]]);
    assert.match(paused.alerts[0].detail, /recorded as SpendBlocked\(SPENDS_PAUSED\) and uses up its nonce \(on a DRAWN line a spend reverts InvalidState instead\)/);
    assert.equal(paused.alerts[2].operator, operator.address);
    assert.match(paused.alerts[2].detail, new RegExp(`^1 OperatorSet event\\(s\\) for ${operator.address} since deployment, the last with allowed true in block \\d+; it is enabled now$`));
    assert.deepEqual(
      paused.contract.operators.map(({ operator: address, enabled, set }) => ({ address, enabled, allowed: set.map((entry) => entry.allowed) })),
      [{ address: operator.address, enabled: true, allowed: [true] }],
    );
    assert.equal(lineOf(paused, seen.lineB).providers[0].limitedBy, "SPENDS_PAUSED");

    const refused = await cli("owner", ["unpause", "--what", "spends", "--execute"], OPERATOR);
    assert.equal(refused.status, 1);
    assert.match(refused.json.error.message, new RegExp(`${operator.address} is not owner\\(\\)`));
    await ok("owner", ["unpause", "--what", "spends", "--execute"], OWNER);
    await ok("owner", ["unpause", "--what", "openings", "--execute"], OWNER);
    assert.deepEqual(alertList(await monitor(["check"])), [["OPERATOR_CHANGED", "warning", null]]);

    // Removing the operator is a change too: it stays reported, as not enabled.
    await ownerCall("setOperator", [operator.address, false]);
    const removed = await monitor(["check"]);
    assert.deepEqual(alertList(removed), [["OPERATOR_CHANGED", "warning", null]]);
    assert.match(removed.alerts[0].detail, new RegExp(`^2 OperatorSet event\\(s\\) for ${operator.address} since deployment, the last with allowed false in block \\d+; it is not enabled now$`));
    assert.deepEqual(
      removed.contract.operators.map(({ enabled, set }) => [enabled, set.map((entry) => entry.allowed)]),
      [[false, [true, false]]],
    );
  });

  test("omitted operator and provider-policy events in a canonical index cannot suppress alerts", async () => {
    await ok("indexer", ["index", "--out", path("index.json"), "--resume"]);
    const options = ["check", "--warn-before", "5184000"];
    const baseline = await monitor(options);
    assert.ok(baseline.alerts.some((alert) => alert.code === "OPERATOR_CHANGED"));
    assert.ok(baseline.alerts.some((alert) => alert.code === "POLICY_EXPIRY_SOON" && alert.lineId === seen.lineB));
    for (const omitted of [["OperatorSet"], ["ProviderPolicySet"], ["OperatorSet", "ProviderPolicySet"]]) {
      const damaged = editedIndex(`without-${omitted.join("-")}.json`, (edited) => {
        const before = edited.events.length;
        edited.events = edited.events.filter((entry) => !omitted.includes(entry.event));
        assert.ok(edited.events.length < before, "the fixture must actually remove canonical events");
      });
      const checked = await monitor([...options, "--index", damaged]);
      assert.equal(checked.discovery.index.canonical, true);
      assert.deepEqual(checked.alerts, baseline.alerts);
      assert.deepEqual(checked.contract.operators, baseline.contract.operators);
      assert.deepEqual(checked.lines, baseline.lines);
    }
  });

  test("a proposed cap increase is reported with its activation time", async () => {
    const receipt = await ownerCall("proposeCapIncrease", [CAP_KINDS.indexOf("PER_SPEND"), 1_500_000n]);
    const activateAt = (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp + GOVERNANCE_DELAY;
    const checked = await monitor(["check"]);
    assert.deepEqual(alertList(checked), [["CAP_INCREASE_PENDING", "warning", null], ["OPERATOR_CHANGED", "warning", null]]);
    assert.equal(checked.alerts[0].kind, "PER_SPEND");
    assert.match(checked.alerts[0].detail, new RegExp(`the owner or an operator can cancelCapIncrease\\(3\\) at any time until it is activated, after ${activateAt} too$`));
    assert.deepEqual(checked.contract.pendingCapIncreases, [
      {
        kind: "PER_SPEND",
        current: "1000000",
        value: "1500000",
        activateAt: activateAt.toString(),
        secondsToActivation: (activateAt - BigInt(checked.observedAt.timestamp)).toString(),
      },
    ]);
  });

  test("a sponsor removed from the allowlist is flagged on its live line, and can still close it", async () => {
    await ok("owner", ["disallow-sponsor", "--sponsor", sponsor.address, "--execute"], OWNER);
    const removed = await monitor(["check"]);
    // Line A is DEFAULTED: only the live line B is flagged.
    assert.deepEqual(alertList(removed), [
      ["CAP_INCREASE_PENDING", "warning", null],
      ["OPERATOR_CHANGED", "warning", null],
      ["SPONSOR_REMOVED", "warning", seen.lineB],
    ]);
    assert.equal(lineOf(removed, seen.lineB).providers[0].limitedBy, "SPONSOR_NOT_ALLOWED");

    const closed = await ok("sponsor", ["close", "--line-id", seen.lineB, "--execute"], SPONSOR);
    assert.deepEqual([closed.amount, closed.state], ["1000000", "CLOSED"]);
    const reconciled = await reconciles({ balance: "0", totalSponsorObligations: "0", totalCommittedCapital: "100000", surplus: "0" });
    assert.deepEqual(identityOf(lineOf(reconciled, seen.lineB)), {
      state: "CLOSED",
      reserveCap: "1000000",
      availableReserve: "0",
      principalOutstanding: "0",
      recoveryAvailable: "0",
      sponsorClaimed: "0",
    });
    assert.deepEqual(alertList(await monitor(["check"])), [["CAP_INCREASE_PENDING", "warning", null], ["OPERATOR_CHANGED", "warning", null]]);
  });

  test("USDC sent to the Float directly is a reported surplus, not a mismatch", async () => {
    const hash = await walletOf(agentB).writeContract({ address: usdc, abi: erc20Abi, functionName: "transfer", args: [float, 500_000n] });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    const reconciled = await reconciles({ balance: "500000", totalSponsorObligations: "0", totalCommittedCapital: "100000", surplus: "500000" });
    assert.match(reconciled.checks[0].detail, /with a surplus of 500000: USDC sent to the Float outside its functions, which no function can move out$/);
    assert.deepEqual(
      reconciled.lines.map(({ lineId, state }) => [lineId, state]),
      [[seen.lineA, "DEFAULTED"], [seen.lineB, "CLOSED"]],
    );
  });

  test("a pending owner and committed capital above the protocol cap are warnings; a cap increase can be cancelled after activateAt", async () => {
    const PROTOCOL_RESERVE = CAP_KINDS.indexOf("PROTOCOL_RESERVE");
    const PER_SPEND = CAP_KINDS.indexOf("PER_SPEND");
    const nextOwner = account(1).address;
    await ownerCall("proposeOwner", [nextOwner]);
    // totalCommittedCapital is 100000, line A's unrepaid principal: a cap equal to it is not exceeded.
    await ownerCall("reduceCap", [PROTOCOL_RESERVE, 100_000n]);
    const atCap = await monitor(["check"]);
    assert.deepEqual(alertList(atCap), [
      ["CAP_INCREASE_PENDING", "warning", null],
      ["OWNERSHIP_PENDING", "warning", null],
      ["OPERATOR_CHANGED", "warning", null],
    ]);
    assert.equal(atCap.alerts[1].detail, `proposeOwner(${nextOwner}) is pending: that address becomes the owner as soon as it calls acceptOwnership`);
    assert.deepEqual([atCap.contract.pendingOwner, atCap.contract.effectiveLimits.protocolReserve], [nextOwner, "100000"]);

    await ownerCall("reduceCap", [PROTOCOL_RESERVE, 99_999n]);
    const over = await monitor(["check"]);
    assert.deepEqual(alertList(over), [...alertList(atCap), ["PROTOCOL_CAP_EXCEEDED", "warning", null]]);
    assert.match(over.alerts[3].detail, /^totalCommittedCapital 100000 exceeds effectiveLimits.protocolReserve 99999: no spend can pay/);
    await reconciles({ balance: "500000", totalSponsorObligations: "0", totalCommittedCapital: "100000", surplus: "500000" });

    // cancelCapIncrease has no deadline but the activation itself.
    const [, activateAt] = await client.readContract({ address: float, abi: floatAbi, functionName: "pendingCaps", args: [PER_SPEND] });
    await travelTo(activateAt + 1n);
    await ownerCall("cancelCapIncrease", [PER_SPEND]);
    assert.deepEqual(alertList(await monitor(["check"])), alertList(over).slice(1));
  });
});
