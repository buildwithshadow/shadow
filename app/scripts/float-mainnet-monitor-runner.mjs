import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";
import { canonicalJson, digestJson, evaluateSnapshot, validateBaseline } from "./float-mainnet-monitor-policy.mjs";

const MONITOR = fileURLToPath(new URL("./float-mainnet-monitor.mjs", import.meta.url));
const alert = (code, detail) => ({ code, severity: "critical", detail });
function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${canonicalJson(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
  finally { rmSync(temporary, { force: true }); }
}
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function optionalJson(path) { return existsSync(path) ? readJson(path) : null; }
function acquire(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, "runner.lock");
  let fd;
  try { fd = openSync(path, "wx", 0o600); } catch { throw new Error("runner lock exists; inspect the process before recovering a stale lock"); }
  try { writeFileSync(fd, canonicalJson({ pid: process.pid, startedAt: new Date().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
  return () => rmSync(path);
}
export function loadContext({ baselinePath, manifestPath, stateDir, indexPath }) {
  const baseline = validateBaseline(readJson(baselinePath));
  const rawManifest = readFileSync(manifestPath);
  const manifest = JSON.parse(rawManifest);
  if (manifest.ok !== true) throw new Error("manifest must have ok:true");
  return { baseline, baselineHash: digestJson(baseline), manifestHash: createHash("sha256").update(rawManifest).digest("hex"), manifestPath: resolve(manifestPath), stateDir: resolve(stateDir), indexPath: indexPath ? resolve(indexPath) : undefined };
}
function identity(context) {
  const { baseline, baselineHash, manifestHash } = context;
  return { schemaVersion: 1, kind: "shadow-monitor-heartbeat", chainId: baseline.identity.chainId,
    address: baseline.identity.address, runtimeCodeHash: baseline.identity.runtimeCodeHash, baselineHash, manifestHash };
}
const paths = (context) => Object.fromEntries(["heartbeat", "snapshot", "hold", "events"].map((name) => [name, resolve(context.stateDir, `${name}.json`)]));
function event(context, record) {
  // Bounded local journal; no webhooks, email, signing keys or scheduler install.
  const path = paths(context).events;
  const history = optionalJson(path) ?? [];
  if (!Array.isArray(history)) throw new Error("local event journal is malformed");
  atomicJson(path, [...history.slice(-199), record]);
}
function latch(context, alerts, nowMs) {
  const path = paths(context).hold;
  if (!existsSync(path)) atomicJson(path, { incidentId: randomUUID(), createdAt: new Date(nowMs).toISOString(), baselineHash: context.baselineHash, alerts });
  return readJson(path);
}

// This subprocess is read-only and has a hard wall-time/output bound. A killed
// scan never yields a partial healthy snapshot. No keys reach its environment.
export async function collectSnapshot(context, { rpcUrl = process.env.ARC_RPC_URL } = {}) {
  if (!rpcUrl) throw new Error("ARC_RPC_URL required");
  const { baseline: b } = context;
  const args = [MONITOR, "snapshot", "--manifest", context.manifestPath, "--warn-before", String(b.policy.warnBeforeSeconds), "--max-index-lag", String(b.policy.maxIndexLagSeconds), "--executor-from-block", b.executor.fromBlock];
  if (context.indexPath) args.push("--index", context.indexPath);
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ARC_RPC_URL: rpcUrl, FLOAT_MAINNET_EXPECTED_CHAIN_ID: b.identity.chainId }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let bytes = 0; let stopped = false;
    const kill = () => { stopped = true; child.kill("SIGKILL"); };
    const timer = setTimeout(kill, b.policy.runTimeoutMs);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) kill(); else output += chunk; });
    child.stderr.on("data", (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) kill(); });
    child.on("error", () => { clearTimeout(timer); reject(new Error("monitor process could not start")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped) return reject(new Error("monitor exceeded time or output bound"));
      try {
        const result = JSON.parse(output);
        if ((code !== 0 && code !== 1) || result.error || !result.observedAt) throw new Error("no complete snapshot");
        resolveResult(result); // Structured policy still inspects every warning.
      } catch { reject(new Error("monitor failed before a complete canonical snapshot")); }
    });
  });
}

