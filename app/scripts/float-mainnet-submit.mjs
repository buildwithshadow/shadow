import { zeroAddress } from "viem";
import { BLOCK_REASONS, RECEIPT_STATUSES, floatAbi, revertName, walletFromEnv } from "./float-mainnet-config.mjs";
import {
  MAX_LOOKBACK_BLOCKS,
  SendFailure,
  UsageError,
  WRITE_OPTIONS,
  afterSend,
  connect,
  eventRecord,
  findLatestLog,
  fromBlockFlag,
  latestBlock,
  parseAddress,
  read,
  required,
  rpcErrorDetail,
  runCalls,
  runCli,
  signerFor,
  writeMode,
} from "./float-mainnet-cli.mjs";
import { checkSignature, readIntentFile } from "./float-mainnet-intent.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";
import { initializeExecutionSession, requireNamedMainnetExecutor, requireSessionPath, withExecutionSession } from "./float-mainnet-session.mjs";

// Executor-side submission of a signed ShadowFloatMainnet SpendIntent.
// receiptStatus[digest] is read first, so a repeated submit reports the
// recorded outcome and sends nothing. A send whose outcome is unknown is never
// retried automatically.

const KEY = "FLOAT_EXECUTOR_PRIVATE_KEY";

async function readReceiptState(connection, struct, digest) {
  const [status, nonceUsed, nonceCancelled] = await Promise.all([
    read(connection, "receiptStatus", [digest]),
    read(connection, "nonceUsed", [struct.lineId, struct.nonce]),
    read(connection, "nonceCancelled", [struct.lineId, struct.nonce]),
  ]);
  return { status, nonceUsed, nonceCancelled };
}

// The outcome already recorded for this digest. receiptStatus is authoritative;
// the ProviderPaid / SpendBlocked log is looked up for reference only, back
// from the head in chunks, so a failed or exhausted lookup is reported with a
// hint instead of failing the command.
async function recordedOutcome(connection, receiptStatus, digest, fromBlock) {
  const paid = receiptStatus === 2;
  const eventName = paid ? "ProviderPaid" : "SpendBlocked";
  const recorded = { status: paid ? "already-paid" : "already-blocked", reason: paid ? "NONE" : null, event: null };
  const bound = fromBlock === null ? `the last ${MAX_LOOKBACK_BLOCKS} blocks` : `blocks from ${fromBlock}`;
  try {
    const head = await connection.client.getBlockNumber();
    const { log } = await findLatestLog(connection, eventName, { digest }, { fromBlock, toBlock: head });
    if (log) {
      recorded.event = eventRecord(log);
      if (!paid) recorded.reason = recorded.event.args.reasonName;
      return recorded;
    }
    recorded.hint = `receiptStatus is ${RECEIPT_STATUSES[receiptStatus]} (authoritative), but no ${eventName} log for this digest is in ${bound}; pass --from-block <n> at or before the submission to find it`;
  } catch (error) {
    recorded.hint = `receiptStatus is ${RECEIPT_STATUSES[receiptStatus]} (authoritative); looking up its ${eventName} log in ${bound} failed (${rpcErrorDetail(error)}); retry, or narrow the scan with --from-block <n>`;
  }
  return recorded;
}

// eth_call of executeSpend from `account` (an address or a local account), at
// blockNumber (the latest block when undefined).
async function simulateSpend(connection, struct, digest, signature, account, blockNumber) {
  try {
    const { result } = await connection.client.simulateContract({
      address: connection.address,
      abi: floatAbi,
      functionName: "executeSpend",
      args: [struct, signature],
      account,
      blockNumber,
    });
    const [paid, reason] = result;
    return { outcome: paid ? "pay" : "block", reason: BLOCK_REASONS[reason] };
  } catch (error) {
    const revert = revertName(error);
    if (revert === null) throw error;
    const simulation = { outcome: "revert", error: revert };
    if (revert === "InvalidSignature") simulation.detail = (await checkSignature(connection, struct.agent, digest, signature)).detail;
    return simulation;
  }
}

function executorAddress(connection, struct, values) {
  const from = values.from === undefined ? null : parseAddress("--from", values.from);
  if (struct.executor !== zeroAddress) {
    if (from !== null && from !== struct.executor) throw new UsageError(`the intent names executor ${struct.executor}; only it can submit`);
    return struct.executor;
  }
  if (from !== null) return from;
  if (!process.env[KEY]?.trim()) throw new UsageError(`the intent allows any executor: pass --from <address> or set ${KEY}`);
  return walletFromEnv(connection, KEY).account.address;
}

function signedIntent(path, connection) {
  const intent = readIntentFile(path, connection);
  if (intent.signature === null) throw new Error("the intent file has no signature; run sign, or verify --signature <hex> --out <path>");
  return intent;
}

