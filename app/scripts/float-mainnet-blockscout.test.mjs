import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockscoutBlock, blockscoutKey } from "./float-mainnet-blockscout.mjs";
import { parseConfig } from "./float-mainnet-preflight.mjs";

const key = "proapi_test_only";
const env = { BLOCKSCOUT_PRO_API_KEY: key };
const hash = `0x${"ab".repeat(32)}`;
const fixture = { data: { block_details: { height: 23761925, hash, timestamp: "2026-10-01T19:54:20Z" } } };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("authenticated block lookup initializes once and keeps key out of URL and returned data", async () => {
  const calls = [];
  const block = await blockscoutBlock({ chainId: 5042, blockNumber: 23761925n, env, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(url.origin, "https://mcp.blockscout.com");
    assert.equal(options.headers["Blockscout-MCP-Pro-Api-Key"], key);
    assert.equal(options.redirect, "error");
    assert.ok(!url.href.includes(key));
    if (calls.length === 1) return response({ data: { session_id: "opaque" } });
    assert.equal(url.searchParams.get("session_id"), "opaque");
    assert.equal(url.searchParams.get("chain_id"), "5042");
    return response(fixture);
  }});
  assert.equal(calls.length, 2);
  assert.equal(block.hash, hash);
  assert.ok(!JSON.stringify(block).includes("opaque"));
});

test("wrong block, invalid hash and missing initialization are refused", async () => {
  for (const body of [{}, { data: { block_details: { height: 1, hash } } }, { data: { block_details: { height: 23761925, hash: "bad" } } }]) {
    await assert.rejects(blockscoutBlock({ chainId: 5042, blockNumber: 23761925, env, fetchImpl: async url =>
      response(url.pathname.includes("unlock") ? { data: { session_id: "opaque" } } : body) }), /malformed or different block/);
  }
  await assert.rejects(blockscoutBlock({ chainId: 5042, blockNumber: 1, env, fetchImpl: async () => response({}) }), /initialization failed/);
});

test("authenticated deployments may initialize without issuing a session ID", async () => {
  const block = await blockscoutBlock({ chainId: 5042, blockNumber: 23761925, env, fetchImpl: async url => {
    if (url.pathname.includes("unlock")) return response({ data: { server_version: "test" } });
    assert.equal(url.searchParams.has("session_id"), false);
    return response(fixture);
  }});
  assert.equal(block.hash, hash);
});

test("4xx is not retried and upstream response bodies and transport exceptions cannot leak credentials", async () => {
  for (const status of [401, 403, 404, 429]) {
    let calls = 0;
    await assert.rejects(blockscoutBlock({ chainId: 5042, blockNumber: 1, env, fetchImpl: async () => {
      calls++; return response({ error: key }, status);
    }}), error => !error.message.includes(key) && error.message.includes(String(status)));
    assert.equal(calls, 1);
  }
  await assert.rejects(blockscoutBlock({ chainId: 5042, blockNumber: 1, env, fetchImpl: async () => { throw new Error(key); } }), /transport unavailable/);
});

test("transient server errors retry only to the bounded limit", async () => {
  let calls = 0;
  await assert.rejects(blockscoutBlock({ chainId: 5042, blockNumber: 1, env, fetchImpl: async () => { calls++; return response({}, 503); } }), /HTTP 503/);
  assert.equal(calls, 3);
});

test("only Arc chains and unsigned block heights can reach the network", async () => {
  for (const [chainId, blockNumber] of [[1, 1], [5042, -1], [5042, "1/path"]]) {
    await assert.rejects(blockscoutBlock({ chainId, blockNumber, env, fetchImpl: async () => { assert.fail("must not fetch"); } }));
  }
});

test("private key file rejects symlinks, open permissions, relative paths and conflicting sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-blockscout-"));
  try {
    const path = join(dir, "key");
    writeFileSync(path, key, { mode: 0o600 });
    assert.equal(blockscoutKey({ BLOCKSCOUT_PRO_API_KEY_FILE: path }), key);
    symlinkSync(path, join(dir, "link"));
    assert.throws(() => blockscoutKey({ BLOCKSCOUT_PRO_API_KEY_FILE: join(dir, "link") }), /private regular file/);
    chmodSync(path, 0o644);
    assert.throws(() => blockscoutKey({ BLOCKSCOUT_PRO_API_KEY_FILE: path }), /private regular file/);
    assert.throws(() => blockscoutKey({ BLOCKSCOUT_PRO_API_KEY_FILE: "relative" }), /absolute path/);
    assert.throws(() => blockscoutKey({ ...env, BLOCKSCOUT_PRO_API_KEY_FILE: path }), /one Blockscout/);
    assert.throws(() => blockscoutKey({}), /required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("data route never silently changes the independent source verification route", () => {
  const { config, errors } = parseConfig({ ARC_EXPLORER_DATA_ROUTE: "blockscout", FLOAT_MAINNET_EXPECTED_CHAIN_ID: "5042" });
  assert.equal(config.explorerDataRoute, "blockscout");
  assert.equal(config.verificationRoute, "explorer");
  assert.ok(!errors.some(e => e.includes("data route")));
  assert.ok(parseConfig({ ARC_EXPLORER_DATA_ROUTE: "arbitrary" }).errors.some(e => e.includes("ARC_EXPLORER_DATA_ROUTE")));
});
