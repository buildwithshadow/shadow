import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { keccak256 } from 'viem';
import { connect, findLogs } from './float-mainnet-cli.mjs';
import { approvedHistoryIdentity, validateConfiguredHistory } from './float-mainnet-approved-history.mjs';
import { buildNormalizedContent, hashBytes, normalizeLog, validateApprovedBytes, verifyAndMerge } from './float-mainnet-history-validation.mjs';
import { validateBaseline } from './float-mainnet-monitor-public-policy.mjs';
import { canonicalJson, digestJson } from './float-mainnet-monitor-policy.mjs';
import { isEntrypoint } from './float-mainnet-preflight.mjs';

// DRAFT, READ ONLY. Resumable capture of the history suffix. Saved pages are
// unapproved candidate data. Nothing here writes a baseline, a prefix, monitor
// state or a hold, signs or sends a transaction, or approves its own output.
export const HEADER_KIND = 'UnapprovedResumableHistoryCaptureHeader';
export const PAGE_KIND = 'UnapprovedResumableHistoryCapturePage';
export const REPORT_KIND = 'UnapprovedResumableShadowHistoryExtension';
export const HARD_LIMITS = { pageWidth: 10_000n, maxPages: 2_000, maxPageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024, maxLogs: 20_000, maxRpcCalls: 10_000, maxRuntimeMs: 3_600_000 };
export const DEFAULT_PAGE_WIDTH = 10_000n;
export const DEFAULT_BOUNDS = { maxPages: 200, maxPageBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024,
  maxLogs: 20_000, maxRpcCalls: 2_000, maxRuntimeMs: 1_800_000 };
export const LIMITATIONS = 'Unapproved candidate. Local hashes only detect corruption and structural tampering; they cannot show that a provider returned every event, and an omitted valid event is undetectable locally. Compare an independent complete capture from a separate provider and obtain explicit maintainer review before any promotion. The provider fingerprint is an operator assertion that this tool cannot verify. No baseline, history binding or hold is changed.';

export class ResumableCaptureError extends Error {
  constructor(code, message, report) { super(message); this.name = 'ResumableCaptureError'; this.code = code; this.report = report; }
}
const fail = (code, message) => { throw new ResumableCaptureError(code, message); };
const must = (ok, code, message) => { if (!ok) fail(code, message); };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const sha = text => createHash('sha256').update(text).digest('hex');
const DECIMAL = /^(0|[1-9]\d*)$/, HASH = /^0x[0-9a-f]{64}$/;

// Imported validators may carry RPC detail or URLs in their messages: keep only a code.
async function sanitized(label, fn) {
  try { return await fn(); } catch (error) {
    if (error instanceof ResumableCaptureError) throw error;
    const code = error?.name === 'ApprovedHistoryError' && /^[A-Z_]+$/.test(error.code) ? ` (${error.code})` : '';
    throw new ResumableCaptureError(`${label.toUpperCase().replaceAll(' ', '_')}_FAILED`, `${label} failed${code}; details withheld`);
  }
}

// Inclusive, contiguous, non-overlapping windows covering [first, last] exactly.
export function pageCountFor(first, last, width) {
  must(typeof first === 'bigint' && typeof last === 'bigint' && typeof width === 'bigint' && width > 0n && last >= first, 'BAD_RANGE', 'invalid capture range');
  return (last - first) / width + 1n;
}
export function windowAt(first, last, width, index) {
  const from = first + BigInt(index) * width, to = from + width - 1n;
  return { from, to: to > last ? last : to };
}
export function planWindows(first, last, width, maxPages) {
  const count = pageCountFor(first, last, width);
  must(count <= BigInt(maxPages), 'BOUND_PAGES', 'capture would exceed the page bound');
  return Array.from({ length: Number(count) }, (_, index) => ({ index, ...windowAt(first, last, width, index) }));
}

