import { decodeEventLog, erc20Abi, zeroAddress } from "viem";
import { floatAbi } from "./float-mainnet-config.mjs";
import {
  UsageError,
  connect,
  durationFlag,
  findLogs,
  parseBytes32,
  read,
  readLimits,
  readLine,
  readPolicy,
  remainingCapacity,
  runCli,
  stateName,
} from "./float-mainnet-cli.mjs";
import { readIndexFile } from "./float-mainnet-indexer.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

// Read-only pilot monitor and reconciliation for the ShadowFloatMainnet
// candidate. Every read is pinned to one block. check exits 1 on a critical
// alert and reconcile on any mismatch, so either can drive cron or CI alerting.

// Enum order as declared in ShadowFloatMainnet.sol (CapKind), with the
// effectiveLimits field each kind changes.
export const CAP_KINDS = ["PROTOCOL_RESERVE", "LINE_RESERVE", "LINE_SPEND", "PER_SPEND", "DAILY_SPEND"];
const LIMIT_FIELDS = ["protocolReserve", "lineReserve", "lineSpend", "perSpend", "dailySpend"];
const DEFAULT_WARN_BEFORE = 86_400n;
const DEFAULT_MAX_INDEX_LAG = 3_600n;

function requireManifest(values) {
  if (values.manifest === undefined) {
    throw new UsageError("--manifest <release manifest> is required: it names the deployment, its runtime code hash and the deployment block every scan starts from");
  }
}

// The Float events the monitor needs, from the deployment block to the pinned
// block. A canonical checkpoint does not prove an index contains every event:
// missing operator/policy changes need not affect the accounting totals. Scan
// the complete canonical range independently; --index supplies lag and reorg
// diagnostics only, never the events that determine alerts or reconciliation.
async function discover(connection, indexPath, pinned) {
  const events = [];
  const from = connection.deployBlock;
  let index = null;
  if (indexPath !== undefined) {
    const file = readIndexFile(indexPath, connection);
    const checkpoint = BigInt(file.checkpoint.blockNumber);
    if (BigInt(file.fromBlock) > connection.deployBlock) {
      throw new Error(
        `${indexPath} starts at block ${file.fromBlock}, after the deployment block ${connection.deployBlock}, so it cannot list every line; rebuild it with --manifest`,
      );
    }
    if (checkpoint > pinned.number) {
      index = {
        checkpoint: file.checkpoint,
        canonical: false,
        lagBlocks: null,
        lagSeconds: null,
        note: `the RPC head ${pinned.number} is behind the index checkpoint ${checkpoint}: this RPC lags the one the index was built from, so the lines were scanned from the deployment block instead; the index needs no action, but an RPC that stays behind is stale`,
      };
    } else {
      const block = await connection.client.getBlock({ blockNumber: checkpoint });
      const canonical = block.hash === file.checkpoint.blockHash;
      index = {
        checkpoint: file.checkpoint,
        canonical,
        lagBlocks: pinned.number - checkpoint,
        lagSeconds: pinned.timestamp - block.timestamp,
        note: canonical
          ? null
          : `the index checkpoint ${checkpoint} (${file.checkpoint.blockHash}) was reorganized away (block ${checkpoint} is now ${block.hash}), so the lines were scanned from the deployment block instead; run the indexer with --resume to rebuild it`,
      };
    }
  }
  const scanned = from <= pinned.number ? { fromBlock: from, toBlock: pinned.number } : null;
  const logs = scanned ? await findLogs(connection, undefined, undefined, from, pinned.number) : [];
  for (const log of logs) {
    const { eventName, args } = decodeEventLog({ abi: floatAbi, data: log.data, topics: log.topics });
    events.push({ event: eventName, args, blockNumber: log.blockNumber, transactionHash: log.transactionHash });
  }

  const lineIds = [...new Set(events.filter((entry) => entry.event === "LineOpened").map((entry) => entry.args.lineId))];
  const providers = new Map(lineIds.map((lineId) => [lineId, new Set()]));
  const sponsorClaimed = new Map(lineIds.map((lineId) => [lineId, 0n]));
  // An event of a line with no LineOpened (an incomplete RPC scan) is skipped here:
  // check's DISCOVERY_INCOMPLETE and reconcile's line sums report the missing line.
  for (const { event, args } of events) {
    if (event === "ProviderPolicySet") providers.get(args.lineId)?.add(args.provider);
    if (event === "SponsorClaimed" && sponsorClaimed.has(args.lineId)) sponsorClaimed.set(args.lineId, sponsorClaimed.get(args.lineId) + BigInt(args.amount));
  }
  const operatorSets = events.filter((entry) => entry.event === "OperatorSet");
  return { lineIds, providers, sponsorClaimed, operatorSets, index, scanned };
}

