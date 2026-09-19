import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { getAddress, keccak256 } from "viem";
import { UsageError, bytes32Flag, connect, failIf, latestBlock, required, runCli } from "./float-mainnet-cli.mjs";
import { readIntentFile, validateIntentFile, writeJsonFile } from "./float-mainnet-intent.mjs";
import { errorMessage, isEntrypoint } from "./float-mainnet-preflight.mjs";
import { ACCEPTANCE_KIND, DELIVERY_KIND, checkPayment, requestIdHashOf, signatureAt, validateReceiptFile } from "./float-mainnet-provider.mjs";

// Agent-side client for a provider that follows the provider kit's protocol
// (Shadow's own convention, not x402; reference server:
// examples/float-mainnet-provider-server). accept sends the signed intent
// before payment and checks the provider's ServiceAcceptance. fetch never pays
// and needs no key: it serves a digest only once the contract records it as
// paid, and recovers an interrupted answer by asking again for the same digest,
// which the provider answers from its store without new work.

// fetch asks /serve at most this many times, waiting 1, 2, 4 and 8 s between.
const MAX_ATTEMPTS = 5;
const FIRST_BACKOFF_MS = 1_000;
const REQUEST_TIMEOUT_MS = 120_000;
// An answer larger than this is not read to its end.
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

class OversizedAnswer extends Error {}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${what} file ${path}: ${errorMessage(error)}`);
  }
}

function providerUrlFlag(values) {
  const raw = required(values, "provider-url");
  if (!URL.canParse(raw) || !["http:", "https:"].includes(new URL(raw).protocol)) throw new UsageError("--provider-url must be an http(s) URL");
  return raw.replace(/\/+$/, "");
}

// fetch() reports "fetch failed" and keeps the reason (a reset, a refused
// connection, a timeout) in its cause.
function failure(error) {
  return error?.cause ? `${errorMessage(error)}: ${errorMessage(error.cause)}` : errorMessage(error);
}

function providerError(json) {
  return typeof json?.error === "string" ? json.error : JSON.stringify(json);
}

// Resolves to the provider's { status, json }; rejects when no complete
// answer arrived or its body is not JSON.
async function call(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_ANSWER_BYTES) throw new OversizedAnswer(`HTTP ${response.status} with a body over ${MAX_ANSWER_BYTES} bytes`);
    chunks.push(chunk);
  }
  try {
    return { status: response.status, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    throw new Error(`HTTP ${response.status} with a body that is not JSON`);
  }
}

// A ServiceAcceptance checked with the kit's receipt rules: for this digest
// (and request id, when given), matching the intent's provider, endpoint and
// principal when the intent is known, accepted no later than the latest block,
// and signed by the provider it names.
async function checkAcceptance(connection, file, { digest, struct, requestId }) {
  const receipt = validateReceiptFile(file, connection, ACCEPTANCE_KIND);
  const { message } = receipt;
  const problems = [];
  if (message.digest !== digest) problems.push(`the acceptance is for digest ${message.digest}, not ${digest}`);
  if (requestId !== undefined && receipt.requestId !== requestId) {
    problems.push(`the acceptance is for request ${JSON.stringify(receipt.requestId)}, not ${JSON.stringify(requestId)}`);
  }
  if (struct) {
    if (message.provider !== struct.provider) problems.push(`the acceptance names provider ${message.provider}; the intent pays ${struct.provider}`);
    if (message.endpointHash !== struct.endpointHash) {
      problems.push(`the acceptance is for endpointHash ${message.endpointHash}; the intent's is ${struct.endpointHash}`);
    }
    if (message.principal !== struct.principal) problems.push(`the acceptance is for principal ${message.principal}; the intent's is ${struct.principal}`);
  }
  const { timestamp } = await latestBlock(connection);
  if (message.acceptedAt > timestamp) problems.push(`the acceptance's acceptedAt ${message.acceptedAt} is after the latest block's timestamp ${timestamp}`);
  failIf(problems);
  const verdict = await signatureAt(connection, { signer: message.provider, hash: receipt.hash, signature: receipt.signature });
  if (!verdict.valid) throw new Error(`the acceptance is not signed by provider ${message.provider}: ${verdict.detail}`);
  return receipt;
}

