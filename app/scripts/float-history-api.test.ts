import assert from "node:assert/strict";
import test from "node:test";
import { toFunctionSelector } from "viem";
import handler from "../api/float.ts";

// Exercise the real handler and ABI decoding without contacting either service.
async function runHistory({
  receiptCount = 0n,
  explorerStatus = 200,
  explorerBody = { items: [], next_page_params: null } as unknown,
  rpcLogsFail = true,
} = {}) {
  const originalFetch = globalThis.fetch;
  const envNames = ["SHADOW_FLOAT", "ARC_RPC_URL", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.SHADOW_FLOAT = "0x0000000000000000000000000000000000000001";
  process.env.ARC_RPC_URL = "https://rpc.example.test";
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  let status = 0;
  let body: any;
  let logCalls = 0;
  const headers = new Map<string, string | number>();
  const response = {
    setHeader(name: string, value: string | number) { headers.set(name, value); },
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; },
  };
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin === "https://rpc.example.test") {
      const request = JSON.parse(input instanceof Request ? await input.text() : String(init?.body));
      let result: string | unknown[];
      if (request.method === "eth_blockNumber") {
        result = "0x1";
      } else if (request.method === "eth_call") {
        result = request.params[0].data === toFunctionSelector("receiptCount()")
          ? `0x${receiptCount.toString(16).padStart(64, "0")}`
          : `0x${"0".repeat(64 * 10)}`;
      } else if (request.method === "eth_getLogs") {
        logCalls += 1;
        if (rpcLogsFail) {
          return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "log window rejected" } });
        }
        result = [];
      } else {
        throw new Error(`Unexpected RPC method: ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    }
    if (url.startsWith("https://testnet.arcscan.app/api/v2/addresses/")) {
      return Response.json(explorerBody, { status: explorerStatus });
    }
    throw new Error(`Unexpected network request: ${url}`);
  };
  try {
    await handler({ method: "GET" }, response);
    return { status, body, headers, logCalls };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("zero on-chain receipts and a successful empty explorer fallback return a readable board", async () => {
  const { status, body, logCalls } = await runHistory();
  assert.equal(status, 200, body.error);
  assert.equal(logCalls, 3, "the failed RPC window must actually exercise its retries");
  assert.equal(body.receiptCount, "0");
  assert.deepEqual(body.receipts, []);
  assert.deepEqual(body.standingBoard.agents, []);
  assert.equal(body.logFetch.historicalPages, 1);
  assert.equal(body.proofChecks.indexedReceiptCountMatchesChain, true);
  assert.equal(body.logFetch.complete, false, "the RPC failure must remain visible");
  assert.equal(body.proofChecks.logFetchComplete, false);
  assert.match(body.logFetch.warnings[0], /rpc window:/);
  assert.equal(body.proofChecks.hasX402BoundSpend, false, "empty history is not proof of a completed purchase");
});

test("empty explorer results cannot hide a missing positive on-chain receipt count", async () => {
  const { status, body, headers } = await runHistory({ receiptCount: 1n });
  assert.equal(status, 503);
  assert.equal(body.degraded, true);
  assert.match(body.error, /Float log fetch failed/);
  assert.equal(headers.get("Cache-Control"), "no-store");
});

test("zero receipt count cannot turn an explorer outage into a successful fallback", async () => {
  const { status, body } = await runHistory({ explorerStatus: 429 });
  assert.equal(status, 503);
  assert.equal(body.degraded, true);
});

test("zero receipt count cannot turn malformed explorer data into a successful empty history", async () => {
  const { status, body } = await runHistory({ explorerBody: {} });
  assert.equal(status, 503);
  assert.equal(body.degraded, true);
});

test("a successful RPC window stays readable while explorer history is unavailable", async () => {
  const { status, body } = await runHistory({ rpcLogsFail: false, explorerStatus: 503 });
  assert.equal(status, 200, body.error);
  assert.equal(body.logFetch.complete, false);
  assert.match(body.logFetch.warnings[0], /HTTP 503/);
});
