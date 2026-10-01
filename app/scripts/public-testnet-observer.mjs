// Read-only operational observation. This never authorizes, signs or pauses spending.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function assess(snapshot, manifest, now = Date.now()) {
  const issues = [];
  const fail = code => issues.push(code);
  if (!snapshot || snapshot.ok !== true) fail('SNAPSHOT_FAILED');
  if (String(snapshot?.identity?.chainId) !== '5042002' ||
      snapshot?.identity?.address?.toLowerCase() !== manifest.contract.address.toLowerCase() ||
      snapshot?.identity?.runtimeCodeHash !== manifest.bytecode.onchainRuntimeKeccak256 ||
      snapshot?.identity?.usdc?.toLowerCase() !== manifest.config.usdc.toLowerCase()) fail('IDENTITY_MISMATCH');
  const age = now / 1000 - Number(snapshot?.observedAt?.timestamp);
  if (!Number.isFinite(age) || age < -30 || age > 1500) fail('STALE_BLOCK');
  if (snapshot?.discovery?.scanned?.fromBlock !== manifest.deployment.blockNumber ||
      snapshot?.discovery?.scanned?.toBlock !== snapshot?.observedAt?.blockNumber ||
      !Array.isArray(snapshot?.lines) || snapshot?.discovery?.lines !== snapshot.lines.length) fail('DISCOVERY_INCOMPLETE');
  if (snapshot?.accounting?.ok !== true) fail('ACCOUNTING_FAILED');
  if (!Array.isArray(snapshot?.alerts)) fail('ALERTS_MISSING');
  else for (const a of snapshot.alerts) fail(a.code || 'UNKNOWN_ALERT');
  return [...new Set(issues)];
}

function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o640);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function status(state, manifestHash, now = Date.now()) {
  const issues = [...(state?.issues ?? [])];
  if (state?.manifestHash !== manifestHash) issues.push('MANIFEST_MISMATCH');
  const started = Date.parse(state?.startedAt), completed = Date.parse(state?.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started ||
      completed > now || completed - started > 1260000 || now - completed > 690000) issues.push('HEARTBEAT_STALE');
  if (state?.ok !== true) issues.push('OBSERVER_NOT_HEALTHY');
  return { ...state, ok: issues.length === 0, issues: [...new Set(issues)], checkedAt: new Date(now).toISOString() };
}

export function collect(manifestPath, rpcUrl, { timeoutMs = 1200000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./float-mainnet-monitor.mjs', import.meta.url)),
      'snapshot', '--manifest', manifestPath], { env: { PATH: process.env.PATH, ARC_RPC_URL: rpcUrl,
      FLOAT_MAINNET_EXPECTED_CHAIN_ID: '5042002', SHADOW_RPC_READ_SPACING_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, exceeded = false;
    const stop = () => { exceeded = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeoutMs);
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
    const clean = () => { clearTimeout(timer); process.off('SIGTERM', terminate); process.off('SIGINT', terminate); };
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop(); else output += chunk; });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop(); });
    child.once('error', () => { clean(); reject(new Error('RPC_SCAN_FAILED')); });
    child.once('close', code => {
      clean();
      try { if (exceeded || ![0, 1].includes(code)) throw new Error(); done(JSON.parse(output)); }
      catch { reject(new Error('RPC_SCAN_FAILED')); }
    });
  });
}

export async function observe({ manifest, manifestHash, stateDir, collectSnapshot }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o750 });
  const startedAt = new Date().toISOString();
  const common = { kind: 'shadow-public-testnet-observer', chainId: '5042002', address: manifest.contract.address,
    manifestHash, startedAt, completedAt: null, ok: false, issues: ['CHECK_IN_PROGRESS'], spendingEnforced: false };
  // Clear a former healthy result before network work; a killed process stays unhealthy.
  atomic(resolve(stateDir, 'status.json'), common);
  let snapshot, issues;
  try { snapshot = await collectSnapshot(); issues = assess(snapshot, manifest); }
  catch { issues = ['RPC_SCAN_FAILED']; }
  if (snapshot) atomic(resolve(stateDir, 'snapshot.json'), snapshot);
  const result = { ...common, completedAt: new Date().toISOString(), ok: issues.length === 0, issues,
    block: snapshot?.observedAt?.blockNumber ?? null, lineCount: snapshot?.lines?.length ?? null };
  atomic(resolve(stateDir, 'status.json'), result);
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, 'state-dir': { type: 'string' }, status: { type: 'boolean' } } });
  if (!values.manifest || !values['state-dir']) throw new Error('manifest and state-dir required');
  const manifestPath = resolve(values.manifest), raw = readFileSync(manifestPath), manifest = JSON.parse(raw);
  if (manifest.ok !== true || manifest.schema !== 'shadow-public-testnet-release/v1' || manifest.chainId !== '5042002') throw new Error('public testnet manifest required');
  const manifestHash = createHash('sha256').update(raw).digest('hex');
  let result;
  if (values.status) {
    let state; try { state = JSON.parse(readFileSync(resolve(values['state-dir'], 'status.json'))); } catch { /* missing is unhealthy */ }
    result = status(state, manifestHash);
  } else {
    if (!process.env.ARC_RPC_URL) throw new Error('ARC_RPC_URL required');
    result = await observe({ manifest, manifestHash, stateDir: resolve(values['state-dir']), collectSnapshot: () => collect(manifestPath, process.env.ARC_RPC_URL) });
  }
  console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Observer failed; inspect durable status and service state. No credentials printed.'); process.exitCode = 1;
});
