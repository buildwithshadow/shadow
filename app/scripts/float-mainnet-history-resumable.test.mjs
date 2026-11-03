import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { decodeFunctionData, encodeAbiParameters, keccak256, toBytes } from 'viem';
import { connectCandidate, floatAbi, SPEND_INTENT_TYPE_STRING } from './float-mainnet-config.mjs';
import { approvedHistoryIdentity } from './float-mainnet-approved-history.mjs';
import { buildNormalizedContent, hashBytes } from './float-mainnet-history-validation.mjs';
import { compareHistoryRenewal } from './float-mainnet-history-renewal.mjs';
import { captureHistoryExtension } from './float-mainnet-history-extension.mjs';
import { canonicalJson } from './float-mainnet-monitor-policy.mjs';
import { HARD_LIMITS, ResumableCaptureError, captureResumableHistory, encodePage, pageName, parseCliArgs, planWindows, runCli } from './float-mainnet-history-resumable.mjs';

// Fully offline: fake connection, fake clock, temporary directories. No network.
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const RUNTIME = '0x6000';
const SECRET = 'SECRETKEY123';
const ANCHOR = 12n;

// Previously approved prefix: anchor 2. Capture anchor 12, width 3 gives windows
// [3-5] [6-8] [9-11] [12-12]; window [6-8] is empty.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'resumable-'));
  const manifest = join(dir, 'manifest.json'), prefix = join(dir, 'prefix.json');
  writeFileSync(manifest, JSON.stringify({ ok: true, chainId: '5042002', contract: { address: address(1) },
    bytecode: { onchainRuntimeKeccak256: keccak256(RUNTIME) }, deployment: { blockNumber: '1' } }));
  const identity = approvedHistoryIdentity(manifest);
  const log = (n, index = 0, tx = n + 100) => ({ address: address(1), blockNumber: BigInt(n), blockHash: hash(n),
    transactionHash: hash(tx), transactionIndex: 0, logIndex: index, data: '0x', topics: [hash(99)], removed: false });
  const original = buildNormalizedContent([log(2)], identity, { blockNumber: '2', blockHash: hash(2) });
  writeFileSync(prefix, original.bytes);
  const baseline = { schemaVersion: 1, identity: { ...identity, usdc: address(8) }, owner: address(2), operators: [], sponsors: [], lines: [],
    effectiveLimits: { protocolReserve: '100', lineReserve: '100', lineSpend: '100', perSpend: '50', dailySpend: '100' },
    pauses: { openingsPaused: true, spendsPaused: true }, executor: { address: address(6), fromBlock: '1' },
    policy: { intervalMs: 1000, runTimeoutMs: 5000, maxHeartbeatAgeMs: 10000, maxBlockAgeSeconds: 120, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false },
    approvedHistory: { file: prefix, sha256: hashBytes(original.bytes), anchorBlock: '2', anchorHash: hash(2) } };
  delete baseline.identity.manifestHash;
  const s = { finalized: ANCHOR, code: RUNTIME, hashes: new Map(), requests: [], blocks: [], rpc: 0, writes: 0, failFrom: null, onLogs: null, onBlock: null,
    anchorReads: 0, flipAt: null, logs: [log(4), log(5, 0, 105), log(5, 1, 105), log(9), log(12)] };
  const hashOf = n => s.hashes.get(n) ?? hash(Number(n));
  const forbidden = () => { s.writes++; throw Error('write attempted'); };
  const connection = { chainId: 5042002n, address: address(1), deployBlock: 1n,
    chain: { rpcUrls: { default: { http: [`https://rpc.example/v1/${SECRET}`] } } }, client: {
      transport: { url: `https://rpc.example/v1/${SECRET}` },
      sendTransaction: forbidden, writeContract: forbidden, sendRawTransaction: forbidden, signTransaction: forbidden,
      getCode: async () => { s.rpc++; return s.code; },
      getBlock: async r => {
        s.rpc++;
        if (r.blockTag === 'finalized') return { number: s.finalized, hash: hashOf(s.finalized) };
        s.blocks.push(r.blockNumber); await s.onBlock?.(r);
        if (r.blockNumber === ANCHOR) { s.anchorReads++; if (s.flipAt && s.anchorReads >= s.flipAt) return { number: ANCHOR, hash: hash(1212) }; }
        return { number: r.blockNumber, hash: hashOf(r.blockNumber) };
      },
      getLogs: async r => {
        s.rpc++; s.requests.push([r.fromBlock, r.toBlock]); await s.onLogs?.(r);
        if (s.failFrom !== null && r.fromBlock >= s.failFrom) throw Error(`HTTP 429 rate limit exceeded at https://rpc.example/v1/${SECRET}`);
        return s.logs.filter(l => l.blockNumber >= r.fromBlock && l.blockNumber <= r.toBlock).map(l => ({ ...l, topics: [...l.topics] }));
      } } };
  const ws = join(dir, 'ws'), out = join(dir, 'candidate.json');
  const opts = (extra = {}) => ({ workspace: ws, out, providerFingerprint: 'provider-alpha-1', pageWidth: 3n, ...extra });
  const f = { dir, ws, out, manifest, prefix, baseline, connection, s, log, identity, original, opts,
    run: (extra = {}, conn = connection) => captureResumableHistory(conn, manifest, baseline, opts(extra)),
    resume: (extra = {}) => captureResumableHistory(connection, manifest, baseline, opts({ resume: true, ...extra })),
    reset: () => { s.requests.length = 0; s.rpc = 0; s.blocks.length = 0; },
    files: () => readdirSync(ws).sort(), pages: () => readdirSync(ws).filter(n => n.startsWith('page-')).sort(),
    snapshot: () => [readFileSync(prefix), readFileSync(manifest), canonicalJson(baseline)].map(String),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  return f;
}
async function refuses(promise, code) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof ResumableCaptureError, `unexpected error type: ${error?.message}`);
    if (code) assert.equal(error.code, code, error.message);
    assert.equal(error.report.approved, false); assert.equal(error.report.configurationChanged, false);
    assert.equal(error.report.transactionsSent, 0); assert.equal(error.report.candidateWritten, false);
    assert.ok(!JSON.stringify(error.report).includes(SECRET) && !error.message.includes(SECRET) && !error.message.includes('rpc.example'));
    return error;
  }
  return assert.fail(`expected refusal ${code ?? ''}`);
}
// Leaves pages 0 and 1 saved; window 2 hit a quota.
async function partial(f) {
  f.s.failFrom = 9n; await refuses(f.run(), 'RPC_READ_FAILED'); f.s.failFrom = null; f.reset();
}
const pagePath = (f, i) => join(f.ws, pageName(i));

