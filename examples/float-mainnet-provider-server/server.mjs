import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { inspect, parseArgs } from "node:util";
import { parseAddress, parseBytes32, parseUint, read } from "../../app/scripts/float-mainnet-cli.mjs";
import { RECEIPT_STATUSES, connectCandidate, endpointHashFrom, readDeployment, walletFromEnv } from "../../app/scripts/float-mainnet-config.mjs";
import { checkSignature, validateIntentFile } from "../../app/scripts/float-mainnet-intent.mjs";
import { errorMessage, isEntrypoint, scrubUrls, stableStringify } from "../../app/scripts/float-mainnet-preflight.mjs";
import {
  ACCEPTANCE_KIND,
  DELIVERY_KIND,
  acceptIntent,
  checkPayment,
  deliverResult,
  requestIdHashOf,
  resultRefHashOf,
  storeOnce,
  validateReceiptFile,
} from "../../app/scripts/float-mainnet-provider.mjs";

// Reference provider server for the ShadowFloatMainnet candidate's provider
// protocol (Shadow's own convention, not x402), built on the provider kit's
// exported functions. POST /accept checks a signed intent before payment and
// signs a ServiceAcceptance; POST /serve serves a digest only once the
// contract's receiptStatus says it is paid, runs the service once per digest
// and signs a DeliveryReceipt; GET /status/<digest> reports what the provider
// holds. Everything is kept by digest in a store directory, so a retry, a
// second request id or a restart gets the stored answer, not new work or a new
// signature (README.md, "Limits", says when the service can run twice).

// The example has no install of its own; keccak256 comes from the viem the kit uses.
const { keccak256 } = createRequire(new URL("../../app/package.json", import.meta.url))("viem");