// State reads are pinned by block number; a reorg of that block during the run
// would mix two chains.
async function stillCanonical(connection, pinned) {
  const block = await connection.client.getBlock({ blockNumber: pinned.number });
  if (block.hash !== pinned.hash) throw new Error(`block ${pinned.number} was reorganized during the run (${pinned.hash} is now ${block.hash}); run again`);
}

const observed = (pinned) => ({ blockNumber: pinned.number, blockHash: pinned.hash, timestamp: pinned.timestamp });

async function check(values) {
  requireManifest(values);
  const warnBefore = values["warn-before"] === undefined ? DEFAULT_WARN_BEFORE : durationFlag(values, "warn-before");
  const maxIndexLag = values["max-index-lag"] === undefined ? DEFAULT_MAX_INDEX_LAG : durationFlag(values, "max-index-lag");
  const only = values["line-id"] === undefined ? null : [...new Set(values["line-id"].map((raw) => parseBytes32("--line-id", raw)))];
  const connection = await connect(values, { readOnly: true });
  const pinned = await connection.client.getBlock();
  const at = (functionName, args) => read(connection, functionName, args, pinned.number);
  const found = await discover(connection, values.index, pinned);
  const unknown = (only ?? []).filter((lineId) => !found.lineIds.includes(lineId));
  if (unknown.length) throw new Error(`no LineOpened for --line-id ${unknown.join(", ")} in blocks ${connection.deployBlock}-${pinned.number}`);

  // Reads share a serial transport. Enqueue each only after its predecessor
  // succeeds so a failed check leaves no detached requests consuming quota.
  const [owner, pendingOwner, openingsPaused, spendsPaused, effectiveLimits, totalCommittedCapital, totalSponsorObligations, minimumRepaymentWindow] =
    [
      await at("owner"),
      await at("pendingOwner"),
      await at("openingsPaused"),
      await at("spendsPaused"),
      await readLimits(connection, pinned.number),
      await at("totalCommittedCapital"),
      await at("totalSponsorObligations"),
      await at("minimumRepaymentWindow"),
    ];
  const pendingCaps = [];
  for (let kind = 0; kind < CAP_KINDS.length; kind++) pendingCaps.push(await at("pendingCaps", [kind]));
  const operatorAddresses = [...new Set(found.operatorSets.map((entry) => entry.args.operator))];
  const operators = [];
  for (const operator of operatorAddresses) {
    operators.push({
      operator,
      enabled: await at("operators", [operator]),
      set: found.operatorSets
        .filter((entry) => entry.args.operator === operator)
        .map(({ args, blockNumber, transactionHash }) => ({ allowed: args.allowed, blockNumber, transactionHash })),
    });
  }

  const now = pinned.timestamp;
  const soon = (time) => time <= now + warnBefore;
  const left = (time) => (time > now ? time - now : 0n);
  const when = (time) => (time > now ? `in ${time - now}s` : `${now - time}s ago`);
  const alerts = [];
  const alert = (severity, code, detail, where = {}) => alerts.push({ severity, code, ...where, detail });

  if (spendsPaused) {
    alert(
      "warning",
      "SPENDS_PAUSED",
      "spendsPaused is set: an intent that passes executeSpend's revert checks is recorded as SpendBlocked(SPENDS_PAUSED) and uses up its nonce (on a DRAWN line a spend reverts InvalidState instead); repayment, default, close and claims stay open",
    );
  }
  if (openingsPaused) alert("warning", "OPENINGS_PAUSED", "openingsPaused is set: openLine reverts; existing lines are unaffected");
  const pendingCapIncreases = pendingCaps.flatMap(([value, activateAt], kind) => {
    if (activateAt === 0n) return [];
    const current = effectiveLimits[LIMIT_FIELDS[kind]];
    alert(
      "warning",
      "CAP_INCREASE_PENDING",
      `${CAP_KINDS[kind]} ${current} -> ${value} can be activated by the owner from ${activateAt} (${when(activateAt)}); the owner or an operator can cancelCapIncrease(${kind}) at any time until it is activated, after ${activateAt} too`,
      { kind: CAP_KINDS[kind] },
    );
    return [{ kind: CAP_KINDS[kind], current, value, activateAt, secondsToActivation: left(activateAt) }];
  });
  if (pendingOwner !== zeroAddress) {
    alert("warning", "OWNERSHIP_PENDING", `proposeOwner(${pendingOwner}) is pending: that address becomes the owner as soon as it calls acceptOwnership`);
  }
  // The release manifest proves only that no operator was enabled up to its
  // block, so any OperatorSet since deployment is reported.
  for (const { operator, enabled, set } of operators) {
    const last = set.at(-1);
    alert(
      "warning",
      "OPERATOR_CHANGED",
      `${set.length} OperatorSet event(s) for ${operator} since deployment, the last with allowed ${last.allowed} in block ${last.blockNumber}; it is ${enabled ? "enabled" : "not enabled"} now`,
      { operator },
    );
  }
  if (totalCommittedCapital > effectiveLimits.protocolReserve) {
    alert(
      "warning",
      "PROTOCOL_CAP_EXCEEDED",
      `totalCommittedCapital ${totalCommittedCapital} exceeds effectiveLimits.protocolReserve ${effectiveLimits.protocolReserve}: no spend can pay (an intent that passes executeSpend's revert checks is recorded as SpendBlocked, with PROTOCOL_CAP unless an earlier reason applies) and openLine reverts, until closes and claims bring the capital down to the cap or the cap is raised`,
    );
  }
  if (found.index && (found.index.note !== null || found.index.lagSeconds > maxIndexLag)) {
    const { checkpoint, note, lagBlocks, lagSeconds } = found.index;
    alert(
      "warning",
      "INDEX_LAG",
      note ?? `the index checkpoint ${checkpoint.blockNumber} is ${lagBlocks} blocks and ${lagSeconds}s behind the head, more than ${maxIndexLag}s; run the indexer with --resume`,
    );
  }

  const sponsorAllowedBy = new Map();
  const lines = [];
  for (const lineId of only ?? found.lineIds) {
    const line = await readLine(connection, lineId, pinned.number);
    if (!sponsorAllowedBy.has(line.sponsor)) sponsorAllowedBy.set(line.sponsor, await at("sponsorAllowed", [line.sponsor]));
    const sponsorAllowed = sponsorAllowedBy.get(line.sponsor);
    const state = stateName(line);
    const live = state === "OPEN" || state === "DRAWN";
    const drawn = state === "DRAWN";
    // As isMatured: declareDefault is possible from dueAt itself.
    const matured = drawn && now >= line.dueAt;
    const providers = [];
    for (const provider of found.providers.get(lineId)) {
      const policy = await readPolicy(connection, lineId, provider, pinned.number);
      const input = { now, line, policy, effectiveLimits, totalCommittedCapital, spendsPaused, sponsorAllowed, minimumRepaymentWindow };
      providers.push({
        provider,
        active: policy.active,
        endpointHash: policy.endpointHash,
        expiry: policy.expiry,
        secondsToExpiry: left(policy.expiry),
        ...remainingCapacity(input),
      });
    }

    const where = { lineId };
    if (matured) {
      alert(
        "critical",
        "DEFAULT_ELIGIBLE",
        `principalOutstanding ${line.principalOutstanding} was due at ${line.dueAt} (${when(line.dueAt)}): the sponsor may declare-default; repayment stays open until it does`,
        where,
      );
    } else if (drawn && soon(line.dueAt)) {
      alert("warning", "MATURITY_SOON", `principalOutstanding ${line.principalOutstanding} is due at ${line.dueAt} (${when(line.dueAt)})`, where);
    }
    // As executeSpend: a spend's dueAt is at least minimumRepaymentWindow after
    // it and at most the line's expiry, so purchases stop that long before it.
    const purchasesEnd = line.expiry - minimumRepaymentWindow;
    if (live && soon(purchasesEnd)) {
      alert(
        "warning",
        "LINE_EXPIRY_SOON",
        `purchases stop after ${purchasesEnd} (${when(purchasesEnd)}), minimumRepaymentWindow before the line expires at ${line.expiry} (${when(line.expiry)}): no spend can have a dueAt after the expiry`,
        where,
      );
    }
    for (const { provider, active, expiry } of providers) {
      if (live && active && soon(expiry)) {
        alert("warning", "POLICY_EXPIRY_SOON", `the policy for provider ${provider} expires at ${expiry} (${when(expiry)}); spends to it are then recorded as PROVIDER_NOT_ALLOWED`, {
          ...where,
          provider,
        });
      }
    }
    if (live && !sponsorAllowed) {
      alert("warning", "SPONSOR_REMOVED", `sponsor ${line.sponsor} is no longer allowlisted: spends on this line are recorded as SPONSOR_NOT_ALLOWED; its exits stay open`, where);
    }

    lines.push({
      lineId,
      state,
      sponsor: line.sponsor,
      agent: line.agent,
      epoch: line.epoch,
      sponsorAllowed,
      reserveCap: line.reserveCap,
      availableReserve: line.availableReserve,
      principalOutstanding: line.principalOutstanding,
      recoveryAvailable: line.recoveryAvailable,
      cumulativePrincipalPaid: line.cumulativePrincipalPaid,
      lineSpendCap: line.lineSpendCap,
      dueAt: line.dueAt,
      matured,
      secondsToMaturity: drawn ? left(line.dueAt) : null,
      expiry: line.expiry,
      secondsToExpiry: left(line.expiry),
      providers,
    });
  }
  // DEFAULT_ELIGIBLE needs every line: a DRAWN line missing from the RPC's
  // log scan would raise nothing. The lines found hold totalCommittedCapital
  // exactly when none is missing (reconcile's committedCapitalEqualsLines); a
  // missed line that holds nothing is CLOSED or DEFAULTED and raises no alert.
  if (only === null) {
    const held = lines.reduce((total, line) => total + line.availableReserve + line.principalOutstanding + line.recoveryAvailable, 0n);
    if (held !== totalCommittedCapital) {
      alert(
        "critical",
        "DISCOVERY_INCOMPLETE",
        `totalCommittedCapital is ${totalCommittedCapital}, but the ${lines.length} line(s) found hold ${held} in availableReserve + principalOutstanding + recoveryAvailable: a line is missing from the canonical log scan, so its alerts (DEFAULT_ELIGIBLE included) cannot be raised, or the totals and the lines have diverged; run check and reconcile with an independent RPC`,
      );
    }
  }
  await stillCanonical(connection, pinned);

  return {
    ok: !alerts.some((entry) => entry.severity === "critical"),
    observedAt: observed(pinned),
    warnBefore,
    maxIndexLag,
    alerts,
    contract: {
      address: connection.address,
      owner,
      pendingOwner,
      openingsPaused,
      spendsPaused,
      effectiveLimits,
      totalCommittedCapital,
      totalSponsorObligations,
      pendingCapIncreases,
      operators,
    },
    discovery: { lines: found.lineIds.length, index: found.index, scanned: found.scanned },
    lines,
  };
}

