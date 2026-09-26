import { createHash } from "node:crypto";
import { isAddress, zeroAddress } from "viem";
import { reconcileState } from "./float-mainnet-monitor.mjs";

const LIMITS = ["protocolReserve", "lineReserve", "lineSpend", "perSpend", "dailySpend"];
const ACCOUNTING = ["balanceCoversObligations", "obligationsEqualLines", "committedCapitalEqualsLines", "linesMatchReserveCap"];
const lower = (value) => typeof value === "string" ? value.toLowerCase() : value;
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
export function canonicalJson(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digestJson = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const uint = (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const hash = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const address = (value) => typeof value === "string" && isAddress(value) && lower(value) !== zeroAddress;
function keys(value, expected, name) {
  requireThat(value && !Array.isArray(value) && typeof value === "object" && equal(Object.keys(value).sort(), expected.sort()), `${name}: unexpected or missing fields`);
}
function addressSet(value, name) {
  requireThat(Array.isArray(value) && value.every(address) && new Set(value.map(lower)).size === value.length, `${name}: unique nonzero addresses required`);
}

// No TOFU: the caller supplies an explicit baseline. Snapshot data can never
// create or rewrite the approved roles, limits or line policy automatically.
export function validateBaseline(raw) {
  const b = structuredClone(raw);
  keys(b, ["schemaVersion", "identity", "owner", "operators", "sponsors", "effectiveLimits", "pauses", "lines", "executor", "policy"], "baseline");
  requireThat(b.schemaVersion === 1, "unsupported baseline schema");
  keys(b.identity, ["chainId", "address", "runtimeCodeHash", "usdc", "deployBlock"], "identity");
  requireThat(uint(b.identity.chainId) && BigInt(b.identity.chainId) > 0n && uint(b.identity.deployBlock) && address(b.identity.address) && address(b.identity.usdc) && hash(b.identity.runtimeCodeHash), "invalid baseline identity");
  requireThat(address(b.owner), "invalid baseline owner");
  addressSet(b.operators, "operators"); addressSet(b.sponsors, "sponsors");
  keys(b.effectiveLimits, [...LIMITS], "effectiveLimits");
  requireThat(LIMITS.every((key) => uint(b.effectiveLimits[key]) && BigInt(b.effectiveLimits[key]) > 0n), "positive atomic limits required");
  keys(b.pauses, ["openingsPaused", "spendsPaused"], "pauses");
  requireThat(Object.values(b.pauses).every((value) => typeof value === "boolean"), "pause expectations must be explicit booleans");
  keys(b.executor, ["address", "fromBlock"], "executor");
  requireThat(address(b.executor.address) && uint(b.executor.fromBlock) && BigInt(b.executor.fromBlock) >= BigInt(b.identity.deployBlock), "executor address and audit start required");
  keys(b.policy, ["intervalMs", "runTimeoutMs", "maxHeartbeatAgeMs", "maxBlockAgeSeconds", "maxIndexLagSeconds", "warnBeforeSeconds", "requireIndex"], "policy");
  for (const key of Object.keys(b.policy).filter((key) => key !== "requireIndex")) requireThat(Number.isSafeInteger(b.policy[key]) && b.policy[key] > 0, `policy.${key} must be a positive safe integer`);
  requireThat(typeof b.policy.requireIndex === "boolean" && b.policy.maxHeartbeatAgeMs >= b.policy.intervalMs + b.policy.runTimeoutMs, "invalid heartbeat/index policy");
  requireThat(Array.isArray(b.lines), "baseline lines required");
  const ids = new Set();
  for (const line of b.lines) {
    keys(line, ["lineId", "sponsor", "agent", "epoch", "reserveCap", "lineSpendCap", "dailySpendCap", "maximumRepaymentWindow", "termsVersion", "expiry", "allowedStates", "providers"], "line");
    requireThat(hash(line.lineId) && !ids.has(line.lineId), "unique line IDs required"); ids.add(line.lineId);
    requireThat(address(line.sponsor) && address(line.agent) && ["epoch", "reserveCap", "lineSpendCap", "dailySpendCap", "maximumRepaymentWindow", "termsVersion", "expiry"].every((key) => uint(line[key])), "invalid line policy");
    requireThat(Array.isArray(line.allowedStates) && line.allowedStates.length > 0 && line.allowedStates.every((state) => ["OPEN", "DRAWN", "CLOSED", "DEFAULTED"].includes(state)) && new Set(line.allowedStates).size === line.allowedStates.length, "explicit allowed line states required");
    requireThat(Array.isArray(line.providers), "providers required");
    const providers = new Set();
    for (const provider of line.providers) {
      keys(provider, ["provider", "active", "endpointHash", "expiry", "perSpendCap", "dailySpendCap"], "provider");
      requireThat(address(provider.provider) && !providers.has(lower(provider.provider)), "unique provider addresses required"); providers.add(lower(provider.provider));
      requireThat(typeof provider.active === "boolean" && hash(provider.endpointHash) && ["expiry", "perSpendCap", "dailySpendCap"].every((key) => uint(provider[key])), "invalid provider policy");
    }
  }
  // Address case and order are not policy changes; amounts retain canonical decimal strings.
  for (const key of ["address", "usdc"]) b.identity[key] = lower(b.identity[key]);
  b.owner = lower(b.owner); b.executor.address = lower(b.executor.address);
  b.operators = b.operators.map(lower).sort(); b.sponsors = b.sponsors.map(lower).sort();
  b.lines = b.lines.map((line) => ({ ...line, allowedStates: line.allowedStates.sort(), sponsor: lower(line.sponsor), agent: lower(line.agent), providers: line.providers.map((p) => ({ ...p, provider: lower(p.provider) })).sort((a, c) => a.provider.localeCompare(c.provider)) })).sort((a, c) => a.lineId.localeCompare(c.lineId));
  return b;
}

export function evaluateSnapshot(rawBaseline, snapshot, nowMs = Date.now()) {
  const b = validateBaseline(rawBaseline);
  const alerts = [];
  const alert = (code, detail, severity = "critical") => alerts.push({ code, severity, detail });
  const check = (ok, code, detail) => { if (!ok) alert(code, detail); };
  try {
    const s = snapshot;
    requireThat(s && s.contract && s.identity && s.observedAt && s.discovery && Array.isArray(s.lines) && Array.isArray(s.alerts) && Array.isArray(s.sponsors), "missing snapshot sections");
    for (const [key, expected] of Object.entries(b.identity).filter(([key]) => key !== "deployBlock")) check(lower(String(s.identity[key])) === expected, "IDENTITY_DRIFT", `${key} differs from approved identity`);
    check(lower(s.contract.address) === b.identity.address, "IDENTITY_DRIFT", "contract address differs");
    const observed = s.observedAt;
    requireThat(uint(observed.blockNumber) && uint(observed.timestamp) && hash(observed.blockHash), "invalid observed block identity");
    const age = nowMs / 1000 - Number(observed.timestamp);
    check(Number.isFinite(age) && age >= -30 && age <= b.policy.maxBlockAgeSeconds, "STALE_BLOCK", "snapshot block timestamp is stale or in the future");
    check(s.discovery.scanned?.fromBlock === b.identity.deployBlock && s.discovery.scanned?.toBlock === observed.blockNumber && s.discovery.lines === s.lines.length && new Set(s.lines.map((line) => line.lineId)).size === s.lines.length, "DISCOVERY_INCOMPLETE", "full deployment-to-observed scan and unique line count required");
    check(s.ok === true, "MONITOR_FAILED", "monitor reported failure");
    check(lower(s.contract.owner) === b.owner && lower(s.contract.pendingOwner) === zeroAddress, "OWNER_DRIFT", "owner or pending owner differs from approved state");
    check(equal(s.contract.effectiveLimits, b.effectiveLimits) && Array.isArray(s.contract.pendingCapIncreases) && s.contract.pendingCapIncreases.length === 0, "CAP_DRIFT", "effective caps changed or an increase is pending");
    for (const key of Object.keys(b.pauses)) check(s.contract[key] === b.pauses[key], "PAUSE_DRIFT", `${key} differs from the approved phase`);
    requireThat(Array.isArray(s.contract.operators), "missing operators");
    const operators = s.contract.operators.filter((entry) => entry.enabled === true).map((entry) => lower(entry.operator)).sort();
    const sponsors = s.sponsors.filter((entry) => entry.allowed === true).map((entry) => lower(entry.sponsor)).sort();
    check(equal(operators, b.operators), "OPERATOR_DRIFT", "enabled operator membership differs");
    check(equal(sponsors, b.sponsors), "SPONSOR_DRIFT", "allowed sponsor membership differs (including sponsors without lines)");
    for (const [records, field, approved, code] of [[s.contract.operators, "operator", b.operators, "OPERATOR_DRIFT"], [s.sponsors, "sponsor", b.sponsors, "SPONSOR_DRIFT"]]) {
      for (const entry of records) {
        requireThat(address(entry[field]) && typeof entry[field === "operator" ? "enabled" : "allowed"] === "boolean" && Array.isArray(entry.set), "invalid role observations");
        if (!approved.includes(lower(entry[field])) && entry.set.some((event) => event.allowed === true && BigInt(event.blockNumber) >= BigInt(b.executor.fromBlock))) alert(code, "unapproved role was enabled during the observation window, even if removed later");
      }
    }
    check(equal(s.lines.map((line) => line.lineId).sort(), b.lines.map((line) => line.lineId)), "LINE_DRIFT", "observed line set/count differs from approved baseline");
    for (const expected of b.lines) {
      const actual = s.lines.find((line) => line.lineId === expected.lineId);
      if (!actual) continue;
      for (const key of ["sponsor", "agent", "epoch", "reserveCap", "lineSpendCap", "dailySpendCap", "maximumRepaymentWindow", "termsVersion", "expiry"]) check(lower(actual[key]) === expected[key], "LINE_DRIFT", `${expected.lineId}: ${key} differs`);
      check(expected.allowedStates.includes(actual.state), "LINE_STATE_DRIFT", `${expected.lineId}: line state is not approved`);
      requireThat(Array.isArray(actual.providers), "missing provider observations");
      const policies = actual.providers.map((p) => Object.fromEntries(["provider", "active", "endpointHash", "expiry", "perSpendCap", "dailySpendCap"].map((key) => [key, key === "provider" ? lower(p[key]) : p[key]]))).sort((a, c) => a.provider.localeCompare(c.provider));
      check(equal(policies, expected.providers), "PROVIDER_DRIFT", `${expected.lineId}: provider/endpoint/limit policy differs`);
    }
    const index = s.discovery.index;
    if (b.policy.requireIndex) check(index !== null && index !== undefined, "INDEX_MISSING", "baseline requires index health");
    if (index) check(index.canonical === true && index.note === null && uint(index.lagSeconds) && Number(index.lagSeconds) <= b.policy.maxIndexLagSeconds, "INDEX_LAG", "index is stale or noncanonical");
    // Recompute accounting rather than trusting an exit code or an `ok` flag.
    requireThat(s.accounting && Array.isArray(s.accounting.checks), "missing accounting checks");
    check(ACCOUNTING.every((id) => s.accounting.checks.some((entry) => entry.id === id && entry.status === "PASS")), "ACCOUNTING_FAILED", "snapshot accounting checks failed or are incomplete");
    requireThat(uint(s.accounting.balance) && uint(s.contract.totalSponsorObligations) && uint(s.contract.totalCommittedCapital) && s.lines.every((line) => ["OPEN", "DRAWN", "CLOSED", "DEFAULTED"].includes(line.state)), "invalid accounting state");
    const accounting = reconcileState({ balance: BigInt(s.accounting.balance), totalSponsorObligations: BigInt(s.contract.totalSponsorObligations), totalCommittedCapital: BigInt(s.contract.totalCommittedCapital), lines: s.lines.map((line) => ({ ...line, ...Object.fromEntries(["reserveCap", "availableReserve", "principalOutstanding", "recoveryAvailable", "sponsorClaimed"].map((field) => { requireThat(uint(line[field]), "invalid accounting amount"); return [field, BigInt(line[field])]; })) })) });
    check(s.accounting.ok === true && accounting.ok, "ACCOUNTING_FAILED", "line identities, balance or aggregate obligations do not reconcile");
    const audit = s.executionAudit;
    requireThat(audit && Array.isArray(audit.executions), "missing execution audit");
    check(audit.fromBlock === b.executor.fromBlock && audit.toBlock === observed.blockNumber, "EXECUTOR_AUDIT_INCOMPLETE", "executor audit does not cover the approved window");
    for (const event of audit.executions) check(lower(event.sender) === b.executor.address && lower(event.executor) === b.executor.address, "EXECUTOR_DRIFT", "execution did not prove the approved sender and nonzero signed executor");
    for (const entry of s.alerts) {
      // Planned pauses and approved historical operators are already checked
      // against exact current state; all other warning codes fail closed.
      if (["SPENDS_PAUSED", "OPENINGS_PAUSED", "OPERATOR_CHANGED"].includes(entry.code)) continue;
      alert(entry.code || "UNKNOWN_MONITOR_ALERT", "monitor raised an operational alert", entry.severity === "critical" ? "critical" : "warning");
    }
  } catch {
    alert("SNAPSHOT_INVALID", "snapshot was incomplete or malformed; no healthy state inferred");
  }
  return { ok: alerts.length === 0, hold: alerts.length !== 0, alerts, baselineHash: digestJson(b) };
}
