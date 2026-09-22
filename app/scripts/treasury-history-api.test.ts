import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import handler from "../api/treasury.ts";
import { LEPTON_M1_DEPLOYMENTS } from "../leptonM1Config.js";

async function withTreasury(t: TestContext, mode: "slow-proof" | "slow-verification", action: (state: any) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const env = {
    ARC_RPC_URL: "https://configured.example.test",
    ARC_PUBLIC_RPC_URL: "https://canonical.example.test",
    TREASURY_VERIFY_FLOAT_API_URL: "https://float.example.test/api/float",
    // Keep warm-worker success caches from the other scenario out of this one.
    TREASURY_VERIFY_ALLOWED_TX: `0x${(mode === "slow-proof" ? "11" : "22").repeat(32)}`,
    TREASURY_VERIFY_X402_SETTLEMENT_TX: `0x${(mode === "slow-proof" ? "33" : "44").repeat(32)}`,
    TREASURY_VERIFY_FLOAT_BIND_TX: `0x${(mode === "slow-proof" ? "55" : "66").repeat(32)}`,
  };
  const originalEnv = new Map(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const calls: Array<{ url: string; method?: string; hash?: string; at: number }> = [];
  const pendingSignals: AbortSignal[] = [];
  const neverRespond = (signal: AbortSignal) => {
    pendingSignals.push(signal);
    return new Promise<Response>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const historicalHash = LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("configured.example.test") || url.includes("canonical.example.test")) {
      const request = JSON.parse(input instanceof Request ? await input.text() : String(init?.body));
      calls.push({ url, method: request.method, hash: request.params[0], at: Date.now() });
      let result: unknown;
      if (request.method === "eth_getTransactionByHash") {
        const historical = request.params[0] === historicalHash;
        if ((mode === "slow-proof" && historical) || (mode === "slow-verification" && !historical)) {
          return neverRespond(init!.signal!);
        }
        result = historical ? { hash: historicalHash, input: "0xabcd", type: "0x0" } : null;
      } else if (request.method === "eth_getTransactionReceipt") {
        result = { status: "0x1", logs: [], blockNumber: "0x1", transactionHash: request.params[0], type: "0x0" };
      } else if (request.method === "eth_call") {
        result = `0x${"0".repeat(64 * 10)}`;
      } else if (request.method === "eth_getCode") {
        result = "0x";
      } else {
        throw new Error(`Unexpected RPC method ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    }
    calls.push({ url, at: Date.now() });
    if (url === env.TREASURY_VERIFY_FLOAT_API_URL) return Response.json({ receipts: [] });
    if (url.startsWith("https://testnet.arcscan.app/api/v2/transactions/")) {
      if (mode === "slow-verification") return neverRespond(init!.signal!);
      return Response.json(url.endsWith("/logs") ? { items: [] } : { status: "ok", token_transfers: [] });
    }
    throw new Error(`Unexpected network request ${url}`);
  };
  let status = 0;
  let body: any;
  const headers = new Map<string, string | number>();
  const response = {
    setHeader(name: string, value: string | number) { headers.set(name, value); },
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = JSON.parse(JSON.stringify(value)); },
  };
  const completed = handler({ method: "GET" }, response);
  try {
    await flush();
    await action({
      calls, pendingSignals, completed, headers,
      response: () => ({ status, body }),
      advance: async (ms: number) => { t.mock.timers.tick(ms); await flush(); },
    });
  } finally {
    // Flush cancellation handlers before restoring the network stub.
    t.mock.timers.tick(30_000);
    await flush();
    globalThis.fetch = originalFetch;
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    t.mock.timers.reset();
  }
}

test("treasury returns an unavailable proof check inside one budget when both RPC sources hang", async (t) => {
  await withTreasury(t, "slow-proof", async ({ calls, pendingSignals, completed, response, advance }) => {
    await advance(5_000);
    await advance(3_000);
    await completed;
    const { status, body } = response();
    assert.equal(status, 500);
    assert.equal(body.ok, false);
    const proofCheck = body.checks?.find((entry: any) => entry.check.startsWith("historical passkey proof"));
    assert.ok(proofCheck, JSON.stringify(body));
    assert.equal(proofCheck.ok, false);
    assert.match(proofCheck.detail, /historical proof deadline exceeded/);
    assert.equal(body.historicalProofs.circlePasskey.blockNumber, "47710773");
    const historical = calls.filter((entry: any) => entry.hash === LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash);
    assert.deepEqual(historical.map((entry: any) => new URL(entry.url).hostname), ["configured.example.test", "canonical.example.test"]);
    assert.equal(calls.some((entry: any) => entry.method === "eth_getBlockByNumber"), false);
    assert.ok(pendingSignals.every((signal: AbortSignal) => signal.aborted), "completed handler cancels pending RPC requests");
  });
});

test("treasury's shared deadline bounds later verification fallbacks and prevents post-response reads", async (t) => {
  await withTreasury(t, "slow-verification", async ({ calls, pendingSignals, completed, response, advance, headers }) => {
    await advance(5_000);
    await advance(8_000);
    await advance(5_000);
    await completed;
    const { status, body } = response();
    assert.equal(status, 500);
    assert.equal(body.ok, false);
    assert.equal(body.degraded, true);
    assert.match(body.error, /Treasury verification deadline exceeded/);
    assert.equal(headers.get("Cache-Control"), "no-store");
    assert.ok(pendingSignals.length > 0);
    assert.ok(pendingSignals.every((signal: AbortSignal) => signal.aborted));
    const countAtResponse = calls.length;
    await advance(20_000);
    assert.equal(calls.length, countAtResponse, "expired stages must not launch more RPC or explorer work");
  });
});
