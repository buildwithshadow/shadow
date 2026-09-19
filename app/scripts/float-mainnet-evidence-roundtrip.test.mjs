import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPublicClient, createTestClient, createWalletClient, defineChain, getAddress, http } from "viem";
import { sign } from "viem/accounts";

import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { stableStringify } from "./float-mainnet-preflight.mjs";

// The two evidence lanes together, as participants would run them: every step
// is a CLI in its own process with only its own role's key. The release
// manifest comes from float-mainnet-manifest.mjs, the provider receipts from
// the provider kit, the bundle from the indexer and exporter, and the report
// from the independent verifier. The test itself only deploys, funds, moves
// time, and edits the exported bundle to tamper with it.

const PORT = 18595;
const RPC = `http://127.0.0.1:${PORT}`;
const ENDPOINT = "https://provider.example/api/ask";
const PRICE = 1_000_000n;
const SIXTY_DAYS = "+5184000";
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };
const WINDOWS = { minimum: 3_600n, maximum: 604_800n, governanceDelay: 172_800n };
const LIMIT_ENV = { protocolReserve: "PROTOCOL_RESERVE", lineReserve: "LINE_RESERVE", lineSpend: "LINE_SPEND", perSpend: "PER_SPEND", dailySpend: "DAILY_SPEND" };
// MANUAL for this test's manifest: a temporary file, not a committed release record.
const PROVENANCE = "deployment.manifestProvenance";
const DECLARED = {
  independentControl: { sponsor: "Sponsor Co holds the sponsor key", agent: "Agent Ltd holds the agent key", provider: "Provider Inc holds the provider key" },
  customerPurpose: "one paid provider answer per day for a daily summary",
  assistance: ["Shadow supplied test USDC", "no live intervention"],
  commercial: { price: "1 USDC per answer" },
};

