import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { decodeFunctionData, isAddressEqual } from "viem";
import { BLOCK_REASONS, floatAbi } from "./float-mainnet-config.mjs";
import { UsageError, bytes32Flag, connect, parseBytes32, readLine, required, runCli, stateName } from "./float-mainnet-cli.mjs";
import { validateIntentFile, writeJsonFile } from "./float-mainnet-intent.mjs";
import { byPosition, checkpointStatus, indexEvents, lineEvents, readIndexFile } from "./float-mainnet-indexer.mjs";
import { errorMessage, isEntrypoint, stableStringify } from "./float-mainnet-preflight.mjs";
import { ACCEPTANCE_KIND, DELIVERY_KIND, signatureAt, validateReceiptFile } from "./float-mainnet-provider.mjs";
import { calldataMismatches } from "./float-mainnet-verify.mjs";

// Per-line evidence export for the ShadowFloatMainnet candidate. The bundle
// points at every on-chain record of one line up to a pinned block, attaches
// the participants' signed files (agent intents, provider receipts), and
// carries the operator's declarations under a label saying they are not
// verified. A verifier re-derives the on-chain part from the pointers.

export const BUNDLE_KIND = "ShadowFloatMainnet.EvidenceBundle";
export const DECLARED_LABEL = "declared by the operator; not verifiable on-chain";
export const DECLARED_KEYS = ["independentControl", "customerPurpose", "assistance", "commercial"];
export const VERIFIER_SCOPE =
  "On-chain, an independent verifier can re-derive from the deployment, observedAt and the transaction hashes in this bundle: the candidate's chain, address and runtime code hash; the line's opening, sponsor, agent and epoch; every ProviderPaid (digest, provider, principal, executor as the transaction sender) and every SpendBlocked (digest, reason) recorded for the line up to observedAt, so an omitted one is detectable; every repayment's payer, amount and remaining principal; and the close or defaulted-claim exit. Against this bundle's signatures only: that each intent file hashes to its recorded digest and carries a valid agent signature (ECDSA, or ERC-1271 for a deployed smart account), and that each provider acceptance and delivery receipt is an EIP-712 signature by the paid provider binding its request id to that digest; the chain records no request id or service result, so a missing provider receipt cannot be recovered from the chain, and a delivery receipt is the provider's own statement that it served the request, not proof of the result's content or quality. From the transaction calldata: a spend or refusal sent directly to the Float carries the intent it executed and the agent's signature in its executeSpend calldata, so an intent file must equal them exactly, and a missing intent file can be recovered from them; a transaction relayed through another contract is not decoded. Declared only: independent control, customer purpose, assistance and commercial terms are copied from the operator's declaration and are neither verified by the exporter nor verifiable on-chain. exporterSummary is the exporter's own count, to be recomputed rather than trusted.";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The operator's declaration, copied verbatim; an absent one is all null.
export function declaredFrom(value) {
  if (value === undefined) return Object.fromEntries(DECLARED_KEYS.map((key) => [key, null]));
  if (!isObject(value)) throw new Error("the declaration must be a JSON object");
  const unknown = Object.keys(value).filter((key) => !DECLARED_KEYS.includes(key));
  if (unknown.length) throw new Error(`the declaration has unknown keys ${unknown.join(", ")}; the bundle records only ${DECLARED_KEYS.join(", ")}`);
  return Object.fromEntries(DECLARED_KEYS.map((key) => [key, value[key] ?? null]));
}

// --request-id <digest>=<id>
export function parseRequestId(raw) {
  const at = raw.indexOf("=");
  if (at < 0 || at === raw.length - 1) throw new UsageError("--request-id must be <digest>=<request id>");
  return { digest: parseBytes32("--request-id digest", raw.slice(0, at)), requestId: raw.slice(at + 1), source: `--request-id ${raw}` };
}

