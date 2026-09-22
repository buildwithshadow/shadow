import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { cachedHistoricalRead, readBeforeDeadline, readExplorerLogPages } from "../historicalReads.js";

for (const label of ["transaction", "transaction logs"]) {
  test(`${label} transient errors are shared, evicted, and retried in a warm worker`, async () => {
    const cache = new Map();
    let calls = 0;
    const read = async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP 429");
      return label === "transaction" ? { raw_input: "0x1234" } : [{ index: 1 }];
    };
    const first = cachedHistoricalRead(cache, "tx", read);
    const concurrent = cachedHistoricalRead(cache, "tx", read);
    assert.equal(first, concurrent);
    const results = await Promise.allSettled([first, concurrent]);
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(cache.has("tx"), false);
    const value = await cachedHistoricalRead(cache, "tx", read);
    assert.ok(value);
    assert.equal(await cachedHistoricalRead(cache, "tx", read), value);
    assert.equal(calls, 2);
  });
}

test("an expired deadline does not start another read", async () => {
  let calls = 0;
  await assert.rejects(readBeforeDeadline(() => { calls += 1; }, Date.now() - 1, "expired"), /expired/);
  assert.equal(calls, 0);
});

test("a later slow explorer page cannot reset the overall crawl deadline", async () => {
  const firstPage = { transaction_hash: "0xabc", index: 1 };
  const signals = [];
  const urls = [];
  const started = Date.now();
  const result = await readExplorerLogPages({
    url: "https://explorer.example/logs",
    deadlineAt: started + 80,
    fetchPage: async (url, { signal }) => {
      signals.push(signal);
      urls.push(url);
      if (urls.length === 1) {
        await delay(30);
        return { ok: true, json: async () => ({ items: [firstPage], next_page_params: { index: 1 } }) };
      }
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  assert.deepEqual(result.items, [firstPage]);
  assert.equal(result.pages, 1);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1], "all pages must share one deadline and cancellation signal");
  assert.equal(signals[1].aborted, true);
  assert.match(result.warnings[0], /deadline exceeded/);
  assert.ok(Date.now() - started < 500, "return the accumulated data before a fresh per-page timeout");
  assert.equal(urls[1], "https://explorer.example/logs?index=1");
});

test("the crawl deadline also bounds a stalled response body", async () => {
  const result = await readExplorerLogPages({
    url: "https://explorer.example/logs",
    deadlineAt: Date.now() + 20,
    fetchPage: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  });
  assert.equal(result.pages, 0);
  assert.deepEqual(result.items, []);
  assert.match(result.warnings[0], /deadline exceeded/);
});

test("a late response that ignores abort cannot mutate returned partial results", async () => {
  let completeBody;
  const result = await readExplorerLogPages({
    url: "https://explorer.example/logs",
    deadlineAt: Date.now() + 20,
    fetchPage: async () => ({ ok: true, json: () => new Promise((resolve) => { completeBody = resolve; }) }),
  });
  completeBody({ items: [{ index: 1 }] });
  await delay(0);
  assert.deepEqual(result.items, []);
  assert.equal(result.pages, 0);
});

test("a complete empty explorer answer differs from an invalid or failed answer", async () => {
  const read = (response) => readExplorerLogPages({
    url: "https://explorer.example/logs", deadlineAt: Date.now() + 1_000, fetchPage: async () => response,
  });
  const empty = await read({ ok: true, json: async () => ({ items: [], next_page_params: null }) });
  assert.deepEqual(empty, { items: [], pages: 1, warnings: [] });
  const invalid = await read({ ok: true, json: async () => ({}) });
  assert.match(invalid.warnings[0], /invalid explorer log response/);
  const failed = await read({ ok: false, status: 429 });
  assert.match(failed.warnings[0], /HTTP 429/);
});

test("the explorer page cap retains data but never reports a complete history", async () => {
  const result = await readExplorerLogPages({
    url: "https://explorer.example/logs", deadlineAt: Date.now() + 1_000, maxPages: 2,
    fetchPage: async () => ({ ok: true, json: async () => ({ items: [{ index: 1 }], next_page_params: { index: 2 } }) }),
  });
  assert.equal(result.pages, 2);
  assert.equal(result.items.length, 2);
  assert.match(result.warnings[0], /2 page cap/);
});
