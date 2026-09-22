import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BlockNotFoundError,
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { BLOCK_REASONS, LINE_STATES, connectCandidate, floatAbi, printJson, readDeployment, revertName } from "./float-mainnet-config.mjs";
import { MAX_LOOKBACK_BLOCKS, UsageError, findLogs, parseAddress, parseBytes32, parseUint, read, readPolicy, required, rpcErrorDetail } from "./float-mainnet-cli.mjs";
import { intentDigest, messageFromStruct, validateIntentFile, writeJsonFile } from "./float-mainnet-intent.mjs";
import { IMMUTABLE_GETTERS, decodeImmutables, immutableRanges, immutableWord, maskImmutables } from "./float-mainnet-manifest.mjs";
import { ACCEPTANCE_KIND, DELIVERY_KIND, signatureAt, validateReceiptFile } from "./float-mainnet-provider.mjs";
import {
  EXPECTED_COMPILER,
  PINNED_SOURCE_COMMIT,
  compilerSettings,
  errorMessage,
  isEntrypoint,
  loadArtifact,
  pinnedLineageMismatches,
  readSourceState,
  runtimeBytes,
  sameJson,
} from "./float-mainnet-preflight.mjs";

// Independent verifier for a ShadowFloatMainnet candidate evidence bundle. It
// takes only the bundle's pointers (deployment, observation block, line,
// transaction hashes) and re-derives every claim from the chain: events,
// receipts, USDC transfers and contract state pinned to blocks. The deployment
// is anchored to a release manifest: the code at its address must be the local
// build of the pinned reviewed source, configured as the manifest records. Its
// provenance check shows only that the manifest's bytes are the file committed
// at HEAD in this checkout. Anyone can commit a manifest on a local branch, so
// the reviewer still confirms that the reported commit is on the reviewed
// upstream branch and that this checkout, which also supplies the pins and this
// verifier, is that branch. Signatures in the bundle (the agent's intents, the
// provider's receipts) are checked against the chain's code at a pinned block.
// Each spend and refusal sent directly to the Float carries its intent and the
// agent's signature in its executeSpend calldata: an intent file must equal it,
// and a missing one is recovered from it.
// Declared fields are reported verbatim and never scored. Any FAIL makes the
// report not ok (exit 1); MANUAL marks what the bundle does not let it check,
// and a report with any MANUAL check is not qualifying.

const BUNDLE_KIND = "ShadowFloatMainnet.EvidenceBundle";
const REPORT_KIND = "ShadowFloatMainnet.VerificationReport";
// The exporter's fixed label for the operator's declarations, written out here
// because the verifier does not import the exporter.
const DECLARED_LABEL = "declared by the operator; not verifiable on-chain";
const EXIT_EVENTS = { close: "LineClosed", "claim-defaulted": "SponsorClaimed" };
const SUMMARY_FIELDS = ["cycles", "cyclesCleared", "principalPaid", "principalRepaid", "refusals", "missingIntentFiles", "missingDeliveries"];
// The keys each bundle object may carry; any other key fails bundle.shape.
const KEYS = {
  bundle: ["kind", "schema", "deployment", "observedAt", "line", "cycles", "refusals", "exit", "declared", "exporterSummary", "verifierScope"],
  deployment: ["chainId", "address", "deployBlock", "runtimeKeccak256", "sourceCommit"],
  observedAt: ["blockNumber", "blockHash"],
  line: ["lineId", "sponsor", "agent", "epoch", "opened"],
  txPointer: ["txHash", "blockNumber"],
  cycle: ["index", "digest", "intent", "spend", "repayments", "cleared", "provider"],
  spend: ["txHash", "blockNumber", "executor"],
  repayment: ["txHash", "blockNumber", "payer", "amount"],
  provider: ["requestId", "acceptance", "delivery"],
  refusal: ["digest", "txHash", "blockNumber", "reason", "intent"],
  exit: ["kind", "txHash", "blockNumber", "amount"],
  declared: ["label", "independentControl", "customerPurpose", "assistance", "commercial"],
  exporterSummary: SUMMARY_FIELDS,
};
const NEVER_CHECKED = [
  "who controls each address, and whether the sponsor, agent, executor and provider are independent parties (declared only)",
  "what the provider delivered: resultHash and resultRef are the provider's signed commitment, and a DeliveryReceipt is the provider's own claim of delivery",
  "when the provider accepted or delivered: acceptedAt and deliveredAt are the provider's own claim in its signed receipts, compared only with the payment block's timestamp",
  "state between two transactions in one block: pre-spend state and signatures are read at the end of the block before the spend",
  "spends relayed through a contract (a Safe, a 4337 account or a relayer): the spend checks require the transaction to be sent by the executor directly to the Float, and only a direct executeSpend call's calldata is decoded, so a relayed refusal's intent is neither compared with nor recovered from its calldata",
];

const PASS = (detail) => ["PASS", detail];
const MANUAL = (detail) => ["MANUAL", detail];
const verdict = (problems, detail) => (problems.length ? ["FAIL", problems.join("; ")] : PASS(detail));

function need(value, message) {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// (blockNumber, logIndex) order.
function before(a, b) {
  return a.blockNumber < b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex < b.logIndex);
}

function sorted(logs) {
  return [...logs].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
}

const sum = (values) => values.reduce((total, value) => total + value, 0n);

// Bundle integers are decimal strings; a safe JSON number is accepted too.
function uintOf(label, value) {
  return parseUint(label, typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value, 256, Error);
}

// With `keys`, no other key may appear.
function objectOf(label, value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unknown = keys ? Object.keys(value).filter((key) => !keys.includes(key)) : [];
  if (unknown.length) throw new Error(`${label} has unknown key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; schema 1 allows ${keys.join(", ")}`);
  return value;
}

function arrayOf(label, value) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function nullableObject(label, value) {
  return value === null ? null : objectOf(label, value);
}