test('capture supports the actual read only connection constructor shape', async () => {
  const f = fixture();
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const r = JSON.parse(text);
      let result;
      if (r.method === 'eth_chainId') result = '0x4cef52';
      else if (r.method === 'eth_getCode') result = RUNTIME;
      else if (r.method === 'eth_call') {
        const { functionName } = decodeFunctionData({ abi: floatAbi, data: r.params[0].data });
        const values = { NAME_HASH: keccak256(toBytes('ShadowFloatMainnet')), VERSION_HASH: keccak256(toBytes('1')),
          SPEND_INTENT_TYPEHASH: keccak256(toBytes(SPEND_INTENT_TYPE_STRING)), deploymentChainId: 5042002n };
        result = encodeAbiParameters([{ type: functionName === 'deploymentChainId' ? 'uint256' : 'bytes32' }], [values[functionName]]);
      } else throw Error('unexpected local method');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const rpcUrl = `http://127.0.0.1:${server.address().port}`;
    const actual = await connectCandidate({ rpcUrl, expectedChainId: 5042002n, address: address(1), deployBlock: 1n,
      runtimeHash: keccak256(RUNTIME), readSpacingMs: 0 }, { readOnly: true });
    assert.equal(Object.hasOwn(actual, 'rpcUrl'), false);
    assert.equal(actual.chain.rpcUrls.default.http[0], rpcUrl);
    // Keep the actual constructor metadata and feed deterministic capture reads.
    const result = await cliRun(f, [], { connect: async () => ({ ...actual, client: f.connection.client }) });
    assert.equal(result.code, 0, result.stderr.join());
    assert.equal(JSON.parse(result.stdout[0]).candidateWritten, true);
    assert.equal(f.s.writes, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.cleanup(); }
});

test('finalization freshly rechecks earlier event blocks after later windows were fetched', async () => {
  const f = fixture(); try {
    f.s.onLogs = r => { if (r.fromBlock === 12n) f.s.hashes.set(4n, hash(444)); };
    await refuses(f.run(), 'EVENT_BLOCK_NOT_CANONICAL');
    assert.equal(existsSync(f.out), false);
  } finally { f.cleanup(); }
});

test('a noncanonical newly fetched page is not saved as validated progress', async () => {
  const f = fixture(); try {
    f.s.hashes.set(4n, hash(444));
    await refuses(f.run(), 'EVENT_BLOCK_NOT_CANONICAL');
    assert.deepEqual(f.pages(), []);
  } finally { f.cleanup(); }
});

test('CLI refuses endpoint changes within one capture even when the provider label is unchanged', async () => {
  const f = fixture(); try {
    f.s.failFrom = 9n;
    assert.equal((await cliRun(f)).code, 1);
    f.s.failFrom = null; f.reset();
    f.connection.chain.rpcUrls.default.http[0] = 'https://second.example/rpc';
    const result = await cliRun(f, ['--resume']);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr[0]).error.code, 'HEADER_MISMATCH');
    assert.deepEqual(f.s.requests, []);
    assert.equal(existsSync(f.out), false);
    assert.ok(!readFileSync(join(f.ws, 'header.json'), 'utf8').includes(SECRET));
  } finally { f.cleanup(); }
});

test('a rewritten resume header cannot exceed the whole session page bound', async () => {
  const f = fixture(); try {
    f.s.failFrom = 3n;
    await refuses(f.run(), 'RPC_READ_FAILED');
    const path = join(f.ws, 'header.json');
    const header = JSON.parse(readFileSync(path));
    header.captureAnchor = { blockNumber: '1000', blockHash: hash(1000) };
    header.pageCount = '333';
    writeFileSync(path, canonicalJson(header));
    f.s.failFrom = null; f.s.finalized = 1000n; f.reset();
    await refuses(f.resume(), 'BOUND_PAGES');
    assert.equal(f.s.rpc, 0);
    assert.equal(existsSync(f.out), false);
  } finally { f.cleanup(); }
});
// Rewrites a page with a freshly computed digest and canonical encoding: only
// local checks other than the digest can catch the change.
function edit(f, index, mutate) {
  const body = JSON.parse(readFileSync(pagePath(f, index))); delete body.contentDigest;
  mutate(body); writeFileSync(pagePath(f, index), encodePage(body));
}

