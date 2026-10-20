import { readFileSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hashBytes, validateApprovedBytes } from './float-mainnet-history-validation.mjs';
import { compareHistoryRenewal } from './float-mainnet-history-renewal.mjs';
import { validateBaseline } from './float-mainnet-monitor-public-policy.mjs';
import { digestJson } from './float-mainnet-monitor-policy.mjs';

// Offline draft only. Preserve the supplied baseline verbatim except its
// history binding. Neither capture agreement nor this plan grants approval.
export function planHistoryRenewal({ baseline, identity, approvedBytes, firstBytes, secondBytes, destination }) {
  const current = validateBaseline(baseline);
  if (!current.approvedHistory) throw Error('An existing approved history binding is required');
  for (const key of ['chainId', 'address', 'runtimeCodeHash', 'deployBlock'])
    if (String(current.identity[key]).toLowerCase() !== String(identity[key]).toLowerCase())
      throw Error('Baseline identity differs from deployment manifest');
  if (typeof destination !== 'string' || !isAbsolute(destination) || normalize(destination) !== destination ||
      destination === '/' || /[\0\r\n]/.test(destination) || destination.length > 4096 ||
      resolve(destination) === resolve(current.approvedHistory.file))
    throw Error('A new canonical absolute history path is required');
  const approvedDigest = current.approvedHistory.sha256;
  const old = validateApprovedBytes(approvedBytes, approvedDigest, identity);
  if (old.parsed.anchor.blockNumber !== current.approvedHistory.anchorBlock ||
      old.parsed.anchor.blockHash.toLowerCase() !== current.approvedHistory.anchorHash.toLowerCase())
    throw Error('Current history anchor differs from protected baseline');
  const comparison = compareHistoryRenewal({ approvedBytes, approvedDigest, identity, firstBytes, secondBytes });
  const candidateBaseline = structuredClone(baseline);
  candidateBaseline.approvedHistory = { file: destination, sha256: comparison.candidate.sha256,
    anchorBlock: comparison.candidate.anchor.blockNumber, anchorHash: comparison.candidate.anchor.blockHash };
  validateBaseline(candidateBaseline);
  return { kind: 'UnapprovedShadowHistoryPlan', approved: false, configurationChanged: false,
    transactionsSent: 0, requiresMaintainerReview: true, comparison,
    selectedCapture: hashBytes(firstBytes) === comparison.candidate.sha256 ? 'first' : 'second',
    expectedCurrentBaselineHash: digestJson(current), candidateBaseline,
    limitations: 'Draft only. Verify complete independent capture provenance and canonical finalized anchor. Check the current baseline again before installation. Preserve immutable prior files and journals. Run a fresh full check and use official incident acknowledgment. No installation or hold clearance is performed.' };
}

function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options:
    Object.fromEntries(['baseline','manifest','first','second','destination'].map(k => [k,{type:'string'}])) });
  for (const key of ['baseline','manifest','first','second','destination'])
    if (!values[key]) throw Error(`--${key} is required`);
  const baseline = JSON.parse(readFileSync(values.baseline, 'utf8'));
  const validated = validateBaseline(baseline);
  if (!validated.approvedHistory) throw Error('An existing approved history binding is required');
  const manifestBytes = readFileSync(values.manifest);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.ok !== true) throw Error('Verified deployment manifest required');
  const identity = { chainId:String(manifest.chainId), address:manifest.contract?.address,
    runtimeCodeHash:manifest.bytecode?.onchainRuntimeKeccak256, deployBlock:String(manifest.deployment?.blockNumber),
    manifestHash:`0x${hashBytes(manifestBytes)}` };
  console.log(JSON.stringify(planHistoryRenewal({ baseline, identity,
    approvedBytes:readFileSync(validated.approvedHistory.file), firstBytes:readFileSync(values.first),
    secondBytes:readFileSync(values.second), destination:values.destination }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`History plan failed: ${error.message}`); process.exitCode = 1; }
}
