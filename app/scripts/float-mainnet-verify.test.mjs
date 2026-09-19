import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, getAddress, http, keccak256, toBytes, toHex, zeroHash } from "viem";
import { sign } from "viem/accounts";

import { BLOCK_REASONS } from "./float-mainnet-config.mjs";
import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { DECLARED_LABEL } from "./float-mainnet-evidence.mjs";
import { INDEX_KIND, validateIndex } from "./float-mainnet-indexer.mjs";
import { PINNED_SOURCE_COMMIT, stableStringify } from "./float-mainnet-preflight.mjs";
import { ACCEPTANCE_KIND, DELIVERY_KIND, signReceipt, validateReceiptFile } from "./float-mainnet-provider.mjs";
import { manifestProvenance, matchRepayments, refusalTransferProblems } from "./float-mainnet-verify.mjs";

// The independent verifier against a real local lifecycle driven through the
// participant CLIs. The evidence bundles are assembled here from the CLIs'
// outputs and chain reads, per the bundle schema, not by the exporter. The
// release manifest comes from float-mainnet-manifest.mjs.

const PORT = 18588;
const PROXY_PORT = 18596;
const CHANGE_PROXY_PORT = 18597;
const REORG_PROXY_PORT = 18620;
const RPC = `http://127.0.0.1:${PORT}`;
const ENDPOINT = "https://provider.example/api/answer";
const PRINCIPAL = 250_000n;
const SIXTY_DAYS = "+5184000";
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };
const WINDOWS = { minimum: 3_600n, maximum: 604_800n, governanceDelay: 172_800n };
const LIMIT_ENV = { protocolReserve: "PROTOCOL_RESERVE", lineReserve: "LINE_RESERVE", lineSpend: "LINE_SPEND", perSpend: "PER_SPEND", dailySpend: "DAILY_SPEND" };
// The exporter's label: the verifier refuses a bundle with any other.
const DECLARED = {
  label: DECLARED_LABEL,
  independentControl: "all keys are held by the test process",
  customerPurpose: "none: a test fixture",
  assistance: "fully scripted",
  commercial: "none",
};

// PilotSmartAccount.isValidSignature expects abi.encode(r, s, v), 96 bytes.
async function accountSignature(hash, privateKey) {
  const { r, s, v } = await sign({ hash, privateKey });
  return encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }], [r, s, Number(v)]);
}