test('quota midway then resume: saved windows are not refetched and bytes equal an uninterrupted capture', async () => {
  const f = fixture(); try {
    const reference = await captureHistoryExtension(f.connection, f.manifest, f.baseline); f.reset();
    const before = f.snapshot();
    f.s.failFrom = 9n;
    const error = await refuses(f.run(), 'RPC_READ_FAILED');
    // One request for the failed window: the quota is a failure, never a smaller-range hint.
    assert.deepEqual(f.s.requests, [[3n, 5n], [6n, 8n], [9n, 11n]]);
    assert.match(error.message, /rate limit or quota suspected/);
    assert.equal(error.report.partial, true); assert.equal(error.report.progressRetained, true);
    assert.equal(error.report.pagesCompleted, 2); assert.equal(error.report.pagesTotal, 4);
    assert.deepEqual(f.pages(), [pageName(0), pageName(1)]);
    assert.equal(existsSync(f.out), false);
    assert.equal(existsSync(join(f.ws, 'capture.lock')), false, 'a clean failure releases its own lock');
    f.s.failFrom = null; f.reset();
    const result = await f.resume();
    assert.deepEqual(f.s.requests, [[9n, 11n], [12n, 12n]]);
    assert.deepEqual(result.bytes, reference.bytes);
    assert.deepEqual(readFileSync(f.out), reference.bytes);
    assert.equal(result.sha256, reference.sha256);
    assert.deepEqual(result.provenance, { ...result.provenance, approved: false, configurationChanged: false, transactionsSent: 0, complete: true, partial: false, pagesFetchedThisRun: 2 });
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.s.writes, 0);
  } finally { f.cleanup(); }
});

test('a rate-limit error is never turned into a smaller window and carries no credential', async () => {
  const f = fixture(); try {
    for (const message of ['Request exceeds defined limit (-32005)', `quota exhausted https://rpc.example/${SECRET}`]) {
      f.s.onLogs = () => { throw Error(message); };
      f.reset();
      await refuses(rmIfAny(f).then(() => f.run()), 'RPC_READ_FAILED');
      assert.deepEqual(f.s.requests, [[3n, 5n]]);
    }
  } finally { f.cleanup(); }
});
async function rmIfAny(f) { rmSync(f.ws, { recursive: true, force: true }); }

test('empty windows count toward coverage and an absent empty page is refetched, never assumed empty', async () => {
  const f = fixture(); try {
    f.s.logs = [f.log(12)];
    await f.run();
    assert.equal(f.pages().length, 4);
    assert.deepEqual(JSON.parse(readFileSync(pagePath(f, 1))).logs, []);
    rmSync(f.out); rmSync(pagePath(f, 1)); f.reset();
    f.s.failFrom = 6n;
    await refuses(f.resume(), 'RPC_READ_FAILED');
    assert.equal(existsSync(f.out), false, 'a missing window cannot yield output');
    f.s.failFrom = null; f.reset();
    await f.resume();
    assert.deepEqual(f.s.requests, [[6n, 8n]]);
    assert.equal(existsSync(f.out), true);
  } finally { f.cleanup(); }
});

test('a missing non-empty window cannot produce output while the provider fails', async () => {
  const f = fixture(); try {
    await partial(f);
    rmSync(pagePath(f, 0));
    f.s.failFrom = 3n;
    await refuses(f.resume(), 'RPC_READ_FAILED');
    assert.equal(existsSync(f.out), false);
    f.s.failFrom = null; f.reset();
    await f.resume();
    assert.equal(f.s.requests[0][0], 3n, 'window 0 is refetched');
  } finally { f.cleanup(); }
});

const TAMPER = [
  ['page not marked complete', body => { body.complete = false; }, 'PAGE_INCOMPLETE'],
  ['log field missing', body => { delete body.logs[0].data; }, 'PAGE_INVALID'],
  ['log field added', body => { body.logs[0].extra = 1; }, 'PAGE_INVALID'],
  ['page field missing', body => { delete body.toBlock; }, 'PAGE_INVALID'],
  ['window end altered', body => { body.toBlock = '6'; }, 'PAGE_BOUNDS'],
  ['page index altered', body => { body.index = 1; }, 'PAGE_BOUNDS'],
  ['bound to another header', body => { body.headerDigest = 'f'.repeat(64); }, 'PAGE_HEADER_BINDING'],
  ['duplicate log', body => { body.logs.push(structuredClone(body.logs[2])); }, 'PAGE_ORDER'],
  ['logs out of order', body => { body.logs.reverse(); }, 'PAGE_ORDER'],
  ['log outside window', body => { body.logs.push({ ...body.logs[2], blockNumber: '7', blockHash: hash(7), transactionHash: hash(107) }); }, 'PAGE_OUT_OF_RANGE'],
  ['foreign address', body => { body.logs[0].address = address(7); }, 'PAGE_INVALID'],
  ['non-normalized hex', body => { body.logs[0].blockHash = body.logs[0].blockHash.replace(/[0-9a-f]$/, 'F'); body.logs[0].blockHash = body.logs[0].blockHash.toUpperCase().replace('0X', '0x'); }, 'PAGE_INVALID'],
  ['removed log', body => { body.logs[0].removed = true; }, 'PAGE_INVALID'],
  ['conflicting block hash', body => { body.logs[2].blockHash = hash(555); }, 'PAGES_INCONSISTENT'],
];
for (const [name, mutate, code] of TAMPER) test(`tampered page refused (digest recomputed): ${name}`, async () => {
  const f = fixture(); try {
    await partial(f);
    edit(f, 0, mutate);
    await refuses(f.resume(), code);
    assert.deepEqual(f.s.requests, []);
    assert.equal(existsSync(f.out), false);
    assert.equal(existsSync(join(f.ws, 'capture.lock')), false);
  } finally { f.cleanup(); }
});

test('a transaction hash reused at another block across windows is refused', async () => {
  const f = fixture(); try {
    await partial(f);
    edit(f, 1, body => { body.logs.push({ address: address(1), blockNumber: '7', blockHash: hash(7), transactionHash: hash(104),
      transactionIndex: 0, logIndex: 0, data: '0x', topics: [hash(99)], removed: false }); });
    await refuses(f.resume(), 'PAGES_INCONSISTENT');
    assert.deepEqual(f.s.requests, []);
  } finally { f.cleanup(); }
});

