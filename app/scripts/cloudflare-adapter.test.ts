import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { runApiHandler } from "../cloudflare/request-adapter.ts";
import { apiRoutes, routeApi } from "../cloudflare/routes.ts";

test("all existing API files are routed on Pages", () => {
  const files = readdirSync(new URL("../api/", import.meta.url), { recursive: true }) as string[];
  const expected = files.filter((file) => file.endsWith(".ts")).map((file) => `/api/${file.slice(0, -3)}`).sort();
  assert.deepEqual([...apiRoutes.keys()].sort(), expected);
});

test("adapter preserves JSON body, query arrays, headers, status and payment headers", async () => {
  const request = new Request("https://shadow.example/api/test?x=1&x=2&__proto__=safe", {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8", "payment-signature": "fixture" },
    body: JSON.stringify({ amount: "1" }),
  });
  const response = await runApiHandler(request, async (req, res) => {
    assert.deepEqual(req.body, { amount: "1" });
    assert.deepEqual(req.query.x, ["1", "2"]);
    assert.equal(req.query.__proto__, "safe");
    assert.equal(req.headers["payment-signature"], "fixture");
    res.setHeader("PAYMENT-REQUIRED", "fixture-challenge");
    res.setHeader("Cache-Control", "no-store");
    res.status(402).json({ accepts: [] });
  });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("payment-required"), "fixture-challenge");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { accepts: [] });
});

test("resource URLs cannot be changed by spoofed forwarding headers", async () => {
  const response = await runApiHandler(new Request("https://shadow.example/api/test", {
    headers: { host: "wrong.example", "x-forwarded-host": "wrong.example", "x-forwarded-proto": "http" },
  }), async (req, res) => {
    assert.equal(req.headers.host, "shadow.example");
    assert.equal(req.headers["x-forwarded-host"], "shadow.example");
    assert.equal(req.headers["x-forwarded-proto"], "https");
    res.status(200).json({ ok: true });
  });
  assert.equal(response.status, 200);
});

test("legacy raw-body iteration is preserved", async () => {
  const response = await runApiHandler(new Request("https://shadow.example/api/test", { method: "POST", body: "raw fixture" }), async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += new TextDecoder().decode(chunk);
    assert.equal(raw, "raw fixture");
    assert.equal(req.body, raw);
    res.status(200).json({ ok: true });
  });
  assert.equal(response.status, 200);
});

test("invalid JSON is rejected before calling a handler", async () => {
  const response = await runApiHandler(new Request("https://shadow.example/api/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{",
  }), async () => { assert.fail("must not call handler"); });
  assert.equal(response.status, 400);
});

test("body limit is enforced on actual bytes, not the content-length header", async () => {
  const response = await runApiHandler(new Request("https://shadow.example/api/test", {
    method: "POST", headers: { "content-length": "1" }, body: "x".repeat(1_048_577),
  }), async () => { assert.fail("must not call handler"); });
  assert.equal(response.status, 413);
});

test("unexpected exceptions do not expose upstream credentials", async () => {
  const response = await runApiHandler(new Request("https://shadow.example/api/test"), async () => { throw new Error("private fixture"); });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "API request failed" });
});

test("a failed request stream returns a bounded JSON error", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error("private fixture")); } });
  const request = new Request("https://shadow.example/api/test", { method: "POST", body, duplex: "half" } as RequestInit);
  const response = await runApiHandler(request, async () => { assert.fail("must not call handler"); });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "request body could not be read" });
});

test("a handler that forgets a response fails closed", async () => {
  const response = await runApiHandler(new Request("https://shadow.example/api/test"), async () => {});
  assert.equal(response.status, 500);
});

test("HEAD responses have no body", async () => {
  const response = await runApiHandler(new Request("https://shadow.example/api/test", { method: "HEAD" }), async (_req, res) => { res.status(200).json({ ok: true }); });
  assert.equal(await response.text(), "");
});

test("unknown APIs return JSON 404, never the SPA", async () => {
  for (const path of ["/api/missing", "/api/toString", "/api/constructor"]) {
    const response = await routeApi(new Request(`https://shadow.example${path}`));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "API route not found" });
  }
});

test("all real routes retain their method guards without calling upstream services", async () => {
  for (const path of apiRoutes.keys()) {
    const response = await routeApi(new Request(`https://shadow.example${path}`, { method: "DELETE" }));
    assert.equal(response.status, 405, path);
    assert.ok(response.headers.get("allow"), path);
  }
});

test("desk alias uses the Float handler", async () => {
  const response = await routeApi(new Request("https://shadow.example/api/desk", { method: "DELETE" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});
