import assert from "node:assert/strict";
import { test } from "node:test";
import { createShadowReasoningService } from "../../examples/float-mainnet-provider-server/shadow-reasoning-service.mjs";

const hash = `0x${"a".repeat(64)}`;
const packet = { intentHash: hash, decision: "skip", rationale: "sample bounded reasoning" };

test("the rehearsal adapter prepares exactly the requested Shadow packet, without an x402 charge", async () => {
  const requests = [];
  const service = createShadowReasoningService({ fetchImpl: async (url, options) => {
    requests.push({ url: url.toString(), redirect: options.redirect });
    return new Response(JSON.stringify({ configured: true, packet }), { status: 200 });
  } });
  assert.deepEqual(await service.prepare({ requestId: hash.toUpperCase().replace(/^0X/, "0x") }), {
    result: `${JSON.stringify(packet)}\n`,
    resultRef: `https://www.shadowbuild.xyz/api/reasoning?hash=${hash}`,
  });
  assert.deepEqual(requests, [{ url: `https://www.shadowbuild.xyz/api/reasoning?hash=${hash}`, redirect: "error" }]);
  assert.equal(await service.prepare({ requestId: "latest" }), null);
  assert.equal(requests.length, 1, "invalid ids never reach the upstream service");
});

test("missing packets are refused, while mismatched packets and outages remain retryable failures", async () => {
  const absent = createShadowReasoningService({ fetchImpl: async () => new Response(JSON.stringify({ configured: true, packet: null }), { status: 200 }) });
  assert.equal(await absent.prepare({ requestId: hash }), null);
  const mismatch = createShadowReasoningService({ fetchImpl: async () => new Response(JSON.stringify({ configured: true, packet: { ...packet, intentHash: `0x${"b".repeat(64)}` } }), { status: 200 }) });
  await assert.rejects(mismatch.prepare({ requestId: hash }), /malformed or mismatched packet/);
  const outage = createShadowReasoningService({ fetchImpl: async () => new Response("unavailable", { status: 503 }) });
  await assert.rejects(outage.prepare({ requestId: hash }), /status 503/);
});

test("the adapter accepts only a fixed HTTPS origin or a loopback rehearsal origin", () => {
  assert.throws(() => createShadowReasoningService({ baseUrl: "http://example.com" }), /must use HTTPS/);
  assert.throws(() => createShadowReasoningService({ baseUrl: "https://user:secret@example.com" }), /without credentials/);
  assert.doesNotThrow(() => createShadowReasoningService({ baseUrl: "http://127.0.0.1:8080" }));
});