function normalizeOptions(raw) {
  must(raw && typeof raw === 'object', 'BAD_OPTION', 'options are required');
  const known = ['workspace', 'out', 'resume', 'providerFingerprint', 'pageWidth', 'bounds', 'anchor', 'clock', 'beforeWrite'];
  must(Object.keys(raw).every(key => known.includes(key)), 'BAD_OPTION', 'unknown option');
  const path = (name, value) => { must(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value), 'BAD_OPTION', `${name} must be a plain path`); return resolve(value); };
  const pageWidth = raw.pageWidth ?? DEFAULT_PAGE_WIDTH;
  must(typeof pageWidth === 'bigint' && pageWidth >= 1n && pageWidth <= HARD_LIMITS.pageWidth, 'BAD_OPTION', 'pageWidth out of range');
  const bounds = { ...DEFAULT_BOUNDS, ...(raw.bounds ?? {}) };
  must(Object.keys(bounds).every(key => Object.hasOwn(DEFAULT_BOUNDS, key)), 'BAD_OPTION', 'unknown bound');
  for (const key of Object.keys(DEFAULT_BOUNDS))
    must(Number.isSafeInteger(bounds[key]) && bounds[key] >= 1 && bounds[key] <= HARD_LIMITS[key], 'BAD_OPTION', `${key} out of range`);
  // An opaque label, never a URL or credential. Only its digest is persisted.
  must(typeof raw.providerFingerprint === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(raw.providerFingerprint), 'BAD_OPTION', 'providerFingerprint must be an opaque 8-128 character label (letters, digits, . _ -), never a URL or key');
  must(raw.resume === undefined || typeof raw.resume === 'boolean', 'BAD_OPTION', 'resume must be boolean');
  must(raw.clock === undefined || typeof raw.clock === 'function', 'BAD_OPTION', 'clock must be a function');
  must(raw.beforeWrite === undefined || typeof raw.beforeWrite === 'function', 'BAD_OPTION', 'beforeWrite must be a function');
  let anchor = null;
  if (raw.anchor !== undefined) {
    must(typeof raw.anchor?.blockNumber === 'bigint' && raw.anchor.blockNumber >= 0n && HASH.test(raw.anchor.blockHash ?? ''), 'BAD_OPTION', 'anchor needs a bigint blockNumber and lowercase bytes32 blockHash');
    anchor = { blockNumber: raw.anchor.blockNumber, blockHash: raw.anchor.blockHash };
  }
  return { workspace: path('workspace', raw.workspace), out: path('out', raw.out), resume: raw.resume === true, pageWidth, bounds, anchor,
    providerDigest: sha(`float-resumable-provider-v1\0${raw.providerFingerprint}`), clock: raw.clock ?? Date.now, beforeWrite: raw.beforeWrite };
}

// Logical client calls and elapsed time are bounded per invocation, not across
// operator resumes. Existing transport retries remain separately bounded.
// A quota error is a failure; there is no automatic resume loop.
function meterConnection(connection, o, progress) {
  const started = o.clock(), meter = { calls: 0, exceeded: null };
  const client = Object.create(connection.client);
  for (const method of ['getLogs', 'getBlock', 'getCode']) client[method] = (...args) => {
    const reason = meter.calls >= o.bounds.maxRpcCalls ? 'RPC call bound' : o.clock() - started > o.bounds.maxRuntimeMs ? 'runtime bound' : null;
    if (reason) { meter.exceeded = new ResumableCaptureError('WORK_BOUND', `${reason} reached; completed pages are retained`); throw meter.exceeded; }
    progress.rpcCalls = ++meter.calls;
    return connection.client[method](...args);
  };
  return { meter, connection: { ...connection, client } };
}

function quotaSuspected(error) {
  const seen = new Set();
  for (let e = error, depth = 0; e && depth < 8 && !seen.has(e); e = e.cause, depth++) {
    seen.add(e);
    if (/rate limit|quota|too many requests|requests? per|exceeds defined limit|\b429\b/i.test([e.shortMessage, e.details, e.message].filter(v => typeof v === 'string').join(' '))) return true;
  }
  return false;
}
async function rpc(meter, what, fn) {
  try { return await fn(); } catch (error) {
    if (meter.exceeded) throw meter.exceeded;
    if (error instanceof ResumableCaptureError) throw error;
    fail('RPC_READ_FAILED', `${what} not committed${quotaSuspected(error) ? ' (rate limit or quota suspected)' : ''}; completed pages are retained and the session may be resumed later`);
  }
}