const RAW = [
  ['content altered without recomputing the digest', page => JSON.stringify({ ...page, logs: page.logs.map(l => ({ ...l, data: '0x00' })) }), 'PAGE_DIGEST'],
  ['digest altered', page => JSON.stringify({ ...page, contentDigest: 'a'.repeat(64) }), 'PAGE_DIGEST'],
  ['non-canonical encoding of a valid page', page => JSON.stringify(page, null, 2), 'PAGE_DIGEST'],
  ['malformed JSON', () => '{"kind":', 'PAGE_INVALID'],
  ['JSON array', () => '[]', 'PAGE_INVALID'],
  ['JSON null', () => 'null', 'PAGE_INVALID'],
  ['empty file', () => '', 'PAGE_INVALID'],
  ['oversized page', () => Buffer.alloc(2 * 1024 * 1024, 0x20), 'BOUND_PAGE_BYTES'],
];
for (const [name, make, code] of RAW) test(`tampered page refused (raw bytes): ${name}`, async () => {
  const f = fixture(); try {
    await partial(f);
    writeFileSync(pagePath(f, 0), make(JSON.parse(readFileSync(pagePath(f, 0)))));
    await refuses(f.resume(), code);
    assert.deepEqual(f.s.requests, []); assert.equal(existsSync(f.out), false);
  } finally { f.cleanup(); }
});

const ENTRIES = [
  ['symlinked page', f => { rmSync(pagePath(f, 1)); symlinkSync(pagePath(f, 0), pagePath(f, 1)); }],
  ['symlinked page to a new valid copy', f => { writeFileSync(join(f.dir, 'copy.json'), readFileSync(pagePath(f, 1))); rmSync(pagePath(f, 1)); symlinkSync(join(f.dir, 'copy.json'), pagePath(f, 1)); }],
  ['unexpected file', f => writeFileSync(join(f.ws, 'notes.txt'), 'x')],
  ['leftover temporary file', f => writeFileSync(`${pagePath(f, 2)}.tmp-abcdef`, '{}')],
  ['unexpected directory', f => mkdirSync(join(f.ws, 'page-00000002.json'))],
  ['page beyond the planned count', f => writeFileSync(join(f.ws, pageName(9)), '{}')],
  ['symlinked lock', f => symlinkSync(join(f.dir, 'nowhere'), join(f.ws, 'capture.lock'))],
];
for (const [name, mutate] of ENTRIES) test(`workspace entry refused: ${name}`, async () => {
  const f = fixture(); try {
    await partial(f);
    mutate(f);
    const error = await refuses(f.resume());
    assert.ok(['WORKSPACE_UNEXPECTED_FILE', 'LOCKED'].includes(error.code), error.code);
    assert.deepEqual(f.s.requests, []); assert.equal(existsSync(f.out), false);
  } finally { f.cleanup(); }
});

test('workspace must be private, real and owned; new sessions need a fresh directory', async () => {
  const f = fixture(); try {
    await partial(f);
    assert.equal(statSync(f.ws).mode & 0o777, 0o700);
    for (const name of f.files()) assert.equal(statSync(join(f.ws, name)).mode & 0o777, 0o600, name);
    chmodSync(f.ws, 0o750);
    await refuses(f.resume(), 'WORKSPACE_UNSAFE');
    chmodSync(f.ws, 0o700);
    symlinkSync(f.ws, join(f.dir, 'link'));
    await refuses(f.resume({ workspace: join(f.dir, 'link') }), 'WORKSPACE_UNSAFE');
    await refuses(f.run(), 'WORKSPACE_EXISTS');
    await refuses(f.resume({ workspace: join(f.dir, 'absent') }), 'WORKSPACE_MISSING');
    assert.deepEqual(f.s.requests, []);
  } finally { f.cleanup(); }
});

test('header is write-once, private and bound to every input; secrets are not persisted', async () => {
  const f = fixture(); try {
    await partial(f);
    const header = readFileSync(join(f.ws, 'header.json'));
    const text = header.toString();
    assert.match(text, /"providerDigest":"[0-9a-f]{64}"/);
    await f.resume();
    assert.deepEqual(readFileSync(join(f.ws, 'header.json')), header);
    const everything = f.files().map(n => readFileSync(join(f.ws, n)).toString()).join('\n');
    for (const secret of [SECRET, 'rpc.example', 'provider-alpha-1']) assert.equal(everything.includes(secret), false, secret);
    const parsed = JSON.parse(text);
    assert.equal(parsed.captureAnchor.blockNumber, '12'); assert.equal(parsed.prefix.sha256, f.baseline.approvedHistory.sha256);
    assert.equal(parsed.identity.manifestHash, f.identity.manifestHash); assert.equal(parsed.pageWidth, '3');
  } finally { f.cleanup(); }
});

test('missing or altered header is refused', async () => {
  const f = fixture(); try {
    await partial(f);
    const header = readFileSync(join(f.ws, 'header.json'));
    writeFileSync(join(f.ws, 'header.json'), canonicalJson({ ...JSON.parse(header), pageWidth: '4' }));
    await refuses(f.resume(), 'HEADER_MISMATCH');
    writeFileSync(join(f.ws, 'header.json'), canonicalJson({ ...JSON.parse(header), captureAnchor: { blockNumber: '11', blockHash: hash(11) } }));
    await refuses(f.resume(), 'HEADER_MISMATCH');
    writeFileSync(join(f.ws, 'header.json'), '{');
    await refuses(f.resume(), 'HEADER_INVALID');
    rmSync(join(f.ws, 'header.json'));
    await refuses(f.resume(), 'HEADER_INVALID');
    assert.deepEqual(f.s.requests, []);
  } finally { f.cleanup(); }
});