async function preflight(values) {
  const path = required(values, "intent");
  const fromBlock = fromBlockFlag(values);
  const connection = await connect(values);
  const { struct, digest, signature } = signedIntent(path, connection);
  requireNamedMainnetExecutor(connection, struct);
  const sessionPath = requireSessionPath(values, connection);
  let sessionReport;
  if (sessionPath) {
    sessionReport = await withExecutionSession(sessionPath, connection, async (session) => {
      await session.reconcile();
      session.check(struct, digest);
      return session.report();
    });
  }
  const from = executorAddress(connection, struct, values);
  const state = await readReceiptState(connection, struct, digest);
  const base = {
    ok: true,
    digest,
    from,
    receiptStatus: RECEIPT_STATUSES[state.status],
    nonceUsed: state.nonceUsed,
    nonceCancelled: state.nonceCancelled,
    ...(sessionReport ? { session: sessionReport } : {}),
  };
  if (state.status !== 0) {
    const { status, ...recorded } = await recordedOutcome(connection, state.status, digest, fromBlock ?? connection.deployBlock);
    return { ...base, outcome: status, ...recorded };
  }
  return { ...base, ...(await simulateSpend(connection, struct, digest, signature, from)) };
}

async function submit(values) {
  const path = required(values, "intent");
  const connection = await connect(values);
  const intent = signedIntent(path, connection);
  requireNamedMainnetExecutor(connection, intent.struct);
  const sessionPath = requireSessionPath(values, connection);
  if (!sessionPath) return submitConnected(values, connection, intent);
  return withExecutionSession(sessionPath, connection, async (session) => {
    await session.reconcile();
    const result = await submitConnected(values, connection, intent, session);
    return { ...result, session: session.report() };
  });
}

async function submitConnected(values, connection, { struct, digest, signature }, session = null) {
  const mode = writeMode(values);
  const fromBlock = fromBlockFlag(values);
  const prior = session?.check(struct, digest);
  if (prior?.status === "reverted") {
    return { ok: false, digest, status: "session-reverted", txHashes: [], txHash: prior.txHash, error: { message: "The original session transaction reverted. Its reservation remains consumed and this digest is never resent; review the cause before preparing another intent.", revert: null } };
  }
  const signer = signerFor(connection, mode, KEY);
  if (struct.executor !== zeroAddress && struct.executor !== signer.address) {
    const who = mode.mode === "calldata" ? "--from is" : `${KEY} belongs to`;
    throw new Error(`the intent names executor ${struct.executor}; ${who} ${signer.address}`);
  }
  const dryRun = mode.mode !== "execute";

  const state = await readReceiptState(connection, struct, digest);
  if (state.status !== 0) {
    if (session && !prior) {
      session.reserve(struct, digest);
      await session.reconcile();
    }
    return { ok: true, dryRun, digest, txHashes: [], ...(await recordedOutcome(connection, state.status, digest, fromBlock ?? connection.deployBlock)) };
  }

  // A Safe may execute --calldata much later: simulatedAt says when this held.
  const block = await latestBlock(connection);
  const simulatedAt = { blockNumber: block.number, timestamp: block.timestamp };
  const simulation = await simulateSpend(connection, struct, digest, signature, signer.account ?? signer.address, block.number);
  if (simulation.outcome === "revert") {
    return {
      ok: false,
      dryRun,
      status: "revert",
      digest,
      error: {
        message: `executeSpend would revert with ${simulation.error}${simulation.detail ? ` (${simulation.detail})` : ""}; nothing was sent`,
        revert: simulation.error,
      },
    };
  }
  // A recorded SpendBlocked uses up the nonce and pays nothing, so sending one
  // (or handing its calldata to a Safe) needs --allow-block; a dry run reports it.
  if (simulation.outcome === "block" && mode.mode !== "dry-run" && values["allow-block"] !== true) {
    return {
      ok: false,
      dryRun,
      status: "block",
      reason: simulation.reason,
      digest,
      error: {
        message: `executeSpend would record SpendBlocked(${simulation.reason}), using up the intent's nonce without paying the provider; nothing was sent. Pass --allow-block to record the refusal deliberately`,
        revert: null,
      },
    };
  }

  const call = { address: connection.address, abi: floatAbi, functionName: "executeSpend", args: [struct, signature] };
  // This fsynced reservation precedes any send or executable calldata output.
  // If signing/preparation fails or the process dies, hold until reconciled.
  if (session && mode.mode !== "dry-run") session.reserve(struct, digest);
  let result;
  try {
    // The pre-check above ran at a pinned block; state can move before the send.
    result = await runCalls(connection, signer, [call], {
      beforeSend: session ? ({ txHash }) => session.beforeSend(digest, txHash) : undefined,
      check:
        values["allow-block"] === true
          ? undefined
          : (_, [paid, reason]) => {
              if (!paid) {
                throw new Error(
                  `executeSpend would now record SpendBlocked(${BLOCK_REASONS[reason]}) at the latest block, using up the intent's nonce without paying the provider; nothing was sent. Pass --allow-block to record the refusal deliberately`,
                );
              }
            },
    });
  } catch (error) {
    if (!(error instanceof SendFailure)) throw error;
    if (session) {
      try { await session.reconcile(); } catch { /* Keep the durable reservation and original send error. */ }
    }
    // The RPC that lost the send is often still down: an unreadable
    // receiptStatus must not cost the user the hash and the guidance.
    let receiptStatus;
    let unreadable = "";
    try {
      receiptStatus = RECEIPT_STATUSES[(await readReceiptState(connection, struct, digest)).status];
    } catch (readError) {
      receiptStatus = "unreadable";
      unreadable = ` (reading it failed: ${rpcErrorDetail(readError)})`;
    }
    // A reverted executeSpend records nothing itself; a paid or blocked
    // receiptStatus then means another submission recorded the digest first.
    const message =
      error.status === "unknown"
        ? `the outcome of ${error.txHash} is unknown (${error.detail}); receiptStatus is now "${receiptStatus}"${unreadable}. Nothing is resent automatically. ${session ? "The durable session holds this reservation; run reconcile-session before continuing. This digest is never resent by the session." : `Check ${error.txHash} (or run float-mainnet-line.mjs receipt --digest ${digest}) before re-running submit. A second payment is impossible: once this spend is recorded, receiptStatus and the used nonce make a duplicate executeSpend revert`}`
        : `transaction ${error.txHash} recorded no outcome; receiptStatus is ${receiptStatus}${unreadable}`;
    return {
      ok: false,
      dryRun,
      status: error.status,
      digest,
      txHash: error.txHash,
      txHashes: error.txHashes,
      receiptStatus,
      error: { message, revert: null },
    };
  }
  if (mode.mode !== "execute") return { ...result, digest, simulation, simulatedAt };

  const txHash = result.txHashes[0];
  return afterSend({ ...result, digest, txHash }, async () => {
    if (session) await session.reconcile();
    const paid = result.events.find((entry) => entry.event === "ProviderPaid" && entry.args.digest === digest);
    const blocked = result.events.find((entry) => entry.event === "SpendBlocked" && entry.args.digest === digest);
    if (!paid && !blocked) throw new Error(`transaction ${txHash} succeeded without a ProviderPaid or SpendBlocked event for ${digest}`);
    const outcome = { status: paid ? "paid" : "blocked", reason: paid ? "NONE" : blocked.args.reasonName };
    if (paid) {
      outcome.providerPaid = {
        blockNumber: paid.blockNumber,
        dueAt: paid.args.dueAt,
        lineId: paid.args.lineId,
        principal: paid.args.principal,
        provider: paid.args.provider,
        transactionHash: paid.transactionHash,
      };
    }
    return outcome;
  });
}

