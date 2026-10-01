// Operational notifications only. Never authorizes or changes onchain spending.
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { status } from './public-testnet-observer.mjs';

export function notificationState(raw, manifestHash, now = Date.now()) {
  if (!raw || !Array.isArray(raw.issues)) raw = undefined;
  const age = now - Date.parse(raw?.startedAt);
  // An ordinary full history scan takes several minutes. It is not an incident.
  if (raw?.manifestHash === manifestHash && raw?.completedAt === null &&
      raw?.issues?.length === 1 && raw.issues[0] === 'CHECK_IN_PROGRESS' &&
      age >= 0 && age <= 1260000) return null;
  const checked = status(raw, manifestHash, now);
  const codes = checked.issues.filter(x => typeof x === 'string' && /^[A-Z_0-9]{1,80}$/.test(x)).sort();
  return { ok: checked.ok, codes, key: checked.ok ? 'healthy' : 'failure' };
}

export async function notify({ raw, manifestHash, previous, destinationId, send, save, now = Date.now() }) {
  if (!/^-?\d+$/.test(String(destinationId || ''))) throw new Error('DESTINATION_REQUIRED');
  const current = notificationState(raw, manifestHash, now);
  if (!current) return { sent: false, reason: 'scan-in-progress' };
  const lastSent = Date.parse(previous?.sentAt);
  if (previous?.destinationId === String(destinationId) && previous?.key === current.key && (current.ok || (Number.isFinite(lastSent) && now >= lastSent && now - lastSent < 21600000))) {
    return { sent: false, reason: 'unchanged' };
  }
  const label = current.ok ? (previous?.destinationId === String(destinationId) && previous?.key === 'failure' ? 'RECOVERED' : 'CONNECTED') : 'ATTENTION';
  const message = `Shadow Arc TESTNET monitor — ${label}\n` +
    (current.ok ? 'The latest complete observation is healthy.' : `Observation failed or became stale: ${current.codes.join(', ') || 'STATUS_INVALID'}. Inspect the observer service and saved status before testing.`) +
    '\nThis is an observation alert; it does not pause or authorize payments.';
  await send(message);
  // Failed delivery must not acknowledge the incident. A later timer can retry.
  await save({ destinationId: String(destinationId), key: current.key, sentAt: new Date(now).toISOString() });
  return { sent: true, state: current.key };
}

export async function sendTelegram(config, text, fetcher = fetch) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config?.token || '') || !/^-?\d+$/.test(String(config?.chatId || ''))) throw new Error('NOTIFICATION_CONFIG_INVALID');
  try {
    const response = await fetcher(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12000), redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || String(result.result?.chat?.id) !== String(config.chatId)) throw new Error();
  } catch { throw new Error('NOTIFICATION_DELIVERY_FAILED'); }
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, 'state-dir': { type: 'string' }, 'observer-dir': { type: 'string' }, config: { type: 'string' } } });
  if (!values.manifest || !values['state-dir'] || !values['observer-dir'] || !values.config) throw new Error('CONFIG_REQUIRED');
  const manifestRaw = readFileSync(resolve(values.manifest));
  const manifest = JSON.parse(manifestRaw);
  if (manifest.schema !== 'shadow-public-testnet-release/v1' || manifest.ok !== true || manifest.chainId !== '5042002') throw new Error('TESTNET_ONLY');
  const manifestHash = createHash('sha256').update(manifestRaw).digest('hex');
  const dir = resolve(values['state-dir']);
  let raw, previous;
  try { raw = JSON.parse(readFileSync(resolve(values['observer-dir'], 'status.json'))); } catch { /* missing/corrupt is unhealthy */ }
  try { previous = JSON.parse(readFileSync(resolve(dir, 'notification.json'))); } catch { /* no successful delivery yet */ }
  const config = JSON.parse(readFileSync(resolve(values.config)));
  const result = await notify({ raw, manifestHash, previous, destinationId: String(config.chatId), send: text => sendTelegram(config, text), save: value => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = resolve(dir, `notification.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, resolve(dir, 'notification.json'));
  } });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Shadow notification check failed. Credentials and transport details suppressed.'); process.exitCode = 1;
});
