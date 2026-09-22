import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  hashTypedData,
  http,
  keccak256,
  maxUint256,
  numberToHex,
  size,
  slice,
  toBytes,
  zeroAddress,
} from "viem";
import { sign } from "viem/accounts";

import { runCalls } from "./float-mainnet-cli.mjs";
import { SPEND_INTENT_TYPES, eip712Domain, floatAbi } from "./float-mainnet-config.mjs";
import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import {
  INTENT_KIND,
  SECP256K1_HALF_ORDER,
  chooseDueAt,
  eoaSignatureIssue,
  intentDigest,
  intentFile,
  messageFromStruct,
  structFromMessage,
  validateIntentFile,
} from "./float-mainnet-intent.mjs";

const ENDPOINT = "https://provider.example/api/answer";
const OTHER_ENDPOINT = "https://provider.example/api/unapproved";
const source = readFileSync(new URL("../../contracts/src/ShadowFloatMainnet.sol", import.meta.url), "utf8");

// Runtime-derived fixtures: no literal bytes32 values in this file. Account
// index 1 is not used.
const FLOAT = getContractAddress({ from: account(0).address, nonce: 1n });
const STRUCT = {
  agent: account(2).address,
  sponsor: account(6).address,
  lineId: keccak256(toBytes("line")),
  lineEpoch: 1n,
  termsHash: keccak256(toBytes("terms")),
  provider: account(4).address,
  endpointHash: keccak256(toBytes(ENDPOINT)),
  principal: 250_000n,
  maximumTotalDebt: 250_000n,
  dueAt: 1_800_000_000n,
  nonce: 7n,
  signatureExpiry: 1_790_000_000n,
  executor: zeroAddress,
};
const CONNECTED = { chainId: CHAIN_ID, address: FLOAT };

// PilotSmartAccount.isValidSignature expects abi.encode(r, s, v), 96 bytes.
async function accountSignature(digest, privateKey) {
  const { r, s, v } = await sign({ hash: digest, privateKey });
  return encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }], [r, s, Number(v)]);
}

function reparsed(value) {
  return JSON.parse(JSON.stringify(value));
}

test("a check on the final simulation stops the call before it is signed or printed", async () => {
  const signed = [];
  const connection = { address: "0x000000000000000000000000000000000000f10a", client: { simulateContract: async () => ({ result: [false, 5] }) } };
  const call = { address: connection.address, abi: floatAbi, functionName: "cancelNonce", args: ["0x" + "ab".repeat(32), 1n] };
  const wallet = { prepareTransactionRequest: async () => signed.push("prepare"), signTransaction: async () => signed.push("sign") };
  const refuse = (_, [paid]) => {
    if (!paid) throw new Error("would record SpendBlocked");
  };
  const execute = { mode: "execute", account: { address: connection.address }, wallet };
  await assert.rejects(runCalls(connection, execute, [call], { check: refuse }), (error) => {
    assert.match(error.message, /would record SpendBlocked/);
    assert.deepEqual(error.txHashes, []);
    return true;
  });
  assert.deepEqual(signed, [], "nothing was prepared or signed");
  await assert.rejects(runCalls(connection, { mode: "calldata", address: connection.address }, [call], { check: refuse }), /would record SpendBlocked/);
  const printed = await runCalls(connection, { mode: "calldata", address: connection.address }, [call], { check: () => {} });
  assert.equal(printed.calls.length, 1);
});

test("the low-s bound is the contract's SECP256K1_HALF_ORDER", () => {
  const literal = source.match(/SECP256K1_HALF_ORDER = (0x[0-9a-fA-F]+);/)[1];
  assert.equal(SECP256K1_HALF_ORDER, BigInt(literal));
});

test("intent files round-trip and carry an eth_signTypedData_v4 payload for external signers", () => {
  const file = intentFile({ chainId: CHAIN_ID, verifyingContract: FLOAT, struct: STRUCT });
  assert.equal(file.kind, INTENT_KIND);
  assert.equal(file.chainId, "5042002");
  assert.equal(file.verifyingContract, FLOAT);
  assert.equal(
    file.digest,
    hashTypedData({ domain: eip712Domain(CHAIN_ID, FLOAT), types: SPEND_INTENT_TYPES, primaryType: "SpendIntent", message: STRUCT }),
  );
  assert.deepEqual(validateIntentFile(reparsed(file), CONNECTED), { struct: STRUCT, digest: file.digest, signature: null });

  const external = JSON.parse(file.externalSignerTypedData);
  assert.deepEqual(external.types.EIP712Domain.map(({ name }) => name), ["name", "version", "chainId", "verifyingContract"]);
  assert.deepEqual(external.domain, { name: "ShadowFloatMainnet", version: "1", chainId: "5042002", verifyingContract: FLOAT });
  assert.equal(external.primaryType, "SpendIntent");
  assert.ok(Object.values(external.message).every((value) => typeof value === "string"));
  assert.equal(external.message.principal, "250000");
  const rehashed = hashTypedData({
    domain: { ...external.domain, chainId: BigInt(external.domain.chainId) },
    types: { SpendIntent: external.types.SpendIntent },
    primaryType: external.primaryType,
    message: structFromMessage(external.message),
  });
  assert.equal(rehashed, file.digest);
});

test("messages normalise to checksummed addresses, lowercase bytes32 and decimal strings", () => {
  const message = messageFromStruct({ ...STRUCT, agent: STRUCT.agent.toLowerCase(), lineId: STRUCT.lineId.toUpperCase().replace("0X", "0x") });
  assert.equal(message.agent, STRUCT.agent);
  assert.equal(message.lineId, STRUCT.lineId);
  assert.equal(message.nonce, "7");
  assert.deepEqual(structFromMessage(message), STRUCT);
});

