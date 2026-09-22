import { zeroHash } from "viem";
import { RECEIPT_STATUSES } from "./float-mainnet-config.mjs";
import {
  MAX_LOOKBACK_BLOCKS,
  UsageError,
  addressFlag,
  bytes32Flag,
  connect,
  eventRecord,
  findLatestLog,
  findLogs,
  fromBlockFlag,
  latestBlock,
  read,
  readLimits,
  readLine,
  readPolicy,
  remainingCapacity,
  rpcErrorDetail,
  runCli,
  stateName,
} from "./float-mainnet-cli.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

// Line status and receipt lookup for the ShadowFloatMainnet candidate.

const DAY = 86_400n;

async function status(values) {
  const byId = values["line-id"] !== undefined;
  if (byId === (values.sponsor !== undefined || values.agent !== undefined)) {
    throw new UsageError("pass --line-id <bytes32>, or --sponsor <address> --agent <address>");
  }
  const lineIdArg = byId ? bytes32Flag(values, "line-id") : null;
  const pair = byId ? null : [addressFlag(values, "sponsor"), addressFlag(values, "agent")];
  const provider = values.provider === undefined ? null : addressFlag(values, "provider");
  const fromBlockArg = fromBlockFlag(values);
  if (!provider && fromBlockArg === null && values.manifest === undefined) {
    throw new UsageError(
      "listing a line's providers scans ProviderPolicySet logs and needs a start block: pass --from-block <n> (the Float's deployment block or later), --manifest <release manifest>, or --provider <addr>",
    );
  }

  const connection = await connect(values);
  const fromBlock = fromBlockArg ?? connection.deployBlock;
  const block = await latestBlock(connection);
  const at = (functionName, args) => read(connection, functionName, args, block.number);
  const lineId = byId ? lineIdArg : await at("activeLineId", pair);
  if (lineId === zeroHash) throw new Error(`no line has been opened for sponsor ${pair[0]} and agent ${pair[1]}`);
  const line = await readLine(connection, lineId, block.number);
  const [effectiveLimits, totalCommittedCapital, spendsPaused, sponsorAllowed, minimumRepaymentWindow, matured] = await Promise.all([
    readLimits(connection, block.number),
    at("totalCommittedCapital"),
    at("spendsPaused"),
    at("sponsorAllowed", [line.sponsor]),
    at("minimumRepaymentWindow"),
    at("isMatured", [lineId]),
  ]);

  let providers = [provider];
  if (!provider) {
    const logs = await findLogs(connection, "ProviderPolicySet", { lineId }, fromBlock, block.number);
    providers = [...new Set(logs.map((log) => log.args.provider))];
    if (!providers.length) {
      throw new Error(
        `no ProviderPolicySet log for line ${lineId} in blocks ${fromBlock}-${block.number}; pass an earlier --from-block or --provider`,
      );
    }
  }
  const now = block.timestamp;
  const today = now / DAY;
  const policies = await Promise.all(
    providers.map(async (address) => {
      const policy = await readPolicy(connection, lineId, address, block.number);
      return {
        provider: address,
        endpointHash: policy.endpointHash,
        active: policy.active,
        expiry: policy.expiry,
        perSpendCap: policy.perSpendCap,
        dailySpendCap: policy.dailySpendCap,
        spentToday: policy.day === today ? policy.spentToday : 0n,
        termsHash: await at("currentTermsHash", [lineId, address]),
        remaining: remainingCapacity({
          now,
          line,
          policy,
          effectiveLimits,
          totalCommittedCapital,
          spendsPaused,
          sponsorAllowed,
          minimumRepaymentWindow,
        }),
      };
    }),
  );

  const drawn = stateName(line) === "DRAWN";
  return {
    ok: true,
    observedAt: { blockNumber: block.number, timestamp: now },
    remainingExactAt:
      "observedAt: providers[].remaining is exact for a spend in that block only, a snapshot, not a promise for a later one (the UTC day rollover, expiries, pauses and cap, policy or allowlist changes move it)",
    lineId,
    state: stateName(line),
    sponsor: line.sponsor,
    agent: line.agent,
    epoch: line.epoch,
    termsVersion: line.termsVersion,
    reserveCap: line.reserveCap,
    availableReserve: line.availableReserve,
    principalOutstanding: line.principalOutstanding,
    recoveryAvailable: line.recoveryAvailable,
    lineSpendCap: line.lineSpendCap,
    cumulativePrincipalPaid: line.cumulativePrincipalPaid,
    dailySpendCap: line.dailySpendCap,
    spentToday: line.day === today ? line.spentToday : 0n,
    dueAt: line.dueAt,
    matured,
    secondsUntilDue: drawn ? (line.dueAt > now ? line.dueAt - now : 0n) : null,
    expiry: line.expiry,
    maximumRepaymentWindow: line.maximumRepaymentWindow,
    sponsorAllowed,
    spendsPaused,
    providers: policies,
  };
}

