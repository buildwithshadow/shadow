import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, erc20Abi, getAddress, isAddress, keccak256, parseAbi, stringToBytes, zeroAddress } from "viem";
import { floatAbi } from "./float-mainnet-config.mjs";
import { findLogs, read, readLimits, readLine, readPolicy, runCli, UsageError } from "./float-mainnet-cli.mjs";
import { createRpcReadTransport } from "./rpc-read-transport.mjs";
import { isEntrypoint, stableStringify } from "./float-mainnet-preflight.mjs";

// A read-only, phase-specific configuration check. It neither grants release
// permission nor produces signatures, approvals or executable transactions.
export const PHASES = ["deployed", "contained", "owned", "funded", "enabled"];
const FIELDS = ["protocolReserve", "lineReserve", "lineSpend", "perSpend", "dailySpend"];
const MAX_GETTERS = ["maximumProtocolReserve", "maximumLineReserve", "maximumLineSpend", "maximumPerSpend", "maximumDailySpend"];
const SAFE_ABI = parseAbi([
  "function VERSION() view returns (string)", "function masterCopy() view returns (address)",
  "function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
  "function getStorageAt(uint256,uint256) view returns (bytes)",
]);
const TOKEN_ABI = [...erc20Abi, ...parseAbi(["function paused() view returns (bool)", "function isBlacklisted(address) view returns (bool)"])];
const SENTINEL = "0x0000000000000000000000000000000000000001";
// Safe v1.4.1/v1.5.0 GuardManager/FallbackManager storage slots. Other versions require
// a separately reviewed adapter; VERSION() alone does not authenticate code.
const GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n;
const FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5n;
const MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947n;
const TOKEN_IMPLEMENTATION_SLOT = keccak256(stringToBytes("org.zeppelinos.proxy.implementation"));
const hash = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const uint = (v) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 2n ** 256n;
const addr = (v) => typeof v === "string" && isAddress(v) && v.toLowerCase() !== zeroAddress;
const comparable = (value) => {
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, comparable(entry)]));
  return typeof value === "string" ? value.toLowerCase() : value;
};
const equal = (a, b) => a !== undefined && b !== undefined && stableStringify(comparable(a)) === stableStringify(comparable(b));
const sorted = (xs) => [...xs].map((s) => s.toLowerCase()).sort();
const zeroWord = `0x${"0".repeat(64)}`;
export const fileHash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateActivationPlan(plan) {
  const require = (pass, message) => { if (!pass) throw new UsageError(`activation plan: ${message}`); };
  require(plan?.schema === "shadow-activation-plan/v1", "unsupported schema");
  for (const name of ["chainId", "deploymentBlock", "minimumRepaymentWindow", "maximumRepaymentWindow", "governanceDelay"])
    require(uint(plan[name]), `${name} must be an unsigned decimal string`);
  require(BigInt(plan.chainId) > 0n && BigInt(plan.chainId) <= BigInt(Number.MAX_SAFE_INTEGER), "invalid chainId");
  for (const name of ["address", "usdc", "deployer", "sponsor", "agent", "executor", "provider", "operator"])
    require(addr(plan[name]), `${name} must be a nonzero public address`);
  for (const name of ["runtimeHash", "tokenCodeHash", "agentCodeHash", "endpointHash"])
    require(hash(plan[name]), `${name} must be bytes32`);
  require(plan.tokenImplementation === null ? plan.chainId !== "5042" && plan.tokenImplementationHash === null : addr(plan.tokenImplementation) && hash(plan.tokenImplementationHash),
    "pin token implementation address and code hash; Arc mainnet requires the FiatTokenProxy implementation");
  if (plan.chainId === "5042") require(plan.usdc.toLowerCase() === "0x3600000000000000000000000000000000000000", "Arc mainnet requires canonical USDC");
  for (const group of ["effectiveLimits", "maximumLimits"]) for (const name of FIELDS)
    require(uint(plan[group]?.[name]) && BigInt(plan[group][name]) > 0n, `${group}.${name} must be positive atomic USDC`);
  for (const name of FIELDS) require(BigInt(plan.effectiveLimits[name]) <= BigInt(plan.maximumLimits[name]), `${name} exceeds immutable maximum`);
  require(BigInt(plan.minimumRepaymentWindow) > 0n && BigInt(plan.maximumRepaymentWindow) >= BigInt(plan.minimumRepaymentWindow), "invalid repayment windows");
  require(Number.isInteger(plan.maxAgeSeconds) && plan.maxAgeSeconds >= 1 && plan.maxAgeSeconds <= 300, "maxAgeSeconds must be 1–300");
  const safe = plan.safe;
  require(["1.4.1", "1.5.0"].includes(safe?.version), "Safe version must have a reviewed adapter (1.4.1 or 1.5.0)");
  require(addr(safe?.address) && addr(safe?.singleton), "Safe address and singleton are required");
  require(hash(safe.proxyCodeHash) && hash(safe.singletonCodeHash), "Safe proxy and singleton hashes must come from reviewed deployment artifacts");
  require(Array.isArray(safe.owners) && safe.owners.length > 0 && safe.owners.every(addr), "Safe owners must be explicit");
  require(new Set(sorted(safe.owners)).size === safe.owners.length, "duplicate Safe owners");
  require(uint(safe.threshold) && BigInt(safe.threshold) > 0n && BigInt(safe.threshold) <= BigInt(safe.owners.length), "invalid Safe threshold");
  require(isAddress(safe.fallbackHandler), "Safe fallback handler must be explicit (zero is allowed)");
  require(safe.fallbackHandler === zeroAddress ? safe.fallbackCodeHash === null : hash(safe.fallbackCodeHash), "fallback handler code hash required unless zero");
  require(sorted([plan.deployer, safe.address, plan.operator]).length === new Set(sorted([plan.deployer, safe.address, plan.operator])).size,
    "deployer, owner Safe and pause operator must be distinct addresses");
  const line = plan.line;
  for (const name of ["reserve", "lineSpendCap", "dailySpendCap", "expiry", "maximumRepaymentWindow", "providerExpiry", "providerPerSpendCap", "providerDailySpendCap"])
    require(uint(line?.[name]) && BigInt(line[name]) > 0n, `line.${name} must be positive`);
  require(BigInt(line.reserve) <= BigInt(plan.effectiveLimits.lineReserve) && BigInt(line.reserve) <= BigInt(plan.effectiveLimits.protocolReserve), "funding exceeds reserve limits");
  require(BigInt(line.providerPerSpendCap) <= BigInt(plan.effectiveLimits.perSpend), "provider purchase cap exceeds limit");
  require(BigInt(line.providerDailySpendCap) <= BigInt(plan.effectiveLimits.dailySpend) && BigInt(line.dailySpendCap) <= BigInt(plan.effectiveLimits.dailySpend), "daily limit exceeds global limit");
  require(BigInt(line.lineSpendCap) <= BigInt(plan.effectiveLimits.lineSpend), "line spending limit exceeds global limit");
  require(BigInt(line.maximumRepaymentWindow) >= BigInt(plan.minimumRepaymentWindow) && BigInt(line.maximumRepaymentWindow) <= BigInt(plan.maximumRepaymentWindow), "invalid line repayment window");
  require(BigInt(line.providerExpiry) <= BigInt(line.expiry), "provider outlives line");
  require(typeof plan.monitorBaselineHash === "string" && /^[a-f0-9]{64}$/.test(plan.monitorBaselineHash), "approved monitor baseline hash required");
  return plan;
}

