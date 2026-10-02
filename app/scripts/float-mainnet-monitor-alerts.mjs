// Read-only operational alerts. No signing, pause, spend or hold acknowledgement.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { heartbeatStatus, loadContext } from './float-mainnet-monitor-runner.mjs';
import { isEntrypoint } from './float-mainnet-preflight.mjs';
import { sendTelegram } from './public-testnet-observer-alerts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const optionalJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

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
  const raw = optionalJson(resolve(context.stateDir, 'heartbeat.json'));
  const b = context.baseline;
  const identity = { schemaVersion: 1, kind: 'shadow-monitor-heartbeat', chainId: b.identity.chainId,
    address: b.identity.address, runtimeCodeHash: b.identity.runtimeCodeHash,
    baselineHash: context.baselineHash, manifestHash: context.manifestHash };
  const age = now - Date.parse(raw?.startedAt);
  // An ordinary bounded scan is quiet, but cannot mask a latched incident,
  // mismatched release, corrupt heartbeat or stopped/stuck runner.
  if (Object.entries(identity).every(([key, value]) => raw?.[key] === value) &&
      raw.status === 'checking' && raw.ok === false && raw.hold === true &&
      raw.completedAt === null && raw.checks?.snapshotHealthy === false &&
      Array.isArray(raw.alerts) && raw.alerts.length === 1 && raw.alerts[0]?.code === 'CHECK_IN_PROGRESS' &&
      age >= 0 && age <= b.policy.runTimeoutMs && !existsSync(resolve(context.stateDir, 'hold.json'))) return null;
  // Revalidates persisted snapshot/accounting, freshness, hashes and hold latch.
  // Reading a stored ok:true alone is never sufficient for recovery.
  const checked = heartbeatStatus(context, now);
  const codes = [...new Set((checked.alerts ?? []).map(entry => entry?.code)
    .filter(code => typeof code === 'string' && /^[A-Z_0-9]{1,80}$/.test(code)))].sort();
  const hold = optionalJson(resolve(context.stateDir, 'hold.json'));
  const incidentId = typeof hold?.incidentId === 'string' && /^[0-9a-f-]{36}$/.test(hold.incidentId) ? hold.incidentId : null;
  return { ok: checked.ok === true, codes, key: checked.ok === true ? 'healthy' : `failure:${hash(JSON.stringify({ codes, incidentId }))}` };
}

export async function notifyMainnet({ context, previous, destinationId, send, save, now = Date.now() }) {
  if (!/^-?\d+$/.test(String(destinationId || ''))) throw new Error('DESTINATION_REQUIRED');
  const current = notificationState(context, now);
  if (!current) return { sent: false, reason: 'scan-in-progress' };
  const binding = hash(JSON.stringify([context.manifestHash, context.baselineHash]));
  const same = previous?.destinationId === String(destinationId) && previous?.binding === binding;
  const age = now - Date.parse(previous?.sentAt);
  if (same && previous?.key === current.key && (current.ok || (age >= 0 && age < 21600000))) return { sent: false, reason: 'unchanged' };
  const label = current.ok ? (same && previous?.key?.startsWith('failure:') ? 'RECOVERED' : 'CONNECTED') : 'ATTENTION';
  const address = context.baseline.identity.address;
  const message = `Shadow Arc MAINNET monitor — ${label}\nContract ${address}\n` +
    (current.ok ? 'The latest complete observation matches the approved baseline; no operational hold remains.' :
      `Observation failed or became stale: ${current.codes.join(', ') || 'STATUS_INVALID'}. Inspect the monitor and reconcile the incident before continuing.`) +
    '\nThis alert does not pause or authorize payments, or acknowledge an incident.';
  await send(message);
  // Failed delivery never suppresses retries. Persist only after success.
  await save({ destinationId: String(destinationId), binding, key: current.key, sentAt: new Date(now).toISOString() });
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
