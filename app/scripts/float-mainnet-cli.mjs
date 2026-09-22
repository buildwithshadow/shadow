import { parseArgs } from "node:util";
import { encodeFunctionData, erc20Abi, getAddress, isAddress, isAddressEqual, isHex, keccak256, parseEventLogs, size } from "viem";
import {
  BLOCK_REASONS,
  LINE_STATES,
  connectCandidate,
  endpointHashFrom,
  floatAbi,
  printJson,
  readDeployment,
  revertName,
  walletFromEnv,
} from "./float-mainnet-config.mjs";
import { errorMessage } from "./float-mainnet-preflight.mjs";

// CLI plumbing shared by the ShadowFloatMainnet candidate participant tools:
// flag parsing, connection, dry-run / --execute / --calldata writes, event
// decoding, chunked log scans and the next-spend capacity mirror.

const DAY = 86_400n;
// Arc RPCs reject eth_getLogs over wide ranges, so every scan is chunked.
const LOG_CHUNK_BLOCKS = 5_000n;
// Without --from-block or a manifest, a digest lookup scans back at most this
// many blocks from the head.
export const MAX_LOOKBACK_BLOCKS = 1_000_000n;
const ENV_USAGE =
  "env: ARC_RPC_URL, FLOAT_MAINNET_EXPECTED_CHAIN_ID, and FLOAT_MAINNET_ADDRESS or --manifest <release manifest> (must have ok: true, the same chain id and the on-chain runtime code hash)";

export const WRITE_OPTIONS = {
  execute: { type: "boolean" },
  calldata: { type: "boolean" },
  from: { type: "string" },
};

export class UsageError extends Error {}

// A transaction that was signed and handed to the RPC but did not end in a
// mined success. status is "unknown" (the send or the wait failed, so it may
// still land) or "reverted". It is never resent.
export class SendFailure extends Error {
  constructor(message, { status, txHash, txHashes, detail }) {
    super(message);
    Object.assign(this, { status, txHash, txHashes, detail });
  }
}

// An RPC error with the node's own message, which viem keeps in `details`.
export function rpcErrorDetail(error) {
  return `${errorMessage(error)}${error?.details ? `; RPC said: ${errorMessage(error.details)}` : ""}`;
}

export function parseUint(label, raw, bits = 256, Failure = UsageError) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Failure(`${label} must be an unsigned decimal integer string`);
  const value = BigInt(raw);
  if (value >= 1n << BigInt(bits)) throw new Failure(`${label} exceeds uint${bits}`);
  return value;
}

// Strict: lowercase, or a valid EIP-55 checksum when mixed-case.
export function parseAddress(label, raw, Failure = UsageError) {
  if (typeof raw !== "string" || !isAddress(raw)) {
    throw new Failure(`${label} must be a 20-byte hex address (lowercase, or checksummed when mixed-case)`);
  }
  return getAddress(raw);
}

export function parseBytes32(label, raw, Failure = UsageError) {
  if (typeof raw !== "string" || !isHex(raw, { strict: true }) || raw.length !== 66) throw new Failure(`${label} must be a 0x-prefixed bytes32`);
  return raw.toLowerCase();
}

export function parseSignature(label, raw, Failure = UsageError) {
  if (typeof raw !== "string" || !isHex(raw, { strict: true }) || raw.length % 2 !== 0 || size(raw) === 0) {
    throw new Failure(`${label} must be 0x-prefixed hex bytes`);
  }
  return raw.toLowerCase();
}

export function required(values, name) {
  const raw = values[name];
  if (raw === undefined || raw === "") throw new UsageError(`--${name} is required`);
  return raw;
}

export function addressFlag(values, name) {
  return parseAddress(`--${name}`, required(values, name));
}

export function uintFlag(values, name, bits = 256) {
  return parseUint(`--${name}`, required(values, name), bits);
}

export function bytes32Flag(values, name) {
  return parseBytes32(`--${name}`, required(values, name));
}

// --from-block <n>: the lower bound of a log scan, or null.
export function fromBlockFlag(values) {
  return values["from-block"] === undefined ? null : uintFlag(values, "from-block", 64);
}

