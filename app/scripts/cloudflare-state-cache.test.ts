import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { onRequest } from "../functions/api/[[path]].ts";
import { routeApi } from "../cloudflare/routes.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function stateFixture(t: TestContext) {
  const env = {
    ARC_RPC_URL: "https://state-rpc.example.test",
    SHADOW_ROUTER: `0x${"1".repeat(40)}`,
    SHADOW_AMM: `0x${"2".repeat(40)}`,
    SHADOW_REGISTRY: `0x${"3".repeat(40)}`,
    SHADOW_START_BLOCK: "0",
    KV_REST_API_URL: "https://state-kv.example.test",
    KV_REST_API_TOKEN: "test-fixture-only",
  };
  const previous = Object.entries(env).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, env);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const writeStarted = deferred<void>();
  const finishWrite = deferred<Response>();
  let cached: string | null = null;
  let rpcReads = 0;
  let writeSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(env.KV_REST_API_URL + "/get/")) {
      return Response.json({ result: url.endsWith("state%3Acache%3Av2") ? cached : null });
    }
    if (url.startsWith(env.KV_REST_API_URL + "/set/state%3Acache%3Av2?")) {
      writeSignal = init?.signal;
      assert.ok(writeSignal, "cache writes must have an abort deadline");
      const signal = writeSignal;
      writeStarted.resolve();
      const response = await Promise.race([
        finishWrite.promise,
        new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
      if (response.ok) cached = String(init?.body);
      return response;
    }
    assert.equal(url, env.ARC_RPC_URL + "/", "unexpected external request");
    rpcReads++;
    const request = JSON.parse(String(init?.body));
    let result: unknown;
    if (request.method === "eth_call") result = `0x${"0".repeat(64)}`;
    else if (request.method === "eth_blockNumber") result = "0x0";
    else if (request.method === "eth_getLogs") result = [];
    else assert.fail(`unexpected RPC method: ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  return {
    writeStarted: writeStarted.promise,
    finishWrite: finishWrite.resolve,
    rpcReads: () => rpcReads,
    writeSignal: () => writeSignal,
  };
}

test("Pages keeps a delayed real state-cache refresh alive and serves it on the next request", { timeout: 5000 }, async (t) => {
  const fixture = stateFixture(t);
  const pending: Promise<unknown>[] = [];
  const context = {
    request: new Request("https://shadow.example/api/state?force=1"),
    waitUntil(promise: Promise<unknown>) {
      assert.equal(this, context, "Pages context must retain its method receiver");
      pending.push(promise);
    },
  };
  try {
    const response = await onRequest(context);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, "live");
    assert.equal(pending.length, 1, "the real handler must register its outstanding KV write");
    const reads = fixture.rpcReads();
    assert.ok(reads > 0);
    fixture.finishWrite(Response.json({ result: "OK" }));
    await Promise.all(pending);
    const cached = await onRequest({ ...context, request: new Request("https://shadow.example/api/state") });
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).source, "cache");
    assert.equal(fixture.rpcReads(), reads, "a stored snapshot avoids another RPC scan");
  } finally {
    fixture.finishWrite(Response.json({ result: "OK" }));
    await Promise.all(pending);
  }
});

test("legacy requests await the delayed cache refresh when no lifetime hook is provided", { timeout: 5000 }, async (t) => {
  const fixture = stateFixture(t);
  let finished = false;
  const response = routeApi(new Request("https://shadow.example/api/state?force=1")).then((value) => {
    finished = true;
    return value;
  });
  try {
    await fixture.writeStarted;
    await flush();
    assert.equal(finished, false, "legacy runtime must not return while the cache write can be dropped");
    fixture.finishWrite(Response.json({ result: "OK" }));
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal((await result.json()).source, "live");
  } finally {
    fixture.finishWrite(Response.json({ result: "OK" }));
    await response;
  }
});

test("a failed background cache refresh preserves the successful fresh response", { timeout: 5000 }, async (t) => {
  const fixture = stateFixture(t);
  const warnings = t.mock.method(console, "warn", () => {});
  const pending: Promise<unknown>[] = [];
  try {
    const response = await onRequest({
      request: new Request("https://shadow.example/api/state?force=1"),
      waitUntil(promise) { pending.push(promise); },
    });
    assert.equal(response.status, 200);
    fixture.finishWrite(new Response("unavailable", { status: 503 }));
    await Promise.all(pending);
    assert.equal((await response.json()).source, "live");
    assert.equal(warnings.mock.callCount(), 1);
  } finally {
    fixture.finishWrite(Response.json({ result: "OK" }));
    await Promise.all(pending);
  }
});

test("an unavailable KV store cannot hold a legacy response past the cache-write deadline", { timeout: 5000 }, async (t) => {
  const fixture = stateFixture(t);
  const warnings = t.mock.method(console, "warn", () => {});
  // Keep Node alive while its unreferenced AbortSignal timer drives the timeout.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const response = await routeApi(new Request("https://shadow.example/api/state?force=1"));
    assert.equal(fixture.writeSignal()?.aborted, true);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, "live");
    assert.equal(warnings.mock.callCount(), 1);
  } finally {
    clearInterval(keepAlive);
    fixture.finishWrite(Response.json({ result: "OK" }));
  }
});