function stringOf(label, value) {
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

// The release config a manifest records, as [immutable getter, value]: usdc a
// checksummed address, every other value a bigint (the manifest stores decimal strings).
function manifestConfig(bytes) {
  const config = objectOf("the manifest's config", JSON.parse(bytes.toString("utf8")).config);
  objectOf("the manifest's config.maxima", config.maxima);
  return IMMUTABLE_GETTERS.map(([name, value]) => {
    const label = `the manifest's config for ${name}()`;
    return [name, name === "usdc" ? parseAddress(label, value(config), Error) : uintOf(label, value(config))];
  });
}

const repoRoot = realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
// git gets no GIT_* variable (GIT_DIR, GIT_INDEX_FILE, ...) that could point it
// at another repository or index. Windows variable names are case-insensitive.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

// Whether `bytes`, read from the file at `path`, are that file as committed at
// HEAD of the checkout at `root`: its repository path, whether git tracks it,
// whether `bytes` hash, through the path's git filters (eol conversion), to
// HEAD's blob for it, and the commit that last changed it. A file outside the
// checkout is untracked. The bytes are compared, not git's view of the working
// tree, so an edit hidden by --assume-unchanged or --skip-worktree still counts.
export function manifestProvenance(path, bytes, { root = repoRoot } = {}) {
  const top = realpathSync.native(root);
  const inRepo = relative(top, realpathSync.native(resolve(path)));
  if (isAbsolute(inRepo) || inRepo === ".." || inRepo.startsWith(`..${sep}`)) return { file: null, tracked: false, clean: false, commit: null };
  const file = inRepo.split(sep).join("/");
  // No shell, and pathspecs are matched literally, never as globs.
  const git = (args, input) => execFileSync("git", args, { cwd: top, encoding: "utf8", env: gitEnv, input });
  if (!git(["--literal-pathspecs", "ls-files", "-z", "--", file]).split("\0").includes(file)) return { file, tracked: false, clean: false, commit: null };
  const commit = git(["--literal-pathspecs", "log", "-1", "--format=%H", "--", file]).trim() || null;
  let committed;
  try {
    committed = git(["rev-parse", "--verify", "--quiet", `HEAD:${file}`]).trim();
  } catch (error) {
    // --quiet exits 1, silently, when HEAD has no such path.
    if (error.status !== 1) throw error;
    committed = null;
  }
  const clean = committed !== null && git(["hash-object", "--stdin", `--path=${file}`], bytes).trim() === committed;
  return { file, tracked: true, clean, commit };
}

// The bundle's pointers, normalized: bigints, checksummed addresses, lowercase
// hashes. Throws on the first malformed field.
function parseBundle(raw) {
  objectOf("the bundle", raw);
  if (raw.kind !== BUNDLE_KIND) throw new Error(`kind is ${JSON.stringify(raw.kind ?? null)}, not ${BUNDLE_KIND}`);
  if (String(raw.schema) !== "1") throw new Error(`schema is ${JSON.stringify(raw.schema ?? null)}; this verifier reads schema 1`);
  objectOf("the bundle", raw, KEYS.bundle);
  const deployment = objectOf("deployment", raw.deployment, KEYS.deployment);
  const observedAt = objectOf("observedAt", raw.observedAt, KEYS.observedAt);
  const line = objectOf("line", raw.line, KEYS.line);
  const opened = objectOf("line.opened", line.opened, KEYS.txPointer);
  const exit = objectOf("exit", raw.exit, KEYS.exit);
  if (!Object.hasOwn(EXIT_EVENTS, exit.kind) && exit.kind !== "none") throw new Error(`exit.kind ${JSON.stringify(exit.kind ?? null)} is not close, claim-defaulted or none`);
  const exited = exit.kind !== "none";
  const summary = objectOf("exporterSummary", raw.exporterSummary, KEYS.exporterSummary);
  const declared = objectOf("declared", raw.declared, KEYS.declared);
  if (declared.label !== DECLARED_LABEL) {
    throw new Error(`declared.label is ${JSON.stringify(declared.label ?? null)}, not the exporter's fixed label ${JSON.stringify(DECLARED_LABEL)}`);
  }
  const txPointer = (label, entry) => ({
    txHash: parseBytes32(`${label}.txHash`, entry.txHash, Error),
    blockNumber: uintOf(`${label}.blockNumber`, entry.blockNumber),
  });
  return {
    deployment: {
      chainId: uintOf("deployment.chainId", deployment.chainId),
      address: parseAddress("deployment.address", deployment.address, Error),
      deployBlock: uintOf("deployment.deployBlock", deployment.deployBlock),
      runtimeKeccak256: parseBytes32("deployment.runtimeKeccak256", deployment.runtimeKeccak256, Error),
      sourceCommit: stringOf("deployment.sourceCommit", deployment.sourceCommit),
    },
    observedAt: {
      blockNumber: uintOf("observedAt.blockNumber", observedAt.blockNumber),
      blockHash: parseBytes32("observedAt.blockHash", observedAt.blockHash, Error),
    },
    line: {
      lineId: parseBytes32("line.lineId", line.lineId, Error),
      sponsor: parseAddress("line.sponsor", line.sponsor, Error),
      agent: parseAddress("line.agent", line.agent, Error),
      epoch: uintOf("line.epoch", line.epoch),
      opened: txPointer("line.opened", opened),
    },
    cycles: arrayOf("cycles", raw.cycles).map((entry, i) => {
      const label = `cycles[${i}]`;
      objectOf(label, entry, KEYS.cycle);
      // The exporter numbers the cycles 1, 2, ... in bundle order, as JSON numbers.
      if (entry.index !== i + 1) throw new Error(`${label}.index is ${JSON.stringify(entry.index ?? null)}, not ${i + 1}: cycles are numbered from 1 in bundle order`);
      const spend = objectOf(`${label}.spend`, entry.spend, KEYS.spend);
      const provider = objectOf(`${label}.provider`, entry.provider, KEYS.provider);
      if (typeof entry.cleared !== "boolean") throw new Error(`${label}.cleared must be a boolean`);
      if (provider.requestId !== null) stringOf(`${label}.provider.requestId`, provider.requestId);
      return {
        digest: parseBytes32(`${label}.digest`, entry.digest, Error),
        intent: nullableObject(`${label}.intent`, entry.intent),
        spend: { ...txPointer(`${label}.spend`, spend), executor: parseAddress(`${label}.spend.executor`, spend.executor, Error) },
        repayments: arrayOf(`${label}.repayments`, entry.repayments).map((repayment, k) => {
          const at = `${label}.repayments[${k}]`;
          objectOf(at, repayment, KEYS.repayment);
          return { ...txPointer(at, repayment), payer: parseAddress(`${at}.payer`, repayment.payer, Error), amount: uintOf(`${at}.amount`, repayment.amount) };
        }),
        cleared: entry.cleared,
        provider: {
          requestId: provider.requestId,
          acceptance: nullableObject(`${label}.provider.acceptance`, provider.acceptance),
          delivery: nullableObject(`${label}.provider.delivery`, provider.delivery),
        },
      };
    }),
    refusals: arrayOf("refusals", raw.refusals).map((entry, j) => {
      const label = `refusals[${j}]`;
      objectOf(label, entry, KEYS.refusal);
      if (typeof entry.reason !== "string" && typeof entry.reason !== "number") throw new Error(`${label}.reason must be a BlockReason name or index`);
      return {
        digest: parseBytes32(`${label}.digest`, entry.digest, Error),
        ...txPointer(label, entry),
        reason: entry.reason,
        intent: nullableObject(`${label}.intent`, entry.intent),
      };
    }),
    exit: {
      kind: exit.kind,
      txHash: exited ? parseBytes32("exit.txHash", exit.txHash, Error) : exit.txHash,
      blockNumber: exited ? uintOf("exit.blockNumber", exit.blockNumber) : exit.blockNumber,
      amount: exited ? uintOf("exit.amount", exit.amount) : exit.amount,
    },
    declared,
    exporterSummary: Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, uintOf(`exporterSummary.${field}`, summary[field])])),
    verifierScope: stringOf("verifierScope", raw.verifierScope),
  };
}

function checklist() {
  const checks = [];
  const scopes = new Map();
  // evaluate returns [status, detail]; anything it throws is a FAIL with the
  // error. Returns the recorded entry.
  async function record(id, scope, evaluate) {
    let status;
    let detail;
    try {
      [status, detail] = await evaluate();
    } catch (error) {
      [status, detail] = ["FAIL", rpcErrorDetail(error)];
    }
    const entry = { id, status, detail };
    checks.push(entry);
    scopes.set(id, scope);
    return entry;
  }
  function declare(id, label, value) {
    checks.push({ id, status: "DECLARED", detail: `declared by ${JSON.stringify(label ?? null)}; reported verbatim, not verified`, label: label ?? null, value });
    scopes.set(id, "declared");
  }
  // Scope "calldata" is an intent check that read the intent from the
  // transaction's calldata: it is verified on chain, and listed apart as well.
  function report(extra) {
    const ids = (...scope) => checks.filter((entry) => entry.status === "PASS" && scope.includes(scopes.get(entry.id))).map((entry) => entry.id);
    const manual = checks.filter((entry) => entry.status === "MANUAL").map((entry) => `${entry.id}: ${entry.detail}`);
    const ok = checks.every((entry) => entry.status !== "FAIL");
    return {
      kind: REPORT_KIND,
      ok,
      // DECLARED fields never count: qualifying means every checkable claim was checked and none failed.
      qualifying: ok && manual.length === 0,
      ...extra,
      scope: {
        verifiedOnChain: ids("chain", "calldata"),
        intentFromCalldata: ids("calldata"),
        verifiedAgainstBundleSignatures: ids("signature"),
        declaredOnly: checks.filter((entry) => entry.status === "DECLARED").map((entry) => entry.id),
        notChecked: [...manual, ...NEVER_CHECKED],
      },
      totals: Object.fromEntries(["PASS", "FAIL", "MANUAL", "DECLARED"].map((status) => [status, checks.filter((entry) => entry.status === status).length])),
      checks,
    };
  }
  return { record, declare, report };
}

// Everything the per-entry checks share: the connection, the pinned
// observation block, and cached receipts, transactions and blocks.
function context(connection, bundle, usdc) {
  const receipts = new Map();
  const transactions = new Map();
  const blocks = new Map();
  const cached = (map, key, load) => {
    if (!map.has(key)) map.set(key, load());
    return map.get(key);
  };
  const float = connection.address;
  return {
    connection,
    float,
    usdc,
    lineId: bundle.line.lineId,
    observed: bundle.observedAt.blockNumber,
    receipt: (hash) => cached(receipts, hash, () => connection.client.getTransactionReceipt({ hash })),
    transaction: (hash) => cached(transactions, hash, () => connection.client.getTransaction({ hash })),
    block: (blockNumber) => cached(blocks, blockNumber, () => connection.client.getBlock({ blockNumber })),
    floatEvents: (receipt) => parseEventLogs({ abi: floatAbi, logs: receipt.logs.filter((log) => isAddressEqual(log.address, float)) }),
    transfers: (receipt) =>
      parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((log) => isAddressEqual(log.address, usdc)) }),
  };
}

// Receipt status, block and observation bound shared by every pointed-to transaction.
function receiptProblems(ctx, receipt, pointer) {
  const problems = [];
  if (receipt.status !== "success") problems.push(`transaction ${pointer.txHash} is ${receipt.status}`);
  if (receipt.blockNumber !== pointer.blockNumber) problems.push(`transaction ${pointer.txHash} is in block ${receipt.blockNumber}, not the bundle's ${pointer.blockNumber}`);
  if (receipt.blockNumber > ctx.observed) problems.push(`transaction ${pointer.txHash} is in block ${receipt.blockNumber}, after observedAt ${ctx.observed}`);
  return problems;
}