async function codeHash(client, address, blockNumber) {
  const code = await client.getCode({ address, blockNumber });
  return !code || code === "0x" ? null : keccak256(code);
}

async function observeSafe(client, safe, blockNumber) {
  const call = (functionName, args = []) => client.readContract({ address: safe.address, abi: SAFE_ABI, functionName, args, blockNumber });
  const proxyCodeHash = await codeHash(client, safe.address, blockNumber);
  if (proxyCodeHash === null) return { proxyCodeHash };
  const singleton = await call("masterCopy");
  const [modules, next] = await call("getModulesPaginated", [SENTINEL, 1n]);
  const fallbackWord = await call("getStorageAt", [FALLBACK_SLOT, 1n]);
  if (!hash(fallbackWord)) throw new Error("malformed Safe fallback storage");
  const fallbackHandler = getAddress(`0x${fallbackWord.slice(-40)}`);
  return {
    proxyCodeHash, singleton, singletonCodeHash: await codeHash(client, singleton, blockNumber),
    version: await call("VERSION"), owners: sorted(await call("getOwners")), threshold: await call("getThreshold"),
    modules, next, guardWord: await call("getStorageAt", [GUARD_SLOT, 1n]),
    moduleGuardWord: safe.version === "1.5.0" ? await call("getStorageAt", [MODULE_GUARD_SLOT, 1n]) : zeroWord,
    fallbackWord, fallbackHandler, fallbackCodeHash: fallbackHandler === zeroAddress ? null : await codeHash(client, fallbackHandler, blockNumber),
  };
}