async function receipt(values) {
  const digest = bytes32Flag(values, "digest");
  const fromBlockArg = fromBlockFlag(values);
  const connection = await connect(values);
  const block = await latestBlock(connection);
  const receiptStatus = RECEIPT_STATUSES[Number(await read(connection, "receiptStatus", [digest], block.number))];
  const result = { ok: true, observedAt: { blockNumber: block.number, timestamp: block.timestamp }, digest, receiptStatus };
  if (receiptStatus === "none") return { ...result, event: null };

  // receiptStatus is authoritative; its log is for reference only, so a lookup
  // that finds nothing or fails is reported with a hint, as submit does.
  const eventName = receiptStatus === "paid" ? "ProviderPaid" : "SpendBlocked";
  const lowerBound = fromBlockArg ?? connection.deployBlock;
  try {
    const { log, fromBlock } = await findLatestLog(connection, eventName, { digest }, { fromBlock: lowerBound, toBlock: block.number });
    if (log) return { ...result, event: eventRecord(log) };
    return {
      ...result,
      event: null,
      hint: `receiptStatus is ${receiptStatus} (authoritative), but no ${eventName} log for this digest is in blocks ${fromBlock}-${block.number}; pass an earlier --from-block`,
    };
  } catch (error) {
    const bound = lowerBound === null ? `the last ${MAX_LOOKBACK_BLOCKS} blocks` : `blocks ${lowerBound}-${block.number}`;
    return {
      ...result,
      event: null,
      hint: `receiptStatus is ${receiptStatus} (authoritative); looking up its ${eventName} log in ${bound} failed (${rpcErrorDetail(error)}); retry, or narrow the scan with --from-block <n>`,
    };
  }
}

const COMMANDS = {
  status: {
    options: {
      "from-block": { type: "string" },
      "line-id": { type: "string" },
      sponsor: { type: "string" },
      agent: { type: "string" },
      provider: { type: "string" },
    },
    run: status,
  },
  receipt: { options: { "from-block": { type: "string" }, digest: { type: "string" } }, run: receipt },
};
const TOOL = "node app/scripts/float-mainnet-line.mjs";
const USAGE = [
  `${TOOL} status (--line-id <bytes32> | --sponsor <addr> --agent <addr>) [--provider <addr>] [--from-block <n>] [--manifest <path>]`,
  `${TOOL} receipt --digest <bytes32> [--from-block <n>] [--manifest <path>]`,
  "Without --provider, status lists every provider from ProviderPolicySet logs scanned forward from --from-block (default: the manifest's deployment block); one is required.",
  `receipt scans back from the head, ${MAX_LOOKBACK_BLOCKS.toString()} blocks at most unless --from-block or a manifest gives the lower bound. receiptStatus is authoritative: a log lookup that finds nothing or fails gives event null and a hint.`,
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
