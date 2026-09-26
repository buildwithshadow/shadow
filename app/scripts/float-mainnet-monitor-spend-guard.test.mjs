import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256 } from "viem";
import { assertHealthySpendMonitor } from "./float-mainnet-monitor-spend-guard.mjs";
import { loadContext, runMonitorOnce } from "./float-mainnet-monitor-runner.mjs";

const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const CODE = "0x60016000";
async function fixture(edit = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "shadow-monitor-guard-"));
  const now = Date.now(); const timestamp = String(Math.floor(now / 1000));
  const limits = { protocolReserve: "100", lineReserve: "100", lineSpend: "100", perSpend: "50", dailySpend: "100" };
  const provider = { provider: addr(5), active: true, endpointHash: hash(8), expiry: String(Number(timestamp) + 10000), perSpendCap: "50", dailySpendCap: "100" };
  const line = { lineId: hash(2), sponsor: addr(3), agent: addr(4), epoch: "1", reserveCap: "100", lineSpendCap: "100", dailySpendCap: "100", maximumRepaymentWindow: "3600", termsVersion: "1", allowedStates: ["OPEN", "DRAWN", "CLOSED"], expiry: provider.expiry, providers: [provider] };
  const baseline = { schemaVersion: 1, identity: { chainId: "5042", address: addr(1), runtimeCodeHash: keccak256(CODE), usdc: addr(8), deployBlock: "10" }, owner: addr(2), operators: [], sponsors: [addr(3)], effectiveLimits: limits, pauses: { openingsPaused: true, spendsPaused: false }, lines: [line], executor: { address: addr(6), fromBlock: "10" }, policy: { intervalMs: 1000, runTimeoutMs: 5000, maxHeartbeatAgeMs: 10000, maxBlockAgeSeconds: 120, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false } };
  const snapshot = { ok: true, identity: { chainId: "5042", address: addr(1), runtimeCodeHash: keccak256(CODE), usdc: addr(8) }, observedAt: { blockNumber: "100", blockHash: hash(100), timestamp }, contract: { address: addr(1), owner: addr(2), pendingOwner: addr(0), openingsPaused: true, spendsPaused: false, effectiveLimits: { ...limits }, pendingCapIncreases: [], operators: [], totalSponsorObligations: "100", totalCommittedCapital: "100" }, sponsors: [{ sponsor: addr(3), allowed: true, set: [{ allowed: true, blockNumber: "11" }] }], discovery: { lines: 1, scanned: { fromBlock: "10", toBlock: "100" }, index: null }, lines: [{ ...structuredClone(line), state: "OPEN", availableReserve: "100", principalOutstanding: "0", recoveryAvailable: "0", sponsorClaimed: "0" }], alerts: [{ code: "OPENINGS_PAUSED", severity: "warning" }], accounting: { ok: true, balance: "100", checks: ["balanceCoversObligations", "obligationsEqualLines", "committedCapitalEqualsLines", "linesMatchReserveCap"].map((id) => ({ id, status: "PASS" })) }, executionAudit: { fromBlock: "10", toBlock: "100", executions: [] } };
  edit(baseline, snapshot);
  const baselinePath = join(directory, "baseline.json"); const manifestPath = join(directory, "manifest.json"); const stateDir = join(directory, "state");
  writeFileSync(baselinePath, JSON.stringify(baseline)); writeFileSync(manifestPath, JSON.stringify({ ok: true }));
  const context = loadContext({ baselinePath, manifestPath, stateDir });
  const heartbeat = await runMonitorOnce(context, { collect: async () => snapshot });
  assert.equal(heartbeat.ok, true, JSON.stringify(heartbeat.alerts));
  const calls = [];
  const connection = { chainId: 5042n, address: addr(1), client: {
    getChainId: async () => { calls.push("chain"); return 5042; },
    getBlock: async ({ blockNumber }) => { calls.push("block"); assert.equal(blockNumber, 100n); return { number: 100n, hash: hash(100), timestamp: BigInt(timestamp) }; },
    getCode: async ({ address, blockNumber }) => { calls.push("code"); assert.equal(address, addr(1)); assert.equal(blockNumber, 100n); return CODE; },
    readContract: async ({ address, blockNumber, functionName }) => { calls.push("token"); assert.equal(address, addr(1)); assert.equal(blockNumber, 100n); assert.equal(functionName, "usdc"); return addr(8); },
  } };
  const sessionPolicy = { chainId: "5042", verifyingContract: addr(1), runtimeKeccak256: keccak256(CODE), executor: addr(6), sponsor: addr(3), agent: addr(4), provider: addr(5), endpointHash: hash(8) };
  const struct = { executor: addr(6), sponsor: addr(3), agent: addr(4), provider: addr(5), endpointHash: hash(8), lineId: hash(2), lineEpoch: 1n };
  return { args: { baselinePath, manifestPath, stateDir, sessionPolicy, connection, struct }, context, baseline, snapshot, heartbeat, calls, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("fresh monitor binds exact intent and canonical runtime/token without modifying local state", async () => {
  const f = await fixture();
  try {
    const files = () => readdirSync(f.args.stateDir).sort().map((name) => [name, readFileSync(join(f.args.stateDir, name), "utf8")]);
    const before = files();
    const proof = await assertHealthySpendMonitor(f.args);
    assert.equal(proof.kind, "ShadowFloatMainnet.SpendMonitorProof");
    assert.equal(proof.baselineHash, f.context.baselineHash); assert.equal(proof.manifestHash, f.context.manifestHash);
    assert.equal(proof.runId, f.heartbeat.runId); assert.deepEqual(proof.observedAt, f.heartbeat.observedAt);
    assert.equal(proof.lineId, hash(2)); assert.equal(proof.lineEpoch, "1"); assert.equal(proof.executor, addr(6));
    assert.deepEqual(f.calls, ["chain", "block", "code", "token", "block"]);
    assert.deepEqual(files(), before);
  } finally { f.cleanup(); }
});

const mismatches = [
  ["connection chain", (f) => f.args.connection.chainId = 1n, /chain identity/],
  ["session chain", (f) => f.args.sessionPolicy.chainId = "1", /chain identity/],
  ["connection contract", (f) => f.args.connection.address = addr(11), /contract identity/],
  ["session contract", (f) => f.args.sessionPolicy.verifyingContract = addr(11), /contract identity/],
  ["session runtime", (f) => f.args.sessionPolicy.runtimeKeccak256 = hash(11), /runtime identity/],
  ...["executor", "sponsor", "agent", "provider"].map((name) => [`intent ${name}`, (f) => f.args.struct[name] = addr(11), new RegExp(`intent ${name}`)]),
  ["intent endpoint", (f) => f.args.struct.endpointHash = hash(11), /intent endpointHash/],
  ["unapproved executor", (f) => { f.args.struct.executor = addr(11); f.args.sessionPolicy.executor = addr(11); }, /executor differs/],
  ["unapproved sponsor", (f) => { f.args.struct.sponsor = addr(11); f.args.sessionPolicy.sponsor = addr(11); }, /sponsor is not approved/],
  ["unapproved agent", (f) => { f.args.struct.agent = addr(11); f.args.sessionPolicy.agent = addr(11); }, /epoch or line parties/],
  ["unapproved provider", (f) => { f.args.struct.provider = addr(11); f.args.sessionPolicy.provider = addr(11); }, /provider\/endpoint/],
  ["unapproved endpoint", (f) => { f.args.struct.endpointHash = hash(11); f.args.sessionPolicy.endpointHash = hash(11); }, /provider\/endpoint/],
  ["unknown line", (f) => f.args.struct.lineId = hash(11), /line is missing/],
  ["wrong epoch", (f) => f.args.struct.lineEpoch = 2n, /epoch or line parties/],
  ["missing exact intent", (f) => delete f.args.struct, /exact intent/],
  ["live wrong chain", (f) => f.args.connection.client.getChainId = async () => 1, /execution RPC chain/],
  ["live runtime mismatch", (f) => f.args.connection.client.getCode = async () => "0x6000", /pinned contract runtime/],
  ["live token mismatch", (f) => f.args.connection.client.readContract = async () => addr(11), /pinned USDC/],
  ["session token mismatch if supplied", (f) => f.args.sessionPolicy.usdc = addr(11), /session USDC/],
  ["reorganized block", (f) => f.args.connection.client.getBlock = async () => ({ number: 100n, hash: hash(11), timestamp: BigInt(f.snapshot.observedAt.timestamp) }), /no longer canonical/],
];
for (const [name, mutate, message] of mismatches) test(`spend guard rejects ${name}`, async () => {
  const f = await fixture();
  try { mutate(f); await assert.rejects(assertHealthySpendMonitor(f.args), message); }
  finally { f.cleanup(); }
});

for (const name of ["missing", "corrupt", "stale", "held"]) test(`spend guard rejects ${name} monitoring before RPC reads`, async () => {
  const f = await fixture();
  try {
    const file = join(f.args.stateDir, "heartbeat.json");
    if (name === "missing") rmSync(file);
    if (name === "corrupt") writeFileSync(file, "broken");
    if (name === "stale") writeFileSync(file, JSON.stringify({ ...f.heartbeat, startedAt: new Date(Date.now() - 20000).toISOString(), completedAt: new Date(Date.now() - 19000).toISOString() }));
    if (name === "held") writeFileSync(join(f.args.stateDir, "hold.json"), JSON.stringify({ incidentId: "unresolved" }));
    await assert.rejects(assertHealthySpendMonitor(f.args), /fresh healthy heartbeat/);
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});

for (const pause of ["openingsPaused", "spendsPaused"]) test(`healthy planned ${pause} phase does not automatically authorize spending`, async () => {
  const f = await fixture((b, s) => { b.pauses[pause] = !b.pauses[pause]; s.contract[pause] = b.pauses[pause]; });
  try { await assert.rejects(assertHealthySpendMonitor(f.args), /spend-enabled phase/); }
  finally { f.cleanup(); }
});

test("OPEN must be approved and actually observed; a healthy DRAWN line cannot spend", async () => {
  for (const approveOpen of [true, false]) {
    const f = await fixture((b, s) => {
      if (!approveOpen) b.lines[0].allowedStates = ["DRAWN"];
      s.lines[0].state = "DRAWN"; s.lines[0].availableReserve = "50"; s.lines[0].principalOutstanding = "50";
      s.contract.totalSponsorObligations = "50"; s.accounting.balance = "50";
    });
    try { await assert.rejects(assertHealthySpendMonitor(f.args), approveOpen ? /did not observe.*OPEN/ : /OPEN is not approved/); }
    finally { f.cleanup(); }
  }
});

test("hold, stale sample, baseline edits or a new monitor cycle during RPC reads revoke permission", async () => {
  for (const change of [
    (f) => writeFileSync(join(f.args.stateDir, "hold.json"), JSON.stringify({ incidentId: "new" })),
    (f) => writeFileSync(join(f.args.stateDir, "heartbeat.json"), JSON.stringify({ ...f.heartbeat, startedAt: new Date(Date.now() - 20000).toISOString(), completedAt: new Date(Date.now() - 19000).toISOString() })),
    (f) => writeFileSync(f.args.baselinePath, JSON.stringify({ ...f.baseline, owner: addr(11) })),
    (f) => writeFileSync(join(f.args.stateDir, "heartbeat.json"), JSON.stringify({ ...f.heartbeat, runId: "another-run" })),
  ]) {
    const f = await fixture();
    try {
      f.args.connection.client.readContract = async () => { change(f); return addr(8); };
      await assert.rejects(assertHealthySpendMonitor(f.args), /changed|held|expired/);
    } finally { f.cleanup(); }
  }
});

test("provider failure fails closed without leaking credentials", async () => {
  const f = await fixture();
  try {
    f.args.connection.client.getBlock = async () => { throw new Error("https://user:secret@rpc.invalid/path?apiKey=hidden"); };
    await assert.rejects(assertHealthySpendMonitor(f.args), (error) => { assert.match(error.message, /could not be verified/); assert.doesNotMatch(error.message, /secret|hidden|apiKey/); return true; });
  } finally { f.cleanup(); }
});
