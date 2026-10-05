import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
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
  checkDeliveryPayment,
  assertPaidProviderBinding,
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
  // An absolute deadline, not an inactivity timeout: dribbled bytes cannot
  // keep a body reader alive indefinitely. No service slot is held here.
  const timer = setTimeout(() => request.destroy(new HttpError('Request body deadline exceeded', 408)), 2000);
  timer.unref();
  try {
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
  } finally { clearTimeout(timer); }
}

// account is anything with an address and a viem-style signTypedData (an EOA
// from walletFromEnv, or a custom signer for an ERC-1271 provider). service is
// called as service({ digest, requestId, acceptance }) at most once per stored
// digest and returns { result: string | Uint8Array, resultRef?: string }.
// An optional service.prepare({ digest, requestId }) resolves immutable content
// before acceptance is signed. Its result is stored under the digest and used
// after payment, even if the upstream content later disappears.
// Returns an http.Server that is not yet listening. A 500 answer names only
// the digest; the full error goes to stderr as one JSON line.
export function createProviderServer({ connection, account, endpointHash, price, storeDir, service, publicOrigin = null, trustLoopbackProxy = false, maxConcurrent = publicOrigin ? 4 : 32, maxRequestsPerMinute = 120, maxStoredPurchases = 1000, recoveryOnly = false }) {
  if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith('https://'))) throw new Error('publicOrigin must be an exact HTTPS origin');
  for (const value of [maxConcurrent, maxRequestsPerMinute, maxStoredPurchases]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Provider limits must be positive integers');
  if (typeof recoveryOnly !== "boolean") throw new Error("recoveryOnly must be boolean");
  if (recoveryOnly) {
    if (account.signTypedData || account.type === "local") throw new Error("Recovery mode requires only a public provider address, never a signer");
    if (!statSync(storeDir).isDirectory()) throw new Error("Recovery requires an existing store directory");
  } else mkdirSync(storeDir, { recursive: true });
  const provider = parseAddress("account.address", account.address, Error);
  const fileOf = (digest, slot) => join(storeDir, `${digest}.${slot}.json`);
  const accepting = new Map();
  const serving = new Map();
  const admitting = new Set();

  let reclaiming = null;
  let reclaimCursor = 0;
  let lastReclaim = 0;
  function outstanding() {
    const files = readdirSync(storeDir);
    const terminal = new Set(files.filter(name => /^0x[0-9a-f]{64}\.(?:delivery|released)\.json$/.test(name)).map(name => name.slice(0, 66)));
    return new Set(files.filter(name => /^0x[0-9a-f]{64}\.(?:admission|prepared|acceptance)\.json$/.test(name)).map(name => name.slice(0, 66)).filter(digest => !terminal.has(digest)));
  }

  // Reclaim only with finalized onchain evidence. Keep every original record
  // for recovery/audit; a paid-but-undelivered request must retain its slot.
  // Bound each pass and rotate through the store so RPC work stays bounded.
  async function reclaimExpired() {
    if (reclaiming) return reclaiming;
    if (Date.now() - lastReclaim < 30_000) return;
    lastReclaim = Date.now();
    reclaiming = (async () => {
      const pending = [...outstanding()].filter(digest => !admitting.has(digest));
      if (!pending.length) return;
      const block = await connection.client.getBlock({ blockTag: "finalized" });
      if (block.number === null) throw new Error("Finalized block is unavailable; admission remains held");
      const batch = Array.from({ length: Math.min(32, pending.length) }, (_, i) => pending[(reclaimCursor + i) % pending.length]);
      reclaimCursor = (reclaimCursor + batch.length) % pending.length;
      for (const digest of batch) {
        const metadata = readStored(fileOf(digest, "admission"));
        if (metadata?.digest !== digest || !/^[0-9]+$/.test(metadata.signatureExpiry) || block.timestamp <= BigInt(metadata.signatureExpiry)) continue;
        const status = Number(await read(connection, "receiptStatus", [digest], block.number));
        if (status !== 0 && status !== 1) continue;
        storeOnce(fileOf(digest, "released"), { digest, reason: status === 0 ? "expired-unpaid" : "blocked", blockNumber: block.number.toString(), blockHash: block.hash, timestamp: block.timestamp.toString() });
      }
    })().finally(() => { reclaiming = null; });
    return reclaiming;
  }

  async function reserveAdmission(digest) {
    let stored = outstanding();
    if (stored.has(digest)) return () => {}; // An interrupted retry already occupies its slot.
    if (new Set([...stored, ...admitting]).size >= maxStoredPurchases) await reclaimExpired();
    // No await between this final capacity check and reservation. One process
    // owns each store, including when concurrent callers await the same sweep.
    stored = outstanding();
    if (new Set([...stored, ...admitting]).size >= maxStoredPurchases) {
      throw new HttpError('New purchases are temporarily at capacity; existing purchases can still be recovered', 503);
    }
    admitting.add(digest);
    return () => admitting.delete(digest);
  }

  // This server reserves each provider job id for at most one intent digest.
  // The durable claim also arbitrates concurrent accepts for different digests.
  function bindRequest(requestId, digest, claim = true) {
    const file = join(storeDir, `request-${requestIdHashOf(requestId)}.json`);
    const binding = { requestId, digest };
    const kept = claim ? (storeOnce(file, binding) ? binding : readStored(file)) : readStored(file);
    if (!claim && kept === null) return;
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

  function outputRecord(digest, requestId, output) {
    const result = output?.result;
    if (typeof result !== "string" && !(result instanceof Uint8Array)) {
      throw new Error("the service must return { result: string | Uint8Array, resultRef?: string }");
    }
    const resultRef = output.resultRef ?? null;
    resultRefHashOf(resultRef);
    return { digest, requestId, result: Buffer.from(result).toString("base64"), resultRef };
  }

  function checkedPrepared(digest, requestId) {
    const prepared = readStored(fileOf(digest, "prepared"));
    if (!prepared) return null;
    if (prepared.digest !== digest || prepared.requestId !== requestId || typeof prepared.result !== "string" ||
        Buffer.from(prepared.result, "base64").toString("base64") !== prepared.result) {
      throw new HttpError(`the provider's prepared result for digest ${digest} disagrees with this request; the provider has to repair it`, 409);
    }
    resultRefHashOf(prepared.resultRef);
    return prepared;
  }

  // Returns the acceptance and the intent file acceptIntent checked for it
  // (null for a stored one).
  async function acceptOnce({ digest, struct, signature }, intent, requestId) {
    const stored = storedReceipt(digest, ACCEPTANCE_KIND);
    if (stored) {
      if (typeof service.prepare === "function" && !checkedPrepared(digest, stored.requestId)) {
        throw new HttpError(`prepared service result for digest ${digest} is missing; the provider must reconcile it before payment`, 409);
      }
      bindRequest(stored.requestId, digest);
      return { acceptance: stored, checkedIntent: null };
    }
    const releaseAdmission = await reserveAdmission(digest);
    try {
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
    const rememberAdmission = () => storeOnce(fileOf(digest, "admission"), { digest, signatureExpiry: struct.signatureExpiry.toString() });
    let signing = false;
    const signer = {
      address: account.address,
      signTypedData: async (typed) => {
        signing = true;
        // Reject existing conflicts before upstream work; atomically claim again
        // after preparation, before persisting anything under this digest.
        bindRequest(requestId, digest, false);
        if (typeof service.prepare === "function" && !checkedPrepared(digest, requestId)) {
          const output = await service.prepare({ digest, requestId });
          if (output === null) throw new HttpError(`service request ${JSON.stringify(requestId)} is unavailable; no acceptance was signed`, 422);
          const prepared = outputRecord(digest, requestId, output);
          bindRequest(requestId, digest);
          rememberAdmission();
          if (!storeOnce(fileOf(digest, "prepared"), prepared)) checkedPrepared(digest, requestId);
        }
        // Recheck time-sensitive snapshots before a new signature, including a
        // retry after a signer/process failure. Stored acceptances and paid
        // delivery recovery retain their original bytes and skip this hook.
        if (typeof service.validatePrepared === "function") {
          const prepared = checkedPrepared(digest, requestId);
          if (!prepared) throw new Error("service validation needs a prepared result");
          await service.validatePrepared({ requestId, result: Buffer.from(prepared.result, "base64"), resultRef: prepared.resultRef });
        }
        bindRequest(requestId, digest);
        rememberAdmission();
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
    } finally { releaseAdmission(); }
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
    const prepared = checkedPrepared(digest, acceptance.requestId);
    if (typeof service.prepare === "function" && !prepared) {
      throw new HttpError(`prepared service result for digest ${digest} is missing; the provider must reconcile it before serving`, 409);
    }
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
      const record = prepared ?? outputRecord(digest, acceptance.requestId, await service({ digest, requestId: acceptance.requestId, acceptance }));
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

  async function serveOnce(digest, paymentTransactionHash) {
    const acceptance = storedReceipt(digest, ACCEPTANCE_KIND);
    if (!acceptance) return [404, { error: `no accepted request for digest ${digest}` }];
    const delivered = storedReceipt(digest, DELIVERY_KIND);
    const earlier = readStored(fileOf(digest, "result"));
    if (recoveryOnly) {
      if (!delivered) throw new HttpError("Recovery mode cannot create a delivery; restore the original signed delivery and result", 409);
      const code = await connection.client.getCode({ address: provider });
      if (code && code !== "0x") throw new HttpError("Recovery mode supports ordinary EOA providers only", 409);
      for (const [receipt, kind] of [[acceptance, ACCEPTANCE_KIND], [delivered, DELIVERY_KIND]]) {
        const checked = validateReceiptFile(receipt, connection, kind);
        const signature = await checkSignature(connection, provider, checked.hash, checked.signature);
        if (!signature.valid) throw new HttpError("Stored provider signature does not verify; restore trusted records", 409);
      }
      if (delivered.requestId !== acceptance.requestId || earlier?.digest !== digest || earlier?.requestId !== acceptance.requestId ||
          typeof earlier?.result !== "string" || Buffer.from(earlier.result, "base64").toString("base64") !== earlier.result ||
          resultRefHashOf(earlier.resultRef) !== delivered.typedData.message.resultRefHash.toLowerCase()) {
        throw new HttpError("Stored recovery records disagree; restore trusted records", 409);
      }
    }
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
    const savedPayment = readStored(fileOf(digest, "payment"));
    const payment = await checkPayment(connection, digest, { transactionHash: savedPayment?.transactionHash ?? paymentTransactionHash });
    if (!payment.paid) return [402, { error: "the digest is not paid", receiptStatus: payment.receiptStatus }];
    await assertPaidProviderBinding(connection, payment, acceptance);
    // Upgrade legacy delivered stores too: persist only the independently
    // verified original transaction, before any successful return.
    if (!recoveryOnly) storeOnce(fileOf(digest, "payment"), { transactionHash: payment.providerPaid.transactionHash });
    // Returning our stored bytes creates no new receipt/signature. A rotated
    // smart-provider key must not strand that result; payment binding is still
    // freshly established from the original canonical transaction.
    if (delivered) return [200, { result: earlier.result, delivery: delivered }];
    const verified = await checkDeliveryPayment(connection, { acceptance, account, transactionHash: payment.providerPaid.transactionHash });
    const produced = earlier ?? (await produce(digest, acceptance));
    // deliverResult reads the payment again and cross-checks its ProviderPaid.
    const { delivery } = await deliverResult(connection, {
      acceptance,
      resultHash: keccak256(Buffer.from(produced.result, "base64")),
      resultRef: produced.resultRef ?? undefined,
      account,
      transactionHash: verified.payment.providerPaid.transactionHash,
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

  async function route(request, context, inputBody) {
    const { pathname } = new URL(request.url, "http://provider.invalid");
    if (request.method === "GET" && pathname.startsWith("/status/")) {
      context.digest = parseBytes32("digest", pathname.slice("/status/".length), HttpError);
      return status(context.digest);
    }
    if (request.method === "POST" && pathname === "/accept") {
      if (recoveryOnly) return [503, { error: "Provider is in recovery-only mode; no new acceptances or purchases are offered" }];
      return accept(inputBody, context);
    }
    if (request.method === "POST" && pathname === "/serve") {
      const input = inputBody;
      const digest = parseBytes32("digest", input.digest, HttpError);
      const paymentTransactionHash = input.paymentTransactionHash === undefined ? undefined : parseBytes32("paymentTransactionHash", input.paymentTransactionHash, HttpError);
      context.digest = digest;
      return once(serving, digest, () => serveOnce(digest, paymentTransactionHash));
    }
    return [404, { error: "not found" }];
  }

  const routeQuotas = { accept: new Map(), status: new Map(), serve: new Map() }, callerActive = new Map();
  let normalActive = 0, recoveryActive = 0;
  const readingBodies = { accept: 0, serve: 0 };
  const recoverySlots = Math.max(1, Math.floor(maxConcurrent / 2));
  if (maxConcurrent < 2) throw new Error('Provider needs at least two slots to reserve recovery capacity');
  function callerOf(request) {
    const remote = request.socket.remoteAddress || 'unknown';
    if (trustLoopbackProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      const forwarded = request.headers['x-shadow-client-ip'];
      if (typeof forwarded !== 'string' || !isIP(forwarded)) return null;
      return forwarded.toLowerCase();
    }
    return remote.toLowerCase();
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, connectionsCheckingInterval: 1000, headersTimeout: 10000, keepAliveTimeout: 5000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (publicOrigin) {
      response.setHeader('vary', 'Origin');
      const origin = request.headers.origin;
      if (origin && origin !== publicOrigin) { response.writeHead(403); response.end(); return; }
      if (origin === publicOrigin) {
        response.setHeader('access-control-allow-origin', publicOrigin);
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'content-type');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    }
    let pathname;
    try { pathname = new URL(request.url, 'http://provider.invalid').pathname; }
    catch { response.writeHead(400); response.end('{"error":"Invalid request target"}'); return; }
    const routeKind = request.method === 'POST' && pathname === '/accept' ? 'accept'
      : request.method === 'POST' && pathname === '/serve' ? 'serve'
      : request.method === 'GET' && pathname.startsWith('/status/') ? 'status' : null;
    // Unknown routes cannot spend the budget reserved for real requests.
    if (!routeKind) { response.writeHead(404); response.end('{"error":"not found"}'); return; }
    const caller = callerOf(request);
    if (!caller) { response.writeHead(400); response.end('{"error":"Missing trusted client address"}'); return; }
    const quotas = routeQuotas[routeKind];
    const now = Date.now(), quotaKey = caller;
    let quota = quotas.get(quotaKey);
    if (!quota || now - quota.start >= 60000) {
      if (quotas.size >= 2048) for (const [key, entry] of quotas) if (now - entry.start >= 60000) quotas.delete(key);
      // Keep rate-limit memory bounded without a global new-caller lockout.
      if (!quotas.has(quotaKey) && quotas.size >= 2048) quotas.delete(quotas.keys().next().value);
      quota = { start: now, count: 0 }; quotas.set(quotaKey, quota);
    }
    // Status polling shares normal admission, never paid-result delivery slots.
    const recovery = routeKind === 'serve', activeKey = `${caller}:${routeKind}`;
    const concurrent = callerActive.get(activeKey) || 0;
    if (++quota.count > maxRequestsPerMinute || (publicOrigin && concurrent >= 1)) {
      response.writeHead(429, { 'retry-after': '60' }); response.end('{"error":"Provider busy. Retry the original request later."}'); return;
    }
    callerActive.set(activeKey, concurrent + 1);
    let serviceAdmitted = false;
    try {
    const context = { digest: null };
    let status;
    let body;
    try {
      if (recoveryOnly && routeKind === 'accept') throw new HttpError('Provider is in recovery-only mode; no new acceptances or purchases are offered', 503);
      let inputBody;
      if (request.method === 'POST') {
        // Independent bounded ingress lanes; slow purchase bodies cannot
        // consume the body budget reserved for result recovery.
        if (readingBodies[routeKind] >= 8) throw new HttpError('Request body capacity busy; retry later', 429);
        readingBodies[routeKind]++;
        try { inputBody = await jsonBody(request); }
        finally { readingBodies[routeKind]--; }
      }
      const full = recovery ? recoveryActive >= recoverySlots : normalActive >= maxConcurrent - recoverySlots;
      if (full) throw new HttpError('Provider busy. Retry the original request later.', 429);
      if (recovery) recoveryActive++; else normalActive++;
      serviceAdmitted = true;
      [status, body] = await route(request, context, inputBody);
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
    } finally {
      if (serviceAdmitted) { if (recovery) recoveryActive--; else normalActive--; }
      const remaining = (callerActive.get(activeKey) || 1) - 1;
      if (remaining) callerActive.set(activeKey, remaining); else callerActive.delete(activeKey);
    }
  });
  server.maxConnections = 32;
  return server;
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: "string" }, "recovery-only": { type: "boolean", default: false }, provider: { type: "string" } }, strict: true, allowPositionals: false });
  const env = process.env;
  const recoveryOnly = values["recovery-only"];
  if (recoveryOnly && env[KEY]) throw new Error("Remove FLOAT_PROVIDER_PRIVATE_KEY from the recovery process environment");
  if (!recoveryOnly && values.provider) throw new Error("--provider is only for --recovery-only");
  const providerAddress = recoveryOnly ? parseAddress("--provider", values.provider, Error) : null;
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
  const account = recoveryOnly ? { address: providerAddress } : walletFromEnv(connection, KEY).account;
  // The key now lives only in `account`: the service, loaded below, and any
  // process it starts do not inherit it.
  delete env[KEY];
  const code = await connection.client.getCode({ address: account.address });
  if (code && code !== "0x") {
    throw new Error(
      `${account.address} has code, so its receipts are checked with ERC-1271; call createProviderServer with a custom account { address, signTypedData } that signs with the account's signer`,
    );
  }
  if (!recoveryOnly && env.PROVIDER_SERVICE && !["example", "shadow-reasoning", "shadow-v2-cycle", "shadow-arc-wallet"].includes(env.PROVIDER_SERVICE)) {
    throw new Error("PROVIDER_SERVICE must be example, shadow-reasoning, shadow-v2-cycle or shadow-arc-wallet");
  }
  let service;
  if (recoveryOnly) {
    service = () => { throw new Error("Recovery mode cannot perform service work"); };
  } else if (env.PROVIDER_SERVICE === "shadow-arc-wallet") {
    const { createShadowArcWalletService } = await import("./shadow-arc-wallet-service.mjs");
    service = createShadowArcWalletService({ chainId: Number(connection.chainId) });
  } else if (env.PROVIDER_SERVICE === "shadow-v2-cycle") {
    const { createShadowV2CycleService } = await import("./shadow-v2-cycle-service.mjs");
    service = createShadowV2CycleService({ paymentTx: env.SHADOW_V2_PAYMENT_TX, repaymentTx: env.SHADOW_V2_REPAYMENT_TX });
  } else {
    const serviceModule = env.PROVIDER_SERVICE === "shadow-reasoning" ? "./shadow-reasoning-service.mjs" : "./service.mjs";
    ({ default: service } = await import(serviceModule));
  }
  const server = createProviderServer({ connection, account, endpointHash, price, storeDir, service, recoveryOnly, publicOrigin: env.PROVIDER_PUBLIC_ORIGIN || null, trustLoopbackProxy: env.PROVIDER_TRUST_LOOPBACK_PROXY === 'true' });
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
      mode: recoveryOnly ? "recovery-only" : "active",
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
