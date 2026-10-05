import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acknowledgeHold, collectSnapshot, heartbeatStatus, loadContext, runMonitorLoop, runMonitorOnce } from "./float-mainnet-monitor-runner.mjs";
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

test("minute cadence includes collection time and keeps retained observations fresh across slow scans", async () => {
  const f = stateFixture(); const stop = new AbortController();
  let elapsed = 0; const starts = []; const waits = []; const ages = [];
  Object.assign(f.context.baseline.policy, { intervalMs: 60000, runTimeoutMs: 120000, maxHeartbeatAgeMs: 240000 });
  try {
    await runMonitorLoop(f.context, {
      signal: stop.signal, monotonicNow: () => elapsed, now: () => NOW + elapsed,
      wait: async (ms) => { waits.push(ms); elapsed += ms; },
      collect: async () => {
        starts.push(elapsed);
        const snapshot = structuredClone(f.snapshot);
        snapshot.observedAt.timestamp = String((NOW + elapsed) / 1000);
        elapsed += 40000;
        // Until publication the notifier must still rely on the last scan.
        if (starts.length > 1) {
          const retained = JSON.parse(readFileSync(join(f.context.stateDir, "snapshot.json")));
          ages.push((NOW + elapsed) / 1000 - Number(retained.observedAt.timestamp));
          assert.equal(evaluateSnapshot(f.context.baseline, retained, NOW + elapsed).ok, true);
        }
        return snapshot;
      },
      onResult: (result) => { assert.equal(result.ok, true); if (starts.length === 4) stop.abort(); },
    });
    assert.deepEqual(starts, [0, 60000, 120000, 180000]);
    assert.deepEqual(waits, [20000, 20000, 20000]);
    assert.deepEqual(ages, [100, 100, 100]);
    // The freshness threshold itself is unchanged.
    assert.ok(codes(heartbeatStatus(f.context, NOW + 301000)).includes("STALE_BLOCK"));
  } finally { f.cleanup(); }
});

test("overrunning scans stay serial and do not accumulate catch-up runs", async () => {
  const f = stateFixture(); const stop = new AbortController();
  let elapsed = 0; let count = 0; let active = 0; const starts = []; const waits = [];
  try {
    await runMonitorLoop(f.context, {
      signal: stop.signal, monotonicNow: () => elapsed, now: () => NOW + elapsed,
      wait: async (ms) => { waits.push(ms); elapsed += ms; },
      collect: async () => {
        assert.equal(++active, 1); starts.push(elapsed);
        elapsed += count++ === 0 ? 2500 : 100;
        await Promise.resolve(); active--; return f.snapshot;
      },
      onResult: () => { if (count === 3) stop.abort(); },
    });
    assert.deepEqual(starts, [0, 2500, 3500]);
    assert.deepEqual(waits, [900]);
  } finally { f.cleanup(); }
});

test("aborting a loop wait does not start another scan or clear a failure hold", async () => {
  const f = stateFixture(); const stop = new AbortController(); let scans = 0;
  try {
    const result = await runMonitorLoop(f.context, {
      signal: stop.signal, monotonicNow: () => 0, now: () => NOW,
      collect: async () => { scans++; throw new Error("RPC unavailable"); },
      wait: async (_ms, signal) => {
        assert.equal(signal, stop.signal); stop.abort();
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      },
    });
    assert.equal(scans, 1); assert.equal(result.hold, true);
    assert.ok(codes(result).includes("RPC_CHECK_FAILED"));
    assert.equal(JSON.parse(readFileSync(join(f.context.stateDir, "hold.json"))).incidentId, result.incidentId);
    assert.equal(await runMonitorLoop(f.context, { signal: stop.signal, collect: () => assert.fail("already stopped") }), undefined);
    await assert.rejects(runMonitorLoop(f.context, {
      monotonicNow: () => 0, now: () => NOW, collect: async () => f.snapshot,
      wait: async () => { throw new Error("unexpected timer failure"); },
    }), /unexpected timer failure/);
  } finally { f.cleanup(); }
});

test("approved pauses and historical operator events are healthy, never implicit spend permission", () => {
  const { baseline, snapshot } = fixture();
  assert.deepEqual(evaluateSnapshot(baseline, snapshot, NOW), { ok: true, hold: false, alerts: [], baselineHash: digestJson(baseline) });
  baseline.pauses.spendsPaused = true; snapshot.contract.spendsPaused = true;
  snapshot.alerts.push({ code: "SPENDS_PAUSED", severity: "warning" });
  assert.equal(evaluateSnapshot(baseline, snapshot, NOW).hold, false);
});