// ---- filesystem: private, exclusive, no symlinks, atomic write-once ----
function readRegular(path, maxBytes, code, sizeCode = code) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { fail(code, 'file is missing, unreadable or a symlink'); }
  try {
    const stat = fstatSync(fd);
    must(stat.isFile(), code, 'not a regular file');
    must(stat.size > 0, code, 'empty file');
    must(stat.size <= maxBytes, sizeCode, 'file exceeds its size bound');
    const bytes = Buffer.alloc(stat.size);
    let got = 0;
    while (got < stat.size) { const n = readSync(fd, bytes, got, stat.size - got, null); if (!n) break; got += n; }
    const after = fstatSync(fd);
    must(got === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, code, 'file changed while reading');
    return bytes;
  } finally { closeSync(fd); }
}
function writeOnce(path, bytes, code) {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(tmp, path); // fails if the target exists: never overwrites
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    fail(error?.code === 'EEXIST' ? `${code}_EXISTS` : `${code}_WRITE_FAILED`, error?.code === 'EEXIST' ? 'refusing to overwrite an existing file' : 'could not write file');
  } finally { try { unlinkSync(tmp); } catch { /* nothing to remove */ } }
}
function checkWorkspace(dir) {
  let stat;
  try { stat = lstatSync(dir); } catch { fail('WORKSPACE_MISSING', 'workspace does not exist'); }
  must(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKSPACE_UNSAFE', 'workspace must be a real directory');
  must((stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()), 'WORKSPACE_UNSAFE', 'workspace must be private and owned by this user');
}
// A lock left by a crashed run is never cleared automatically.
function acquireLock(dir) {
  const path = join(dir, 'capture.lock'), nonce = randomBytes(16).toString('hex');
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify({ nonce, pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    fail('LOCKED', error?.code === 'EEXIST' ? 'workspace is locked by an active or abandoned run; this tool never clears a lock automatically' : 'could not create the workspace lock');
  }
  return () => { try { if (JSON.parse(readRegular(path, 4096, 'LOCK')).nonce === nonce) unlinkSync(path); } catch { /* leave it */ } };
}

// ---- header and pages ----
export const pageName = index => `page-${String(index).padStart(8, '0')}.json`;
const PAGE_NAME = /^page-(\d{8})\.json$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();

function expectedHeader(ctx, anchor) {
  const { o, prev } = ctx;
  return { kind: HEADER_KIND, schemaVersion: 1,
    prefix: { sha256: ctx.baseline.approvedHistory.sha256, anchorBlock: String(prev.blockNumber), anchorHash: prev.blockHash },
    identity: ctx.identity, baselineIdentity: ctx.baseline.identity, baselineHash: ctx.baselineHash, providerDigest: o.providerDigest,
    captureAnchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash },
    firstBlock: String(prev.blockNumber + 1n), pageWidth: String(o.pageWidth),
    pageCount: String(pageCountFor(prev.blockNumber + 1n, anchor.blockNumber, o.pageWidth)), bounds: o.bounds };
}
const encode = value => Buffer.from(canonicalJson(value));

function readHeader(dir, ctx) {
  const bytes = readRegular(join(dir, 'header.json'), 65_536, 'HEADER_INVALID');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('HEADER_INVALID', 'header is not valid JSON'); }
  const a = parsed?.captureAnchor;
  must(exactKeys(a, ['blockNumber', 'blockHash']) && DECIMAL.test(a.blockNumber) && HASH.test(a.blockHash) && BigInt(a.blockNumber) > ctx.prev.blockNumber, 'HEADER_INVALID', 'header anchor is malformed');
  const expected = expectedHeader(ctx, { blockNumber: BigInt(a.blockNumber), blockHash: a.blockHash });
  must(Buffer.compare(bytes, encode(expected)) === 0, 'HEADER_MISMATCH', 'session differs from the requested prefix, manifest, baseline, provider, anchor or limits');
  return { header: expected, digest: hashBytes(bytes), anchor: { blockNumber: BigInt(a.blockNumber), blockHash: a.blockHash } };
}