const CHANGES = [
  ['baseline changed', f => { f.baseline.owner = address(3); }, 'HEADER_MISMATCH'],
  ['baseline identity changed', f => { f.baseline.identity.usdc = address(9); }, 'HEADER_MISMATCH'],
  ['provider changed', () => ({ providerFingerprint: 'provider-beta-22' }), 'HEADER_MISMATCH'],
  ['page width changed', () => ({ pageWidth: 4n }), 'HEADER_MISMATCH'],
  ['a limit changed', () => ({ bounds: { maxLogs: 100 } }), 'HEADER_MISMATCH'],
  ['a different anchor requested', () => ({ anchor: { blockNumber: 11n, blockHash: hash(11) } }), 'ANCHOR_CHANGED'],
  ['same number, different hash requested', () => ({ anchor: { blockNumber: 12n, blockHash: hash(1212) } }), 'ANCHOR_CHANGED'],
  ['fixed anchor reorganized', f => { f.s.hashes.set(12n, hash(1212)); }, 'ANCHOR_CHANGED'],
  ['fixed anchor no longer finalized', f => { f.s.finalized = 11n; }, 'ANCHOR_NOT_FINAL'],
  ['runtime differs at the anchor', f => { f.s.code = '0x6001'; }, 'RUNTIME_MISMATCH'],
  ['approved prefix replaced with a newly approved one', f => {
    const next = buildNormalizedContent([], f.identity, { blockNumber: '2', blockHash: hash(2) });
    writeFileSync(f.prefix, next.bytes); f.baseline.approvedHistory.sha256 = hashBytes(next.bytes);
  }, 'HEADER_MISMATCH'],
  ['manifest replaced and everything re-approved against it', f => {
    const manifest = JSON.parse(readFileSync(f.manifest)); manifest.checkedAt = 'later'; writeFileSync(f.manifest, JSON.stringify(manifest));
    const next = buildNormalizedContent([f.log(2)], approvedHistoryIdentity(f.manifest), { blockNumber: '2', blockHash: hash(2) });
    writeFileSync(f.prefix, next.bytes); f.baseline.approvedHistory.sha256 = hashBytes(next.bytes);
  }, 'HEADER_MISMATCH'],
  ['manifest replaced under the old prefix', f => {
    const manifest = JSON.parse(readFileSync(f.manifest)); manifest.checkedAt = 'later'; writeFileSync(f.manifest, JSON.stringify(manifest));
  }, 'APPROVED_PREFIX_FAILED'],
  ['approved prefix bytes altered', f => { writeFileSync(f.prefix, '{}'); }, 'APPROVED_PREFIX_FAILED'],
];
for (const [name, change, code] of CHANGES) test(`resume refused when input changed: ${name}`, async () => {
  const f = fixture(); try {
    await partial(f);
    const extra = change(f);
    await refuses(f.resume(extra ?? {}), code);
    assert.deepEqual(f.s.requests, []); assert.equal(existsSync(f.out), false);
  } finally { f.cleanup(); }
});

test('a new session needs a strictly newer finalized anchor and a canonical, finalized requested anchor', async () => {
  const f = fixture(); try {
    f.s.finalized = 2n;
    await refuses(f.run(), 'ANCHOR_NOT_NEWER');
    f.s.finalized = 12n;
    await refuses(f.run({ anchor: { blockNumber: 13n, blockHash: hash(13) } }), 'ANCHOR_NOT_FINAL');
    await refuses(f.run({ anchor: { blockNumber: 11n, blockHash: hash(1111) } }), 'ANCHOR_CHANGED');
    assert.equal(existsSync(f.ws), false, 'a refused start creates no workspace');
    const ok = await f.run({ anchor: { blockNumber: 11n, blockHash: hash(11) } });
    assert.equal(ok.parsed.anchor.blockNumber, '11');
    assert.deepEqual(f.s.requests.at(-1), [9n, 11n]);
  } finally { f.cleanup(); }
});

test('canonical checks: event block reorg on resume, on a new window, and the old anchor', async () => {
  const f = fixture(); try {
    await partial(f);
    f.s.hashes.set(4n, hash(444));
    await refuses(f.resume(), 'EVENT_BLOCK_NOT_CANONICAL');
    assert.deepEqual(f.s.requests, [], 'saved blocks are rechecked before anything else is fetched');
  } finally { f.cleanup(); }
  const g = fixture(); try {
    g.s.hashes.set(9n, hash(999));
    const error = await refuses(g.run(), 'EVENT_BLOCK_NOT_CANONICAL');
    assert.equal(error.report.pagesCompleted, 2, 'only canonically checked pages are kept as unapproved progress');
    await refuses(g.resume(), 'EVENT_BLOCK_NOT_CANONICAL');
    assert.equal(existsSync(g.out), false);
  } finally { g.cleanup(); }
  const h = fixture(); try {
    h.s.hashes.set(2n, hash(22));
    await refuses(h.run(), 'OLD_ANCHOR_REORGANIZED');
    assert.equal(existsSync(h.ws), false); assert.deepEqual(h.s.requests, []);
  } finally { h.cleanup(); }
});

test('a capture anchor reorg at any read, including the last, is refused and writes no output', async () => {
  for (const events of [[4, 12], [4]]) {
    const clean = fixture(); let reads;
    try { clean.s.logs = events.map(n => clean.log(n)); await clean.run(); reads = clean.s.anchorReads; } finally { clean.cleanup(); }
    assert.ok(reads >= 1);
    for (let k = 1; k <= reads; k++) {
      const f = fixture(); try {
        f.s.logs = events.map(n => f.log(n)); f.s.flipAt = k;
        const error = await refuses(f.run());
        assert.equal(existsSync(f.out), false, `flip at read ${k}`);
        if (k === reads) assert.equal(error.code, 'ANCHOR_CHANGED');
      } finally { f.cleanup(); }
    }
  }
});