export function heartbeatStatus(context, nowMs = Date.now()) {
  const common = identity(context);
  try {
    const heartbeat = optionalJson(paths(context).heartbeat);
    if (!heartbeat) return { ...common, ok: false, hold: true, status: "missing", alerts: [alert("HEARTBEAT_MISSING", "no completed monitor heartbeat")] };
    const alerts = [];
    for (const key of Object.keys(common)) if (heartbeat[key] !== common[key]) alerts.push(alert("HEARTBEAT_BINDING_MISMATCH", `${key} differs from the selected baseline/release`));
    const time = Date.parse(heartbeat.completedAt);
    const start = Date.parse(heartbeat.startedAt);
    if (!Number.isFinite(time) || !Number.isFinite(start) || time < start || time > nowMs || nowMs - time > context.baseline.policy.maxHeartbeatAgeMs || nowMs - start > context.baseline.policy.maxHeartbeatAgeMs) alerts.push(alert("HEARTBEAT_STALE", "monitor completion is absent, stale or has invalid timestamps"));
    if (heartbeat.status !== "healthy" || heartbeat.checks?.snapshotHealthy !== true) alerts.push(alert("HEARTBEAT_NOT_HEALTHY", "latest cycle is not a completed healthy policy result"));
    if (heartbeat.status === "checking") alerts.push(alert("CHECK_IN_PROGRESS", "a fresh complete check is not available"));
    const snapshot = optionalJson(paths(context).snapshot);
    if (!snapshot || digestJson(snapshot) !== heartbeat.snapshotHash) alerts.push(alert("SNAPSHOT_BINDING_MISMATCH", "persisted snapshot is missing or does not match the heartbeat"));
    else alerts.push(...evaluateSnapshot(context.baseline, snapshot, nowMs).alerts);
    const hold = optionalJson(paths(context).hold);
    if (hold) alerts.push(alert("HOLD_LATCHED", `incident ${hold.incidentId} needs explicit local acknowledgement`));
    if (heartbeat.ok !== true || heartbeat.hold !== false) alerts.push(...(Array.isArray(heartbeat.alerts) ? heartbeat.alerts : [alert("HEARTBEAT_INVALID", "heartbeat has no alert policy result")]));
    const healthy = alerts.length === 0 && heartbeat.ok === true && heartbeat.hold === false;
    return { ...heartbeat, checkedAt: new Date(nowMs).toISOString(), ok: healthy, hold: !healthy, status: healthy ? "healthy" : "hold", alerts };
  } catch { return { ...common, ok: false, hold: true, status: "hold", alerts: [alert("LOCAL_STATE_INVALID", "heartbeat, snapshot or local hold is unreadable/malformed")] }; }
}

export async function runMonitorOnce(context, { collect = collectSnapshot, now = Date.now } = {}) {
  const release = acquire(context.stateDir);
  const file = paths(context);
  const started = now();
  const common = { ...identity(context), runId: randomUUID(), startedAt: new Date(started).toISOString(), completedAt: null, observedAt: null, snapshotHash: null, ok: false, hold: true, status: "checking", checks: { snapshotHealthy: false }, alerts: [alert("CHECK_IN_PROGRESS", "canonical read in progress; no spend authorization")] };
  try {
    // Replace a previous healthy heartbeat before doing any network work.
    let previous;
    try { previous = optionalJson(file.heartbeat); } catch { latch(context, [alert("LOCAL_STATE_INVALID", "previous heartbeat was unreadable")], started); }
    if (previous && (previous.baselineHash !== context.baselineHash || previous.manifestHash !== context.manifestHash)) latch(context, [alert("BASELINE_CHANGED", "baseline/release changed since the previous run")], started);
    if (previous && (!Number.isFinite(Date.parse(previous.startedAt)) || started - Date.parse(previous.startedAt) > context.baseline.policy.maxHeartbeatAgeMs || previous.status === "checking")) latch(context, [alert("HEARTBEAT_STALE", "previous monitor heartbeat was missed or interrupted")], started);
    atomicJson(file.heartbeat, common);
    let snapshot; let result;
    try { snapshot = await collect(context); result = evaluateSnapshot(context.baseline, snapshot, now()); }
    catch { result = { ok: false, hold: true, alerts: [alert("RPC_CHECK_FAILED", "read-only monitor failed or timed out; partial results are not healthy")] }; }
    if (snapshot?.observedAt && previous?.observedAt) {
      try {
        const before = BigInt(previous.observedAt.blockNumber); const after = BigInt(snapshot.observedAt.blockNumber);
        if (after < before || (after === before && snapshot.observedAt.blockHash !== previous.observedAt.blockHash)) result = { ...result, ok: false, hold: true, alerts: [...result.alerts, alert("CANONICAL_HEAD_CHANGED", "RPC head regressed or the same observed height changed hash")] };
      } catch { result = { ...result, ok: false, hold: true, alerts: [...result.alerts, alert("LOCAL_STATE_INVALID", "previous canonical observation was malformed")] }; }
    }
    const completed = now();
    if (completed < started || completed - started > context.baseline.policy.runTimeoutMs) result = { ok: false, hold: true, alerts: [...result.alerts, alert("CHECK_TIMEOUT", "check exceeded the approved wall-time bound")] };
    if (snapshot) atomicJson(file.snapshot, snapshot);
    if (result.hold) latch(context, result.alerts, completed);
    const incident = optionalJson(file.hold);
    const heartbeat = { ...common, completedAt: new Date(completed).toISOString(), observedAt: snapshot?.observedAt ?? null,
      snapshotHash: snapshot ? digestJson(snapshot) : null, ok: result.ok && !incident, hold: result.hold || !!incident,
      status: result.ok && !incident ? "healthy" : "hold", checks: { snapshotHealthy: result.ok },
      incidentId: incident?.incidentId ?? null, alerts: [...result.alerts, ...(incident && result.ok ? [alert("HOLD_LATCHED", `incident ${incident.incidentId} requires local acknowledgement after recovery`)] : [])] };
    event(context, { runId: heartbeat.runId, completedAt: heartbeat.completedAt, ok: heartbeat.ok, hold: heartbeat.hold, baselineHash: context.baselineHash, observedAt: heartbeat.observedAt, alerts: heartbeat.alerts });
    atomicJson(file.heartbeat, heartbeat);
    return heartbeat;
  } finally { release(); }
}