const SESSION_OPTIONS = { session: { type: "string" } };
const INTENT_OPTIONS = { intent: { type: "string" }, "from-block": { type: "string" }, ...SESSION_OPTIONS };
const COMMANDS = {
  "init-session": { options: SESSION_OPTIONS, run: async (values) => initializeExecutionSession(required(values, "session"), await connect(values)) },
  "reconcile-session": { options: SESSION_OPTIONS, run: async (values) => withExecutionSession(required(values, "session"), await connect(values), async (session) => {
    const report = await session.reconcile();
    return { ok: report.pending.length === 0, status: report.pending.length ? "session-held" : "session-reconciled", session: report,
      ...(report.pending.length ? { error: { message: "Original outcome remains unresolved. No new submission or resend is allowed; preserve this ledger and reconcile the original digest/transaction.", revert: null } } : {}) };
  }) },
  preflight: { options: { ...INTENT_OPTIONS, from: { type: "string" } }, run: preflight },
  submit: { options: { ...INTENT_OPTIONS, ...WRITE_OPTIONS, "allow-block": { type: "boolean" } }, run: submit },
};
const TOOL = "node app/scripts/float-mainnet-submit.mjs";
const USAGE = [
  `${TOOL} init-session --session <policy.json> [--manifest <path>]`,
  `${TOOL} reconcile-session --session <policy.json> [--manifest <path>]`,
  `${TOOL} preflight --intent <signed.json> [--session <policy.json>] [--from <executor>] [--from-block <n>] [--manifest <path>]`,
  `${TOOL} submit --intent <signed.json> [--session <policy.json>] [--execute | --calldata --from <executor>] [--allow-block] [--from-block <n>] [--manifest <path>]`,
  `submit signs with ${KEY} (never printed); without --execute it only simulates, and reports simulatedAt (the block the simulation ran at). --calldata --from <executor> needs no key and prints the executeSpend call for a Safe or contract executor.`,
  "A simulated SpendBlocked (nonce used, provider not paid) is sent, or printed as calldata, only with --allow-block.",
  `An already-recorded digest is reported, never resent; its event is looked up back from the head (--from-block or the manifest's deployment block bounds it, else ${MAX_LOOKBACK_BLOCKS.toString()} blocks).`,
  "Arc mainnet requires --session <policy.json> and an exact nonzero executor. Testnet can opt in. Initialize the ledger once; all processes must share it. Every attempted digest permanently reserves gross principal across epochs, including blocked/reverted attempts. Uncertain attempts hold new submissions until reconciled; no automatic reset or resend.",
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