test("wrong-generation, wrong-deployment and altered payloads are rejected", () => {
  const file = intentFile({ chainId: CHAIN_ID, verifyingContract: FLOAT, struct: STRUCT });
  const variant = (mutate) => {
    const copy = reparsed(file);
    mutate(copy);
    return copy;
  };
  const v2 = {
    kind: "ShadowFloat.FloatSpendIntent",
    typedData: {
      domain: { name: "ShadowFloat", version: "1", chainId: "5042002", verifyingContract: FLOAT },
      primaryType: "FloatSpendIntent",
      message: { agent: STRUCT.agent, amountUSDC: "250000" },
    },
  };
  assert.throws(() => validateIntentFile(v2, CONNECTED), /V2 FloatSpendIntent/);
  assert.throws(() => validateIntentFile(variant((f) => delete f.kind), CONNECTED), /kind null/);
  assert.throws(() => validateIntentFile(variant((f) => (f.typedData.domain.name = "ShadowFloat")), CONNECTED), /wrong-generation/);
  assert.throws(() => validateIntentFile(variant((f) => (f.typedData.domain.version = "2")), CONNECTED), /wrong-generation/);
  assert.throws(() => validateIntentFile(variant((f) => (f.typedData.primaryType = "FloatSpendIntent")), CONNECTED), /primaryType/);
  assert.throws(() => validateIntentFile(file, { ...CONNECTED, chainId: 5042n }), /chain 5042002; the connected candidate is on chain 5042/);
  const elsewhere = getContractAddress({ from: FLOAT, nonce: 1n });
  assert.throws(() => validateIntentFile(file, { ...CONNECTED, address: elsewhere }), /bound to contract/);
  assert.throws(() => validateIntentFile(variant((f) => (f.typedData.message.principal = "999")), CONNECTED), /file was altered/);
  assert.throws(
    () =>
      validateIntentFile(
        variant((f) => {
          f.typedData.message.principal = "999";
          delete f.digest;
        }),
        CONNECTED,
      ),
    /externalSignerTypedData does not match/,
  );
  assert.throws(
    () => validateIntentFile(variant((f) => f.typedData.types.SpendIntent.push({ name: "reason", type: "string" })), CONNECTED),
    /not the candidate SpendIntent type/,
  );
  const bare = (mutate) =>
    variant((f) => {
      delete f.digest;
      delete f.externalSignerTypedData;
      mutate(f);
    });
  assert.throws(() => validateIntentFile(bare((f) => (f.typedData.message.reason = "x")), CONNECTED), /unexpected fields: reason/);
  assert.throws(() => validateIntentFile(bare((f) => (f.typedData.message.principal = 250000)), CONNECTED), /decimal integer string/);
  assert.throws(() => validateIntentFile(bare((f) => (f.typedData.message.lineEpoch = (2n ** 64n).toString())), CONNECTED), /exceeds uint64/);
  assert.throws(() => validateIntentFile(variant((f) => (f.signature = "0x123")), CONNECTED), /hex bytes/);
  // Addresses are strict: lowercase or a valid checksum. Flipping the case of
  // one letter of a checksummed address breaks its checksum.
  const letter = STRUCT.agent.search(/[a-fA-F]/);
  const flipped = STRUCT.agent.slice(0, letter) + (STRUCT.agent[letter] === STRUCT.agent[letter].toUpperCase() ? STRUCT.agent[letter].toLowerCase() : STRUCT.agent[letter].toUpperCase()) + STRUCT.agent.slice(letter + 1);
  assert.throws(() => validateIntentFile(bare((f) => (f.typedData.message.agent = flipped)), CONNECTED), /checksummed/);
  assert.deepEqual(validateIntentFile(bare((f) => (f.typedData.message.agent = STRUCT.agent.toLowerCase())), CONNECTED).struct, STRUCT);
  assert.throws(() => validateIntentFile(variant((f) => (f.verifyingContract = f.verifyingContract.toUpperCase().replace("0X", "0x"))), CONNECTED), /bound to contract/);
});

test("dueAt keeps the intent executable for its whole signature validity; the default is the latest such dueAt", () => {
  const base = {
    now: 1_000_000n,
    dueIn: null,
    signatureExpiry: 1_000_900n,
    lineExpiry: 10_000_000n,
    lineMaximumRepaymentWindow: 604_800n,
    minimumRepaymentWindow: 3_600n,
  };
  assert.equal(chooseDueAt(base), 1_000_000n + 604_800n);
  assert.equal(chooseDueAt({ ...base, lineExpiry: 1_010_000n }), 1_010_000n);
  // The window is [signatureExpiry + minimumRepaymentWindow, min(now + line window, line expiry)].
  assert.equal(chooseDueAt({ ...base, lineExpiry: 1_004_500n }), 1_004_500n);
  assert.throws(() => chooseDueAt({ ...base, lineExpiry: 1_004_499n }), /empty window \[1004500, 1004499\].*shorten --signature-ttl/);
  assert.equal(chooseDueAt({ ...base, lineMaximumRepaymentWindow: 4_500n }), 1_004_500n);
  assert.throws(() => chooseDueAt({ ...base, lineMaximumRepaymentWindow: 4_499n }), /empty window.*widen the line's repayment window/);
  assert.equal(chooseDueAt({ ...base, dueIn: 4_500n }), 1_004_500n);
  assert.throws(() => chooseDueAt({ ...base, dueIn: 4_499n }), /--due-in 4499 gives dueAt 1004499, outside the window \[1004500, 1604800\]/);
  assert.equal(chooseDueAt({ ...base, dueIn: 604_800n }), 1_604_800n);
  assert.throws(() => chooseDueAt({ ...base, dueIn: 604_801n }), /outside the window/);
  assert.throws(() => chooseDueAt({ ...base, lineExpiry: 1_005_000n, dueIn: 5_001n }), /outside the window/);

  // executeSpend's own rule at every execution time T in [now, signatureExpiry].
  const inputs = [base, { ...base, lineExpiry: 1_004_500n }, { ...base, lineMaximumRepaymentWindow: 4_500n }, { ...base, dueIn: 4_500n }];
  for (const input of inputs) {
    const dueAt = chooseDueAt(input);
    for (let T = input.now; T <= input.signatureExpiry; T += 100n) {
      assert.ok(dueAt >= T + input.minimumRepaymentWindow, `${dueAt} at ${T}`);
      assert.ok(dueAt <= T + input.lineMaximumRepaymentWindow && dueAt <= input.lineExpiry, `${dueAt} at ${T}`);
    }
  }
});

test("EOA signatures must be 65-byte, v 27/28, low-s, as the contract requires", async () => {
  const digest = keccak256(toBytes("digest"));
  const signature = await account(2).sign({ hash: digest });
  assert.equal(eoaSignatureIssue(signature), null);
  assert.match(eoaSignatureIssue(await accountSignature(digest, keyOf(5))), /96 bytes.*deploy it before submitting/);
  assert.match(eoaSignatureIssue(concat([slice(signature, 0, 64), "0x00"])), /v is 0/);
  const order = SECP256K1_HALF_ORDER * 2n + 1n;
  const highS = numberToHex(order - BigInt(slice(signature, 32, 64)), { size: 32 });
  const flippedV = slice(signature, 64, 65) === "0x1b" ? "0x1c" : "0x1b";
  const malleable = concat([slice(signature, 0, 32), highS, flippedV]);
  assert.equal(size(malleable), 65);
  assert.match(eoaSignatureIssue(malleable), /low-s/);
});

test("the local digest helper hashes exactly the candidate EIP-712 domain", () => {
  assert.equal(
    intentDigest(CHAIN_ID, FLOAT, STRUCT),
    intentFile({ chainId: CHAIN_ID, verifyingContract: FLOAT, struct: STRUCT }).digest,
  );
  assert.notEqual(intentDigest(5042n, FLOAT, STRUCT), intentDigest(CHAIN_ID, FLOAT, STRUCT));
});

// ---------------------------------------------------------------------------
// End to end: a participant drives the CLIs against a fresh local candidate.

const PORT = 18561;
const PROXY_PORT = 18564;
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };
const PRINCIPAL = 250_000n;
const DAY = 86_400n;