// Shared by live provider data and stored pages: exact normalized shape, window and order.
function normalizePage(rawLogs, from, to, address) {
  must(Array.isArray(rawLogs), 'PAGE_INVALID', 'logs must be an array');
  const logs = rawLogs.map(raw => {
    try { return normalizeLog(raw, address); } catch (error) { return fail('PAGE_INVALID', `a log is malformed (${/^[A-Z_]+$/.test(error?.code) ? error.code : 'error'})`); }
  });
  logs.forEach((log, i) => {
    const bn = BigInt(log.blockNumber), p = logs[i - 1];
    must(bn >= from && bn <= to, 'PAGE_OUT_OF_RANGE', 'a log lies outside its window');
    must(!p || bn > BigInt(p.blockNumber) || (bn === BigInt(p.blockNumber) && log.logIndex > p.logIndex), 'PAGE_ORDER', 'logs are duplicated or out of order');
  });
  return logs;
}
export function pageBody(headerDigest, index, from, to, logs) {
  return { kind: PAGE_KIND, schemaVersion: 1, complete: true, headerDigest, index, fromBlock: String(from), toBlock: String(to), logs };
}
export const pageContentDigest = body => sha(canonicalJson(body));
export const encodePage = body => encode({ ...body, contentDigest: pageContentDigest(body) });

function parsePage(bytes, ctx, index) {
  let page;
  try { page = JSON.parse(bytes.toString('utf8')); } catch { fail('PAGE_INVALID', 'page is not valid JSON'); }
  must(exactKeys(page, ['kind', 'schemaVersion', 'complete', 'headerDigest', 'index', 'fromBlock', 'toBlock', 'logs', 'contentDigest']), 'PAGE_INVALID', 'page fields are malformed');
  must(page.kind === PAGE_KIND && page.schemaVersion === 1, 'PAGE_INVALID', 'wrong page kind');
  must(page.complete === true, 'PAGE_INCOMPLETE', 'page is not marked complete');
  must(page.headerDigest === ctx.headerDigest, 'PAGE_HEADER_BINDING', 'page is bound to a different session header');
  const { from, to } = windowAt(ctx.first, ctx.anchor.blockNumber, ctx.o.pageWidth, index);
  must(page.index === index && page.fromBlock === String(from) && page.toBlock === String(to), 'PAGE_BOUNDS', 'page window differs from the planned window');
  const logs = normalizePage(page.logs, from, to, ctx.identity.address);
  must(canonicalJson(logs) === canonicalJson(page.logs), 'PAGE_INVALID', 'page logs are not in exact normalized form');
  const { contentDigest, ...body } = page;
  must(contentDigest === pageContentDigest(body) && Buffer.compare(bytes, encode(page)) === 0, 'PAGE_DIGEST', 'page content digest or encoding is wrong (corruption or tampering)');
  return logs;
}

// Whole-sequence validation with the existing builder. The output is discarded:
// it only proves the prefix and saved windows form one consistent ordered history.
function validateSequence(ctx, pages) {
  const logs = [...pages.keys()].sort((a, b) => a - b).flatMap(i => pages.get(i));
  try { buildNormalizedContent([...ctx.original.logs, ...logs], ctx.identity, ctx.anchor); } catch (error) {
    fail('PAGES_INCONSISTENT', `saved windows conflict with the prefix or each other (${/^[A-Z_]+$/.test(error?.code) ? error.code : 'error'})`);
  }
}

function loadPages(dir, ctx) {
  const { bounds } = ctx.o, pages = new Map();
  let bytesTotal = 0, logsTotal = 0;
  const allowed = new Set(['header.json', 'capture.lock']);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const match = PAGE_NAME.exec(entry.name);
    must(entry.isFile() && (allowed.has(entry.name) || (match && Number(match[1]) < Number(ctx.pageCount))), 'WORKSPACE_UNEXPECTED_FILE', 'workspace holds an unexpected, non-regular or symlinked entry');
    if (!match) continue;
    const index = Number(match[1]);
    const bytes = readRegular(join(dir, entry.name), bounds.maxPageBytes, 'PAGE_INVALID', 'BOUND_PAGE_BYTES');
    const logs = parsePage(bytes, ctx, index);
    bytesTotal += bytes.length; logsTotal += logs.length;
    must(bytesTotal <= bounds.maxTotalBytes, 'BOUND_TOTAL_BYTES', 'saved pages exceed the total byte bound');
    must(logsTotal <= bounds.maxLogs, 'BOUND_LOGS', 'saved pages exceed the log bound');
    pages.set(index, logs);
  }
  validateSequence(ctx, pages);
  return { pages, bytesTotal, logsTotal };
}