// A /serve answer checked with the kit's receipt rules before anything is
// written: a DeliveryReceipt for this digest, from the paid provider, for the
// agent's request, delivered no earlier than the payment block when that is
// known (paidAt), whose resultHash is keccak256 of the returned bytes;
// validateReceiptFile also checks resultRef against its signed hash. The result
// travels as canonical base64 of its exact bytes.
async function checkDelivery(connection, body, { digest, provider, requestId, paidAt }) {
  if (typeof body?.result !== "string") throw new Error("the answer has no base64 result");
  const bytes = Buffer.from(body.result, "base64");
  if (bytes.toString("base64") !== body.result) throw new Error("the answer's result is not canonical base64");
  const receipt = validateReceiptFile(body.delivery, connection, DELIVERY_KIND);
  const { message } = receipt;
  const resultHash = keccak256(bytes);
  const problems = [];
  if (message.digest !== digest) problems.push(`the delivery is for digest ${message.digest}, not ${digest}`);
  if (message.provider !== provider) problems.push(`the delivery names provider ${message.provider}, not the paid provider ${provider}`);
  if (message.requestIdHash !== requestIdHashOf(requestId)) {
    problems.push(`the delivery is for request ${JSON.stringify(receipt.requestId)}, not the agent's request ${JSON.stringify(requestId)}`);
  }
  if (paidAt !== null && message.deliveredAt < paidAt) {
    problems.push(`the delivery's deliveredAt ${message.deliveredAt} is before the payment block's timestamp ${paidAt}`);
  }
  if (message.resultHash !== resultHash) problems.push(`the returned result hashes to ${resultHash}, but the delivery signs resultHash ${message.resultHash}`);
  failIf(problems);
  const verdict = await signatureAt(connection, { signer: provider, hash: receipt.hash, signature: receipt.signature });
  if (!verdict.valid) throw new Error(`the delivery is not signed by provider ${provider}: ${verdict.detail}`);
  return { bytes, resultHash };
}

async function accept(values) {
  const url = providerUrlFlag(values);
  const path = required(values, "intent");
  const requestId = required(values, "request-id");
  const connection = await connect(values);
  const intent = readJson(path, "intent");
  const { struct, digest, signature } = validateIntentFile(intent, connection);
  if (signature === null) throw new Error("the intent file carries no signature; the agent signs it before sending it to the provider");
  let reply;
  try {
    reply = await call(`${url}/accept`, { intent, requestId });
  } catch (error) {
    throw new Error(
      `no answer from the provider (${failure(error)}); nothing is paid before acceptance, and accept with the same --request-id returns the acceptance the provider stored`,
    );
  }
  if (reply.status >= 500) {
    throw new Error(
      `the provider failed (HTTP ${reply.status}): ${providerError(reply.json)}; nothing is paid before acceptance, so this is retryable: run accept again with the same --request-id`,
    );
  }
  if (reply.status !== 200) throw new Error(`the provider refused the intent (HTTP ${reply.status}): ${providerError(reply.json)}`);
  try {
    await checkAcceptance(connection, reply.json, { digest, struct, requestId });
  } catch (error) {
    throw new Error(`rejected the provider's acceptance${values.out === undefined ? "" : `; nothing was written to ${values.out}`}: ${errorMessage(error)}`);
  }
  if (values.out !== undefined) writeJsonFile(values.out, reply.json);
  return { ...reply.json, ok: true, digest, out: values.out ?? null };
}