test('simultaneous runs are refused and an abandoned lock is never cleared automatically', async () => {
  const f = fixture(); try {
    let open; const gate = new Promise(r => { open = r; }); let entered; const inside = new Promise(r => { entered = r; });
    f.s.onLogs = async () => { entered(); await gate; };
    const first = f.run();
    await inside;
    await refuses(f.resume(), 'LOCKED');
    await refuses(f.run(), 'WORKSPACE_EXISTS');
    open(); f.s.onLogs = null;
    await first;
    assert.equal(existsSync(join(f.ws, 'capture.lock')), false);
  } finally { f.cleanup(); }
  const g = fixture(); try {
    await partial(g);
    writeFileSync(join(g.ws, 'capture.lock'), '{"nonce":"left-by-a-crashed-run"}');
    await refuses(g.resume(), 'LOCKED');
    await refuses(g.resume(), 'LOCKED');
    assert.equal(readFileSync(join(g.ws, 'capture.lock')).toString(), '{"nonce":"left-by-a-crashed-run"}');
    assert.deepEqual(g.s.requests, []);
  } finally { g.cleanup(); }
});

test('output collision is refused: before work, during capture, and a dangling symlink; progress survives', async () => {
  const f = fixture(); try {
    writeFileSync(f.out, 'precious');
    await refuses(f.run(), 'OUTPUT_EXISTS');
    assert.equal(f.s.rpc, 0); assert.equal(existsSync(f.ws), false);
    rmSync(f.out);
    symlinkSync(join(f.dir, 'nowhere'), f.out);
    await refuses(f.run(), 'OUTPUT_EXISTS');
    rmSync(f.out);
    f.s.onLogs = r => { if (r.fromBlock === 12n) writeFileSync(f.out, 'precious'); };
    const error = await refuses(f.run(), 'OUTPUT_EXISTS');
    assert.equal(readFileSync(f.out).toString(), 'precious');
    assert.equal(error.report.pagesCompleted, 4); assert.equal(error.report.partial, false);
    rmSync(f.out); f.s.onLogs = null; f.reset();
    const result = await f.resume();
    assert.deepEqual(f.s.requests, [], 'complete windows are never refetched');
    assert.deepEqual(readFileSync(f.out), result.bytes);
  } finally { f.cleanup(); }
});

test('output and workspace may not overlap the prefix, manifest or each other', async () => {
  const f = fixture(); try {
    await refuses(f.run({ out: f.prefix }), 'BAD_OPTION');
    await refuses(f.run({ out: join(f.ws, 'candidate.json') }), 'BAD_OPTION');
    await refuses(f.run({ workspace: f.dir }), 'BAD_OPTION');
    assert.equal(f.s.rpc, 0);
  } finally { f.cleanup(); }
});

test('resource bounds are enforced and keep only validated progress', async () => {
  const sized = fixture(); let sizes;
  try { await sized.run(); sizes = sized.pages().map(n => statSync(join(sized.ws, n)).size); } finally { sized.cleanup(); }
  let f = fixture(); try {
    await refuses(f.run({ bounds: { maxPages: 3 } }), 'BOUND_PAGES');
    assert.equal(existsSync(f.ws), false);
  } finally { f.cleanup(); }
  f = fixture(); try {
    const error = await refuses(f.run({ bounds: { maxPageBytes: sizes[0] - 1 } }), 'BOUND_PAGE_BYTES');
    assert.equal(error.report.pagesCompleted, 0); assert.deepEqual(f.pages(), []);
  } finally { f.cleanup(); }
  f = fixture(); try {
    const error = await refuses(f.run({ bounds: { maxTotalBytes: sizes[0] + sizes[1] } }), 'BOUND_TOTAL_BYTES');
    assert.equal(error.report.pagesCompleted, 2); assert.equal(f.pages().length, 2);
  } finally { f.cleanup(); }
  f = fixture(); try {
    const error = await refuses(f.run({ bounds: { maxLogs: 3 } }), 'BOUND_LOGS');
    assert.equal(error.report.pagesCompleted, 2);
  } finally { f.cleanup(); }
  f = fixture(); try {
    const error = await refuses(f.run({ bounds: { maxRpcCalls: 5 } }), 'WORK_BOUND');
    assert.equal(f.s.rpc, 5); assert.equal(error.report.rpcCalls, 5); assert.equal(error.report.partial, true);
    assert.equal(existsSync(f.out), false);
  } finally { f.cleanup(); }
  f = fixture(); try {
    let now = 0;
    await refuses(f.run({ clock: () => (now += 400), bounds: { maxRuntimeMs: 1000 } }), 'WORK_BOUND');
    assert.equal(f.s.rpc, 2);
  } finally { f.cleanup(); }
  f = fixture(); try { // a saved page that exceeds the session's own bound is refused on resume
    const bounds = { maxPageBytes: sizes[0] + 100 };
    f.s.failFrom = 9n; await refuses(f.run({ bounds }), 'RPC_READ_FAILED'); f.s.failFrom = null; f.reset();
    edit(f, 0, body => { body.logs[0].data = `0x${'00'.repeat(500)}`; });
    await refuses(f.resume({ bounds }), 'BOUND_PAGE_BYTES');
    assert.deepEqual(f.s.requests, []);
  } finally { f.cleanup(); }
});

const BAD_OPTIONS = [
  { pageWidth: 3 }, { pageWidth: 0n }, { pageWidth: HARD_LIMITS.pageWidth + 1n },
  { bounds: { maxPages: 0 } }, { bounds: { maxPages: HARD_LIMITS.maxPages + 1 } }, { bounds: { maxLogs: 1.5 } }, { bounds: { bogus: 1 } },
  { providerFingerprint: 'https://rpc.example/v1/KEY12345' }, { providerFingerprint: 'short' }, { providerFingerprint: 'has space inside' },
  { providerFingerprint: 'key?apikey=abcdef123' }, { providerFingerprint: undefined },
  { privateKey: '0x01' }, { clock: 5 }, { resume: 'yes' }, { anchor: { blockNumber: 5, blockHash: hash(5) } }, { anchor: { blockNumber: 5n, blockHash: 'x' } },
];
test('strict options are validated before any RPC call or write', async () => {
  const f = fixture(); try {
    for (const bad of BAD_OPTIONS) await refuses(f.run(bad), 'BAD_OPTION');
    assert.equal(f.s.rpc, 0); assert.equal(existsSync(f.ws), false);
  } finally { f.cleanup(); }
});

