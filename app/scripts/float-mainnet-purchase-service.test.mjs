import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPurchaseService } from "./float-mainnet-purchase-service.mjs";
import { initializePurchaseStore, openPurchaseStore } from "./float-mainnet-purchase-store.mjs";

const TOKEN = "a".repeat(43), ORIGIN = "https://shadow.example", BINDING = "unit-test-binding";
async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shadow-purchase-http-")), directory = join(dir, "store");
  initializePurchaseStore(directory, BINDING);
  const calls = { prepare: 0, verify: 0, accept: 0, preflight: 0, send: 0, recover: 0 };
  let payment = "unknown";
  const adapter = { assertConfiguration() {},
    async prepare(id) { calls.prepare++; return { digest: `0x${id}${id}`, typedData: { fixture: true } }; },
    async verify() { calls.verify++; }, async accept() { calls.accept++; return { receipt: true }; },
    async preflight() { calls.preflight++; }, async send() { calls.send++; payment = "paid"; },
    async status() { return { payment }; }, async recover() { calls.recover++; return { bytes: "aGVsbG8=", encoding: "base64" }; },
    ...overrides,
  };
  let service;
  async function start() {
    service = createPurchaseService({ directory, binding: BINDING, token: TOKEN, origins: [ORIGIN], catalog: { chainId: "5042002" }, adapter });
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  }
  await start();
  const call = async (path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, ...await res.json() };
  };
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { call, calls, directory, adapter, setPayment: (p) => { payment = p; }, restart: async () => { await service.close(); await start(); } };
}

test("authentication, origin, fixed enrollment inputs and durable request identity", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/v1/catalog", undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.call("/v1/catalog", undefined, { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.call("/v1/catalog?token=leak")).status, 404);
  assert.equal((await f.call("/v1/purchases", { requestId: "job-1", principal: "999999" })).status, 400);
  assert.equal((await f.call("/v1/purchases", { requestId: "../escape" })).status, 400);
  const one = await f.call("/v1/purchases", { requestId: "job-1" });
  const two = await f.call("/v1/purchases", { requestId: "job-1" });
  assert.equal(one.id, two.id); assert.equal(f.calls.prepare, 1);
  await f.restart();
  assert.equal((await f.call("/v1/purchases", { requestId: "job-1" })).digest, one.digest);
  assert.equal(f.calls.prepare, 1);
});

test("concurrent submissions, lost acknowledgement, restart and recovery pay once", async (t) => {
  const f = await fixture(t);
  f.adapter.send = async () => { f.calls.send++; f.setPayment("paid"); throw new Error("confirmation lost RPC credential=https://secret"); };
  const p = await f.call("/v1/purchases", { requestId: "one-paid-job" });
  const path = `/v1/purchases/${p.id}`;
  const replies = await Promise.all([f.call(`${path}/submit`, { signature: "0xab" }), f.call(`${path}/submit`, { signature: "0xcd" })]);
  assert.deepEqual(replies.map((r) => r.payment), ["paid", "paid"]);
  assert.equal(f.calls.send, 1); assert.equal(f.calls.accept, 1);
  assert.equal(JSON.stringify(replies).includes("signature"), false);
  await f.restart();
  assert.equal((await f.call(`${path}/submit`, { signature: "0xef" })).payment, "paid");
  assert.equal(f.calls.send, 1);
  assert.equal((await f.call(`${path}/recover`, {})).result.bytes, "aGVsbG8=");
  assert.equal((await f.call(`${path}/recover`, {})).result.bytes, "aGVsbG8=");
  assert.equal(f.calls.send, 1);
  f.setPayment("unknown");
  assert.equal((await f.call(`${path}/recover`, {})).error, "reconciliation_required");
  assert.equal(f.calls.recover, 1, "changed payment must not serve a cached result");
});

