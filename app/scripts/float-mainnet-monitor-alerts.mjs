// Read-only operational alerts. No signing, pause, spend or hold acknowledgement.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { heartbeatStatus, loadContext } from './float-mainnet-monitor-runner.mjs';
import { digestJson, evaluateSnapshot } from './float-mainnet-monitor-policy.mjs';
import { isEntrypoint } from './float-mainnet-preflight.mjs';
import { sendTelegram } from './public-testnet-observer-alerts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const optionalJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const optionalRecord = path => {
  let data;
  try { data = readFileSync(path, 'utf8'); }
  catch (error) { return { exists: error.code !== 'ENOENT', value: null }; }
  try { return { exists: true, value: JSON.parse(data) }; }
  catch { return { exists: true, value: null }; }
};

export function loadMainnetContext(options) {
  const context = loadContext(options);
  const manifestRaw = readFileSync(context.manifestPath);
  if (hash(manifestRaw) !== context.manifestHash) throw new Error('MANIFEST_CHANGED_DURING_LOAD');
  const manifest = JSON.parse(manifestRaw);
  const identity = context.baseline.identity;
  if (identity.chainId !== '5042' || String(manifest.chainId) !== '5042' ||
      identity.usdc !== '0x3600000000000000000000000000000000000000' ||
      manifest.contract?.address?.toLowerCase() !== identity.address ||
      manifest.bytecode?.onchainRuntimeKeccak256?.toLowerCase() !== identity.runtimeCodeHash ||
      String(manifest.deployment?.blockNumber) !== identity.deployBlock) throw new Error('MAINNET_BINDING_REQUIRED');
  return context;
}