export async function observeActivation(client, plan, phase, pinned) {
  const blockNumber = pinned.number;
  const connection = { client, address: plan.address, deployBlock: BigInt(plan.deploymentBlock) };
  const at = (name, args = []) => read(connection, name, args, blockNumber);
  const token = (functionName, args = []) => client.readContract({ address: plan.usdc, abi: TOKEN_ABI, functionName, args, blockNumber });
  const tokenSlot = await client.getStorageAt({ address: plan.usdc, slot: TOKEN_IMPLEMENTATION_SLOT, blockNumber });
  if (!hash(tokenSlot)) throw new Error("missing token implementation storage");
  const tokenImplementation = BigInt(tokenSlot) === 0n ? null : getAddress(`0x${tokenSlot.slice(-40)}`);
  const events = [];
  for (const log of await findLogs(connection, undefined, undefined, connection.deployBlock, blockNumber)) {
    if (log.removed || log.blockNumber === null) throw new Error("noncanonical event in activation discovery");
    events.push(decodeEventLog({ abi: floatAbi, data: log.data, topics: log.topics }));
  }
  const members = async (event, arg, getter) => {
    const result = [];
    for (const value of new Set(events.filter((e) => e.eventName === event).map((e) => e.args[arg].toLowerCase())))
      if (await at(getter, [value])) result.push(value);
    return sorted(result);
  };
  const state = {};
  for (const name of ["owner", "pendingOwner", "openingsPaused", "spendsPaused", "usdc", "deploymentChainId", "minimumRepaymentWindow", "maximumRepaymentWindow", "governanceDelay", "totalCommittedCapital", "totalSponsorObligations"])
    state[name] = await at(name);
  state.effectiveLimits = await readLimits(connection, blockNumber);
  state.maximumLimits = {};
  for (const [i, name] of FIELDS.entries()) state.maximumLimits[name] = await at(MAX_GETTERS[i]);
  state.pendingCaps = [];
  for (let i = 0; i < FIELDS.length; i++) state.pendingCaps.push(await at("pendingCaps", [i]));
  state.sponsors = await members("SponsorAllowed", "sponsor", "sponsorAllowed");
  state.operators = await members("OperatorSet", "operator", "operators");
  state.sponsorAllowed = await at("sponsorAllowed", [plan.sponsor]);
  state.operatorAllowed = await at("operators", [plan.operator]);
  state.deployerOperator = await at("operators", [plan.deployer]);
  state.balance = await token("balanceOf", [plan.address]);
  state.sponsorBalance = await token("balanceOf", [plan.sponsor]);
  state.allowance = await token("allowance", [plan.sponsor, plan.address]);
  state.tokenDecimals = await token("decimals");
  state.tokenPaused = await token("paused");
  state.blacklisted = [];
  for (const address of new Set([plan.address, plan.deployer, plan.sponsor, plan.agent, plan.executor, plan.provider, plan.operator, plan.safe.address]))
    if (await token("isBlacklisted", [address])) state.blacklisted.push(address);
  const lineIds = [...new Set(events.filter((e) => e.eventName === "LineOpened").map((e) => e.args.lineId))];
  state.lines = [];
  for (const lineId of lineIds) {
    const line = await readLine(connection, lineId, blockNumber);
    const providers = [];
    for (const provider of new Set(events.filter((e) => e.eventName === "ProviderPolicySet" && e.args.lineId === lineId).map((e) => e.args.provider.toLowerCase()))) {
      const policy = await readPolicy(connection, lineId, provider, blockNumber);
      if (policy.active) providers.push({ provider, ...policy });
    }
    state.lines.push({ lineId, ...line, providers });
  }
  return {
    block: { number: blockNumber, hash: pinned.hash, timestamp: pinned.timestamp },
    runtimeHash: await codeHash(client, plan.address, blockNumber), tokenCodeHash: await codeHash(client, plan.usdc, blockNumber),
    agentCodeHash: await codeHash(client, plan.agent, blockNumber), state,
    tokenImplementation, tokenImplementationHash: tokenImplementation === null ? null : await codeHash(client, tokenImplementation, blockNumber),
    safe: ["owned", "funded", "enabled"].includes(phase) ? await observeSafe(client, plan.safe, blockNumber) : null,
    discoveredFrom: connection.deployBlock, discoveredThrough: blockNumber,
  };
}

