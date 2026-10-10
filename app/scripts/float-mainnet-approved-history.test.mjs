import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, decodeEventLog } from 'viem';
import { floatEventAbi } from './float-mainnet-config.mjs';
import { buildNormalizedContent, hashBytes } from './float-mainnet-history-validation.mjs';
import { approvedHistoryIdentity, discoverApprovedHistory, validateConfiguredHistory } from './float-mainnet-approved-history.mjs';
import { validateBaseline, evaluateSnapshot } from './float-mainnet-monitor-policy.mjs';
import { loadContext } from './float-mainnet-monitor-runner.mjs';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-approved-history-'));
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ ok: true, chainId: '5042', contract: { address: addr(1) },
    bytecode: { onchainRuntimeKeccak256: hash(1) }, deployment: { blockNumber: '1' } }));
  const identity = approvedHistoryIdentity(manifestPath);
  const log = (allowed, index) => ({ address: addr(1), blockNumber: 2n, blockHash: hash(2), transactionHash: hash(10 + index),
    transactionIndex: index, logIndex: index, removed: false,
    topics: encodeEventTopics({ abi: floatEventAbi, eventName: 'OperatorSet', args: { operator: addr(99) } }),
    data: encodeAbiParameters([{ type: 'bool' }], [allowed]) });
  const original = buildNormalizedContent([log(true, 0), log(false, 1)], identity, { blockNumber: '2', blockHash: hash(2) });
  const file = join(directory, 'prefix.json');
  writeFileSync(file, original.bytes);
  const history = { file, sha256: hashBytes(original.bytes), anchorBlock: '2', anchorHash: hash(2) };
  const requests = [];
  const connection = { chainId: 5042n, address: addr(1), deployBlock: 1n, client: {
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 3n, hash: hash(Number(blockNumber ?? 3n)) }),
    getLogs: async request => { requests.push([request.fromBlock, request.toBlock]); return []; },
  } };
  const values = { manifest: manifestPath, 'approved-history': file, 'approved-history-digest': history.sha256 };
  const baseline = { schemaVersion: 1, identity: { chainId: '5042', address: addr(1), runtimeCodeHash: hash(1), deployBlock: '1', usdc: addr(8) },
    owner: addr(2), operators: [], sponsors: [], lines: [], effectiveLimits: { protocolReserve: '100', lineReserve: '100', lineSpend: '100', perSpend: '50', dailySpend: '100' },
    pauses: { openingsPaused: true, spendsPaused: true }, executor: { address: addr(6), fromBlock: '1' },
    policy: { intervalMs: 1000, runTimeoutMs: 5000, maxHeartbeatAgeMs: 10000, maxBlockAgeSeconds: 120, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false }, approvedHistory: history };
  return { directory, manifestPath, identity, history, values, baseline, original, requests, connection,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('default discovery still replays the original deployment range', async () => {
  const f = fixture(); try {
    const result = await discoverApprovedHistory(f.connection, { number: 3n, hash: hash(3) });
    assert.deepEqual(f.requests, [[1n, 3n]]);
    assert.equal(result.approvedHistory, undefined);
  } finally { f.cleanup(); }
});

test('protected prefix keeps transient roles and requests every suffix block', async () => {
  const f = fixture(); try {
    const result = await discoverApprovedHistory(f.connection, { number: 3n, hash: hash(3) }, f.values);
    assert.deepEqual(f.requests, [[3n, 3n]]);
    assert.deepEqual(result.scanned, { fromBlock: 1n, toBlock: 3n });
    const events = result.logs.map(log => decodeEventLog({ abi: floatEventAbi, data: log.data, topics: log.topics }));
    assert.deepEqual(events.map(event => event.args.allowed), [true, false]);
    const now = 1_800_000_000_000;
    const snapshot = { ok: true, identity: f.baseline.identity, observedAt: { blockNumber: '3', blockHash: hash(3), timestamp: String(now / 1000) },
      contract: { address: addr(1), owner: addr(2), pendingOwner: addr(0), ...f.baseline.pauses, effectiveLimits: f.baseline.effectiveLimits,
        pendingCapIncreases: [], operators: [{ operator: addr(99), enabled: false, set: events.map(event => ({ allowed: event.args.allowed, blockNumber: '2' })) }], totalSponsorObligations: '0', totalCommittedCapital: '0' },
      sponsors: [], lines: [], alerts: [], discovery: { lines: 0, scanned: { fromBlock: '1', toBlock: '3' }, index: null, approvedHistory: result.approvedHistory },
      accounting: { ok: true, balance: '0', checks: ['balanceCoversObligations', 'obligationsEqualLines', 'committedCapitalEqualsLines', 'linesMatchReserveCap'].map(id => ({ id, status: 'PASS' })) },
      executionAudit: { fromBlock: '1', toBlock: '3', executions: [] } };
    assert.ok(evaluateSnapshot(f.baseline, snapshot, now).alerts.some(alert => alert.code === 'OPERATOR_DRIFT'));
    const unapproved = structuredClone(f.baseline); delete unapproved.approvedHistory;
    assert.ok(evaluateSnapshot(unapproved, snapshot, now).alerts.some(alert => alert.code === 'HISTORY_UNAPPROVED'));
  } finally { f.cleanup(); }
});

test('context rejects a modified approved file before any spending lookup', () => {
  const f = fixture(); try {
    const baselinePath = join(f.directory, 'baseline.json'); writeFileSync(baselinePath, JSON.stringify(f.baseline));
    loadContext({ baselinePath, manifestPath: f.manifestPath, stateDir: join(f.directory, 'state') });
    const changed = JSON.parse(f.original.bytes); changed.logs = [];
    writeFileSync(f.history.file, JSON.stringify(changed));
    assert.throws(() => loadContext({ baselinePath, manifestPath: f.manifestPath, stateDir: join(f.directory, 'state') }), /digest/);
    assert.deepEqual(f.requests, []);
  } finally { f.cleanup(); }
});

test('an orphaned intermediate suffix block is refused before policy sees its role change', async () => {
  const f = fixture(); try {
    f.connection.client.getLogs = async request => [{ ...f.original.parsed.logs[0],
      blockNumber: 3n, blockHash: hash(333), transactionHash: hash(333), transactionIndex: 0, logIndex: 0 }];
    await assert.rejects(discoverApprovedHistory(f.connection, { number: 4n, hash: hash(4) }, f.values), /Suffix event block is not canonical/);
  } finally { f.cleanup(); }
});

test('canonical intermediate suffix logs remain part of complete discovery', async () => {
  const f = fixture(); try {
    f.connection.client.getLogs = async request => [{ ...f.original.parsed.logs[0],
      blockNumber: 3n, blockHash: hash(3), transactionHash: hash(333), transactionIndex: 0, logIndex: 0 }];
    const result = await discoverApprovedHistory(f.connection, { number: 4n, hash: hash(4) }, f.values);
    assert.equal(result.logs.length, 3);
    assert.equal(result.logs[2].blockHash, hash(3));
    assert.deepEqual(result.scanned, { fromBlock: 1n, toBlock: 4n });
  } finally { f.cleanup(); }
});

test('wrong manifest or declared anchor cannot reuse an approved prefix', () => {
  const f = fixture(); try {
    assert.throws(() => validateConfiguredHistory({ ...f.baseline, approvedHistory: { ...f.history, anchorBlock: '3' } }, f.manifestPath), /anchor differs/);
    const manifest = JSON.parse(requireManifest(f.manifestPath)); manifest.chainId = '1';
    writeFileSync(f.manifestPath, JSON.stringify(manifest));
    assert.throws(() => validateConfiguredHistory(f.baseline, f.manifestPath), /differs/);
  } finally { f.cleanup(); }
});

test('invalid optional binding is rejected instead of silently choosing full replay', () => {
  const f = fixture(); try {
    for (const value of [null, false, {}, { ...f.history, file: 'relative.json' }, { ...f.history, sha256: 'not-approved' }])
      assert.throws(() => validateBaseline({ ...f.baseline, approvedHistory: value }));
  } finally { f.cleanup(); }
});

// Read only fixture helper; no live chain or wallet is used.
import { readFileSync as requireManifest } from 'node:fs';