describe("evidence round trip: provider kit, indexer, exporter and independent verifier", { skip: e2eSkip }, () => {
  // Account index 1 is not used.
  const [owner, sponsor, agent, executor, provider, stranger] = [0, 2, 3, 4, 5, 6].map(account);
  const OWNER = { FLOAT_OWNER_PRIVATE_KEY: keyOf(0) };
  const SPONSOR = { FLOAT_SPONSOR_PRIVATE_KEY: keyOf(2) };
  const AGENT = { FLOAT_AGENT_PRIVATE_KEY: keyOf(3) };
  const EXECUTOR = { FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(4) };
  const PROVIDER = { FLOAT_PROVIDER_PRIVATE_KEY: keyOf(5) };
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
  let manifest;
  const path = (name) => join(dir, name);
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  const writeJson = (file, value) => writeFileSync(file, stableStringify(value));

  async function deploy(name, args) {
    const { abi, bytecode } = artifact(name);
    const hash = await walletOf(owner).deployContract({ abi, bytecode: bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", name);
    return receipt;
  }

  // Every participant command names the deployment by its release manifest.
  const cli = (tool, args, env = {}) =>
    runTool(tool, [...args, "--manifest", manifest], { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(), ...env });

  async function ok(tool, args, env) {
    const { status, json } = await cli(tool, args, env);
    assert.equal(status, 0, `${tool} ${args[0]}: ${JSON.stringify(json, null, 2)}`);
    assert.equal(json.ok, true);
    return json;
  }

  // The verifier is given the RPC, the bundle and the release manifest only.
  async function verify(name, bundle) {
    writeJson(path(name), bundle);
    const { status, json } = await runTool("verify", ["verify", "--bundle", path(name), "--manifest", manifest], { ARC_RPC_URL: RPC });
    const check = (id) => json.checks?.find((entry) => entry.id === id) ?? assert.fail(`no check ${id} in ${JSON.stringify(json, null, 2)}`);
    const ids = (status) => json.checks.filter((entry) => entry.status === status).map((entry) => entry.id);
    return { status, report: json, check, ids };
  }

  async function verifiesOk(name, bundle) {
    const result = await verify(name, bundle);
    assert.equal(result.status, 0, JSON.stringify(result.report.checks?.filter((entry) => entry.status === "FAIL") ?? result.report, null, 2));
    assert.equal(result.report.ok, true);
    return result;
  }

  // A tampered bundle fails at exactly the expected checks, the first with `pattern`.
  async function failsAt(name, bundle, expected, pattern) {
    const result = await verify(name, bundle);
    assert.equal(result.status, 1, JSON.stringify(result.report, null, 2));
    assert.equal(result.report.ok, false);
    assert.deepEqual(result.ids("FAIL"), expected, `${name}: ${JSON.stringify(result.report.checks.filter((entry) => entry.status === "FAIL"), null, 2)}`);
    assert.match(result.check(expected[0]).detail, pattern);
    return result;
  }

  const event = (output, name) => output.events.find((entry) => entry.event === name) ?? assert.fail(`no ${name} in ${JSON.stringify(output)}`);

  before(async () => {
    anvil = await startAnvil(PORT);
    dir = mkdtempSync(join(tmpdir(), "float-roundtrip-"));
    const usdc = getAddress((await deploy("MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6])).contractAddress);
    const deployed = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [
      usdc,
      CHAIN_ID,
      MAXIMA,
      INITIAL,
      WINDOWS.minimum,
      WINDOWS.maximum,
      WINDOWS.governanceDelay,
    ]);

    // The committed manifest tool, pinned at the deploy block (before any
    // allowlisting), reading the chain through two host names for its two RPCs.
    manifest = path("manifest.json");
    const limits = Object.entries(LIMIT_ENV).flatMap(([field, suffix]) => [
      [`FLOAT_MAINNET_MAX_${suffix}`, MAXIMA[field].toString()],
      [`FLOAT_MAINNET_INIT_${suffix}`, INITIAL[field].toString()],
    ]);
    const release = await runTool(
      "manifest",
      ["--out", manifest, "--address", deployed.contractAddress, "--tx", deployed.transactionHash, "--block", deployed.blockNumber.toString()],
      {
        ARC_RPC_URL: RPC,
        ARC_RPC_URL_2: `http://localhost:${PORT}`,
        ARC_EXPLORER_URL: "http://127.0.0.1:1",
        FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(),
        FLOAT_MAINNET_USDC: usdc,
        FLOAT_MAINNET_EXPECTED_DEPLOYER: owner.address,
        FLOAT_MAINNET_MIN_REPAYMENT_WINDOW: WINDOWS.minimum.toString(),
        FLOAT_MAINNET_MAX_REPAYMENT_WINDOW: WINDOWS.maximum.toString(),
        FLOAT_MAINNET_GOVERNANCE_DELAY: WINDOWS.governanceDelay.toString(),
        ...Object.fromEntries(limits),
      },
    );
    assert.equal(release.status, 0, JSON.stringify(release.json, null, 2));
    assert.deepEqual([release.json.ok, release.json.failed], [true, []]);
    const written = readJson(manifest);
    assert.deepEqual(
      [written.contract.address, written.deployment.blockNumber, written.deployment.txHash],
      [getAddress(deployed.contractAddress), deployed.blockNumber.toString(), deployed.transactionHash],
    );

    const { abi } = artifact("MockAsset.sol/MockAsset.json");
    for (const [holder, amount] of [[sponsor, 10_000_000n], [agent, 5_000_000n]]) {
      const hash = await walletOf(owner).writeContract({ address: usdc, abi, functionName: "mint", args: [holder.address, amount] });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    }
  });

  after(() => {
    anvil?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a pilot line exported from the CLIs' own files verifies ok, and each tamper fails at the check that owns it", async () => {
    // 1. Owner and sponsor, with the guide's pilot values.
    await ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], OWNER);
    const opened = await ok(
      "sponsor",
      [
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
      ],
      SPONSOR,
    );
    const lineId = opened.lineId;
    const intentArgs = (principal, out, extra = []) => [
      "build",
      "--agent", agent.address,
      "--sponsor", sponsor.address,
      "--provider", provider.address,
      "--endpoint", ENDPOINT,
      "--principal", principal.toString(),
      "--executor", executor.address,
      "--out", out,
      ...extra,
    ];

    // 2. Three purchases on separate UTC days: the provider accepts before the
    // payment, checks it on-chain after, then signs the delivery.
    const cycles = [];
    for (let day = 1; day <= 3; day++) {
      if (day > 1) {
        await testClient.increaseTime({ seconds: 86_400 });
        await testClient.mine({ blocks: 1 });
      }
      const file = (kind) => path(`c${day}-${kind}`);
      const requestId = `request-${day}`;
      const built = await ok("intent", intentArgs(PRICE, file("intent.json")));
      await ok("intent", ["sign", "--intent", file("intent.json"), "--out", file("signed.json")], AGENT);
      const accepted = await ok(
        "provider",
        ["accept", "--intent", file("signed.json"), "--endpoint", ENDPOINT, "--price", PRICE.toString(), "--request-id", requestId, "--out", file("acceptance.json")],
        PROVIDER,
      );
      assert.deepEqual([accepted.digest, accepted.predictedOutcome.outcome], [built.digest, "pay"]);
      const paid = await ok("submit", ["submit", "--intent", file("signed.json"), "--execute"], EXECUTOR);
      assert.deepEqual([paid.status, paid.digest], ["paid", built.digest]);
      const payment = await ok("provider", ["check-payment", "--intent", file("signed.json"), "--acceptance", file("acceptance.json")]);
      assert.deepEqual(
        [payment.paid, payment.providerPaid.transactionHash, payment.acceptance.requestId, payment.acceptance.signatureValid],
        [true, paid.txHash, requestId, true],
      );
      writeFileSync(file("result.txt"), `answer for ${requestId}`);
      await ok(
        "provider",
        ["deliver", "--acceptance", file("acceptance.json"), "--result-file", file("result.txt"), "--result-ref", `results/${day}`, "--out", file("delivery.json")],
        PROVIDER,
      );
      for (const amount of day === 2 ? [["--amount", "400000"], ["--full"]] : [["--full"]]) {
        await ok("repay", ["--line-id", lineId, ...amount, "--execute"], AGENT);
      }
      cycles.push({ digest: built.digest, requestId, spendBlock: BigInt(paid.providerPaid.blockNumber) });
    }
    const days = await Promise.all(cycles.map(async ({ spendBlock }) => (await client.getBlock({ blockNumber: spendBlock })).timestamp / 86_400n));
    assert.equal(new Set(days).size, 3, "three separate UTC days");

    // 3. A deliberate over-cap purchase, recorded as a refusal; then close.
    const { providers } = await ok("line", ["status", "--line-id", lineId, "--provider", provider.address]);
    assert.deepEqual([providers[0].remaining.nextSpendMax, providers[0].remaining.limitedBy], ["0", "LINE_SPEND_CAP"]);
    await ok("intent", intentArgs(1n, path("refusal-intent.json"), ["--allow-block"]));
    await ok("intent", ["sign", "--intent", path("refusal-intent.json"), "--out", path("refusal-signed.json"), "--allow-block"], AGENT);
    const blocked = await ok("submit", ["submit", "--intent", path("refusal-signed.json"), "--execute", "--allow-block"], EXECUTOR);
    assert.deepEqual([blocked.status, blocked.reason], ["blocked", "LINE_SPEND_CAP"]);
    const closed = await ok("sponsor", ["close", "--line-id", lineId, "--execute"], SPONSOR);
    assert.deepEqual([closed.amount, closed.state], ["1000000", "CLOSED"]);

    // 4. Index, export with every participant file, verify.
    const index = path("index.json");
    await ok("indexer", ["index", "--out", index]);
    writeJson(path("declared.json"), DECLARED);
    const files = (skip = []) => [
      ...[1, 2, 3].filter((day) => !skip.includes(day)).flatMap((day) => ["--intent", path(`c${day}-signed.json`)]),
      "--intent", path("refusal-signed.json"),
      ...[1, 2, 3].flatMap((day) => ["--acceptance", path(`c${day}-acceptance.json`), "--delivery", path(`c${day}-delivery.json`)]),
      ...cycles.flatMap(({ digest, requestId }) => ["--request-id", `${digest}=${requestId}`]),
      "--declared", path("declared.json"),
      "--index", index,
    ];
    const exported = await ok("evidence", ["export", "--line-id", lineId, ...files(), "--out", path("bundle.json")]);
    const summary = { cycles: 3, cyclesCleared: 3, principalPaid: "3000000", principalRepaid: "3000000", refusals: 1, missingIntentFiles: 0, missingDeliveries: 0 };
    assert.deepEqual(exported.exporterSummary, summary);
    const bundle = readJson(path("bundle.json"));
    assert.deepEqual(bundle.cycles.map((cycle) => [cycle.digest, cycle.provider.requestId]), cycles.map(({ digest, requestId }) => [digest, requestId]));
    assert.deepEqual(bundle.cycles[1].repayments.map((repayment) => repayment.amount), ["400000", "600000"]);

    const { report, check, ids } = await verifiesOk("verified.json", bundle);
    // A complete bundle leaves nothing MANUAL but the manifest's provenance: this
    // test's manifest is a temporary file, not a committed release record, so
    // the report is ok but not qualifying. Every other check passes.
    assert.deepEqual([report.totals.FAIL, report.qualifying, ids("MANUAL")], [0, false, [PROVENANCE]]);
    assert.equal(check(PROVENANCE).detail, "rehearsal manifest: not a committed release record (it is outside this checkout)");
    const declaredIds = ["bundle.verifierScope", ...["assistance", "commercial", "customerPurpose", "independentControl", "label"].map((key) => `declared.${key}`)];
    assert.deepEqual(ids("DECLARED").sort(), declaredIds.sort());
    assert.deepEqual(report.checks.filter((entry) => entry.id !== PROVENANCE && !["PASS", "DECLARED"].includes(entry.status)), []);
    for (const [key, value] of Object.entries(DECLARED)) {
      assert.deepEqual([check(`declared.${key}`).status, check(`declared.${key}`).value], ["DECLARED", value], key);
      assert.ok(report.scope.declaredOnly.includes(`declared.${key}`), key);
    }
    assert.equal(check("deployment.manifest").status, "PASS");
    assert.match(check("deployment.manifest").detail, /sourceCommit equals its source\.commit/);
    // The manifest tool's own release checks, redone by the verifier.
    assert.deepEqual([check("deployment.artifact").status, check("deployment.config").status], ["PASS", "PASS"]);
    for (const i of [0, 1, 2]) {
      for (const name of ["intent.signature", "provider.acceptance", "provider.delivery"]) {
        assert.ok(report.scope.verifiedAgainstBundleSignatures.includes(`cycle[${i}].${name}`), `cycle[${i}].${name}`);
      }
    }
    assert.ok(report.scope.verifiedAgainstBundleSignatures.includes("refusal[0].intent.signature"));
    assert.match(check("cycle[1].repayments").detail, /^2 repayment\(s\)/);

    // 5. Tampers on the exported bundle, each caught by the check that owns it.
    const tamper = (edit) => {
      const copy = structuredClone(bundle);
      edit(copy);
      return copy;
    };
    await failsAt(
      "t-drop-cycle.json",
      tamper((b) => b.cycles.splice(1, 1)),
      ["completeness.providerPaid", "completeness.repaid"],
      new RegExp(`on chain but not in the bundle: ${cycles[1].digest}@`),
    );
    await failsAt(
      "t-repayment.json",
      tamper((b) => (b.cycles[1].repayments[0].amount = "400001")),
      ["completeness.repaid", "cycle[1].repayments"],
      /on chain but not in the bundle: 400000 from .*; in the bundle but not on chain: 400001 from/,
    );
    await failsAt(
      "t-swap-delivery.json",
      tamper((b) => ([b.cycles[0].provider.delivery, b.cycles[1].provider.delivery] = [b.cycles[1].provider.delivery, b.cycles[0].provider.delivery])),
      ["cycle[0].provider.delivery", "cycle[1].provider.delivery"],
      new RegExp(`it delivers digest ${cycles[1].digest}, not the cycle's ${cycles[0].digest}`),
    );
    // A 65-byte low-s signature by another key over the same digest.
    const cycleSignature = await sign({ hash: cycles[2].digest, privateKey: keyOf(6), to: "hex" });
    const replaced = await failsAt(
      "t-intent-signature.json",
      tamper((b) => (b.cycles[2].intent.signature = cycleSignature)),
      ["cycle[2].intent.signature"],
      new RegExp(`recovers to ${stranger.address}, not ${agent.address}`),
    );
    assert.equal(replaced.check("cycle[2].intent.digest").status, "PASS");
    const refusalSignature = await sign({ hash: bundle.refusals[0].digest, privateKey: keyOf(6), to: "hex" });
    await failsAt(
      "t-refusal-signature.json",
      tamper((b) => (b.refusals[0].intent.signature = refusalSignature)),
      ["refusal[0].intent.signature"],
      new RegExp(`recovers to ${stranger.address}, not ${agent.address}`),
    );
    await failsAt(
      "t-summary.json",
      tamper((b) => (b.exporterSummary.principalRepaid = "2999999")),
      ["exporterSummary"],
      /^principalRepaid is 2999999; this verifier derives 3000000$/,
    );
    const redeclared = await verifiesOk(
      "t-declared.json",
      tamper((b) => (b.declared = { ...b.declared, customerPurpose: "an edited declaration", commercial: null })),
    );
    assert.deepEqual([redeclared.check("declared.customerPurpose").value, redeclared.ids("MANUAL")], ["an edited declaration", [PROVENANCE]]);

    // 6. A cycle exported without its intent file: the export succeeds, and the
    // verifier leaves that cycle's intent-derived checks MANUAL, never PASS, so
    // the report is ok but not qualifying.
    const partial = await ok("evidence", ["export", "--line-id", lineId, ...files([2]), "--out", path("bundle-no-intent.json")]);
    assert.equal(partial.exporterSummary.missingIntentFiles, 1);
    const withoutIntent = await verifiesOk("verified-no-intent.json", readJson(path("bundle-no-intent.json")));
    assert.equal(withoutIntent.report.qualifying, false);
    const manual = [PROVENANCE, ...["intent.digest", "intent.fields", "spend.executor", "intent.signature", "state.termsHash"].map((name) => `cycle[1].${name}`)];
    assert.deepEqual(withoutIntent.ids("MANUAL"), manual);
    assert.deepEqual(withoutIntent.ids("FAIL"), []);
    for (const id of manual.slice(1)) assert.equal(withoutIntent.check(id).detail, "intent file not supplied", id);
    // The acceptance's endpoint is compared with the one the provider's policy approved before the spend.
    assert.match(withoutIntent.check("cycle[1].provider.acceptance").detail, /, at the endpoint provider 0x[0-9a-fA-F]{40}'s policy approved at block \d+; /);
    for (const name of ["spend.receipt", "spend.providerPaid", "spend.usdcTransfer", "state.before", "repayments", "cleared", "receiptStatus", "provider.acceptance", "provider.delivery"]) {
      assert.equal(withoutIntent.check(`cycle[1].${name}`).status, "PASS", name);
    }
    // MANUAL checks never mask a FAIL.
    const masked = await failsAt(
      "t-no-intent-summary.json",
      { ...readJson(path("bundle-no-intent.json")), exporterSummary: { ...partial.exporterSummary, missingIntentFiles: 0 } },
      ["exporterSummary"],
      /^missingIntentFiles is 0; this verifier derives 1$/,
    );
    assert.deepEqual(masked.ids("MANUAL"), manual);

    // 7. A provider receipt in eth_signTypedData_v4 form (with the EIP712Domain
    // type), which the exporter accepts, verifies as well.
    const acceptance = readJson(path("c1-acceptance.json"));
    acceptance.typedData.types = {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...acceptance.typedData.types,
    };
    writeJson(path("c1-acceptance-v4.json"), acceptance);
    const v4Files = files().map((value) => (value === path("c1-acceptance.json") ? path("c1-acceptance-v4.json") : value));
    await ok("evidence", ["export", "--line-id", lineId, ...v4Files, "--out", path("bundle-v4.json")]);
    const v4 = await verifiesOk("verified-v4.json", readJson(path("bundle-v4.json")));
    assert.deepEqual([v4.check("cycle[0].provider.acceptance").status, v4.ids("MANUAL")], ["PASS", [PROVENANCE]]);
  });
});