// The identities reconcile checks, derived from every write to the two totals
// in ShadowFloatMainnet.sol:
//   openLine          committed += reserve, obligations += reserve   availableReserve = reserve
//   executeSpend      obligations -= p                               availableReserve -= p, principalOutstanding = p
//   repay (DRAWN)     obligations += a                               principalOutstanding -= a, availableReserve += a
//   repay (DEFAULTED) obligations += a                               principalOutstanding -= a, recoveryAvailable += a
//   closeLine         committed -= r, obligations -= r               r = availableReserve (principal and recovery are 0)
//   claimDefaulted    committed -= r, obligations -= r               r = availableReserve + recoveryAvailable
// so, over every line ever opened:
//   totalSponsorObligations == sum(availableReserve + recoveryAvailable)
//   totalCommittedCapital   == sum(availableReserve + principalOutstanding + recoveryAvailable)
// A defaulted line's unrepaid principal stays committed after claimDefaulted.
// CAP-02: each of those USDC movements is an exact transfer of the same amount,
// so balanceOf(Float) == totalSponsorObligations + any USDC sent to the Float
// outside its functions, which no function can move out.
//
// The totals miss equal and opposite errors on two lines (a CAP-01 breach), so
// each line is also checked against its reserveCap. From every write to a
// line's state, reserveCap, availableReserve, principalOutstanding and
// recoveryAvailable (a lineId hashes a fresh epoch, so openLine starts from
// zeroed storage, and reserveCap is written only there):
//   openLine          -> OPEN        reserveCap = availableReserve = reserve
//   executeSpend      OPEN -> DRAWN  availableReserve -= p, principalOutstanding = p (p > 0; it was 0 while OPEN)
//   repay (DRAWN)                    principalOutstanding -= a, availableReserve += a; -> OPEN when principal reaches 0
//   declareDefault    DRAWN -> DEFAULTED, no amount changes
//   repay (DEFAULTED)                principalOutstanding -= a, recoveryAvailable += a
//   claimDefaulted    stays DEFAULTED  availableReserve = recoveryAvailable = 0, SponsorClaimed(amount = their sum)
//   closeLine         OPEN, no principal -> CLOSED  availableReserve = 0
// DEFAULTED and CLOSED are final, so recoveryAvailable is 0 on every other line:
//   OPEN       availableReserve == reserveCap (principalOutstanding 0, recoveryAvailable 0)
//   DRAWN      availableReserve + principalOutstanding == reserveCap, principalOutstanding > 0, recoveryAvailable 0
//   CLOSED     availableReserve, principalOutstanding and recoveryAvailable all 0
//   DEFAULTED  availableReserve + principalOutstanding + recoveryAvailable + sum(SponsorClaimed.amount) == reserveCap
// Returns the identities a line breaks, as text.
export function lineMismatches({ state, reserveCap, availableReserve, principalOutstanding, recoveryAvailable, sponsorClaimed }) {
  const mismatches = [];
  const zero = (name, value) => {
    if (value !== 0n) mismatches.push(`${name} ${value} is not 0`);
  };
  if (state === "CLOSED") {
    zero("availableReserve", availableReserve);
    zero("principalOutstanding", principalOutstanding);
    zero("recoveryAvailable", recoveryAvailable);
  } else if (state === "DEFAULTED") {
    const held = availableReserve + principalOutstanding + recoveryAvailable + sponsorClaimed;
    if (held !== reserveCap) {
      mismatches.push(`availableReserve + principalOutstanding + recoveryAvailable + SponsorClaimed amounts ${held} is not reserveCap ${reserveCap}`);
    }
  } else {
    // OPEN or DRAWN: readLine refuses a line in state NONE.
    if (availableReserve + principalOutstanding !== reserveCap) {
      mismatches.push(`availableReserve + principalOutstanding ${availableReserve + principalOutstanding} is not reserveCap ${reserveCap}`);
    }
    zero("recoveryAvailable", recoveryAvailable);
    if (state === "OPEN") zero("principalOutstanding", principalOutstanding);
    else if (principalOutstanding === 0n) mismatches.push("principalOutstanding is 0 on a DRAWN line");
  }
  return mismatches;
}

