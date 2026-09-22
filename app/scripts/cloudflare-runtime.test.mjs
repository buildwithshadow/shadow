import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const origin = "http://127.0.0.1:8795";
const localEnvFiles = readdirSync(".").filter((name) => /^(\.env|\.dev\.vars)(\.|$)/.test(name) && name !== ".env.example");
assert.deepEqual(localEnvFiles, [], "run the credential-free rehearsal from a checkout without local environment files");
const options = { signal: AbortSignal.timeout(1000) };
let occupied = false;
try { await fetch(origin, options); occupied = true; } catch {}
assert.equal(occupied, false, `${origin} is already in use`);

// Do not inherit credentials or RPC settings from the caller into CI rehearsal.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(ARC_|FLOAT_|SHADOW_|VITE_|KV_|X402_|GATEWAY_|CIRCLE_|BANKR_|PRIVATE_KEY$|CAT_AGENT_PRIVATE_KEY$)/i.test(name)));
const child = spawn("npx", ["--yes", "wrangler@4.136.1", "pages", "dev", "dist", "--port", "8795", "--ip", "127.0.0.1"], {
  env: { ...env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs = (logs + chunk).slice(-12000); });
let spawnError;
child.on("error", (error) => { spawnError = error; });
const exited = new Promise((resolve) => child.once("close", resolve));
function stop(signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== "ESRCH") throw error; }
}

try {
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Wrangler exited ${child.exitCode}: ${logs}`);
    try { ready = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await delay(250);
  }
  assert.ok(ready, `Cloudflare runtime did not start: ${logs}`);
  for (const path of ["/", "/float", "/treasury"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /Shadow/, path);
    const asset = html.match(/src="([^\"]+\/assets\/[^\"]+|\/assets\/[^\"]+)"/);
    assert.ok(asset, `${path}: compiled script asset missing`);
    assert.equal((await fetch(new URL(asset[1], origin))).status, 200, "script asset");
  }
  const webauthn = await fetch(`${origin}/.well-known/webauthn`);
  assert.equal(webauthn.headers.get("content-type"), "application/json");
  assert.equal(webauthn.headers.get("access-control-allow-origin"), "*");
  assert.ok(Array.isArray((await webauthn.json()).origins));
  for (const route of ["float", "float-tools", "fund-smart-account", "pilot", "reasoning", "reasoning-x402", "settlements", "state", "treasury", "verify-slippage", "cctp-funding", "agent/follow-plan", "desk"]) {
    const response = await fetch(`${origin}/api/${route}`, { method: "DELETE" });
    assert.equal(response.status, 405, route);
    assert.ok(response.headers.get("allow"), route);
    assert.ok((await response.json()).error, route);
  }
  const unknown = await fetch(`${origin}/api/unknown`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get("content-type"), /application\/json/);
  const invalid = await fetch(`${origin}/api/pilot`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(invalid.status, 400);
  console.log("Cloudflare runtime passed: SPA/assets, WebAuthn headers, 13 route guards, JSON 404 and invalid-body rejection.");
} finally {
  stop("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    stop("SIGKILL");
    await exited;
  }
}