export function evaluateActivation(plan, phase, observations, { now = Math.floor(Date.now() / 1000), heartbeat, manifestHash } = {}) {
  validateActivationPlan(plan);
  if (!PHASES.includes(phase)) throw new UsageError(`phase must be ${PHASES.join(" | ")}`);
  const checks = [];
  const check = (id, ok) => checks.push({ id, status: ok === true ? "PASS" : "FAIL" });
  check("two_matching_observations", observations.length === 2 && equal(observations[0], observations[1]));
  const o = observations[0];
  if (!o?.state) throw new Error("missing activation observation");
  const s = o.state, funded = ["funded", "enabled"].includes(phase), owned = funded || phase === "owned";
  const match = (id, actual, expected) => check(id, equal(actual, expected));
  check("fresh_block", Number(o.block.timestamp) <= now + 15 && now - Number(o.block.timestamp) <= plan.maxAgeSeconds);
  match("full_discovery", [o.discoveredFrom, o.discoveredThrough], [plan.deploymentBlock, o.block.number]);
  match("contract_runtime", o.runtimeHash, plan.runtimeHash);
  match("token_runtime", o.tokenCodeHash, plan.tokenCodeHash);
  match("token_implementation", [o.tokenImplementation, o.tokenImplementationHash], [plan.tokenImplementation, plan.tokenImplementationHash]);
  match("network_and_token", [s.deploymentChainId, s.usdc, s.tokenDecimals], [plan.chainId, plan.usdc, 6]);
  match("owner", s.owner, owned ? plan.safe.address : plan.deployer);
  match("pending_owner_cleared", s.pendingOwner, zeroAddress);
  match("pauses", [s.openingsPaused, s.spendsPaused], [phase !== "deployed", !["deployed", "enabled"].includes(phase)]);
  match("effective_limits", s.effectiveLimits, plan.effectiveLimits);
  match("immutable_limits", s.maximumLimits, plan.maximumLimits);
  match("repayment_and_governance_windows", [s.minimumRepaymentWindow, s.maximumRepaymentWindow, s.governanceDelay], [plan.minimumRepaymentWindow, plan.maximumRepaymentWindow, plan.governanceDelay]);
  match("no_pending_cap_increases", s.pendingCaps, FIELDS.map(() => [0n, 0n]));
  match("exact_sponsors", s.sponsors, funded ? sorted([plan.sponsor]) : []);
  match("expected_sponsor_membership", s.sponsorAllowed, funded);
  match("exact_operators", s.operators, owned ? sorted([plan.operator]) : []);
  match("expected_operator_membership", s.operatorAllowed, owned);
  match("deployer_is_not_operator", s.deployerOperator, false);
  match("token_unrestricted", [s.tokenPaused, s.blacklisted], [false, []]);
  match("zero_residual_allowance", s.allowance, 0n);
  const reserve = funded ? plan.line.reserve : "0";
  match("exact_funding_and_obligations", [s.balance, s.totalCommittedCapital, s.totalSponsorObligations], [reserve, reserve, reserve]);
  check("line_count", s.lines.length === (funded ? 1 : 0));
  if (owned) {
    const a = o.safe ?? {};
    match("safe_code_identity", [a.proxyCodeHash, a.singleton, a.singletonCodeHash, a.version], [plan.safe.proxyCodeHash, plan.safe.singleton, plan.safe.singletonCodeHash, plan.safe.version]);
    match("safe_owners_threshold", [a.owners, a.threshold], [sorted(plan.safe.owners), plan.safe.threshold]);
    match("safe_no_modules_or_guard", [a.modules, a.next, a.guardWord, a.moduleGuardWord], [[], SENTINEL, zeroWord, zeroWord]);
    match("safe_fallback", [a.fallbackHandler, a.fallbackCodeHash], [plan.safe.fallbackHandler, plan.safe.fallbackCodeHash]);
  }
  if (funded) {
    match("contract_agent_deployed", o.agentCodeHash, plan.agentCodeHash);
    const line = s.lines[0] ?? {}, t = plan.line;
    match("first_unused_line", [line.sponsor, line.agent, line.epoch, line.state, line.reserveCap, line.availableReserve, line.principalOutstanding, line.recoveryAvailable, line.cumulativePrincipalPaid, line.spentToday],
      [plan.sponsor, plan.agent, "1", "1", t.reserve, t.reserve, "0", "0", "0", "0"]);
    match("line_terms", [line.lineSpendCap, line.dailySpendCap, line.expiry, line.maximumRepaymentWindow], [t.lineSpendCap, t.dailySpendCap, t.expiry, t.maximumRepaymentWindow]);
    const providers = line.providers ?? [], provider = providers[0] ?? {};
    check("exact_provider_count", providers.length === 1);
    match("provider_terms", [provider.provider, provider.endpointHash, provider.expiry, provider.perSpendCap, provider.dailySpendCap, provider.spentToday],
      [plan.provider, plan.endpointHash, t.providerExpiry, t.providerPerSpendCap, t.providerDailySpendCap, "0"]);
    check("terms_have_repayment_time", BigInt(t.expiry) > BigInt(o.block.timestamp) + BigInt(plan.minimumRepaymentWindow) && BigInt(t.providerExpiry) > BigInt(o.block.timestamp) + BigInt(plan.minimumRepaymentWindow));
    const h = heartbeat ?? {}, completed = Date.parse(h.completedAt) / 1000;
    check("fresh_monitor", h.kind === "shadow-monitor-heartbeat" && h.ok === true && h.hold === false && Number.isFinite(completed) && completed <= now + 15 && now - completed <= plan.maxAgeSeconds);
    match("monitor_identity", [h.chainId, h.address, h.runtimeCodeHash, h.baselineHash, h.manifestHash], [plan.chainId, plan.address, plan.runtimeHash, plan.monitorBaselineHash, manifestHash]);
    check("monitor_recent_and_canonical", o.monitorCanonical === true && uint(String(h.observedAt?.timestamp)) &&
      BigInt(h.observedAt.timestamp) <= BigInt(o.block.timestamp) && BigInt(o.block.timestamp) - BigInt(h.observedAt.timestamp) <= BigInt(plan.maxAgeSeconds));
  }
  return { kind: "shadow-activation-check", phase, ok: checks.every((c) => c.status === "PASS"), releaseReady: false,
    scope: "Read-only phase configuration snapshot. Does not prove signer control, independent review, customer evidence, service delivery or release authorization.",
    planHash: fileHash(stableStringify(plan)), observedAt: o.block, checks };
}