export function reconcileState({ balance, totalSponsorObligations, totalCommittedCapital, lines }) {
  const sum = (field) => lines.reduce((total, line) => total + line[field], 0n);
  const sums = { availableReserve: sum("availableReserve"), principalOutstanding: sum("principalOutstanding"), recoveryAvailable: sum("recoveryAvailable") };
  const obligationsOfLines = sums.availableReserve + sums.recoveryAvailable;
  const committedOfLines = obligationsOfLines + sums.principalOutstanding;
  const surplus = balance >= totalSponsorObligations ? balance - totalSponsorObligations : 0n;
  const broken = lines.flatMap((line) => {
    const mismatches = lineMismatches(line);
    return mismatches.length ? [`${line.lineId} (${line.state}): ${mismatches.join(", ")}`] : [];
  });
  const checks = [
    {
      id: "balanceCoversObligations",
      status: balance >= totalSponsorObligations ? "PASS" : "FAIL",
      detail:
        balance < totalSponsorObligations
          ? `CAP-02 broken: balance ${balance} is ${totalSponsorObligations - balance} below totalSponsorObligations ${totalSponsorObligations}`
          : surplus === 0n
            ? `balance ${balance} equals totalSponsorObligations`
            : `balance ${balance} covers totalSponsorObligations ${totalSponsorObligations} with a surplus of ${surplus}: USDC sent to the Float outside its functions, which no function can move out`,
    },
    {
      id: "obligationsEqualLines",
      status: totalSponsorObligations === obligationsOfLines ? "PASS" : "FAIL",
      detail: `totalSponsorObligations ${totalSponsorObligations}; sum over ${lines.length} lines of availableReserve + recoveryAvailable ${obligationsOfLines}`,
    },
    {
      id: "committedCapitalEqualsLines",
      status: totalCommittedCapital === committedOfLines ? "PASS" : "FAIL",
      detail: `totalCommittedCapital ${totalCommittedCapital}; sum over ${lines.length} lines of availableReserve + principalOutstanding + recoveryAvailable ${committedOfLines}`,
    },
    {
      id: "linesMatchReserveCap",
      status: broken.length ? "FAIL" : "PASS",
      detail: broken.length
        ? `${broken.length} of ${lines.length} lines break their identity with reserveCap: ${broken.join("; ")}`
        : `each of the ${lines.length} lines matches its reserveCap for its state`,
    },
  ];
  return { ok: checks.every((entry) => entry.status === "PASS"), surplus, sums, checks };
}

