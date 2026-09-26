import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { openPurchaseStore } from "./float-mainnet-purchase-store.mjs";

export class PurchaseError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const problem = (status, code) => { throw new PurchaseError(status, code); };
const hash = (s) => createHash("sha256").update(s).digest();
const TERMINAL = new Set(["paid", "blocked", "reverted"]);
const exactBody = (body, keys) => {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== keys.length || keys.some((k) => !(k in body))) problem(400, "invalid_request");
};

// One enrollment, one durable store, one executor session. A token authorizes
// API access; only the configured agent's verified signature authorizes spend.
export function createPurchaseService({ directory, binding, token, origins, catalog, adapter, maxRecords = 64 }) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error("use a random enrollment token of at least 32 bytes, encoded as base64url");
  if (!Array.isArray(origins) || origins.length === 0) throw new Error("explicit browser origins required");
  const store = openPurchaseStore(directory, binding);
  const auth = hash(`Bearer ${token}`);
  let tail = Promise.resolve(), pending = 0, closed = false;
  let tokens = 30, refilled = Date.now();
  function view(r) {
    return { id: r.id, requestId: r.requestId, digest: r.intent.digest, intent: r.intent,
      payment: r.payment, delivery: r.delivered ? "available" : r.payment === "paid" ? "pending" : "not_requested",
      attempted: r.attempted, ...(r.txHash ? { transactionHash: r.txHash } : {}),
      ...(r.observedAt ? { observedAt: r.observedAt } : {}) };
  }
  async function reconcile(r) {
    if (!r.attempted) return r;
    try {
      const current = await adapter.status(r);
      if (TERMINAL.has(r.payment) && current.payment !== r.payment) throw new Error("outcome changed");
      r.payment = TERMINAL.has(current.payment) ? current.payment : "unknown";
      r.txHash = current.txHash ?? r.txHash;
      r.observedAt = current.observedAt;
      r.held = false;
    } catch { r.held = true; }
    store.put(r);
    if (r.held) problem(503, "reconciliation_required");
    return r;
  }
  async function route(method, pathname, body) {
    await adapter.assertConfiguration();
    if (method === "GET" && pathname === "/v1/catalog") return catalog;
    if (method === "POST" && pathname === "/v1/purchases") {
      exactBody(body, ["requestId"]);
      if (typeof body.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.requestId)) problem(400, "invalid_request_id");
      const records = store.all();
      const old = records.find((r) => r.requestId === body.requestId);
      if (old) return view(await reconcile(old));
      if (records.length >= maxRecords) problem(409, "enrollment_capacity_reached");
      for (const r of records.filter((r) => r.attempted)) {
        if (!TERMINAL.has((await reconcile(r)).payment)) problem(409, "original_payment_unresolved");
      }
      const id = randomBytes(16).toString("hex");
      const intent = await adapter.prepare(id);
      const r = { id, requestId: body.requestId, intent, attempted: false, payment: "not_submitted", delivered: false };
      store.put(r);
      return view(r);
    }
    const match = /^\/v1\/purchases\/([a-f0-9]{32})(?:\/(submit|recover))?$/.exec(pathname);
    if (!match) problem(404, "not_found");
    const r = store.all().find((item) => item.id === match[1]);
    if (!r) problem(404, "not_found");
    if (method === "GET" && !match[2]) return view(await reconcile(r));
    if (method === "POST" && match[2] === "submit") {
      exactBody(body, ["signature"]);
      if (typeof body.signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,16384}$/.test(body.signature)) problem(400, "invalid_signature");
      // Persisted attempted is a one-way boundary. No retry, restart, fresh
      // signature or ambiguous child failure may call send a second time.
      if (r.attempted) return view(await reconcile(r));
      for (const other of store.all().filter((item) => item.attempted)) {
        if (!TERMINAL.has((await reconcile(other)).payment)) problem(409, "original_payment_unresolved");
      }
      await adapter.verify(r, body.signature);
      r.signature = body.signature;
      r.acceptance = await adapter.accept(r); // verified provider agreement BEFORE payment
      store.put(r);
      await adapter.preflight(r); // monitor checked again inside guarded submit
      r.attempted = true; r.payment = "unknown";
      store.put(r);
      try { await adapter.send(r); } catch { /* only reconcile the original attempt */ }
      return view(await reconcile(r));
    }
    if (method === "POST" && match[2] === "recover") {
      exactBody(body, []);
      await reconcile(r);
      if (r.payment !== "paid") problem(409, "payment_not_confirmed");
      const result = r.delivered ? store.readResult(r) : await adapter.recover(r); // same digest; no payment capability
      await reconcile(r); // do not deliver a result against a changed payment
      if (!r.delivered) r.resultChecksum = store.saveResult(r, result);
      r.delivered = true;
      store.put(r);
      return { ...view(r), result };
    }
    problem(405, "method_not_allowed");
  }
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    try {
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin)) problem(403, "origin_not_allowed");
      if (origin) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        if (!origin) problem(403, "origin_required");
        res.setHeader("access-control-allow-methods", "GET, POST");
        res.setHeader("access-control-allow-headers", "authorization, content-type");
        res.writeHead(204); res.end(); return;
      }
      if (!timingSafeEqual(hash(req.headers.authorization ?? ""), auth)) problem(401, "unauthorized");
      const now = Date.now();
      tokens = Math.min(30, tokens + (now - refilled) / 2000); refilled = now;
      if (tokens < 1 || pending >= 8 || closed) problem(429, "busy_retry_later");
      tokens -= 1;
      const pathname = req.url;
      // Do not accept query-string tokens, absolute URLs, or encoded paths.
      if (typeof pathname !== "string" || !/^\/v1\/[A-Za-z0-9/-]+$/.test(pathname)) problem(404, "not_found");
      if (req.method !== "GET" && req.method !== "POST") problem(405, "method_not_allowed");
      if (req.method === "POST" && req.headers["content-type"]?.split(";")[0] !== "application/json") problem(415, "json_required");
      pending += 1;
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 40_000) problem(413, "request_too_large");
          chunks.push(chunk);
        }
        let body = {};
        if (size) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { problem(400, "invalid_json"); } }
        const job = tail.then(() => route(req.method, pathname, body));
        tail = job.catch(() => {});
        send(200, { ok: true, ...await job });
      } finally { pending -= 1; }
    } catch (error) {
      // Child output may contain RPC credentials, signatures, or local paths.
      send(error instanceof PurchaseError ? error.status : 503, { ok: false, error: error instanceof PurchaseError ? error.code : "operation_unavailable" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  let closing;
  return { server, close() {
    closing ??= (async () => {
      closed = true;
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await tail;
      store.close();
    })();
    return closing;
  } };
}