const KEY = "FLOAT_PROVIDER_PRIVATE_KEY";
const MAX_BODY_BYTES = 65_536;

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function readStored(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

// Concurrent calls for one key share a single run of work. Finished work is
// remembered by the store, not by this map.
function once(map, key, work) {
  let pending = map.get(key);
  if (!pending) {
    pending = work().finally(() => map.delete(key));
    map.set(key, pending);
  }
  return pending;
}

async function jsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(`the request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError("the request body is not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError("the request body is not a JSON object");
  return body;
}

// account is anything with an address and a viem-style signTypedData (an EOA
// from walletFromEnv, or a custom signer for an ERC-1271 provider). service is
// called as service({ digest, requestId, acceptance }) at most once per stored
// digest and returns { result: string | Uint8Array, resultRef?: string }.
// Returns an http.Server that is not yet listening. A 500 answer names only
// the digest; the full error goes to stderr as one JSON line.
export function createProviderServer({ connection, account, endpointHash, price, storeDir, service }) {
  mkdirSync(storeDir, { recursive: true });
  const provider = parseAddress("account.address", account.address, Error);
  const fileOf = (digest, slot) => join(storeDir, `${digest}.${slot}.json`);
  const accepting = new Map();
  const serving = new Map();

  // This server reserves each provider job id for at most one intent digest.
  // The durable claim also arbitrates concurrent accepts for different digests.
  function bindRequest(requestId, digest) {
    const file = join(storeDir, `request-${requestIdHashOf(requestId)}.json`);
    const binding = { requestId, digest };
    const kept = storeOnce(file, binding) ? binding : readStored(file);
    if (kept?.requestId !== requestId || !/^0x[0-9a-f]{64}$/.test(kept?.digest)) {
      throw new HttpError(`the stored binding for request ${JSON.stringify(requestId)} is invalid; the provider has to repair it`, 500);
    }
    if (kept.digest !== digest) {
      throw new HttpError(
        `request ${JSON.stringify(requestId)} is already accepted for digest ${kept.digest}; refusing a second intent for the same request`,
        409,
      );
    }
  }

  // A stored receipt, checked for shape and for this provider and digest. Its
  // signature was verified when it was signed and is not checked again, so an
  // ERC-1271 provider that rotates its signer still serves what it stored.
  function storedReceipt(digest, kind) {
    const file = fileOf(digest, kind === ACCEPTANCE_KIND ? "acceptance" : "delivery");
    const stored = readStored(file);
    if (!stored) return null;
    const receipt = validateReceiptFile(stored, connection, kind);
    if (receipt.message.provider !== provider) throw new Error(`${file} holds provider ${receipt.message.provider}'s receipt, not ${provider}'s`);
    if (receipt.message.digest !== digest) throw new Error(`${file} holds the receipt of digest ${receipt.message.digest}, not ${digest}`);
    return stored;
  }

  // Returns the acceptance and the intent file acceptIntent checked for it
  // (null for a stored one).
  async function acceptOnce({ digest, struct, signature }, intent, requestId) {
    const stored = storedReceipt(digest, ACCEPTANCE_KIND);
    if (stored) {
      bindRequest(stored.requestId, digest);
      return { acceptance: stored, checkedIntent: null };
    }
    // acceptIntent's checks that need no chain read, made first, so that an
    // intent refused on its face costs no RPC call.
    const problems = [];
    if (struct.provider !== provider) problems.push(`the intent pays provider ${struct.provider}, not ${provider}`);
    if (struct.endpointHash !== endpointHash.toLowerCase()) {
      problems.push(`the intent's endpointHash ${struct.endpointHash} is not this endpoint's ${endpointHash.toLowerCase()}`);
    }
    if (struct.principal < price) problems.push(`the intent's principal ${struct.principal} is below the price ${price}`);
    if (signature === null) problems.push("the intent file carries no signature; the agent signs it before sending it to the provider");
    if (problems.length) throw new HttpError(problems.join("; "), 422);
    // acceptIntent refuses with a plain Error listing its problems, before it
    // signs anything. An RPC failure is one of viem's Error subclasses, and a
    // failure once signing has begun is the provider's own: neither is a refusal.
    let signing = false;
    const signer = {
      address: account.address,
      signTypedData: (typed) => {
        signing = true;
        return account.signTypedData(typed);
      },
    };
    let acceptance;
    try {
      ({ acceptance } = await acceptIntent(connection, { intent, endpointHash, price, requestId, account: signer }));
    } catch (error) {
      if (!signing && Object.getPrototypeOf(error) === Error.prototype) throw new HttpError(errorMessage(error), 422);
      throw error;
    }
    bindRequest(requestId, digest);
    const kept = storeOnce(fileOf(digest, "acceptance"), acceptance) ? acceptance : storedReceipt(digest, ACCEPTANCE_KIND);
    return { acceptance: kept, checkedIntent: intent };
  }

  // One acceptance per digest, whatever the request id: the first request id
  // accepted for a digest is the only one ever answered for it.
  async function accept(input, context) {
    if (typeof input.requestId !== "string" || input.requestId === "") throw new HttpError("requestId must be a non-empty string");
    let checked;
    try {
      checked = validateIntentFile(input.intent, connection);
    } catch (error) {
      throw new HttpError(errorMessage(error));
    }
    const { digest } = checked;
    context.digest = digest;
    const { acceptance, checkedIntent } = await once(accepting, digest, () => acceptOnce(checked, input.intent, input.requestId));
    // A stored acceptance, or one a concurrent request's intent file produced,
    // skipped acceptIntent for this request's file: it goes only to an intent
    // the agent signed.
    if (checkedIntent !== input.intent) {
      if (checked.signature === null) throw new HttpError("the intent file carries no signature; the agent signs it before sending it to the provider", 422);
      const verdict = await checkSignature(connection, checked.struct.agent, digest, checked.signature);
      if (!verdict.valid) throw new HttpError(`the agent's signature does not verify: ${verdict.detail}`, 422);
    }
    if (acceptance.requestId !== input.requestId) {
      throw new HttpError(
        `digest ${digest} is already accepted for request ${JSON.stringify(acceptance.requestId)}; refusing a second acceptance for request ${JSON.stringify(input.requestId)}`,
        409,
      );
    }
    return [200, acceptance];
  }

  // The service's output, stored before any delivery is signed over it, so a
  // crash after this point never runs the service again for the digest.
  async function produce(digest, acceptance) {
    const markerFile = fileOf(digest, "started");
    const marker = { digest, requestId: acceptance.requestId };
    if (!storeOnce(markerFile, marker)) {
      const kept = readStored(markerFile);
      if (kept?.digest !== digest || kept?.requestId !== acceptance.requestId) {
        throw new HttpError(`the provider's stored service marker for digest ${digest} disagrees with its acceptance; the provider has to repair it`, 500);
      }
      throw new HttpError(`service outcome for digest ${digest} is unknown; the provider must reconcile it before work can be retried`, 409);
    }
    try {
      const output = await service({ digest, requestId: acceptance.requestId, acceptance });
      const result = output?.result;
      if (typeof result !== "string" && !(result instanceof Uint8Array)) {
        throw new Error("the service must return { result: string | Uint8Array, resultRef?: string }");
      }
      const resultRef = output.resultRef ?? null;
      resultRefHashOf(resultRef); // throws unless resultRef is null or a non-empty string
      const record = { digest, requestId: acceptance.requestId, result: Buffer.from(result).toString("base64"), resultRef };
      const kept = storeOnce(fileOf(digest, "result"), record) ? record : readStored(fileOf(digest, "result"));
      if (kept?.digest !== digest || kept?.requestId !== acceptance.requestId || typeof kept?.result !== "string") {
        throw new Error(`stored result for digest ${digest} is missing or disagrees with its acceptance`);
      }
      return kept;
    } catch (cause) {
      const error = new HttpError(`service outcome for digest ${digest} is unknown; the provider must reconcile it before work can be retried`, 500);
      error.cause = cause;
      throw error;
    }
  }

  async function serveOnce(digest) {
    const acceptance = storedReceipt(digest, ACCEPTANCE_KIND);
    if (!acceptance) return [404, { error: `no accepted request for digest ${digest}` }];
    const delivered = storedReceipt(digest, DELIVERY_KIND);
    const earlier = readStored(fileOf(digest, "result"));
    const marker = readStored(fileOf(digest, "started"));
    if (marker && (marker.digest !== digest || marker.requestId !== acceptance.requestId)) {
      throw new HttpError(`the provider's stored service marker for digest ${digest} disagrees with its acceptance; the provider has to repair it`, 500);
    }
    if (delivered) {
      if (typeof earlier?.result !== "string" || keccak256(Buffer.from(earlier.result, "base64")) !== delivered.typedData.message.resultHash.toLowerCase()) {
        throw new HttpError(
          `the provider's stored result for digest ${digest} is missing or does not match its signed delivery; the provider has to restore it before the digest can be served`,
          500,
        );
      }
    }
    // A result kept from an earlier run is signed over only if it is this
    // digest's, for its accepted request; a store that holds another is the
    // provider's to repair, so no chain read is made.
    if (!delivered && earlier && (earlier.digest !== digest || earlier.requestId !== acceptance.requestId || typeof earlier.result !== "string")) {
      throw new HttpError(
        `the provider's stored result for digest ${digest} is not this digest's result for its accepted request; the provider has to restore it before the digest can be served`,
        500,
      );
    }
    // A stored delivery is not payment evidence: a reorg can remove its
    // payment after it was signed. Recheck before returning either path.
    const payment = await checkPayment(connection, digest);
    if (!payment.paid) return [402, { error: "the digest is not paid", receiptStatus: payment.receiptStatus }];
    if (delivered) return [200, { result: earlier.result, delivery: delivered }];
    const produced = earlier ?? (await produce(digest, acceptance));
    // deliverResult reads the payment again and cross-checks its ProviderPaid.
    const { delivery } = await deliverResult(connection, {
      acceptance,
      resultHash: keccak256(Buffer.from(produced.result, "base64")),
      resultRef: produced.resultRef ?? undefined,
      account,
    });
    const kept = storeOnce(fileOf(digest, "delivery"), delivery) ? delivery : storedReceipt(digest, DELIVERY_KIND);
    return [200, { result: produced.result, delivery: kept }];
  }

  // receiptStatus only: a status request never scans for the ProviderPaid log.
  async function status(digest) {
    const acceptance = storedReceipt(digest, ACCEPTANCE_KIND);
    const receiptStatus = RECEIPT_STATUSES[Number(await read(connection, "receiptStatus", [digest]))];
    return [
      200,
      {
        digest,
        accepted: acceptance !== null,
        requestId: acceptance?.requestId ?? null,
        paid: receiptStatus === "paid",
        receiptStatus,
        delivered: existsSync(fileOf(digest, "delivery")),
      },
    ];
  }

  async function route(request, context) {
    const { pathname } = new URL(request.url, "http://provider.invalid");
    if (request.method === "GET" && pathname.startsWith("/status/")) {
      context.digest = parseBytes32("digest", pathname.slice("/status/".length), HttpError);
      return status(context.digest);
    }
    if (request.method === "POST" && pathname === "/accept") return accept(await jsonBody(request), context);
    if (request.method === "POST" && pathname === "/serve") {
      const digest = parseBytes32("digest", (await jsonBody(request)).digest, HttpError);
      context.digest = digest;
      return once(serving, digest, () => serveOnce(digest));
    }
    return [404, { error: "not found" }];
  }

  return createServer(async (request, response) => {
    const context = { digest: null };
    let status;
    let body;
    try {
      [status, body] = await route(request, context);
    } catch (error) {
      status = error instanceof HttpError ? error.status : 500;
      const failed = `the provider failed on ${context.digest === null ? "this request" : `digest ${context.digest}`} and logged the error; the request can be retried`;
      body = { error: error instanceof HttpError ? errorMessage(error) : failed };
      if (status >= 500) {
        console.error(JSON.stringify({ request: `${request.method} ${request.url}`, digest: context.digest, status, error: scrubUrls(inspect(error)) }));
      }
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(stableStringify(body));
  });
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: "string" } }, strict: true, allowPositionals: false });
  const env = process.env;
  const endpoint = env.PROVIDER_ENDPOINT;
  if (!endpoint) throw new Error("PROVIDER_ENDPOINT is required: the exact endpoint string the sponsor approved for this provider");
  const endpointHash = endpointHashFrom({ endpoint });
  const price = parseUint("PROVIDER_PRICE", env.PROVIDER_PRICE?.trim(), 256, Error);
  const storeDir = env.PROVIDER_STORE_DIR?.trim();
  if (!storeDir) throw new Error("PROVIDER_STORE_DIR is required");
  const port = env.PORT?.trim() || "8080";
  if (!/^\d+$/.test(port) || Number(port) > 65_535) throw new Error("PORT must be a TCP port number");
  const host = env.HOST?.trim() || "127.0.0.1";

  const connection = await connectCandidate(readDeployment(env, { manifest: values.manifest }));
  const { account } = walletFromEnv(connection, KEY);
  // The key now lives only in `account`: the service, loaded below, and any
  // process it starts do not inherit it.
  delete env[KEY];
  const code = await connection.client.getCode({ address: account.address });
  if (code && code !== "0x") {
    throw new Error(
      `${account.address} has code, so its receipts are checked with ERC-1271; call createProviderServer with a custom account { address, signTypedData } that signs with the account's signer`,
    );
  }
  const { default: service } = await import("./service.mjs");
  const server = createProviderServer({ connection, account, endpointHash, price, storeDir, service });
  // A port in use or refused ends main with the one-line JSON error below.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(
    JSON.stringify({
      listening: `http://${host}:${server.address().port}`,
      provider: account.address,
      float: connection.address,
      chainId: connection.chainId.toString(),
      endpoint,
      endpointHash,
      price: price.toString(),
      store: storeDir,
    }),
  );
}

if (isEntrypoint(import.meta)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: errorMessage(error) }));
    process.exitCode = 1;
  });
}
