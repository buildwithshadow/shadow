import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { keccak256 } from 'viem';
import { connect } from './float-mainnet-cli.mjs';
import { approvedHistoryIdentity, discoverApprovedHistory, validateConfiguredHistory } from './float-mainnet-approved-history.mjs';
import { buildNormalizedContent, hashBytes } from './float-mainnet-history-validation.mjs';
import { validateBaseline } from './float-mainnet-monitor-public-policy.mjs';
import { digestJson } from './float-mainnet-monitor-policy.mjs';
import { isEntrypoint } from './float-mainnet-preflight.mjs';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const must = (ok, message) => { if (!ok) throw Error(message); };

// Read-only maintenance. The existing protected digest remains the trust root.
// Each RPC scans the entire NEW suffix; neither a checkpoint nor a current-state
// snapshot is allowed to approve missing events. The output still needs separate
// cross-provider comparison, maintainer review and protected installation.
export async function captureHistoryExtension(connection, manifestPath, rawBaseline) {
  const baseline = validateBaseline(structuredClone(rawBaseline));
  must(baseline.approvedHistory, 'An existing approved history binding is required');
  const identity = approvedHistoryIdentity(manifestPath, connection);
  const original = validateConfiguredHistory(baseline, manifestPath);
  const anchor = await connection.client.getBlock({ blockTag: 'finalized' });
  must(anchor.number > BigInt(original.parsed.anchor.blockNumber), 'Finalized head must advance the approved anchor');
  const code = await connection.client.getCode({ address: connection.address, blockNumber: anchor.number });
  must(code && same(keccak256(code), identity.runtimeCodeHash), 'Runtime differs at the extension anchor');
  const discovery = await discoverApprovedHistory(connection, anchor, { manifest: manifestPath,
    'approved-history': baseline.approvedHistory.file,
    'approved-history-digest': baseline.approvedHistory.sha256 });
  const built = buildNormalizedContent(discovery.logs, identity,
    { blockNumber: anchor.number, blockHash: anchor.hash });
  const current = await connection.client.getBlock({ blockNumber: anchor.number });
  must(current.number === anchor.number && same(current.hash, anchor.hash), 'Extension anchor changed during capture');
  must(approvedHistoryIdentity(manifestPath).manifestHash === identity.manifestHash, 'Manifest changed during capture');
  return { ...built, sha256: hashBytes(built.bytes), provenance: {
    kind: 'UnapprovedShadowHistoryExtension', approved: false, configurationChanged: false, transactionsSent: 0,
    expectedCurrentBaselineHash: digestJson(baseline), previousDigest: baseline.approvedHistory.sha256,
    previousAnchor: original.parsed.anchor, anchor: built.parsed.anchor,
    prefixLogCount: original.parsed.logs.length, suffixLogCount: discovery.approvedHistory.suffixLogCount,
    limitations: 'Reuses the approved prefix. Only the complete new suffix was scanned by this RPC. Compare independent suffix captures and verify provenance before approval. No baseline, history binding or hold is changed.' } };
}

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options:
    Object.fromEntries(['manifest', 'baseline', 'out'].map(key => [key, { type: 'string' }])) });
  for (const key of ['manifest', 'baseline', 'out']) must(values[key], `--${key} is required`);
  const baselineBytes = readFileSync(values.baseline);
  const connection = await connect(values, { readOnly: true });
  const capture = await captureHistoryExtension(connection, values.manifest, JSON.parse(baselineBytes));
  must(hashBytes(readFileSync(values.baseline)) === hashBytes(baselineBytes), 'Protected baseline changed during capture');
  writeFileSync(values.out, capture.bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...capture.provenance, sha256: capture.sha256, bytes: capture.bytes.length,
    logCount: capture.parsed.logs.length }));
}

if (isEntrypoint(import.meta)) main().catch(() => {
  console.error('History extension failed. No history approval, monitor configuration or hold was changed.');
  process.exitCode = 1;
});
