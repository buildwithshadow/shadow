import { createServer } from "node:http";
import { isIP } from "node:net";
import { inspect, parseArgs } from "node:util";
import { parseAddress, parseBytes32, parseUint, read } from "../../app/scripts/float-mainnet-cli.mjs";
import { RECEIPT_STATUSES, connectCandidate, endpointHashFrom, readDeployment, walletFromEnv } from "../../app/scripts/float-mainnet-config.mjs";
import { checkSignature, validateIntentFile } from "../../app/scripts/float-mainnet-intent.mjs";
import { errorMessage, scrubUrls, stableStringify } from "../../app/scripts/float-mainnet-format.mjs";
import { isEntrypoint } from "../../app/scripts/float-mainnet-entrypoint.mjs";
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
  resultHashOf,
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

import { ProviderStoreHold } from "./store-witness.mjs";
import { createFileProviderStore } from "./file-store.mjs";

const KEY = "FLOAT_PROVIDER_PRIVATE_KEY";
const MAX_BODY_BYTES = 65_536;
function createNodeProviderHttpServer(options, listener, connectionLimit) {
  const server = createServer(options, listener);
  server.maxConnections = connectionLimit;
  return server;
}

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
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
  } catch (error) {
    if (request.aborted && !(error instanceof HttpError)) throw new HttpError('Request body interrupted', 400);
    throw error;
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
export function createProviderServer({ connection, account, endpointHash, price, storeDir, service, publicOrigin = null, trustLoopbackProxy = false, maxConcurrent = publicOrigin ? 4 : 32, maxRequestsPerMinute = 120, maxStoredPurchases = 1000, maxStoredPerAgent = 100, maxStoredPerLine = 25, maxSignatureTtl = 3600, recoveryOnly = false, witnessDir = null, admissionGuard = null, recordStore = null, serverFactory = createNodeProviderHttpServer, clientAddress = null, routeQuotaStore = null, readDeadlineMs = null }) {
  if (clientAddress !== null && typeof clientAddress !== "function") throw new Error("clientAddress must be a function");
  if (typeof serverFactory !== "function") throw new Error("serverFactory must be a function");
  if (admissionGuard !== null && typeof admissionGuard !== "function") throw new Error("admissionGuard must be a function");
  const assertAdmission = async () => {
    if (!admissionGuard) return;
    try { await admissionGuard(); } catch {
      throw new HttpError("Service temporarily unavailable. No new payment acceptance was signed. Retry this same request.", 503);
    }
  };
  if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith('https://'))) throw new Error('publicOrigin must be an exact HTTPS origin');
  for (const value of [maxConcurrent, maxRequestsPerMinute, maxStoredPurchases, maxStoredPerAgent, maxStoredPerLine, maxSignatureTtl]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Provider limits must be positive integers');
  if (typeof recoveryOnly !== "boolean") throw new Error("recoveryOnly must be boolean");
  if (readDeadlineMs !== null && (!Number.isSafeInteger(readDeadlineMs) || readDeadlineMs < 1)) throw new Error("readDeadlineMs must be a positive integer or null");
  if (recoveryOnly) {
    if (account.signTypedData || account.type === "local") throw new Error("Recovery mode requires only a public provider address, never a signer");
  }
  const provider = parseAddress("account.address", account.address, Error);
  const store = recordStore ?? createFileProviderStore({
    directory: storeDir, witnessDirectory: witnessDir, recoveryOnly,
    identity: witnessDir ? { provider, chainId: String(connection.chainId), contract: connection.address.toLowerCase(), endpointHash: endpointHash.toLowerCase() } : null,
  });
  for (const method of ["read", "putOnce", "list", "has", "assertConsistent", "describe"]) {
    if (typeof store[method] !== "function") throw new Error(`Provider store needs ${method}`);
  }
  // One server is the only writer for this identity. Await every durable write
  // before signing or replying. Generation changes invalidate capacity scans
  // that overlap a local publication, including writes suspended on a witness.
  let storeGeneration = 0;
  const fileOf = (digest, slot) => `${digest}.${slot}.json`;
  const readStored = name => store.read(name);
  const persist = async (name, value) => {
    storeGeneration++;
    try { return await store.putOnce(name, value); }
    finally { storeGeneration++; }
  };
  const accepting = new Map();
  const serving = new Map();
  const admitting = new Map();

  let reclaiming = null;
  let reclaimCursor = 0;
  let lastReclaim = 0;
  async function outstanding() {
    const files = await store.list();
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
      const pending = [...await outstanding()].filter(digest => !admitting.has(digest));
      if (!pending.length) return;
      const block = await connection.client.getBlock({ blockTag: "finalized" });
      if (block.number === null) throw new Error("Finalized block is unavailable; admission remains held");
      const batch = Array.from({ length: Math.min(32, pending.length) }, (_, i) => pending[(reclaimCursor + i) % pending.length]);
      reclaimCursor = (reclaimCursor + batch.length) % pending.length;
      for (const digest of batch) {
        const metadata = await readStored(fileOf(digest, "admission"));
        if (metadata?.digest !== digest || !/^[0-9]+$/.test(metadata.signatureExpiry)) continue;
        const status = Number(await read(connection, "receiptStatus", [digest], block.number));
        if (status !== 0 && status !== 1) continue; // Never release paid, undelivered results.
        let reason = status === 1 ? "blocked" : null;
        if (block.timestamp > BigInt(metadata.signatureExpiry)) reason ??= "expired-unpaid";
        if (/^[0-9]+$/.test(metadata.dueAt) && block.timestamp > BigInt(metadata.dueAt)) reason ??= "past-due-unpaid";
        if (!reason && /^0x[0-9a-fA-F]{64}$/.test(metadata.lineId) && /^[0-9]+$/.test(metadata.nonce)) {
          const args = [metadata.lineId, BigInt(metadata.nonce)];
          const [used, cancelled] = await Promise.all([
            read(connection, "nonceUsed", args, block.number),
            read(connection, "nonceCancelled", args, block.number),
          ]);
          if (used || cancelled) reason = used ? "nonce-used-unpaid" : "nonce-cancelled-unpaid";
        }
        if (reason && !admitting.has(digest)) {
          // A suspended release still occupies both identity quotas until durable.
          admitting.set(digest, { ...metadata, reclaiming: true });
          storeGeneration++;
          try { await persist(fileOf(digest, "released"), { digest, reason, blockNumber: block.number.toString(), blockHash: block.hash, timestamp: block.timestamp.toString() }); }
          finally { admitting.delete(digest); storeGeneration++; }
        }
      }
    })().finally(() => { reclaiming = null; });
    return reclaiming;
  }

  async function capacityReached(struct) {
    const pending = new Map();
    for (const digest of await outstanding()) pending.set(digest, await readStored(fileOf(digest, "admission")));
    for (const [digest, metadata] of admitting) pending.set(digest, metadata);
    const records = [...pending.values()];
    return pending.size >= maxStoredPurchases ||
      records.filter(item => item?.agent?.toLowerCase() === struct.agent.toLowerCase()).length >= maxStoredPerAgent ||
      records.filter(item => item?.lineId?.toLowerCase() === struct.lineId.toLowerCase()).length >= maxStoredPerLine;
  }

  async function reserveAdmission(digest, struct) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = storeGeneration;
      if (admitting.get(digest)?.reclaiming) throw new HttpError('This expired purchase is being released; retry later', 503);
      if (await readStored(fileOf(digest, "released"))) throw new HttpError('This purchase authorization has ended; prepare a new purchase', 409);
      const known = await outstanding();
      const full = known.has(digest) ? false : await capacityReached(struct);
      if (generation !== storeGeneration) continue;
      // No await between validating the scan and registering this request.
      // Retries already occupy one durable slot, but must exclude reclaim too.
      if (full) {
        if (attempt === 0) { await reclaimExpired(); continue; }
        throw new HttpError('New purchases are temporarily at capacity; existing purchases can still be recovered', 503);
      }
      admitting.set(digest, struct);
      storeGeneration++;
      return () => { admitting.delete(digest); storeGeneration++; };
    }
    throw new HttpError('Purchase capacity changed while checking; retry the original request', 503);
  }

  // This server reserves each provider job id for at most one intent digest.
  // The durable claim also arbitrates concurrent accepts for different digests.
  async function bindRequest(requestId, digest, claim = true) {
    const file = `request-${requestIdHashOf(requestId)}.json`;
    const binding = { requestId, digest };
    const kept = claim ? (await persist(file, binding) ? binding : await readStored(file)) : await readStored(file);
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
  async function storedReceipt(digest, kind) {
    const file = fileOf(digest, kind === ACCEPTANCE_KIND ? "acceptance" : "delivery");
    const stored = await readStored(file);
    if (!stored) return null;
    const receipt = validateReceiptFile(stored, connection, kind);
    if (receipt.message.provider !== provider) throw new Error(`${store.describe(file)} holds provider ${receipt.message.provider}'s receipt, not ${provider}'s`);
    if (receipt.message.digest !== digest) throw new Error(`${store.describe(file)} holds the receipt of digest ${receipt.message.digest}, not ${digest}`);
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

  async function checkedPrepared(digest, requestId) {
    const prepared = await readStored(fileOf(digest, "prepared"));
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
    const stored = await storedReceipt(digest, ACCEPTANCE_KIND);
    if (stored) {
      // An unpaid stored signature still authorizes a new payment. Only an
      // already paid digest may bypass the admission hold for recovery.
      if (admissionGuard && RECEIPT_STATUSES[Number(await read(connection, "receiptStatus", [digest]))] !== "paid") await assertAdmission();
      if (typeof service.prepare === "function" && !(await checkedPrepared(digest, stored.requestId))) {
        throw new HttpError(`prepared service result for digest ${digest} is missing; the provider must reconcile it before payment`, 409);
      }
      await bindRequest(stored.requestId, digest);
      return { acceptance: stored, checkedIntent: null };
    }
    await assertAdmission();
    const releaseAdmission = await reserveAdmission(digest, struct);
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
    const latest = await connection.client.getBlock({ blockTag: "latest" });
    if (struct.signatureExpiry > latest.timestamp + BigInt(maxSignatureTtl)) {
      throw new HttpError(`the intent signature exceeds the provider's ${maxSignatureTtl}-second admission horizon`, 422);
    }
    // acceptIntent refuses with a plain Error listing its problems, before it
    // signs anything. An RPC failure is one of viem's Error subclasses, and a
    // failure once signing has begun is the provider's own: neither is a refusal.
    const rememberAdmission = async () => await persist(fileOf(digest, "admission"), { digest, agent: struct.agent, lineId: struct.lineId, nonce: struct.nonce.toString(), dueAt: struct.dueAt.toString(), signatureExpiry: struct.signatureExpiry.toString() });
    let signing = false;
    const signer = {
      address: account.address,
      signTypedData: async (typed) => {
        signing = true;
        // Reject existing conflicts before upstream work; atomically claim again
        // after preparation, before persisting anything under this digest.
        await bindRequest(requestId, digest, false);
        if (typeof service.prepare === "function" && !(await checkedPrepared(digest, requestId))) {
          await store.assertConsistent();
          const output = await service.prepare({ digest, requestId });
          if (output === null) throw new HttpError(`service request ${JSON.stringify(requestId)} is unavailable; no acceptance was signed`, 422);
          const prepared = outputRecord(digest, requestId, output);
          await bindRequest(requestId, digest);
          await rememberAdmission();
          if (!await persist(fileOf(digest, "prepared"), prepared)) await checkedPrepared(digest, requestId);
        }
        // Recheck time-sensitive snapshots before a new signature, including a
        // retry after a signer/process failure. Stored acceptances and paid
        // delivery recovery retain their original bytes and skip this hook.
        if (typeof service.validatePrepared === "function") {
          const prepared = await checkedPrepared(digest, requestId);
          if (!prepared) throw new Error("service validation needs a prepared result");
          await service.validatePrepared({ requestId, result: Buffer.from(prepared.result, "base64"), resultRef: prepared.resultRef });
        }
        await bindRequest(requestId, digest);
        await rememberAdmission();
        await store.assertConsistent();
        await assertAdmission();
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
    await bindRequest(requestId, digest);
    const kept = await persist(fileOf(digest, "acceptance"), acceptance) ? acceptance : await storedReceipt(digest, ACCEPTANCE_KIND);
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
    const prepared = await checkedPrepared(digest, acceptance.requestId);
    if (typeof service.prepare === "function" && !prepared) {
      throw new HttpError(`prepared service result for digest ${digest} is missing; the provider must reconcile it before serving`, 409);
    }
    if (prepared) {
      // Prepared bytes were frozen before acceptance and payment. Copying them
      // cannot repeat external work, even if an older process left a marker.
      const kept = await persist(fileOf(digest, "result"), prepared) ? prepared : await readStored(fileOf(digest, "result"));
      if (kept?.digest !== digest || kept?.requestId !== acceptance.requestId || kept?.result !== prepared.result || kept?.resultRef !== prepared.resultRef) {
        throw new HttpError(`the provider's stored result for digest ${digest} disagrees with its prepared output; the provider has to repair it`, 500);
      }
      return kept;
    }
    const markerFile = fileOf(digest, "started");
    const marker = { digest, requestId: acceptance.requestId };
    if (!await persist(markerFile, marker)) {
      const kept = await readStored(markerFile);
      if (kept?.digest !== digest || kept?.requestId !== acceptance.requestId) {
        throw new HttpError(`the provider's stored service marker for digest ${digest} disagrees with its acceptance; the provider has to repair it`, 500);
      }
      throw new HttpError(`service outcome for digest ${digest} is unknown; the provider must reconcile it before work can be retried`, 409);
    }
    try {
      await store.assertConsistent();
      const record = outputRecord(digest, acceptance.requestId, await service({ digest, requestId: acceptance.requestId, acceptance }));
      const kept = await persist(fileOf(digest, "result"), record) ? record : await readStored(fileOf(digest, "result"));
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

  async function serveOnce(digest, paymentTransactionHash, conn = connection, enterCommit = () => {}) {
    const acceptance = await storedReceipt(digest, ACCEPTANCE_KIND);
    if (!acceptance) return [404, { error: `no accepted request for digest ${digest}` }];
    const delivered = await storedReceipt(digest, DELIVERY_KIND);
    const earlier = await readStored(fileOf(digest, "result"));
    if (recoveryOnly) {
      if (!delivered) throw new HttpError("Recovery mode cannot create a delivery; restore the original signed delivery and result", 409);
      const code = await conn.client.getCode({ address: provider });
      if (code && code !== "0x") throw new HttpError("Recovery mode supports ordinary EOA providers only", 409);
      for (const [receipt, kind] of [[acceptance, ACCEPTANCE_KIND], [delivered, DELIVERY_KIND]]) {
        const checked = validateReceiptFile(receipt, connection, kind);
        const signature = await checkSignature(conn, provider, checked.hash, checked.signature);
        if (!signature.valid) throw new HttpError("Stored provider signature does not verify; restore trusted records", 409);
      }
      if (delivered.requestId !== acceptance.requestId || earlier?.digest !== digest || earlier?.requestId !== acceptance.requestId ||
          typeof earlier?.result !== "string" || Buffer.from(earlier.result, "base64").toString("base64") !== earlier.result ||
          resultRefHashOf(earlier.resultRef) !== delivered.typedData.message.resultRefHash.toLowerCase()) {
        throw new HttpError("Stored recovery records disagree; restore trusted records", 409);
      }
    }
    const marker = await readStored(fileOf(digest, "started"));
    if (marker && (marker.digest !== digest || marker.requestId !== acceptance.requestId)) {
      throw new HttpError(`the provider's stored service marker for digest ${digest} disagrees with its acceptance; the provider has to repair it`, 500);
    }
    if (delivered) {
      if (typeof earlier?.result !== "string" || resultHashOf(Buffer.from(earlier.result, "base64")) !== delivered.typedData.message.resultHash.toLowerCase()) {
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
    const savedPayment = await readStored(fileOf(digest, "payment"));
    const payment = await checkPayment(conn, digest, { transactionHash: savedPayment?.transactionHash ?? paymentTransactionHash });
    if (!payment.paid) return [402, { error: "the digest is not paid", receiptStatus: payment.receiptStatus }];
    await assertPaidProviderBinding(conn, payment, acceptance);
    enterCommit(); // payment is bound to this acceptance; from here a hint can no longer supersede this run
    // Upgrade legacy delivered stores too: persist only the independently
    // verified original transaction, before any successful return.
    if (!recoveryOnly) await persist(fileOf(digest, "payment"), { transactionHash: payment.providerPaid.transactionHash });
    // Returning our stored bytes creates no new receipt/signature. A rotated
    // smart-provider key must not strand that result; payment binding is still
    // freshly established from the original canonical transaction.
    if (delivered) return [200, { result: earlier.result, delivery: delivered }];
    const verified = await checkDeliveryPayment(conn, { acceptance, account, transactionHash: payment.providerPaid.transactionHash });
    const produced = earlier ?? (await produce(digest, acceptance));
    // deliverResult reads the payment again and cross-checks its ProviderPaid.
    await store.assertConsistent();
    const deliveryAccount = store.witnessed ? { address: account.address, signTypedData: async typed => { await store.assertConsistent(); return account.signTypedData(typed); } } : account;
    const { delivery } = await deliverResult(conn, {
      acceptance,
      resultHash: resultHashOf(Buffer.from(produced.result, "base64")),
      resultRef: produced.resultRef ?? undefined,
      account: deliveryAccount,
      transactionHash: verified.payment.providerPaid.transactionHash,
    });
    const kept = await persist(fileOf(digest, "delivery"), delivery) ? delivery : await storedReceipt(digest, DELIVERY_KIND);
    return [200, { result: produced.result, delivery: kept }];
  }

  // ---- bounded recovery reads -------------------------------------------------------------------------------
  // Every chain read of one /serve run goes through a client scoped to that run's AbortSignal. Aborting (the overall
  // lookup deadline, or a better payment hint) makes the next and any pending scoped read fail at once, so a lookup loop stops
  // issuing reads and unwinds, which also releases its recovery slot and its `serving` entry. An RPC already on the wire
  // still ends under the transport's own per-request timeout; at most one such request per run is left behind. Nothing
  // durable is skipped or fabricated. The deadline is cleared after canonical payment binding, before writes or signing.
  const DEADLINE_MESSAGE = 'The original payment lookup timed out. Retry this saved purchase with its original payment transaction hash. Do not pay again.';
  const SUPERSEDED_MESSAGE = 'A newer recovery request supplied a payment transaction hash. Retry this saved purchase. Do not pay again.';
  function scopeConnection(base, signal) {
    // A scoped transport captures this run's signal at queue admission, not
    // in mutable shared state. Retired reads cannot later retry or dispatch.
    if (typeof base.withReadSignal === 'function') base = base.withReadSignal(signal);
    const reason = () => signal.reason ?? new Error('read aborted');
    const guard = (call) => {
      if (signal.aborted) return Promise.reject(reason());
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(reason());
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve().then(() => { if (signal.aborted) throw reason(); return call(); })
          .then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    };
    const client = new Proxy(base.client, {
      get(target, property) {
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? (...args) => guard(() => value.apply(target, args)) : value;
      },
    });
    return { ...base, client };
  }

  // One run per digest, as before. A request that brings the payment transaction hash replaces a run that is still only
  // looking for the payment without one (nothing has been bound, persisted or signed in that phase).
  function serveDigest(digest, paymentTransactionHash, mayReplace = true) {
    const running = serving.get(digest);
    if (running) {
      if (mayReplace && paymentTransactionHash && !running.hinted && running.phase === 'lookup') {
        running.controller.abort(new HttpError(SUPERSEDED_MESSAGE, 503));
        const again = () => serveDigest(digest, paymentTransactionHash, false);
        return running.promise.then(again, again);
      }
      return running.promise;
    }
    const controller = new AbortController();
    const run = { hinted: Boolean(paymentTransactionHash), phase: 'lookup', controller, promise: null };
    const timer = readDeadlineMs === null ? null : setTimeout(() => controller.abort(new HttpError(DEADLINE_MESSAGE, 503)), readDeadlineMs);
    run.promise = serveOnce(digest, paymentTransactionHash, scopeConnection(connection, controller.signal), () => { run.phase = 'commit'; if (timer !== null) clearTimeout(timer); })
      .catch((error) => { throw controller.signal.aborted ? controller.signal.reason : error; })
      .finally(() => { if (timer !== null) clearTimeout(timer); if (serving.get(digest) === run) serving.delete(digest); });
    serving.set(digest, run);
    return run.promise;
  }

  // receiptStatus only: a status request never scans for the ProviderPaid log.
  async function status(digest) {
    const acceptance = await storedReceipt(digest, ACCEPTANCE_KIND);
    const receiptStatus = RECEIPT_STATUSES[Number(await read(connection, "receiptStatus", [digest]))];
    return [
      200,
      {
        digest,
        accepted: acceptance !== null,
        requestId: acceptance?.requestId ?? null,
        paid: receiptStatus === "paid",
        receiptStatus,
        delivered: await store.has(fileOf(digest, "delivery")),
      },
    ];
  }

  async function route(request, context, inputBody) {
    await store.assertConsistent();
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
      return serveDigest(digest, paymentTransactionHash);
    }
    return [404, { error: "not found" }];
  }

  // A trusted embedding may retain these per-route counters across connection
  // retirement. Node deployments keep the original bounded in-memory maps.
  const routeQuotas = routeQuotaStore ?? { accept: new Map(), status: new Map(), serve: new Map() }, callerActive = new Map();
  for (const route of ["accept", "status", "serve"]) {
    const quota = routeQuotas[route];
    if (!quota || !Number.isSafeInteger(quota.size) || quota.size < 0 || ["get", "set", "has", "delete", "keys"].some(name => typeof quota[name] !== "function") || typeof quota[Symbol.iterator] !== "function") throw new Error("invalid route quota store");
  }
  let normalActive = 0, recoveryActive = 0;
  const readingBodies = { accept: 0, serve: 0 };
  const recoverySlots = Math.max(1, Math.floor(maxConcurrent / 2));
  if (maxConcurrent < 2) throw new Error('Provider needs at least two slots to reserve recovery capacity');
  function callerOf(request) {
    // Trusted hosting adapters supply a request-local, platform-authenticated
    // IP literal. This never makes a client-supplied forwarding header trusted.
    if (clientAddress !== null) {
      try {
        const address = clientAddress(request);
        if (address && typeof address.then === 'function') {
          Promise.resolve(address).catch(() => {});
          return null;
        }
        return typeof address === 'string' && address.length <= 45 && /^[0-9a-fA-F:.]+$/.test(address) && isIP(address)
          ? address.toLowerCase() : null;
      } catch { return null; }
    }
    const remote = request.socket.remoteAddress || 'unknown';
    if (trustLoopbackProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      const forwarded = request.headers['x-shadow-client-ip'];
      if (typeof forwarded !== 'string' || !isIP(forwarded)) return null;
      return forwarded.toLowerCase();
    }
    return remote.toLowerCase();
  }
  const server = serverFactory({ maxHeaderSize: 8192, requestTimeout: 15000, connectionsCheckingInterval: 1000, headersTimeout: 10000, keepAliveTimeout: 5000 }, async (request, response) => {
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
        response.setHeader('access-control-expose-headers', 'retry-after');
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
      // An embedded durable map returns a write-through counter view.
      quota = quotas.get(quotaKey);
    }
    // Status polling shares normal admission, never paid-result delivery slots.
    const recovery = routeKind === 'serve', activeKey = `${caller}:${routeKind}`;
    const concurrent = callerActive.get(activeKey) || 0;
    if (++quota.count > maxRequestsPerMinute || (publicOrigin && concurrent >= 1)) {
      response.setHeader('connection', 'close');
      response.once('finish', () => request.destroy());
      response.writeHead(429, { 'retry-after': '60' }); response.end('{"error":"Provider busy. Retry the original request later."}'); return;
    }
    callerActive.set(activeKey, concurrent + 1);
    let serviceAdmitted = false;
    try {
    const context = { digest: null };
    let status;
    let body;
    try {
      if (recoveryOnly && routeKind === 'accept') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(stableStringify({error: 'Provider is in recovery-only mode; no new acceptances or purchases are offered'}));
        return;
      }
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
      status = error instanceof HttpError || error instanceof ProviderStoreHold ? error.status : 500;
      const failed = `the provider failed on ${context.digest === null ? "this request" : `digest ${context.digest}`} and logged the error; the request can be retried`;
      body = { error: error instanceof HttpError || error instanceof ProviderStoreHold ? errorMessage(error) : failed };
      if (status >= 500) {
        console.error(JSON.stringify({ request: `${request.method} ${request.url}`, digest: context.digest, status, error: scrubUrls(inspect(error)) }));
      }
    }
    if (status === 429) {
      response.setHeader('retry-after', '60');
      // A rejected upload must not retain an uncounted TCP connection while
      // its sender dribbles a body. Flush the refusal, then close it.
      response.setHeader('connection', 'close');
      response.once('finish', () => request.destroy());
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(stableStringify(body));
    } finally {
      if (serviceAdmitted) { if (recovery) recoveryActive--; else normalActive--; }
      const remaining = (callerActive.get(activeKey) || 1) - 1;
      if (remaining) callerActive.set(activeKey, remaining); else callerActive.delete(activeKey);
    }
  }, Math.max(32, maxConcurrent + 16));
  return server;
}

async function main() {
  const { configureProviderAdmission } = await import("../../app/scripts/float-mainnet-provider-monitor-guard.mjs");
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
  const admissionGuard = configureProviderAdmission({
    mode: env.PROVIDER_ADMISSION_MODE, recoveryOnly,
    connection, manifestPath: values.manifest,
    baselinePath: env.PROVIDER_MONITOR_BASELINE, stateDir: env.PROVIDER_MONITOR_STATE_DIR,
  });
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
  const server = createProviderServer({ connection, account, endpointHash, price, storeDir, service, recoveryOnly, admissionGuard, witnessDir: env.PROVIDER_WITNESS_DIR?.trim() || null, publicOrigin: env.PROVIDER_PUBLIC_ORIGIN || null, trustLoopbackProxy: env.PROVIDER_TRUST_LOOPBACK_PROXY === 'true' });
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
