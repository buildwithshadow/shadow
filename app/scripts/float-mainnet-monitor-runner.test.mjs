import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acknowledgeHold, collectSnapshot, heartbeatStatus, loadContext, runMonitorOnce } from "./float-mainnet-monitor-runner.mjs";
import { digestJson, evaluateSnapshot, validateBaseline } from "./float-mainnet-monitor-policy.mjs";

const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const NOW = 1_800_000_000_000;
function fixture() {
  const limits = { protocolReserve: "100", lineReserve: "100", lineSpend: "100", perSpend: "50", dailySpend: "100" };
  const provider = { provider: addr(5), active: true, endpointHash: hash(8), expiry: "1800010000", perSpendCap: "50", dailySpendCap: "100" };
  const line = { lineId: hash(2), sponsor: addr(3), agent: addr(4), epoch: "1", reserveCap: "100", lineSpendCap: "100", dailySpendCap: "100", maximumRepaymentWindow: "3600", termsVersion: "1", allowedStates: ["OPEN", "DRAWN", "CLOSED"], expiry: "1800010000", providers: [provider] };
  const baseline = validateBaseline({ schemaVersion: 1, identity: { chainId: "5042002", address: addr(1), runtimeCodeHash: hash(1), usdc: addr(8), deployBlock: "10" }, owner: addr(2), operators: [addr(9)], sponsors: [addr(3)], effectiveLimits: limits, pauses: { openingsPaused: true, spendsPaused: false }, lines: [line], executor: { address: addr(6), fromBlock: "10" }, policy: { intervalMs: 1000, runTimeoutMs: 5000, maxHeartbeatAgeMs: 10000, maxBlockAgeSeconds: 120, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false } });
  const snapshot = { ok: true, identity: { chainId: "5042002", address: addr(1), runtimeCodeHash: hash(1), usdc: addr(8) }, observedAt: { blockNumber: "100", blockHash: hash(100), timestamp: String(NOW / 1000) }, contract: { address: addr(1), owner: addr(2), pendingOwner: addr(0), openingsPaused: true, spendsPaused: false, effectiveLimits: limits, pendingCapIncreases: [], operators: [{ operator: addr(9), enabled: true, set: [{ allowed: true, blockNumber: "11" }] }], totalSponsorObligations: "100", totalCommittedCapital: "100" }, sponsors: [{ sponsor: addr(3), allowed: true, set: [{ allowed: true, blockNumber: "11" }] }], discovery: { lines: 1, scanned: { fromBlock: "10", toBlock: "100" }, index: null }, lines: [{ ...line, state: "OPEN", availableReserve: "100", principalOutstanding: "0", recoveryAvailable: "0", sponsorClaimed: "0" }], alerts: [{ code: "OPENINGS_PAUSED", severity: "warning" }, { code: "OPERATOR_CHANGED", severity: "warning" }], accounting: { ok: true, balance: "100", checks: ["balanceCoversObligations", "obligationsEqualLines", "committedCapitalEqualsLines", "linesMatchReserveCap"].map((id) => ({ id, status: "PASS" })) }, executionAudit: { fromBlock: "10", toBlock: "100", executions: [] } };
  return { baseline, snapshot };
}
function stateFixture() {
  const directory = mkdtempSync(join(tmpdir(), "shadow-runner-"));
  const { baseline, snapshot } = fixture();
  const baselinePath = join(directory, "baseline.json"); const manifestPath = join(directory, "manifest.json");
  writeFileSync(baselinePath, JSON.stringify(baseline)); writeFileSync(manifestPath, JSON.stringify({ ok: true }));
  const context = loadContext({ baselinePath, manifestPath, stateDir: join(directory, "state") });
  return { context, baseline, snapshot, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const codes = (result) => result.alerts.map((entry) => entry.code);

test("approved pauses and historical operator events are healthy, never implicit spend permission", () => {
  const { baseline, snapshot } = fixture();
  assert.deepEqual(evaluateSnapshot(baseline, snapshot, NOW), { ok: true, hold: false, alerts: [], baselineHash: digestJson(baseline) });
  baseline.pauses.spendsPaused = true; snapshot.contract.spendsPaused = true;
  snapshot.alerts.push({ code: "SPENDS_PAUSED", severity: "warning" });
  assert.equal(evaluateSnapshot(baseline, snapshot, NOW).hold, false);
});

const mutations = [
  ["unknown sponsor without a line", "SPONSOR_DRIFT", (s) => s.sponsors.push({ sponsor: addr(10), allowed: true, set: [] })],
  ["unknown operator", "OPERATOR_DRIFT", (s) => s.contract.operators.push({ operator: addr(10), enabled: true, set: [] })],
  ["transient sponsor enabled then removed", "SPONSOR_DRIFT", (s) => s.sponsors.push({ sponsor: addr(10), allowed: false, set: [{ allowed: true, blockNumber: "90" }, { allowed: false, blockNumber: "91" }] })],
  ["owner changed", "OWNER_DRIFT", (s) => s.contract.owner = addr(10)],
  ["ownership pending despite check exit zero", "OWNER_DRIFT", (s) => s.contract.pendingOwner = addr(10)],
  ["effective cap changed", "CAP_DRIFT", (s) => s.contract.effectiveLimits = { ...s.contract.effectiveLimits, perSpend: "51" }],
  ["pending increase", "CAP_DRIFT", (s) => s.contract.pendingCapIncreases.push({ kind: "PER_SPEND" })],
  ["unexpected pause phase", "PAUSE_DRIFT", (s) => s.contract.openingsPaused = false],
  ["filtered range", "DISCOVERY_INCOMPLETE", (s) => s.discovery.scanned.fromBlock = "11"],
  ["incomplete final range", "DISCOVERY_INCOMPLETE", (s) => s.discovery.scanned.toBlock = "99"],
  ["missing unfunded historical line", "LINE_DRIFT", (s) => { s.lines = []; s.discovery.lines = 0; }],
  ["line daily cap changed", "LINE_DRIFT", (s) => s.lines[0].dailySpendCap = "101"],
  ["unexpected defaulted state", "LINE_STATE_DRIFT", (s) => s.lines[0].state = "DEFAULTED"],
  ["provider changed", "PROVIDER_DRIFT", (s) => s.lines[0].providers = [{ ...s.lines[0].providers[0], provider: addr(10) }]],
  ["endpoint changed", "PROVIDER_DRIFT", (s) => s.lines[0].providers = [{ ...s.lines[0].providers[0], endpointHash: hash(10) }]],
  ["index lag", "INDEX_LAG", (s) => s.discovery.index = { canonical: true, note: null, lagSeconds: "121" }],
  ["index reorg", "INDEX_LAG", (s) => s.discovery.index = { canonical: false, note: "reorg", lagSeconds: "0" }],
  ["stale block", "STALE_BLOCK", (s) => s.observedAt.timestamp = String(NOW / 1000 - 121)],
  ["forged healthy accounting flag", "ACCOUNTING_FAILED", (s) => s.accounting.balance = "99"],
  ["unbound signed executor", "EXECUTOR_DRIFT", (s) => s.executionAudit.executions.push({ sender: addr(6), executor: addr(0) })],
  ["unknown routed executor", "EXECUTOR_DRIFT", (s) => s.executionAudit.executions.push({ sender: addr(6), executor: null })],
  ["missing execution window", "EXECUTOR_AUDIT_INCOMPLETE", (s) => s.executionAudit.fromBlock = "11"],
  ["runtime drift", "IDENTITY_DRIFT", (s) => s.identity.runtimeCodeHash = hash(10)],
  ["structured warning with zero-exit check", "SPONSOR_REMOVED", (s) => s.alerts.push({ code: "SPONSOR_REMOVED", severity: "warning" })],
  ["unknown future alert", "NEW_ALERT", (s) => s.alerts.push({ code: "NEW_ALERT", severity: "warning" })],
  ["missing accounting data", "SNAPSHOT_INVALID", (s) => delete s.accounting],
];
for (const [name, code, change] of mutations) test(`hold on ${name}`, () => {
  const { baseline, snapshot } = fixture(); change(snapshot);
  const result = evaluateSnapshot(baseline, snapshot, NOW);
  assert.equal(result.ok, false); assert.equal(result.hold, true); assert.ok(codes(result).includes(code), JSON.stringify(result));
});

test("baseline rejects ambiguous schema, duplicate roles and zero executor", () => {
  for (const change of [(b) => b.extra = true, (b) => b.sponsors.push(b.sponsors[0]), (b) => b.executor.address = addr(0), (b) => b.effectiveLimits.perSpend = 1, (b) => b.policy.maxHeartbeatAgeMs = 0]) {
    const { baseline } = fixture(); change(baseline); assert.throws(() => validateBaseline(baseline));
  }
  const { baseline, snapshot } = fixture(); baseline.policy.requireIndex = true;
  assert.ok(codes(evaluateSnapshot(baseline, snapshot, NOW)).includes("INDEX_MISSING"));
});

test("atomic heartbeat, stale detection, RPC failure, restart and explicit incident acknowledgement", async () => {
  const f = stateFixture(); let time = NOW;
  try {
    assert.equal(heartbeatStatus(f.context, time).hold, true);
    const healthy = await runMonitorOnce(f.context, { now: () => time, collect: async () => f.snapshot });
    assert.equal(healthy.ok, true); assert.equal(statSync(join(f.context.stateDir, "heartbeat.json")).mode & 0o777, 0o600);
    assert.equal(heartbeatStatus(f.context, time + 10001).hold, true);
    // A failure replaces the healthy heartbeat and never persists provider secrets.
    time += 100;
    const failed = await runMonitorOnce(f.context, { now: () => time, collect: async () => { throw new Error("https://user:secret@rpc.invalid?apiKey=hidden"); } });
    assert.equal(failed.hold, true); assert.ok(codes(failed).includes("RPC_CHECK_FAILED"));
    assert.doesNotMatch(readFileSync(join(f.context.stateDir, "heartbeat.json"), "utf8"), /secret|hidden|apiKey/);
    // New runner instance cannot silently clear the previous incident.
    time += 100;
    const recovered = await runMonitorOnce({ ...f.context }, { now: () => time, collect: async () => f.snapshot });
    assert.equal(recovered.checks.snapshotHealthy, true); assert.equal(recovered.hold, true);
    assert.throws(() => acknowledgeHold(f.context, "wrong", time));
    assert.throws(() => acknowledgeHold(f.context, undefined, time));
    assert.equal(acknowledgeHold(f.context, recovered.incidentId, time).hold, false);
    assert.equal(heartbeatStatus(f.context, time).ok, true);
    f.snapshot.accounting.balance = "99";
    const accounting = await runMonitorOnce(f.context, { now: () => time, collect: async () => f.snapshot });
    assert.equal(accounting.hold, true); assert.throws(() => acknowledgeHold(f.context, accounting.incidentId, time));
  } finally { f.cleanup(); }
});

test("in-progress cycle revokes previous healthy state and excludes concurrent runners", async () => {
  const f = stateFixture(); let finish; let entered;
  try {
    await runMonitorOnce(f.context, { now: () => NOW, collect: async () => f.snapshot });
    const started = new Promise((resolve) => { entered = resolve; });
    const running = runMonitorOnce(f.context, { now: () => NOW, collect: async () => { entered(); return new Promise((resolve) => { finish = resolve; }); } });
    await started;
    assert.equal(heartbeatStatus(f.context, NOW).hold, true);
    await assert.rejects(runMonitorOnce(f.context, { collect: async () => assert.fail("must not collect") }), /lock exists/);
    finish(f.snapshot); assert.equal((await running).ok, true);
  } finally { f.cleanup(); }
});

test("missed heartbeat latches even after recovery, and corrupted snapshot never stays healthy", async () => {
  const f = stateFixture();
  try {
    await runMonitorOnce(f.context, { now: () => NOW, collect: async () => f.snapshot });
    const restarted = await runMonitorOnce(f.context, { now: () => NOW + 10001, collect: async () => f.snapshot });
    assert.equal(restarted.hold, true); assert.equal(restarted.checks.snapshotHealthy, true);
    acknowledgeHold(f.context, restarted.incidentId, NOW + 10001);
    writeFileSync(join(f.context.stateDir, "snapshot.json"), "{}");
    assert.ok(codes(heartbeatStatus(f.context, NOW + 10001)).includes("SNAPSHOT_BINDING_MISMATCH"));
  } finally { f.cleanup(); }
});

test("wall time is bounded and a partial subprocess result cannot become healthy", async () => {
  const f = stateFixture();
  try {
    f.context.baseline.policy.runTimeoutMs = 25;
    const start = Date.now();
    await assert.rejects(collectSnapshot(f.context, { rpcUrl: "http://127.0.0.1:1" }), /bound|complete/);
    assert.ok(Date.now() - start < 2000);
    let time = NOW;
    const expired = await runMonitorOnce(f.context, { now: () => time, collect: async () => { time += 26; return f.snapshot; } });
    assert.ok(codes(expired).includes("CHECK_TIMEOUT")); assert.equal(expired.hold, true);
  } finally { f.cleanup(); }
});

test("head regression and same-height reorg latch a hold, baseline change needs fresh acknowledgement", async () => {
  for (const mutate of [(s) => { s.observedAt.blockNumber = "99"; s.discovery.scanned.toBlock = "99"; s.executionAudit.toBlock = "99"; }, (s) => { s.observedAt.blockHash = hash(101); }]) {
    const f = stateFixture();
    try {
      await runMonitorOnce(f.context, { now: () => NOW, collect: async () => f.snapshot });
      mutate(f.snapshot);
      const result = await runMonitorOnce(f.context, { now: () => NOW + 1, collect: async () => f.snapshot });
      assert.equal(result.hold, true); assert.ok(codes(result).includes("CANONICAL_HEAD_CHANGED"));
    } finally { f.cleanup(); }
  }
  const f = stateFixture();
  try {
    await runMonitorOnce(f.context, { now: () => NOW, collect: async () => f.snapshot });
    const context = { ...f.context, manifestHash: "a".repeat(64) };
    assert.equal(heartbeatStatus(context, NOW).hold, true);
    const changed = await runMonitorOnce(context, { now: () => NOW, collect: async () => f.snapshot });
    assert.equal(changed.hold, true); assert.equal(changed.checks.snapshotHealthy, true);
    assert.equal(acknowledgeHold(context, changed.incidentId, NOW).hold, false);
  } finally { f.cleanup(); }
});