async function reconcile(values) {
  requireManifest(values);
  const connection = await connect(values, { readOnly: true });
  const pinned = await connection.client.getBlock();
  const at = (functionName, args) => read(connection, functionName, args, pinned.number);
  const found = await discover(connection, values.index, pinned);
  const usdc = await at("usdc");
  const totalSponsorObligations = await at("totalSponsorObligations");
  const totalCommittedCapital = await at("totalCommittedCapital");
  const balance = await connection.client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [connection.address],
    blockNumber: pinned.number,
  });
  const lines = [];
  for (const lineId of found.lineIds) {
    const line = await readLine(connection, lineId, pinned.number);
    const { reserveCap, availableReserve, principalOutstanding, recoveryAvailable } = line;
    lines.push({
      lineId,
      state: stateName(line),
      reserveCap,
      availableReserve,
      principalOutstanding,
      recoveryAvailable,
      sponsorClaimed: found.sponsorClaimed.get(lineId),
    });
  }
  await stillCanonical(connection, pinned);
  return {
    observedAt: observed(pinned),
    address: connection.address,
    usdc,
    balance,
    totalSponsorObligations,
    totalCommittedCapital,
    ...reconcileState({ balance, totalSponsorObligations, totalCommittedCapital, lines }),
    discovery: { lines: lines.length, index: found.index, scanned: found.scanned },
    lines,
  };
}