export function notificationState(context, now = Date.now()) {
  if (context.baseline.identity.chainId !== '5042') throw new Error('MAINNET_ONLY');
  // Read the heartbeat around its snapshot/publication generation. A normal
  // two-file publication can finish between any of these reads.
  const holdPath = resolve(context.stateDir, 'hold.json');
  let raw, snapshot, publication, publicationExists, hold, holdExists, generationConsistent = false, generationMoved = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    raw = optionalJson(resolve(context.stateDir, 'heartbeat.json'));
    const publicationPath = resolve(context.stateDir, 'publication.json');
    const publicationRecord = optionalRecord(publicationPath);
    publicationExists = publicationRecord.exists;
    publication = publicationRecord.value;
    snapshot = optionalJson(resolve(context.stateDir, 'snapshot.json'));
    // A single read distinguishes absence from corruption without an
    // existence/read race. A later created hold belongs to the next sample.
    const holdRecord = optionalRecord(holdPath);
    holdExists = holdRecord.exists;
    hold = holdRecord.value;
    const afterPublication = optionalRecord(publicationPath);
    const after = optionalJson(resolve(context.stateDir, 'heartbeat.json'));
    const currentPublication = publication !== null && raw !== null && publication.runId === raw.runId && publication.startedAt === raw.startedAt;
    // With no hold, a valid bounded checking heartbeat remains non-authoritative
    // while its snapshot is being published. A held incident must bind data.
    const snapshotGenerationMatches = !holdExists || !currentPublication || publication.snapshotHash === null ||
      snapshot !== null && publication.snapshotHash === digestJson(snapshot);
    const recordsMatch = JSON.stringify(raw) === JSON.stringify(after) && JSON.stringify(publicationRecord) === JSON.stringify(afterPublication);
    generationMoved ||= !recordsMatch;
    if (recordsMatch && snapshotGenerationMatches) {
      generationConsistent = true;
      break;
    }
    raw = after;
  }
  const b = context.baseline;
  const identity = { schemaVersion: 1, kind: 'shadow-monitor-heartbeat', chainId: b.identity.chainId,
    address: b.identity.address, runtimeCodeHash: b.identity.runtimeCodeHash,
    baselineHash: context.baselineHash, manifestHash: context.manifestHash };
  const age = now - Date.parse(raw?.startedAt);
  // An ordinary bounded scan is quiet, but cannot mask a latched incident,
  // mismatched release, corrupt heartbeat or stopped/stuck runner.
  const incidentId = typeof hold?.incidentId === 'string' && /^[0-9a-f-]{36}$/.test(hold.incidentId) ? hold.incidentId : null;
  const checkingShape = Object.entries(identity).every(([key, value]) => raw?.[key] === value) &&
      raw.status === 'checking' && raw.ok === false && raw.hold === true &&
      typeof raw.startedAt === 'string' && Number.isFinite(Date.parse(raw.startedAt)) && new Date(Date.parse(raw.startedAt)).toISOString() === raw.startedAt &&
      raw.completedAt === null && raw.snapshotHash === null && raw.observedAt === null &&
      typeof raw.runId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.runId) &&
      (raw.previousSnapshotHash === null || typeof raw.previousSnapshotHash === 'string' && /^[0-9a-f]{64}$/.test(raw.previousSnapshotHash)) &&
      raw.checks?.snapshotHealthy === false &&
      Array.isArray(raw.alerts) && raw.alerts.length === 1 && raw.alerts[0]?.code === 'CHECK_IN_PROGRESS' &&
      raw.alerts[0]?.severity === 'critical' && typeof raw.alerts[0]?.detail === 'string';
  const boundedScan = checkingShape && age >= 0 && age <= b.policy.runTimeoutMs;
  // A known incident stays a failure during a normal bounded scan. Its
  // incomplete heartbeat is not a new incident or a recovery. Only notify an
  // already delivered incident again after its reminder deadline; completed
  // checks still validate snapshot, accounting and any newly failing codes.
  let completedSnapshotValid = false;
  let snapshotAlerts = [];
  let publishing = false;
  let publicationFresh = false;
  let publicationBound = false;
  let firstFailurePublication = false;
  let retainedNoSnapshotFailure = false;
  let acceptablePublication = !publicationExists;
  try {
    publishing = publication && publication.runId === raw?.runId &&
      publication.startedAt === raw?.startedAt &&
      Object.entries(identity).every(([key, value]) => publication[key] === value);
    completedSnapshotValid = snapshot !== null &&
      (raw?.previousSnapshotHash === digestJson(snapshot) || publishing && publication.snapshotHash === digestJson(snapshot));
    const validCodes = Array.isArray(publication?.alertCodes) && publication.alertCodes.every(code => typeof code === 'string' && /^[A-Z_0-9]{1,80}$/.test(code));
    publicationBound = checkingShape && publishing && validCodes && typeof publication.completedAt === 'string' &&
      Number.isFinite(Date.parse(publication.completedAt)) && new Date(Date.parse(publication.completedAt)).toISOString() === publication.completedAt &&
      (publication.snapshotHash === null || typeof publication.snapshotHash === 'string' && /^[0-9a-f]{64}$/.test(publication.snapshotHash)) &&
      (publication.snapshotHash !== null || publication.alertCodes.includes('RPC_CHECK_FAILED')) &&
      Date.parse(publication.completedAt) >= Date.parse(raw.startedAt) &&
      Date.parse(publication.completedAt) <= now;
    const priorPublicationBound = publication !== null && typeof raw?.previousPublicationHash === 'string' &&
      /^[0-9a-f]{64}$/.test(raw.previousPublicationHash) && raw.previousPublicationHash === digestJson(publication);
    acceptablePublication = !publicationExists || publicationBound || priorPublicationBound;
    publicationFresh = publicationBound && now - Date.parse(publication.completedAt) <= b.policy.runTimeoutMs;
    if (completedSnapshotValid) {
      snapshotAlerts = evaluateSnapshot(b, snapshot, now).alerts;
      if (publicationBound && publication.snapshotHash === digestJson(snapshot)) snapshotAlerts.push(...publication.alertCodes.map(code => ({code})));
    }
    // A first collection failure has no snapshot to bind. Preserve its real
    // failure and missing-snapshot codes while publishing, never a healthy
    // result or a transient checking fingerprint. Corrupt files stay audible.
    firstFailurePublication = publicationBound && publication.snapshotHash === null &&
      raw.previousSnapshotHash === null && snapshot === null &&
      !existsSync(resolve(context.stateDir, 'snapshot.json')) && publication.alertCodes.includes('RPC_CHECK_FAILED');
    if (firstFailurePublication) snapshotAlerts.push({code:'SNAPSHOT_BINDING_MISMATCH'}, ...publication.alertCodes.map(code => ({code})));
    // A subsequent bounded collection retains a prior no-snapshot failure;
    // its original RPC outage does not become a new checking incident.
    retainedNoSnapshotFailure = boundedScan && (!publicationExists || priorPublicationBound) && raw.previousSnapshotHash === null &&
      snapshot === null && !existsSync(resolve(context.stateDir, 'snapshot.json')) &&
      Array.isArray(raw.previousFailureCodes) && raw.previousFailureCodes.includes('RPC_CHECK_FAILED') &&
      raw.previousFailureCodes.every(code => typeof code === 'string' && /^[A-Z_0-9]{1,80}$/.test(code));
    if (retainedNoSnapshotFailure) snapshotAlerts.push({code:'SNAPSHOT_BINDING_MISMATCH'}, ...raw.previousFailureCodes.map(code => ({code})));
  } catch { /* invalid state remains audible below */ }
  // Exhaustion after observed generation changes is an inconclusive sample,
  // not a failure/recovery decision. Preserve delivery state for the next tick.
  // Stable corruption, invalid markers and expired scans remain audible.
  if (!generationConsistent && generationMoved && boundedScan && acceptablePublication) return null;
  if (generationConsistent && boundedScan && !holdExists && acceptablePublication) return null;
  if (generationConsistent && acceptablePublication && (boundedScan || publicationFresh) && (completedSnapshotValid || firstFailurePublication || retainedNoSnapshotFailure) && incidentId && hold.baselineHash === context.baselineHash &&
      Number.isFinite(Date.parse(hold.createdAt)) && Date.parse(hold.createdAt) <= now &&
      Array.isArray(hold.alerts) && hold.alerts.length > 0 && hold.alerts.every(entry =>
        typeof entry?.code === 'string' && /^[A-Z_0-9]{1,80}$/.test(entry.code))) {
    const validationCodes = [...new Set(snapshotAlerts.map(entry => entry.code))].sort();
    const codes = [...new Set(['HEARTBEAT_NOT_HEALTHY', 'HOLD_LATCHED', ...validationCodes])].sort();
    return { ok: false, codes, validationCodes, incidentCodes: hold.alerts.map(entry => entry.code), incidentId, checking: true,
      key: `failure:${hash(JSON.stringify({ codes, incidentId }))}` };
  }
  // Revalidates persisted snapshot/accounting, freshness, hashes and hold latch.
  // Reading a stored ok:true alone is never sufficient for recovery.
  const checked = heartbeatStatus(context, now);
  const codes = [...new Set((checked.alerts ?? []).map(entry => entry?.code)
    .filter(code => typeof code === 'string' && /^[A-Z_0-9]{1,80}$/.test(code)))].sort();
  return { ok: checked.ok === true, codes, incidentId, key: checked.ok === true ? 'healthy' : `failure:${hash(JSON.stringify({ codes, incidentId }))}` };
}

