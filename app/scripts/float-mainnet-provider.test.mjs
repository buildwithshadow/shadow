import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  stringToBytes,
  toBytes,
  zeroHash,
} from "viem";
import { sign } from "viem/accounts";

import { connectCandidate, floatAbi } from "./float-mainnet-config.mjs";
import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { validateIntentFile } from "./float-mainnet-intent.mjs";
import { stableStringify } from "./float-mainnet-preflight.mjs";
import {
  ACCEPTANCE_KIND,
  DELIVERY_KIND,
  acceptIntent,
  checkPayment,
  deliverResult,
  requestIdHashOf,
  resultRefHashOf,
  signReceipt,
  validateReceiptFile,
} from "./float-mainnet-provider.mjs";

// The provider kit end to end: a stub provider HTTP server built on the kit's
// exported functions, and the participants' CLIs driving the purchase.

const PORT = 18586;
const PROVIDER_PORT = 18587;
const RPC = `http://127.0.0.1:${PORT}`;
const PROVIDER_URL = `http://127.0.0.1:${PROVIDER_PORT}`;
const ENDPOINT = "https://provider.example/api/answer";
const OTHER_ENDPOINT = "https://provider.example/api/other";
const ENDPOINT_HASH = keccak256(toBytes(ENDPOINT));
const PRINCIPAL = 250_000n;
const PRICE = PRINCIPAL;
const SIXTY_DAYS = "+5184000";
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };

// PilotSmartAccount.isValidSignature expects abi.encode(r, s, v), 96 bytes.
async function accountSignature(hash, privateKey) {
  const { r, s, v } = await sign({ hash, privateKey });
  return encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }], [r, s, Number(v)]);
}

// A stub provider built only on the kit: it stores each acceptance and each
// delivered result by digest, not by request id, so a retried or concurrent
// request gets the stored result and receipt back and never causes new work.
// `work` counts results produced.
function startStubProvider(connection, providerAccount) {
  const accepted = new Map();
  const served = new Map();
  const stats = { work: 0 };
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(stableStringify(body));
    };
    try {
      if (request.method === "GET" && request.url.startsWith("/status/")) {
        const digest = request.url.slice("/status/".length);
        const payment = await checkPayment(connection, digest);
        return reply(200, { ...payment, accepted: accepted.has(digest), delivered: served.has(digest) });
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (request.method === "POST" && request.url === "/accept") {
        const { digest } = validateIntentFile(input.intent, connection);
        // Registered before any await, so a concurrent request for the same
        // digest finds it: one acceptance per digest, whatever the request id.
        let entry = accepted.get(digest);
        if (!entry) {
          entry = {
            requestId: input.requestId,
            acceptance: acceptIntent(connection, {
              intent: input.intent,
              endpointHash: ENDPOINT_HASH,
              price: PRICE,
              requestId: input.requestId,
              account: providerAccount,
            }).then((result) => result.acceptance),
          };
          accepted.set(digest, entry);
        }
        if (entry.requestId !== input.requestId) return reply(409, { error: `digest ${digest} is already accepted for request ${entry.requestId}` });
        let acceptance;
        try {
          acceptance = await entry.acceptance;
        } catch (error) {
          // A refused intent is not accepted: a later request may try again.
          if (accepted.get(digest) === entry) accepted.delete(digest);
          throw error;
        }
        return reply(200, acceptance);
      }
      if (request.method === "POST" && request.url === "/serve") {
        const acceptance = await accepted.get(input.digest)?.acceptance;
        if (!acceptance) return reply(404, { error: `no accepted request for digest ${input.digest}` });
        // Registered before any await, the payment check included: a
        // concurrent request for the digest waits for this one.
        let pending = served.get(input.digest);
        if (!pending) {
          pending = (async () => {
            const payment = await checkPayment(connection, input.digest);
            if (!payment.paid) return [402, { error: "the digest is not paid", receiptStatus: payment.receiptStatus }];
            stats.work += 1;
            const result = `answer ${stats.work} for ${acceptance.requestId}`;
            const { delivery } = await deliverResult(connection, {
              acceptance,
              resultHash: keccak256(toBytes(result)),
              resultRef: `stub://results/${input.digest}`,
              account: providerAccount,
            });
            return [200, { result, delivery }];
          })();
          served.set(input.digest, pending);
        }
        let status;
        let outcome;
        try {
          [status, outcome] = await pending;
        } finally {
          // Only a delivered result is kept: after a 402 or an error, a later paid retry does the work.
          if (status !== 200 && served.get(input.digest) === pending) served.delete(input.digest);
        }
        // Simulates a response lost after the work was done and stored.
        if (request.headers["x-drop-response"] === "1") return request.socket.destroy();
        return reply(status, outcome);
      }
      reply(404, { error: "not found" });
    } catch (error) {
      reply(422, { error: error.message });
    }
  });
  return new Promise((resolve) => server.listen(PROVIDER_PORT, "127.0.0.1", () => resolve({ server, stats })));
}