const COMMANDS = {
  check: {
    options: {
      index: { type: "string" },
      "warn-before": { type: "string" },
      "max-index-lag": { type: "string" },
      "line-id": { type: "string", multiple: true },
    },
    run: check,
  },
  reconcile: { options: { index: { type: "string" } }, run: reconcile },
};
const TOOL = "node app/scripts/float-mainnet-monitor.mjs";
const USAGE = [
  `${TOOL} check --manifest <path> [--index <index.json>] [--warn-before <seconds>] [--max-index-lag <seconds>] [--line-id <bytes32> ...]`,
  `${TOOL} reconcile --manifest <path> [--index <index.json>]`,
  "Both read one pinned block and discover events with a complete canonical log scan from deployment. --index (float-mainnet-indexer.mjs) supplies checkpoint lag/reorg diagnostics only; cached events never determine alerts or reconciliation.",
  `check reports each line, the pauses, pending cap increases, operators and owner, and alerts: DEFAULT_ELIGIBLE and DISCOVERY_INCOMPLETE (critical: exit 1), MATURITY_SOON, LINE_EXPIRY_SOON, POLICY_EXPIRY_SOON, SPENDS_PAUSED, OPENINGS_PAUSED, CAP_INCREASE_PENDING, OWNERSHIP_PENDING, OPERATOR_CHANGED, PROTOCOL_CAP_EXCEEDED, SPONSOR_REMOVED, INDEX_LAG. --warn-before (default ${DEFAULT_WARN_BEFORE}) is the warning horizon in seconds for maturities, expiries and the end of purchases before a line's expiry; --max-index-lag (default ${DEFAULT_MAX_INDEX_LAG}) is the largest index lag in seconds before INDEX_LAG; --line-id limits the lines checked and skips the DISCOVERY_INCOMPLETE guard.`,
  "reconcile compares the Float's USDC balance with totalSponsorObligations (CAP-02, surplus reported), totalSponsorObligations with the lines' availableReserve + recoveryAvailable, totalCommittedCapital with their availableReserve + principalOutstanding + recoveryAvailable, and each line with its reserveCap for its state (a DEFAULTED line with its SponsorClaimed amounts); any mismatch exits 1.",
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
