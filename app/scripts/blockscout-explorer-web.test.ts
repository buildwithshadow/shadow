import assert from "node:assert/strict";
import test from "node:test";
import handler from "../explorerRecovery.mjs";
import floatHandler from "../api/float.ts";
import { fetchBlockscoutExplorer } from "../blockscoutExplorer.mjs";
import { readExplorerLogPages } from "../historicalReads.js";

const key = "proapi_fixture";
const account = "0x894f6d4d3a7cFF40aeFD63Ac3794358E38a3dDc3";
const hash = `0x${"ab".repeat(32)}`;
const page = { items: [{ hash, nonce: 20, from: { hash: account }, raw_input: key }], next_page_params: null };
const url = `https://explorer.testnet.arc.io/api/v2/addresses/${account}/transactions?filter=from`;

test("server transport preserves raw data and keeps the key in a header on the fixed API", async () => {
  const result = await fetchBlockscoutExplorer(url, undefined, { chainId: 5042002, env: { BLOCKSCOUT_PRO_API_KEY: key }, fetchImpl: async (target, options) => {
    const u = new URL(String(target));
    assert.equal(u.origin, "https://api.blockscout.com");
    assert.equal(u.pathname, `/5042002/api/v2/addresses/${account}/transactions`);
    assert.equal(options?.redirect, "error");
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    assert.ok(!u.href.includes(key));
    return Response.json(page);
  }});
  assert.deepEqual(await result.json(), page);
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
  globalThis.fetch = async () => Response.json(page);
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

test("raw log pagination reaches the second page before claiming a complete history", async () => {
  let pages = 0;
  const endpoint = `/api/v2/addresses/${account}/logs`;
  const result = await readExplorerLogPages({
    url: `https://explorer.testnet.arc.io${endpoint}`,
    deadlineAt: Date.now() + 5000,
    fetchPage: (target, init) => fetchBlockscoutExplorer(String(target), init, { chainId: 5042002, env: { BLOCKSCOUT_PRO_API_KEY: key }, fetchImpl: async input => {
      const u = new URL(String(input)); pages++;
      if (pages === 1) return Response.json({ items: [{ index: 2, data: "0x1234" }], next_page_params: { block_number: 1, index: 2 } });
      assert.equal(u.searchParams.get("block_number"), "1");
      assert.equal(u.searchParams.get("index"), "2");
      return Response.json({ items: [{ index: 1, data: "0x5678" }], next_page_params: null });
    } }),
  });
  assert.equal(result.pages, 2);
  assert.deepEqual(result.items, [{ index: 2, data: "0x1234" }, { index: 1, data: "0x5678" }]);
  assert.deepEqual(result.warnings, []);
});

test("truncated log data cannot become a successful empty or complete history", async () => {
  await assert.rejects(fetchBlockscoutExplorer(`https://explorer.testnet.arc.io/api/v2/addresses/${account}/logs`, undefined, {
    chainId: 5042002, env: { BLOCKSCOUT_PRO_API_KEY: key }, fetchImpl: async target => Response.json({ items: [{ data: "0x", data_truncated: true }] }),
  }), /truncated/);
});

test("public recovery preserves and forwards the full supported transaction cursor", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BLOCKSCOUT_PRO_API_KEY;
  process.env.BLOCKSCOUT_PRO_API_KEY = key;
  const next = { index: 185, value: "1400000000000000000000", hash, inserted_at: "2021-10-19T04:21:43.201751Z", block_number: 12495947, fee: "0", items_count: 50 };
  let calls = 0; let status = 0; let data: any;
  globalThis.fetch = async input => {
    calls++;
    if (calls === 2) {
      const params = new URL(String(input)).searchParams;
      for (const [name, value] of Object.entries(next)) assert.equal(params.get(name), String(value));
    }
    return Response.json({ ...page, next_page_params: calls === 1 ? next : null });
  };
  const res = { setHeader() {}, status(code: number) { status = code; return this; }, json(value: unknown) { data = value; } };
  try {
    await handler({ method: "GET", query: { chainId: "5042002", account, index: "99" } }, res);
    assert.equal(status, 200);
    assert.deepEqual(data.next_page_params, next);
    const cursor = Object.fromEntries(Object.entries(next).map(([name, value]) => [name, String(value)]));
    await handler({ method: "GET", query: { chainId: "5042002", account, ...cursor } }, res);
    assert.equal(status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BLOCKSCOUT_PRO_API_KEY;
    else process.env.BLOCKSCOUT_PRO_API_KEY = originalKey;
  }
});