function hasTransfer(ctx, receipt, { from, to, value, beforeLog }) {
  return ctx
    .transfers(receipt)
    .some((log) => isAddressEqual(log.args.from, from) && isAddressEqual(log.args.to, to) && log.args.value === value && log.logIndex < beforeLog.logIndex);
}

function parseIntent(file, connection) {
  if (file === null) return { missing: true };
  try {
    return { value: validateIntentFile(file, connection) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

// The executeSpend call a transaction sends directly to the Float, decoded: the
// intent and signature in its calldata, and the digest that intent recomputes
// to for this chain and Float. The Float pays, and records a refusal, only in
// executeSpend(intent, signature), so that call holds the intent the Float
// executed and the signature it accepted. A call relayed through a contract (a
// Safe, a 4337 account, a relayer) is inside that contract's calldata, not the
// transaction's, and is not decoded: { relayed } says where the transaction went.
async function executeSpendCall(ctx, txHash) {
  const tx = await ctx.transaction(txHash);
  if (!tx.to || !isAddressEqual(tx.to, ctx.float)) return { relayed: `transaction ${txHash} is sent to ${tx.to ?? "no address"}, not the Float ${ctx.float}` };
  // Lowercased, so its bytes32 fields and signature compare with the bundle's lowercase hex.
  const { functionName, args } = decodeFunctionData({ abi: floatAbi, data: tx.input.toLowerCase() });
  if (functionName !== "executeSpend") throw new Error(`transaction ${txHash} calls ${functionName} on the Float, not executeSpend`);
  const [struct, signature] = args;
  return { struct, signature, digest: intentDigest(ctx.connection.chainId, ctx.float, struct) };
}

// The intent an entry's intent checks read: its bundle file or, when the bundle
// has none, the one in its transaction's executeSpend calldata. { gate } is the
// [status, detail] those checks report when neither is usable.
async function intentOf(ctx, intent, txHash) {
  if (intent.error) return { gate: ["FAIL", `the intent file is rejected: ${intent.error}`] };
  if (intent.value) return intent.value;
  const call = await executeSpendCall(ctx, txHash);
  if (call.relayed) return { gate: MANUAL(`intent file not supplied, and ${call.relayed}, so it cannot be recovered from the transaction's calldata`) };
  return { ...call, fromCalldata: true };
}

// Runs `check` on the intent `resolve` gives; its detail says when that intent came from calldata.
async function onIntent(resolve, check) {
  const used = await resolve();
  if (used.gate) return used.gate;
  const [status, detail] = await check(used);
  return [status, used.fromCalldata ? `${detail} (intent from the transaction calldata: the bundle has no intent file)` : detail];
}

// How an intent file differs from the executeSpend call its transaction made:
// each message field that is not the call's, and a signature that is not
// exactly the call's. None when the file holds the call's intent and signature.
export function calldataMismatches(file, call) {
  const inFile = messageFromStruct(file.struct);
  const inCall = messageFromStruct(call.struct);
  const problems = Object.keys(inCall)
    .filter((name) => inFile[name] !== inCall[name])
    .map((name) => `message.${name} is ${inFile[name]} in the intent file, ${inCall[name]} in the calldata`);
  if (file.signature === null) problems.push("the intent file carries no signature; the calldata carries the one the Float accepted");
  else if (file.signature !== call.signature) problems.push(`the intent file's signature ${file.signature} is not the calldata's ${call.signature}`);
  return problems;
}

// The bundle's intent file against its transaction's executeSpend calldata.
async function matchesCalldata(ctx, intent, txHash) {
  if (intent.error) return ["FAIL", `the intent file is rejected: ${intent.error}`];
  const call = await executeSpendCall(ctx, txHash);
  if (call.relayed) return MANUAL(`${call.relayed}, so the intent file is not compared with the call it relays`);
  return verdict(calldataMismatches(intent.value, call), "the intent file's message and signature are exactly those in the transaction's executeSpend calldata");
}

// Each on-chain payment and the Repaid events between it and the next payment.
function cycleWindows(paidLogs, repaidLogs) {
  const payments = sorted(paidLogs);
  return new Map(
    payments.map((log, k) => {
      const next = payments[k + 1];
      const repaid = sorted(repaidLogs).filter((entry) => before(log, entry) && (!next || before(entry, next)));
      return [log.args.digest, { log, repaid, cleared: repaid.length > 0 && repaid.at(-1).args.principalRemaining === 0n }];
    }),
  );
}

// Each listed repayment's own Repaid log for the line, from the decoded Float
// events of its transaction (eventsByTx: txHash -> events), or null. A log is
// matched at most once: one transaction can emit two identical Repaid events,
// and two listed repayments cannot both claim one of them.
export function matchRepayments(lineId, repayments, eventsByTx) {
  const matched = new Set();
  return repayments.map((repayment) => {
    const log = eventsByTx.get(repayment.txHash).find(
      (entry) =>
        entry.eventName === "Repaid" &&
        entry.args.lineId === lineId &&
        isAddressEqual(entry.args.payer, repayment.payer) &&
        entry.args.amount === repayment.amount &&
        !matched.has(`${entry.transactionHash}:${entry.logIndex}`),
    );
    if (!log) return null;
    matched.add(`${log.transactionHash}:${log.logIndex}`);
    return log;
  });
}

// The refused transaction's USDC accounting, from its decoded Float events and
// USDC Transfer logs: problems, or none. Another call in the same transaction
// (a batch that also closes a line, say) may move USDC out of the Float, so each
// transfer out must be another Float event's payment, and no ProviderPaid may
// carry the refused digest. The contract transfers before it emits, so, in log
// order, each ProviderPaid (principal to its provider), LineClosed or
// SponsorClaimed (amount to its sponsor) explains one earlier transfer of
// exactly that amount to that payee: the nearest one not already explained.
export function refusalTransferProblems(float, refusedDigest, floatEvents, transfers) {
  const byLog = (a, b) => a.logIndex - b.logIndex;
  const problems = [];
  if (floatEvents.some((log) => log.eventName === "ProviderPaid" && log.args.digest === refusedDigest)) {
    problems.push(`the transaction also emits ProviderPaid for the refused digest ${refusedDigest}`);
  }
  const unexplained = transfers.filter((log) => isAddressEqual(log.args.from, float)).sort(byLog);
  for (const event of [...floatEvents].sort(byLog)) {
    const [payee, amount] =
      event.eventName === "ProviderPaid"
        ? [event.args.provider, event.args.principal]
        : event.eventName === "LineClosed" || event.eventName === "SponsorClaimed"
          ? [event.args.sponsor, event.args.amount]
          : [];
    if (payee === undefined) continue;
    const k = unexplained.findLastIndex((log) => log.logIndex < event.logIndex && isAddressEqual(log.args.to, payee) && log.args.value === amount);
    if (k >= 0) unexplained.splice(k, 1);
  }
  if (unexplained.length) {
    problems.push(
      `the transaction moves USDC out of the Float that no other Float event in it pays: ${unexplained.map((log) => `${log.args.value} to ${getAddress(log.args.to)}`).join(", ")}`,
    );
  }
  return problems;
}

async function verifyCycle(ctx, { record }, cycle, i, windowOf, bundle) {
  const id = (name) => `cycle[${i}].${name}`;
  const { connection, float, lineId, observed } = ctx;
  const receipt = ctx.receipt(cycle.spend.txHash);
  const event = async () => {
    const found = ctx.floatEvents(await receipt).find((log) => log.eventName === "ProviderPaid" && log.args.digest === cycle.digest && log.args.lineId === lineId);
    return need(found, `transaction ${cycle.spend.txHash} emits no ProviderPaid for digest ${cycle.digest} on line ${lineId}`);
  };
  const spendBlock = async () => (await receipt).blockNumber;
  const intent = parseIntent(cycle.intent, connection);
  const withIntent = (check) => onIntent(() => intentOf(ctx, intent, cycle.spend.txHash), check);
  // An intent check without the bundle's file reads the calldata's intent.
  const intentScope = (scope) => (intent.missing ? "calldata" : scope);

  await record(id("spend.receipt"), "chain", async () => {
    const mined = await receipt;
    const problems = receiptProblems(ctx, mined, cycle.spend);
    if (!mined.to || !isAddressEqual(mined.to, float)) problems.push(`transaction is sent to ${mined.to}, not the Float ${float}`);
    if (!isAddressEqual(mined.from, cycle.spend.executor)) problems.push(`transaction is sent by ${mined.from}, not the bundle's executor ${cycle.spend.executor}`);
    return verdict(problems, `executeSpend by ${cycle.spend.executor} mined successfully in block ${mined.blockNumber}`);
  });
  await record(id("spend.providerPaid"), "chain", async () => {
    const paid = await event();
    return PASS(`ProviderPaid(${cycle.digest}) on line ${lineId}: provider ${paid.args.provider}, principal ${paid.args.principal}, dueAt ${paid.args.dueAt}`);
  });
  await record(id("spend.usdcTransfer"), "chain", async () => {
    const paid = await event();
    const moved = hasTransfer(ctx, await receipt, { from: float, to: paid.args.provider, value: paid.args.principal, beforeLog: paid });
    return verdict(moved ? [] : [`no USDC Transfer of exactly ${paid.args.principal} from the Float to ${paid.args.provider} precedes the ProviderPaid`], `USDC ${ctx.usdc} moved exactly ${paid.args.principal} from the Float to ${paid.args.provider}`);
  });
  await record(id("spend.calldata"), "chain", async () => {
    const call = await executeSpendCall(ctx, cycle.spend.txHash);
    if (call.relayed) return ["FAIL", `${call.relayed}: a spend must be a direct executeSpend call to the Float`];
    return verdict(
      call.digest === cycle.digest ? [] : [`the intent in its executeSpend calldata recomputes to digest ${call.digest} for chain ${connection.chainId} and Float ${float}, not the cycle's ${cycle.digest}`],
      `the transaction calls executeSpend on the Float with an intent that recomputes to the cycle's digest for chain ${connection.chainId} and Float ${float}`,
    );
  });
  await record(id("intent.digest"), intentScope("chain"), () =>
    withIntent(({ digest }) =>
      verdict(
        digest === cycle.digest ? [] : [`the intent's message recomputes to digest ${digest} for chain ${connection.chainId} and Float ${float}, not the cycle's ${cycle.digest}`],
        `the intent's message recomputes to the paid digest for chain ${connection.chainId} and Float ${float}`,
      ),
    ),
  );
  await record(id("intent.fields"), intentScope("chain"), () =>
    withIntent(async ({ struct }) => {
      const paid = await event();
      const problems = [];
      const expect = (name, actual, expected) => {
        if (actual !== expected) problems.push(`message.${name} is ${actual}, not ${expected}`);
      };
      expect("lineId", struct.lineId, lineId);
      expect("sponsor", struct.sponsor, bundle.line.sponsor);
      expect("agent", struct.agent, bundle.line.agent);
      expect("lineEpoch", struct.lineEpoch, bundle.line.epoch);
      expect("provider", struct.provider, getAddress(paid.args.provider));
      expect("principal", struct.principal, paid.args.principal);
      expect("dueAt", struct.dueAt, paid.args.dueAt);
      return verdict(problems, "line, sponsor, agent, epoch, provider, principal and dueAt equal the line and the ProviderPaid event");
    }),
  );
  await record(id("spend.executor"), intentScope("chain"), () =>
    withIntent(async ({ struct }) => {
      const mined = await receipt;
      if (struct.executor === zeroAddress) return PASS("the intent allows any executor");
      return verdict(
        isAddressEqual(mined.from, struct.executor) ? [] : [`the intent names executor ${struct.executor}, but ${mined.from} sent the spend`],
        `sent by the intent's named executor ${struct.executor}`,
      );
    }),
  );
  await record(id("intent.signature"), intentScope("signature"), () =>
    withIntent(async ({ struct, digest, signature: signed }) => {
      if (signed === null) return MANUAL("the intent file carries no signature");
      const at = (await spendBlock()) - 1n;
      const signature = await signatureAt(connection, { signer: struct.agent, hash: digest, signature: signed, blockNumber: at, caller: float });
      return verdict(signature.valid ? [] : [`agent ${struct.agent}: ${signature.detail}`], `agent ${struct.agent} (${signature.signerKind}): ${signature.detail}`);
    }),
  );
  if (cycle.intent !== null) await record(id("intent.matchesCalldata"), "chain", () => matchesCalldata(ctx, intent, cycle.spend.txHash));
  await record(id("state.before"), "chain", async () => {
    const at = (await spendBlock()) - 1n;
    const line = await read(connection, "getLine", [lineId], at);
    const problems = [];
    if (LINE_STATES[line.state] !== "OPEN") problems.push(`the line is ${LINE_STATES[line.state]} at block ${at}, not OPEN`);
    if (line.principalOutstanding !== 0n) problems.push(`principalOutstanding is ${line.principalOutstanding} at block ${at}, not zero (one outstanding draw per line)`);
    if (line.epoch !== bundle.line.epoch) problems.push(`epoch is ${line.epoch} at block ${at}, not the line's ${bundle.line.epoch}`);
    if (!isAddressEqual(line.sponsor, bundle.line.sponsor) || !isAddressEqual(line.agent, bundle.line.agent)) problems.push(`the line's sponsor/agent at block ${at} are ${line.sponsor}/${line.agent}`);
    return verdict(problems, `at block ${at} the line was OPEN with no outstanding principal, epoch ${line.epoch}`);
  });
  await record(id("state.termsHash"), intentScope("chain"), () =>
    withIntent(async ({ struct }) => {
      const at = (await spendBlock()) - 1n;
      const current = await read(connection, "currentTermsHash", [lineId, struct.provider], at);
      return verdict(
        current === struct.termsHash ? [] : [`currentTermsHash(line, ${struct.provider}) at block ${at} is ${current}, not the intent's termsHash ${struct.termsHash}`],
        `the intent's termsHash equals currentTermsHash(line, ${struct.provider}) at block ${at}`,
      );
    }),
  );
  await record(id("repayments"), "chain", async () => {
    const window = windowOf(cycle.digest);
    const unmatched = [...window.repaid];
    const problems = [];
    const mined = new Map();
    for (const { txHash } of cycle.repayments) if (!mined.has(txHash)) mined.set(txHash, await ctx.receipt(txHash));
    const matched = matchRepayments(
      lineId,
      cycle.repayments,
      new Map([...mined].map(([txHash, receipt]) => [txHash, ctx.floatEvents(receipt)])),
    );
    for (const [k, repayment] of cycle.repayments.entries()) {
      const label = `repayment ${k} (${repayment.txHash})`;
      const receipt = mined.get(repayment.txHash);
      problems.push(...receiptProblems(ctx, receipt, repayment).map((problem) => `${label}: ${problem}`));
      const repaid = matched[k];
      if (!repaid) {
        problems.push(`${label}: no Repaid(${lineId}, ${repayment.payer}, ${repayment.amount}) from the Float in the transaction that another listed repayment has not already matched`);
        continue;
      }
      if (!hasTransfer(ctx, receipt, { from: repayment.payer, to: float, value: repayment.amount, beforeLog: repaid })) {
        problems.push(`${label}: no USDC Transfer of exactly ${repayment.amount} from ${repayment.payer} to the Float precedes the Repaid`);
      }
      const index = unmatched.findIndex((log) => log.transactionHash === receipt.transactionHash && log.logIndex === repaid.logIndex);
      if (index < 0) problems.push(`${label}: the Repaid is not between this cycle's payment and the next one`);
      else unmatched.splice(index, 1);
    }
    if (unmatched.length) {
      problems.push(`the chain has ${unmatched.length} Repaid event(s) in this cycle's window that the bundle does not list: ${unmatched.map((log) => log.transactionHash).join(", ")}`);
    }
    return verdict(problems, `${cycle.repayments.length} repayment(s), each a Repaid with an exact USDC transfer to the Float, and no other repayment in this cycle's window`);
  });
  await record(id("cleared"), "chain", async () => {
    const window = windowOf(cycle.digest);
    const remaining = window.repaid.length ? window.repaid.at(-1).args.principalRemaining : window.log.args.principal;
    return verdict(
      cycle.cleared === window.cleared ? [] : [`the bundle says cleared ${cycle.cleared}; the chain's last principalRemaining for this cycle is ${remaining}`],
      `cleared ${window.cleared}: principalRemaining after this cycle's repayments is ${remaining}`,
    );
  });
  await record(id("receiptStatus"), "chain", async () => {
    const status = await read(connection, "receiptStatus", [cycle.digest], observed);
    return verdict(status === 2 ? [] : [`receiptStatus is ${status} at block ${observed}, not 2 (paid)`], `receiptStatus is paid at block ${observed}`);
  });

  const spendTime = async () => (await ctx.block(await spendBlock())).timestamp;
  let acceptedRequestIdHash = null;
  await record(id("provider.acceptance"), "signature", async () => {
    if (cycle.provider.acceptance === null) {
      return MANUAL(`no ServiceAcceptance in the bundle${cycle.provider.requestId === null ? "" : `; requestId ${JSON.stringify(cycle.provider.requestId)} is unbacked`}`);
    }
    const paid = await event();
    const acceptance = validateReceiptFile(cycle.provider.acceptance, connection, ACCEPTANCE_KIND);
    const signature = await signatureAt(connection, { signer: acceptance.message.provider, hash: acceptance.hash, signature: acceptance.signature, blockNumber: observed });
    const spentAt = await spendTime();
    // Without a usable intent, from the file or the calldata, the paid endpoint
    // is the one the provider's policy approved before the spend: the contract
    // pays no other endpoint.
    const policyAt = (await spendBlock()) - 1n;
    const { struct, fromCalldata } = await intentOf(ctx, intent, cycle.spend.txHash);
    const endpoint = struct
      ? { hash: struct.endpointHash, source: fromCalldata ? "the intent's endpoint in the transaction calldata" : "the intent's endpoint" }
      : {
          hash: (await readPolicy(connection, lineId, paid.args.provider, policyAt)).endpointHash,
          source: `the endpoint provider ${paid.args.provider}'s policy approved at block ${policyAt}`,
        };
    const problems = [];
    if (!signature.valid) problems.push(`signature: ${signature.detail}`);
    if (acceptance.message.digest !== cycle.digest) problems.push(`it accepts digest ${acceptance.message.digest}, not the cycle's ${cycle.digest}`);
    if (!isAddressEqual(acceptance.message.provider, paid.args.provider)) problems.push(`its provider ${acceptance.message.provider} is not the paid provider ${paid.args.provider}`);
    if (acceptance.message.principal !== paid.args.principal) problems.push(`its principal ${acceptance.message.principal} is not the paid ${paid.args.principal}`);
    if (acceptance.message.acceptedAt > spentAt) problems.push(`acceptedAt ${acceptance.message.acceptedAt} is after the payment block's timestamp ${spentAt}`);
    if (cycle.provider.requestId !== acceptance.requestId) problems.push(`the bundle's requestId ${JSON.stringify(cycle.provider.requestId)} is not the acceptance's ${JSON.stringify(acceptance.requestId)}`);
    if (acceptance.message.endpointHash !== endpoint.hash) problems.push(`its endpointHash ${acceptance.message.endpointHash} is not ${endpoint.source} (${endpoint.hash})`);
    if (problems.length) return ["FAIL", problems.join("; ")];
    acceptedRequestIdHash = acceptance.message.requestIdHash;
    return PASS(
      `provider ${acceptance.message.provider} (${signature.signerKind}) signed its acceptance of request ${JSON.stringify(acceptance.requestId)} for this digest and principal, at ${endpoint.source}; the provider asserts it accepted at ${acceptance.message.acceptedAt}, no later than the payment block's timestamp ${spentAt}`,
    );
  });
  await record(id("provider.delivery"), "signature", async () => {
    if (cycle.provider.delivery === null) return MANUAL("no DeliveryReceipt in the bundle");
    const paid = await event();
    const delivery = validateReceiptFile(cycle.provider.delivery, connection, DELIVERY_KIND);
    const signature = await signatureAt(connection, { signer: delivery.message.provider, hash: delivery.hash, signature: delivery.signature, blockNumber: observed });
    const spentAt = await spendTime();
    const problems = [];
    if (!signature.valid) problems.push(`signature: ${signature.detail}`);
    if (delivery.message.digest !== cycle.digest) problems.push(`it delivers digest ${delivery.message.digest}, not the cycle's ${cycle.digest}`);
    if (!isAddressEqual(delivery.message.provider, paid.args.provider)) problems.push(`its provider ${delivery.message.provider} is not the paid provider ${paid.args.provider}`);
    if (delivery.message.deliveredAt < spentAt) problems.push(`deliveredAt ${delivery.message.deliveredAt} is before the payment block's timestamp ${spentAt}`);
    if (cycle.provider.requestId !== delivery.requestId) problems.push(`the bundle's requestId ${JSON.stringify(cycle.provider.requestId)} is not the delivery's ${JSON.stringify(delivery.requestId)}`);
    if (cycle.provider.acceptance !== null && acceptedRequestIdHash === null) problems.push("the cycle's acceptance did not verify, so the delivery is not bound to an accepted request");
    if (acceptedRequestIdHash !== null && delivery.message.requestIdHash !== acceptedRequestIdHash) problems.push("its requestIdHash is not the acceptance's");
    return verdict(
      problems,
      `provider ${delivery.message.provider} (${signature.signerKind}) signed delivery of result ${delivery.message.resultHash} for request ${JSON.stringify(delivery.requestId)}; the provider asserts it delivered at ${delivery.message.deliveredAt}, no earlier than the payment block's timestamp ${spentAt}`,
    );
  });
}

function reasonMatches(bundleReason, reason) {
  return bundleReason === BLOCK_REASONS[reason] || String(bundleReason) === String(reason);
}

async function verifyRefusal(ctx, { record }, refusal, j) {
  const id = (name) => `refusal[${j}].${name}`;
  const { connection, float, lineId, observed } = ctx;
  const receipt = ctx.receipt(refusal.txHash);
  const event = async () => {
    const found = ctx.floatEvents(await receipt).find((log) => log.eventName === "SpendBlocked" && log.args.digest === refusal.digest && log.args.lineId === lineId);
    return need(found, `transaction ${refusal.txHash} emits no SpendBlocked for digest ${refusal.digest} on line ${lineId}`);
  };
  const intent = parseIntent(refusal.intent, connection);
  const withIntent = (check) => onIntent(() => intentOf(ctx, intent, refusal.txHash), check);
  // An intent check without the bundle's file reads the calldata's intent.
  const intentScope = (scope) => (intent.missing ? "calldata" : scope);
  await record(id("event"), "chain", async () => {
    const mined = await receipt;
    const blocked = await event();
    const problems = receiptProblems(ctx, mined, refusal);
    if (!reasonMatches(refusal.reason, blocked.args.reason)) problems.push(`the recorded reason is ${BLOCK_REASONS[blocked.args.reason]}, not the bundle's ${refusal.reason}`);
    return verdict(problems, `SpendBlocked(${BLOCK_REASONS[blocked.args.reason]}) for nonce ${blocked.args.nonce} in block ${mined.blockNumber}`);
  });
  // A refusal relayed through a contract (a batch that also closes a line, say)
  // is not a direct call, so its calldata is left to the reviewer.
  await record(id("calldata"), "chain", async () => {
    const call = await executeSpendCall(ctx, refusal.txHash);
    if (call.relayed) return MANUAL(`${call.relayed}: only a direct executeSpend call's calldata is decoded`);
    return verdict(
      call.digest === refusal.digest ? [] : [`the intent in its executeSpend calldata recomputes to digest ${call.digest} for chain ${connection.chainId} and Float ${float}, not the refusal's ${refusal.digest}`],
      `the transaction calls executeSpend on the Float with an intent that recomputes to the refused digest for chain ${connection.chainId} and Float ${float}`,
    );
  });
  await record(id("intent.digest"), intentScope("chain"), () =>
    withIntent(async ({ struct, digest }) => {
      const blocked = await event();
      const problems = [];
      if (digest !== refusal.digest) problems.push(`the intent's message recomputes to digest ${digest}, not ${refusal.digest}`);
      if (struct.lineId !== lineId) problems.push(`message.lineId is ${struct.lineId}, not ${lineId}`);
      if (struct.nonce !== blocked.args.nonce) problems.push(`message.nonce is ${struct.nonce}, not the recorded ${blocked.args.nonce}`);
      return verdict(problems, "the intent's message recomputes to the refused digest, on this line with the recorded nonce");
    }),
  );
  // The contract records a SpendBlocked only after validating the signature,
  // so it is checked as for a paid cycle, at the block before the refusal.
  await record(id("intent.signature"), intentScope("signature"), () =>
    withIntent(async ({ struct: { agent }, digest, signature: signed }) => {
      if (signed === null) return MANUAL("the intent file carries no signature");
      const at = (await receipt).blockNumber - 1n;
      const signature = await signatureAt(connection, { signer: agent, hash: digest, signature: signed, blockNumber: at, caller: float });
      return verdict(signature.valid ? [] : [`agent ${agent}: ${signature.detail}`], `agent ${agent} (${signature.signerKind}): ${signature.detail}`);
    }),
  );
  if (refusal.intent !== null) await record(id("intent.matchesCalldata"), "chain", () => matchesCalldata(ctx, intent, refusal.txHash));
  await record(id("noUsdcTransfer"), "chain", async () => {
    const mined = await receipt;
    const transfers = ctx.transfers(mined);
    const outgoing = transfers.filter((log) => isAddressEqual(log.args.from, float)).length;
    return verdict(
      refusalTransferProblems(float, refusal.digest, ctx.floatEvents(mined), transfers),
      outgoing
        ? `no USDC left the Float for the refusal: each of the transaction's ${outgoing} USDC transfer(s) out of the Float is paid by another Float event in it`
        : "no USDC left the Float in the refused transaction",
    );
  });
  await record(id("receiptStatus"), "chain", async () => {
    const status = await read(connection, "receiptStatus", [refusal.digest], observed);
    return verdict(status === 1 ? [] : [`receiptStatus is ${status} at block ${observed}, not 1 (blocked)`], `receiptStatus is blocked at block ${observed}`);
  });
}

// The keys of `keys` left over once each key of `others` is matched once.
function unmatched(keys, others) {
  const rest = [...others];
  return keys.filter((key) => {
    const index = rest.indexOf(key);
    if (index < 0) return true;
    rest.splice(index, 1);
    return false;
  });
}

// Each on-chain event must be in the bundle and each bundle entry on chain.
// logs are in chain order. With ordered, the bundle must list the entries in
// that order too, so its numbering follows the chain.
function compareSets(eventName, logs, entries, keyOfLog, keyOfEntry, range, { ordered = false } = {}) {
  const onChain = logs.map(keyOfLog);
  const listed = entries.map(keyOfEntry);
  const missing = unmatched(onChain, listed);
  const extra = unmatched(listed, onChain);
  const problems = [];
  if (missing.length) problems.push(`on chain but not in the bundle: ${missing.join(", ")}`);
  if (extra.length) problems.push(`in the bundle but not on chain: ${extra.join(", ")}`);
  if (ordered && !problems.length && listed.some((key, k) => key !== onChain[k])) {
    problems.push(`the bundle lists them as ${listed.join(", ")}, not in the chain's order ${onChain.join(", ")}`);
  }
  const order = ordered ? " in the chain's order" : "";
  return verdict(problems, `${logs.length} ${eventName} event(s) for the line in blocks ${range}, each in the bundle${order}, and no other`);
}

async function verifyBundle(raw, { rpcUrl, manifest }) {
  // Read once: the manifest checks parse these bytes and provenance hashes them.
  // readDeployment reads the path itself; the end of the run requires the file
  // to still hold these bytes.
  let manifestBytes;
  try {
    manifestBytes = readFileSync(manifest);
  } catch (error) {
    throw new Error(`cannot read manifest ${manifest}: ${errorMessage(error)}`);
  }
  const list = checklist();
  const { record, declare } = list;
  let bundle;
  await record("bundle.shape", "format", async () => {
    bundle = parseBundle(raw);
    return PASS(`${BUNDLE_KIND} schema 1: ${bundle.cycles.length} cycle(s), ${bundle.refusals.length} refusal(s), exit ${bundle.exit.kind}`);
  });
  if (!bundle) return list.report({ observedAt: raw?.observedAt ?? null });

  const extra = { observedAt: raw.observedAt, lineId: bundle.line.lineId };
  const { deployment, observedAt, line, exit } = bundle;
  let connection;
  let usdc;
  await record("deployment.runtimeCode", "chain", async () => {
    const connected = await connectCandidate({
      rpcUrl,
      expectedChainId: deployment.chainId,
      address: deployment.address,
      runtimeHash: deployment.runtimeKeccak256,
      deployBlock: deployment.deployBlock,
    });
    connection = connected;
    return PASS(
      `chain ${connection.chainId}: the code at ${deployment.address} hashes to ${deployment.runtimeKeccak256} and reports the candidate's EIP-712 name, version and SpendIntent typehash`,
    );
  });
  if (!connection) return list.report(extra);
  // Before any state read pinned to observedAt, and again after the last one.
  const observedHash = await record("observedAt.blockHash", "chain", async () => {
    const block = await connection.client.getBlock({ blockNumber: observedAt.blockNumber });
    const problems = block.hash === observedAt.blockHash ? [] : [`block ${observedAt.blockNumber} is ${block.hash} on this chain, not the bundle's ${observedAt.blockHash}`];
    usdc = getAddress(await read(connection, "usdc", [], observedAt.blockNumber));
    return verdict(problems, `block ${observedAt.blockNumber} is ${observedAt.blockHash} on this chain; every state read is pinned to it; usdc() there is ${usdc}`);
  });
  if (!usdc) return list.report(extra);

  await record("deployment.manifest", "chain", async () => {
    // The bundle's chain id stands in for FLOAT_MAINNET_EXPECTED_CHAIN_ID.
    const release = readDeployment({ ARC_RPC_URL: rpcUrl, FLOAT_MAINNET_EXPECTED_CHAIN_ID: deployment.chainId.toString() }, { manifest });
    const parsed = JSON.parse(manifestBytes.toString("utf8"));
    const commits = { "source.commit": parsed.source?.commit, "pinnedLineage.commit": parsed.pinnedLineage?.commit };
    const commitMatch = Object.keys(commits).find((key) => commits[key] === deployment.sourceCommit);
    const problems = [];
    if (release.address !== deployment.address) problems.push(`the manifest's address is ${release.address}, not the bundle's ${deployment.address}`);
    if (release.runtimeHash !== deployment.runtimeKeccak256) problems.push(`the manifest's runtime hash is ${release.runtimeHash}, not the bundle's ${deployment.runtimeKeccak256}`);
    if (release.deployBlock !== deployment.deployBlock) problems.push(`the manifest's deploy block is ${release.deployBlock}, not the bundle's ${deployment.deployBlock}`);
    if (!commitMatch) problems.push(`the bundle's sourceCommit ${deployment.sourceCommit} is neither the manifest's source.commit ${commits["source.commit"]} nor its pinnedLineage.commit ${commits["pinnedLineage.commit"]}`);
    return verdict(problems, `address, chain, runtime code hash and deploy block equal the passing manifest's; sourceCommit equals its ${commitMatch}`);
  });
  // The anchor checks catch a manifest inconsistent with the chain or the
  // reviewed code. Anyone can write a consistent one for a deployment of their
  // own. A PASS here shows only that the manifest is committed in this
  // checkout's history, which anyone can arrange on a local branch; the
  // reviewer confirms that its commit is on the reviewed upstream branch and
  // that this checkout is that branch.
  const provenance = await record("deployment.manifestProvenance", "repository", async () => {
    const { file, tracked, clean, commit } = manifestProvenance(manifest, manifestBytes);
    if (tracked && clean && commit) {
      return PASS(
        `the manifest read is ${file} as committed at HEAD of this checkout; commit ${commit} last changed it. This shows only that the manifest is committed in this checkout's history: confirm that the commit is on the reviewed upstream branch and that this checkout, which also supplies the pins and this verifier, is that branch`,
      );
    }
    const why =
      file === null
        ? "it is outside this checkout"
        : !tracked
          ? `${file} is not tracked by git in this checkout`
          : !commit
            ? `${file} is in no commit`
            : `the manifest read is not ${file} as committed at HEAD`;
    return MANUAL(`rehearsal manifest: not a committed release record (${why})`);
  });
  // The manifest's own ok flag is a claim: the release checks that can be
  // redone locally are redone here, against the code at observedAt.
  const codeAt = async () => (await connection.client.getCode({ address: connection.address, blockNumber: observedAt.blockNumber })) ?? "0x";
  await record("deployment.artifact", "chain", async () => {
    const artifact = loadArtifact();
    const { files } = readSourceState(artifact);
    const problems = [];
    const stale = Object.keys(files).filter((path) => !files[path].artifactMatchesWorkingTree);
    if (stale.length) problems.push(`the local artifact was not compiled from the working tree's ${stale.join(", ")}; run forge build --root contracts`);
    const lineage = pinnedLineageMismatches(files);
    if (lineage.length) problems.push(`the local sources are not the pinned reviewed lineage ${PINNED_SOURCE_COMMIT} (git blob differs: ${lineage.join(", ")})`);
    const compiler = compilerSettings(artifact);
    if (!sameJson(compiler, EXPECTED_COMPILER)) {
      problems.push(`the local artifact was compiled with ${JSON.stringify(compiler)}, not the release profile ${JSON.stringify(EXPECTED_COMPILER)}`);
    }
    const code = await codeAt();
    const compiled = artifact.deployedBytecode.object;
    if (code.length !== compiled.length) {
      problems.push(`the runtime code at ${connection.address} is ${(code.length - 2) / 2} bytes, the artifact's ${runtimeBytes(artifact)}`);
    } else if (maskImmutables(code, artifact) !== maskImmutables(compiled, artifact)) {
      problems.push(`with its immutables masked, the runtime code at ${connection.address} differs from the artifact's`);
    }
    return verdict(
      problems,
      `with its ${immutableRanges(artifact).length} immutable ranges masked, the runtime code at ${connection.address} equals the local artifact compiled from the pinned reviewed lineage ${PINNED_SOURCE_COMMIT} with the release compiler profile (solc ${EXPECTED_COMPILER.version})`,
    );
  });
  await record("deployment.config", "chain", async () => {
    const config = manifestConfig(manifestBytes);
    const immutables = decodeImmutables(await codeAt(), loadArtifact());
    const problems = [];
    const inconsistent = immutables.filter((entry) => !entry.consistent).map((entry) => entry.astId);
    if (inconsistent.length) problems.push(`the copies of immutable ${inconsistent.join(", ")} in the runtime code differ`);
    const decoded = immutables.map((entry) => entry.value).sort();
    const expected = config.map(([, value]) => immutableWord(value)).sort();
    if (decoded.join() !== expected.join()) problems.push("the immutable values in the runtime code are not the manifest's config");
    for (const [name, value] of config) {
      const actual = await read(connection, name, [], observedAt.blockNumber);
      if (name === "usdc" && !isAddressEqual(actual, value)) problems.push(`usdc() is ${getAddress(actual)}, not the manifest's configured USDC ${value}`);
      if (name !== "usdc" && actual !== value) problems.push(`${name}() is ${actual}, not the manifest's ${value}`);
    }
    return verdict(
      problems,
      `the runtime code's immutables and ${config.map(([name]) => `${name}()`).join(", ")} equal the manifest's config; usdc() is its configured USDC ${Object.fromEntries(config).usdc}`,
    );
  });
  const ctx = context(connection, bundle, usdc);
  let reserve = null;
  await record("line.opened", "chain", async () => {
    const mined = await ctx.receipt(line.opened.txHash);
    const problems = receiptProblems(ctx, mined, line.opened);
    if (deployment.deployBlock > mined.blockNumber) problems.push(`the bundle's deployBlock ${deployment.deployBlock} is after the line was opened (block ${mined.blockNumber}), so the completeness scan would start too late`);
    const opened = ctx
      .floatEvents(mined)
      .find(
        (log) =>
          log.eventName === "LineOpened" &&
          log.args.lineId === line.lineId &&
          isAddressEqual(log.args.sponsor, line.sponsor) &&
          isAddressEqual(log.args.agent, line.agent) &&
          log.args.epoch === line.epoch,
      );
    if (!opened) problems.push(`transaction ${line.opened.txHash} emits no LineOpened(${line.lineId}, ${line.sponsor}, ${line.agent}, epoch ${line.epoch})`);
    else reserve = opened.args.reserve;
    return verdict(problems, `LineOpened(${line.lineId}) for sponsor ${line.sponsor} and agent ${line.agent}, epoch ${line.epoch}, reserve ${reserve}, in block ${mined.blockNumber}`);
  });
  await record("line.idRecomputed", "chain", async () => {
    const recomputed = keccak256(
      encodeAbiParameters(parseAbiParameters("uint256, address, address, address, uint64"), [connection.chainId, connection.address, line.sponsor, line.agent, line.epoch]),
    );
    return verdict(
      recomputed === line.lineId ? [] : [`keccak256(abi.encode(chainId, Float, sponsor, agent, epoch)) is ${recomputed}, not the bundle's lineId ${line.lineId}`],
      "lineId = keccak256(abi.encode(chainId, Float, sponsor, agent, epoch))",
    );
  });

  // The independent scan: every line event from the deploy block to observedAt.
  const range = `${deployment.deployBlock}-${observedAt.blockNumber}`;
  let logs = null;
  let scanError = null;
  try {
    const names = ["ProviderPaid", "SpendBlocked", "Repaid", "LineClosed", "SponsorClaimed", "LineDefaulted"];
    // One event's scan at a time, so a failed scan leaves none still running.
    const found = [];
    for (const name of names) found.push(await findLogs(connection, name, { lineId: line.lineId }, deployment.deployBlock, observedAt.blockNumber));
    logs = Object.fromEntries(names.map((name, k) => [name, sorted(found[k])]));
  } catch (error) {
    scanError = `scanning the line's events in blocks ${range} failed: ${rpcErrorDetail(error)}`;
  }
  const scanned = () => need(logs, scanError);
  const windows = logs ? cycleWindows(logs.ProviderPaid, logs.Repaid) : new Map();
  // A paid digest's repayment window; when the scan failed, its error.
  const windowOf = (digest) => {
    scanned();
    return need(windows.get(digest), `no ProviderPaid for digest ${digest} on line ${line.lineId} up to block ${observedAt.blockNumber}, so this cycle has no repayment window`);
  };

  await record("completeness.providerPaid", "chain", async () =>
    compareSets(
      "ProviderPaid",
      scanned().ProviderPaid,
      bundle.cycles,
      (log) => `${log.args.digest}@${log.transactionHash}`,
      (cycle) => `${cycle.digest}@${cycle.spend.txHash}`,
      range,
      { ordered: true },
    ),
  );
  await record("completeness.spendBlocked", "chain", async () =>
    compareSets(
      "SpendBlocked",
      scanned().SpendBlocked,
      bundle.refusals,
      (log) => `${log.args.digest}@${log.transactionHash}`,
      (refusal) => `${refusal.digest}@${refusal.txHash}`,
      range,
    ),
  );
  await record("completeness.repaid", "chain", async () =>
    compareSets(
      "Repaid",
      scanned().Repaid,
      bundle.cycles.flatMap((cycle) => cycle.repayments),
      (log) => `${log.args.amount} from ${getAddress(log.args.payer)}@${log.transactionHash}`,
      (repayment) => `${repayment.amount} from ${repayment.payer}@${repayment.txHash}`,
      range,
    ),
  );
  await record("completeness.exit", "chain", async () => {
    const exits = sorted([...scanned().LineClosed, ...scanned().SponsorClaimed]);
    const described = exits.map((log) => `${log.eventName}@${log.transactionHash}`).join(", ");
    if (exit.kind === "none") return verdict(exits.length ? [`the bundle records no exit, but the chain has ${described}`] : [], `no LineClosed or SponsorClaimed for the line in blocks ${range}`);
    const expected = EXIT_EVENTS[exit.kind];
    const problems = [];
    if (exits.length !== 1) problems.push(`the bundle records one exit; the chain has ${exits.length}${exits.length ? `: ${described}` : ""}`);
    else if (exits[0].eventName !== expected || exits[0].transactionHash !== exit.txHash) problems.push(`the chain's exit is ${described}, not ${expected}@${exit.txHash}`);
    return verdict(problems, `the line's only exit event in blocks ${range} is ${expected}@${exit.txHash}`);
  });

  for (const [i, cycle] of bundle.cycles.entries()) await verifyCycle(ctx, list, cycle, i, windowOf, bundle);
  for (const [j, refusal] of bundle.refusals.entries()) await verifyRefusal(ctx, list, refusal, j);

  await record("exit.event", "chain", async () => {
    if (exit.kind === "none") {
      const stray = ["txHash", "blockNumber", "amount"].filter((field) => exit[field] !== null);
      return verdict(stray.length ? [`exit.kind is none but ${stray.join(", ")} ${stray.length > 1 ? "are" : "is"} set`] : [], "the bundle records no exit");
    }
    const eventName = EXIT_EVENTS[exit.kind];
    const mined = await ctx.receipt(exit.txHash);
    const problems = receiptProblems(ctx, mined, exit);
    const found = ctx
      .floatEvents(mined)
      .find((log) => log.eventName === eventName && log.args.lineId === line.lineId && isAddressEqual(log.args.sponsor, line.sponsor));
    if (!found) return ["FAIL", [...problems, `transaction ${exit.txHash} emits no ${eventName} for line ${line.lineId} and sponsor ${line.sponsor}`].join("; ")];
    if (found.args.amount !== exit.amount) problems.push(`${eventName} pays ${found.args.amount}, not the bundle's ${exit.amount}`);
    if (!hasTransfer(ctx, mined, { from: ctx.float, to: line.sponsor, value: found.args.amount, beforeLog: found })) {
      problems.push(`no USDC Transfer of exactly ${found.args.amount} from the Float to the sponsor precedes the ${eventName}`);
    }
    if (exit.kind === "claim-defaulted" && !scanned().LineDefaulted.some((log) => before(log, found))) problems.push("no LineDefaulted precedes the claim");
    return verdict(problems, `${eventName} paid the sponsor exactly ${found.args.amount}, moved by a USDC transfer from the Float, in block ${mined.blockNumber}`);
  });
  await record("exit.state", "chain", async () => {
    const events = scanned();
    const final = await read(connection, "getLine", [line.lineId], observedAt.blockNumber);
    const last = events.ProviderPaid.at(-1);
    const outstanding = last ? last.args.principal - sum(windows.get(last.args.digest).repaid.map((log) => log.args.amount)) : 0n;
    const defaulted = events.LineDefaulted.length > 0;
    const expectedState =
      exit.kind === "close" ? "CLOSED" : exit.kind === "claim-defaulted" || defaulted ? "DEFAULTED" : outstanding > 0n ? "DRAWN" : "OPEN";
    const problems = [];
    const expect = (name, actual, expected) => {
      if (actual !== expected) problems.push(`${name} is ${actual} at block ${observedAt.blockNumber}; the events give ${expected}`);
    };
    expect("state", LINE_STATES[final.state], expectedState);
    expect("cumulativePrincipalPaid", final.cumulativePrincipalPaid, sum(events.ProviderPaid.map((log) => log.args.principal)));
    expect("principalOutstanding", final.principalOutstanding, outstanding);
    if (reserve !== null) expect("reserveCap", final.reserveCap, reserve);
    if (exit.kind !== "none") expect("availableReserve", final.availableReserve, 0n);
    else if (!defaulted && reserve !== null) expect("availableReserve", final.availableReserve, reserve - outstanding);
    if (exit.kind === "claim-defaulted") {
      const claim = events.SponsorClaimed.at(-1);
      expect("recoveryAvailable", final.recoveryAvailable, sum(events.Repaid.filter((log) => claim && before(claim, log)).map((log) => log.args.amount)));
    }
    return verdict(problems, `at block ${observedAt.blockNumber} the line is ${expectedState}, with the cumulative principal, outstanding debt and reserve the events give`);
  });

  await record("exporterSummary", "chain", async () => {
    const events = scanned();
    const derived = {
      cycles: BigInt(events.ProviderPaid.length),
      cyclesCleared: BigInt([...windows.values()].filter((window) => window.cleared).length),
      principalPaid: sum(events.ProviderPaid.map((log) => log.args.principal)),
      principalRepaid: sum(events.Repaid.map((log) => log.args.amount)),
      refusals: BigInt(events.SpendBlocked.length),
      // An intent file without a signature proves nothing, so it counts as missing.
      missingIntentFiles: BigInt([...bundle.cycles, ...bundle.refusals].filter((entry) => (entry.intent?.signature ?? null) === null).length),
      missingDeliveries: BigInt(bundle.cycles.filter((cycle) => cycle.provider.delivery === null).length),
    };
    const problems = SUMMARY_FIELDS.filter((field) => bundle.exporterSummary[field] !== derived[field]).map(
      (field) => `${field} is ${bundle.exporterSummary[field]}; this verifier derives ${derived[field]}`,
    );
    return verdict(
      problems,
      `${SUMMARY_FIELDS.map((field) => `${field} ${derived[field]}`).join(", ")}: counts and sums from the chain's events; missingIntentFiles (cycles and refusals without a signed intent file) and missingDeliveries from the bundle's entries`,
    );
  });

  for (const key of Object.keys(bundle.declared).sort()) declare(`declared.${key}`, bundle.declared.label, bundle.declared[key]);
  declare("bundle.verifierScope", bundle.declared.label, bundle.verifierScope);
  const afterObservedAt = await laterLineEvents(connection, line.lineId, observedAt.blockNumber);
  // Every chain read is pinned by block number only, so, once they are all
  // done, the block at observedAt must still be the bundle's: after a reorg
  // during the run, the report would not be derived from the stated block.
  if (observedHash.status === "PASS") {
    let reread = null;
    try {
      const block = await connection.client.getBlock({ blockNumber: observedAt.blockNumber });
      if (block.hash !== observedAt.blockHash) reread = `the observation block was reorganized during verification: block ${observedAt.blockNumber} is now ${block.hash}, not the bundle's ${observedAt.blockHash}`;
    } catch (error) {
      reread =
        error instanceof BlockNotFoundError
          ? `the observation block was reorganized during verification: block ${observedAt.blockNumber} no longer exists`
          : `block ${observedAt.blockNumber} cannot be read again after the other checks, so they are not shown to have read the bundle's ${observedAt.blockHash}: ${rpcErrorDetail(error)}`;
    }
    if (reread) Object.assign(observedHash, { status: "FAIL", detail: reread });
  }
  // Every check, readDeployment's read of the path included, must have seen the bytes read at the start.
  let changed = null;
  try {
    if (!readFileSync(manifest).equals(manifestBytes)) changed = "its bytes are not those read at the start";
  } catch (error) {
    changed = `it cannot be read again: ${errorMessage(error)}`;
  }
  if (changed) Object.assign(provenance, { status: "FAIL", detail: `manifest changed during verification: ${changed}` });
  return list.report({ ...extra, afterObservedAt });
}

// Every Float event that carries the line's id (indexed in each of them).
const LINE_EVENTS = floatAbi.filter((item) => item.type === "event" && item.inputs.some((input) => input.name === "lineId")).map((item) => item.name);

// Informational, never a check: the line's events after observedAt, up to the
// head or at most MAX_LOOKBACK_BLOCKS past observedAt (truncated says which). A
// bundle pinned at an older block still verifies; this shows what it leaves out.
// One event's scan at a time, so a failed scan leaves none still running.
async function laterLineEvents(connection, lineId, observed) {
  try {
    const head = await connection.client.getBlockNumber();
    const scannedTo = head - observed > MAX_LOOKBACK_BLOCKS ? observed + MAX_LOOKBACK_BLOCKS : head;
    const found = [];
    for (const name of LINE_EVENTS) found.push(await findLogs(connection, name, { lineId }, observed + 1n, scannedTo));
    const laterLineEvents = LINE_EVENTS.map((event, k) => ({ event, count: found[k].length })).filter((entry) => entry.count > 0);
    return { head, scannedTo, truncated: scannedTo < head, laterLineEvents };
  } catch (error) {
    return { head: null, scannedTo: null, truncated: null, laterLineEvents: null, error: `scanning the blocks after observedAt ${observed} failed: ${rpcErrorDetail(error)}` };
  }
}

async function verify(values) {
  const path = required(values, "bundle");
  if (values.manifest === undefined || values.manifest === "") {
    throw new UsageError("--manifest <release manifest> is required: the repository's reviewed release record, never a file from the bundle's author");
  }
  const rpcUrl = process.env.ARC_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("ARC_RPC_URL is required");
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read bundle ${path}: ${errorMessage(error)}`);
  }
  const report = await verifyBundle(raw, { rpcUrl, manifest: values.manifest });
  if (values.out !== undefined) writeJsonFile(values.out, report);
  return { ...report, out: values.out ?? null };
}

const OPTIONS = { bundle: { type: "string" }, manifest: { type: "string" }, out: { type: "string" } };
const USAGE = [
  "node app/scripts/float-mainnet-verify.mjs verify --bundle <evidence-bundle.json> --manifest <release manifest> [--out <report.json>]",
  "Reads ARC_RPC_URL only; the chain id, Float address, runtime code hash and deploy block come from the bundle and are checked against the chain and against --manifest. State is read at pinned historical blocks, so the RPC must serve archive state.",
  "--manifest is the repository's reviewed release record (a manifest committed at a reviewed commit), never a file from the bundle's author. The code at its address must equal this checkout's forge build of the pinned reviewed source (contracts/out), with the manifest's config and USDC. Those checks catch a manifest inconsistent with the chain or the reviewed code, not a consistent one written for another deployment. deployment.manifestProvenance passes only when the bytes read from --manifest are that file as committed at HEAD in this checkout, and fails if the file changes during the run; any other --manifest is a rehearsal and leaves it MANUAL. A pass proves only that the manifest is committed in this checkout's history, which anyone can arrange on a local branch: confirm that the reported commit is on the reviewed upstream branch and that this checkout, which also supplies the pins and this verifier, is that branch.",
  "Exit 1 when any check FAILs. qualifying is ok with nothing MANUAL, so it needs a committed release manifest. MANUAL checks (for example a rehearsal manifest, a cycle without its provider receipts, or a refusal relayed through a contract, whose calldata is not decoded) and DECLARED fields never pass or fail the report. An intent file missing from the bundle is recovered from the executeSpend calldata of a transaction sent directly to the Float.",
];

// runCli's contract (one JSON object; a usage error exits 2 with the full
// usage; a thrown error, or a report that is not ok, exits 1), without its env
// footer, which names FLOAT_MAINNET_ADDRESS and FLOAT_MAINNET_EXPECTED_CHAIN_ID:
// the verifier reads neither.
function runVerifier(argv) {
  const run = async () => {
    const [command, ...args] = argv;
    if (command !== "verify") throw new UsageError(command === undefined ? "a command is required" : `unknown command ${JSON.stringify(command)}`);
    let values;
    try {
      ({ values } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false }));
    } catch (error) {
      throw new UsageError(`verify: ${error.message}`);
    }
    return verify(values);
  };
  return run().then(
    (result) => {
      printJson(result);
      if (result.ok !== true) process.exitCode = 1;
    },
    (error) => {
      const failure = { ok: false, error: { message: errorMessage(error), revert: revertName(error) } };
      if (error instanceof UsageError) failure.usage = USAGE;
      printJson(failure);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}

if (isEntrypoint(import.meta)) runVerifier(process.argv.slice(2));
