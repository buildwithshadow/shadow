import assert from "node:assert/strict";
import { test } from "node:test";
import handler from "../api/reasoning-x402.ts";

const hash = `0x${"a".repeat(64)}`;
const packet = { intentHash: hash, decision: "publish", rationale: "fresh packet" };

function response() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    body: null,
    setHeader(name, value) { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; },
  };
}

test("x402 never advertises a charge for an expired or unavailable reasoning packet", async () => {
  const oldFetch = globalThis.fetch;
  const names = ["X402_PAY_TO", "X402_FACILITATOR_PRIVATE_KEY", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const values = new Map([["latestReasoningIntentHash", hash]]);
  const requests = [];
  try {
    process.env.X402_PAY_TO = "0x8ddf06fE8985988d3e0883F945E891BD57084937";
    process.env.X402_FACILITATOR_PRIVATE_KEY = `0x${"1".repeat(64)}`;
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "test-only-token";
    globalThis.fetch = async (url) => {
      const key = decodeURIComponent(new URL(url).pathname.slice("/get/".length));
      requests.push(key);
      return { ok: true, json: async () => ({ result: values.get(key) ?? null }) };
    };

    const stale = response();
    await handler({ method: "GET", url: "/api/reasoning-x402" }, stale);
    assert.equal(stale.statusCode, 404);
    assert.equal(stale.body.intentHash, hash);
    assert.equal(requests.includes(`reasoning:${hash}`), true);
    assert.equal(stale.headers["X-PAYMENT-RESPONSE"], undefined);

    const count = requests.length;
    const invalid = response();
    await handler({ method: "GET", url: "/api/reasoning-x402?hash=not-a-digest" }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(requests.length, count, "malformed public requests never query KV");

    values.set(`reasoning:${hash}`, JSON.stringify(packet));
    const available = response();
    await handler({ method: "GET", url: "/api/reasoning-x402" }, available);
    assert.equal(available.statusCode, 402);
    assert.equal(available.body.accepts[0].maxAmountRequired, "1000");

    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "upstream unavailable" });
    const outage = response();
    await handler({ method: "GET", url: "/api/reasoning-x402", headers: { "x-payment": "invalid" } }, outage);
    assert.equal(outage.statusCode, 503);
    assert.equal(outage.headers["X-PAYMENT-RESPONSE"], undefined);
  } finally {
    globalThis.fetch = oldFetch;
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
});