// Builds the bundle for lineId from index-shaped events (decimal strings) and
// validated files, each carrying its `path`. Missing files are recorded as
// null; a file that contradicts the line's records throws. `expected` is the
// line state the events imply, for a check against the chain.
export function assembleBundle({
  deployment,
  observedAt,
  lineId,
  events,
  intents = [],
  acceptances = [],
  deliveries = [],
  requestIds = [],
  declared = declaredFrom(undefined),
}) {
  const onLine = events.filter((entry) => entry.args.lineId === lineId);
  const opened = onLine.filter((entry) => entry.event === "LineOpened");
  if (opened.length !== 1) {
    throw new Error(
      `found ${opened.length} LineOpened events for line ${lineId} up to block ${observedAt.blockNumber}; the line is not on this deployment, or the index starts after it was opened`,
    );
  }
  const claims = onLine.filter((entry) => entry.event === "SponsorClaimed").length;
  if (claims > 1) throw new Error(`schema 1 records a single exit; this line has ${claims} claims (SponsorClaimed) up to block ${observedAt.blockNumber}`);

  const cycles = [];
  const paid = [];
  const refusals = [];
  let exit = { kind: "none", txHash: null, blockNumber: null, amount: null };
  let defaulted = false;
  for (const entry of onLine) {
    const where = { txHash: entry.transactionHash, blockNumber: entry.blockNumber };
    if (entry.event === "ProviderPaid") {
      cycles.push({
        index: cycles.length + 1,
        digest: entry.args.digest,
        intent: null,
        spend: { ...where, executor: entry.from },
        repayments: [],
        cleared: false,
        provider: { requestId: null, acceptance: null, delivery: null },
      });
      paid.push({ provider: entry.args.provider, principal: BigInt(entry.args.principal), remaining: BigInt(entry.args.principal) });
    } else if (entry.event === "Repaid") {
      if (!cycles.length) throw new Error(`Repaid in ${entry.transactionHash} precedes every ProviderPaid on line ${lineId}; the index is inconsistent`);
      const cycle = cycles.at(-1);
      cycle.repayments.push({ ...where, payer: entry.args.payer, amount: entry.args.amount });
      paid.at(-1).remaining = BigInt(entry.args.principalRemaining);
      cycle.cleared = paid.at(-1).remaining === 0n;
    } else if (entry.event === "SpendBlocked") {
      refusals.push({ digest: entry.args.digest, ...where, reason: BLOCK_REASONS[Number(entry.args.reason)], intent: null });
    } else if (entry.event === "LineDefaulted") {
      defaulted = true;
    } else if (entry.event === "LineClosed") {
      exit = { kind: "close", ...where, amount: entry.args.amount };
    } else if (entry.event === "SponsorClaimed") {
      exit = { kind: "claim-defaulted", ...where, amount: entry.args.amount };
    }
  }

  const recorded = new Map([...cycles, ...refusals].map((entry) => [entry.digest, entry]));
  const structs = new Map();
  for (const intent of intents) {
    if (intent.struct.lineId !== lineId) throw new Error(`${intent.path}: the intent is for line ${intent.struct.lineId}, not ${lineId}`);
    const target = recorded.get(intent.digest);
    if (!target) {
      throw new Error(`${intent.path}: digest ${intent.digest} is not recorded on line ${lineId} (no ProviderPaid or SpendBlocked up to block ${observedAt.blockNumber})`);
    }
    if (intent.signature === null) throw new Error(`${intent.path}: the intent file has no signature; pass the signed file`);
    if (target.intent !== null && !isDeepStrictEqual(target.intent, intent.file)) {
      throw new Error(`${intent.path}: a different intent file for digest ${intent.digest} was already given`);
    }
    target.intent = intent.file;
    structs.set(intent.digest, intent.struct);
  }

  const cycleIndex = new Map(cycles.map((cycle, i) => [cycle.digest, i]));
  const requestIdOf = new Map();
  const bindRequestId = (i, requestId, source) => {
    const prior = requestIdOf.get(i);
    if (prior && prior.requestId !== requestId) {
      throw new Error(`cycle ${i + 1} has request id ${JSON.stringify(prior.requestId)} from ${prior.source}, but ${JSON.stringify(requestId)} from ${source}`);
    }
    if (!prior) requestIdOf.set(i, { requestId, source });
  };
  const cycleOf = (digest, source) => {
    const i = cycleIndex.get(digest);
    if (i !== undefined) return i;
    const refused = recorded.has(digest) ? " (it was refused, so nothing was paid)" : "";
    throw new Error(`${source}: digest ${digest} has no paid cycle on line ${lineId}${refused}`);
  };
  const attach = (receipt, slot) => {
    const i = cycleOf(receipt.message.digest, receipt.path);
    if (receipt.message.provider !== paid[i].provider) {
      throw new Error(`${receipt.path}: signed for provider ${receipt.message.provider}, but cycle ${i + 1} paid ${paid[i].provider}`);
    }
    if (cycles[i].provider[slot] !== null) throw new Error(`${receipt.path}: cycle ${i + 1} already has a provider ${slot} file`);
    cycles[i].provider[slot] = receipt.file;
    bindRequestId(i, receipt.requestId, receipt.path);
    return i;
  };
  for (const acceptance of acceptances) {
    const i = attach(acceptance, "acceptance");
    if (acceptance.message.principal !== paid[i].principal) {
      throw new Error(`${acceptance.path}: accepts principal ${acceptance.message.principal}, but cycle ${i + 1} paid ${paid[i].principal}`);
    }
    const struct = structs.get(cycles[i].digest);
    if (struct && acceptance.message.endpointHash !== struct.endpointHash) {
      throw new Error(`${acceptance.path}: accepts endpoint hash ${acceptance.message.endpointHash}, but the cycle ${i + 1} intent names ${struct.endpointHash}`);
    }
  }
  for (const delivery of deliveries) attach(delivery, "delivery");
  for (const entry of requestIds) bindRequestId(cycleOf(entry.digest, entry.source), entry.requestId, entry.source);
  for (const [i, { requestId }] of requestIdOf) cycles[i].provider.requestId = requestId;

  const sum = (values) => values.reduce((total, value) => total + value, 0n);
  const last = paid.at(-1);
  const principalOutstanding = last ? last.remaining : 0n;
  const bundle = {
    kind: BUNDLE_KIND,
    schema: 1,
    deployment,
    observedAt,
    line: {
      lineId,
      sponsor: opened[0].args.sponsor,
      agent: opened[0].args.agent,
      epoch: opened[0].args.epoch,
      opened: { txHash: opened[0].transactionHash, blockNumber: opened[0].blockNumber },
    },
    cycles,
    refusals,
    exit,
    declared: { label: DECLARED_LABEL, ...declared },
    exporterSummary: {
      cycles: cycles.length,
      cyclesCleared: cycles.filter((cycle) => cycle.cleared).length,
      principalPaid: sum(paid.map((draw) => draw.principal)).toString(),
      principalRepaid: sum(cycles.flatMap((cycle) => cycle.repayments.map((repayment) => BigInt(repayment.amount)))).toString(),
      refusals: refusals.length,
      missingIntentFiles: [...cycles, ...refusals].filter((entry) => entry.intent === null).length,
      missingDeliveries: cycles.filter((cycle) => cycle.provider.delivery === null).length,
    },
    verifierScope: VERIFIER_SCOPE,
  };
  const state = exit.kind === "close" ? "CLOSED" : defaulted ? "DEFAULTED" : principalOutstanding > 0n ? "DRAWN" : "OPEN";
  return { bundle, expected: { state, principalOutstanding, cumulativePrincipalPaid: sum(paid.map((draw) => draw.principal)) } };
}