async function currentBlock(ctx, number) {
  const block = await rpc(ctx.meter, `block ${number}`, () => ctx.chain.client.getBlock({ blockNumber: number }));
  return block && block.number === number ? block : fail('CHAIN_INCONSISTENT', 'RPC returned a different block');
}
async function verifyBlocks(ctx, logs) {
  // Cache only within this pass. Assembly must recheck earlier event blocks
  // after all later windows have been fetched, as uninterrupted capture does.
  const verified = new Map();
  for (const log of logs) {
    if (verified.get(log.blockNumber) === log.blockHash) continue;
    const block = await currentBlock(ctx, BigInt(log.blockNumber));
    must(same(block.hash, log.blockHash), 'EVENT_BLOCK_NOT_CANONICAL', 'a saved or fetched event block is not canonical');
    verified.set(log.blockNumber, log.blockHash);
  }
}
async function checkRuntime(ctx, anchor) {
  const code = await rpc(ctx.meter, 'runtime code', () => ctx.chain.client.getCode({ address: ctx.chain.address, blockNumber: anchor.blockNumber }));
  must(code && same(keccak256(code), ctx.identity.runtimeCodeHash), 'RUNTIME_MISMATCH', 'runtime differs at the capture anchor');
}

export async function captureResumableHistory(connection, manifestPath, rawBaseline, rawOptions) {
  const progress = { pagesTotal: null, pagesCompleted: 0, pagesFetched: 0, rpcCalls: 0 };
  try { return await run(connection, manifestPath, rawBaseline, rawOptions, progress); } catch (error) {
    const known = error instanceof ResumableCaptureError;
    const failure = known ? error : new ResumableCaptureError('CAPTURE_FAILED', 'capture failed; details withheld');
    failure.report = { kind: REPORT_KIND, approved: false, configurationChanged: false, transactionsSent: 0, complete: false, candidateWritten: false,
      partial: progress.pagesTotal === null || progress.pagesCompleted < progress.pagesTotal, progressRetained: progress.pagesCompleted > 0,
      pagesTotal: progress.pagesTotal, pagesCompleted: progress.pagesCompleted, pagesFetchedThisRun: progress.pagesFetched, rpcCalls: progress.rpcCalls,
      errorCode: failure.code };
    delete failure.cause;
    throw failure;
  }
}

