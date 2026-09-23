import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import {
  CallExecutionError,
  HttpRequestError,
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
} from "viem";
import { sign } from "viem/accounts";

import { createProviderServer } from "../../examples/float-mainnet-provider-server/server.mjs";
import exampleService from "../../examples/float-mainnet-provider-server/service.mjs";
import { connectCandidate, floatAbi } from "./float-mainnet-config.mjs";
import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { stableStringify } from "./float-mainnet-preflight.mjs";
import {
  ACCEPTANCE_KIND,
  DELIVERY_KIND,
  checkPayment,
  requestIdHashOf,
  resultRefHashOf,
  signReceipt,
  signatureAt,
  validateReceiptFile,
} from "./float-mainnet-provider.mjs";

// The agent-side request client against the reference provider server: the
// participants' CLIs drive every step, and a proxy between the client and the
// server loses, rewrites or forges the server's answers.

const PORT = 18640;
const SERVER_PORT = 18641;
const PROXY_PORT = 18642;
const CHILD_PORT = 18643;
const RESTART_PORT = 18644;
const OTHER_PORT = 18645;
const SMART_PORT = 18646;
const RPC = `http://127.0.0.1:${PORT}`;
const url = (port) => `http://127.0.0.1:${port}`;
const PROXY_URL = url(PROXY_PORT);
const CHILD_URL = url(CHILD_PORT);
const SERVER_SCRIPT = fileURLToPath(new URL("../../examples/float-mainnet-provider-server/server.mjs", import.meta.url));
const ENDPOINT = "https://provider.example/api/answer";
const ENDPOINT_HASH = keccak256(stringToBytes(ENDPOINT));
const OTHER_HASH = keccak256(stringToBytes("https://provider.example/api/other"));
const PRINCIPAL = 200_000n;
const PRICE = PRINCIPAL;
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
const SIXTY_DAYS = "+5184000";
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function stop(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function send(port, method, route, body) {
  // These direct probes cross server restarts. A fresh socket avoids reusing
  // an idle fetch connection that belonged to the server we just stopped.
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url(port)}${route}`, {
      method,
      agent: false,
      headers: { "content-type": "application/json" },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const post = (port, route, body) => send(port, "POST", route, body);

// Resolves once `server` has received `count` requests in full, one macrotask
// later: by then each of them has reached the server's in-flight map, since
// nothing between a request's last byte and that map waits on I/O.
function arrivals(server, count) {
  return new Promise((resolve) => {
    let ended = 0;
    const onRequest = (request) =>
      request.once("end", () => {
        ended += 1;
        if (ended < count) return;
        server.off("request", onRequest);
        setImmediate(resolve);
      });
    server.on("request", onRequest);
  });
}

// PilotSmartAccount.isValidSignature expects abi.encode(r, s, v), 96 bytes.
async function accountSignature(hash, privateKey) {
  const { r, s, v } = await sign({ hash, privateKey });
  return encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }], [r, s, Number(v)]);
}

describe("request client against the reference provider server", { skip: e2eSkip }, () => {
  // Account index 1 is not used.
  const [owner, sponsor, agent, executor, provider, stranger] = [0, 2, 3, 4, 5, 6].map(account);
  const OWNER = { FLOAT_OWNER_PRIVATE_KEY: keyOf(0) };
  const SPONSOR = { FLOAT_SPONSOR_PRIVATE_KEY: keyOf(2) };
  const AGENT = { FLOAT_AGENT_PRIVATE_KEY: keyOf(3) };
  const EXECUTOR = { FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(4) };
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
  let store;
  let usdc;
  let float;
  let connection;
  let proxyServer;
  // The in-process provider server now behind the proxy, with its counters.
  let current;
  const seen = {};
  // Between the client and the in-process server: a log of the requests it
  // relayed, and ways to lose or rewrite the server's answer.
  const proxy = { upstream: url(SERVER_PORT), log: [], dropNextServe: false, dropped: null, rewrite: null, statusFailure: null, redirectAccept: null };

  async function deploy(path, args) {
    const { abi, bytecode } = artifact(path);
    const hash = await walletOf(owner).deployContract({ abi, bytecode: bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", path);
    return getAddress(receipt.contractAddress);
  }

  // A reference server in this process with the example service. Its signer,
  // its service and its chain client are wrapped to count signatures, service
  // runs and chain calls: failNextSign and failNextCall make the next one fail,
  // and hold, when set, is a promise the signer and the service wait for.
  async function startProviderServer(port, { key = provider, endpointHash = ENDPOINT_HASH, price = PRICE, storeDir = store } = {}) {
    const stats = { signed: 0, work: [], calls: [], failNextSign: false, failNextCall: null, failSignatureRpc: null, hold: null };
    const signer = {
      address: key.address,
      signTypedData: async (typed) => {
        await stats.hold;
        if (stats.failNextSign) {
          stats.failNextSign = false;
          throw new Error("the signer is unavailable");
        }
        stats.signed += 1;
        return key.signTypedData(typed);
      },
    };
    const service = async (input) => {
      await stats.hold;
      stats.work.push(input.digest);
      return exampleService(input);
    };
    const counted = new Proxy(connection.client, {
      get(target, name) {
        const value = Reflect.get(target, name);
        if (typeof value !== "function") return value;
        return (...args) => {
          stats.calls.push(name);
          const signatureFailure = stats.failSignatureRpc;
          if (signatureFailure?.method === name && (args[0]?.address ?? args[0]?.to) === signatureFailure.address) {
            stats.failSignatureRpc = null;
            throw signatureFailure.error;
          }
          const failure = stats.failNextCall;
          if (failure) {
            stats.failNextCall = null;
            throw failure;
          }
          return value.apply(target, args);
        };
      },
    });
    const server = createProviderServer({ connection: { ...connection, client: counted }, account: signer, endpointHash, price, storeDir, service });
    await listen(server, port);
    return { server, stats, port };
  }

  function startProxy() {
    const server = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        proxy.log.push(`${request.method} ${request.url}`);
        if (request.url === "/accept" && proxy.redirectAccept) {
          response.writeHead(proxy.redirectAccept.status, { location: proxy.redirectAccept.location });
          return response.end();
        }
        if (request.url.startsWith("/status/") && proxy.statusFailure) {
          if (proxy.statusFailure === "disconnect") return request.socket.destroy();
          response.writeHead(proxy.statusFailure, { "content-type": "application/json" });
          return response.end(JSON.stringify({ error: "status is unavailable" }));
        }
        const upstream = await fetch(`${proxy.upstream}${request.url}`, {
          method: request.method,
          headers: { "content-type": "application/json" },
          body: request.method === "GET" ? undefined : body,
        });
        let text = await upstream.text();
        if (request.url === "/serve" && proxy.dropNextServe) {
          // The server did the work and answered; the answer never reaches the client.
          proxy.dropNextServe = false;
          proxy.dropped = JSON.parse(text);
          return request.socket.destroy();
        }
        if (request.url === proxy.rewrite?.route && upstream.status === 200) text = stableStringify(await proxy.rewrite.body(JSON.parse(text)));
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(text);
      } catch (error) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `proxy: ${error.message}` }));
      }
    });
    return listen(server, PROXY_PORT);
  }

  async function withRewrite(rewrite, run) {
    proxy.rewrite = rewrite;
    try {
      return await run();
    } finally {
      proxy.rewrite = null;
    }
  }

  // The receipt with `message` fields replaced and, given a requestId, bound to
  // that request (requestIdHash follows it), signed by `signer`.
  async function resign(kind, file, signer, { message = {}, requestId } = {}) {
    const receipt = validateReceiptFile(file, { chainId: CHAIN_ID, address: float }, kind);
    const id = requestId ?? receipt.requestId;
    return signReceipt(signer, {
      kind,
      chainId: CHAIN_ID,
      verifyingContract: float,
      message: { ...receipt.message, requestIdHash: requestIdHashOf(id), ...message },
      requestId: id,
      resultRef: kind === DELIVERY_KIND ? receipt.resultRef : undefined,
    });
  }

  // The server as an operator runs it: its own process, configured from env.
  async function startChildServer(childStore, port = CHILD_PORT) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(FLOAT_|ARC_|PROVIDER_|PORT$|HOST$)/i.test(name)));
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      env: {
        ...inherited,
        ARC_RPC_URL: RPC,
        FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(),
        FLOAT_MAINNET_ADDRESS: float,
        FLOAT_PROVIDER_PRIVATE_KEY: keyOf(5),
        PROVIDER_ENDPOINT: ENDPOINT,
        PROVIDER_PRICE: PRICE.toString(),
        PROVIDER_STORE_DIR: childStore,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    // "close" follows the end of stdout and stderr, so output is complete by then.
    const exited = new Promise((resolve) => child.once("close", resolve));
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the provider server did not start within 30 s:\n${output}`)), 30_000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline === -1) return;
        clearTimeout(timer);
        resolve(JSON.parse(output.slice(0, newline)));
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`the provider server exited with ${code}:\n${output}`));
      });
    });
    return {
      started,
      output: () => output,
      stop: () => {
        child.kill();
        return exited;
      },
    };
  }

  const balance = (address) => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  const path = (name) => join(dir, name);
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
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

  async function openLine(agentAddress = agent.address) {
    const opened = await ok(
      "sponsor",
      [
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
      ],
      SPONSOR,
    );
    return opened.lineId;
  }

  // Builds and signs an intent through the agent's CLI.
  async function signedIntent(name, principal = PRINCIPAL, extra = []) {
    const built = await ok("intent", [
      "build",
      "--agent", agent.address,
      "--sponsor", sponsor.address,
      "--provider", provider.address,
      "--endpoint", ENDPOINT,
      "--principal", principal.toString(),
      "--executor", executor.address,
      "--out", path(`${name}.json`),
      ...extra,
    ]);
    await ok("intent", ["sign", "--intent", path(`${name}.json`), "--out", path(`${name}-signed.json`), ...extra.filter((flag) => flag === "--allow-block")], AGENT);
    return { file: path(`${name}-signed.json`), unsigned: path(`${name}.json`), digest: built.digest };
  }

  const acceptArgs = (providerUrl, intent, requestId, out) => ["accept", "--provider-url", providerUrl, "--intent", intent, "--request-id", requestId, "--out", out];
  const fetchArgs = (providerUrl, source, out) => ["fetch", "--provider-url", providerUrl, ...source, "--out", out];
  const executorNonce = () => client.getTransactionCount({ address: executor.address });

  before(async () => {
    anvil = await startAnvil(PORT);
    dir = mkdtempSync(join(tmpdir(), "float-request-"));
    store = join(dir, "provider-store");
    usdc = await deploy("MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6]);
    float = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [usdc, CHAIN_ID, MAXIMA, INITIAL, 3_600n, 604_800n, 172_800n]);
    const { abi } = artifact("MockAsset.sol/MockAsset.json");
    for (const [holder, amount] of [[sponsor, 10_000_000n], [agent, 2_000_000n]]) {
      const hash = await walletOf(owner).writeContract({ address: usdc, abi, functionName: "mint", args: [holder.address, amount] });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    }
    connection = await connectCandidate({ rpcUrl: RPC, expectedChainId: CHAIN_ID, address: float, runtimeHash: null, deployBlock: 0n });
    current = await startProviderServer(SERVER_PORT);
    proxyServer = await startProxy();
  });

  after(async () => {
    if (proxyServer) await stop(proxyServer);
    if (current) await stop(current.server);
    anvil?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("lifecycle through the CLIs and the server run from env: accept before payment, pay, fetch a checked result, repay and close", async () => {
    await ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], OWNER);
    const lineId = await openLine();
    const a = await signedIntent("a");
    const child = await startChildServer(path("child-store"));
    try {
      assert.deepEqual(
        [child.started.listening, child.started.provider, child.started.float, child.started.endpointHash, child.started.price],
        [CHILD_URL, provider.address, float, ENDPOINT_HASH, PRICE.toString()],
      );
      const accepted = await ok("request", acceptArgs(CHILD_URL, a.file, "req-a", path("acceptance-a.json")));
      assert.deepEqual(
        [accepted.kind, accepted.digest, accepted.requestId, accepted.signer, accepted.typedData.message.digest, accepted.typedData.message.endpointHash],
        [ACCEPTANCE_KIND, a.digest, "req-a", provider.address, a.digest, ENDPOINT_HASH],
      );
      const saved = readJson(path("acceptance-a.json"));
      assert.deepEqual([saved.signature, saved.typedData], [accepted.signature, accepted.typedData]);

      const providerBefore = await balance(provider.address);
      const paid = await ok("submit", ["submit", "--intent", a.file, "--execute"], EXECUTOR);
      assert.deepEqual([paid.status, paid.digest], ["paid", a.digest]);
      assert.equal((await balance(provider.address)) - providerBefore, PRINCIPAL);

      const fetched = await ok("request", fetchArgs(CHILD_URL, ["--intent", a.file, "--acceptance", path("acceptance-a.json")], path("result-a.txt")));
      const bytes = readFileSync(path("result-a.txt"));
      const expected = await exampleService({ digest: a.digest, requestId: "req-a" });
      assert.equal(bytes.toString("utf8"), expected.result);
      assert.deepEqual(
        [fetched.digest, fetched.attempts, fetched.resultHash, fetched.delivery.typedData.message.resultHash, fetched.delivery.resultRef],
        [a.digest, 1, keccak256(bytes), keccak256(bytes), expected.resultRef],
      );
      assert.deepEqual([fetched.delivery.kind, fetched.delivery.requestId, fetched.delivery.signer], [DELIVERY_KIND, "req-a", provider.address]);
      writeFileSync(path("delivery-a.json"), stableStringify(fetched.delivery));
      const verified = await ok("provider", ["verify-receipt", "--file", path("delivery-a.json")]);
      assert.deepEqual([verified.signatureValid, verified.digest, verified.provider], [true, a.digest, provider.address]);
    } finally {
      await child.stop();
    }
    const output = child.output().toLowerCase();
    assert.equal(output.includes(keyOf(5).slice(2).toLowerCase()), false, "the server printed its key");

    const repaid = await ok("repay", ["--line-id", lineId, "--full", "--execute"], AGENT);
    assert.deepEqual([repaid.after.state, repaid.after.principalOutstanding], ["OPEN", "0"]);
    const closed = await ok("sponsor", ["close", "--line-id", lineId, "--execute"], SPONSOR);
    assert.deepEqual([closed.amount, closed.state], ["1000000", "CLOSED"]);
  });

  test("a server run from env whose port is taken prints one JSON error line and exits 1", async () => {
    await assert.rejects(startChildServer(path("busy-store"), PROXY_PORT), (error) => {
      const [, code, output] = /^the provider server exited with (\d+):\n([^]*)$/.exec(error.message) ?? [];
      assert.equal(code, "1", error.message);
      assert.deepEqual(
        output.trim().split("\n").map((line) => JSON.parse(line)),
        [{ ok: false, error: `listen EADDRINUSE: address already in use 127.0.0.1:${PROXY_PORT}` }],
      );
      return true;
    });
  });

  test("fetch before payment is refused from the contract's receiptStatus alone: the provider is not contacted", async () => {
    seen.lineId = await openLine();
    const b = await signedIntent("b");
    const accepted = await ok("request", acceptArgs(PROXY_URL, b.file, "req-b", path("acceptance-b.json")));
    assert.equal(accepted.digest, b.digest);
    const relayed = proxy.log.length;
    const refused = await fails(
      "request",
      fetchArgs(PROXY_URL, ["--intent", b.file, "--acceptance", path("acceptance-b.json")], path("result-b.txt")),
      {},
      /^receiptStatus for digest 0x[0-9a-f]{64} is none at block \d+: nothing has been paid for it; this tool never pays .*; the provider was not contacted$/,
    );
    assert.deepEqual([refused.digest, refused.paid, refused.receiptStatus], [b.digest, false, "none"]);
    assert.deepEqual(proxy.log.slice(relayed), []);
    assert.deepEqual(current.stats.work, []);
    assert.equal(existsSync(path("result-b.txt")), false);
    seen.b = b;
  });

  test("an answer lost after the server did the work is recovered for the same digest: identical result and receipt, one service run, no second payment", async () => {
    const { b } = seen;
    assert.equal((await ok("submit", ["submit", "--intent", b.file, "--execute"], EXECUTOR)).status, "paid");
    const [nonceBefore, providerBefore, signedBefore] = [await executorNonce(), await balance(provider.address), current.stats.signed];
    const relayed = proxy.log.length;
    proxy.dropNextServe = true;
    const fetched = await ok("request", fetchArgs(PROXY_URL, ["--intent", b.file, "--acceptance", path("acceptance-b.json")], path("result-b.txt")));
    assert.deepEqual(proxy.log.slice(relayed), ["POST /serve", `GET /status/${b.digest}`, "POST /serve"]);
    assert.equal(fetched.attempts, 2);
    // The retry returned exactly what the lost answer carried, as stored by digest.
    assert.deepEqual(fetched.delivery, proxy.dropped.delivery);
    assert.deepEqual(readFileSync(path("result-b.txt")), Buffer.from(proxy.dropped.result, "base64"));
    assert.deepEqual(readJson(join(store, `${b.digest}.delivery.json`)), fetched.delivery);
    assert.equal(fetched.delivery.requestId, "req-b");
    assert.deepEqual(current.stats.work, [b.digest]);
    assert.equal(current.stats.signed - signedBefore, 1, "one delivery signed");
    // Nothing was paid again.
    assert.equal(await executorNonce(), nonceBefore);
    assert.equal(await balance(provider.address), providerBefore);
    assert.equal(await client.readContract({ address: float, abi: floatAbi, functionName: "receiptStatus", args: [b.digest] }), 2);

    const again = await ok("request", fetchArgs(PROXY_URL, ["--intent", b.file, "--request-id", "req-b"], path("result-b2.txt")));
    assert.deepEqual([again.attempts, again.delivery, again.resultHash], [1, fetched.delivery, fetched.resultHash]);
    assert.deepEqual(readFileSync(path("result-b2.txt")), readFileSync(path("result-b.txt")));
    assert.deepEqual([current.stats.work, current.stats.signed - signedBefore], [[b.digest], 1]);
    await ok("repay", ["--line-id", seen.lineId, "--full", "--execute"], AGENT);
  });

  test("a status outage does not consume the serve retry or strand a paid result", async () => {
    const { b } = seen;
    const [nonceBefore, providerBefore, signedBefore, workBefore] = [await executorNonce(), await balance(provider.address), current.stats.signed, current.stats.work.length];
    for (const statusFailure of [503, "disconnect"]) {
      const relayed = proxy.log.length;
      proxy.dropNextServe = true;
      proxy.statusFailure = statusFailure;
      try {
        const out = path(`status-outage-${statusFailure}.txt`);
        const fetched = await ok("request", fetchArgs(PROXY_URL, ["--intent", b.file, "--acceptance", path("acceptance-b.json")], out));
        assert.equal(fetched.attempts, 2);
        assert.deepEqual(proxy.log.slice(relayed), ["POST /serve", `GET /status/${b.digest}`, "POST /serve"]);
        assert.deepEqual(fetched.delivery, proxy.dropped.delivery);
        assert.deepEqual(readFileSync(out), Buffer.from(proxy.dropped.result, "base64"));
      } finally {
        proxy.statusFailure = null;
        proxy.dropNextServe = false;
      }
    }
    assert.deepEqual([await executorNonce(), await balance(provider.address), current.stats.signed, current.stats.work.length], [nonceBefore, providerBefore, signedBefore, workBefore]);
  });

  test("307 and 308 redirects never disclose a signed intent to a different origin", async () => {
    let leakedRequests = 0;
    const receiver = await listen(createServer(async (request, response) => {
      leakedRequests += 1;
      for await (const _ of request) { /* Drain any leaked body without logging it. */ }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }), 0);
    const nonceBefore = await executorNonce();
    try {
      for (const status of [307, 308]) {
        proxy.redirectAccept = { status, location: `${url(receiver.address().port)}/stolen` };
        const out = path(`redirect-${status}.json`);
        await fails("request", acceptArgs(PROXY_URL, seen.b.file, "req-b", out), {}, /no answer from the provider .*redirect/i);
        assert.equal(existsSync(out), false);
      }
      assert.equal(leakedRequests, 0);
      assert.equal(await executorNonce(), nonceBefore);
    } finally {
      proxy.redirectAccept = null;
      await stop(receiver);
    }
  });

  test("a restart between accept and serve keeps the acceptance: nothing is re-signed, and the paid digest is served once", async () => {
    const c = await signedIntent("c");
    const accepted = await ok("request", acceptArgs(PROXY_URL, c.file, "req-c", path("acceptance-c.json")));
    const storedAcceptance = readFileSync(join(store, `${c.digest}.acceptance.json`), "utf8");

    await stop(current.server);
    current = await startProviderServer(RESTART_PORT);
    proxy.upstream = url(RESTART_PORT);
    const again = await ok("request", acceptArgs(PROXY_URL, c.file, "req-c", path("acceptance-c2.json")));
    assert.deepEqual([again.signature, again.typedData], [accepted.signature, accepted.typedData]);
    await fails(
      "request",
      acceptArgs(PROXY_URL, c.file, "req-c-other", path("acceptance-c3.json")),
      {},
      /^the provider refused the intent \(HTTP 409\): digest 0x[0-9a-f]{64} is already accepted for request "req-c"; refusing a second acceptance for request "req-c-other"$/,
    );
    assert.equal(current.stats.signed, 0, "the restarted server signed nothing");
    assert.equal(existsSync(path("acceptance-c3.json")), false);

    assert.equal((await ok("submit", ["submit", "--intent", c.file, "--execute"], EXECUTOR)).status, "paid");
    const fetched = await ok("request", fetchArgs(PROXY_URL, ["--intent", c.file, "--acceptance", path("acceptance-c.json")], path("result-c.txt")));
    assert.deepEqual([fetched.attempts, fetched.delivery.requestId], [1, "req-c"]);
    assert.deepEqual([current.stats.work, current.stats.signed], [[c.digest], 1]);
    assert.equal(readFileSync(join(store, `${c.digest}.acceptance.json`), "utf8"), storedAcceptance);
    await ok("repay", ["--line-id", seen.lineId, "--full", "--execute"], AGENT);
    seen.c = { ...c, delivery: fetched.delivery };
  });

  test("one provider request id cannot accept two fresh intent digests, including across a restart", async () => {
    const [first, second] = await Promise.all([signedIntent("same-job-first"), signedIntent("same-job-second")]);
    assert.notEqual(first.digest, second.digest);
    const requestId = "req-same-provider-job";
    const before = [await executorNonce(), await balance(provider.address)];
    const replies = await Promise.all([first, second].map((intent) =>
      post(current.port, "/accept", { intent: readJson(intent.file), requestId })));
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
    const winner = replies.findIndex((reply) => reply.status === 200);
    const accepted = [first, second][winner];
    const refused = [first, second][1 - winner];
    assert.match(replies[1 - winner].json.error,
      new RegExp(`^request "${requestId}" is already accepted for digest ${accepted.digest}; refusing a second intent for the same request$`));
    assert.equal(existsSync(join(store, `${refused.digest}.acceptance.json`)), false);
    assert.deepEqual([await executorNonce(), await balance(provider.address)], before, "acceptance did not pay either intent");

    await stop(current.server);
    current = await startProviderServer(RESTART_PORT);
    proxy.upstream = url(RESTART_PORT);
    assert.deepEqual(await post(current.port, "/accept", { intent: readJson(refused.file), requestId }), replies[1 - winner]);
    assert.deepEqual(await post(current.port, "/accept", { intent: readJson(accepted.file), requestId }), replies[winner]);
    assert.deepEqual([await executorNonce(), await balance(provider.address)], before);
  });

  test("a service side effect with no durable result remains unresolved after restart", async () => {
    const intent = await signedIntent("unknown-work");
    const snapshot = await client.request({ method: "evm_snapshot", params: [] });
    const uncertainStore = path("unknown-work-store");
    const sideEffect = path("unknown-work-side-effect.txt");
    let work = 0;
    const service = async () => {
      work += 1;
      writeFileSync(sideEffect, `external work ${work}`);
      throw new Error("process stopped after external work");
    };
    const makeServer = () => createProviderServer({
      connection, account: provider, endpointHash: ENDPOINT_HASH, price: PRICE, storeDir: uncertainStore, service,
    });
    let server = await listen(makeServer(), 0);
    try {
      const accepted = await post(server.address().port, "/accept", { intent: readJson(intent.file), requestId: "req-unknown-work" });
      assert.equal(accepted.status, 200);
      assert.equal((await ok("submit", ["submit", "--intent", intent.file, "--execute"], EXECUTOR)).status, "paid");
      const before = [await executorNonce(), await balance(provider.address)];
      assert.deepEqual(await post(server.address().port, "/serve", { digest: intent.digest }), {
        status: 500,
        json: { error: `service outcome for digest ${intent.digest} is unknown; the provider must reconcile it before work can be retried` },
      });
      assert.equal(readFileSync(sideEffect, "utf8"), "external work 1");
      assert.equal(existsSync(join(uncertainStore, `${intent.digest}.result.json`)), false);
      const markerFile = join(uncertainStore, `${intent.digest}.started.json`);
      const marker = readJson(markerFile);
      assert.deepEqual(marker, { digest: intent.digest, requestId: "req-unknown-work" });

      await stop(server);
      server = await listen(makeServer(), 0);
      assert.deepEqual(await post(server.address().port, "/serve", { digest: intent.digest }), {
        status: 409,
        json: { error: `service outcome for digest ${intent.digest} is unknown; the provider must reconcile it before work can be retried` },
      });
      assert.equal(work, 1, "the restarted provider did not repeat the side effect");
      assert.deepEqual([await executorNonce(), await balance(provider.address)], before);

      writeFileSync(markerFile, stableStringify({ ...marker, requestId: "wrong-request" }));
      assert.equal((await post(server.address().port, "/serve", { digest: intent.digest })).status, 500);
      assert.equal(work, 1, "a marker that disagrees with the acceptance also blocks work");
    } finally {
      await stop(server);
      assert.equal(await client.request({ method: "evm_revert", params: [snapshot] }), true);
    }
  });

  test("a stored delivery is withheld when a reorg removes its payment", async () => {
    const intent = await signedIntent("reorg");
    await ok("request", acceptArgs(PROXY_URL, intent.file, "req-reorg", path("acceptance-reorg.json")));
    const snapshot = await client.request({ method: "evm_snapshot", params: [] });
    let reverted = false;
    try {
      await ok("submit", ["submit", "--intent", intent.file, "--execute"], EXECUTOR);
      const delivered = await post(current.port, "/serve", { digest: intent.digest });
      assert.equal(delivered.status, 200);
      const [signed, work] = [current.stats.signed, current.stats.work.length];
      assert.equal(await client.request({ method: "evm_revert", params: [snapshot] }), true);
      reverted = true;
      assert.deepEqual(await post(current.port, "/serve", { digest: intent.digest }), {
        status: 402,
        json: { error: "the digest is not paid", receiptStatus: "none" },
      });
      assert.deepEqual([current.stats.signed, current.stats.work.length], [signed, work]);
      assert.deepEqual(readJson(join(store, `${intent.digest}.delivery.json`)), delivered.json.delivery);
    } finally {
      if (!reverted) await client.request({ method: "evm_revert", params: [snapshot] });
    }
  });

  test("a tampered result from a malicious server is rejected, and nothing is written", async () => {
    const { c } = seen;
    proxy.rewrite = { route: "/serve", body: (answer) => ({ ...answer, result: Buffer.from("a different answer").toString("base64") }) };
    try {
      await fails(
        "request",
        fetchArgs(PROXY_URL, ["--digest", c.digest, "--acceptance", path("acceptance-c.json")], path("tampered.txt")),
        {},
        /^rejected the provider's answer for digest 0x[0-9a-f]{64}; nothing was written to .*: the returned result hashes to 0x[0-9a-f]{64}, but the delivery signs resultHash 0x[0-9a-f]{64}$/,
      );
    } finally {
      proxy.rewrite = null;
    }
    assert.equal(existsSync(path("tampered.txt")), false);
  });

  test("a delivery or an acceptance signed by another key is rejected, and nothing is written", async () => {
    const { c } = seen;
    const forgeAs = (signer) => ({ address: provider.address, signTypedData: (typed) => signer.signTypedData(typed) });

    // The provider's name on another key's signature.
    const forged = await resign(DELIVERY_KIND, c.delivery, forgeAs(stranger));
    await withRewrite({ route: "/serve", body: (answer) => ({ ...answer, delivery: forged }) }, () =>
      fails(
        "request",
        fetchArgs(PROXY_URL, ["--intent", c.file, "--acceptance", path("acceptance-c.json")], path("forged.txt")),
        {},
        new RegExp(`nothing was written to .*: the delivery is not signed by provider ${provider.address}: signature recovers to ${stranger.address}, not ${provider.address}$`),
      ),
    );
    // Another key's own, validly signed delivery for the paid digest.
    const own = await resign(DELIVERY_KIND, c.delivery, stranger, { message: { provider: stranger.address } });
    await withRewrite({ route: "/serve", body: (answer) => ({ ...answer, delivery: own }) }, () =>
      fails(
        "request",
        fetchArgs(PROXY_URL, ["--intent", c.file, "--request-id", "req-c"], path("forged.txt")),
        {},
        new RegExp(`nothing was written to .*: the delivery names provider ${stranger.address}, not the paid provider ${provider.address}$`),
      ),
    );
    assert.equal(existsSync(path("forged.txt")), false);

    // Before payment, the same holds for the provider's acceptance.
    const d = await signedIntent("d");
    await withRewrite({ route: "/accept", body: (acceptance) => resign(ACCEPTANCE_KIND, acceptance, forgeAs(stranger)) }, () =>
      fails(
        "request",
        acceptArgs(PROXY_URL, d.file, "req-d", path("acceptance-d.json")),
        {},
        new RegExp(`^rejected the provider's acceptance; nothing was written to .*: the acceptance is not signed by provider ${provider.address}: signature recovers to ${stranger.address}`),
      ),
    );
    await withRewrite({ route: "/accept", body: (acceptance) => resign(ACCEPTANCE_KIND, acceptance, stranger, { message: { provider: stranger.address } }) }, () =>
      fails(
        "request",
        acceptArgs(PROXY_URL, d.file, "req-d", path("acceptance-d.json")),
        {},
        new RegExp(`the acceptance names provider ${stranger.address}; the intent pays ${provider.address}$`),
      ),
    );
    assert.equal(existsSync(path("acceptance-d.json")), false);
    // The genuine acceptance still comes through unaltered.
    assert.equal((await ok("request", acceptArgs(PROXY_URL, d.file, "req-d", path("acceptance-d.json")))).signer, provider.address);
    seen.d = d;
  });

  test("the provider's own signature does not save an acceptance or a delivery for another digest, request, endpoint, principal or time, or a result in non-canonical base64: each is rejected and nothing is written", async () => {
    const { c } = seen;
    const other = keccak256(stringToBytes("another digest"));
    const { timestamp: latest } = await client.getBlock();
    const acceptC = acceptArgs(PROXY_URL, c.file, "req-c", path("rebound-acceptance.json"));
    for (const [patch, problem] of [
      [{ message: { digest: other } }, `the acceptance is for digest ${other}, not ${c.digest}`],
      [{ requestId: "req-other" }, 'the acceptance is for request "req-other", not "req-c"'],
      [{ message: { endpointHash: OTHER_HASH } }, `the acceptance is for endpointHash ${OTHER_HASH}; the intent's is ${ENDPOINT_HASH}`],
      [{ message: { principal: PRINCIPAL + 1n } }, `the acceptance is for principal ${PRINCIPAL + 1n}; the intent's is ${PRINCIPAL}`],
      [{ message: { acceptedAt: latest + 1_000n } }, `the acceptance's acceptedAt ${latest + 1_000n} is after the latest block's timestamp \\d+`],
    ]) {
      await withRewrite({ route: "/accept", body: (acceptance) => resign(ACCEPTANCE_KIND, acceptance, provider, patch) }, () =>
        fails("request", acceptC, {}, new RegExp(`^rejected the provider's acceptance; nothing was written to .*: ${problem}$`)),
      );
    }
    assert.equal(existsSync(path("rebound-acceptance.json")), false);

    // --out already holds a file: a rejected answer leaves it as it was.
    const out = path("rebound.txt");
    writeFileSync(out, "left alone");
    const fetchC = (binding = ["--acceptance", path("acceptance-c.json")]) => fetchArgs(PROXY_URL, ["--intent", c.file, ...binding], out);
    const { providerPaid } = await checkPayment(connection, c.digest);
    const { timestamp: paidAt } = await client.getBlock({ blockNumber: providerPaid.blockNumber });
    for (const [patch, problem] of [
      [{ message: { digest: other } }, `the delivery is for digest ${other}, not ${c.digest}`],
      [{ requestId: "req-other" }, `the delivery is for request "req-other", not the agent's request "req-c"`],
      [{ message: { deliveredAt: paidAt - 1n } }, `the delivery's deliveredAt ${paidAt - 1n} is before the payment block's timestamp ${paidAt}`],
    ]) {
      await withRewrite({ route: "/serve", body: async (answer) => ({ ...answer, delivery: await resign(DELIVERY_KIND, answer.delivery, provider, patch) }) }, () =>
        fails("request", fetchC(), {}, new RegExp(`^rejected the provider's answer for digest ${c.digest}; nothing was written to .*: ${problem}$`)),
      );
    }
    // The same bytes and the provider's genuine delivery, but not in canonical base64.
    await withRewrite({ route: "/serve", body: (answer) => ({ ...answer, result: `${answer.result}\n` }) }, () =>
      fails("request", fetchC(), {}, new RegExp(`^rejected the provider's answer for digest ${c.digest}; nothing was written to .*: the answer's result is not canonical base64$`)),
    );
    // An answer too large to be a result is not read to its end.
    await withRewrite({ route: "/serve", body: (answer) => ({ ...answer, result: "A".repeat(MAX_ANSWER_BYTES + 1) }) }, () =>
      fails("request", fetchC(), {}, new RegExp(`^the provider's answer for digest ${c.digest} is HTTP 200 with a body over ${MAX_ANSWER_BYTES} bytes; nothing was written to .*$`)),
    );

    // fetch binds the delivery to the agent's own request: --acceptance or --request-id is required.
    const unbound = await cli("request", fetchC([]));
    assert.equal(unbound.status, 2, JSON.stringify(unbound.json));
    assert.match(unbound.json.error.message, /^pass --acceptance <acceptance\.json> or --request-id <id>/);
    await fails("request", fetchC(["--request-id", "req-other"]), {}, /: the delivery is for request "req-c", not the agent's request "req-other"$/);
    await fails("request", fetchC(["--acceptance", path("acceptance-c.json"), "--request-id", "req-other"]), {}, /^the acceptance is for request "req-c", not "req-other"$/);
    // An acceptance the provider signed after the payment, which the verifier refuses.
    await client.request({ method: "evm_increaseTime", params: [10] });
    await client.request({ method: "evm_mine", params: [] });
    writeFileSync(path("late-acceptance.json"), stableStringify(await resign(ACCEPTANCE_KIND, readJson(path("acceptance-c.json")), provider, { message: { acceptedAt: paidAt + 1n } })));
    await fails(
      "request",
      fetchC(["--acceptance", path("late-acceptance.json")]),
      {},
      new RegExp(`^the acceptance's acceptedAt ${paidAt + 1n} is after the payment block's timestamp ${paidAt} \\(ProviderPaid in 0x[0-9a-f]{64}\\)`),
    );
    assert.equal(readFileSync(out, "utf8"), "left alone");

    // The genuine answer replaces --out whole, through a temporary file that is gone afterwards.
    const fetched = await ok("request", fetchC(["--request-id", "req-c"]));
    assert.deepEqual(readFileSync(out), readFileSync(path("result-c.txt")));
    assert.equal(fetched.delivery.requestId, "req-c");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  });

  test("a failed answer is retried: the result the service stored is signed on the retry, without running the service again", async () => {
    const { d } = seen;
    assert.equal((await ok("submit", ["submit", "--intent", d.file, "--execute"], EXECUTOR)).status, "paid");
    const [nonceBefore, workBefore, relayed] = [await executorNonce(), current.stats.work.length, proxy.log.length];
    current.stats.failNextSign = true;
    const fetched = await ok("request", fetchArgs(PROXY_URL, ["--intent", d.file, "--acceptance", path("acceptance-d.json")], path("result-d.txt")));
    assert.deepEqual(proxy.log.slice(relayed), ["POST /serve", `GET /status/${d.digest}`, "POST /serve"]);
    assert.deepEqual([fetched.attempts, fetched.delivery.requestId], [2, "req-d"]);
    assert.deepEqual(current.stats.work.slice(workBefore), [d.digest]);
    assert.equal(readFileSync(path("result-d.txt"), "utf8"), (await exampleService({ digest: d.digest, requestId: "req-d" })).result);
    assert.equal(await executorNonce(), nonceBefore);
    await ok("repay", ["--line-id", seen.lineId, "--full", "--execute"], AGENT);
  });

  test("POST /serve straight to the server: an unpaid or a blocked digest gets 402 and a digest with no acceptance 404, with no service run and nothing signed", async () => {
    const f = await signedIntent("f");
    assert.equal((await post(current.port, "/accept", { intent: readJson(f.file), requestId: "req-f" })).status, 200);
    // A retry is answered from the store only for an intent file the agent signed.
    assert.deepEqual(await post(current.port, "/accept", { intent: readJson(f.unsigned), requestId: "req-f" }), {
      status: 422,
      json: { error: "the intent file carries no signature; the agent signs it before sending it to the provider" },
    });
    const otherSigner = { ...readJson(f.file), signature: await sign({ hash: f.digest, privateKey: keyOf(6), to: "hex" }) };
    const wronglySigned = await post(current.port, "/accept", { intent: otherSigner, requestId: "req-f" });
    assert.equal(wronglySigned.status, 422);
    assert.match(wronglySigned.json.error, new RegExp(`^the agent's signature does not verify: signature recovers to 0x[0-9a-fA-F]{40}, not the agent ${agent.address}$`));
    // Over the line's next-spend capacity, so the provider refuses to accept it
    // (a refusal found by acceptIntent's chain reads: 422). Its acceptance is
    // put in the store directly: an intent that was blocked after acceptance.
    const line = await ok("line", ["status", "--line-id", seen.lineId, "--provider", provider.address]);
    const overCap = BigInt(line.providers[0].remaining.nextSpendMax) + 1n;
    const over = await signedIntent("over", overCap, ["--allow-block"]);
    const refused = await post(current.port, "/accept", { intent: readJson(over.file), requestId: "req-over" });
    assert.equal(refused.status, 422);
    assert.match(refused.json.error, /^the contract would record it as SpendBlocked\([A-Z_]+\) and pay nothing: /);
    const { timestamp } = await client.getBlock();
    const overAcceptance = await signReceipt(provider, {
      kind: ACCEPTANCE_KIND,
      chainId: CHAIN_ID,
      verifyingContract: float,
      message: { digest: over.digest, provider: provider.address, endpointHash: ENDPOINT_HASH, principal: overCap, requestIdHash: requestIdHashOf("req-over"), acceptedAt: timestamp },
      requestId: "req-over",
    });
    writeFileSync(join(store, `${over.digest}.acceptance.json`), stableStringify(overAcceptance));
    assert.equal((await ok("submit", ["submit", "--intent", over.file, "--execute", "--allow-block"], EXECUTOR)).status, "blocked");
    const unaccepted = keccak256(stringToBytes("a digest nobody sent to the provider"));
    seen.f = f;

    const [signed, work] = [current.stats.signed, current.stats.work.length];
    assert.deepEqual(await post(current.port, "/serve", { digest: f.digest }), { status: 402, json: { error: "the digest is not paid", receiptStatus: "none" } });
    assert.deepEqual(await post(current.port, "/serve", { digest: over.digest }), { status: 402, json: { error: "the digest is not paid", receiptStatus: "blocked" } });
    assert.deepEqual(await post(current.port, "/serve", { digest: unaccepted }), { status: 404, json: { error: `no accepted request for digest ${unaccepted}` } });
    assert.deepEqual([current.stats.signed, current.stats.work.length], [signed, work], "no service run and nothing signed");
    for (const digest of [f.digest, over.digest, unaccepted]) {
      for (const slot of ["result", "delivery"]) assert.equal(existsSync(join(store, `${digest}.${slot}.json`)), false, `${digest}.${slot}`);
    }
  });

  test("only acceptIntent's refusals get 422, and one refused on its face costs no chain read; an RPC, signer or store failure gets a 500 that names only the digest and is logged in full; the client calls a 5xx retryable", async () => {
    const g = await signedIntent("g");
    const intent = readJson(g.file);
    // Another provider's server, at another endpoint and a higher price.
    const other = await startProviderServer(OTHER_PORT, { key: stranger, endpointHash: OTHER_HASH, price: PRICE + 1n, storeDir: path("other-store") });
    try {
      assert.deepEqual(await post(OTHER_PORT, "/accept", { intent, requestId: "req-g" }), {
        status: 422,
        json: {
          error: `the intent pays provider ${provider.address}, not ${stranger.address}; the intent's endpointHash ${ENDPOINT_HASH} is not this endpoint's ${OTHER_HASH}; the intent's principal ${PRINCIPAL} is below the price ${PRICE + 1n}`,
        },
      });
      assert.deepEqual([other.stats.calls, other.stats.signed], [[], 0]);
    } finally {
      await stop(other.server);
    }
    const calls = current.stats.calls.length;
    assert.deepEqual(await post(current.port, "/accept", { intent: readJson(g.unsigned), requestId: "req-g" }), {
      status: 422,
      json: { error: "the intent file carries no signature; the agent signs it before sending it to the provider" },
    });
    assert.deepEqual(current.stats.calls.slice(calls), []);
    const malformed = await post(current.port, "/accept", { intent: { ...intent, kind: "ShadowFloatV2.SpendIntent" }, requestId: "req-g" });
    assert.equal(malformed.status, 400);
    assert.match(malformed.json.error, /^not a ShadowFloatMainnet\.SpendIntent file/);

    // /status reads receiptStatus only: no ProviderPaid log scan.
    const statusCalls = current.stats.calls.length;
    assert.deepEqual(await send(current.port, "GET", `/status/${seen.c.digest}`), {
      status: 200,
      json: { accepted: true, delivered: true, digest: seen.c.digest, paid: true, receiptStatus: "paid", requestId: "req-c" },
    });
    assert.deepEqual(current.stats.calls.slice(statusCalls), ["readContract"]);

    const logged = [];
    const log = console.error;
    console.error = (line) => logged.push(JSON.parse(line));
    const failedOn = (digest) => ({ error: `the provider failed on digest ${digest} and logged the error; the request can be retried` });
    const stranded = keccak256(stringToBytes("a digest whose stored acceptance names another provider"));
    const resultFile = join(store, `${seen.c.digest}.result.json`);
    const storedResult = readFileSync(resultFile);
    try {
      // The chain read fails while acceptIntent checks the intent.
      current.stats.failNextCall = new HttpRequestError({ url: `${RPC}/rpc-api-key`, status: 503 });
      assert.deepEqual(await post(current.port, "/accept", { intent, requestId: "req-g" }), { status: 500, json: failedOn(g.digest) });
      // The signer fails once every check passed; the client says to retry.
      current.stats.failNextSign = true;
      await fails(
        "request",
        acceptArgs(PROXY_URL, g.file, "req-g", path("acceptance-g.json")),
        {},
        new RegExp(
          `^the provider failed \\(HTTP 500\\): the provider failed on digest ${g.digest} and logged the error; the request can be retried; nothing is paid before acceptance, so this is retryable: run accept again with the same signed intent and --request-id$`,
        ),
      );
      assert.equal(existsSync(path("acceptance-g.json")), false);
      assert.equal(existsSync(join(store, `${g.digest}.acceptance.json`)), false);
      // The store holds another provider's acceptance under a digest's name.
      const strangers = await signReceipt(stranger, {
        kind: ACCEPTANCE_KIND,
        chainId: CHAIN_ID,
        verifyingContract: float,
        message: { digest: stranded, provider: stranger.address, endpointHash: ENDPOINT_HASH, principal: PRINCIPAL, requestIdHash: requestIdHashOf("req-x"), acceptedAt: 1n },
        requestId: "req-x",
      });
      writeFileSync(join(store, `${stranded}.acceptance.json`), stableStringify(strangers));
      assert.deepEqual(await post(current.port, "/serve", { digest: stranded }), { status: 500, json: failedOn(stranded) });
      // A delivered digest whose stored result is gone, or no longer the one its delivery signs.
      const unmatched = {
        status: 500,
        json: {
          error: `the provider's stored result for digest ${seen.c.digest} is missing or does not match its signed delivery; the provider has to restore it before the digest can be served`,
        },
      };
      unlinkSync(resultFile);
      assert.deepEqual(await post(current.port, "/serve", { digest: seen.c.digest }), unmatched);
      writeFileSync(resultFile, JSON.stringify({ ...JSON.parse(storedResult), result: Buffer.from("another answer").toString("base64") }));
      assert.deepEqual(await post(current.port, "/serve", { digest: seen.c.digest }), unmatched);
      // An accepted digest whose stored result is another request's: refused before any chain read, and nothing is signed.
      const foreignResult = join(store, `${seen.f.digest}.result.json`);
      writeFileSync(foreignResult, stableStringify({ ...JSON.parse(storedResult), digest: seen.f.digest }));
      const [signed, work, reads] = [current.stats.signed, current.stats.work.length, current.stats.calls.length];
      assert.deepEqual(await post(current.port, "/serve", { digest: seen.f.digest }), {
        status: 500,
        json: {
          error: `the provider's stored result for digest ${seen.f.digest} is not this digest's result for its accepted request; the provider has to restore it before the digest can be served`,
        },
      });
      assert.deepEqual([current.stats.signed, current.stats.work.length, current.stats.calls.slice(reads)], [signed, work, []]);
      assert.equal(existsSync(join(store, `${seen.f.digest}.delivery.json`)), false);
      unlinkSync(foreignResult);
    } finally {
      console.error = log;
      writeFileSync(resultFile, storedResult);
    }
    assert.equal((await post(current.port, "/serve", { digest: seen.c.digest })).status, 200);
    assert.deepEqual(
      logged.map(({ request, digest, status }) => [request, digest, status]),
      [
        ["POST /accept", g.digest, 500],
        ["POST /accept", g.digest, 500],
        ["POST /serve", stranded, 500],
        ["POST /serve", seen.c.digest, 500],
        ["POST /serve", seen.c.digest, 500],
        ["POST /serve", seen.f.digest, 500],
      ],
    );
    // The log keeps the whole error, with the RPC URL's path redacted and the store's paths kept.
    assert.match(logged[0].error, /HttpRequestError: HTTP request failed\.[^]*Status: 503[^]*URL: http:\/\/127\.0\.0\.1:18640\/\[redacted\]/);
    assert.equal(logged[0].error.includes("rpc-api-key"), false);
    assert.match(logged[1].error, /Error: the signer is unavailable/);
    assert.ok(logged[2].error.includes(join(store, `${stranded}.acceptance.json`)), logged[2].error);
  });

  test("each stored file is flushed to disk before it is linked into place, and its directory after", async () => {
    // A spy on the node:fs functions the kit's storeOnce imports: syncBuiltinESMExports
    // updates the named exports other modules hold.
    const events = [];
    const opened = new Map();
    const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync };
    fs.openSync = (file, ...rest) => {
      const fd = real.openSync(file, ...rest);
      opened.set(fd, String(file));
      return fd;
    };
    fs.fsyncSync = (fd) => {
      events.push(["fsync", opened.get(fd)]);
      return real.fsyncSync(fd);
    };
    fs.linkSync = (from, to) => {
      events.push(["link", String(from), String(to)]);
      return real.linkSync(from, to);
    };
    syncBuiltinESMExports();
    const g = await signedIntent("g2");
    try {
      await ok("request", acceptArgs(PROXY_URL, g.file, "req-g2", path("acceptance-g2.json")));
      assert.equal((await ok("submit", ["submit", "--intent", g.file, "--execute"], EXECUTOR)).status, "paid");
      await ok("request", fetchArgs(PROXY_URL, ["--intent", g.file, "--acceptance", path("acceptance-g2.json")], path("result-g2.txt")));
    } finally {
      Object.assign(fs, real);
      syncBuiltinESMExports();
    }
    for (const slot of ["acceptance", "result", "delivery"]) {
      const file = join(store, `${g.digest}.${slot}.json`);
      const linked = events.findIndex(([kind, , to]) => kind === "link" && to === file);
      assert.notEqual(linked, -1, `${slot} was linked into place: ${JSON.stringify(events)}`);
      const temporary = events[linked][1];
      const flushed = events.findIndex(([kind, target]) => kind === "fsync" && target === temporary);
      assert.ok(flushed !== -1 && flushed < linked, `${slot} was flushed before it was linked: ${JSON.stringify(events)}`);
      // Windows cannot open a directory to flush it.
      const directory = events.findIndex(([kind, target], k) => k > linked && kind === "fsync" && target === store);
      assert.equal(directory !== -1, process.platform !== "win32", `${slot}'s directory flush: ${JSON.stringify(events)}`);
    }
    await ok("repay", ["--line-id", seen.lineId, "--full", "--execute"], AGENT);
  });

  test("a stored receipt is not re-verified when read, so an ERC-1271 provider that rotated its signer still serves what it stored", async () => {
    const snapshot = await client.request({ method: "evm_snapshot", params: [] });
    const smartAccount = "ShadowFloatMainnetPilotLifecycle.t.sol/PilotSmartAccount.json";
    const smart = await deploy(smartAccount, [account(7).address]);
    const rotated = await deploy(smartAccount, [account(8).address]);
    const signer = { address: smart, signTypedData: async (typed) => accountSignature(hashTypedData(typed), keyOf(7)) };
    const smartStore = path("smart-store");
    const server = createProviderServer({ connection, account: signer, endpointHash: ENDPOINT_HASH, price: PRICE, storeDir: smartStore, service: exampleService });
    await listen(server, SMART_PORT);
    try {
      await ok("sponsor", ["set-provider-policy", "--line-id", seen.lineId, "--provider", smart, "--endpoint", ENDPOINT,
        "--per-spend", "1000000", "--daily", "1000000", "--expiry", SIXTY_DAYS, "--execute"], SPONSOR);
      const { digest } = await ok("intent", ["build", "--agent", agent.address, "--sponsor", sponsor.address,
        "--provider", smart, "--endpoint", ENDPOINT, "--principal", PRINCIPAL.toString(), "--executor", executor.address,
        "--out", path("smart-intent.json")]);
      await ok("intent", ["sign", "--intent", path("smart-intent.json"), "--out", path("smart-signed.json")], AGENT);
      assert.equal((await post(SMART_PORT, "/accept", { intent: readJson(path("smart-signed.json")), requestId: "req-smart" })).status, 200);
      await ok("submit", ["submit", "--intent", path("smart-signed.json"), "--execute"], EXECUTOR);
      const served = await post(SMART_PORT, "/serve", { digest });
      assert.equal(served.status, 200);
      const { delivery } = served.json;
      // The account rotates: its code now accepts only another signer's signatures.
      await client.request({ method: "anvil_setCode", params: [smart, await client.getCode({ address: rotated })] });
      const { hash, signature } = validateReceiptFile(delivery, connection, DELIVERY_KIND);
      assert.equal((await signatureAt(connection, { signer: smart, hash, signature })).valid, false);

      assert.deepEqual(await post(SMART_PORT, "/serve", { digest }), served);
      await ok("repay", ["--line-id", seen.lineId, "--full", "--execute"], AGENT);
    } finally {
      await stop(server);
      assert.equal(await client.request({ method: "evm_revert", params: [snapshot] }), true);
    }
  });

  test("concurrent first requests for one digest get one acceptance, one service run and one receipt, through the server's in-flight map", async () => {
    const e = await signedIntent("e");
    const intent = readJson(e.file);
    const signedBefore = current.stats.signed;
    const requests = 6;
    // The signer and the service wait until every request has reached the
    // server, so none can find a stored file: all but the first join its run.
    current.stats.hold = arrivals(current.server, requests);
    const accepts = await Promise.all(Array.from({ length: requests }, (_, k) => post(current.port, "/accept", { intent, requestId: `req-e-${k}` })));
    const accepted = accepts.filter((reply) => reply.status === 200);
    assert.equal(accepted.length, 1, JSON.stringify(accepts, null, 2));
    const winner = accepted[0].json.requestId;
    accepts.forEach((reply, k) => {
      if (reply.status === 200) return;
      assert.deepEqual(reply, {
        status: 409,
        json: { error: `digest ${e.digest} is already accepted for request ${JSON.stringify(winner)}; refusing a second acceptance for request "req-e-${k}"` },
      });
    });
    assert.equal(current.stats.signed - signedBefore, 1, "one acceptance signed");

    assert.equal((await ok("submit", ["submit", "--intent", e.file, "--execute"], EXECUTOR)).status, "paid");
    const workBefore = current.stats.work.length;
    current.stats.hold = arrivals(current.server, requests);
    const serves = await Promise.all(Array.from({ length: requests }, () => post(current.port, "/serve", { digest: e.digest })));
    current.stats.hold = null;
    assert.equal(serves[0].status, 200, JSON.stringify(serves[0]));
    for (const reply of serves) assert.deepEqual(reply, serves[0]);
    assert.deepEqual(current.stats.work.slice(workBefore), [e.digest]);
    assert.equal(current.stats.signed - signedBefore, 2, "one acceptance and one delivery signed");
    assert.equal(serves[0].json.delivery.requestId, winner);
  });

  test("fresh and stored ERC-1271 acceptances retry after signature RPC failures, but reject actual invalid signatures", async () => {
    const snapshot = await client.request({ method: "evm_snapshot", params: [] });
    const logged = [];
    const originalLog = console.error;
    console.error = (message) => logged.push(JSON.parse(message));
    try {
      const smart = await deploy("ShadowFloatMainnetPilotLifecycle.t.sol/PilotSmartAccount.json", [account(7).address]);
      await openLine(smart);
      const transport = new HttpRequestError({ url: `${RPC}/signature-rpc-secret`, status: 503 });
      const failures = [
        { method: "call", error: new CallExecutionError(transport, { to: smart }) },
        { method: "call", error: new Error("signature RPC connection reset") },
        { method: "getCode", error: new Error("account-code RPC unavailable") },
      ];
      for (const [index, failure] of failures.entries()) {
        const intentPath = path(`smart-agent-${index}.json`);
        const { digest } = await ok("intent", ["build", "--agent", smart, "--sponsor", sponsor.address,
          "--provider", provider.address, "--endpoint", ENDPOINT, "--principal", PRINCIPAL.toString(),
          "--executor", executor.address, "--out", intentPath]);
        await ok("intent", ["verify", "--intent", intentPath, "--signature", await accountSignature(digest, keyOf(7)), "--out", intentPath]);
        const intent = readJson(intentPath);
        const requestId = `req-smart-agent-${index}`;
        const out = path(`smart-agent-${index}-acceptance.json`);
        const args = acceptArgs(PROXY_URL, intentPath, requestId, out);
        const signedBefore = current.stats.signed;

        // Both a real contract revert (malformed bytes) and wrong magic
        // (well-formed signature from another key) are permanent refusals.
        for (const signature of ["0x1234", await accountSignature(digest, keyOf(8))]) {
          const reply = await post(current.port, "/accept", { intent: { ...intent, signature }, requestId });
          assert.equal(reply.status, 422);
          assert.match(reply.json.error, /the agent's signature does not verify/);
        }

        current.stats.failSignatureRpc = { ...failure, address: smart };
        await fails("request", args, {}, /^the provider failed \(HTTP 500\).*retryable/);
        assert.equal(current.stats.failSignatureRpc, null, "the injected failure reached signature verification");
        assert.equal(current.stats.signed, signedBefore);
        assert.equal(existsSync(out), false);
        assert.equal(existsSync(join(store, `${digest}.acceptance.json`)), false);

        const accepted = await ok("request", args);
        assert.equal(current.stats.signed, signedBefore + 1);
        unlinkSync(out);
        current.stats.failSignatureRpc = { ...failure, address: smart };
        await fails("request", args, {}, /^the provider failed \(HTTP 500\).*retryable/);
        assert.equal(current.stats.failSignatureRpc, null);
        assert.equal(existsSync(out), false);
        const retried = await ok("request", args);
        assert.deepEqual([retried.signature, retried.typedData], [accepted.signature, accepted.typedData]);
        assert.equal(current.stats.signed, signedBefore + 1, "stored acceptance is not signed again");

        const rejected = await post(current.port, "/accept", { intent: { ...intent, signature: "0x1234" }, requestId });
        assert.equal(rejected.status, 422, "stored acceptance still checks an actually invalid signature");
      }
      assert.equal(logged.length, failures.length * 2);
      assert.ok(logged.every(({ status, error }) => status === 500 && error.includes("SignatureCheckUnavailable")));
      assert.equal(JSON.stringify(logged).includes("signature-rpc-secret"), false);
    } finally {
      console.error = originalLog;
      current.stats.failSignatureRpc = null;
      assert.equal(await client.request({ method: "evm_revert", params: [snapshot] }), true);
    }
  });
});