function cell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function fenced(value) {
  const text = JSON.stringify(value, null, 2);
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}json\n${text}\n${fence}`;
}

const DECLARED_TITLES = {
  independentControl: "Independent control",
  customerPurpose: "Customer purpose",
  assistance: "Assistance",
  commercial: "Commercial evidence",
};

// A human summary of the bundle that keeps the three kinds of evidence apart.
export function evidenceMarkdown(bundle, events) {
  const paid = new Map(events.filter((entry) => entry.event === "ProviderPaid").map((entry) => [entry.args.digest, entry.args]));
  const { deployment, observedAt, line, exit, exporterSummary: summary } = bundle;
  const present = (file) => (file === null ? "missing" : "included");
  const exitLine =
    exit.kind === "none"
      ? "Exit: none recorded up to the observed block."
      : `Exit: ${exit.kind === "close" ? "sponsor closed the line" : "sponsor claimed after default"}, ${exit.amount} returned, in ${exit.txHash} (block ${exit.blockNumber}).`;
  return [
    `# Shadow Float evidence: line ${line.lineId}`,
    "",
    `Candidate ${deployment.address} on chain ${deployment.chainId}, deployed at block ${deployment.deployBlock}, runtime keccak256 ${deployment.runtimeKeccak256}, source commit ${deployment.sourceCommit}. Observed at block ${observedAt.blockNumber} (${observedAt.blockHash}). Written by the exporter: a verifier re-derives the on-chain facts from the transaction hashes in the bundle and does not rely on this summary.`,
    "",
    "## Recorded on-chain",
    "",
    `Sponsor ${line.sponsor} opened the line for agent ${line.agent} (epoch ${line.epoch}) in ${line.opened.txHash} (block ${line.opened.blockNumber}).`,
    "",
    "| Cycle | Digest | Provider | Principal | Spend tx (block) | Executor | Repayments (amount by payer in tx) | Cleared |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...bundle.cycles.map((cycle) => {
      const draw = paid.get(cycle.digest);
      const repayments = cycle.repayments.map((repayment) => `${repayment.amount} by ${repayment.payer} in ${repayment.txHash}`).join("; ") || "none";
      return `| ${cycle.index} | ${cycle.digest} | ${draw.provider} | ${draw.principal} | ${cycle.spend.txHash} (${cycle.spend.blockNumber}) | ${cycle.spend.executor} | ${repayments} | ${cycle.cleared ? "yes" : "no"} |`;
    }),
    "",
    ...(bundle.refusals.length
      ? [
          "| Refusal | Digest | Reason | Tx (block) |",
          "| --- | --- | --- | --- |",
          ...bundle.refusals.map((refusal, i) => `| ${i + 1} | ${refusal.digest} | ${refusal.reason} | ${refusal.txHash} (${refusal.blockNumber}) |`),
        ]
      : ["No recorded refusals."]),
    "",
    exitLine,
    "",
    `Principal paid ${summary.principalPaid}, repaid ${summary.principalRepaid} (atomic USDC); ${summary.cyclesCleared} of ${summary.cycles} cycles cleared.`,
    "",
    "## Signed by participants (bundle)",
    "",
    "The participants' own signed files, checked against the digests above. A provider receipt is not recorded on-chain and cannot be recovered from the chain; an intent sent directly to the Float is also in its transaction's executeSpend calldata, from which a missing intent file can be recovered.",
    "",
    "| Cycle | Agent-signed intent | Provider request id | Provider acceptance | Provider delivery |",
    "| --- | --- | --- | --- | --- |",
    ...bundle.cycles.map(
      (cycle) =>
        `| ${cycle.index} | ${present(cycle.intent)} | ${cycle.provider.requestId === null ? "missing" : cell(cycle.provider.requestId)} | ${present(cycle.provider.acceptance)} | ${present(cycle.provider.delivery)} |`,
    ),
    "",
    ...bundle.refusals.map((refusal, i) => `Refusal ${i + 1} agent-signed intent: ${present(refusal.intent)}.`),
    `Missing intent files: ${summary.missingIntentFiles}. Missing delivery receipts: ${summary.missingDeliveries}.`,
    "",
    "## Declared (not verified)",
    "",
    `> ${bundle.declared.label}`,
    "",
    ...DECLARED_KEYS.flatMap((key) => [
      `### ${DECLARED_TITLES[key]}`,
      "",
      bundle.declared[key] === null ? "Not declared." : fenced(bundle.declared[key]),
      "",
    ]),
    "## Verifier scope",
    "",
    bundle.verifierScope,
    "",
  ].join("\n");
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${what} ${path}: ${errorMessage(error)}`);
  }
}

function fileEntry(path, what, validate) {
  const file = readJson(path, what);
  try {
    return { path, file, ...validate(file) };
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

// The manifest fields the bundle records; readDeployment and connectCandidate
// have already checked its ok flag, chain, address and runtime code hash.
function deploymentFrom(manifestPath, connection) {
  const manifest = readJson(manifestPath, "manifest");
  const sourceCommit = manifest.source?.commit;
  if (typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`${manifestPath} has no source.commit`);
  return {
    chainId: connection.chainId.toString(),
    address: connection.address,
    deployBlock: connection.deployBlock.toString(),
    runtimeKeccak256: manifest.bytecode.onchainRuntimeKeccak256.toLowerCase(),
    sourceCommit,
  };
}

// The events and the block they are pinned at: an index file (its events
// checked by readIndexFile, then put in block and log order), provided it
// covers the deployment, its checkpoint is still canonical and it holds the
// line's events exactly as the chain does, or a fresh scan from the deployment
// block to the head.
async function observedEvents(connection, indexPath, lineId) {
  if (indexPath === undefined) {
    const { index } = await indexEvents(connection, { fromBlock: connection.deployBlock });
    return { events: index.events, observedAt: index.checkpoint };
  }
  const index = readIndexFile(indexPath, connection);
  if (BigInt(index.fromBlock) > connection.deployBlock) {
    throw new Error(`${indexPath} starts at block ${index.fromBlock}, after the deployment block ${connection.deployBlock}, so it can miss events; rebuild it from the manifest`);
  }
  const status = await checkpointStatus(connection, index.checkpoint);
  if (!status.canonical) {
    throw new Error(`${indexPath}: checkpoint block ${index.checkpoint.blockNumber} is no longer ${index.checkpoint.blockHash} (reorg); run index --resume first`);
  }
  const events = [...index.events].sort(byPosition);
  // The index file is not trusted for the line: its events are read again from
  // the chain and must match exactly, so an edited or truncated index can
  // neither drop nor add a record, even a SpendBlocked, which changes nothing
  // getLine reports.
  const onChain = await lineEvents(connection, lineId, connection.deployBlock, BigInt(index.checkpoint.blockNumber));
  const indexed = events.filter((entry) => entry.args.lineId === lineId);
  if (!isDeepStrictEqual(indexed, onChain)) {
    const keys = (list) => new Set(list.map((entry) => stableStringify(entry)));
    const [indexedKeys, chainKeys] = [keys(indexed), keys(onChain)];
    const at = (list) => list.map((entry) => `${entry.event} at block ${entry.blockNumber} log ${entry.logIndex}`).join(", ") || "none";
    throw new Error(
      `${indexPath} does not hold line ${lineId}'s events as the chain records them up to its checkpoint ${index.checkpoint.blockNumber}: ` +
        `missing or altered ${at(onChain.filter((entry) => !indexedKeys.has(stableStringify(entry))))}; ` +
        `not on the chain ${at(indexed.filter((entry) => !chainKeys.has(stableStringify(entry))))}`,
    );
  }
  return { events, observedAt: index.checkpoint };
}

