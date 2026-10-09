import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GUARDED_TESTNET as deployment } from '../guardedTestnetDeployment.mjs';
import { runMonitorOnce, acknowledgeHold } from './float-mainnet-monitor-runner.mjs';
import { loadMainnetContext, notificationState, notifyMainnet, loadGuardedTestnetContext, guardedTestnetNotificationState, notifyGuardedTestnet } from './float-mainnet-monitor-alerts.mjs';

const now = 1800000000000;
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-guarded-testnet-alerts-'));
  const identity = { chainId: String(deployment.chainId), address: deployment.address.toLowerCase(), runtimeCodeHash: deployment.runtimeHash,
    usdc: deployment.usdc, deployBlock: String(deployment.deployBlock) };
  const limits = { protocolReserve: '100000', lineReserve: '100000', lineSpend: '5000', perSpend: '5000', dailySpend: '5000' };
  const baseline = { schemaVersion: 1, identity, owner: addr(2), operators: [], sponsors: [], effectiveLimits: limits,
    pauses: { openingsPaused: true, spendsPaused: true }, lines: [], executor: { address: addr(3), fromBlock: identity.deployBlock },
    policy: { intervalMs: 1000, runTimeoutMs: 5000, maxHeartbeatAgeMs: 10000, maxBlockAgeSeconds: 120, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false } };
  const manifest = { ok: true, chainId: identity.chainId, contract: { address: identity.address }, bytecode: { onchainRuntimeKeccak256: identity.runtimeCodeHash }, deployment: { blockNumber: identity.deployBlock } };
  const options = { baselinePath: join(dir, 'baseline.json'), manifestPath: join(dir, 'manifest.json'), stateDir: join(dir, 'observer') };
  const write = () => { writeFileSync(options.baselinePath, JSON.stringify(baseline)); writeFileSync(options.manifestPath, JSON.stringify(manifest)); };
  write(); const context = loadGuardedTestnetContext(options);
  const block = String(deployment.deployBlock + 100n);
  const snapshot = { ok: true, identity, observedAt: { blockNumber: block, blockHash: hash(100), timestamp: String(now / 1000) },
    contract: { address: identity.address, owner: baseline.owner, pendingOwner: addr(0), ...baseline.pauses, effectiveLimits: limits, pendingCapIncreases: [], operators: [], totalSponsorObligations: '0', totalCommittedCapital: '0' },
    sponsors: [], discovery: { lines: 0, scanned: { fromBlock: identity.deployBlock, toBlock: block }, index: null }, lines: [], alerts: [],
    accounting: { ok: true, balance: '0', checks: ['balanceCoversObligations', 'obligationsEqualLines', 'committedCapitalEqualsLines', 'linesMatchReserveCap'].map(id => ({ id, status: 'PASS' })) },
    executionAudit: { fromBlock: identity.deployBlock, toBlock: block, executions: [] } };
  return { dir, context, baseline, manifest, options, snapshot, write, run: (time = now, collect = async () => snapshot) => runMonitorOnce(context, { now: () => time, collect }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('guarded notifier pins network, deployment, runtime and token while mainnet entrypoints reject it', async () => {
  const f = fixture();
  try {
    assert.throws(() => loadMainnetContext(f.options), /MAINNET_BINDING_REQUIRED/);
    assert.throws(() => notificationState(f.context, now), /MAINNET_ONLY/);
    await assert.rejects(notifyMainnet({ context: f.context, destinationId: '-123', now, send: async () => assert.fail(), save: async () => assert.fail() }), /MAINNET_ONLY/);
    for (const [field, value] of [['chainId', '5042'], ['chainId', '1'], ['address', addr(7)], ['runtimeCodeHash', hash(7)], ['usdc', addr(8)], ['deployBlock', '10']]) {
      const context = structuredClone(f.context); context.baseline.identity[field] = value;
      assert.throws(() => guardedTestnetNotificationState(context, now), /GUARDED_TESTNET_BINDING_REQUIRED/);
      const original = f.baseline.identity[field]; f.baseline.identity[field] = value; f.write();
      assert.throws(() => loadGuardedTestnetContext(f.options));
      f.baseline.identity[field] = original; f.write();
    }
    for (const mutate of [m => m.chainId = '5042', m => m.contract.address = addr(7), m => m.bytecode.onchainRuntimeKeccak256 = hash(7), m => m.deployment.blockNumber = '10']) {
      const bad = structuredClone(f.manifest); mutate(bad); writeFileSync(f.options.manifestPath, JSON.stringify(bad));
      assert.throws(() => loadGuardedTestnetContext(f.options));
    }
  } finally { f.cleanup(); }
});

test('testnet notification requires fresh bound accounting and only announces recovery after acknowledgement', async () => {
  const f = fixture(); let previous; const messages = [];
  const notify = time => notifyGuardedTestnet({ context: f.context, previous, destinationId: '-123', now: time, send: async text => messages.push(text), save: async value => { previous = value; } });
  try {
    await f.run(); await notify(now); await notify(now);
    assert.equal(messages.length, 1); assert.match(messages[0], /Arc TESTNET monitor/); assert.doesNotMatch(messages[0], /MAINNET/);
    await f.run(now + 1, async () => { throw Error('private rpc URL'); }); await notify(now + 1); await notify(now + 1);
    assert.equal(messages.length, 2); assert.match(messages[1], /ATTENTION/); assert.doesNotMatch(messages[1], /private rpc URL/);
    const recovered = await f.run(now + 2); await notify(now + 2); assert.doesNotMatch(messages.at(-1), /RECOVERED/);
    const beforeAcknowledgement = messages.length;
    acknowledgeHold(f.context, recovered.incidentId, now + 2); await notify(now + 2); await notify(now + 2);
    assert.match(messages.at(-1), /RECOVERED/); assert.equal(messages.length, beforeAcknowledgement + 1);
    assert.equal(guardedTestnetNotificationState(f.context, now + 10003).ok, false);
    writeFileSync(join(f.context.stateDir, 'snapshot.json'), '{}');
    assert.ok(guardedTestnetNotificationState(f.context, now + 2).codes.includes('SNAPSHOT_BINDING_MISMATCH'));
  } finally { f.cleanup(); }
});

test('ordinary testnet scans stay quiet and a previously notified hold does not generate alternating alerts', async () => {
  const f = fixture(); let previous; let finish; const messages = [];
  const notify = time => notifyGuardedTestnet({ context: f.context, previous, destinationId: '-123', now: time, send: async text => messages.push(text), save: async value => { previous = value; } });
  async function start(time) {
    let entered; const began = new Promise(resolve => { entered = resolve; });
    const pending = f.run(time, async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
    await began; return { pending };
  }
  try {
    const first = await start(now); assert.equal((await notify(now)).reason, 'scan-in-progress');
    finish(f.snapshot); await first.pending;
    await f.run(now + 1, async () => { throw Error('offline'); }); await notify(now + 1);
    await f.run(now + 2); await notify(now + 2);
    const count = messages.length; const second = await start(now + 3);
    assert.equal((await notify(now + 3)).reason, 'known-incident-scan-in-progress'); assert.equal(messages.length, count);
    finish(f.snapshot); await second.pending; await notify(now + 3); assert.equal(messages.length, count);
  } finally { f.cleanup(); }
});

test('failed Telegram delivery does not suppress retries or six hour failure reminders', async () => {
  const f = fixture(); let previous; let sent = 0;
  const options = time => ({ context: f.context, previous, destinationId: '-123', now: time, send: async () => { sent++; }, save: async value => { previous = value; } });
  try {
    await assert.rejects(notifyGuardedTestnet({ ...options(now), send: async () => { throw Error('offline'); }, save: async () => assert.fail() }));
    await notifyGuardedTestnet(options(now)); await notifyGuardedTestnet(options(now)); assert.equal(sent, 1);
    await notifyGuardedTestnet(options(now + 21600000)); assert.equal(sent, 2);
  } finally { f.cleanup(); }
});

test('CLI flushes the delivery record and directory before exit; failed file flush preserves prior state', async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    try {
      await f.run(Date.now());
      const state = join(f.dir, 'notifications'); mkdirSync(state);
      const original = JSON.stringify({ destinationId: '456', binding: 'old', key: 'healthy', sentAt: new Date(now).toISOString() });
      const saved = join(state, 'notification.json'); writeFileSync(saved, original);
      const events = join(f.dir, 'flush-events.jsonl');
      const stub = join(f.dir, 'durability-stub.mjs');
      const config = join(f.dir, 'telegram.json'); writeFileSync(config, JSON.stringify({ token: '123:fake', chatId: '456' }));
      writeFileSync(stub, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const record = event => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(event)+'\\n');
const flush = fs.fsyncSync, rename = fs.renameSync;
fs.fsyncSync = fd => {
  const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
  record('flush:'+kind);
  if (${fail} && kind === 'file') throw Error('injected file flush failure');
  return flush(fd);
};
fs.renameSync = (...args) => { record('rename'); return rename(...args); };
syncBuiltinESMExports();
globalThis.fetch = async () => { record('delivery'); return { ok:true, json:async()=>({ok:true,result:{chat:{id:456}}}) }; };
`);
      const child = spawnSync(process.execPath, ['--import', stub, fileURLToPath(new URL('./guarded-testnet-monitor-alerts.mjs', import.meta.url)),
        '--baseline', f.options.baselinePath, '--manifest', f.options.manifestPath, '--observer-dir', f.options.stateDir, '--state-dir', state, '--config', config],
      { encoding: 'utf8', timeout: 10000 });
      const observed = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse);
      if (fail) {
        assert.equal(child.status, 1, child.stdout + child.stderr);
        assert.deepEqual(observed, ['delivery', 'flush:file']);
        assert.equal(readFileSync(saved, 'utf8'), original);
      } else {
        assert.equal(child.status, 0, child.stdout + child.stderr);
        assert.deepEqual(observed, ['delivery', 'flush:file', 'rename', 'flush:directory']);
        assert.equal(JSON.parse(readFileSync(saved)).destinationId, '456');
      }
      assert.ok(!readdirSync(state).some(name => name.endsWith('.tmp')));
    } finally { f.cleanup(); }
  }
});
