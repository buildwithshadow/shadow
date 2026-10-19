import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { digestJson } from './float-mainnet-monitor-policy.mjs';
import { validateBaseline } from './float-mainnet-monitor-public-policy.mjs';

const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// Advisory telemetry only. This never authorizes a payment, approves history,
// changes a baseline, or acknowledges an incident. Failed cycles are retained.
export function maintenanceReport({ baseline, events, nowMs = Date.now() }) {
  const b = validateBaseline(baseline);
  const baselineHash = digestJson(b);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Array.isArray(events) || events.length > 200)
    throw new Error('Invalid clock or bounded event journal');
  const rows = events.filter(e => {
    if (e?.baselineHash !== baselineHash) return false;
    // The runner also journals hold acknowledgements. They are not scans and
    // must not consume the twenty-cycle window or erase earlier failures.
    if (Object.keys(e).sort().join(',') === 'acknowledgedAt,baselineHash,incidentId' &&
        canonicalTime(e.acknowledgedAt) && Date.parse(e.acknowledgedAt) >= 0 &&
        Date.parse(e.acknowledgedAt) <= nowMs && uuid(e.incidentId)) return false;
    return true; // Unknown or malformed matching records fail validation below.
  }).slice(-20);
  const seen = new Set();
  let previous = -1;
  const durations = [];
  for (const row of rows) {
    const end = Date.parse(row.completedAt);
    if (!uuid(row.runId) || seen.has(row.runId) || !canonicalTime(row.completedAt) ||
        end < previous || end > nowMs || typeof row.ok !== 'boolean' || typeof row.hold !== 'boolean')
      throw new Error('Invalid, duplicated, future or unordered journal sample');
    seen.add(row.runId); previous = end;
    // Older journal entries did not record start time. Do not fabricate it.
    if (row.startedAt !== undefined) {
      const start = Date.parse(row.startedAt);
      if (!canonicalTime(row.startedAt) || start > end || start < 0)
        throw new Error('Invalid journal start time');
      durations.push(end - start);
    }
  }
  const stale = !rows.length || nowMs - previous > b.policy.maxHeartbeatAgeMs;
  const failedCycles = rows.filter(row => !row.ok || row.hold).length;
  const maxDurationMs = durations.length ? Math.max(...durations) : null;
  const thresholdMs = Math.ceil(b.policy.runTimeoutMs * 0.75);
  const pressure = maxDurationMs !== null && maxDurationMs >= thresholdMs;
  const reasons = [
    ...(stale ? ['NO_RECENT_JOURNAL_SAMPLE'] : []),
    ...(failedCycles ? ['RECENT_FAILED_OR_HELD_CYCLES'] : []),
    ...(pressure ? ['SCAN_TIME_MARGIN_LOW'] : []),
    ...(durations.length < 3 ? ['INSUFFICIENT_TIMING_SAMPLES'] : []),
  ];
  return {
    kind: 'ShadowMonitorMaintenanceAdvisory', authoritative: false,
    chainId: b.identity.chainId, address: b.identity.address, baselineHash,
    status: stale || failedCycles ? 'investigate' : pressure ? 'maintenance-recommended' :
      durations.length < 3 ? 'insufficient-data' : 'no-pressure-observed',
    reasons, samples: rows.length, timingSamples: durations.length, failedCycles,
    latestCompletedAt: rows.at(-1)?.completedAt ?? null,
    runTimeoutMs: b.policy.runTimeoutMs, thresholdMs, maxDurationMs,
    minimumObservedMarginMs: maxDurationMs === null ? null : b.policy.runTimeoutMs - maxDurationMs,
    approvedAnchorBlock: b.approvedHistory?.anchorBlock ?? null,
    action: 'Inspect RPC latency and history suffix growth. Prepare independently captured history renewal when needed. Keep the existing timeout and admission checks unchanged.',
    limitations: 'Recent local telemetry only. Not a live health check or a prediction of future capacity. Does not establish the cause of slow scans.',
    transactionsSent: 0, configurationChanged: false,
  };
}

function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    baseline: { type: 'string' }, events: { type: 'string' },
  } });
  if (!values.baseline || !values.events) throw new Error('--baseline and --events are required');
  const report = maintenanceReport({ baseline: JSON.parse(readFileSync(values.baseline, 'utf8')),
    events: JSON.parse(readFileSync(values.events, 'utf8')) });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'no-pressure-observed' ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`Maintenance report failed: ${error.message}`); process.exitCode = 1; }
}