// getLine at observedAt must be what the indexed events imply; otherwise the
// index is incomplete and the bundle would omit records.
async function checkAgainstChain(connection, bundle, expected) {
  const line = await readLine(connection, bundle.line.lineId, BigInt(bundle.observedAt.blockNumber));
  const problems = [
    line.sponsor !== bundle.line.sponsor && `sponsor ${line.sponsor}, events ${bundle.line.sponsor}`,
    line.agent !== bundle.line.agent && `agent ${line.agent}, events ${bundle.line.agent}`,
    line.epoch.toString() !== bundle.line.epoch && `epoch ${line.epoch}, events ${bundle.line.epoch}`,
    stateName(line) !== expected.state && `state ${stateName(line)}, events ${expected.state}`,
    line.principalOutstanding !== expected.principalOutstanding && `principalOutstanding ${line.principalOutstanding}, events ${expected.principalOutstanding}`,
    line.cumulativePrincipalPaid !== expected.cumulativePrincipalPaid &&
      `cumulativePrincipalPaid ${line.cumulativePrincipalPaid}, events ${expected.cumulativePrincipalPaid}`,
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(`getLine at block ${bundle.observedAt.blockNumber} disagrees with the indexed events (${problems.join("; ")}): the index is incomplete`);
  }
}

async function exportBundle(values) {
  const out = required(values, "out");
  const lineId = bytes32Flag(values, "line-id");
  if (values.manifest === undefined) throw new UsageError("--manifest <release manifest> is required: the bundle records the deployment it describes");
  const requestIds = (values["request-id"] ?? []).map(parseRequestId);
  const declared = declaredFrom(values.declared === undefined ? undefined : readJson(values.declared, "--declared file"));

  const connection = await connect(values);
  const deployment = deploymentFrom(values.manifest, connection);
  const intents = (values.intent ?? []).map((path) => fileEntry(path, "intent file", (file) => validateIntentFile(file, connection)));
  // The provider kit's own receipt rules: one source for the kit, the exporter and the verifier.
  const receipts = (flag, kind) => (values[flag] ?? []).map((path) => fileEntry(path, `--${flag} file`, (file) => validateReceiptFile(file, connection, kind)));
  const acceptances = receipts("acceptance", ACCEPTANCE_KIND);
  const deliveries = receipts("delivery", DELIVERY_KIND);

  const { events, observedAt } = await observedEvents(connection, values.index, lineId);
  const { bundle, expected } = assembleBundle({ deployment, observedAt, lineId, events, intents, acceptances, deliveries, requestIds, declared });
  await checkAgainstChain(connection, bundle, expected);
  // Pinned where the verifier checks them: an intent at the block before the
  // transaction that recorded it (the contract validated it there, called from
  // the Float), a receipt at observedAt. A smart account that rotates its
  // signer later cannot fail the export of a genuine bundle.
  const recordedIn = new Map([
    ...bundle.cycles.map((cycle) => [cycle.digest, cycle.spend]),
    ...bundle.refusals.map((refusal) => [refusal.digest, refusal]),
  ]);
  const observed = BigInt(observedAt.blockNumber);
  const signed = [
    ...intents.map((intent) => [intent.path, "agent", intent.struct.agent, intent.digest, intent.signature, BigInt(recordedIn.get(intent.digest).blockNumber) - 1n, connection.address]),
    ...[...acceptances, ...deliveries].map((receipt) => [receipt.path, "provider", receipt.message.provider, receipt.hash, receipt.signature, observed, undefined]),
  ];
  for (const [path, role, signer, hash, signature, blockNumber, caller] of signed) {
    const verdict = await signatureAt(connection, { signer, hash, signature, blockNumber, caller });
    if (!verdict.valid) throw new Error(`${path}: the ${role} signature does not verify for ${signer}: ${verdict.detail}`);
  }
  // Each intent file must be exactly the intent and signature in the
  // executeSpend calldata of the transaction that recorded it, as the
  // verifier's intent.matchesCalldata requires, in its words. A transaction
  // relayed through a contract (a Safe, a 4337 account, a relayer) is not sent
  // to the Float, so its calldata is not decoded and its intent file is not
  // compared: the verifier leaves that comparison MANUAL.
  for (const intent of intents) {
    const { txHash } = recordedIn.get(intent.digest);
    const tx = await connection.client.getTransaction({ hash: txHash });
    if (!tx.to || !isAddressEqual(tx.to, connection.address)) continue;
    // Lowercased, as the verifier decodes it, so its bytes32 fields and signature compare with the file's.
    const { functionName, args } = decodeFunctionData({ abi: floatAbi, data: tx.input.toLowerCase() });
    if (functionName !== "executeSpend") throw new Error(`${intent.path}: transaction ${txHash} calls ${functionName} on the Float, not executeSpend`);
    const [struct, signature] = args;
    const problems = calldataMismatches(intent, { struct, signature });
    if (problems.length) throw new Error(`${intent.path}: ${problems.join("; ")}`);
  }

  // State and signature reads above are pinned by number. Refuse to publish
  // either artifact if the observation block changed during those reads.
  const status = await checkpointStatus(connection, observedAt);
  if (!status.canonical) {
    throw new Error(`the observation block was reorganized during export: block ${observedAt.blockNumber} is now ${status.canonicalHash ?? "missing"}, not ${observedAt.blockHash}; retry the export`);
  }
  writeJsonFile(out, bundle);
  const markdown = `${out}.md`;
  writeFileSync(markdown, evidenceMarkdown(bundle, events));
  return { ok: true, out, markdown, lineId, observedAt, index: values.index ?? null, exporterSummary: bundle.exporterSummary };
}