test("a usage error, a missing --manifest among them, prints the verifier's full usage, which names only the env it reads", async () => {
  for (const [args, message] of [
    [[], "a command is required"],
    [["verify"], "--bundle is required"],
    [["verify", "--bundle", "b.json"], /^--manifest <release manifest> is required: the repository's reviewed release record, never a file from the bundle's author$/],
    [["verify", "--bundle", "b.json", "--bogus"], /^verify: Unknown option '--bogus'/],
  ]) {
    const { status, json } = await runTool("verify", args, {});
    assert.equal(status, 2, JSON.stringify(json, null, 2));
    assert.equal(json.ok, false);
    assert.match(json.error.message, message instanceof RegExp ? message : new RegExp(`^${message}$`));
    const usage = json.usage.join("\n");
    assert.match(usage, /verify --bundle <evidence-bundle\.json> --manifest <release manifest> \[--out <report\.json>\]/);
    assert.match(usage, /Reads ARC_RPC_URL only/);
    assert.match(usage, /never a file from the bundle's author/);
    assert.doesNotMatch(usage, /FLOAT_MAINNET_ADDRESS|FLOAT_MAINNET_EXPECTED_CHAIN_ID/);
  }
});

// git in the tests reads no GIT_* variable either, so it never touches another repository.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

test("manifest provenance: a tracked file whose bytes are HEAD's reports the commit that last changed it; other bytes, a gitignored file in the checkout and a copy outside it do not pass", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const tracked = fileURLToPath(new URL("../../contracts/foundry.toml", import.meta.url));
  const commit = execFileSync("git", ["log", "-1", "--format=%H", "--", "contracts/foundry.toml"], { cwd: repo, encoding: "utf8", env: gitEnv }).trim();
  assert.match(commit, /^[0-9a-f]{40}$/);
  // Read as checked out: on a Windows checkout with core.autocrlf the file has CRLF endings, and still matches HEAD's blob.
  assert.deepEqual(manifestProvenance(tracked, readFileSync(tracked)), { file: "contracts/foundry.toml", tracked: true, clean: true, commit });
  // Other bytes for the same tracked path, without writing to the checkout.
  const edited = Buffer.concat([readFileSync(tracked), Buffer.from("# edited\n")]);
  assert.deepEqual(manifestProvenance(tracked, edited), { file: "contracts/foundry.toml", tracked: true, clean: false, commit });
  // A file inside the checkout that git ignores (forge's build output) is not tracked.
  const ignored = fileURLToPath(new URL("../../contracts/out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json", import.meta.url));
  assert.deepEqual(manifestProvenance(ignored, readFileSync(ignored)), { file: "contracts/out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json", tracked: false, clean: false, commit: null });
  const dir = mkdtempSync(join(tmpdir(), "float-provenance-"));
  try {
    const copy = join(dir, "foundry.toml");
    writeFileSync(copy, `${readFileSync(tracked, "utf8")}\n# edited\n`);
    assert.deepEqual(manifestProvenance(copy, readFileSync(copy)), { file: null, tracked: false, clean: false, commit: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest provenance compares the bytes read with HEAD's blob, so an edit hidden from git status by --skip-worktree still fails it (in a scratch repository)", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "float-provenance-repo-")));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=float-test", "-c", "user.email=float-test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: gitEnv });
  try {
    git("init", "-q");
    const file = join(dir, "release.manifest.json");
    writeFileSync(file, '{"ok":true}\n');
    git("add", "release.manifest.json");
    git("commit", "-q", "--no-verify", "-m", "release manifest");
    const commit = git("rev-parse", "HEAD").trim();
    const provenance = () => manifestProvenance(file, readFileSync(file), { root: dir });
    assert.deepEqual(provenance(), { file: "release.manifest.json", tracked: true, clean: true, commit });

    writeFileSync(file, '{"ok":true,"edited":true}\n');
    assert.deepEqual(provenance(), { file: "release.manifest.json", tracked: true, clean: false, commit });
    // git status no longer reports the edit; the bytes still differ from HEAD's blob.
    git("update-index", "--skip-worktree", "release.manifest.json");
    assert.equal(git("status", "--porcelain"), "");
    assert.deepEqual(provenance(), { file: "release.manifest.json", tracked: true, clean: false, commit });

    writeFileSync(file, '{"ok":true}\n');
    assert.deepEqual(provenance(), { file: "release.manifest.json", tracked: true, clean: true, commit });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each listed repayment is matched to its own Repaid log: two identical Repaid logs in one transaction match two listed repayments, and no log is matched twice", () => {
  const lineId = keccak256(toBytes("line"));
  const payer = account(3).address;
  const [tx, otherTx] = ["repayments tx", "other tx"].map((label) => keccak256(toBytes(label)));
  const repaid = (transactionHash, logIndex, amount, args = {}) => ({ eventName: "Repaid", args: { lineId, payer, amount, principalRemaining: 0n, ...args }, transactionHash, logIndex });
  const events = new Map([
    [tx, [repaid(tx, 1, 500n), { eventName: "LineClosed", args: { lineId, sponsor: payer, amount: 500n }, transactionHash: tx, logIndex: 2 }, repaid(tx, 3, 500n)]],
    [otherTx, [repaid(otherTx, 0, 700n, { lineId: keccak256(toBytes("another line")) })]],
  ]);
  const listed = (txHash, amount, from = payer) => ({ txHash, blockNumber: 1n, payer: from, amount });
  const matched = matchRepayments(lineId, [listed(tx, 500n), listed(tx, 500n), listed(tx, 500n), listed(otherTx, 700n)], events);
  // The third identical repayment finds no log left; the other transaction's Repaid is for another line.
  assert.deepEqual(matched.map((log) => log && `${log.transactionHash}:${log.logIndex}`), [`${tx}:1`, `${tx}:3`, null, null]);
  // Payer and amount must both match; the payer's case does not matter.
  assert.deepEqual(matchRepayments(lineId, [listed(tx, 499n), listed(tx, 500n, account(4).address)], events), [null, null]);
  assert.deepEqual(matchRepayments(lineId, [listed(tx, 500n, payer.toLowerCase())], events).map((log) => log.logIndex), [1]);
});

test("a refusal's transaction may move USDC out of the Float only as another Float event's payment, each transfer explained once, and never for the refused digest", () => {
  const float = account(20).address;
  const [sponsor, provider, stranger] = [2, 5, 6].map((i) => account(i).address);
  const lineId = keccak256(toBytes("line"));
  const otherLine = keccak256(toBytes("other line"));
  const refused = keccak256(toBytes("refused digest"));
  const blocked = { eventName: "SpendBlocked", args: { digest: refused, lineId, nonce: 1n, reason: 7 }, logIndex: 0 };
  const transfer = (logIndex, to, value, from = float) => ({ eventName: "Transfer", args: { from, to, value }, logIndex });
  const closed = (logIndex, amount) => ({ eventName: "LineClosed", args: { lineId: otherLine, sponsor, amount }, logIndex });
  const claimed = (logIndex, amount) => ({ eventName: "SponsorClaimed", args: { lineId: otherLine, sponsor, amount }, logIndex });
  const paid = (logIndex, digest, principal) => ({ eventName: "ProviderPaid", args: { digest, lineId: otherLine, provider, principal, dueAt: 1n }, logIndex });
  const problems = (events, transfers) => refusalTransferProblems(float, refused, events, transfers);
  const unexplained = (...moves) => [`the transaction moves USDC out of the Float that no other Float event in it pays: ${moves.join(", ")}`];

  // The refusal alone; USDC moving into the Float (a repayment in the same batch) is not outgoing.
  assert.deepEqual(problems([blocked], []), []);
  assert.deepEqual(problems([blocked, { eventName: "Repaid", args: { lineId, payer: stranger, amount: 9n, principalRemaining: 0n }, logIndex: 2 }], [transfer(1, float, 9n, stranger)]), []);
  // A batch that also closes a line, pays another digest and claims a defaulted line.
  const batch = [blocked, closed(2, 1_000_000n), paid(4, keccak256(toBytes("other digest")), 250_000n), claimed(6, 300n)];
  const batchTransfers = [transfer(1, sponsor, 1_000_000n), transfer(3, provider, 250_000n), transfer(5, sponsor, 300n)];
  assert.deepEqual(problems(batch, batchTransfers), []);
  // The payee's address case does not matter.
  assert.deepEqual(problems([blocked, closed(2, 5n)], [transfer(1, sponsor.toLowerCase(), 5n)]), []);

  // An outgoing transfer no event pays.
  assert.deepEqual(problems([blocked], [transfer(1, stranger, 5n)]), unexplained(`5 to ${stranger}`));
  assert.deepEqual(problems(batch, [...batchTransfers, transfer(7, stranger, 1n)]), unexplained(`1 to ${stranger}`));
  // An event explains one transfer, of exactly its amount to its payee, made before it.
  assert.deepEqual(problems([blocked, closed(3, 5n)], [transfer(1, sponsor, 5n), transfer(2, sponsor, 5n)]), unexplained(`5 to ${sponsor}`));
  assert.deepEqual(problems([blocked, closed(2, 5n)], [transfer(1, sponsor, 6n)]), unexplained(`6 to ${sponsor}`));
  assert.deepEqual(problems([blocked, closed(2, 5n)], [transfer(1, stranger, 5n)]), unexplained(`5 to ${stranger}`));
  assert.deepEqual(problems([blocked, closed(1, 5n)], [transfer(2, sponsor, 5n)]), unexplained(`5 to ${sponsor}`));
  // A ProviderPaid carrying the refused digest fails, even with its own transfer.
  assert.deepEqual(problems([blocked, paid(2, refused, 7n)], [transfer(1, provider, 7n)]), [`the transaction also emits ProviderPaid for the refused digest ${refused}`]);
});

// The indexer feeds the exporter, not the verifier; its block numbers must be canonical decimal strings.
test("an index's block numbers must be in their stored form: a lone leading-zero block number is refused", () => {
  const deployment = { chainId: CHAIN_ID, address: account(20).address };
  const event = (blockNumber) => ({
    event: "SponsorAllowed",
    blockNumber,
    logIndex: 0,
    transactionHash: keccak256(toBytes(`tx ${blockNumber}`)),
    blockHash: keccak256(toBytes(`block ${blockNumber}`)),
    transactionIndex: 0,
    from: account(0).address,
    timestamp: "1",
    args: { sponsor: account(2).address, allowed: true },
  });
  const index = (events, edit = {}) => ({
    kind: INDEX_KIND,
    schema: 1,
    chainId: CHAIN_ID.toString(),
    address: deployment.address,
    fromBlock: "100",
    checkpoint: { blockNumber: "200", blockHash: keccak256(toBytes("checkpoint")) },
    events,
    ...edit,
  });
  assert.equal(validateIndex(index([event("101"), event("102")]), deployment).events.length, 2);
  assert.throws(() => validateIndex(index([event("101"), event("0102")]), deployment), /^Error: events\[1\]\.blockNumber 0102 is not in its stored form$/);
  assert.throws(() => validateIndex(index([], { fromBlock: "0100" }), deployment), /^Error: the index has no valid fromBlock, checkpoint or events$/);
  assert.throws(
    () => validateIndex(index([], { checkpoint: { blockNumber: "0200", blockHash: keccak256(toBytes("checkpoint")) } }), deployment),
    /^Error: the index has no valid fromBlock, checkpoint or events$/,
  );
});

describe("independent candidate verifier", { skip: e2eSkip }, () => {
  // Account index 1 is not used.
  const [owner, sponsor, agent, executor, provider, stranger, accountSigner] = [0, 2, 3, 4, 5, 6, 7].map(account);
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
  let usdc;
  let float;
  let deployment;
  let manifest;
  let bundleA;

  async function deploy(path, args) {
    const { abi, bytecode } = artifact(path);
    const hash = await walletOf(owner).deployContract({ abi, bytecode: bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", path);
    return receipt;
  }

  const path = (name) => join(dir, name);
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  const writeJson = (file, value) => writeFileSync(file, stableStringify(value));
  // env may name another Float with FLOAT_MAINNET_ADDRESS.
  const cli = (tool, args, env = {}) =>
    runTool(tool, args, { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(), FLOAT_MAINNET_ADDRESS: float, ...env });

  async function ok(tool, args, env) {
    const { status, json } = await cli(tool, args, env);
    assert.equal(status, 0, `${tool} ${args[0]}: ${JSON.stringify(json, null, 2)}`);
    assert.equal(json.ok, true);
    return json;
  }

  // The verifier is given the RPC, the bundle and the release manifest only:
  // no Float address, chain id or key.
  async function verify(name, bundle, { release = manifest, extra = [], rpc = RPC } = {}) {
    writeJson(path(name), bundle);
    const { status, json } = await runTool("verify", ["verify", "--bundle", path(name), "--manifest", release, ...extra], { ARC_RPC_URL: rpc });
    const check = (id) => json.checks?.find((entry) => entry.id === id) ?? assert.fail(`no check ${id} in ${JSON.stringify(json, null, 2)}`);
    const ids = (status) => json.checks.filter((entry) => entry.status === status).map((entry) => entry.id);
    return { status, report: json, check, ids };
  }

  async function verifiesOk(name, bundle, options) {
    const result = await verify(name, bundle, options);
    const failed = result.report.checks?.filter((entry) => entry.status === "FAIL");
    assert.equal(result.status, 0, JSON.stringify(failed ?? result.report, null, 2));
    assert.equal(result.report.ok, true);
    return result;
  }

  // Fails at `id` with `pattern`; given a list of ids, fails at exactly those,
  // the first with `pattern`.
  async function failsAt(name, bundle, id, pattern, options) {
    const result = await verify(name, bundle, options);
    assert.equal(result.status, 1, JSON.stringify(result.report, null, 2));
    assert.deepEqual([result.report.ok, result.report.qualifying], [false, false]);
    if (Array.isArray(id)) {
      assert.deepEqual(result.ids("FAIL"), id, `${name}: ${JSON.stringify(result.report.checks.filter((entry) => entry.status === "FAIL"), null, 2)}`);
    }
    const entry = result.check([id].flat()[0]);
    assert.equal(entry.status, "FAIL", `${entry.id}: ${JSON.stringify(entry)}`);
    assert.match(entry.detail, pattern);
    return result;
  }

  const event = (output, name) => output.events.find((entry) => entry.event === name) ?? assert.fail(`no ${name} in ${JSON.stringify(output)}`);
  const repayment = (output) => {
    const repaid = event(output, "Repaid");
    return { txHash: repaid.transactionHash, blockNumber: repaid.blockNumber, payer: repaid.args.payer, amount: repaid.args.amount };
  };
  const openArgs = (agentAddress) => [
    "open",
    "--agent", agentAddress,
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
  const buildArgs = (agentAddress, principal, out, extra = []) => [
    "build",
    "--agent", agentAddress,
    "--sponsor", sponsor.address,
    "--provider", provider.address,
    "--endpoint", ENDPOINT,
    "--principal", principal.toString(),
    "--out", out,
    ...extra,
  ];

  // One purchase through the CLIs: the agent builds and signs, the provider
  // accepts (when requestId is given) before the executor pays, then delivers.
  async function purchase(name, { requestId = null, extra = [], on = {} } = {}) {
    await ok("intent", buildArgs(agent.address, PRINCIPAL, path(`${name}.json`), extra), on);
    await ok("intent", ["sign", "--intent", path(`${name}.json`), "--out", path(`${name}-signed.json`)], { ...AGENT, ...on });
    return settle(name, `${name}-signed.json`, requestId, on);
  }

  async function settle(name, signedFile, requestId, on = {}) {
    if (requestId !== null) {
      await ok(
        "provider",
        ["accept", "--intent", path(signedFile), "--endpoint", ENDPOINT, "--price", PRINCIPAL.toString(), "--request-id", requestId, "--out", path(`${name}-acceptance.json`)],
        { ...PROVIDER, ...on },
      );
    }
    const paid = await ok("submit", ["submit", "--intent", path(signedFile), "--execute"], { ...EXECUTOR, ...on });
    assert.equal(paid.status, "paid");
    if (requestId !== null) {
      writeFileSync(path(`${name}-result.txt`), `result for ${requestId}`);
      await ok(
        "provider",
        ["deliver", "--acceptance", path(`${name}-acceptance.json`), "--result-file", path(`${name}-result.txt`), "--result-ref", `results/${name}`, "--out", path(`${name}-delivery.json`)],
        { ...PROVIDER, ...on },
      );
    }
    const intent = readJson(path(signedFile));
    return {
      index: 0,
      digest: intent.digest,
      intent,
      spend: { txHash: paid.txHash, blockNumber: paid.providerPaid.blockNumber, executor: executor.address },
      repayments: [],
      cleared: false,
      provider: {
        requestId,
        acceptance: requestId === null ? null : readJson(path(`${name}-acceptance.json`)),
        delivery: requestId === null ? null : readJson(path(`${name}-delivery.json`)),
      },
    };
  }

  async function observed() {
    const head = await client.getBlock();
    return { blockNumber: head.number.toString(), blockHash: head.hash };
  }

  function bundleOf({ line, cycles, refusals, exit, observedAt, summary }) {
    return {
      kind: "ShadowFloatMainnet.EvidenceBundle",
      schema: 1,
      deployment,
      observedAt,
      line,
      cycles: cycles.map((cycle, i) => ({ ...cycle, index: i + 1 })),
      refusals,
      exit,
      declared: DECLARED,
      exporterSummary: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, value.toString()])),
      verifierScope: "assembled by float-mainnet-verify.test.mjs from CLI outputs",
    };
  }

  async function openLine(agentAddress, on = {}) {
    const opened = await ok("sponsor", openArgs(agentAddress), { ...SPONSOR, ...on });
    const logged = event(opened, "LineOpened");
    return {
      lineId: opened.lineId,
      sponsor: sponsor.address,
      agent: agentAddress,
      epoch: logged.args.epoch,
      opened: { txHash: logged.transactionHash, blockNumber: logged.blockNumber },
    };
  }

  before(async () => {
    anvil = await startAnvil(PORT);
    dir = mkdtempSync(join(tmpdir(), "float-verify-"));
    usdc = getAddress((await deploy("MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6])).contractAddress);
    const deployed = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [
      usdc,
      CHAIN_ID,
      MAXIMA,
      INITIAL,
      WINDOWS.minimum,
      WINDOWS.maximum,
      WINDOWS.governanceDelay,
    ]);
    float = getAddress(deployed.contractAddress);
    deployment = {
      chainId: CHAIN_ID.toString(),
      address: float,
      deployBlock: deployed.blockNumber.toString(),
      runtimeKeccak256: keccak256(await client.getCode({ address: float })),
      sourceCommit: PINNED_SOURCE_COMMIT,
    };

    // The committed manifest tool, pinned at the deploy block (before any
    // allowlisting), reading the chain through two host names for its two RPCs.
    manifest = path("manifest.json");
    const limits = Object.entries(LIMIT_ENV).flatMap(([field, suffix]) => [
      [`FLOAT_MAINNET_MAX_${suffix}`, MAXIMA[field].toString()],
      [`FLOAT_MAINNET_INIT_${suffix}`, INITIAL[field].toString()],
    ]);
    const release = await runTool(
      "manifest",
      ["--out", manifest, "--address", float, "--tx", deployed.transactionHash, "--block", deployed.blockNumber.toString()],
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

    const { abi } = artifact("MockAsset.sol/MockAsset.json");
    for (const [holder, amount] of [[sponsor, 10_000_000n], [agent, 3_000_000n]]) {
      const hash = await walletOf(owner).writeContract({ address: usdc, abi, functionName: "mint", args: [holder.address, amount] });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    }
    await ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], OWNER);
  });

  after(() => {
    anvil?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a real lifecycle (3 cycles, a partial repayment, a refusal, close) verifies ok from the bundle's pointers alone", async () => {
    const line = await openLine(agent.address);

    const first = await purchase("c1", { requestId: "req-1", extra: ["--executor", executor.address] });
    first.repayments.push(repayment(await ok("repay", ["--line-id", line.lineId, "--amount", "100000", "--execute"], AGENT)));
    first.repayments.push(repayment(await ok("repay", ["--line-id", line.lineId, "--full", "--execute"], AGENT)));
    first.cleared = true;

    const second = await purchase("c2", { requestId: "req-2" });
    second.repayments.push(repayment(await ok("repay", ["--line-id", line.lineId, "--full", "--execute"], AGENT)));
    second.cleared = true;

    const { providers } = await ok("line", ["status", "--line-id", line.lineId, "--provider", provider.address]);
    const overCap = BigInt(providers[0].remaining.nextSpendMax) + 1n;
    await ok("intent", buildArgs(agent.address, overCap, path("over.json"), ["--allow-block"]));
    await ok("intent", ["sign", "--intent", path("over.json"), "--out", path("over-signed.json"), "--allow-block"], AGENT);
    const blocked = await ok("submit", ["submit", "--intent", path("over-signed.json"), "--execute", "--allow-block"], EXECUTOR);
    assert.equal(blocked.status, "blocked");
    const refusal = {
      digest: blocked.digest,
      txHash: blocked.txHash,
      blockNumber: event(blocked, "SpendBlocked").blockNumber,
      reason: blocked.reason,
      intent: readJson(path("over-signed.json")),
    };

    const third = await purchase("c3");
    third.repayments.push(repayment(await ok("repay", ["--line-id", line.lineId, "--full", "--execute"], AGENT)));
    third.cleared = true;

    const closed = await ok("sponsor", ["close", "--line-id", line.lineId, "--execute"], SPONSOR);
    const logged = event(closed, "LineClosed");
    bundleA = bundleOf({
      line,
      cycles: [first, second, third],
      refusals: [refusal],
      exit: { kind: "close", txHash: logged.transactionHash, blockNumber: logged.blockNumber, amount: closed.amount },
      observedAt: await observed(),
      summary: {
        cycles: 3,
        cyclesCleared: 3,
        principalPaid: 3n * PRINCIPAL,
        principalRepaid: 3n * PRINCIPAL,
        refusals: 1,
        missingIntentFiles: 0,
        missingDeliveries: 1,
      },
    });

    const { report, check, ids } = await verifiesOk("a.json", bundleA, { extra: ["--out", path("a-report.json")] });
    assert.equal(report.kind, "ShadowFloatMainnet.VerificationReport");
    assert.deepEqual(report.observedAt, bundleA.observedAt);
    const { out, ...printed } = report;
    assert.equal(out, path("a-report.json"));
    assert.deepEqual(readJson(path("a-report.json")), printed);
    assert.deepEqual(Object.keys(report.scope).sort(), ["declaredOnly", "notChecked", "verifiedAgainstBundleSignatures", "verifiedOnChain"]);
    // ok, but not qualifying: cycle 3 has no provider receipts, and the
    // manifest, written to a temporary directory, is not a committed release record.
    assert.deepEqual([report.ok, report.qualifying], [true, false]);
    assert.deepEqual(ids("MANUAL"), ["deployment.manifestProvenance", "cycle[2].provider.acceptance", "cycle[2].provider.delivery"]);
    assert.equal(check("deployment.manifestProvenance").detail, "rehearsal manifest: not a committed release record (it is outside this checkout)");
    assert.ok(report.scope.notChecked.includes("deployment.manifestProvenance: rehearsal manifest: not a committed release record (it is outside this checkout)"));
    assert.ok(!report.scope.verifiedOnChain.includes("deployment.manifestProvenance"));
    // Nothing happened on the line after observedAt.
    assert.deepEqual(report.afterObservedAt, { head: bundleA.observedAt.blockNumber, scannedTo: bundleA.observedAt.blockNumber, truncated: false, laterLineEvents: [] });

    for (const id of [
      "bundle.shape",
      "deployment.runtimeCode",
      "deployment.manifest",
      "deployment.artifact",
      "deployment.config",
      "observedAt.blockHash",
      "line.opened",
      "line.idRecomputed",
      "completeness.providerPaid",
      "completeness.spendBlocked",
      "completeness.repaid",
      "completeness.exit",
      "exit.event",
      "exit.state",
      "exporterSummary",
      "refusal[0].event",
      "refusal[0].intent.digest",
      "refusal[0].noUsdcTransfer",
      "refusal[0].receiptStatus",
      ...[0, 1, 2].flatMap((i) =>
        ["spend.receipt", "spend.providerPaid", "spend.usdcTransfer", "spend.executor", "intent.digest", "intent.fields", "intent.signature", "state.before", "state.termsHash", "repayments", "cleared", "receiptStatus"].map(
          (name) => `cycle[${i}].${name}`,
        ),
      ),
      "cycle[0].provider.acceptance",
      "cycle[0].provider.delivery",
      "cycle[1].provider.acceptance",
      "cycle[1].provider.delivery",
    ]) {
      assert.equal(check(id).status, "PASS", `${id}: ${check(id).detail}`);
    }
    assert.match(check("cycle[0].spend.executor").detail, new RegExp(`named executor ${executor.address}`));
    assert.match(check("cycle[0].intent.signature").detail, /\(eoa\): 65-byte low-s ECDSA signature recovers to/);
    assert.match(check("cycle[0].repayments").detail, /^2 repayment\(s\)/);
    assert.match(check("deployment.artifact").detail, /immutable ranges masked, the runtime code at 0x[0-9a-fA-F]{40} equals the local artifact compiled from the pinned reviewed lineage/);
    assert.match(check("deployment.config").detail, new RegExp(`usdc\\(\\) is its configured USDC ${usdc}$`));
    // The receipts' times are the provider's own claim, and the report says so.
    assert.match(check("cycle[0].provider.acceptance").detail, /at the intent's endpoint; the provider asserts it accepted at \d+, no later than the payment block's timestamp \d+$/);
    assert.match(check("cycle[0].provider.delivery").detail, /; the provider asserts it delivered at \d+, no earlier than the payment block's timestamp \d+$/);
    assert.ok(report.scope.notChecked.some((entry) => /^when the provider accepted or delivered: acceptedAt and deliveredAt are the provider's own claim/.test(entry)));
    // Missing provider receipts are MANUAL, never PASS.
    assert.deepEqual([check("cycle[2].provider.acceptance").status, check("cycle[2].provider.delivery").status], ["MANUAL", "MANUAL"]);
    assert.ok(report.scope.notChecked.includes("cycle[2].provider.delivery: no DeliveryReceipt in the bundle"));
    assert.ok(report.scope.verifiedOnChain.includes("completeness.providerPaid"));
    assert.ok(report.scope.verifiedAgainstBundleSignatures.includes("cycle[0].intent.signature"));
    assert.ok(report.scope.verifiedAgainstBundleSignatures.includes("cycle[1].provider.delivery"));
    assert.ok(!report.scope.verifiedOnChain.includes("cycle[0].intent.signature"));
    for (const key of Object.keys(DECLARED)) {
      assert.deepEqual(check(`declared.${key}`), {
        id: `declared.${key}`,
        status: "DECLARED",
        detail: `declared by ${JSON.stringify(DECLARED.label)}; reported verbatim, not verified`,
        label: DECLARED.label,
        value: DECLARED[key],
      });
      assert.ok(report.scope.declaredOnly.includes(`declared.${key}`));
    }
    assert.equal(report.totals.FAIL, 0);
  });

  test("a smart-account agent's cycle verifies through isValidSignature at the block before the spend", async () => {
    const receipt = await deploy("ShadowFloatMainnetPilotLifecycle.t.sol/PilotSmartAccount.json", [accountSigner.address]);
    const smartAgent = getAddress(receipt.contractAddress);
    const line = await openLine(smartAgent);
    const built = await ok("intent", buildArgs(smartAgent, PRINCIPAL, path("s.json")));
    const signature = await accountSignature(built.digest, keyOf(7));
    const attached = await ok("intent", ["verify", "--intent", path("s.json"), "--signature", signature, "--out", path("s-signed.json")]);
    assert.equal(attached.signerKind, "erc1271");
    const cycle = await settle("s", "s-signed.json", "req-s");

    // No repayment: the line is left DRAWN with no exit.
    const bundle = bundleOf({
      line,
      cycles: [cycle],
      refusals: [],
      exit: { kind: "none", txHash: null, blockNumber: null, amount: null },
      observedAt: await observed(),
      summary: { cycles: 1, cyclesCleared: 0, principalPaid: PRINCIPAL, principalRepaid: 0, refusals: 0, missingIntentFiles: 0, missingDeliveries: 0 },
    });
    const { report, check, ids } = await verifiesOk("smart.json", bundle);
    // Every file present: nothing is MANUAL but the rehearsal manifest's
    // provenance, which alone keeps the report from qualifying.
    assert.deepEqual([report.qualifying, ids("MANUAL")], [false, ["deployment.manifestProvenance"]]);
    assert.equal(check("cycle[0].intent.signature").status, "PASS");
    assert.match(check("cycle[0].intent.signature").detail, /\(erc1271\): isValidSignature on 0x[0-9a-fA-F]{40} returned the ERC-1271 magic value at block \d+/);
    assert.match(check("exit.state").detail, /the line is DRAWN/);
    assert.match(check("cycle[0].cleared").detail, /cleared false: principalRemaining after this cycle's repayments is 250000/);
    assert.equal(check("completeness.exit").status, "PASS");

    // An EOA-style signature by the account's signer is not the account's signature.
    const eoaStyle = structuredClone(bundle);
    eoaStyle.cycles[0].intent.signature = await sign({ hash: built.digest, privateKey: keyOf(7), to: "hex" });
    await failsAt("smart-eoa-style.json", eoaStyle, "cycle[0].intent.signature", /isValidSignature on 0x[0-9a-fA-F]{40} at block \d+ failed/);

    // The line is repaid after observedAt: the pinned bundle still verifies,
    // and the report names what it leaves out, without changing ok.
    await ok("repay", ["--line-id", line.lineId, "--full", "--execute"], AGENT);
    const stale = await verifiesOk("smart-stale.json", bundle);
    assert.deepEqual([stale.ids("MANUAL"), stale.report.afterObservedAt.laterLineEvents], [["deployment.manifestProvenance"], [{ event: "Repaid", count: 1 }]]);
    assert.ok(BigInt(stale.report.afterObservedAt.head) > BigInt(bundle.observedAt.blockNumber));
    assert.deepEqual([stale.report.afterObservedAt.scannedTo, stale.report.afterObservedAt.truncated], [stale.report.afterObservedAt.head, false]);
    assert.match(stale.check("exit.state").detail, /the line is DRAWN/);
  });

  test("the anchor checks catch a manifest inconsistent with the chain or the reviewed code; a consistent manifest of one's own passes them, and only its provenance keeps the report from qualifying", async () => {
    const release = readJson(manifest);
    assert.deepEqual([release.ok, release.contract.address, release.config.usdc], [true, float, usdc]);
    const { check } = await verifiesOk("a-manifest.json", bundleA);
    assert.match(check("deployment.manifest").detail, /sourceCommit equals its pinnedLineage\.commit$/);

    writeJson(path("other-manifest.json"), { ...release, contract: { ...release.contract, address: usdc }, deployment: { ...release.deployment, blockNumber: "1" } });
    await failsAt(
      "a-other-manifest.json",
      bundleA,
      ["deployment.manifest"],
      /the manifest's address is .*, not the bundle's .*; the manifest's deploy block is 1/,
      { release: path("other-manifest.json") },
    );

    // A genuine-bytecode Float deployed with a token of its own as usdc(), run
    // through a self-dealing purchase, under a manifest that copies the reviewed
    // release's ok flag and config but names this Float. That manifest is
    // inconsistent with the chain, and deployment.config catches it.
    const token = getAddress((await deploy("MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6])).contractAddress);
    const deployed = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [
      token,
      CHAIN_ID,
      MAXIMA,
      INITIAL,
      WINDOWS.minimum,
      WINDOWS.maximum,
      WINDOWS.governanceDelay,
    ]);
    const mock = getAddress(deployed.contractAddress);
    const on = { FLOAT_MAINNET_ADDRESS: mock };
    const { abi } = artifact("MockAsset.sol/MockAsset.json");
    const minted = await walletOf(owner).writeContract({ address: token, abi, functionName: "mint", args: [sponsor.address, 10_000_000n] });
    assert.equal((await client.waitForTransactionReceipt({ hash: minted })).status, "success");
    await ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], { ...OWNER, ...on });
    const line = await openLine(agent.address, on);
    const cycle = await purchase("mock", { on });
    const runtimeKeccak256 = keccak256(await client.getCode({ address: mock }));
    writeJson(path("mock-manifest.json"), {
      ...release,
      contract: { ...release.contract, address: mock },
      bytecode: { ...release.bytecode, onchainRuntimeKeccak256: runtimeKeccak256 },
      deployment: { ...release.deployment, blockNumber: deployed.blockNumber.toString() },
    });
    const bundle = {
      ...bundleOf({
        line,
        cycles: [cycle],
        refusals: [],
        exit: { kind: "none", txHash: null, blockNumber: null, amount: null },
        observedAt: await observed(),
        summary: { cycles: 1, cyclesCleared: 0, principalPaid: PRINCIPAL, principalRepaid: 0, refusals: 0, missingIntentFiles: 0, missingDeliveries: 1 },
      }),
      deployment: { ...deployment, address: mock, deployBlock: deployed.blockNumber.toString(), runtimeKeccak256 },
    };
    const caught = await failsAt(
      "mock-usdc.json",
      bundle,
      ["deployment.config"],
      new RegExp(`the immutable values in the runtime code are not the manifest's config; usdc\\(\\) is ${token}, not the manifest's configured USDC ${usdc}`),
      { release: path("mock-manifest.json") },
    );
    assert.deepEqual([caught.check("deployment.manifest").status, caught.check("deployment.artifact").status], ["PASS", "PASS"]);

    // The same Float under a manifest that records its own token as config.usdc
    // is consistent with the chain and the reviewed code, so every anchor check
    // passes. Only provenance tells it from the reviewed release: it is not a
    // committed release record, so the report is ok but not qualifying.
    writeJson(path("self-manifest.json"), { ...readJson(path("mock-manifest.json")), config: { ...release.config, usdc: token } });
    const self = await verifiesOk("mock-self.json", bundle, { release: path("self-manifest.json") });
    assert.deepEqual(
      ["deployment.runtimeCode", "deployment.manifest", "deployment.artifact", "deployment.config"].map((id) => self.check(id).status),
      ["PASS", "PASS", "PASS", "PASS"],
    );
    assert.match(self.check("deployment.config").detail, new RegExp(`usdc\\(\\) is its configured USDC ${token}$`));
    assert.deepEqual(
      [self.report.ok, self.report.qualifying, self.check("deployment.manifestProvenance").status, self.check("deployment.manifestProvenance").detail],
      [true, false, "MANUAL", "rehearsal manifest: not a committed release record (it is outside this checkout)"],
    );
  });

  test("a Float whose runtime differs from the artifact outside its immutables fails deployment.artifact, and nothing else", async () => {
    const release = readJson(manifest);
    const deployed = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [
      usdc,
      CHAIN_ID,
      MAXIMA,
      INITIAL,
      WINDOWS.minimum,
      WINDOWS.maximum,
      WINDOWS.governanceDelay,
    ]);
    const altered = getAddress(deployed.contractAddress);
    // The first INVALID (0xfe) instruction outside the immutable ranges becomes
    // the undefined opcode 0x0c: one byte differs, and the code behaves the same
    // (both halt exceptionally, and no PUSH boundary or JUMPDEST moves).
    const ranges = Object.values(artifact("ShadowFloatMainnet.sol/ShadowFloatMainnet.json").deployedBytecode.immutableReferences).flat();
    const bytes = toBytes(await client.getCode({ address: altered }));
    let offset = null;
    for (let i = 0; i < bytes.length; i += bytes[i] >= 0x60 && bytes[i] <= 0x7f ? bytes[i] - 0x5e : 1) {
      if (bytes[i] === 0xfe && !ranges.some(({ start, length }) => i >= start && i < start + length)) {
        offset = i;
        break;
      }
    }
    assert.notEqual(offset, null, "the runtime has an INVALID instruction outside its immutable ranges");
    bytes[offset] = 0x0c;
    await testClient.setCode({ address: altered, bytecode: toHex(bytes) });
    await testClient.mine({ blocks: 1 });

    const on = { FLOAT_MAINNET_ADDRESS: altered };
    await ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], { ...OWNER, ...on });
    const line = await openLine(agent.address, on);
    const runtimeKeccak256 = keccak256(await client.getCode({ address: altered }));
    writeJson(path("altered-manifest.json"), {
      ...release,
      contract: { ...release.contract, address: altered },
      bytecode: { ...release.bytecode, onchainRuntimeKeccak256: runtimeKeccak256 },
      deployment: { ...release.deployment, blockNumber: deployed.blockNumber.toString() },
    });
    const bundle = {
      ...bundleOf({
        line,
        cycles: [],
        refusals: [],
        exit: { kind: "none", txHash: null, blockNumber: null, amount: null },
        observedAt: await observed(),
        summary: { cycles: 0, cyclesCleared: 0, principalPaid: 0, principalRepaid: 0, refusals: 0, missingIntentFiles: 0, missingDeliveries: 0 },
      }),
      deployment: { ...deployment, address: altered, deployBlock: deployed.blockNumber.toString(), runtimeKeccak256 },
    };
    const caught = await failsAt(
      "altered-code.json",
      bundle,
      ["deployment.artifact"],
      new RegExp(`^with its immutables masked, the runtime code at ${altered} differs from the artifact's$`),
      { release: path("altered-manifest.json") },
    );
    assert.deepEqual(
      ["deployment.runtimeCode", "deployment.manifest", "deployment.config", "exit.state"].map((id) => caught.check(id).status),
      ["PASS", "PASS", "PASS", "PASS"],
    );
  });

  test("tampered bundles fail at the check that catches them", async () => {
    const tamper = (edit) => {
      const copy = structuredClone(bundleA);
      edit(copy);
      return copy;
    };
    // Drops the file's own digest and signer payload, so only the recomputation can catch an edit.
    const bare = (intent) => {
      delete intent.digest;
      delete intent.externalSignerTypedData;
    };

    const strangerSignature = await sign({ hash: bundleA.cycles[0].digest, privateKey: keyOf(6), to: "hex" });
    const wrongSignature = await failsAt(
      "t-signature.json",
      tamper((b) => (b.cycles[0].intent.signature = strangerSignature)),
      "cycle[0].intent.signature",
      new RegExp(`recovers to ${stranger.address}, not ${agent.address}`),
    );
    assert.equal(wrongSignature.check("cycle[0].intent.digest").status, "PASS");

    await failsAt(
      "t-principal.json",
      tamper((b) => {
        b.cycles[1].intent.typedData.message.principal = (PRINCIPAL + 1n).toString();
        bare(b.cycles[1].intent);
      }),
      "cycle[1].intent.digest",
      /the intent's message recomputes to digest 0x[0-9a-f]{64} .*not the cycle's/,
    );
    await failsAt(
      "t-principal-with-digest.json",
      tamper((b) => (b.cycles[1].intent.typedData.message.principal = (PRINCIPAL + 1n).toString())),
      "cycle[1].intent.digest",
      /the intent file is rejected: .*the file was altered/,
    );
    const terms = await failsAt(
      "t-terms.json",
      tamper((b) => {
        b.cycles[0].intent.typedData.message.termsHash = keccak256(toBytes("other terms"));
        bare(b.cycles[0].intent);
      }),
      "cycle[0].state.termsHash",
      /currentTermsHash\(line, 0x[0-9a-fA-F]{40}\) at block \d+ is 0x[0-9a-f]{64}, not the intent's termsHash/,
    );
    assert.equal(terms.check("cycle[0].intent.digest").status, "FAIL");

    const omitted = await failsAt(
      "t-omitted.json",
      // Renumbered, so only the omission itself is left to catch.
      tamper((b) => {
        b.cycles.splice(1, 1);
        b.cycles[1].index = 2;
      }),
      "completeness.providerPaid",
      new RegExp(`on chain but not in the bundle: ${bundleA.cycles[1].digest}@${bundleA.cycles[1].spend.txHash}`),
    );
    assert.equal(omitted.check("completeness.repaid").status, "FAIL");

    const fabricatedDigest = keccak256(toBytes("fabricated cycle"));
    const fabricatedTx = keccak256(toBytes("no such transaction"));
    const fabricated = await failsAt(
      "t-fabricated.json",
      tamper((b) => b.cycles.push({ ...structuredClone(b.cycles[2]), index: 4, digest: fabricatedDigest, spend: { ...b.cycles[2].spend, txHash: fabricatedTx }, repayments: [] })),
      "completeness.providerPaid",
      new RegExp(`in the bundle but not on chain: ${fabricatedDigest}@${fabricatedTx}`),
    );
    assert.equal(fabricated.check("cycle[3].spend.receipt").status, "FAIL");

    // A delivery re-signed by another key that still names the provider.
    const original = validateReceiptFile(bundleA.cycles[0].provider.delivery, { chainId: CHAIN_ID, address: float }, DELIVERY_KIND);
    const forgedDelivery = await signReceipt(
      { address: provider.address, signTypedData: (typed) => stranger.signTypedData(typed) },
      { kind: DELIVERY_KIND, chainId: CHAIN_ID, verifyingContract: float, message: original.message, requestId: original.requestId, resultRef: original.resultRef },
    );
    const forged = await failsAt(
      "t-forged-receipt.json",
      tamper((b) => (b.cycles[0].provider.delivery = forgedDelivery)),
      "cycle[0].provider.delivery",
      new RegExp(`signature: signature recovers to ${stranger.address}, not ${provider.address}`),
    );
    assert.equal(forged.check("cycle[0].provider.acceptance").status, "PASS");
    // The delivery signs its result location: a rewritten one fails, and a delivery that names none verifies.
    await failsAt(
      "t-result-ref.json",
      tamper((b) => (b.cycles[0].provider.delivery.resultRef = "results/elsewhere")),
      ["cycle[0].provider.delivery"],
      /^resultRef "results\/elsewhere" does not hash to the message's resultRefHash 0x[0-9a-f]{64}$/,
    );
    const bareDelivery = await signReceipt(provider, {
      kind: DELIVERY_KIND,
      chainId: CHAIN_ID,
      verifyingContract: float,
      message: { ...original.message, resultRefHash: zeroHash },
      requestId: original.requestId,
    });
    const noRef = await verifiesOk("t-delivery-no-ref.json", tamper((b) => (b.cycles[0].provider.delivery = bareDelivery)));
    assert.deepEqual([Object.hasOwn(bareDelivery, "resultRef"), noRef.check("cycle[0].provider.delivery").status], [false, "PASS"]);

    await failsAt(
      "t-summary.json",
      tamper((b) => (b.exporterSummary.principalPaid = (3n * PRINCIPAL + 1n).toString())),
      "exporterSummary",
      /^principalPaid is 750001; this verifier derives 750000$/,
    );

    // Moving cycle 0's partial repayment to cycle 1 keeps the totals but not the windows.
    const shuffled = await failsAt(
      "t-shuffled.json",
      tamper((b) => b.cycles[1].repayments.unshift(b.cycles[0].repayments.shift())),
      "cycle[1].repayments",
      /the Repaid is not between this cycle's payment and the next one/,
    );
    assert.match(shuffled.check("cycle[0].repayments").detail, /the chain has 1 Repaid event\(s\) in this cycle's window that the bundle does not list/);

    // Pointers and records that disagree with the chain.
    await failsAt(
      "t-observed-hash.json",
      tamper((b) => (b.observedAt.blockHash = keccak256(toBytes("another block")))),
      ["observedAt.blockHash"],
      /^block \d+ is 0x[0-9a-f]{64} on this chain, not the bundle's 0x[0-9a-f]{64}$/,
    );
    await failsAt(
      "t-exit-none.json",
      tamper((b) => (b.exit = { kind: "none", txHash: null, blockNumber: null, amount: null })),
      ["completeness.exit", "exit.state"],
      /^the bundle records no exit, but the chain has LineClosed@0x[0-9a-f]{64}$/,
    );
    await failsAt(
      "t-spend-executor.json",
      tamper((b) => (b.cycles[0].spend.executor = stranger.address)),
      ["cycle[0].spend.receipt"],
      new RegExp(`^transaction is sent by ${executor.address}, not the bundle's executor ${stranger.address}$`, "i"),
    );
    // The intent names another executor than the one that sent the spend.
    const executorSwap = await failsAt(
      "t-intent-executor.json",
      tamper((b) => {
        b.cycles[0].intent.typedData.message.executor = stranger.address;
        bare(b.cycles[0].intent);
      }),
      ["cycle[0].intent.digest", "cycle[0].spend.executor", "cycle[0].intent.signature"],
      /the intent's message recomputes to digest 0x[0-9a-f]{64} .*not the cycle's/,
    );
    assert.match(executorSwap.check("cycle[0].spend.executor").detail, new RegExp(`^the intent names executor ${stranger.address}, but ${executor.address} sent the spend$`, "i"));
    const otherReason = BLOCK_REASONS.find((name) => name !== "NONE" && name !== bundleA.refusals[0].reason);
    await failsAt(
      "t-refusal-reason.json",
      tamper((b) => (b.refusals[0].reason = otherReason)),
      ["refusal[0].event"],
      new RegExp(`^the recorded reason is ${bundleA.refusals[0].reason}, not the bundle's ${otherReason}$`),
    );
    const noSuchRepayment = keccak256(toBytes("no such repayment"));
    await failsAt(
      "t-repayment-tx.json",
      tamper((b) => (b.cycles[0].repayments[0].txHash = noSuchRepayment)),
      ["completeness.repaid", "cycle[0].repayments"],
      new RegExp(`in the bundle but not on chain: 100000 from ${agent.address}@${noSuchRepayment}$`),
    );

    // Provider receipts re-signed by the provider's own key with one field changed.
    const deployed = { chainId: CHAIN_ID, address: float };
    const resigned = async (file, kind, change) => {
      const signed = validateReceiptFile(file, deployed, kind);
      const message = { ...signed.message, ...change };
      return signReceipt(provider, { kind, chainId: CHAIN_ID, verifyingContract: float, message, requestId: signed.requestId, resultRef: signed.resultRef ?? undefined });
    };
    const [first, second] = bundleA.cycles;
    const otherEndpoint = keccak256(toBytes("https://provider.example/api/other"));
    const principalAcceptance = await resigned(first.provider.acceptance, ACCEPTANCE_KIND, { principal: PRINCIPAL + 1n });
    await failsAt(
      "t-acceptance-principal.json",
      tamper((b) => (b.cycles[0].provider.acceptance = principalAcceptance)),
      ["cycle[0].provider.acceptance", "cycle[0].provider.delivery"],
      /^its principal 250001 is not the paid 250000$/,
    );
    const endpointAcceptance = await resigned(first.provider.acceptance, ACCEPTANCE_KIND, { endpointHash: otherEndpoint });
    await failsAt(
      "t-acceptance-endpoint.json",
      tamper((b) => (b.cycles[0].provider.acceptance = endpointAcceptance)),
      ["cycle[0].provider.acceptance", "cycle[0].provider.delivery"],
      new RegExp(`^its endpointHash ${otherEndpoint} is not the intent's endpoint \\(${keccak256(toBytes(ENDPOINT))}\\)$`),
    );
    // Without the intent file, the endpoint is the one the provider's policy approved before the spend.
    const withoutIntent = (b) => {
      b.cycles[1].intent = null;
      b.exporterSummary.missingIntentFiles = "1";
    };
    const byPolicy = await verifiesOk("t-no-intent-endpoint-ok.json", tamper(withoutIntent));
    assert.equal(byPolicy.check("cycle[1].provider.acceptance").status, "PASS");
    assert.match(byPolicy.check("cycle[1].provider.acceptance").detail, /, at the endpoint provider 0x[0-9a-fA-F]{40}'s policy approved at block \d+; /);
    const policyEndpointAcceptance = await resigned(second.provider.acceptance, ACCEPTANCE_KIND, { endpointHash: otherEndpoint });
    await failsAt(
      "t-no-intent-endpoint.json",
      tamper((b) => {
        withoutIntent(b);
        b.cycles[1].provider.acceptance = policyEndpointAcceptance;
      }),
      ["cycle[1].provider.acceptance", "cycle[1].provider.delivery"],
      new RegExp(`^its endpointHash ${otherEndpoint} is not the endpoint provider ${provider.address}'s policy approved at block \\d+ \\(${keccak256(toBytes(ENDPOINT))}\\)$`),
    );
    const spentAt = (await client.getBlock({ blockNumber: BigInt(first.spend.blockNumber) })).timestamp;
    const lateAcceptance = await resigned(first.provider.acceptance, ACCEPTANCE_KIND, { acceptedAt: spentAt + 1n });
    await failsAt(
      "t-accepted-late.json",
      tamper((b) => (b.cycles[0].provider.acceptance = lateAcceptance)),
      ["cycle[0].provider.acceptance", "cycle[0].provider.delivery"],
      new RegExp(`^acceptedAt ${spentAt + 1n} is after the payment block's timestamp ${spentAt}$`),
    );
    const earlyDelivery = await resigned(first.provider.delivery, DELIVERY_KIND, { deliveredAt: spentAt - 1n });
    await failsAt(
      "t-delivered-early.json",
      tamper((b) => (b.cycles[0].provider.delivery = earlyDelivery)),
      ["cycle[0].provider.delivery"],
      new RegExp(`^deliveredAt ${spentAt - 1n} is before the payment block's timestamp ${spentAt}$`),
    );

    // A stripped intent signature counts as a missing intent file: the summary fails, not only a MANUAL check.
    const unsigned = await failsAt(
      "t-unsigned-intent.json",
      tamper((b) => {
        delete b.cycles[0].intent.signature;
        delete b.cycles[0].intent.signerKind;
      }),
      ["exporterSummary"],
      /^missingIntentFiles is 0; this verifier derives 1$/,
    );
    assert.deepEqual([unsigned.check("cycle[0].intent.signature").status, unsigned.check("cycle[0].intent.signature").detail], ["MANUAL", "the intent file carries no signature"]);

    // The shape is strict: no unknown key, and only the exporter's declaration label.
    for (const [name, edit, pattern] of [
      ["top", (b) => (b.verified = true), /^the bundle has unknown key verified; schema 1 allows kind, schema, /],
      ["cycle", (b) => (b.cycles[1].note = "x"), /^cycles\[1\] has unknown key note; /],
      ["refusal", (b) => (b.refusals[0].reasonName = "LINE_SPEND_CAP"), /^refusals\[0\] has unknown key reasonName; /],
      ["exit", (b) => (b.exit.recipient = sponsor.address), /^exit has unknown key recipient; /],
      ["summary", (b) => (b.exporterSummary.verified = "1"), /^exporterSummary has unknown key verified; /],
      ["declared", (b) => (b.declared.verifiedOnChain = "yes"), /^declared has unknown key verifiedOnChain; schema 1 allows label, independentControl, customerPurpose, assistance, commercial$/],
      // Cycles are numbered 1, 2, ... in bundle order, as the exporter writes them.
      ["index-changed", (b) => (b.cycles[1].index = 3), /^cycles\[1\]\.index is 3, not 2: cycles are numbered from 1 in bundle order$/],
      ["index-duplicated", (b) => (b.cycles[1].index = 1), /^cycles\[1\]\.index is 1, not 2: /],
      ["index-non-numeric", (b) => (b.cycles[0].index = "first"), /^cycles\[0\]\.index is "first", not 1: /],
      ["index-string", (b) => (b.cycles[2].index = "3"), /^cycles\[2\]\.index is "3", not 3: /],
    ]) {
      await failsAt(`t-unknown-${name}.json`, tamper(edit), ["bundle.shape"], pattern);
    }
    await failsAt(
      "t-label.json",
      tamper((b) => (b.declared.label = "verified by the exporter")),
      ["bundle.shape"],
      /^declared\.label is "verified by the exporter", not the exporter's fixed label "declared by the operator; not verifiable on-chain"$/,
    );

    await failsAt("t-kind.json", tamper((b) => (b.kind = "ShadowFloat.EvidenceBundle")), "bundle.shape", /kind is "ShadowFloat.EvidenceBundle"/);
  });

  test("an RPC that fails mid-run fails the checks that needed it, and passes none of them", async () => {
    // Relays every call to anvil except eth_getLogs, which it answers with an
    // error. It counts the calls of the line's scan (up to observedAt), not
    // those of the informational scan past it.
    let lineScanCalls = 0;
    const proxy = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const call = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      if (call.method === "eth_getLogs") {
        if (BigInt(call.params[0].fromBlock) <= BigInt(bundleA.observedAt.blockNumber)) lineScanCalls += 1;
        return response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "eth_getLogs is unavailable" } }));
      }
      const upstream = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
      response.end(await upstream.text());
    });
    await new Promise((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve));
    let down;
    try {
      down = await failsAt(
        "rpc-down.json",
        bundleA,
        [
          "completeness.providerPaid",
          "completeness.spendBlocked",
          "completeness.repaid",
          "completeness.exit",
          ...[0, 1, 2].flatMap((i) => [`cycle[${i}].repayments`, `cycle[${i}].cleared`]),
          "exit.state",
          "exporterSummary",
        ],
        /^scanning the line's events in blocks \d+-\d+ failed: .*; RPC said: eth_getLogs is unavailable$/s,
        { rpc: `http://127.0.0.1:${PROXY_PORT}` },
      );
    } finally {
      proxy.close();
    }
    for (const id of down.ids("FAIL")) assert.match(down.check(id).detail, /RPC said: eth_getLogs is unavailable$/, id);
    // The line's scan stops at its first failed call, with no other event's scan left running.
    assert.equal(lineScanCalls, 1);
    // The informational scan past observedAt reports its failure without failing anything.
    const { head, scannedTo, truncated, laterLineEvents } = down.report.afterObservedAt;
    assert.deepEqual([head, scannedTo, truncated, laterLineEvents], [null, null, null, null]);
    assert.match(down.report.afterObservedAt.error, /^scanning the blocks after observedAt \d+ failed: .*eth_getLogs is unavailable$/s);
  });

  test("a reorg of the observation block during the run fails observedAt.blockHash, and nothing else", async () => {
    // Relays every call to anvil. The first eth_getBlockByNumber for the
    // observation block passes through; every later one reports another hash
    // at that height, as if the block was reorganized after the first check.
    const observed = toHex(BigInt(bundleA.observedAt.blockNumber));
    let reads = 0;
    const proxy = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const call = JSON.parse(body);
      const answer = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
      if (call.method === "eth_getBlockByNumber" && call.params[0] === observed && reads++ > 0) {
        // The real hash with its last hex digit changed.
        const { hash } = answer.result;
        answer.result.hash = `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(answer));
    });
    await new Promise((resolve) => proxy.listen(REORG_PROXY_PORT, "127.0.0.1", resolve));
    try {
      await failsAt(
        "reorged.json",
        bundleA,
        ["observedAt.blockHash"],
        new RegExp(`^the observation block was reorganized during verification: block ${bundleA.observedAt.blockNumber} is now 0x[0-9a-f]{64}, not the bundle's ${bundleA.observedAt.blockHash}$`),
        { rpc: `http://127.0.0.1:${REORG_PROXY_PORT}` },
      );
    } finally {
      proxy.close();
    }
    // Read twice: by the check, and again once every other chain read is done.
    assert.equal(reads, 2);
  });

  test("a manifest file that changes while the verifier runs fails deployment.manifestProvenance", async () => {
    const changing = path("changing-manifest.json");
    copyFileSync(manifest, changing);
    // Relays every call to anvil; the first eth_getLogs, after the manifest checks, appends a newline to the manifest file.
    let changed = false;
    const proxy = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (!changed && JSON.parse(body).method === "eth_getLogs") {
        changed = true;
        writeFileSync(changing, `${readFileSync(changing, "utf8")}\n`);
      }
      const upstream = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
      response.setHeader("content-type", "application/json");
      response.end(await upstream.text());
    });
    await new Promise((resolve) => proxy.listen(CHANGE_PROXY_PORT, "127.0.0.1", resolve));
    try {
      await failsAt(
        "manifest-changed.json",
        bundleA,
        ["deployment.manifestProvenance"],
        /^manifest changed during verification: its bytes are not those read at the start$/,
        { release: changing, rpc: `http://127.0.0.1:${CHANGE_PROXY_PORT}` },
      );
    } finally {
      proxy.close();
    }
    assert.equal(changed, true);
  });

  test("declared fields are never scored, and a cycle without its intent file is MANUAL, not PASS", async () => {
    const declared = structuredClone(bundleA);
    declared.declared = { ...declared.declared, customerPurpose: "a recurring paid research job", independentControl: "claimed independent" };
    const { check } = await verifiesOk("d-declared.json", declared);
    assert.deepEqual(
      [check("declared.customerPurpose").status, check("declared.customerPurpose").value, check("declared.independentControl").value],
      ["DECLARED", "a recurring paid research job", "claimed independent"],
    );

    const withoutIntent = structuredClone(bundleA);
    withoutIntent.cycles[2].intent = null;
    withoutIntent.exporterSummary.missingIntentFiles = "1";
    const { report, check: checkOf } = await verifiesOk("d-no-intent.json", withoutIntent);
    assert.deepEqual([report.ok, report.qualifying], [true, false]);
    for (const name of ["intent.signature", "intent.digest", "intent.fields", "spend.executor", "state.termsHash"]) {
      assert.deepEqual([checkOf(`cycle[2].${name}`).status, checkOf(`cycle[2].${name}`).detail], ["MANUAL", "intent file not supplied"]);
    }
    assert.ok(report.scope.notChecked.includes("cycle[2].intent.signature: intent file not supplied"));
    assert.ok(!report.scope.verifiedAgainstBundleSignatures.includes("cycle[2].intent.signature"));
    // The event-derived checks still run for that cycle.
    for (const name of ["spend.receipt", "spend.providerPaid", "spend.usdcTransfer", "state.before", "repayments", "receiptStatus"]) {
      assert.equal(checkOf(`cycle[2].${name}`).status, "PASS", name);
    }
  });
});