test("a refused spend from another executor does not latch a payment-executor hold", async () => {
  const f = stateFixture();
  try {
    f.snapshot.executionAudit.executions.push({ event: "SpendBlocked", sender: addr(4), executor: addr(4), lineId: hash(2), digest: hash(71), blockNumber: "90", transactionHash: hash(72) });
    const result = await runMonitorOnce(f.context, { collect: async () => f.snapshot, now: () => NOW });
    assert.equal(result.hold, false);
    assert.equal(result.ok, true);
    assert.equal(heartbeatStatus(f.context, NOW).hold, false);
    for (const executor of [null, undefined, "invalid"]) {
      const routed = structuredClone(f.snapshot);
      routed.executionAudit.executions[0].executor = executor;
      assert.ok(codes(evaluateSnapshot(f.baseline, routed, NOW)).includes("EXECUTOR_DRIFT"));
    }
    const paid = structuredClone(f.snapshot);
    paid.executionAudit.executions[0].event = "ProviderPaid";
    assert.ok(codes(evaluateSnapshot(f.baseline, paid, NOW)).includes("EXECUTOR_DRIFT"));
  } finally { f.cleanup(); }
});

test("advancing the execution window cannot hide transient unapproved roles", () => {
  for (const role of ["sponsor", "operator"]) {
    const { baseline, snapshot } = fixture();
    baseline.executor.fromBlock = "95";
    snapshot.executionAudit.fromBlock = "95";
    const entry = { [role]: addr(10), [role === "sponsor" ? "allowed" : "enabled"]: false, set: [{ allowed: true, blockNumber: "90" }, { allowed: false, blockNumber: "91" }] };
    (role === "sponsor" ? snapshot.sponsors : snapshot.contract.operators).push(entry);
    assert.ok(codes(evaluateSnapshot(baseline, snapshot, NOW)).includes(role === "sponsor" ? "SPONSOR_DRIFT" : "OPERATOR_DRIFT"));
  }
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

test("agent-self execution is opt-in for the exact approved line and sender", () => {
 const {baseline,snapshot}=fixture();
 const paid={event:'ProviderPaid',lineId:baseline.lines[0].lineId,sender:baseline.lines[0].agent,executor:baseline.lines[0].agent};
 snapshot.executionAudit.executions=[paid];
 assert.ok(codes(evaluateSnapshot(baseline,snapshot,NOW)).includes('EXECUTOR_DRIFT'));
 baseline.lines[0].executorPolicy='agent-self';
 assert.equal(evaluateSnapshot(baseline,snapshot,NOW).ok,true);
 for(const mutate of [e=>e.sender=addr(99),e=>e.executor=addr(99),e=>e.executor=addr(0),e=>e.executor=null,e=>e.lineId=hash(99),e=>e.event='UnknownEvent']){
  const bad=structuredClone(snapshot);mutate(bad.executionAudit.executions[0]);
  assert.ok(codes(evaluateSnapshot(baseline,bad,NOW)).includes('EXECUTOR_DRIFT'));
 }
 const dedicated=structuredClone(snapshot);dedicated.executionAudit.executions[0].sender=addr(6);dedicated.executionAudit.executions[0].executor=addr(6);
 assert.ok(codes(evaluateSnapshot(baseline,dedicated,NOW)).includes('EXECUTOR_DRIFT'));
 baseline.lines[0].executorPolicy='dedicated';
 assert.equal(evaluateSnapshot(baseline,dedicated,NOW).ok,true);
 baseline.lines[0].executorPolicy='anything';
 assert.throws(()=>validateBaseline(baseline),/executor policy/);
});

test("critical, unknown and unbound lifecycle alerts remain global holds", () => {
 const {baseline,snapshot}=fixture();
 for(const entry of [
  {code:'MATURITY_SOON',severity:'critical',lineId:baseline.lines[0].lineId},
  {code:'DEFAULT_ELIGIBLE',severity:'critical',lineId:baseline.lines[0].lineId},
  {code:'MATURITY_SOON',severity:'warning',lineId:hash(99)},
  {code:'POLICY_EXPIRY_SOON',severity:'warning',lineId:baseline.lines[0].lineId,provider:addr(99)},
  {code:'UNKNOWN',severity:'warning',lineId:baseline.lines[0].lineId},
 ]) {
  const copy=structuredClone(snapshot);copy.alerts.push(entry);
  const result=evaluateSnapshot(baseline,copy,NOW);
  assert.equal(result.hold,true);assert.ok(codes(result).includes(entry.code));
 }
});