async function run(connection, manifestPath, rawBaseline, rawOptions, progress) {
  const o = normalizeOptions(rawOptions);
  // Bind the actual configured endpoint too, without retaining a URL or key.
  // This prevents accidental source switches, not dishonest provider claims.
  let endpoint;
  try { endpoint = new URL(connection.rpcUrl); } catch { fail('BAD_PROVIDER', 'a valid configured RPC endpoint is required'); }
  must(['https:', 'http:'].includes(endpoint.protocol), 'BAD_PROVIDER', 'unsupported RPC endpoint protocol');
  endpoint.hash = '';
  o.providerDigest = sha(`float-resumable-endpoint-v1\0${o.providerDigest}\0${endpoint.href}`);
  const { meter, connection: chain } = meterConnection(connection, o, progress);
  const baseline = await sanitized('baseline validation', () => validateBaseline(structuredClone(rawBaseline)));
  must(baseline.approvedHistory, 'NO_APPROVED_PREFIX', 'an existing externally approved history binding is required');
  const identity = await sanitized('manifest identity', () => approvedHistoryIdentity(manifestPath, connection));
  const original = await sanitized('approved prefix', () => validateConfiguredHistory(baseline, manifestPath));
  const prev = { blockNumber: BigInt(original.parsed.anchor.blockNumber), blockHash: original.parsed.anchor.blockHash };
  const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
  const protectedPaths = [resolve(baseline.approvedHistory.file), resolve(manifestPath)];
  must(protectedPaths.every(p => !inside(o.workspace, p) && p !== o.out) && !inside(o.workspace, o.out), 'BAD_OPTION', 'workspace and output must not overlap the prefix, manifest or each other');
  try { lstatSync(o.out); fail('OUTPUT_EXISTS', 'output file already exists; refusing to overwrite'); } catch (error) { if (error instanceof ResumableCaptureError) throw error; }
  const ctx = { o, meter, chain, baseline, baselineHash: digestJson(baseline), identity, original, prev, first: prev.blockNumber + 1n };
  let release;
  try {
    if (o.resume) { checkWorkspace(o.workspace); release = acquireLock(o.workspace); Object.assign(ctx, readHeaderInto(o.workspace, ctx)); }
    const oldBlock = await currentBlock(ctx, prev.blockNumber);
    must(same(oldBlock.hash, prev.blockHash), 'OLD_ANCHOR_REORGANIZED', 'the approved prefix anchor is no longer canonical');
    const finalized = await rpc(meter, 'finalized head', () => chain.client.getBlock({ blockTag: 'finalized' }));
    if (!o.resume) {
      let anchor = { blockNumber: finalized.number, blockHash: finalized.hash };
      if (o.anchor) {
        must(o.anchor.blockNumber <= finalized.number, 'ANCHOR_NOT_FINAL', 'requested anchor is not finalized');
        must(same((await currentBlock(ctx, o.anchor.blockNumber)).hash, o.anchor.blockHash), 'ANCHOR_CHANGED', 'requested anchor hash is not canonical');
        anchor = o.anchor;
      }
      must(anchor.blockNumber > prev.blockNumber, 'ANCHOR_NOT_NEWER', 'capture anchor must advance the approved anchor');
      must(pageCountFor(ctx.first, anchor.blockNumber, o.pageWidth) <= BigInt(o.bounds.maxPages), 'BOUND_PAGES', 'capture would exceed the page bound');
      await checkRuntime(ctx, anchor);
      ctx.anchor = anchor;
      try { mkdirSync(o.workspace, { mode: 0o700 }); } catch { fail('WORKSPACE_EXISTS', 'workspace already exists or cannot be created; a new session needs a fresh directory (use resume for an existing one)'); }
      checkWorkspace(o.workspace);
      release = acquireLock(o.workspace);
      const header = expectedHeader(ctx, anchor);
      writeOnce(join(o.workspace, 'header.json'), encode(header), 'HEADER');
      Object.assign(ctx, readHeaderInto(o.workspace, ctx));
    } else {
      must(!o.anchor || (o.anchor.blockNumber === ctx.anchor.blockNumber && o.anchor.blockHash === ctx.anchor.blockHash), 'ANCHOR_CHANGED', 'requested anchor differs from the session anchor');
      must(finalized.number >= ctx.anchor.blockNumber, 'ANCHOR_NOT_FINAL', 'session anchor is not finalized');
      must(same((await currentBlock(ctx, ctx.anchor.blockNumber)).hash, ctx.anchor.blockHash), 'ANCHOR_CHANGED', 'session anchor is no longer canonical');
      await checkRuntime(ctx, ctx.anchor);
    }
    progress.pagesTotal = Number(ctx.pageCount);
    // Progress comes only from validated expected page files, never a saved cursor.
    const loaded = loadPages(o.workspace, ctx);
    const { pages } = loaded;
    let { bytesTotal, logsTotal } = loaded;
    progress.pagesCompleted = pages.size;
    for (const logs of pages.values()) await verifyBlocks(ctx, logs);
    for (let index = 0; index < progress.pagesTotal; index++) {
      if (pages.has(index)) continue;
      const { from, to } = windowAt(ctx.first, ctx.anchor.blockNumber, o.pageWidth, index);
      const raw = await rpc(meter, `log window ${from}-${to}`, () => findLogs(chain, undefined, undefined, from, to));
      must(!Array.isArray(raw) || raw.length <= o.bounds.maxLogs - logsTotal, 'BOUND_LOGS', 'provider response exceeds the log bound');
      const logs = normalizePage(raw, from, to, ctx.identity.address);
      const bytes = encodePage(pageBody(ctx.headerDigest, index, from, to, logs));
      must(bytes.length <= o.bounds.maxPageBytes, 'BOUND_PAGE_BYTES', 'page exceeds the per-page byte bound');
      must(bytesTotal + bytes.length <= o.bounds.maxTotalBytes, 'BOUND_TOTAL_BYTES', 'pages exceed the total byte bound');
      pages.set(index, logs);
      try { validateSequence(ctx, pages); } catch (error) { pages.delete(index); throw error; }
      await verifyBlocks(ctx, logs);
      writeOnce(join(o.workspace, pageName(index)), bytes, 'PAGE');
      bytesTotal += bytes.length; logsTotal += logs.length;
      progress.pagesCompleted = pages.size; progress.pagesFetched++;
    }
    return await assemble(ctx, manifestPath, rawBaseline, pages, progress);
  } finally { release?.(); }
}

