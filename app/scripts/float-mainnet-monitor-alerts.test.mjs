import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeHold, runMonitorOnce } from './float-mainnet-monitor-runner.mjs';
import { loadMainnetContext, notificationState, notifyMainnet } from './float-mainnet-monitor-alerts.mjs';

const now = 1800000000000;
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-mainnet-alerts-'));
  const limits = { protocolReserve: '100', lineReserve: '100', lineSpend: '100', perSpend: '50', dailySpend: '100' };
  const identity = { chainId: '5042', address: addr(1), runtimeCodeHash: hash(1), usdc: '0x3600000000000000000000000000000000000000', deployBlock: '10' };
  const baseline = { schemaVersion: 1, identity, owner: addr(2), operators: [], sponsors: [], effectiveLimits: limits,
    pauses: { openingsPaused: true, spendsPaused: true }, lines: [], executor: { address: addr(3), fromBlock: '10' },
    policy: { intervalMs: 1000, runTimeoutMs: 5000, maxHeartbeatAgeMs: 10000, maxBlockAgeSeconds: 120, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false } };
  const manifest = { ok: true, chainId: '5042', contract: { address: addr(1) }, bytecode: { onchainRuntimeKeccak256: hash(1) }, deployment: { blockNumber: '10' } };
  const options = { baselinePath: join(directory, 'baseline.json'), manifestPath: join(directory, 'manifest.json'), stateDir: join(directory, 'state') };
  writeFileSync(options.baselinePath, JSON.stringify(baseline)); writeFileSync(options.manifestPath, JSON.stringify(manifest));
  const context = loadMainnetContext(options);
  const snapshot = { ok: true, identity, observedAt: { blockNumber: '100', blockHash: hash(100), timestamp: String(now / 1000) },
    contract: { address: addr(1), owner: addr(2), pendingOwner: addr(0), ...baseline.pauses, effectiveLimits: limits, pendingCapIncreases: [], operators: [], totalSponsorObligations: '0', totalCommittedCapital: '0' },
    sponsors: [], discovery: { lines: 0, scanned: { fromBlock: '10', toBlock: '100' }, index: null }, lines: [], alerts: [],
    accounting: { ok: true, balance: '0', checks: ['balanceCoversObligations', 'obligationsEqualLines', 'committedCapitalEqualsLines', 'linesMatchReserveCap'].map(id => ({ id, status: 'PASS' })) },
    executionAudit: { fromBlock: '10', toBlock: '100', executions: [] } };
  return { context, snapshot, options, manifest, baseline, cleanup: () => rmSync(directory, { recursive: true, force: true }),
    run: (time = now, collect = async () => snapshot) => runMonitorOnce(context, { now: () => time, collect }) };
}

test('mainnet alerts bind manifest to approved deployment and reject testnet/mismatched files', () => {
  const f = fixture();
  try {
    for (const mutate of [m => m.ok = false, m => m.chainId = '5042002', m => m.contract.address = addr(7), m => m.bytecode.onchainRuntimeKeccak256 = hash(7), m => m.deployment.blockNumber = '11']) {
      const m = structuredClone(f.manifest); mutate(m); writeFileSync(f.options.manifestPath, JSON.stringify(m));
      assert.throws(() => loadMainnetContext(f.options));
    }
    f.baseline.identity.chainId = '5042002';
    writeFileSync(f.options.baselinePath, JSON.stringify(f.baseline));
    assert.throws(() => loadMainnetContext(f.options));
    assert.throws(() => notificationState({ ...f.context, baseline: f.baseline }, now), /MAINNET_ONLY/);
  } finally { f.cleanup(); }
});

test('missing, corrupt, stale and forged healthy state alerts through runner validation', async () => {
  const f = fixture();
  try {
    assert.equal(notificationState(f.context, now).ok, false);
    await f.run(); assert.equal(notificationState(f.context, now).ok, true);
    assert.equal(notificationState(f.context, now + 10001).ok, false);
    writeFileSync(join(f.context.stateDir, 'snapshot.json'), '{}');
    assert.ok(notificationState(f.context, now).codes.includes('SNAPSHOT_BINDING_MISMATCH'));
    writeFileSync(join(f.context.stateDir, 'heartbeat.json'), '{');
    assert.equal(notificationState(f.context, now).ok, false);
  } finally { f.cleanup(); }
});

test('bounded check is quiet but release drift, stale check and latched hold are never suppressed', async () => {
  const f = fixture(); let finish;
  try {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const running = f.run(now, async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
    await started;
    assert.equal(notificationState(f.context, now), null);
    assert.equal(notificationState(f.context, now + 5001).ok, false);
    assert.equal(notificationState({ ...f.context, manifestHash: 'changed' }, now).ok, false);
    writeFileSync(join(f.context.stateDir, 'hold.json'), JSON.stringify({ incidentId: 'existing-incident' }));
    assert.ok(notificationState(f.context, now).codes.includes('HOLD_LATCHED'));
    finish(f.snapshot); await running;
    assert.equal(notificationState(f.context, now).ok, false);
  } finally { f.cleanup(); }
});

test('failure persists across healthy scans; recovery notifies only after explicit acknowledgement', async () => {
  const f = fixture(); let previous; const messages = [];
  const notify = (time = now, context = f.context, destinationId = '-123') => notifyMainnet({ context, previous, destinationId, now: time,
    send: async m => messages.push(m), save: async p => { previous = p; } });
  try {
    await f.run(); await notify(); await notify(); assert.equal(messages.length, 1); assert.match(messages[0], /MAINNET.*CONNECTED/);
    await f.run(now + 1, async () => { throw Error('https://secret@rpc.invalid'); });
    await notify(now + 1); await notify(now + 1); assert.equal(messages.length, 2); assert.match(messages[1], /ATTENTION/);
    assert.doesNotMatch(messages[1], /secret|rpc.invalid/);
    const recovering = await f.run(now + 2);
    await notify(now + 2); assert.doesNotMatch(messages.at(-1), /RECOVERED/);
    acknowledgeHold(f.context, recovering.incidentId, now + 2);
    await notify(now + 2); assert.match(messages.at(-1), /RECOVERED/);
    const count = messages.length; await notify(now + 2); assert.equal(messages.length, count);
    await notify(now + 2, f.context, '-456'); assert.match(messages.at(-1), /CONNECTED/);
    await notify(now + 2, { ...f.context, manifestHash: 'different' }, '-456'); assert.match(messages.at(-1), /ATTENTION/);
  } finally { f.cleanup(); }
});

test('delivery failures retry, six-hour reminders recur, and changed failure codes notify immediately', async () => {
  const f = fixture(); let previous; let sent = 0;
  const notify = time => notifyMainnet({ context: f.context, previous, destinationId: '-123', now: time, send: async () => { sent++; }, save: async p => { previous = p; } });
  try {
    await assert.rejects(notifyMainnet({ context: f.context, destinationId: '-123', now, send: async () => { throw Error('offline'); }, save: async () => assert.fail('must not save') }));
    await notify(now); await notify(now); assert.equal(sent, 1);
    await notify(now + 21600000); assert.equal(sent, 2);
    await f.run(now, async () => { throw Error('offline'); });
    await notify(now); assert.equal(sent, 3);
    assert.deepEqual(readFileSync(join(f.context.stateDir, 'hold.json'), 'utf8').includes('secret'), false);
    await assert.rejects(notifyMainnet({ context: f.context, destinationId: 'invalid', send: async () => assert.fail(), save: async () => assert.fail() }));
  } finally { f.cleanup(); }
});