test("unknown attempt holds new purchases across restart and never resends", async (t) => {
  const f = await fixture(t);
  f.adapter.status = async () => ({ payment: "unknown", txHash: `0x${"12".repeat(32)}` });
  f.adapter.send = async () => { f.calls.send++; throw new Error("transport interrupted"); };
  const p = await f.call("/v1/purchases", { requestId: "unknown" });
  const prepared = await f.call("/v1/purchases", { requestId: "prepared-earlier" });
  const path = `/v1/purchases/${p.id}`;
  const pending = await f.call(`${path}/submit`, { signature: "0xab" });
  assert.equal(pending.payment, "unknown");
  assert.equal(pending.transactionHash, `0x${"12".repeat(32)}`);
  await f.restart();
  assert.equal((await f.call(`${path}/submit`, { signature: "0xab" })).payment, "unknown");
  assert.equal((await f.call("/v1/purchases", { requestId: "replacement" })).error, "original_payment_unresolved");
  assert.equal((await f.call(`/v1/purchases/${prepared.id}/submit`, { signature: "0xab" })).error, "original_payment_unresolved");
  assert.equal((await f.call(`${path}/recover`, {})).error, "payment_not_confirmed");
  assert.equal(f.calls.send, 1);
  f.adapter.status = async () => ({ payment: "paid", txHash: pending.transactionHash });
  assert.equal((await f.call(path)).payment, "paid");
});

test("signature, acceptance and monitor failures occur before the irreversible attempt marker", async (t) => {
  const f = await fixture(t);
  const p = await f.call("/v1/purchases", { requestId: "guarded" });
  const path = `/v1/purchases/${p.id}`;
  for (const stage of ["verify", "accept", "preflight"]) {
    const original = f.adapter[stage];
    f.adapter[stage] = async () => { throw new Error("private://secret-signature-and-path"); };
    const failed = await f.call(`${path}/submit`, { signature: "0xab" });
    assert.equal(failed.status, 503); assert.equal(failed.error, "operation_unavailable");
    assert.equal((await f.call(path)).attempted, false);
    assert.equal(f.calls.send, 0);
    f.adapter[stage] = original;
  }
  assert.equal((await f.call(`${path}/submit`, { signature: "0xab" })).payment, "paid");
});

test("provider result failure preserves paid debt and supports later result-only recovery", async (t) => {
  const f = await fixture(t);
  const p = await f.call("/v1/purchases", { requestId: "delayed-result" }), path = `/v1/purchases/${p.id}`;
  await f.call(`${path}/submit`, { signature: "0xab" });
  const recover = f.adapter.recover;
  f.adapter.recover = async () => { throw new Error("provider unavailable"); };
  assert.equal((await f.call(`${path}/recover`, {})).status, 503);
  const status = await f.call(path);
  assert.equal(status.payment, "paid"); assert.equal(status.delivery, "pending");
  f.adapter.recover = recover;
  assert.equal((await f.call(`${path}/recover`, {})).delivery, "available");
  await f.restart();
  f.adapter.recover = async () => { throw new Error("provider went offline after delivery"); };
  assert.equal((await f.call(`${path}/recover`, {})).result.bytes, "aGVsbG8=");
  const cachedPath = join(f.directory, `${p.id}.result.json`);
  const cached = JSON.parse(readFileSync(cachedPath));
  cached.result.bytes = "dGFtcGVyZWQ=";
  writeFileSync(cachedPath, JSON.stringify(cached));
  assert.equal((await f.call(`${path}/recover`, {})).status, 503);
  assert.equal(f.calls.send, 1);
});

test("missing, corrupt, changed or simultaneously opened store fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-store-")), store = join(dir, "state");
  try {
    assert.throws(() => openPurchaseStore(store, BINDING));
    initializePurchaseStore(store, BINDING);
    assert.throws(() => initializePurchaseStore(store, BINDING));
    assert.throws(() => openPurchaseStore(store, "new-enrollment"));
    const first = openPurchaseStore(store, BINDING);
    assert.throws(() => openPurchaseStore(store, BINDING));
    first.close();
    const file = join(store, "purchases.json"), body = JSON.parse(readFileSync(file));
    body.records.push({ id: "tampered" }); writeFileSync(file, JSON.stringify(body));
    assert.throws(() => openPurchaseStore(store, BINDING), /corrupt/);
    rmSync(file);
    assert.throws(() => openPurchaseStore(store, BINDING));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