async function fetchResult(values) {
  const url = providerUrlFlag(values);
  const out = required(values, "out");
  const byIntent = values.intent !== undefined;
  if (byIntent === (values.digest !== undefined)) throw new UsageError("pass --intent <signed.json> or --digest <bytes32>");
  if (values.acceptance === undefined && values["request-id"] === undefined) {
    throw new UsageError("pass --acceptance <acceptance.json> or --request-id <id>: fetch keeps a delivery only for the agent's own request");
  }
  const requestIdFlag = values["request-id"] === undefined ? undefined : required(values, "request-id");
  const digestFlag = byIntent ? null : bytes32Flag(values, "digest");
  const connection = await connect(values);
  const intent = byIntent ? readIntentFile(values.intent, connection) : null;
  const digest = intent?.digest ?? digestFlag;
  const accepted =
    values.acceptance === undefined
      ? null
      : await checkAcceptance(connection, readJson(values.acceptance, "acceptance"), { digest, struct: intent?.struct, requestId: requestIdFlag });
  const requestId = accepted?.requestId ?? requestIdFlag;

  // Nothing here pays: the contract's receiptStatus decides whether there is
  // anything to fetch, before the provider is contacted.
  const payment = await checkPayment(connection, digest);
  if (!payment.paid) {
    const why =
      payment.receiptStatus === "blocked"
        ? "the contract recorded a refusal and paid nothing, so the provider owes no service for it"
        : "nothing has been paid for it; this tool never pays (the executor submits the intent)";
    return {
      ok: false,
      digest,
      paid: false,
      receiptStatus: payment.receiptStatus,
      error: { message: `receiptStatus for digest ${digest} is ${payment.receiptStatus} at block ${payment.observedAt.blockNumber}: ${why}; the provider was not contacted`, revert: null },
    };
  }
  const provider = accepted?.message.provider ?? intent?.struct.provider ?? payment.providerPaid?.provider ?? null;
  if (provider === null) {
    throw new Error(`digest ${digest} is paid, but the paid provider is unknown (${payment.hint}); pass --acceptance or --intent`);
  }
  // The payment block's timestamp, when its ProviderPaid is found: the verifier
  // refuses an acceptance after it and a delivery before it.
  let paidAt = null;
  if (payment.providerPaid) {
    const paid = payment.providerPaid;
    const principal = accepted?.message.principal ?? intent?.struct.principal ?? paid.principal;
    if (getAddress(paid.provider) !== provider || paid.principal !== principal) {
      throw new Error(
        `digest ${digest} paid provider ${paid.provider} principal ${paid.principal} (ProviderPaid in ${paid.transactionHash}), not provider ${provider} principal ${principal}`,
      );
    }
    paidAt = (await connection.client.getBlock({ blockNumber: paid.blockNumber })).timestamp;
    if (accepted && accepted.message.acceptedAt > paidAt) {
      throw new Error(
        `the acceptance's acceptedAt ${accepted.message.acceptedAt} is after the payment block's timestamp ${paidAt} (ProviderPaid in ${paid.transactionHash}): an acceptance signed after the payment is refused by the verifier; the provider was not contacted`,
      );
    }
  }

  const failures = [];
  let attempts = 0;
  for (let round = 1; round <= MAX_ATTEMPTS; round++) {
    if (round > 1) {
      const wait = FIRST_BACKOFF_MS * 2 ** (round - 2);
      console.error(`${failures.at(-1)}; checking the provider's /status, then asking again for digest ${digest} in ${wait} ms (nothing is paid again)`);
      await sleep(wait);
      let status;
      try {
        status = await call(`${url}/status/${digest}`);
      } catch (error) {
        failures.push(`status: ${failure(error)}`);
        continue;
      }
      if (status.status !== 200) {
        failures.push(`status: HTTP ${status.status}: ${providerError(status.json)}`);
        continue;
      }
      if (status.json.accepted !== true) {
        throw new Error(`the provider's /status holds no acceptance for digest ${digest}, so it cannot serve it; take the digest and its payment to the provider`);
      }
    }
    attempts += 1;
    let reply;
    try {
      reply = await call(`${url}/serve`, { digest });
    } catch (error) {
      if (error instanceof OversizedAnswer) throw new Error(`the provider's answer for digest ${digest} is ${error.message}; nothing was written to ${out}`);
      failures.push(`serve: ${failure(error)}`);
      continue;
    }
    // A 402 means the provider's chain view lags the one read above.
    if (reply.status >= 500 || reply.status === 402) {
      failures.push(`serve: HTTP ${reply.status}: ${providerError(reply.json)}`);
      continue;
    }
    if (reply.status !== 200) throw new Error(`the provider refused to serve digest ${digest} (HTTP ${reply.status}): ${providerError(reply.json)}`);
    let checked;
    try {
      checked = await checkDelivery(connection, reply.json, { digest, provider, requestId, paidAt });
    } catch (error) {
      throw new Error(`rejected the provider's answer for digest ${digest}; nothing was written to ${out}: ${errorMessage(error)}`);
    }
    // Written beside --out and renamed over it: --out holds its old content or the whole result.
    const temporary = `${out}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, checked.bytes, { flag: "wx" });
      renameSync(temporary, out);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return { ok: true, digest, delivery: reply.json.delivery, resultHash: checked.resultHash, attempts, out };
  }
  return {
    ok: false,
    digest,
    attempts,
    failures,
    error: {
      message: `no checked delivery for digest ${digest} after ${attempts} requests to /serve; the digest stays paid and nothing was paid again. Run fetch again later with the same digest, or take the digest and its payment to the provider`,
      revert: null,
    },
  };
}

const COMMANDS = {
  accept: {
    options: { "provider-url": { type: "string" }, intent: { type: "string" }, "request-id": { type: "string" }, out: { type: "string" } },
    run: accept,
  },
  fetch: {
    options: {
      "provider-url": { type: "string" },
      intent: { type: "string" },
      digest: { type: "string" },
      acceptance: { type: "string" },
      "request-id": { type: "string" },
      out: { type: "string" },
    },
    run: fetchResult,
  },
};
const TOOL = "node app/scripts/float-mainnet-request.mjs";
const USAGE = [
  `${TOOL} accept --provider-url <url> --intent <signed.json> --request-id <id> [--out <acceptance.json>] [--manifest <path>]`,
  `${TOOL} fetch --provider-url <url> (--intent <signed.json> | --digest <bytes32>) (--acceptance <acceptance.json> | --request-id <id>) --out <result file> [--manifest <path>]`,
  "accept sends the signed intent to the provider's POST /accept before payment, and keeps the ServiceAcceptance only when it is signed by the provider the intent pays, for this digest, request id, endpoint and principal, and accepted no later than the latest block. Re-running it with the same --request-id returns the provider's stored acceptance; a 5xx answer is retryable that way.",
  `fetch never pays and needs no key. It reads receiptStatus from the contract and, unless the digest is paid, stops without contacting the provider. Then it asks POST /serve for the digest; on a lost or failed answer it checks GET /status and asks again for the same digest, at most ${MAX_ATTEMPTS} times with backoff. It writes the result only after checking the DeliveryReceipt: signed by the paid provider, for this digest and the agent's request (the acceptance's, or --request-id; with both, they must agree), with resultHash equal to keccak256 of the returned bytes, a resultRef that matches its signed hash and, when the digest's ProviderPaid is found, a deliveredAt no earlier than the payment block (and an acceptance no later). An answer over ${MAX_ANSWER_BYTES} bytes is refused; --out is replaced through a temporary file and a rename.`,
  "The protocol is Shadow's own convention, not x402: examples/float-mainnet-provider-server/README.md.",
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
