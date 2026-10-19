import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceReport } from './float-mainnet-maintenance-report.mjs';
import { digestJson } from './float-mainnet-monitor-policy.mjs';
import { validateBaseline } from './float-mainnet-monitor-public-policy.mjs';
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const nowMs = 1800000000000;
const baseline = validateBaseline({ schemaVersion: 2,
  identity: { chainId:'5042', address:addr(1), runtimeCodeHash:hash(1), usdc:addr(8), deployBlock:'10' },
  owner:addr(2), operators:[], sponsors:[], lines:[],
  effectiveLimits:{ protocolReserve:'100', lineReserve:'10', lineSpend:'5', perSpend:'5', dailySpend:'5' },
  pauses:{ openingsPaused:true, spendsPaused:true }, executor:{address:addr(9), fromBlock:'10'},
  policy:{ intervalMs:60000, runTimeoutMs:45000, maxHeartbeatAgeMs:120000,
    maxBlockAgeSeconds:120, maxIndexLagSeconds:120, warnBeforeSeconds:3600, requireIndex:false },
  publicAdmission:{ minimumRepaymentWindow:'3600', maximumRepaymentWindow:'86400' },
});
const row = (i, duration = 20000) => ({ runId:`00000000-0000-4000-8000-${String(100+i).padStart(12,'0')}`, baselineHash:digestJson(baseline),
  startedAt:new Date(nowMs - (3-i)*60000-duration).toISOString(),
  completedAt:new Date(nowMs - (3-i)*60000).toISOString(), ok:true, hold:false });
const report = events => maintenanceReport({baseline,events,nowMs});
test('normal timing is advisory, not a health or authorization claim', () => {
  const r=report([row(1),row(2),row(3)]);
  assert.equal(r.status,'no-pressure-observed'); assert.equal(r.authoritative,false);
  assert.equal(r.minimumObservedMarginMs,25000); assert.equal(r.configurationChanged,false);
});
test('one slow sample triggers maintenance even when the latest is fast', () => {
  const r=report([row(1,37000),row(2),row(3)]);
  assert.equal(r.status,'maintenance-recommended'); assert.equal(r.minimumObservedMarginMs,8000);
});
test('warning threshold is inclusive and does not change timeout', () => {
  const r=report([row(1,33750),row(2),row(3)]);
  assert.equal(r.status,'maintenance-recommended'); assert.equal(r.runTimeoutMs,45000);
});
test('failed cycles cannot disappear into healthy timing averages', () => {
  const r=report([{...row(1,46000),ok:false,hold:true},row(2),row(3)]);
  assert.equal(r.status,'investigate'); assert.equal(r.failedCycles,1);
  assert.equal(r.minimumObservedMarginMs,-1000);
});
test('missing, stale and old format records are not adequate timing evidence', () => {
  assert.equal(report([]).status,'investigate');
  assert.equal(report([row(0)]).status,'investigate');
  const old=row(3); delete old.startedAt;
  assert.equal(report([old]).status,'insufficient-data');
  assert.equal(report([old]).maxDurationMs,null);
});
test('does not combine records from different approved baselines', () => {
  assert.equal(report([{...row(3),baselineHash:hash(99)}]).samples,0);
});
test('rejects duplicate, future, inverted and unordered timestamps', () => {
  for (const events of [[row(1),row(1)], [row(4)], [row(3,-1)], [row(3),row(2)]])
    assert.throws(()=>report(events));
});
test('only the latest twenty matching records contribute and inputs stay unchanged', () => {
  const events=Array.from({length:25},(_,i)=>row(i-21,i===0?44000:20000));
  const before=JSON.stringify(events); const r=report(events);
  assert.equal(r.samples,20); assert.equal(r.maxDurationMs,20000);
  assert.equal(JSON.stringify(events),before);
});
test('rejects malformed or oversized journals and invalid clocks', () => {
  assert.throws(()=>report({})); assert.throws(()=>report(Array(201).fill(row(3))));
  assert.throws(()=>maintenanceReport({baseline,events:[],nowMs:NaN}));
});
test('hold acknowledgements do not count as cycles or hide recent failures', () => {
  const acknowledgement = { baselineHash:digestJson(baseline), acknowledgedAt:new Date(nowMs).toISOString(),
    incidentId:'12345678-1234-4234-8234-123456789abc' };
  const events=[{...row(1),ok:false,hold:true},row(2),row(3),acknowledgement];
  const r=report(events);
  assert.equal(r.samples,3); assert.equal(r.timingSamples,3);
  assert.equal(r.failedCycles,1); assert.equal(r.status,'investigate');
  assert.equal(report([row(1),row(2),row(3),acknowledgement]).status,'no-pressure-observed');
  assert.equal(report([acknowledgement]).status,'investigate');
  assert.throws(()=>report([{...acknowledgement,runId:'malformed'}]));
});
test('corrupted acknowledgement values cannot be filtered out of healthy samples', () => {
  const good = { baselineHash:digestJson(baseline), acknowledgedAt:new Date(nowMs).toISOString(),
    incidentId:'12345678-1234-4234-8234-123456789abc' };
  for (const bad of [
    {...good,acknowledgedAt:'2026-01-01'}, {...good,incidentId:'-'.repeat(36)},
    {...good,acknowledgedAt:new Date(nowMs+1).toISOString()},
    {...good,incidentId:'12345678-1234-1234-8234-123456789abc'},
    {...good,acknowledgedAt:'invalid'},
  ]) assert.throws(()=>report([row(1),row(2),row(3),bad]));
});
test('cycle IDs and timestamps must use the runner canonical format', () => {
  for (const bad of [
    {...row(3),runId:'not-a-run'}, {...row(3),completedAt:'2026-01-01'},
    {...row(3),startedAt:'2026-01-01'},
  ]) assert.throws(()=>report([row(1),row(2),bad]));
});

test('accepts a fixed testnet baseline without applying public mainnet admission', () => {
  const {publicAdmission,...fixed}=baseline;
  const b=validateBaseline({...fixed,schemaVersion:1,identity:{...fixed.identity,chainId:'5042002'}});
  const events=[row(1),row(2),row(3)].map(e=>({...e,baselineHash:digestJson(b)}));
  assert.equal(maintenanceReport({baseline:b,events,nowMs}).status,'no-pressure-observed');
});