export async function notifyMainnet({ context, previous, destinationId, send, save, now = Date.now() }) {
  if (!/^-?\d+$/.test(String(destinationId || ''))) throw new Error('DESTINATION_REQUIRED');
  const current = notificationState(context, now);
  if (!current) return { sent: false, reason: 'scan-in-progress' };
  const binding = hash(JSON.stringify([context.manifestHash, context.baselineHash]));
  const same = previous?.destinationId === String(destinationId) && previous?.binding === binding;
  const age = now - Date.parse(previous?.sentAt);
  const knownHeldScan = same && current.checking && previous?.incidentId === current.incidentId &&
    previous?.key?.startsWith('failure:') && current.validationCodes.every(code => previous?.codes?.includes(code));
  if (knownHeldScan && age >= 0 && age < 21600000) return { sent: false, reason: 'known-incident-scan-in-progress' };
  if (same && previous?.key === current.key && (current.ok || (age >= 0 && age < 21600000))) return { sent: false, reason: 'unchanged' };
  const label = current.ok ? (same && previous?.key?.startsWith('failure:') ? 'RECOVERED' : 'CONNECTED') : 'ATTENTION';
  const address = context.baseline.identity.address;
  const message = `Shadow Arc MAINNET monitor — ${label}\nContract ${address}\n` +
    (current.ok ? 'The latest complete observation matches the approved baseline; no operational hold remains.' :
      `Observation failed or became stale: ${current.codes.join(', ') || 'STATUS_INVALID'}. Inspect the monitor and reconcile the incident before continuing.`) +
    (current.incidentCodes ? `\nOriginal incident: ${[...new Set(current.incidentCodes)].sort().join(', ')}.` : '') +
    '\nThis alert does not pause or authorize payments, or acknowledge an incident.';
  await send(message);
  // Failed delivery never suppresses retries. Persist only after success.
  // A reminder during an unchanged scan retains the last completed-state
  // fingerprint, so its completion does not send a second reminder.
  const key = knownHeldScan ? previous.key : current.key;
  await save({ destinationId: String(destinationId), binding, key, codes: knownHeldScan ? previous.codes : current.codes, incidentId: current.incidentId, sentAt: new Date(now).toISOString() });
  return { sent: true, state: current.ok ? 'healthy' : 'failure', codes: current.codes };
}

async function main() {
  const { values } = parseArgs({ options: { baseline: { type: 'string' }, manifest: { type: 'string' },
    'observer-dir': { type: 'string' }, 'state-dir': { type: 'string' }, config: { type: 'string' } } });
  for (const key of ['baseline', 'manifest', 'observer-dir', 'state-dir', 'config']) if (!values[key]) throw new Error('CONFIG_REQUIRED');
  const observerDir = resolve(values['observer-dir']);
  const dir = resolve(values['state-dir']);
  if (dir === observerDir) throw new Error('SEPARATE_NOTIFICATION_STATE_REQUIRED');
  const context = loadMainnetContext({ baselinePath: values.baseline, manifestPath: values.manifest, stateDir: observerDir });
  const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = resolve(dir, 'notification.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  try {
    const result = await notifyMainnet({ context, previous: optionalJson(resolve(dir, 'notification.json')),
      destinationId: String(config.chatId), send: text => sendTelegram(config, text), save: value => {
        const temporary = resolve(dir, `notification.${randomUUID()}.tmp`);
        try {
          writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
          renameSync(temporary, resolve(dir, 'notification.json'));
        } finally { rmSync(temporary, { force: true }); }
      } });
    console.log(JSON.stringify(result));
  } finally { rmSync(lock); }
}

if (isEntrypoint(import.meta)) main().catch(() => {
  console.error('Shadow mainnet notification check failed. Inspect configuration, access and lock state locally. Credentials and transport details suppressed.');
  process.exitCode = 1;
});
