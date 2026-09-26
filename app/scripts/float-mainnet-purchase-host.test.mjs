import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPersistentPaths, hostCommands, supervise } from "./float-mainnet-purchase-host.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "shadow-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
async function until(check) {
  const limit = Date.now() + 5000;
  while (!check()) { if (Date.now() > limit) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); }
}
test("hosting refuses missing state and symlinks escaping the declared persistent directory", (t) => {
  const root = fixture(t), mount = join(root, "mount"), outside = join(root, "outside");
  mkdirSync(mount); writeFileSync(outside, "private"); writeFileSync(join(mount, "config"), "{}");
  assertPersistentPaths(mount, [join(mount, "config")]);
  symlinkSync(outside, join(mount, "escape"));
  assert.throws(() => assertPersistentPaths(mount, [join(mount, "escape")]), /inside/);
  assert.throws(() => assertPersistentPaths(mount, [join(mount, "missing")]));
  assert.equal(existsSync(join(mount, "missing")), false);
  assert.throws(() => assertPersistentPaths("/", [outside]), /dedicated/);
});
test("monitor receives no signer, bearer token or injected Node options", () => {
  const config = { spec: { monitorBaseline: "/disk/baseline", manifest: "/disk/manifest", monitorStateDir: "/disk/monitor" } };
  const [monitor, api] = hostCommands(config, "/disk/config", 12345, { PATH: "/bin", ARC_RPC_URL: "https://rpc.example", FLOAT_EXECUTOR_PRIVATE_KEY: "executor-secret", SHADOW_PURCHASE_TOKEN: "token-secret", FLOAT_SPONSOR_PRIVATE_KEY: "owner-secret", NODE_OPTIONS: "--require injected" });
  assert.deepEqual(Object.keys(monitor.env).sort(), ["ARC_RPC_URL", "FLOAT_MAINNET_EXPECTED_CHAIN_ID", "PATH"]);
  assert.equal(api.env.FLOAT_EXECUTOR_PRIVATE_KEY, "executor-secret");
  assert.equal(api.env.NODE_OPTIONS, undefined); assert.equal(api.env.FLOAT_SPONSOR_PRIVATE_KEY, undefined);
  assert.equal(JSON.stringify([monitor.args, api.args]).includes("secret"), false);
  assert.deepEqual(api.args.slice(-2), ["--host", "0.0.0.0"]);
});
test("unexpected child exit stops its sibling and returns failure", async (t) => {
  const root = fixture(t), ready = join(root, "ready"), stopped = join(root, "stopped"), signals = new EventEmitter();
  const pending = supervise([
    { args: ["-e", `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); process.on('SIGTERM',()=>{ fs.writeFileSync(${JSON.stringify(stopped)},'stopped'); process.exit(0); }); setInterval(()=>{},100);`], env: {}, stdio: "ignore" },
    { args: ["-e", `const fs=require('fs'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)}))process.exit(7)},10);`], env: {}, stdio: "ignore" },
  ], { shutdownMs: 1000, signals });
  assert.equal(await pending, 1); assert.equal(existsSync(stopped), true);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
test("requested shutdown drains a child, and a stuck child is killed within the bound", async (t) => {
  const root = fixture(t);
  for (const stuck of [false, true]) {
    const ready = join(root, `ready-${stuck}`), signals = new EventEmitter();
    const pending = supervise([{ args: ["-e", `const fs=require('fs');process.on('SIGTERM',()=>{${stuck ? "" : "setTimeout(()=>process.exit(0),30)"}});fs.writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},100);`], env: {}, stdio: "ignore" }], { shutdownMs: 100, signals });
    await until(() => existsSync(ready)); signals.emit("SIGTERM");
    assert.equal(await pending, stuck ? 1 : 0);
  }
});

test("graceful shutdown lets a parent drain its active subprocess without signaling that subprocess", async (t) => {
  const root = fixture(t), ready = join(root, "grandchild-ready"), done = join(root, "grandchild-done"), terminated = join(root, "grandchild-signaled");
  const grandchild = `const fs=require('fs'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(terminated)},'1');process.exit(1)}); fs.writeFileSync(${JSON.stringify(ready)},'1');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},'1');process.exit(0)},300);`;
  const parent = `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); process.on('SIGTERM',()=>{}); child.on('exit',code=>process.exit(code));`;
  const signals = new EventEmitter();
  const pending = supervise([{ args: ["-e", parent], env: {}, stdio: "ignore" }], { shutdownMs: 2000, signals });
  await until(() => existsSync(ready)); signals.emit("SIGTERM");
  assert.equal(await pending, 0); assert.equal(existsSync(done), true); assert.equal(existsSync(terminated), false);
});