export function acknowledgeHold(context, incidentId, nowMs = Date.now()) {
  if (typeof incidentId !== "string" || !/^[0-9a-f-]{36}$/.test(incidentId)) throw new Error("the exact incident-id is required");
  const release = acquire(context.stateDir);
  try {
    const file = paths(context); const hold = readJson(file.hold); const heartbeat = readJson(file.heartbeat); const snapshot = readJson(file.snapshot);
    const age = nowMs - Date.parse(heartbeat.startedAt);
    const completed = Date.parse(heartbeat.completedAt);
    if (hold.incidentId !== incidentId || heartbeat.baselineHash !== context.baselineHash || heartbeat.manifestHash !== context.manifestHash || heartbeat.snapshotHash !== digestJson(snapshot) || heartbeat.checks?.snapshotHealthy !== true || !Number.isFinite(completed) || completed > nowMs || completed < Date.parse(heartbeat.startedAt) || !Number.isFinite(age) || age < 0 || age > context.baseline.policy.maxHeartbeatAgeMs || !evaluateSnapshot(context.baseline, snapshot, nowMs).ok) throw new Error("acknowledgement requires the exact incident and a fresh complete healthy sample for this baseline");
    event(context, { acknowledgedAt: new Date(nowMs).toISOString(), incidentId, baselineHash: context.baselineHash });
    const acknowledged = { ...heartbeat, ok: true, hold: false, status: "healthy", alerts: [], incidentId: null, acknowledgedAt: new Date(nowMs).toISOString() };
    atomicJson(file.heartbeat, acknowledged);
    rmSync(file.hold); // If interrupted before this removal, status still holds.
    return acknowledged;
  } finally { release(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["once", "loop", "status", "acknowledge"].includes(command)) throw new Error("command must be once, loop, status or acknowledge");
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { baseline: { type: "string" }, manifest: { type: "string" }, "state-dir": { type: "string" }, index: { type: "string" }, "incident-id": { type: "string" } } });
  if (!values.baseline || !values.manifest || !values["state-dir"]) throw new Error("--baseline, --manifest and --state-dir required");
  const context = loadContext({ baselinePath: values.baseline, manifestPath: values.manifest, stateDir: values["state-dir"], indexPath: values.index });
  if (command === "status") return heartbeatStatus(context);
  if (command === "acknowledge") return acknowledgeHold(context, values["incident-id"]);
  if (command === "once") return runMonitorOnce(context);
  // Explicit foreground loop only. No daemon, cron, launchd or systemd install.
  let stop = false;
  const controller = new AbortController();
  const halt = () => { stop = true; controller.abort(); };
  process.once("SIGINT", halt); process.once("SIGTERM", halt);
  let result;
  do {
    result = await runMonitorOnce(context);
    process.stdout.write(`${canonicalJson(result)}\n`);
    if (!stop) await delay(context.baseline.policy.intervalMs, undefined, { signal: controller.signal }).catch(() => {});
  } while (!stop);
  return result;
}
if (isEntrypoint(import.meta)) main().then((result) => {
  process.stdout.write(`${canonicalJson(result)}\n`); if (!result.ok) process.exitCode = 1;
}, () => {
  // Do not serialize environment values, provider request bodies or credentials.
  process.stdout.write(`${canonicalJson({ ok: false, hold: true, status: "hold", alerts: [alert("RUNNER_FAILED", "runner configuration, lock or local persistence failed; inspect local files before restarting")] })}\n`);
  process.exitCode = 1;
});