test('windows are inclusive, contiguous, non-overlapping and exact', () => {
  for (const [first, last, width] of [[3n, 12n, 3n], [3n, 11n, 3n], [5n, 5n, 1n], [3n, 12n, 100n], [1n, 100n, 7n], [10n, 10009n, 5000n]]) {
    const windows = planWindows(first, last, width, 100_000);
    assert.equal(windows[0].from, first); assert.equal(windows.at(-1).to, last);
    let covered = 0n;
    windows.forEach((w, i) => {
      assert.equal(w.index, i); assert.ok(w.to >= w.from && w.to - w.from + 1n <= width);
      if (i) assert.equal(w.from, windows[i - 1].to + 1n);
      covered += w.to - w.from + 1n;
    });
    assert.equal(covered, last - first + 1n);
  }
  for (const args of [[5n, 4n, 1n, 10], [1n, 5n, 0n, 10], [1n, 100n, 1n, 10], [1, 5, 1, 10]]) assert.throws(() => planWindows(...args), ResumableCaptureError);
});

test('nothing protected is mutated and no transaction path is touched, on success or failure', async () => {
  const f = fixture(); try {
    const before = f.snapshot(), baselineObject = structuredClone(f.baseline);
    f.s.failFrom = 9n;
    await refuses(f.run(), 'RPC_READ_FAILED');
    f.s.failFrom = null;
    await refuses(f.run(), 'WORKSPACE_EXISTS');
    const ok = await f.resume();
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.baseline, baselineObject);
    assert.equal(f.s.writes, 0);
    assert.equal(ok.provenance.approved, false); assert.equal(ok.provenance.configurationChanged, false); assert.equal(ok.provenance.transactionsSent, 0);
    assert.equal(ok.provenance.previousDigest, f.baseline.approvedHistory.sha256);
    assert.equal(hashBytes(readFileSync(f.out)), ok.sha256);
    assert.equal(statSync(f.out).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('structural tampering is caught locally; an omitted valid event is not, and only independent comparison catches it', async () => {
  const honest = fixture(), omitting = fixture(); try {
    const first = await honest.run();
    const second = await honest.run({ workspace: join(honest.dir, 'ws2'), out: join(honest.dir, 'candidate2.json'), providerFingerprint: 'provider-beta-22' });
    const approvedBytes = readFileSync(honest.prefix), approvedDigest = hashBytes(approvedBytes);
    const compare = (a, b) => compareHistoryRenewal({ approvedBytes, approvedDigest, identity: honest.identity, firstBytes: a, secondBytes: b });
    assert.equal(compare(first.bytes, second.bytes).comparisonPassed, true);

    await partial(omitting);
    const saved = readFileSync(pagePath(omitting, 0));
    writeFileSync(pagePath(omitting, 0), JSON.stringify({ ...JSON.parse(saved), logs: JSON.parse(saved).logs.slice(1) }));
    await refuses(omitting.resume(), 'PAGE_DIGEST'); // omission without recomputed hashes: local corruption check
    writeFileSync(pagePath(omitting, 0), saved);
    edit(omitting, 0, body => { body.logs = body.logs.filter(l => l.blockNumber !== '4'); }); // consistent rewrite: invisible locally
    const omitted = await omitting.resume();
    assert.match(omitted.provenance.limitations, /omitted valid event is undetectable locally/);
    assert.notDeepEqual(omitted.bytes, first.bytes);
    assert.throws(() => compare(omitted.bytes, first.bytes), /disagree/);
  } finally { honest.cleanup(); omitting.cleanup(); }
});

function cliRun(f, extra = [], io = {}) {
  const baselinePath = join(f.dir, 'baseline.json');
  if (!existsSync(baselinePath)) writeFileSync(baselinePath, JSON.stringify(f.baseline));
  const stdout = [], stderr = [], calls = [];
  const connect = async (values, options) => { calls.push([values.manifest, options]); return f.connection; };
  const argv = ['--manifest', f.manifest, '--baseline', baselinePath, '--workspace', f.ws, '--out', f.out,
    '--provider-fingerprint', 'provider-alpha-1', '--page-width', '3', ...extra];
  return runCli(argv, { connect, stdout: t => stdout.push(t), stderr: t => stderr.push(t), ...io }).then(code => ({ code, stdout, stderr, calls, baselinePath }));
}

test('CLI: read-only connection, resumable failure exit, sanitized JSON, byte-identical resume', async () => {
  const f = fixture(); try {
    const reference = await captureHistoryExtension(f.connection, f.manifest, f.baseline); f.reset();
    f.s.failFrom = 9n;
    let r = await cliRun(f);
    assert.equal(r.code, 1); assert.deepEqual(r.stdout, []);
    const failure = JSON.parse(r.stderr[0]);
    assert.equal(failure.ok, false); assert.equal(failure.error.code, 'RPC_READ_FAILED'); assert.equal(failure.partial, true);
    assert.equal(failure.approved, false); assert.equal(failure.configurationChanged, false); assert.equal(failure.transactionsSent, 0);
    assert.ok(!r.stderr[0].includes(SECRET));
    f.s.failFrom = null; f.reset();
    r = await cliRun(f, ['--resume']);
    assert.equal(r.code, 0); assert.deepEqual(r.stderr, []);
    const report = JSON.parse(r.stdout[0]);
    assert.equal(report.ok, true); assert.equal(report.approved, false); assert.equal(report.configurationChanged, false);
    assert.equal(report.transactionsSent, 0); assert.equal(report.partial, false); assert.equal(report.sha256, reference.sha256);
    assert.deepEqual(f.s.requests, [[9n, 11n], [12n, 12n]]);
    assert.deepEqual(readFileSync(f.out), reference.bytes);
    assert.deepEqual(r.calls, [[f.manifest, { readOnly: true }]]);
    assert.equal(f.s.writes, 0);
  } finally { f.cleanup(); }
});

test('CLI: strict parsing rejects unknown flags, key flags and malformed numbers before connecting', async () => {
  const f = fixture(); try {
    for (const extra of [['--private-key', 'x'], ['--execute'], ['--rpc-url', 'https://rpc.example/v1/KEY'], ['stray'], ['--page-width', 'abc'],
      ['--page-width', '-1'], ['--max-pages', '1e3'], ['--anchor-number', '5'], ['--anchor-hash', hash(5)]]) {
      const r = await cliRun(f, extra);
      assert.equal(r.code, 2, extra.join(' ')); assert.deepEqual(r.calls, []);
      assert.equal(JSON.parse(r.stderr[0]).error.code, 'USAGE');
    }
    const missing = await runCli([], { connect: () => assert.fail('connected'), stdout: () => {}, stderr: () => {} });
    assert.equal(missing, 2);
    assert.equal(existsSync(f.ws), false);
    assert.deepEqual(parseCliArgs(['--manifest', 'm', '--baseline', 'b', '--workspace', 'w', '--out', 'o', '--provider-fingerprint', 'provider-alpha-1',
      '--resume', '--page-width', '7', '--anchor-number', '12', '--anchor-hash', hash(12).toUpperCase().replace('0X', '0x'), '--max-pages', '9']).options,
    { workspace: 'w', out: 'o', resume: true, providerFingerprint: 'provider-alpha-1', pageWidth: 7n, anchor: { blockNumber: 12n, blockHash: hash(12) }, bounds: { maxPages: 9 } });
  } finally { f.cleanup(); }
});

test('CLI: a credential-like fingerprint, a failing connection and a changed baseline file are refused without leaking', async () => {
  const f = fixture(); try {
    let r = await cliRun(f, ['--provider-fingerprint', `https://rpc.example/v1/${SECRET}`]);
    assert.equal(r.code, 1); assert.equal(JSON.parse(r.stderr[0]).error.code, 'BAD_OPTION'); assert.ok(!r.stderr[0].includes(SECRET));
    assert.equal(existsSync(f.ws), false);
    r = await cliRun(f, [], { connect: async () => { throw Error(`connect failed https://rpc.example/v1/${SECRET}`); } });
    assert.equal(r.code, 1); assert.equal(JSON.parse(r.stderr[0]).error.code, 'CONNECTION_FAILED'); assert.ok(!r.stderr[0].includes(SECRET));
    f.s.onLogs = () => writeFileSync(r.baselinePath, `${JSON.stringify(f.baseline)}\n`);
    r = await cliRun(f);
    assert.equal(r.code, 1); assert.equal(JSON.parse(r.stderr[0]).error.code, 'BASELINE_CHANGED');
    assert.equal(existsSync(f.out), false);
    assert.equal(JSON.parse(r.stderr[0]).pagesCompleted, 4, 'unapproved progress is retained');
  } finally { f.cleanup(); }
});

const DURING = [
  ['approved prefix bytes replaced', f => writeFileSync(f.prefix, '{}')],
  ['manifest replaced', f => writeFileSync(f.manifest, JSON.stringify({ ...JSON.parse(readFileSync(f.manifest)), checkedAt: 'later' }))],
  ['baseline object changed', f => { f.baseline.owner = address(3); }, 'BASELINE_CHANGED'],
  ['old anchor reorganized after its first check', f => { f.s.hashes.set(2n, hash(22)); }],
  ['capture anchor reorganized', f => { f.s.hashes.set(12n, hash(1212)); }],
];
for (const [name, change, code] of DURING) test(`input changed during capture is refused with no output: ${name}`, async () => {
  const f = fixture(); try {
    f.s.onLogs = r => { if (r.fromBlock === 12n) change(f); };
    await refuses(f.run(), code);
    assert.equal(existsSync(f.out), false);
  } finally { f.cleanup(); }
});

test('an approved prefix that is not in exact canonical form is refused rather than silently renormalized', async () => {
  const f = fixture(); try {
    const bytes = Buffer.from(JSON.stringify(JSON.parse(f.original.bytes), null, 2));
    writeFileSync(f.prefix, bytes); f.baseline.approvedHistory.sha256 = hashBytes(bytes);
    await refuses(f.run(), 'PREFIX_NOT_PRESERVED');
    assert.equal(existsSync(f.out), false);
  } finally { f.cleanup(); }
});

test('final bytes do not depend on page width or on where interruptions fell', async () => {
  const reference = fixture(); let expected;
  try { expected = (await captureHistoryExtension(reference.connection, reference.manifest, reference.baseline)).bytes; } finally { reference.cleanup(); }
  for (const pageWidth of [1n, 2n, 4n, 5n, 100n]) for (const failFrom of [null, 5n, 9n]) {
    const f = fixture(); let result; try {
      f.s.failFrom = failFrom;
      try { result = await f.run({ pageWidth }); } catch (error) { // only a window starting at or after failFrom fails
        assert.equal(error.code, 'RPC_READ_FAILED'); f.s.failFrom = null; result = await f.resume({ pageWidth });
      }
      assert.deepEqual(result.bytes, expected, `width ${pageWidth} fail ${failFrom}`);
    } finally { f.cleanup(); }
  }
});