// Unix seconds, or +<seconds> after the latest block. Resolved once the
// latest block is known, never against the wall clock.
export function timeFlag(values, name) {
  const raw = required(values, name);
  const match = /^(\+?)(\d+)$/.exec(raw);
  if (!match) throw new UsageError(`--${name} must be unix seconds or +<seconds> after the latest block`);
  return (now) => {
    const value = match[1] ? now + BigInt(match[2]) : BigInt(match[2]);
    if (value >= 2n ** 64n) throw new UsageError(`--${name} resolves beyond uint64`);
    return value;
  };
}

// A duration: bare seconds, no sign.
export function durationFlag(values, name) {
  const raw = required(values, name);
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a number of seconds`);
  const value = BigInt(raw);
  if (value >= 2n ** 64n) throw new UsageError(`--${name} exceeds uint64`);
  return value;
}

export function endpointFlag(values) {
  try {
    return endpointHashFrom({ endpoint: values.endpoint, endpointHash: values["endpoint-hash"] });
  } catch (error) {
    throw new UsageError(error.message);
  }
}

export function connect(values) {
  return connectCandidate(readDeployment(process.env, { manifest: values.manifest }));
}

// dry-run (default) simulates from the key's address; --execute sends;
// --calldata --from <addr> needs no key and prints calls for a Safe, a smart
// account or any other wallet to send.
export function writeMode(values) {
  if (values.calldata) {
    if (values.execute) throw new UsageError("--calldata and --execute are exclusive");
    return { mode: "calldata", from: addressFlag(values, "from") };
  }
  if (values.from !== undefined) throw new UsageError("--from is only used with --calldata");
  return { mode: values.execute ? "execute" : "dry-run" };
}

export function signerFor(connection, { mode, from }, keyName) {
  if (mode === "calldata") return { mode, address: from };
  const { account, wallet } = walletFromEnv(connection, keyName);
  return { mode, address: account.address, account, wallet };
}

export async function latestBlock(connection) {
  const { number, timestamp } = await connection.client.getBlock();
  return { number, timestamp };
}

export function read(connection, functionName, args = [], blockNumber) {
  return connection.client.readContract({ address: connection.address, abi: floatAbi, functionName, args, blockNumber });
}

export function stateName(line) {
  return LINE_STATES[Number(line.state)];
}

export async function readLine(connection, lineId, blockNumber) {
  const line = await read(connection, "getLine", [lineId], blockNumber);
  if (stateName(line) === "NONE") throw new Error(`no line ${lineId} on ${connection.address}`);
  return line;
}

export async function readPolicy(connection, lineId, provider, blockNumber) {
  const [endpointHash, expiry, day, active, perSpendCap, dailySpendCap, spentToday] = await read(
    connection,
    "providerPolicies",
    [lineId, provider],
    blockNumber,
  );
  return { endpointHash, expiry, day, active, perSpendCap, dailySpendCap, spentToday };
}

export async function readLimits(connection, blockNumber) {
  const [protocolReserve, lineReserve, lineSpend, perSpend, dailySpend] = await read(connection, "effectiveLimits", [], blockNumber);
  return { protocolReserve, lineReserve, lineSpend, perSpend, dailySpend };
}

// The Float pulls USDC with transferFrom, so the payer approves exactly the
// amount first, and only when the current allowance is short.
export async function usdcFunding(connection, payer, amount) {
  const usdc = await read(connection, "usdc");
  const token = (functionName, args) => connection.client.readContract({ address: usdc, abi: erc20Abi, functionName, args });
  const [balance, allowance] = await Promise.all([token("balanceOf", [payer]), token("allowance", [payer, connection.address])]);
  const approval =
    allowance < amount ? { address: usdc, abi: erc20Abi, functionName: "approve", args: [connection.address, amount] } : null;
  return { usdc, balance, allowance, approval };
}

export function failIf(problems) {
  if (problems.length) throw new Error(problems.join("; "));
}

export function eventRecord(log) {
  const args = log.eventName === "SpendBlocked" ? { ...log.args, reasonName: BLOCK_REASONS[log.args.reason] } : log.args;
  return {
    event: log.eventName,
    args,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    transactionHash: log.transactionHash,
  };
}

function eventItem(eventName) {
  return floatAbi.find((item) => item.type === "event" && item.name === eventName);
}

// Every matching log in [fromBlock, toBlock], oldest first.
export async function findLogs(connection, eventName, args, fromBlock, toBlock) {
  const event = eventItem(eventName);
  const logs = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK_BLOCKS) {
    const to = from + LOG_CHUNK_BLOCKS - 1n < toBlock ? from + LOG_CHUNK_BLOCKS - 1n : toBlock;
    logs.push(...(await connection.client.getLogs({ address: connection.address, event, args, fromBlock: from, toBlock: to })));
  }
  return logs;
}

// The latest matching log, scanning back from toBlock one chunk at a time and
// stopping at the first chunk with a match: for events keyed by a unique
// digest. fromBlock null means MAX_LOOKBACK_BLOCKS back from toBlock.
export async function findLatestLog(connection, eventName, args, { fromBlock, toBlock }) {
  const floor = fromBlock ?? (toBlock >= MAX_LOOKBACK_BLOCKS ? toBlock - MAX_LOOKBACK_BLOCKS + 1n : 0n);
  const event = eventItem(eventName);
  for (let to = toBlock; to >= floor; ) {
    const from = to - floor >= LOG_CHUNK_BLOCKS ? to - LOG_CHUNK_BLOCKS + 1n : floor;
    const logs = await connection.client.getLogs({ address: connection.address, event, args, fromBlock: from, toBlock: to });
    if (logs.length) return { log: logs.at(-1), fromBlock: floor, toBlock };
    to = from - 1n;
  }
  return { log: null, fromBlock: floor, toBlock };
}

// Why no principal can pass at all, as [label, binding], or null. Checked in
// the order remainingCapacity has always reported them.
function noCapacity({ now, line, policy, effectiveLimits, totalCommittedCapital, spendsPaused, sponsorAllowed, minimumRepaymentWindow }) {
  const state = stateName(line);
  if (state !== "OPEN") return [`LINE_${state}`, "line.state"];
  // A dueAt must satisfy now + minimumRepaymentWindow <= dueAt <= line.expiry.
  if (now > line.expiry) return ["LINE_EXPIRED", "line.expiry"];
  if (now + minimumRepaymentWindow > line.expiry) return ["NO_DUE_DATE_BEFORE_EXPIRY", "line.expiry"];
  if (spendsPaused) return ["SPENDS_PAUSED", "spendsPaused"];
  if (!sponsorAllowed) return ["SPONSOR_NOT_ALLOWED", "sponsorAllowed"];
  if (!policy.active) return ["PROVIDER_NOT_ALLOWED", "policy.active"];
  if (now > policy.expiry) return ["PROVIDER_NOT_ALLOWED", "policy.expiry"];
  if (totalCommittedCapital > effectiveLimits.protocolReserve) return ["PROTOCOL_CAP", "effectiveLimits.protocolReserve"];
  if (line.reserveCap > effectiveLimits.lineReserve) return ["LINE_RESERVE_CAP", "effectiveLimits.lineReserve"];
  return null;
}

// The principal checks of _blockReason, in its order, as [BlockReason,
// binding, largest principal the check lets through]. The contract's
// `principal > effectiveLimits.lineSpend` is implied by the cumulative
// effective lineSpend check.
function amountLimits({ now, line, policy, effectiveLimits }) {
  const today = now / DAY;
  const lineSpent = line.day === today ? line.spentToday : 0n;
  const providerSpent = policy.day === today ? policy.spentToday : 0n;
  const left = (cap, used) => (cap > used ? cap - used : 0n);
  return [
    ["LINE_RESERVE_CAP", "line.availableReserve", line.availableReserve],
    ["LINE_SPEND_CAP", "line.lineSpendCap", left(line.lineSpendCap, line.cumulativePrincipalPaid)],
    ["LINE_SPEND_CAP", "effectiveLimits.lineSpend", left(effectiveLimits.lineSpend, line.cumulativePrincipalPaid)],
    ["PER_SPEND_CAP", "policy.perSpendCap", policy.perSpendCap],
    ["PER_SPEND_CAP", "effectiveLimits.perSpend", effectiveLimits.perSpend],
    ["DAILY_SPEND_CAP", "line.dailySpendCap", left(line.dailySpendCap, lineSpent)],
    ["DAILY_SPEND_CAP", "effectiveLimits.dailySpend", left(effectiveLimits.dailySpend, lineSpent)],
    ["DAILY_SPEND_CAP", "policy.dailySpendCap", left(policy.dailySpendCap, providerSpent)],
  ];
}

// The largest principal the next SpendIntent for this provider can carry
// without a revert or a SpendBlocked, mirroring executeSpend and _blockReason in
// ShadowFloatMainnet.sol. It is exact for a spend executed at `now` (the block
// the inputs were read at) and only a snapshot for any later block: the UTC day
// rollover, expiries, pauses and cap, policy or allowlist changes move it.
// `limitedBy` is the reason a principal of nextSpendMax + 1 fails first: a
// BlockReason name, or LINE_<state>, LINE_EXPIRED and NO_DUE_DATE_BEFORE_EXPIRY
// for the checks that revert before _blockReason. `binding` names the exact
// term. All values are bigints.
export function remainingCapacity(input) {
  const none = noCapacity(input);
  if (none) return { nextSpendMax: 0n, limitedBy: none[0], binding: none[1] };
  const [limitedBy, binding, nextSpendMax] = amountLimits(input).reduce((best, entry) => (entry[2] < best[2] ? entry : best));
  return { nextSpendMax, limitedBy, binding };
}

// What executeSpend records for `intent` at `now`, given that it passes the
// revert checks (binding, terms, nonce, signature, dueAt window): outcome
// "pay" (reason NONE) or "block" with the BlockReason _blockReason returns for
// this principal, which can precede `limitedBy` for a principal well above
// nextSpendMax. "revert" when the line itself cannot be drawn.
export function predictSpend(input, intent) {
  const capacity = remainingCapacity(input);
  const none = noCapacity(input);
  const exceeds = `principal ${intent.principal} exceeds nextSpendMax ${capacity.nextSpendMax} (limitedBy ${capacity.limitedBy}, binding ${capacity.binding})`;
  if (none && (!BLOCK_REASONS.includes(none[0]) || none[0] === "LINE_EXPIRED")) {
    return { outcome: "revert", reason: none[0], detail: `the line cannot be drawn (${none[0]})`, ...capacity };
  }
  let reason = "NONE";
  let detail = `principal ${intent.principal} is within nextSpendMax ${capacity.nextSpendMax}`;
  if (none && ["SPENDS_PAUSED", "SPONSOR_NOT_ALLOWED", "PROVIDER_NOT_ALLOWED"].includes(none[0])) {
    [reason, detail] = [none[0], exceeds];
  } else if (intent.endpointHash !== input.policy.endpointHash) {
    reason = "ENDPOINT_NOT_ALLOWED";
    detail = `endpoint hash ${intent.endpointHash} is not the endpoint approved for provider ${intent.provider} (${input.policy.endpointHash})`;
  } else if (none) {
    [reason, detail] = [none[0], exceeds];
  } else {
    const hit = amountLimits(input).find(([, , max]) => intent.principal > max);
    if (hit) [reason, detail] = [hit[0], exceeds];
  }
  return { outcome: reason === "NONE" ? "pay" : "block", reason, detail, ...capacity };
}

// Only an approval ever precedes another call in a batch. eth_call does not
// carry state between calls (and eth_simulateV1 is not on every Arc RPC), so a
// dry run simulates the first call only; the dependent call is covered by the
// explicit pre-checks and --execute simulates it again once the approval is mined.
// --execute signs each transaction before broadcasting it, so its hash is known
// even when the send or the wait fails; such a transaction is reported with
// status "unknown" and never resent.
// check(call, result), when given, runs on the last simulation before a call is
// signed (or printed as calldata) and throws to stop it.
export async function runCalls(connection, signer, calls, { simulate = true, check } = {}) {
  const { client } = connection;
  if (signer.mode !== "execute") {
    const [first, ...dependent] = calls;
    if (signer.mode === "calldata") {
      if (simulate) {
        const { result } = await client.simulateContract({ ...first, account: signer.address });
        check?.(first, result);
      }
      return { ok: true, calls: calls.map((call) => ({ to: call.address, value: "0", data: encodeFunctionData(call) })) };
    }
    const { result } = await client.simulateContract({ ...first, account: signer.address });
    return {
      ok: true,
      dryRun: true,
      calls: calls.map((call) => ({
        to: call.address,
        functionName: call.functionName,
        args: call.args,
        data: encodeFunctionData(call),
      })),
      simulation: [
        { functionName: first.functionName, status: "ok", result },
        ...dependent.map((call) => ({
          functionName: call.functionName,
          status: "skipped",
          reason: `depends on the ${first.functionName} in this batch; the pre-checks passed and --execute simulates it once that is mined`,
        })),
      ],
    };
  }

  const txHashes = [];
  const events = [];
  for (const call of calls) {
    let serializedTransaction;
    try {
      const { result } = await client.simulateContract({ ...call, account: signer.account });
      check?.(call, result);
      const request = await signer.wallet.prepareTransactionRequest({
        account: signer.account,
        to: call.address,
        data: encodeFunctionData(call),
      });
      serializedTransaction = await signer.wallet.signTransaction(request);
    } catch (error) {
      error.txHashes = [...txHashes];
      throw error;
    }
    const txHash = keccak256(serializedTransaction);
    txHashes.push(txHash);
    let receipt;
    try {
      await signer.wallet.sendRawTransaction({ serializedTransaction });
      receipt = await client.waitForTransactionReceipt({ hash: txHash });
    } catch (error) {
      const detail = rpcErrorDetail(error);
      throw new SendFailure(
        `the outcome of ${call.functionName} transaction ${txHash} is unknown (${detail}). Nothing is resent automatically: look ${txHash} up before re-running`,
        { status: "unknown", txHash, txHashes, detail },
      );
    }
    if (receipt.status !== "success") {
      throw new SendFailure(`${call.functionName} transaction ${txHash} reverted onchain`, { status: "reverted", txHash, txHashes });
    }
    const logs = receipt.logs.filter((log) => isAddressEqual(log.address, connection.address));
    events.push(...parseEventLogs({ abi: floatAbi, logs }).map(eventRecord));
  }
  return { ok: true, dryRun: false, txHashes, events };
}

// Everything a tool reads or checks after a mined --execute goes through here.
// The transactions are final by then, so a failure (usually the RPC) is reported
// as status "sent" with every hash, never as a bare error: a blind re-run could
// repeat them, a second repay --amount for one.
export async function afterSend(output, follow) {
  try {
    return { ...output, ...(await follow()) };
  } catch (error) {
    return {
      ...output,
      ok: false,
      status: "sent",
      error: {
        message: `sent and mined: ${output.txHashes.join(", ")}; follow-up read failed: ${rpcErrorDetail(error)}; check these hashes before re-running`,
        revert: null,
      },
    };
  }
}

// Prints exactly one JSON object. Usage errors exit 2 and print the tool's
// full usage; a thrown error or a returned { ok: false } exits 1.
export function runCli(commands, usage, argv = process.argv.slice(2)) {
  const run = async () => {
    const [command, ...args] = argv;
    if (!Object.hasOwn(commands, command ?? "")) {
      throw new UsageError(command === undefined ? "a command is required" : `unknown command ${JSON.stringify(command)}`);
    }
    let values;
    try {
      ({ values } = parseArgs({
        args,
        options: { manifest: { type: "string" }, ...commands[command].options },
        strict: true,
        allowPositionals: false,
      }));
    } catch (error) {
      throw new UsageError(`${command}: ${error.message}`);
    }
    return commands[command].run(values);
  };
  return run().then(
    (result) => {
      printJson(result);
      if (result.ok !== true) process.exitCode = 1;
    },
    (error) => {
      const failure = { ok: false, error: { message: errorMessage(error), revert: revertName(error) } };
      if (error instanceof SendFailure) Object.assign(failure, { status: error.status, txHash: error.txHash });
      if (error?.txHashes?.length) failure.txHashes = error.txHashes;
      if (error instanceof UsageError) failure.usage = [...usage, ENV_USAGE];
      printJson(failure);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}