async function callProvider(method, route, body, headers = {}) {
  const response = await fetch(`${PROVIDER_URL}${route}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("request ids and result locations are hashed as UTF-8 text, so a receipt whose plaintext id or location is rewritten, even to a hex-looking form, is rejected", async () => {
  // viem's toBytes decodes "0x61" to the byte 0x61, which is also "a" in UTF-8.
  assert.equal(keccak256(toBytes("0x61")), keccak256(toBytes("a")));
  assert.notEqual(requestIdHashOf("0x61"), requestIdHashOf("a"));
  assert.deepEqual([requestIdHashOf("0x61"), resultRefHashOf("0x61")], [keccak256(stringToBytes("0x61")), keccak256(stringToBytes("0x61"))]);
  assert.deepEqual([resultRefHashOf(undefined), resultRefHashOf(null)], [zeroHash, zeroHash]);

  // Account index 1 is not used; FLOAT only names the EIP-712 verifying contract.
  const provider = account(5);
  const FLOAT = account(20).address;
  const deployment = { chainId: CHAIN_ID, address: FLOAT };
  const digest = keccak256(stringToBytes("digest"));
  const signed = (kind, message, extra) => signReceipt(provider, { kind, chainId: CHAIN_ID, verifyingContract: FLOAT, message, ...extra });
  const validate = (file, kind) => validateReceiptFile(file, deployment, kind);

  const acceptance = await signed(
    ACCEPTANCE_KIND,
    { digest, provider: provider.address, endpointHash: keccak256(stringToBytes(ENDPOINT)), principal: PRINCIPAL, requestIdHash: requestIdHashOf("a"), acceptedAt: 1n },
    { requestId: "a" },
  );
  assert.equal(validate(acceptance, ACCEPTANCE_KIND).requestId, "a");
  assert.throws(() => validate({ ...acceptance, requestId: "0x61" }, ACCEPTANCE_KIND), /^Error: requestId "0x61" does not hash to the message's requestIdHash 0x[0-9a-f]{64}$/);

  const deliveryMessage = (resultRef) => ({
    digest,
    provider: provider.address,
    requestIdHash: requestIdHashOf("a"),
    resultHash: keccak256(stringToBytes("result")),
    resultRefHash: resultRefHashOf(resultRef),
    deliveredAt: 2n,
  });
  const delivery = await signed(DELIVERY_KIND, deliveryMessage("a"), { requestId: "a", resultRef: "a" });
  assert.deepEqual([validate(delivery, DELIVERY_KIND).resultRef, delivery.typedData.message.resultRefHash], ["a", keccak256(stringToBytes("a"))]);
  const { resultRef, ...withoutRef } = delivery;
  for (const [file, pattern] of [
    [{ ...delivery, requestId: "0x61" }, /^Error: requestId "0x61" does not hash to the message's requestIdHash/],
    [{ ...delivery, resultRef: "0x61" }, /^Error: resultRef "0x61" does not hash to the message's resultRefHash 0x[0-9a-f]{64}$/],
    [{ ...delivery, resultRef: "s3://bucket/elsewhere" }, /^Error: resultRef "s3:\/\/bucket\/elsewhere" does not hash to the message's resultRefHash/],
    [withoutRef, /^Error: the receipt has no resultRef, but the message's resultRefHash is 0x[0-9a-f]{64}, not zero$/],
    [{ ...delivery, resultRef: null }, /^Error: the receipt has no resultRef, but the message's resultRefHash is 0x[0-9a-f]{64}, not zero$/],
    [{ ...delivery, resultRef: 7 }, /^Error: resultRef must be a string, or absent or null when the delivery names no result location$/],
  ]) {
    assert.throws(() => validate(file, DELIVERY_KIND), pattern);
  }

  // A delivery that names no result location signs the zero hash, and cannot be given one afterwards.
  const bare = await signed(DELIVERY_KIND, deliveryMessage(undefined), { requestId: "a" });
  assert.deepEqual([Object.hasOwn(bare, "resultRef"), bare.typedData.message.resultRefHash], [false, zeroHash]);
  assert.equal(validate(bare, DELIVERY_KIND).resultRef, null);
  assert.equal(validate({ ...bare, resultRef: null }, DELIVERY_KIND).hash, validate(bare, DELIVERY_KIND).hash);
  assert.throws(() => validate({ ...bare, resultRef: "a" }, DELIVERY_KIND), /^Error: resultRef "a" does not hash to the message's resultRefHash 0x0{64}$/);
});

describe("provider verification kit", { skip: e2eSkip }, () => {
  // Account index 1 is not used.
  const [owner, sponsor, agent, executor, provider, stranger, accountSigner] = [0, 2, 3, 4, 5, 6, 7].map(account);
  const OWNER = { FLOAT_OWNER_PRIVATE_KEY: keyOf(0) };
  const SPONSOR = { FLOAT_SPONSOR_PRIVATE_KEY: keyOf(2) };
  const AGENT = { FLOAT_AGENT_PRIVATE_KEY: keyOf(3) };
  const EXECUTOR = { FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(4) };
  const PROVIDER = { FLOAT_PROVIDER_PRIVATE_KEY: keyOf(5) };
  const STRANGER = { FLOAT_PROVIDER_PRIVATE_KEY: keyOf(6) };
  const chain = defineChain({
    id: Number(CHAIN_ID),
    name: "anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC) });
  const walletOf = (signer) => createWalletClient({ account: signer, chain, transport: http(RPC) });
  const artifact = (path) => JSON.parse(readFileSync(new URL(`../../contracts/out/${path}`, import.meta.url), "utf8"));

  let anvil;
  let dir;
  let usdc;
  let float;
  let connection;
  let stub;
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
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  const writeJson = (file, value) => writeFileSync(file, stableStringify(value));
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

  // Builds and signs an intent through the agent's CLI; returns the signed file's path and digest.
  async function signedIntent(name, principal, extra = []) {
    const built = await ok("intent", [
      "build",
      "--agent", agent.address,
      "--sponsor", sponsor.address,
      "--provider", provider.address,
      "--endpoint", ENDPOINT,
      "--principal", principal.toString(),
      "--out", path(`${name}.json`),
      ...extra,
    ]);
    await ok("intent", ["sign", "--intent", path(`${name}.json`), "--out", path(`${name}-signed.json`), ...extra.filter((flag) => flag === "--allow-block")], AGENT);
    return { file: path(`${name}-signed.json`), unsigned: path(`${name}.json`), digest: built.digest };
  }

  const acceptArgs = (intent, requestId, extra = []) => ["accept", "--intent", intent, "--price", PRICE.toString(), "--request-id", requestId, ...extra];

  before(async () => {
    anvil = await startAnvil(PORT);
    dir = mkdtempSync(join(tmpdir(), "float-provider-"));
    usdc = await deploy("MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6]);
    float = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [usdc, CHAIN_ID, MAXIMA, INITIAL, 3_600n, 604_800n, 172_800n]);
    const { abi } = artifact("MockAsset.sol/MockAsset.json");
    for (const [holder, amount] of [[sponsor, 10_000_000n], [agent, 2_000_000n]]) {
      const hash = await walletOf(owner).writeContract({ address: usdc, abi, functionName: "mint", args: [holder.address, amount] });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    }
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
    seen.lineId = opened.lineId;
    connection = await connectCandidate({ rpcUrl: RPC, expectedChainId: CHAIN_ID, address: float, runtimeHash: null, deployBlock: 0n });
    stub = await startStubProvider(connection, provider);
  });

  after(() => {
    stub?.server.close();
    anvil?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("accept, pay, serve: a paid digest is served once, and every retry returns the stored result and receipt", async () => {
    const a = await signedIntent("a", PRINCIPAL);
    const b = await signedIntent("b", PRINCIPAL);
    assert.equal((await callProvider("POST", "/serve", { digest: a.digest })).status, 404);

    const accepted = await callProvider("POST", "/accept", { intent: readJson(a.file), requestId: "req-a" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const acceptance = accepted.json;
    assert.deepEqual(
      [acceptance.kind, acceptance.signer, acceptance.requestId, acceptance.typedData.domain.name, acceptance.typedData.primaryType],
      [ACCEPTANCE_KIND, provider.address, "req-a", "ShadowFloatMainnetProvider", "ServiceAcceptance"],
    );
    assert.deepEqual(acceptance.typedData.message, {
      digest: a.digest,
      provider: provider.address,
      endpointHash: ENDPOINT_HASH,
      principal: PRINCIPAL.toString(),
      requestIdHash: requestIdHashOf("req-a"),
      acceptedAt: acceptance.typedData.message.acceptedAt,
    });
    assert.ok(BigInt(acceptance.typedData.message.acceptedAt) <= (await client.getBlock()).timestamp);
    writeJson(path("acceptance-a.json"), acceptance);
    assert.deepEqual(await callProvider("POST", "/accept", { intent: readJson(a.file), requestId: "req-a" }), accepted);
    const rebound = await callProvider("POST", "/accept", { intent: readJson(a.file), requestId: "req-other" });
    assert.deepEqual([rebound.status, rebound.json.error], [409, `digest ${a.digest} is already accepted for request req-a`]);
    assert.equal((await callProvider("POST", "/accept", { intent: readJson(b.file), requestId: "req-b" })).status, 200);
    writeJson(path("acceptance-b.json"), (await callProvider("POST", "/accept", { intent: readJson(b.file), requestId: "req-b" })).json);

    // Before payment the provider refuses to serve.
    assert.deepEqual(await callProvider("POST", "/serve", { digest: a.digest }), {
      status: 402,
      json: { error: "the digest is not paid", receiptStatus: "none" },
    });
    assert.equal(stub.stats.work, 0);

    const providerBefore = await balance(provider.address);
    const paid = await ok("submit", ["submit", "--intent", a.file, "--execute"], EXECUTOR);
    assert.deepEqual([paid.status, paid.digest], ["paid", a.digest]);
    assert.equal((await balance(provider.address)) - providerBefore, PRINCIPAL);
    const spendBlock = await client.getBlock({ blockNumber: BigInt(paid.providerPaid.blockNumber) });
    assert.ok(BigInt(acceptance.typedData.message.acceptedAt) <= spendBlock.timestamp, "accepted before payment");

    // The first response is lost after the work was done; the retry recovers it.
    await assert.rejects(callProvider("POST", "/serve", { digest: a.digest }, { "x-drop-response": "1" }));
    assert.equal(stub.stats.work, 1);
    const served = await callProvider("POST", "/serve", { digest: a.digest });
    assert.equal(served.status, 200, JSON.stringify(served.json));
    const { result, delivery } = served.json;
    assert.equal(result, "answer 1 for req-a");
    assert.deepEqual(
      [delivery.kind, delivery.requestId, delivery.resultRef, delivery.typedData.message.digest, delivery.typedData.message.requestIdHash],
      [DELIVERY_KIND, "req-a", `stub://results/${a.digest}`, a.digest, acceptance.typedData.message.requestIdHash],
    );
    assert.equal(delivery.typedData.message.resultHash, keccak256(toBytes(result)));
    assert.ok(BigInt(delivery.typedData.message.deliveredAt) >= spendBlock.timestamp, "delivered after payment");
    writeJson(path("delivery-a.json"), delivery);

    for (const name of ["acceptance-a.json", "delivery-a.json"]) {
      const verified = await ok("provider", ["verify-receipt", "--file", path(name)]);
      assert.deepEqual([verified.signerKind, verified.signatureValid, verified.digest, verified.provider], ["eoa", true, a.digest, provider.address]);
    }
    const payment = await ok("provider", ["check-payment", "--intent", a.file, "--acceptance", path("acceptance-a.json")]);
    assert.deepEqual(
      [payment.paid, payment.receiptStatus, payment.providerPaid.transactionHash, payment.providerPaid.principal, payment.acceptance.requestId, payment.acceptance.signatureValid],
      [true, "paid", paid.txHash, PRINCIPAL.toString(), "req-a", true],
    );
    // A paid digest does not make a forged acceptance pass.
    const altered = { ...acceptance.typedData.message, acceptedAt: (BigInt(acceptance.typedData.message.acceptedAt) + 1n).toString() };
    writeJson(path("acceptance-altered.json"), { ...acceptance, typedData: { ...acceptance.typedData, message: altered } });
    const forged = await fails("provider", ["check-payment", "--intent", a.file, "--acceptance", path("acceptance-altered.json")], {}, /the acceptance is not signed by provider/);
    assert.deepEqual([forged.paid, forged.receiptStatus, forged.acceptance.signatureValid], [true, "paid", false]);

    // Retries: the identical stored result and receipt, no new work, no new payment.
    const sentBefore = await client.getTransactionCount({ address: executor.address });
    const providerPaid = await balance(provider.address);
    for (let retry = 0; retry < 2; retry++) assert.deepEqual(await callProvider("POST", "/serve", { digest: a.digest }), served);
    assert.equal(stub.stats.work, 1);
    assert.equal(await balance(provider.address), providerPaid);
    assert.equal(await client.getTransactionCount({ address: executor.address }), sentBefore);
    assert.equal(await readFloat("receiptStatus", [a.digest]), 2);
    const status = await callProvider("GET", `/status/${a.digest}`);
    assert.deepEqual([status.json.paid, status.json.accepted, status.json.delivered, status.json.providerPaid.transactionHash], [true, true, true, paid.txHash]);

    // An accepted digest that was never paid is not served.
    assert.deepEqual(await callProvider("POST", "/serve", { digest: b.digest }), {
      status: 402,
      json: { error: "the digest is not paid", receiptStatus: "none" },
    });
    await fails("provider", ["deliver", "--acceptance", path("acceptance-b.json"), "--result-hash", keccak256(toBytes("x"))], PROVIDER, /refusing to deliver: receiptStatus for digest 0x[0-9a-f]{64} is none .*nothing has been paid/);
    const unpaid = await ok("provider", ["check-payment", "--digest", b.digest]);
    assert.deepEqual([unpaid.paid, unpaid.receiptStatus, unpaid.providerPaid], [false, "none", null]);
    assert.equal(stub.stats.work, 1);
    seen.a = { ...a, paid, acceptance, delivery };
  });

  test("the CLI deliver signs a paid digest's receipt with the accepting provider's key only, bound to the accepted request", async () => {
    writeFileSync(path("result-a.bin"), "stored result bytes");
    const delivered = await ok(
      "provider",
      ["deliver", "--acceptance", path("acceptance-a.json"), "--result-file", path("result-a.bin"), "--result-ref", "s3://bucket/a", "--out", path("delivery-cli.json")],
      PROVIDER,
    );
    assert.deepEqual(
      [delivered.kind, delivered.requestId, delivered.resultRef, delivered.payment.paid, delivered.typedData.message.resultHash, delivered.typedData.message.resultRefHash],
      [DELIVERY_KIND, "req-a", "s3://bucket/a", true, keccak256(readFileSync(path("result-a.bin"))), keccak256(stringToBytes("s3://bucket/a"))],
    );
    assert.deepEqual(readJson(path("delivery-cli.json")).typedData, delivered.typedData);
    // Without --result-ref the receipt names no location and signs the zero hash; it verifies.
    await ok("provider", ["deliver", "--acceptance", path("acceptance-a.json"), "--result-file", path("result-a.bin"), "--out", path("delivery-no-ref.json")], PROVIDER);
    const bare = readJson(path("delivery-no-ref.json"));
    assert.deepEqual([Object.hasOwn(bare, "resultRef"), bare.typedData.message.resultRefHash], [false, zeroHash]);
    assert.equal((await ok("provider", ["verify-receipt", "--file", path("delivery-no-ref.json")])).signatureValid, true);
    await fails("provider", ["deliver", "--acceptance", path("acceptance-a.json"), "--result-hash", keccak256(toBytes("x"))], STRANGER, /the acceptance is provider .*'s, not /);
  });

  test("a blocked digest is refused at acceptance and at delivery", async () => {
    await ok("repay", ["--line-id", seen.lineId, "--full", "--execute"], AGENT);
    const status = await ok("line", ["status", "--line-id", seen.lineId, "--provider", provider.address]);
    const overCap = BigInt(status.providers[0].remaining.nextSpendMax) + 1n;
    const over = await signedIntent("over", overCap, ["--allow-block"]);

    const refused = await callProvider("POST", "/accept", { intent: readJson(over.file), requestId: "req-over" });
    assert.equal(refused.status, 422);
    assert.match(refused.json.error, /would record it as SpendBlocked\(.*\) and pay nothing/);
    await fails("provider", acceptArgs(over.file, "req-over", ["--endpoint", ENDPOINT]), PROVIDER, /would record it as SpendBlocked/);

    const blocked = await ok("submit", ["submit", "--intent", over.file, "--execute", "--allow-block"], EXECUTOR);
    assert.equal(blocked.status, "blocked");
    // An acceptance the provider signed anyway still cannot turn a blocked digest into a delivery.
    const { timestamp } = await client.getBlock();
    const acceptance = await signReceipt(provider, {
      kind: ACCEPTANCE_KIND,
      chainId: CHAIN_ID,
      verifyingContract: float,
      message: { digest: over.digest, provider: provider.address, endpointHash: ENDPOINT_HASH, principal: overCap, requestIdHash: requestIdHashOf("req-over"), acceptedAt: timestamp },
      requestId: "req-over",
    });
    writeJson(path("acceptance-over.json"), acceptance);
    await fails("provider", ["deliver", "--acceptance", path("acceptance-over.json"), "--result-hash", keccak256(toBytes("x"))], PROVIDER, /receiptStatus for digest 0x[0-9a-f]{64} is blocked .*recorded a refusal and paid nothing/);
    await assert.rejects(
      deliverResult(connection, { acceptance, resultHash: keccak256(toBytes("x")), account: provider }),
      /refusing to deliver: .* is blocked/,
    );
    const payment = await ok("provider", ["check-payment", "--digest", over.digest]);
    assert.deepEqual([payment.paid, payment.receiptStatus], [false, "blocked"]);
    const viaStub = await callProvider("GET", `/status/${over.digest}`);
    assert.deepEqual([viaStub.json.paid, viaStub.json.receiptStatus, viaStub.json.accepted], [false, "blocked", false]);
  });

  test("an intent for another provider or endpoint, below the price, or unsigned is refused at acceptance", async () => {
    const c = await signedIntent("c", PRINCIPAL);
    await fails("provider", acceptArgs(c.file, "req-c", ["--endpoint", ENDPOINT]), STRANGER, new RegExp(`the intent pays provider ${provider.address}, not ${stranger.address}`));
    await fails("provider", acceptArgs(c.file, "req-c", ["--endpoint", OTHER_ENDPOINT]), PROVIDER, /the intent's endpointHash 0x[0-9a-f]{64} is not this endpoint's/);
    await fails(
      "provider",
      ["accept", "--intent", c.file, "--endpoint", ENDPOINT, "--price", (PRINCIPAL + 1n).toString(), "--request-id", "req-c"],
      PROVIDER,
      new RegExp(`principal ${PRINCIPAL} is below the price ${PRINCIPAL + 1n}`),
    );
    await fails("provider", acceptArgs(c.unsigned, "req-c", ["--endpoint", ENDPOINT]), PROVIDER, /carries no signature/);
    await assert.rejects(
      acceptIntent(connection, { intent: readJson(c.file), endpointHash: ENDPOINT_HASH, price: PRICE, requestId: "req-c", account: stranger }),
      /the intent pays provider/,
    );
    // The same intent, endpoint and price are accepted: each refusal above came from its own check.
    const accepted = await ok("provider", acceptArgs(c.file, "req-c", ["--endpoint", ENDPOINT, "--out", path("acceptance-c.json")]), PROVIDER);
    assert.deepEqual([accepted.digest, accepted.predictedOutcome.outcome], [c.digest, "pay"]);
    assert.deepEqual(readJson(path("acceptance-c.json")).typedData.message.digest, c.digest);
    seen.c = c;
  });

  test("an ERC-1271 provider's receipt verifies through isValidSignature", async () => {
    const smartProvider = await deploy("ShadowFloatMainnetPilotLifecycle.t.sol/PilotSmartAccount.json", [accountSigner.address]);
    const signerOf = (privateKey) => ({ address: smartProvider, signTypedData: async (typed) => accountSignature(hashTypedData(typed), privateKey) });
    const { timestamp } = await client.getBlock();
    const receipt = (signer) =>
      signReceipt(signer, {
        kind: ACCEPTANCE_KIND,
        chainId: CHAIN_ID,
        verifyingContract: float,
        message: { digest: seen.c.digest, provider: smartProvider, endpointHash: ENDPOINT_HASH, principal: PRINCIPAL, requestIdHash: requestIdHashOf("req-1271"), acceptedAt: timestamp },
        requestId: "req-1271",
      });

    writeJson(path("smart.json"), await receipt(signerOf(keyOf(7))));
    const verified = await ok("provider", ["verify-receipt", "--file", path("smart.json")]);
    assert.deepEqual([verified.signerKind, verified.signatureValid, verified.provider], ["erc1271", true, smartProvider]);
    assert.match(verified.signatureDetail, /isValidSignature on 0x[0-9a-fA-F]{40} returned the ERC-1271 magic value/);

    writeJson(path("smart-forged.json"), await receipt(signerOf(keyOf(6))));
    const forged = await fails("provider", ["verify-receipt", "--file", path("smart-forged.json")], {}, /not signed by provider/);
    assert.match(forged.signatureDetail, /returned 0xffffffff.*not the magic value/);

    // A 65-byte ECDSA signature by the account's signer is not the account's signature.
    const ecdsa = await receipt({ address: smartProvider, signTypedData: async (typed) => sign({ hash: hashTypedData(typed), privateKey: keyOf(7), to: "hex" }) });
    writeJson(path("smart-ecdsa.json"), ecdsa);
    const rejected = await fails("provider", ["verify-receipt", "--file", path("smart-ecdsa.json")], {}, /not signed by provider/);
    assert.equal(rejected.signerKind, "erc1271");
  });

  test("a tampered or rebound receipt is rejected", async () => {
    const delivery = readJson(path("delivery-a.json"));
    const variants = {
      "altered-result.json": [
        { ...delivery, typedData: { ...delivery.typedData, message: { ...delivery.typedData.message, resultHash: keccak256(toBytes("other")) } } },
        /not signed by provider/,
      ],
      "other-request.json": [{ ...delivery, requestId: "req-z" }, /requestId "req-z" does not hash to the message's requestIdHash/],
      // The result location is signed: it cannot be redirected, or dropped.
      "other-ref.json": [{ ...delivery, resultRef: "stub://results/elsewhere" }, /^resultRef "stub:\/\/results\/elsewhere" does not hash to the message's resultRefHash 0x[0-9a-f]{64}$/],
      "dropped-ref.json": [{ ...delivery, resultRef: null }, /^the receipt has no resultRef, but the message's resultRefHash is 0x[0-9a-f]{64}, not zero$/],
      "other-float.json": [{ ...delivery, verifyingContract: usdc, typedData: { ...delivery.typedData, domain: { ...delivery.typedData.domain, verifyingContract: usdc } } }, /bound to contract/],
      "other-chain.json": [{ ...delivery, chainId: "1", typedData: { ...delivery.typedData, domain: { ...delivery.typedData.domain, chainId: "1" } } }, /bound to chain 1/],
      "wrong-kind.json": [{ ...delivery, kind: ACCEPTANCE_KIND }, /typedData.primaryType is "DeliveryReceipt", not "ServiceAcceptance"/],
      "other-signer.json": [{ ...delivery, signer: stranger.address }, /signer 0x[0-9a-fA-F]{40} is not the receipt's provider/],
    };
    for (const [name, [file, pattern]] of Object.entries(variants)) {
      writeJson(path(name), file);
      await fails("provider", ["verify-receipt", "--file", path(name)], {}, pattern);
    }
    assert.throws(() => validateReceiptFile(delivery, { chainId: CHAIN_ID, address: float }, ACCEPTANCE_KIND), /is a ShadowFloatMainnet.DeliveryReceipt, not a/);

    // An eth_signTypedData_v4 payload also lists the EIP712Domain type, which
    // the exporter accepts: accepted here when it is exactly the standard one.
    const EIP712Domain = [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ];
    const withDomain = (domainType) => ({ ...delivery, typedData: { ...delivery.typedData, types: { EIP712Domain: domainType, ...delivery.typedData.types } } });
    const deployment = { chainId: CHAIN_ID, address: float };
    assert.equal(validateReceiptFile(withDomain(EIP712Domain), deployment, DELIVERY_KIND).hash, validateReceiptFile(delivery, deployment, DELIVERY_KIND).hash);
    assert.throws(() => validateReceiptFile(withDomain(EIP712Domain.slice(0, 3)), deployment, DELIVERY_KIND), /typedData\.types is not the DeliveryReceipt type/);
  });

  test("concurrent first requests for one digest get one acceptance, one piece of work and one receipt", async () => {
    const d = await signedIntent("d", PRINCIPAL);
    const requests = 6;
    const accepts = await Promise.all(
      Array.from({ length: requests }, (_, k) => callProvider("POST", "/accept", { intent: readJson(d.file), requestId: `req-d-${k}` })),
    );
    const accepted = accepts.filter((reply) => reply.status === 200);
    assert.equal(accepted.length, 1, JSON.stringify(accepts, null, 2));
    const winner = accepted[0].json.requestId;
    for (const reply of accepts.filter((entry) => entry.status !== 200)) {
      assert.deepEqual(reply, { status: 409, json: { error: `digest ${d.digest} is already accepted for request ${winner}` } });
    }

    const paid = await ok("submit", ["submit", "--intent", d.file, "--execute"], EXECUTOR);
    assert.equal(paid.status, "paid");
    const workBefore = stub.stats.work;
    const serves = await Promise.all(Array.from({ length: requests }, () => callProvider("POST", "/serve", { digest: d.digest })));
    assert.equal(stub.stats.work - workBefore, 1, "one piece of work for one paid digest");
    assert.equal(serves[0].status, 200, JSON.stringify(serves[0]));
    for (const reply of serves) assert.deepEqual(reply, serves[0]);
    assert.deepEqual([serves[0].json.delivery.requestId, serves[0].json.delivery.typedData.message.digest], [winner, d.digest]);
  });

  test("deliver refuses an acceptance its payment's ProviderPaid contradicts, and says when it could not cross-check", async () => {
    const { timestamp } = await client.getBlock();
    const acceptanceOf = (signer, principal, requestId) =>
      signReceipt(signer, {
        kind: ACCEPTANCE_KIND,
        chainId: CHAIN_ID,
        verifyingContract: float,
        message: { digest: seen.a.digest, provider: signer.address, endpointHash: ENDPOINT_HASH, principal, requestIdHash: requestIdHashOf(requestId), acceptedAt: timestamp },
        requestId,
      });
    // Another key accepts a digest that paid the provider, then delivers it.
    await assert.rejects(
      deliverResult(connection, { acceptance: await acceptanceOf(stranger, PRINCIPAL, "req-x"), resultHash: keccak256(toBytes("x")), account: stranger }),
      new RegExp(
        `refusing to deliver: digest ${seen.a.digest} paid provider ${provider.address} principal ${PRINCIPAL} \\(ProviderPaid in ${seen.a.paid.txHash}\\), not this acceptance's provider ${stranger.address} principal ${PRINCIPAL}$`,
      ),
    );
    // The provider's own acceptance, for another principal than the one paid.
    writeJson(path("acceptance-a-principal.json"), await acceptanceOf(provider, PRINCIPAL - 1n, "req-a"));
    await fails(
      "provider",
      ["deliver", "--acceptance", path("acceptance-a-principal.json"), "--result-hash", keccak256(toBytes("x"))],
      PROVIDER,
      new RegExp(`^refusing to deliver: digest ${seen.a.digest} paid provider ${provider.address} principal ${PRINCIPAL} .*, not this acceptance's provider ${provider.address} principal ${PRINCIPAL - 1n}$`),
    );
    const checked = await ok("provider", ["deliver", "--acceptance", path("acceptance-a.json"), "--result-hash", keccak256(toBytes("x"))], PROVIDER);
    assert.equal(checked.crossCheck, `passed: ProviderPaid in ${seen.a.paid.txHash} pays this acceptance's provider and principal`);
    // A lookup that finds no ProviderPaid (it starts after the payment) cannot cross-check, and says so.
    const head = await client.getBlockNumber();
    const skipped = await ok(
      "provider",
      ["deliver", "--acceptance", path("acceptance-a.json"), "--result-hash", keccak256(toBytes("x")), "--from-block", head.toString()],
      PROVIDER,
    );
    assert.match(skipped.crossCheck, /^skipped: receiptStatus is paid \(authoritative\), but no ProviderPaid log for this digest is in blocks \d+-\d+; pass an earlier --from-block$/);
  });

  test("with --store the CLI accepts and delivers once per digest; without it the output says nothing was de-duplicated", async () => {
    await ok("repay", ["--line-id", seen.lineId, "--full", "--execute"], AGENT);
    const e = await signedIntent("e", PRINCIPAL);
    const store = path("store");
    const none = "none: pass --store, or de-duplicate by digest in your server";
    const accept = (requestId, extra = []) => acceptArgs(e.file, requestId, ["--endpoint", ENDPOINT, "--store", store, ...extra]);
    // A temporary file left by an interrupted write is never read as the stored receipt.
    mkdirSync(store);
    const leftover = `${e.digest}.acceptance.json.4242.00ff00ff00ff00ff.tmp`;
    writeFileSync(join(store, leftover), '{"kind":');
    const first = await ok("provider", accept("req-e", ["--out", path("acceptance-e.json")]), PROVIDER);
    const storedAcceptance = join(store, `${e.digest}.acceptance.json`);
    assert.equal(first.deduplication, `stored at ${storedAcceptance}`);
    assert.deepEqual(readJson(storedAcceptance), readJson(path("acceptance-e.json")));
    // The run's own temporary file is gone, and the leftover is untouched.
    assert.deepEqual(readdirSync(store).sort(), [`${e.digest}.acceptance.json`, leftover].sort());
    assert.equal(readFileSync(join(store, leftover), "utf8"), '{"kind":');
    // The same request id gets the stored acceptance back; another request id is refused.
    const again = await ok("provider", accept("req-e"), PROVIDER);
    assert.deepEqual([again.signature, again.typedData, again.predictedOutcome], [first.signature, first.typedData, null]);
    assert.equal(again.deduplication, `returned the acceptance stored at ${storedAcceptance} for this digest; nothing re-signed`);
    await fails(
      "provider",
      accept("req-e2"),
      PROVIDER,
      new RegExp(`^digest ${e.digest} is already accepted for request "req-e" \\(.+\\); refusing a second acceptance for request "req-e2"$`),
    );
    // A store shared with another provider key: that key, under the same
    // request id, is refused the provider's acceptance (acceptIntent would refuse
    // it too: the intent pays the provider, not that key).
    await fails("provider", accept("req-e"), STRANGER, new RegExp(`holds provider ${provider.address}'s acceptance, not ${stranger.address}'s; refusing to return it$`));
    // A stored file under another digest's name is refused, not returned.
    const misnamed = path("store-misnamed");
    mkdirSync(misnamed);
    copyFileSync(storedAcceptance, join(misnamed, `${seen.c.digest}.acceptance.json`));
    await fails(
      "provider",
      acceptArgs(seen.c.file, "req-e", ["--endpoint", ENDPOINT, "--store", misnamed]),
      PROVIDER,
      new RegExp(`holds the acceptance of digest ${e.digest}, not ${seen.c.digest}; refusing to return it$`),
    );
    // A stored acceptance that names the provider but that another key signed is refused, not returned.
    const forgedStore = path("store-forged");
    mkdirSync(forgedStore);
    const storedFile = validateReceiptFile(readJson(storedAcceptance), { chainId: CHAIN_ID, address: float }, ACCEPTANCE_KIND);
    const forged = await signReceipt(
      { address: provider.address, signTypedData: (typed) => stranger.signTypedData(typed) },
      { kind: ACCEPTANCE_KIND, chainId: CHAIN_ID, verifyingContract: float, message: storedFile.message, requestId: storedFile.requestId },
    );
    writeJson(join(forgedStore, `${e.digest}.acceptance.json`), forged);
    await fails(
      "provider",
      acceptArgs(e.file, "req-e", ["--endpoint", ENDPOINT, "--store", forgedStore]),
      PROVIDER,
      new RegExp(`^the acceptance stored at .+ has a signature that does not verify \\(signature recovers to ${stranger.address}, not ${provider.address}\\); refusing to return it$`),
    );
    // Without --store nothing is remembered, and the output says so.
    const unstored = await ok("provider", acceptArgs(e.file, "req-e3", ["--endpoint", ENDPOINT, "--out", path("acceptance-e3.json")]), PROVIDER);
    assert.equal(unstored.deduplication, none);

    assert.equal((await ok("submit", ["submit", "--intent", e.file, "--execute"], EXECUTOR)).status, "paid");
    const deliver = (acceptance, result, extra = ["--store", store]) => ["deliver", "--acceptance", path(acceptance), "--result-hash", keccak256(toBytes(result)), ...extra];
    const delivered = await ok("provider", deliver("acceptance-e.json", "answer e"), PROVIDER);
    const storedDelivery = join(store, `${e.digest}.delivery.json`);
    assert.deepEqual([delivered.deduplication, delivered.crossCheck.startsWith("passed: ")], [`stored at ${storedDelivery}`, true]);
    // A rerun, even with another result, returns the stored delivery and signs nothing.
    const rerun = await ok("provider", deliver("acceptance-e.json", "another answer"), PROVIDER);
    assert.deepEqual([rerun.signature, rerun.typedData, rerun.payment, rerun.crossCheck], [delivered.signature, delivered.typedData, null, null]);
    assert.equal(rerun.deduplication, `returned the delivery stored at ${storedDelivery} for this digest; nothing re-signed`);
    // Nor is another key handed the provider's stored delivery, which would skip deliverResult's provider check.
    await fails("provider", deliver("acceptance-e.json", "answer e"), STRANGER, new RegExp(`holds provider ${provider.address}'s delivery, not ${stranger.address}'s; refusing to return it$`));
    // A second acceptance of the same paid digest is not served through the store.
    await fails(
      "provider",
      deliver("acceptance-e3.json", "answer e3"),
      PROVIDER,
      new RegExp(`^digest ${e.digest} is already delivered for request "req-e" \\(.+\\); refusing a second delivery for request "req-e3"$`),
    );
    // Without --store deliver signs again, and says it did not de-duplicate.
    assert.equal((await ok("provider", deliver("acceptance-e.json", "answer e", []), PROVIDER)).deduplication, none);
  });
});