describe("participant lifecycle on a local candidate", { skip: e2eSkip }, () => {
  const [owner, agent, executor, provider, accountSigner, sponsor] = [0, 2, 3, 4, 5, 6].map(account);
  const AGENT_KEY = keyOf(2);
  const EXECUTOR_KEY = keyOf(3);
  const SIGNER_KEY = keyOf(5);
  const RPC = `http://127.0.0.1:${PORT}`;
  const chain = defineChain({
    id: Number(CHAIN_ID),
    name: "anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC) });
  const walletOf = (signer) => createWalletClient({ account: signer, chain, transport: http(RPC) });
  const artifact = (path) => JSON.parse(readFileSync(new URL(`../../contracts/out/${path}`, import.meta.url), "utf8"));
  const usdcAbi = artifact("MockAsset.sol/MockAsset.json").abi;

  let anvil;
  let dir;
  let usdc;
  let float;
  let otherFloat;
  let lineId;

  async function deploy(signer, path, args) {
    const { abi, bytecode } = artifact(path);
    const hash = await walletOf(signer).deployContract({ abi, bytecode: bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", path);
    return getAddress(receipt.contractAddress);
  }

  async function write(signer, address, abi, functionName, args) {
    const hash = await walletOf(signer).writeContract({ address, abi, functionName, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", functionName);
    return receipt;
  }

  const readFloat = (functionName, args = []) => client.readContract({ address: float, abi: floatAbi, functionName, args });
  const providerBalance = () => client.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [provider.address] });

  // "Nothing was sent": the sender's nonce and the chain height are unchanged.
  // cacheTime 0: viem otherwise serves a block number up to 4 s old.
  async function sentNothing(address, run) {
    const [count, height] = await Promise.all([client.getTransactionCount({ address }), client.getBlockNumber({ cacheTime: 0 })]);
    const result = await run();
    assert.equal(await client.getTransactionCount({ address }), count, `${address} sent a transaction`);
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), height, "a block was mined");
    return result;
  }

  async function deployFloat() {
    return deploy(owner, "ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [usdc, CHAIN_ID, MAXIMA, INITIAL, 3_600n, 604_800n, 172_800n]);
  }

  async function openLine(agentAddress) {
    const { timestamp } = await client.getBlock();
    await write(sponsor, float, floatAbi, "openLine", [
      {
        agent: agentAddress,
        reserve: 1_000_000n,
        lineSpendCap: 3_000_000n,
        dailySpendCap: 1_000_000n,
        lineExpiry: timestamp + 60n * DAY,
        maximumRepaymentWindow: 604_800n,
        provider: provider.address,
        endpointHash: keccak256(toBytes(ENDPOINT)),
        providerPerSpendCap: 1_000_000n,
        providerDailyCap: 1_000_000n,
        providerExpiry: timestamp + 60n * DAY,
      },
    ]);
    return readFloat("activeLineId", [sponsor.address, agentAddress]);
  }

  // Given the RPC, the candidate address and only the one key its role needs.
  const cli = (tool, args, env = {}) =>
    runTool(tool, args, { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(), FLOAT_MAINNET_ADDRESS: float, ...env });

  function ok(result) {
    assert.equal(result.status, 0, JSON.stringify(result.json, null, 2));
    assert.equal(result.json.ok, true);
    return result.json;
  }

  function fails(result, pattern, status = 1) {
    assert.equal(result.status, status, JSON.stringify(result.json, null, 2));
    assert.equal(result.json.ok, false);
    assert.match(result.json.error.message, pattern);
    return result.json;
  }

  const path = (name) => join(dir, name);
  const buildArgs = (agentAddress, out, extra = []) => [
    "build",
    "--agent",
    agentAddress,
    "--sponsor",
    sponsor.address,
    "--provider",
    provider.address,
    "--principal",
    PRINCIPAL.toString(),
    "--out",
    out,
    ...(extra.includes("--endpoint-hash") || extra.includes("--endpoint") ? [] : ["--endpoint", ENDPOINT]),
    ...extra,
  ];
  const agentEnv = { FLOAT_AGENT_PRIVATE_KEY: AGENT_KEY };
  const executorEnv = { FLOAT_EXECUTOR_PRIVATE_KEY: EXECUTOR_KEY };
  const readIntent = (file) => JSON.parse(readFileSync(file, "utf8"));
  const structOf = (file) => structFromMessage(readIntent(file).typedData.message);

  before(async () => {
    anvil = await startAnvil(PORT);
    dir = mkdtempSync(join(tmpdir(), "float-agent-tools-"));

    usdc = await deploy(owner, "MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6]);
    float = await deployFloat();
    otherFloat = await deployFloat();
    await write(owner, usdc, usdcAbi, "mint", [sponsor.address, 10_000_000n]);
    await write(owner, usdc, usdcAbi, "mint", [agent.address, 1_000_000n]);
    await write(owner, float, floatAbi, "setSponsorAllowed", [sponsor.address, true]);
    await write(sponsor, usdc, usdcAbi, "approve", [float, maxUint256]);
    lineId = await openLine(agent.address);
  });

  after(() => {
    anvil?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("build, sign and verify an EOA agent's intent", async () => {
    const built = ok(await cli("intent", buildArgs(agent.address, path("i1.json"))));
    assert.equal(built.kind, INTENT_KIND);
    assert.equal(built.out, path("i1.json"));
    assert.ok(Object.values(built.checks).every((entry) => entry.ok));
    assert.deepEqual([built.predictedOutcome.outcome, built.predictedOutcome.reason], ["pay", "NONE"]);
    const struct = structOf(path("i1.json"));
    assert.equal(struct.lineId, lineId);
    assert.equal(struct.termsHash, await readFloat("currentTermsHash", [lineId, provider.address]));
    assert.equal(built.digest, await readFloat("hashSpendIntent", [struct]));
    // Default signature validity 900 s from the build block; default dueAt is the
    // line window from that block (the 60-day expiry does not bind).
    const builtAt = struct.signatureExpiry - 900n;
    assert.equal(BigInt(built.predictedOutcome.observedAt.timestamp) >= builtAt, true);
    assert.equal(struct.dueAt, builtAt + 604_800n);
    assert.ok(struct.dueAt >= struct.signatureExpiry + 3_600n);
    assert.equal(JSON.parse(built.externalSignerTypedData).types.EIP712Domain.length, 4);
    assert.equal(readIntent(path("i1.json")).digest, built.digest);

    fails(await cli("intent", buildArgs(agent.address, path("x.json"), ["--due-in", "+4500"])), /--due-in must be a number of seconds/, 2);
    fails(await cli("intent", buildArgs(agent.address, path("x.json"), ["--due-in", "4499"])), /outside the window/);
    ok(await cli("intent", buildArgs(agent.address, path("x.json"), ["--due-in", "4500"])));
    fails(
      await cli("intent", buildArgs(agent.address, path("x.json"), ["--signature-ttl", "601201"])),
      /empty window.*shorten --signature-ttl/,
    );
    ok(await cli("intent", buildArgs(agent.address, path("x.json"), ["--signature-ttl", "601200"])));

    fails(await cli("intent", ["sign", "--intent", path("i1.json"), "--out", path("x.json")], executorEnv), /FLOAT_AGENT_PRIVATE_KEY is required/);
    fails(
      await cli("intent", ["sign", "--intent", path("i1.json"), "--out", path("x.json")], { FLOAT_AGENT_PRIVATE_KEY: EXECUTOR_KEY }),
      /not the intent's agent/,
    );
    const signed = ok(await cli("intent", ["sign", "--intent", path("i1.json"), "--out", path("s1.json")], agentEnv));
    assert.equal(signed.signerKind, "eoa");
    assert.equal(size(signed.signature), 65);
    assert.equal(signed.digest, built.digest);
    assert.equal(signed.predictedOutcome.outcome, "pay");

    const verified = ok(await cli("intent", ["verify", "--intent", path("s1.json")]));
    assert.deepEqual(
      [verified.signerKind, verified.signatureValid, verified.fresh, verified.digest, verified.predictedOutcome.outcome],
      ["eoa", true, true, built.digest, "pay"],
    );

    // A second intent, signed while the line is still OPEN.
    ok(await cli("intent", buildArgs(agent.address, path("i2.json"))));
    ok(await cli("intent", ["sign", "--intent", path("i2.json"), "--out", path("s2.json")], agentEnv));
    assert.notEqual(structOf(path("s2.json")).nonce, struct.nonce);
  });

  test("malformed EOA recovery remains a structured invalid signature in verify and submit", async () => {
    for (const [index, r] of [0n, SECP256K1_HALF_ORDER * 2n + 1n].entries()) {
      const signature = `0x${r.toString(16).padStart(64, "0")}${"1".padStart(64, "0")}1b`;
      const verified = fails(await cli("intent", ["verify", "--intent", path("s1.json"), "--signature", signature]), /invalid signature: no key recovers/);
      assert.deepEqual([verified.signerKind, verified.signatureValid, verified.fresh, verified.predictedOutcome], ["eoa", false, true, null]);
      const malformed = path(`bad-r-${index}.json`);
      writeFileSync(malformed, JSON.stringify({ ...readIntent(path("s1.json")), signature }));
      const rejected = await sentNothing(executor.address, async () =>
        fails(await cli("submit", ["submit", "--intent", malformed, "--execute"], executorEnv), /InvalidSignature.*no key recovers/),
      );
      assert.equal(rejected.error.revert, "InvalidSignature");
      assert.equal(await readFloat("nonceUsed", [lineId, structOf(malformed).nonce]), false);
    }
  });

  test("preflight predicts the payment and submit pays exactly once", async () => {
    const predicted = ok(await cli("submit", ["preflight", "--intent", path("s1.json")], executorEnv));
    assert.deepEqual([predicted.outcome, predicted.reason, predicted.receiptStatus, predicted.from], ["pay", "NONE", "none", executor.address]);

    const balanceBefore = await providerBalance();
    const dry = await sentNothing(executor.address, async () => ok(await cli("submit", ["submit", "--intent", path("s1.json")], executorEnv)));
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.simulation, { outcome: "pay", reason: "NONE" });
    const head = await client.getBlock();
    assert.deepEqual(dry.simulatedAt, { blockNumber: head.number.toString(), timestamp: head.timestamp.toString() });
    assert.deepEqual([dry.calls[0].to, dry.calls[0].functionName], [float, "executeSpend"]);
    assert.equal(await providerBalance(), balanceBefore);

    const paid = ok(await cli("submit", ["submit", "--intent", path("s1.json"), "--execute"], executorEnv));
    assert.deepEqual([paid.dryRun, paid.status, paid.reason], [false, "paid", "NONE"]);
    assert.deepEqual(paid.txHashes, [paid.txHash]);
    assert.equal(paid.providerPaid.principal, PRINCIPAL.toString());
    assert.equal(paid.providerPaid.provider, provider.address);
    assert.ok(paid.events.some((entry) => entry.event === "ProviderPaid" && entry.args.digest === paid.digest));
    assert.equal(await providerBalance(), balanceBefore + PRINCIPAL);
    assert.equal(await readFloat("receiptStatus", [paid.digest]), 2);

    const again = await sentNothing(executor.address, async () =>
      ok(await cli("submit", ["submit", "--intent", path("s1.json"), "--execute"], executorEnv)),
    );
    assert.equal(again.status, "already-paid");
    assert.deepEqual([again.event.event, again.event.transactionHash, again.event.args.digest], ["ProviderPaid", paid.txHash, paid.digest]);
    assert.deepEqual(again.txHashes, []);
    assert.equal(again.hint, undefined);
    assert.equal(await providerBalance(), balanceBefore + PRINCIPAL);
    const recorded = ok(await cli("submit", ["preflight", "--intent", path("s1.json")], executorEnv));
    assert.deepEqual([recorded.outcome, recorded.reason, recorded.event.transactionHash], ["already-paid", "NONE", paid.txHash]);
  });

  test("a DRAWN line refuses new intents and an earlier-signed intent reverts without consuming its nonce", async () => {
    fails(await cli("intent", buildArgs(agent.address, path("x.json"))), /outstanding debt .*; repay in full first/);
    fails(await cli("intent", buildArgs(agent.address, path("x.json"), ["--allow-block"])), /outstanding debt .*; repay in full first/);
    const second = structOf(path("s2.json"));
    const predicted = ok(await cli("submit", ["preflight", "--intent", path("s2.json"), "--from", executor.address]));
    assert.deepEqual([predicted.outcome, predicted.error, predicted.nonceUsed], ["revert", "InvalidState", false]);
    assert.equal(await readFloat("nonceUsed", [lineId, second.nonce]), false);
    fails(await cli("intent", ["sign", "--intent", path("i2.json"), "--out", path("x.json")], agentEnv), /lineState: DRAWN/);
  });

  test("after full repayment, an intent for a non-approved endpoint needs --allow-block at every step and is recorded as ENDPOINT_NOT_ALLOWED", async () => {
    await write(agent, usdc, usdcAbi, "approve", [float, PRINCIPAL]);
    await write(agent, float, floatAbi, "repay", [lineId, PRINCIPAL]);
    assert.equal((await readFloat("getLine", [lineId])).state, 1);

    const other = ["--endpoint", OTHER_ENDPOINT];
    fails(
      await cli("intent", buildArgs(agent.address, path("x.json"), other)),
      /refusing to build .*SpendBlocked\(ENDPOINT_NOT_ALLOWED\).*is not the endpoint approved.*pass --allow-block/,
    );
    const built = ok(await cli("intent", buildArgs(agent.address, path("b3.json"), [...other, "--allow-block"])));
    assert.deepEqual([built.predictedOutcome.outcome, built.predictedOutcome.reason], ["block", "ENDPOINT_NOT_ALLOWED"]);
    fails(await cli("intent", ["sign", "--intent", path("b3.json"), "--out", path("x.json")], agentEnv), /refusing to sign .*SpendBlocked\(ENDPOINT_NOT_ALLOWED\)/);
    ok(await cli("intent", ["sign", "--intent", path("b3.json"), "--out", path("c3.json"), "--allow-block"], agentEnv));

    const verified = ok(await cli("intent", ["verify", "--intent", path("c3.json")]));
    assert.deepEqual([verified.fresh, verified.signatureValid], [true, true]);
    assert.deepEqual([verified.predictedOutcome.outcome, verified.predictedOutcome.reason], ["block", "ENDPOINT_NOT_ALLOWED"]);
    const predicted = ok(await cli("submit", ["preflight", "--intent", path("c3.json")], executorEnv));
    assert.deepEqual([predicted.outcome, predicted.reason], ["block", "ENDPOINT_NOT_ALLOWED"]);
    const dry = ok(await cli("submit", ["submit", "--intent", path("c3.json")], executorEnv));
    assert.deepEqual(dry.simulation, { outcome: "block", reason: "ENDPOINT_NOT_ALLOWED" });

    const crafted = structOf(path("c3.json"));
    const balanceBefore = await providerBalance();
    const refused = await sentNothing(executor.address, async () =>
      fails(
        await cli("submit", ["submit", "--intent", path("c3.json"), "--execute"], executorEnv),
        /would record SpendBlocked\(ENDPOINT_NOT_ALLOWED\).*nothing was sent. Pass --allow-block/,
      ),
    );
    assert.deepEqual([refused.status, refused.reason], ["block", "ENDPOINT_NOT_ALLOWED"]);
    assert.equal(await readFloat("nonceUsed", [lineId, crafted.nonce]), false);

    const blocked = ok(await cli("submit", ["submit", "--intent", path("c3.json"), "--execute", "--allow-block"], executorEnv));
    assert.deepEqual([blocked.status, blocked.reason], ["blocked", "ENDPOINT_NOT_ALLOWED"]);
    assert.ok(blocked.events.some((entry) => entry.event === "SpendBlocked" && entry.args.digest === blocked.digest));
    assert.equal(await readFloat("receiptStatus", [blocked.digest]), 1);
    assert.equal(await readFloat("nonceUsed", [lineId, crafted.nonce]), true);
    assert.equal(await providerBalance(), balanceBefore);
    assert.equal((await readFloat("getLine", [lineId])).state, 1);

    const again = await sentNothing(executor.address, async () =>
      ok(await cli("submit", ["submit", "--intent", path("c3.json"), "--execute", "--allow-block"], executorEnv)),
    );
    assert.deepEqual(
      [again.status, again.reason, again.event.event, again.event.transactionHash, again.event.args.reasonName],
      ["already-blocked", "ENDPOINT_NOT_ALLOWED", "SpendBlocked", blocked.txHash, "ENDPOINT_NOT_ALLOWED"],
    );
    const recorded = ok(await cli("submit", ["preflight", "--intent", path("c3.json")], executorEnv));
    assert.deepEqual([recorded.outcome, recorded.reason, recorded.event.transactionHash], ["already-blocked", "ENDPOINT_NOT_ALLOWED", blocked.txHash]);
  });

  test("cancel-nonce voids an outstanding signed intent, with a key or as calldata for a keyless agent", async () => {
    const leftover = structOf(path("s2.json"));
    assert.equal(ok(await cli("intent", ["verify", "--intent", path("s2.json")])).fresh, true);
    const cancelArgs = ["--line-id", lineId, "--nonce", leftover.nonce.toString()];

    fails(await cli("cancel-nonce", cancelArgs, { FLOAT_AGENT_PRIVATE_KEY: EXECUTOR_KEY }), /only the line's agent/);
    const dry = await sentNothing(agent.address, async () => ok(await cli("cancel-nonce", cancelArgs, agentEnv)));
    assert.deepEqual([dry.dryRun, dry.calls[0].functionName, dry.calls[0].to], [true, "cancelNonce", float]);
    assert.deepEqual(dry.simulation.map((entry) => entry.status), ["ok"]);
    assert.equal(await readFloat("nonceCancelled", [lineId, leftover.nonce]), false);

    const unsigned = await sentNothing(agent.address, async () => ok(await cli("cancel-nonce", [...cancelArgs, "--calldata", "--from", agent.address])));
    assert.deepEqual([unsigned.calls.length, unsigned.calls[0].to, unsigned.calls[0].value], [1, float, "0"]);
    const decoded = decodeFunctionData({ abi: floatAbi, data: unsigned.calls[0].data });
    assert.deepEqual([decoded.functionName, decoded.args], ["cancelNonce", [lineId, leftover.nonce]]);
    fails(await cli("cancel-nonce", [...cancelArgs, "--calldata", "--from", executor.address]), /--from is .*only the line's agent/);

    const cancelled = ok(await cli("cancel-nonce", [...cancelArgs, "--execute"], agentEnv));
    assert.equal(cancelled.nonceCancelled, true);
    assert.deepEqual(cancelled.events.map((entry) => entry.event), ["NonceCancelled"]);
    assert.equal(await readFloat("nonceCancelled", [lineId, leftover.nonce]), true);

    const verified = await cli("intent", ["verify", "--intent", path("s2.json")]);
    fails(verified, /nonce: nonce cancelled by the agent/);
    assert.deepEqual([verified.json.fresh, verified.json.signatureValid, verified.json.checks.nonce.ok, verified.json.predictedOutcome], [false, true, false, null]);
    fails(await cli("cancel-nonce", cancelArgs, agentEnv), /already cancelled/);
    const predicted = ok(await cli("submit", ["preflight", "--intent", path("s2.json")], executorEnv));
    assert.deepEqual([predicted.outcome, predicted.error], ["revert", "NonceUnavailable"]);
  });

  test("a sponsor terms change makes a signed intent stale", async () => {
    ok(await cli("intent", buildArgs(agent.address, path("i5.json"))));
    ok(await cli("intent", ["sign", "--intent", path("i5.json"), "--out", path("s5.json")], agentEnv));
    const line = await readFloat("getLine", [lineId]);
    await write(sponsor, float, floatAbi, "updateLineTerms", [lineId, line.lineSpendCap, line.dailySpendCap, line.expiry, line.maximumRepaymentWindow]);

    const verified = await cli("intent", ["verify", "--intent", path("s5.json")]);
    fails(verified, /termsHash: currentTermsHash is/);
    assert.deepEqual([verified.json.fresh, verified.json.checks.termsHash.ok, verified.json.signatureValid], [false, false, true]);
    fails(await cli("intent", ["sign", "--intent", path("i5.json"), "--out", path("x.json")], agentEnv), /refusing to sign a stale/);

    const predicted = ok(await cli("submit", ["preflight", "--intent", path("s5.json")], executorEnv));
    assert.deepEqual([predicted.outcome, predicted.error], ["revert", "StaleTerms"]);
    const balanceBefore = await providerBalance();
    const rejected = await sentNothing(executor.address, async () =>
      fails(await cli("submit", ["submit", "--intent", path("s5.json"), "--execute"], executorEnv), /would revert with StaleTerms; nothing was sent/),
    );
    assert.deepEqual([rejected.error.revert, rejected.status], ["StaleTerms", "revert"]);
    assert.equal(await providerBalance(), balanceBefore);
    assert.equal(await readFloat("nonceUsed", [lineId, structOf(path("s5.json")).nonce]), false);
  });

  test("wrong-generation and wrong-deployment payloads are rejected by every command", async () => {
    const signed = readIntent(path("s1.json"));
    writeFileSync(
      path("v2.json"),
      JSON.stringify({
        kind: "ShadowFloat.FloatSpendIntent",
        typedData: {
          domain: { name: "ShadowFloat", version: "1", chainId: "5042002", verifyingContract: float },
          primaryType: "FloatSpendIntent",
          message: signed.typedData.message,
        },
        signature: signed.signature,
      }),
    );
    fails(await cli("intent", ["verify", "--intent", path("v2.json")]), /V2 FloatSpendIntent/);
    fails(await cli("submit", ["submit", "--intent", path("v2.json"), "--execute"], executorEnv), /V2 FloatSpendIntent/);
    fails(await cli("intent", ["sign", "--intent", path("v2.json")], agentEnv), /V2 FloatSpendIntent/);

    writeFileSync(path("renamed.json"), JSON.stringify({ ...signed, typedData: { ...signed.typedData, domain: { ...signed.typedData.domain, name: "ShadowFloat" } } }));
    fails(await cli("submit", ["preflight", "--intent", path("renamed.json")], executorEnv), /wrong-generation/);

    fails(await cli("intent", ["verify", "--intent", path("s1.json")], { FLOAT_MAINNET_ADDRESS: otherFloat }), /bound to contract/);
    fails(await cli("submit", ["submit", "--intent", path("s1.json"), "--execute"], { ...executorEnv, FLOAT_MAINNET_ADDRESS: otherFloat }), /bound to contract/);
    fails(await cli("intent", ["verify", "--intent", path("s1.json")], { FLOAT_MAINNET_ADDRESS: usdc }), /not a ShadowFloatMainnet candidate/);
    fails(await cli("intent", ["verify", "--intent", path("s1.json")], { FLOAT_MAINNET_EXPECTED_CHAIN_ID: "5042" }), /not 5042/);
  });

  test("an ERC-1271 smart-account agent: external signature verified, attached and paid", async () => {
    const smartAccount = await deploy(owner, "ShadowFloatMainnetPilotLifecycle.t.sol/PilotSmartAccount.json", [accountSigner.address]);
    const accountLine = await openLine(smartAccount);
    const built = ok(await cli("intent", buildArgs(smartAccount, path("a.json"))));
    assert.equal(structOf(path("a.json")).lineId, accountLine);
    fails(
      await cli("intent", ["sign", "--intent", path("a.json")], { FLOAT_AGENT_PRIVATE_KEY: SIGNER_KEY }),
      /not the intent's agent/,
    );

    const forged = await cli("intent", ["verify", "--intent", path("a.json"), "--signature", await accountSignature(built.digest, AGENT_KEY)]);
    fails(forged, /invalid signature/);
    assert.deepEqual([forged.json.signerKind, forged.json.signatureValid, forged.json.predictedOutcome], ["erc1271", false, null]);

    const signature = await accountSignature(built.digest, SIGNER_KEY);
    const verified = ok(await cli("intent", ["verify", "--intent", path("a.json"), "--signature", signature, "--out", path("as.json")]));
    assert.deepEqual([verified.signerKind, verified.signatureValid, verified.fresh, verified.out], ["erc1271", true, true, path("as.json")]);
    assert.deepEqual([readIntent(path("as.json")).signature, readIntent(path("as.json")).signerKind], [signature, "erc1271"]);

    assert.equal(ok(await cli("submit", ["preflight", "--intent", path("as.json")], executorEnv)).outcome, "pay");
    const balanceBefore = await providerBalance();
    const paid = ok(await cli("submit", ["submit", "--intent", path("as.json"), "--execute"], executorEnv));
    assert.equal(paid.status, "paid");
    assert.equal(paid.providerPaid.lineId, accountLine);
    assert.equal(await providerBalance(), balanceBefore + PRINCIPAL);
  });

  test("an undeployed smart-account address gets deploy-before-submitting guidance", async () => {
    const counterfactual = getContractAddress({ from: owner.address, nonce: 1_000_000n });
    assert.equal(await client.getCode({ address: counterfactual }), undefined);
    const undeployedLine = await openLine(counterfactual);
    const built = ok(await cli("intent", buildArgs(counterfactual, path("u.json"))));
    const signature = await accountSignature(built.digest, SIGNER_KEY);

    const verified = await cli("intent", ["verify", "--intent", path("u.json"), "--signature", signature, "--out", path("x.json")]);
    fails(verified, /deploy it before submitting/);
    assert.deepEqual([verified.json.signerKind, verified.json.signatureValid, verified.json.fresh], ["eoa", false, true]);

    writeFileSync(path("us.json"), JSON.stringify({ ...readIntent(path("u.json")), signature }));
    const rejected = await sentNothing(executor.address, async () =>
      fails(await cli("submit", ["submit", "--intent", path("us.json"), "--execute"], executorEnv), /InvalidSignature.*deploy it before submitting/),
    );
    assert.equal(rejected.error.revert, "InvalidSignature");
    assert.equal(await readFloat("nonceUsed", [undeployedLine, structOf(path("u.json")).nonce]), false);
  });

  test("an executor-bound intent: other submitters are refused, and an interrupted send is reported, never resent", async () => {
    ok(await cli("intent", buildArgs(agent.address, path("e.json"), ["--executor", executor.address])));
    ok(await cli("intent", ["sign", "--intent", path("e.json")], agentEnv));
    assert.equal(readIntent(path("e.json")).typedData.message.executor, executor.address);

    fails(await cli("submit", ["preflight", "--intent", path("e.json"), "--from", agent.address]), /only it can submit/, 2);
    const predicted = ok(await cli("submit", ["preflight", "--intent", path("e.json")]));
    assert.deepEqual([predicted.from, predicted.outcome], [executor.address, "pay"]);
    fails(await cli("submit", ["submit", "--intent", path("e.json"), "--execute"], { FLOAT_EXECUTOR_PRIVATE_KEY: AGENT_KEY }), /names executor/);
    fails(await cli("submit", ["submit", "--intent", path("e.json"), "--calldata", "--from", agent.address]), /names executor .*; --from is/);

    // An RPC that relays eth_sendRawTransaction to the node but answers the
    // client with an error: the payment lands, the submitter cannot tell.
    const proxy = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const upstream = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await upstream.text();
      const call = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      response.end(
        call.method === "eth_sendRawTransaction"
          ? JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "upstream timed out" } })
          : text,
      );
    });
    await new Promise((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve));
    const balanceBefore = await providerBalance();
    const sentBefore = await client.getTransactionCount({ address: executor.address });
    let interrupted;
    try {
      interrupted = fails(
        await cli("submit", ["submit", "--intent", path("e.json"), "--execute"], { ...executorEnv, ARC_RPC_URL: `http://127.0.0.1:${PROXY_PORT}` }),
        /is unknown [(].*; RPC said: upstream timed out[)]; receiptStatus is now "paid". Nothing is resent automatically. Check 0x[0-9a-f]+ [(]or run float-mainnet-line.mjs receipt --digest 0x[0-9a-f]+[)] before re-running submit. A second payment is impossible: .*duplicate executeSpend revert/s,
      );
    } finally {
      proxy.close();
    }
    assert.deepEqual([interrupted.status, interrupted.receiptStatus], ["unknown", "paid"]);
    assert.deepEqual(interrupted.txHashes, [interrupted.txHash]);
    assert.ok(interrupted.error.message.includes(`Check ${interrupted.txHash}`));
    assert.ok(interrupted.error.message.includes(`receipt --digest ${interrupted.digest}`));
    assert.equal(await client.getTransactionCount({ address: executor.address }), sentBefore + 1);
    assert.equal(await providerBalance(), balanceBefore + PRINCIPAL);
    assert.equal((await client.getTransactionReceipt({ hash: interrupted.txHash })).status, "success");

    const rerun = await sentNothing(executor.address, async () => ok(await cli("submit", ["submit", "--intent", path("e.json"), "--execute"], executorEnv)));
    assert.deepEqual([rerun.status, rerun.event.transactionHash], ["already-paid", interrupted.txHash]);
    assert.equal(await providerBalance(), balanceBefore + PRINCIPAL);
  });

  // Repays the line in full and returns a fresh signed intent on it.
  async function reopenAndSign(name) {
    const { principalOutstanding } = await readFloat("getLine", [lineId]);
    await write(agent, usdc, usdcAbi, "approve", [float, principalOutstanding]);
    await write(agent, float, floatAbi, "repay", [lineId, principalOutstanding]);
    ok(await cli("intent", buildArgs(agent.address, path(`${name}.json`))));
    ok(await cli("intent", ["sign", "--intent", path(`${name}.json`)], agentEnv));
    return readIntent(path(`${name}.json`));
  }

  // An RPC proxy on `port` that answers `handle(call, relay)`; relay() forwards
  // the call to anvil and returns its JSON-RPC response text.
  async function rpcProxy(port, handle) {
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const relay = async () => (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body })).text();
      const answer = await handle(JSON.parse(body), relay, response);
      if (answer !== undefined) {
        response.setHeader("content-type", "application/json");
        response.end(answer);
      }
    });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  test("a send that reverts because another executor recorded the digest first reports the recorded receiptStatus", async () => {
    const signed = await reopenAndSign("race");
    const struct = structFromMessage(signed.typedData.message);
    // Relays everything, but lets another executor's executeSpend of the same
    // intent land first, so the submitter's own transaction reverts onchain.
    const racing = await rpcProxy(18571, async (call, relay) => {
      if (call.method === "eth_sendRawTransaction") await write(owner, float, floatAbi, "executeSpend", [struct, signed.signature]);
      return relay();
    });
    const balanceBefore = await providerBalance();
    const sentBefore = await client.getTransactionCount({ address: executor.address });
    let raced;
    try {
      raced = fails(await cli("submit", ["submit", "--intent", path("race.json"), "--execute"], { ...executorEnv, ARC_RPC_URL: racing.url }), /recorded no outcome/);
    } finally {
      racing.close();
    }
    assert.equal(raced.error.message, `transaction ${raced.txHash} recorded no outcome; receiptStatus is paid`);
    assert.deepEqual([raced.status, raced.receiptStatus, raced.txHashes, raced.error.revert], ["reverted", "paid", [raced.txHash], null]);
    assert.equal((await client.getTransactionReceipt({ hash: raced.txHash })).status, "reverted");
    assert.equal(await client.getTransactionCount({ address: executor.address }), sentBefore + 1);
    assert.equal(await providerBalance(), balanceBefore + PRINCIPAL);

    const recorded = await sentNothing(executor.address, async () => ok(await cli("submit", ["submit", "--intent", path("race.json"), "--execute"], executorEnv)));
    assert.equal(recorded.status, "already-paid");
    assert.notEqual(recorded.event.transactionHash, raced.txHash);
  });

  test("an unknown send whose receiptStatus cannot be read either still reports the hash and the guidance", async () => {
    const signed = await reopenAndSign("dark");
    // Relays the send but answers it with an error, then drops every later
    // connection: the RPC went down with the payment in flight.
    let down = false;
    const dark = await rpcProxy(18572, async (call, relay, response) => {
      if (down) return void response.socket.destroy();
      if (call.method !== "eth_sendRawTransaction") return relay();
      await relay();
      down = true;
      return JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "upstream timed out" } });
    });
    const balanceBefore = await providerBalance();
    let lost;
    try {
      lost = fails(
        await cli("submit", ["submit", "--intent", path("dark.json"), "--execute"], { ...executorEnv, ARC_RPC_URL: dark.url }),
        /is unknown [(].*; RPC said: upstream timed out[)]; receiptStatus is now "unreadable" [(]reading it failed: .+[)]. Nothing is resent automatically. Check 0x[0-9a-f]+ [(]or run float-mainnet-line.mjs receipt --digest 0x[0-9a-f]+[)] before re-running submit. A second payment is impossible/s,
      );
    } finally {
      dark.close();
    }
    assert.deepEqual([lost.status, lost.receiptStatus, lost.digest, lost.txHashes], ["unknown", "unreadable", signed.digest, [lost.txHash]]);
    assert.ok(lost.error.message.includes(`Check ${lost.txHash}`));
    assert.ok(lost.error.message.includes(`receipt --digest ${signed.digest}`));
    // The reported hash is the payment that landed.
    assert.equal((await client.getTransactionReceipt({ hash: lost.txHash })).status, "success");
    assert.equal(await providerBalance(), balanceBefore + PRINCIPAL);
    const rerun = await sentNothing(executor.address, async () => ok(await cli("submit", ["submit", "--intent", path("dark.json"), "--execute"], executorEnv)));
    assert.deepEqual([rerun.status, rerun.event.transactionHash], ["already-paid", lost.txHash]);
  });

  // Last: it moves the chain's clock past the policy expiry.
  test("build and sign refuse an intent whose signature outlives its provider policy, unless --allow-block", async () => {
    const late = account(7);
    const lateKey = { FLOAT_AGENT_PRIVATE_KEY: keyOf(7) };
    const lateLine = await openLine(late.address);
    await write(sponsor, float, floatAbi, "setProviderPolicy", [
      lateLine,
      provider.address,
      keccak256(toBytes(ENDPOINT)),
      1_000_000n,
      1_000_000n,
      (await client.getBlock()).timestamp + 4_500n,
      true,
    ]);
    const policyExpiry = (await readFloat("providerPolicies", [lateLine, provider.address]))[1];

    const refused = fails(
      await cli("intent", buildArgs(late.address, path("x.json"), ["--signature-ttl", "5000"])),
      /^refusing to build an intent whose signature expires at (\d+), after provider 0x[0-9a-fA-F]{40}'s policy expiry (\d+): executed after \2 the contract would record it as SpendBlocked\(PROVIDER_NOT_ALLOWED\), using up its nonce and paying nothing; shorten --signature-ttl, or ask the sponsor to extend the policy \(set-provider-policy --expiry\), or pass --allow-block to accept that$/,
    );
    const [, signatureExpiry, stated] = /expires at (\d+), after provider .*'s policy expiry (\d+)/.exec(refused.error.message);
    assert.equal(BigInt(stated), policyExpiry);
    assert.ok(BigInt(signatureExpiry) > policyExpiry);

    // The default 900 s validity fits inside the policy.
    const fits = ok(await cli("intent", buildArgs(late.address, path("p1.json"))));
    assert.equal(fits.predictedOutcome.outcome, "pay");
    assert.ok(structOf(path("p1.json")).signatureExpiry <= policyExpiry);
    ok(await cli("intent", ["sign", "--intent", path("p1.json")], lateKey));

    // Accepted deliberately, it still predicts pay at the latest block, and sign applies the same rule.
    const accepted = ok(await cli("intent", buildArgs(late.address, path("p2.json"), ["--signature-ttl", "5000", "--allow-block"])));
    assert.equal(accepted.predictedOutcome.outcome, "pay");
    assert.ok(structOf(path("p2.json")).signatureExpiry > policyExpiry);
    fails(
      await cli("intent", ["sign", "--intent", path("p2.json"), "--out", path("x.json")], lateKey),
      /^refusing to sign an intent whose signature expires at .*SpendBlocked\(PROVIDER_NOT_ALLOWED\).*; rebuild it with a shorter --signature-ttl, or ask the sponsor to extend the policy \(set-provider-policy --expiry\) and rebuild, or pass --allow-block to accept that$/,
    );
    ok(await cli("intent", ["sign", "--intent", path("p2.json"), "--allow-block"], lateKey));

    // Why: once the policy has expired, that signed intent is still valid, and
    // executing it records SpendBlocked(PROVIDER_NOT_ALLOWED) instead of paying.
    await client.request({ method: "evm_setNextBlockTimestamp", params: [numberToHex(policyExpiry + 1n)] });
    await client.request({ method: "evm_mine", params: [] });
    const expired = ok(await cli("submit", ["preflight", "--intent", path("p2.json")], executorEnv));
    assert.deepEqual([expired.outcome, expired.reason], ["block", "PROVIDER_NOT_ALLOWED"]);
  });
});