const COMMANDS = {
  export: {
    options: {
      out: { type: "string" },
      "line-id": { type: "string" },
      intent: { type: "string", multiple: true },
      acceptance: { type: "string", multiple: true },
      delivery: { type: "string", multiple: true },
      "request-id": { type: "string", multiple: true },
      declared: { type: "string" },
      index: { type: "string" },
    },
    run: exportBundle,
  },
};
const TOOL = "node app/scripts/float-mainnet-evidence.mjs";
const USAGE = [
  `${TOOL} export --manifest <path> --line-id <bytes32> --out <bundle.json> [--intent <signed.json> ...] [--acceptance <file> ...] [--delivery <file> ...] [--request-id <digest>=<id> ...] [--declared <file.json>] [--index <index.json>]`,
  "Writes the line's evidence bundle to --out and a Markdown summary to <out>.md. Without --index it scans every Float event from the manifest's deployment block to the latest block; with --index it uses that index file (from float-mainnet-indexer.mjs) pinned at its checkpoint, its events checked and put in block and log order, and requires the line's events in it to be exactly those the chain returns up to the checkpoint.",
  `--declared is a JSON file with any of ${DECLARED_KEYS.join(", ")}, copied verbatim and labelled "${DECLARED_LABEL}".`,
  "A missing intent or receipt file is recorded as null and counted; a file for another deployment or line, or one that contradicts the line's records or does not verify, fails the export. So does a line with more than one SponsorClaimed: schema 1 records a single exit.",
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