function readHeaderInto(dir, ctx) {
  const { header, digest, anchor } = readHeader(dir, ctx);
  return { header, headerDigest: digest, anchor: { ...anchor, blockNumber: anchor.blockNumber }, pageCount: BigInt(header.pageCount) };
}

async function assemble(ctx, manifestPath, rawBaseline, pages, progress) {
  const { o, identity, original, prev, anchor } = ctx;
  must(pages.size === progress.pagesTotal && [...Array(progress.pagesTotal).keys()].every(i => pages.has(i)), 'MISSING_WINDOW', 'a window is missing; no candidate can be produced');
  const suffix = [...pages.keys()].sort((a, b) => a - b).flatMap(i => pages.get(i));
  const finalized = await rpc(ctx.meter, 'finalized head', () => ctx.chain.client.getBlock({ blockTag: 'finalized' }));
  must(finalized.number >= anchor.blockNumber, 'ANCHOR_NOT_FINAL', 'capture anchor is not finalized');
  const merged = await sanitized('history merge', () => verifyAndMerge({ prefixBytes: original.bytes, approvedDigest: ctx.baseline.approvedHistory.sha256, expectedIdentity: identity,
    pinnedBlock: { blockNumber: anchor.blockNumber, blockHash: anchor.blockHash }, finalizedBlock: { blockNumber: finalized.number },
    verifyAnchorHash: async number => (await currentBlock(ctx, number)).hash,
    fetchSuffix: (from, to) => from === ctx.first && to === anchor.blockNumber ? suffix : fail('MISSING_WINDOW', 'merge asked for a range other than the captured suffix') }));
  await verifyBlocks(ctx, merged.suffixLogs);
  const built = await sanitized('candidate build', () => buildNormalizedContent(merged.mergedLogs, identity, { blockNumber: anchor.blockNumber, blockHash: anchor.blockHash }));
  const prefixOnly = await sanitized('prefix rebuild', () => buildNormalizedContent(original.logs, original.parsed.identity, original.parsed.anchor));
  must(Buffer.compare(prefixOnly.bytes, original.bytes) === 0 && canonicalJson(built.parsed.logs.slice(0, original.logs.length)) === canonicalJson(original.logs), 'PREFIX_NOT_PRESERVED', 'the original approved prefix is not preserved exactly');
  must(same((await currentBlock(ctx, prev.blockNumber)).hash, prev.blockHash), 'OLD_ANCHOR_REORGANIZED', 'the approved prefix anchor changed during capture');
  must(same((await currentBlock(ctx, anchor.blockNumber)).hash, anchor.blockHash), 'ANCHOR_CHANGED', 'capture anchor changed during capture');
  const again = await sanitized('re-check', () => ({ identity: approvedHistoryIdentity(manifestPath), history: validateConfiguredHistory(ctx.baseline, manifestPath),
    baselineHash: digestJson(validateBaseline(structuredClone(rawBaseline))) }));
  must(again.identity.manifestHash === identity.manifestHash, 'MANIFEST_CHANGED', 'manifest changed during capture');
  must(Buffer.compare(again.history.bytes, original.bytes) === 0 && again.baselineHash === ctx.baselineHash, 'BASELINE_CHANGED', 'baseline or approved prefix changed during capture');
  const sha256 = hashBytes(built.bytes);
  await sanitized('candidate validation', () => validateApprovedBytes(built.bytes, sha256, identity));
  await sanitized('pre-write check', async () => { await o.beforeWrite?.(); });
  writeOnce(o.out, built.bytes, 'OUTPUT');
  return { ...built, sha256, provenance: { kind: REPORT_KIND, approved: false, configurationChanged: false, transactionsSent: 0,
    complete: true, partial: false, candidateWritten: true, pagesTotal: progress.pagesTotal, pagesCompleted: pages.size, pagesFetchedThisRun: progress.pagesFetched,
    rpcCalls: progress.rpcCalls, expectedCurrentBaselineHash: ctx.baselineHash, previousDigest: ctx.baseline.approvedHistory.sha256,
    previousAnchor: original.parsed.anchor, anchor: built.parsed.anchor, prefixLogCount: original.logs.length, suffixLogCount: suffix.length, limitations: LIMITATIONS } };
}