async function checkPhase(values) {
  if (!values.plan || !values.manifest || !values.phase || !values["plan-sha256"] || !values["manifest-sha256"]) throw new UsageError("--plan, --manifest, --phase and approved --plan-sha256/--manifest-sha256 are required");
  const planBytes = readFileSync(values.plan);
  if (fileHash(planBytes) !== values["plan-sha256"]) throw new Error("plan changed from the reviewed SHA256");
  const plan = validateActivationPlan(JSON.parse(planBytes));
  if (!PHASES.includes(values.phase)) throw new UsageError("unknown phase");
  const manifestBytes = readFileSync(values.manifest), manifest = JSON.parse(manifestBytes);
  if (fileHash(manifestBytes) !== values["manifest-sha256"]) throw new Error("manifest changed from the reviewed SHA256");
  if (manifest.ok !== true || String(manifest.chainId) !== plan.chainId || !equal(manifest.contract?.address, plan.address) || !equal(manifest.bytecode?.onchainRuntimeKeccak256, plan.runtimeHash) || String(manifest.deployment?.blockNumber) !== plan.deploymentBlock || !equal(manifest.deployment?.deployer, plan.deployer))
    throw new Error("passing release manifest must match the plan's chain, address, runtime and deployment block");
  const urls = [process.env.ARC_RPC_URL, process.env.ARC_RPC_URL_2];
  if (urls.some((u) => !u || !URL.canParse(u)) || new URL(urls[0]).origin === new URL(urls[1]).origin) throw new Error("two different RPC origins required in ARC_RPC_URL and ARC_RPC_URL_2");
  const clients = urls.map((url) => createPublicClient({ transport: createRpcReadTransport(url) }));
  const heads = [];
  for (const client of clients) {
    if (String(await client.getChainId()) !== plan.chainId) throw new Error("RPC chain differs from activation plan");
    heads.push(await client.getBlockNumber({ cacheTime: 0 }));
  }
  let heartbeat = null;
  if (["funded", "enabled"].includes(values.phase)) {
    if (!values["monitor-baseline"] || !values["monitor-state-dir"]) throw new UsageError("funded/enabled require --monitor-baseline and --monitor-state-dir");
    // Revalidate the stored snapshot, baseline binding and latched incident,
    // rather than trusting a copied heartbeat's ok flag.
    const { loadContext, heartbeatStatus } = await import("./float-mainnet-monitor-runner.mjs");
    const context = loadContext({ baselinePath: values["monitor-baseline"], manifestPath: values.manifest, stateDir: values["monitor-state-dir"] });
    heartbeat = heartbeatStatus(context);
    if (!heartbeat.ok || heartbeat.hold || context.baselineHash !== plan.monitorBaselineHash) throw new Error("monitor is not healthy for the approved activation baseline");
  }
  // Never let a still-fresh heartbeat choose an old activation state. Re-read
  // all phase invariants at the current common head independently of monitoring.
  const blockNumber = heads.reduce((a, b) => a < b ? a : b);
  if (blockNumber < BigInt(plan.deploymentBlock) || heads.some((n) => n < blockNumber)) throw new Error("activation block outside both RPC heads/deployment");
  const observations = [];
  for (const client of clients) {
    const pinned = await client.getBlock({ blockNumber });
    const observation = await observeActivation(client, plan, values.phase, pinned);
    if (heartbeat && ["funded", "enabled"].includes(values.phase)) {
      const number = String(heartbeat.observedAt?.blockNumber);
      if (!uint(number) || BigInt(number) > blockNumber) throw new Error("invalid monitor block");
      const monitorBlock = await client.getBlock({ blockNumber: BigInt(number) });
      observation.monitorCanonical = monitorBlock.hash === heartbeat.observedAt.blockHash && String(monitorBlock.timestamp) === String(heartbeat.observedAt.timestamp);
    }
    observations.push(observation);
    if ((await client.getBlock({ blockNumber })).hash !== pinned.hash) throw new Error("activation block reorganized during reads");
  }
  for (const client of clients) if ((await client.getBlock({ blockNumber })).hash !== observations[0].block.hash) throw new Error("activation block no longer canonical across both providers");
  return evaluateActivation(plan, values.phase, observations, { heartbeat, manifestHash: fileHash(manifestBytes) });
}

if (isEntrypoint(import.meta)) runCli({ check: { options: { plan: { type: "string" }, "plan-sha256": { type: "string" }, "manifest-sha256": { type: "string" }, phase: { type: "string" }, "monitor-baseline": { type: "string" }, "monitor-state-dir": { type: "string" } }, run: checkPhase } }, [
  "node app/scripts/float-mainnet-activation.mjs check --plan <private-plan.json> --plan-sha256 <approved hash> --manifest <release.json> --manifest-sha256 <approved hash> --phase deployed|contained|owned|funded|enabled [--monitor-baseline <baseline.json> --monitor-state-dir <local directory>]",
  "Set ARC_RPC_URL and ARC_RPC_URL_2 to separate operators. This tool only reads; it never signs, sends, auto-advances phases or certifies full release readiness.",
]);
