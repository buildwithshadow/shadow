import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadPurchaseConfiguration } from "./float-mainnet-purchase-adapter.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

// Require pre-provisioned state on the operator's persistent mount. This does
// not initialize a store, remove stale locks, or restore an old ledger.
export function assertPersistentPaths(root, paths) {
  root = realpathSync(root);
  if (root === sep) throw new Error("persistent root must be a dedicated directory");
  for (const path of paths) {
    const rel = relative(root, realpathSync(path));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("state must remain inside the persistent directory");
  }
}

// A managed service cannot attach one disk to separate API/monitor services.
// Keep both on this instance, with distinct environments and process groups.
// No automatic child restart: a crash requires preserved-state investigation.
export function supervise(commands, { shutdownMs = 240_000, signals = process } = {}) {
  if (!commands.length) throw new Error("at least one process required");
  return new Promise((resolve) => {
    const live = new Set(); let stopping = false, exitCode = 0, timer;
    const kill = (child, signal) => {
      try { process.kill(-child.pid, signal); } catch { /* already exited */ }
    };
    const finish = () => {
      if (live.size) return;
      clearTimeout(timer); signals.off("SIGTERM", halt); signals.off("SIGINT", halt); resolve(exitCode);
    };
    const stop = (code) => {
      if (stopping) return;
      stopping = true; exitCode = code;
      // Let parents drain their active subprocesses. Only the deadline kills
      // whole groups; sending SIGTERM to groups would interrupt live sends.
      for (const child of live) child.kill("SIGTERM");
      timer = setTimeout(() => { exitCode = 1; for (const child of live) kill(child, "SIGKILL"); }, shutdownMs);
      finish();
    };
    const halt = () => stop(0);
    signals.once("SIGTERM", halt); signals.once("SIGINT", halt);
    for (const command of commands) {
      const child = spawn(process.execPath, command.args, { env: command.env, detached: true, stdio: command.stdio ?? "inherit" });
      live.add(child);
      child.once("error", () => { live.delete(child); stop(1); finish(); });
      child.once("exit", (code, signal) => {
        if (stopping && code !== 0 && signal !== "SIGTERM") exitCode = 1;
        // Terminate grandchildren even if their direct parent exited first.
        kill(child, "SIGKILL"); live.delete(child); stop(1); finish();
      });
    }
  });
}

export function hostCommands(config, configPath, port, env = process.env) {
  const script = (name) => fileURLToPath(new URL(`./float-mainnet-${name}.mjs`, import.meta.url));
  const base = { PATH: env.PATH ?? "/usr/bin:/bin", ARC_RPC_URL: env.ARC_RPC_URL, FLOAT_MAINNET_EXPECTED_CHAIN_ID: "5042002" };
  return [
    { args: [script("monitor-runner"), "loop", "--baseline", config.spec.monitorBaseline, "--manifest", config.spec.manifest, "--state-dir", config.spec.monitorStateDir], env: base },
    { args: [script("purchase-server"), "serve", "--config", configPath, "--port", String(port), "--host", "0.0.0.0"],
      env: { ...base, FLOAT_EXECUTOR_PRIVATE_KEY: env.FLOAT_EXECUTOR_PRIVATE_KEY, SHADOW_PURCHASE_TOKEN: env.SHADOW_PURCHASE_TOKEN } },
  ];
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: "string" }, "persistent-root": { type: "string" }, port: { type: "string", default: process.env.PORT ?? "8788" } } });
  if (!values.config || !values["persistent-root"] || !/^\d+$/.test(values.port) || Number(values.port) < 1024 || Number(values.port) > 65535) throw new Error("invalid host arguments");
  const path = realpathSync(values.config), config = loadPurchaseConfiguration(path);
  assertPersistentPaths(values["persistent-root"], [path, config.spec.session, config.spec.manifest, config.spec.monitorBaseline, config.spec.monitorStateDir, config.spec.storeDir, config.policy.ledgerDirectory]);
  return supervise(hostCommands(config, path, values.port));
}
if (isEntrypoint(import.meta)) main().then((code) => { process.exitCode = code; }, () => {
  console.error("Hosted purchase service could not start; inspect access and preserved state. Credentials are not printed."); process.exitCode = 1;
});