// ---- CLI: strict flags, read-only connection, no key loading ----
const STRING_FLAGS = ['manifest', 'baseline', 'workspace', 'out', 'provider-fingerprint', 'anchor-number', 'anchor-hash', 'page-width',
  'max-pages', 'max-page-bytes', 'max-total-bytes', 'max-logs', 'max-rpc-calls', 'max-runtime-ms'];
const BOUND_FLAGS = { 'max-pages': 'maxPages', 'max-page-bytes': 'maxPageBytes', 'max-total-bytes': 'maxTotalBytes', 'max-logs': 'maxLogs',
  'max-rpc-calls': 'maxRpcCalls', 'max-runtime-ms': 'maxRuntimeMs' };
const usage = message => Object.assign(new ResumableCaptureError('USAGE', message), { usage: true });

export function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
      options: { ...Object.fromEntries(STRING_FLAGS.map(k => [k, { type: 'string' }])), resume: { type: 'boolean' } } }));
  } catch { throw usage('invalid or unknown option'); }
  for (const key of ['manifest', 'baseline', 'workspace', 'out', 'provider-fingerprint']) if (!values[key]) throw usage(`--${key} is required`);
  const dec = key => { if (!/^\d+$/.test(values[key])) throw usage(`--${key} must be an unsigned decimal integer`); return BigInt(values[key]); };
  const options = { workspace: values.workspace, out: values.out, resume: values.resume === true, providerFingerprint: values['provider-fingerprint'] };
  if (values['page-width'] !== undefined) options.pageWidth = dec('page-width');
  if ((values['anchor-number'] === undefined) !== (values['anchor-hash'] === undefined)) throw usage('--anchor-number and --anchor-hash go together');
  if (values['anchor-number'] !== undefined) options.anchor = { blockNumber: dec('anchor-number'), blockHash: String(values['anchor-hash']).toLowerCase() };
  const bounds = {};
  for (const [flag, key] of Object.entries(BOUND_FLAGS)) if (values[flag] !== undefined) { const n = dec(flag); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw usage(`--${flag} is too large`); bounds[key] = Number(n); }
  if (Object.keys(bounds).length) options.bounds = bounds;
  return { values, options };
}

export async function runCli(argv, io = {}) {
  const out = io.stdout ?? (text => console.log(text)), err = io.stderr ?? (text => console.error(text));
  const emit = (sink, value) => sink(JSON.stringify(value));
  try {
    const { values, options } = parseCliArgs(argv);
    const baselineBytes = readFileSync(values.baseline);
    const baseline = JSON.parse(baselineBytes);
    const connection = await sanitized('connection', () => (io.connect ?? connect)(values, { readOnly: true }));
    const result = await captureResumableHistory(connection, values.manifest, baseline, { ...options, clock: io.clock,
      beforeWrite: () => must(Buffer.compare(readFileSync(values.baseline), baselineBytes) === 0, 'BASELINE_CHANGED', 'protected baseline file changed during capture') });
    emit(out, { ok: true, ...result.provenance, sha256: result.sha256, bytes: result.bytes.length, logCount: result.parsed.logs.length });
    return 0;
  } catch (error) {
    const known = error instanceof ResumableCaptureError;
    emit(err, { ok: false, error: { code: known ? error.code : 'FAILED', message: known ? error.message : 'capture failed; details withheld' },
      ...(error?.report ?? { approved: false, configurationChanged: false, transactionsSent: 0 }),
      note: 'No history approval, monitor configuration or hold was changed. Unapproved progress, if any, is retained in the workspace.' });
    return error?.usage ? 2 : 1;
  }
}

if (isEntrypoint(import.meta)) runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
