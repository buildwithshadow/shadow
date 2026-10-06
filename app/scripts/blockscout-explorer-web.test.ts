import assert from "node:assert/strict";
import test from "node:test";
import handler from "../explorerRecovery.ts";
import floatHandler from "../api/float.ts";
import { fetchBlockscoutExplorer } from "../blockscoutExplorer.mjs";
import { readExplorerLogPages } from "../historicalReads.js";

const key = "proapi_fixture";
const account = "0x894f6d4d3a7cFF40aeFD63Ac3794358E38a3dDc3";
const hash = `0x${"ab".repeat(32)}`;
const page = { items: [{ hash, nonce: 20, from: { hash: account }, raw_input: key }], next_page_params: null };
const url = `https://explorer.testnet.arc.io/api/v2/addresses/${account}/transactions?filter=from`;

test("server transport uses the fixed authenticated service and optional sessions", async () => {
  for (const session of [{}, { session_id: "opaque" }]) {
    const result = await fetchBlockscoutExplorer(url, undefined, { chainId: 5042002, env: { BLOCKSCOUT_PRO_API_KEY: key }, fetchImpl: async (target, options) => {
      const u = new URL(String(target));
      assert.equal(u.origin, "https://mcp.blockscout.com");
      assert.equal(options?.redirect, "error");
      assert.equal((options?.headers as Record<string, string>)["Blockscout-MCP-Pro-Api-Key"], key);
      assert.ok(!u.href.includes(key));
      if (u.pathname.includes("unlock")) return Response.json({ data: session });
      assert.equal(u.searchParams.has("session_id"), "session_id" in session);
      return Response.json({ data: page });
    }});
    assert.deepEqual(await result.json(), page);
  }
});

test("untrusted hosts, paths, network mismatches and missing keys never fetch", async () => {
  for (const [target, chainId] of [["https://evil.example/api/v2/addresses/"+account+"/transactions",5042002], [url,5042], [url.replace("/transactions", "/raw-trace"),5042002]] as const) {
    await assert.rejects(fetchBlockscoutExplorer(target, undefined, { chainId, env: { BLOCKSCOUT_PRO_API_KEY: key }, fetchImpl: async () => { assert.fail("must not fetch"); } }));
  }
  await assert.rejects(fetchBlockscoutExplorer(url, undefined, { chainId: 5042002, env: {} }), /credentials unavailable/);
});

test("upstream errors and invalid responses do not expose credential-bearing details", async () => {
  for (const status of [401,403,429,503]) {
    let calls = 0;
    await assert.rejects(fetchBlockscoutExplorer(url, undefined, { chainId: 5042002, env: { BLOCKSCOUT_PRO_API_KEY: key }, fetchImpl: async () => {
      calls++; return Response.json({ error: key }, { status });
    }}), error => error instanceof Error && !error.message.includes(key) && error.message.includes(String(status)));
    assert.equal(calls, status >= 500 ? 3 : 1);
  }
  await assert.rejects(fetchBlockscoutExplorer(url, undefined, { chainId: 5042002, env: { BLOCKSCOUT_PRO_API_KEY: key }, fetchImpl: async () => { throw new Error(key); } }), /upstream unavailable/);
});

test("public recovery endpoint returns only transaction suggestions and refuses malformed cursors", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BLOCKSCOUT_PRO_API_KEY;
  process.env.BLOCKSCOUT_PRO_API_KEY = key;
  globalThis.fetch = async input => Response.json({ data: String(input).includes("unlock") ? {} : page });
  let status = 0; let data: any;
  const res = { setHeader() {}, status(code: number) { status=code; return this; }, json(value: unknown) { data=value; } };
  try {
    await handler({ method: "GET", query: { chainId: "5042002", account } }, res);
    assert.equal(status, 200);
    assert.deepEqual(data.items, [{ hash, nonce: 20, from: { hash: account } }]);
    assert.ok(!JSON.stringify(data).includes(key));
    await handler({ method: "GET", query: { chainId: "5042002", account, endpoint: "evil" } }, res);
    assert.equal(status,400);
    await handler({ method: "GET", query: { chainId: "5042002", account, index: "-1" } }, res);
    assert.equal(status,400);
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey === undefined) delete process.env.BLOCKSCOUT_PRO_API_KEY;
    else process.env.BLOCKSCOUT_PRO_API_KEY=originalKey;
  }
});

test("public endpoint retains unavailable status when no server credential exists", async () => {
  const originalKey = process.env.BLOCKSCOUT_PRO_API_KEY;
  delete process.env.BLOCKSCOUT_PRO_API_KEY;
  let status=0; let data: any;
  const res = { setHeader() {}, status(code:number) {status=code;return this;},json(value:unknown){data=value;} };
  try {
    await handler({method:"GET",query:{chainId:"5042",account}},res);
    assert.equal(status,503);
    assert.match(data.error,/original operation pending/);
  } finally { if(originalKey!==undefined)process.env.BLOCKSCOUT_PRO_API_KEY=originalKey; }
});

test("existing Float function dispatches the recovery rewrite before legacy configuration reads", async () => {
  const originalKey = process.env.BLOCKSCOUT_PRO_API_KEY;
  delete process.env.BLOCKSCOUT_PRO_API_KEY;
  let status = 0; let data: any;
  const res = { setHeader() {}, status(code: number) { status = code; return this; }, json(value: unknown) { data = value; } };
  try {
    await floatHandler({ method: "GET", url: `/api/float?mode=explorer&chainId=5042&account=${account}` }, res);
    assert.equal(status, 503);
    assert.match(data.error, /original operation pending/);
  } finally { if (originalKey !== undefined) process.env.BLOCKSCOUT_PRO_API_KEY = originalKey; }
});

test("MCP log continuation reaches the second page before claiming a complete history", async () => {
  let pages = 0;
  const endpoint = `/api/v2/addresses/${account}/logs`;
  const result = await readExplorerLogPages({
    url: `https://explorer.testnet.arc.io${endpoint}`,
    deadlineAt: Date.now() + 5000,
    fetchPage: (target, init) => fetchBlockscoutExplorer(String(target), init, { chainId: 5042002, env: { BLOCKSCOUT_PRO_API_KEY: key }, fetchImpl: async input => {
      const u = new URL(String(input));
      if (u.pathname.includes("unlock")) return Response.json({ data: {} });
      pages++;
      if (pages === 1) return Response.json({ data: { items: [{ index: 2 }] }, pagination: { next_call: {
        tool_name: "direct_api_call", params: { chain_id: "5042002", endpoint_path: endpoint, cursor: "next_page" },
      } } });
      assert.equal(u.searchParams.get("cursor"), "next_page");
      assert.equal(u.searchParams.has("query_params[mcp_cursor]"), false);
      return Response.json({ data: { items: [{ index: 1 }], next_page_params: null } });
    } }),
  });
  assert.equal(result.pages, 2);
  assert.deepEqual(result.items, [{ index: 2 }, { index: 1 }]);
  assert.deepEqual(result.warnings, []);
});
