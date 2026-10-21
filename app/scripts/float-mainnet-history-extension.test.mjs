import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { approvedHistoryIdentity } from './float-mainnet-approved-history.mjs';
import { buildNormalizedContent, hashBytes, validateApprovedBytes } from './float-mainnet-history-validation.mjs';
import { compareHistoryRenewal } from './float-mainnet-history-renewal.mjs';
import { captureHistoryExtension } from './float-mainnet-history-extension.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-extension-'));
  const manifest = join(dir, 'manifest.json'), prefix = join(dir, 'prefix.json');
  const runtime = '0x6000';
  writeFileSync(manifest, JSON.stringify({ ok: true, chainId: '5042002', contract: { address: address(1) },
    bytecode: { onchainRuntimeKeccak256: keccak256(runtime) }, deployment: { blockNumber: '1' } }));
  const identity = approvedHistoryIdentity(manifest);
  const log = (n, index = 0) => ({ address: address(1), blockNumber: BigInt(n), blockHash: hash(n),
    transactionHash: hash(n + 100), transactionIndex: 0, logIndex: index, data: '0x', topics: [hash(99)], removed: false });
  const original = buildNormalizedContent([log(2)], identity, { blockNumber: '2', blockHash: hash(2) });
  writeFileSync(prefix, original.bytes);
  const baseline = { schemaVersion: 1, identity: { ...identity, usdc: address(8) }, owner: address(2),
    operators: [], sponsors: [], lines: [], effectiveLimits: { protocolReserve: '100', lineReserve: '100', lineSpend: '100', perSpend: '50', dailySpend: '100' },
    pauses: { openingsPaused: true, spendsPaused: true }, executor: { address: address(6), fromBlock: '1' },
    policy: { intervalMs: 1000, runTimeoutMs: 5000, maxHeartbeatAgeMs: 10000, maxBlockAgeSeconds: 120, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false },
    approvedHistory: { file: prefix, sha256: hashBytes(original.bytes), anchorBlock: '2', anchorHash: hash(2) } };
  delete baseline.identity.manifestHash;
  const requests = [];
  const connection = { chainId: 5042002n, address: address(1), deployBlock: 1n, client: {
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 4n, hash: hash(Number(blockNumber ?? 4n)) }),
    getCode: async () => runtime,
    getLogs: async r => { requests.push([r.fromBlock, r.toBlock]); return [log(3)]; },
  } };
  return { dir, manifest, prefix, baseline, connection, requests, log, identity, original,
    run: () => captureHistoryExtension(connection, manifest, baseline),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('extension preserves approved events, scans complete suffix and grants no approval', async () => {
  const f = fixture(); try {
    const before = JSON.stringify(f.baseline), bytes = readFileSync(f.prefix);
    const c = await f.run();
    assert.deepEqual(f.requests, [[3n, 4n]]);
    assert.deepEqual(c.parsed.logs[0], f.original.parsed.logs[0]);
    assert.equal(c.parsed.logs.length, 2);
    assert.equal(c.provenance.previousDigest, hashBytes(bytes));
    assert.equal(c.provenance.approved, false);
    assert.equal(c.provenance.configurationChanged, false);
    assert.equal(c.provenance.transactionsSent, 0);
    assert.equal(JSON.stringify(f.baseline), before);
    assert.deepEqual(readFileSync(f.prefix), bytes);
    validateApprovedBytes(c.bytes, c.sha256, f.identity);
    const comparison = compareHistoryRenewal({ approvedBytes: bytes, approvedDigest: hashBytes(bytes), identity: f.identity,
      firstBytes: c.bytes, secondBytes: (await f.run()).bytes });
    assert.equal(comparison.comparisonPassed, true);
  } finally { f.cleanup(); }
});

test('initial capture cannot be replaced by extension without a protected binding', async () => {
  const f = fixture(); try {
    delete f.baseline.approvedHistory;
    await assert.rejects(f.run(), /existing approved history/);
    assert.deepEqual(f.requests, []);
  } finally { f.cleanup(); }
});

test('altered prefix and a forged baseline identity are refused before scanning', async () => {
  const f = fixture(); try {
    const forged = structuredClone(f.baseline); forged.identity.address = address(20);
    await assert.rejects(captureHistoryExtension(f.connection, f.manifest, forged), /differs/);
    writeFileSync(f.prefix, JSON.stringify({ ...f.original.parsed, logs: [] }));
    await assert.rejects(f.run(), /digest/);
    assert.deepEqual(f.requests, []);
  } finally { f.cleanup(); }
});

test('connection identity and runtime must match the pinned deployment', async () => {
  const f = fixture(); try {
    await assert.rejects(captureHistoryExtension({ ...f.connection, chainId: 1n }, f.manifest, f.baseline), /differs/);
    f.connection.client.getCode = async () => '0x6001';
    await assert.rejects(f.run(), /Runtime differs/);
    assert.deepEqual(f.requests, []);
  } finally { f.cleanup(); }
});

test('unchanged or older finalized head cannot renew the anchor', async () => {
  const f = fixture(); try {
    f.connection.client.getBlock = async () => ({ number: 2n, hash: hash(2) });
    await assert.rejects(f.run(), /must advance/);
  } finally { f.cleanup(); }
});

test('any unavailable suffix range aborts the entire extension', async () => {
  const f = fixture(); try {
    f.connection.client.getBlock = async ({ blockNumber }) => ({ number: blockNumber ?? 12000n, hash: hash(Number(blockNumber ?? 12000n)) });
    f.connection.client.getLogs = async r => {
      f.requests.push([r.fromBlock, r.toBlock]);
      if (r.fromBlock > 3n) throw Error('quota exceeded');
      return [f.log(3)];
    };
    await assert.rejects(f.run(), /log scan incomplete/);
    assert.deepEqual(f.requests, [[3n, 5002n], [5003n, 10002n]]);
    assert.deepEqual(readFileSync(f.prefix), f.original.bytes);
  } finally { f.cleanup(); }
});

test('old anchor reorganisation is refused', async () => {
  const f = fixture(); try {
    const get = f.connection.client.getBlock;
    f.connection.client.getBlock = async r => r.blockNumber === 2n ? { number: 2n, hash: hash(22) } : get(r);
    await assert.rejects(f.run(), /reorganized/);
  } finally { f.cleanup(); }
});

test('noncanonical suffix event and a changed final anchor are refused', async () => {
  const f = fixture(); try {
    f.connection.client.getLogs = async () => [{ ...f.log(3), blockHash: hash(33) }];
    await assert.rejects(f.run(), /Suffix event block is not canonical/);
    f.connection.client.getLogs = async () => [f.log(3)];
    const get = f.connection.client.getBlock;
    f.connection.client.getBlock = async r => r.blockNumber === 4n ? { number: 4n, hash: hash(44) } : get(r);
    await assert.rejects(f.run(), /Extension anchor changed/);
  } finally { f.cleanup(); }
});

test('manifest replacement during capture is refused', async () => {
  const f = fixture(); try {
    f.connection.client.getLogs = async () => {
      const manifest = JSON.parse(readFileSync(f.manifest)); manifest.checkedAt = 'changed';
      writeFileSync(f.manifest, JSON.stringify(manifest));
      return [f.log(3)];
    };
    await assert.rejects(f.run(), /Manifest changed/);
  } finally { f.cleanup(); }
});
