import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashBytes, validateApprovedBytes } from './float-mainnet-history-validation.mjs';

// Offline comparison only. RPC agreement is not proof of completeness or
// independent operation. A maintainer must verify capture provenance and the
// finalized canonical anchor before installing a new protected digest.
export function compareHistoryRenewal({ approvedBytes, approvedDigest, identity, firstBytes, secondBytes }) {
  const original = validateApprovedBytes(approvedBytes, approvedDigest, identity);
  const first = validateApprovedBytes(firstBytes, hashBytes(firstBytes), identity);
  const second = validateApprovedBytes(secondBytes, hashBytes(secondBytes), identity);
  const oldBlock = BigInt(original.parsed.anchor.blockNumber);
  const firstBlock = BigInt(first.parsed.anchor.blockNumber);
  const secondBlock = BigInt(second.parsed.anchor.blockNumber);
  if (firstBlock <= oldBlock || secondBlock <= oldBlock) throw new Error('Both captures must advance the approved anchor.');
  const comparable = (logs, end) => JSON.stringify(logs.filter(log => BigInt(log.blockNumber) <= end));
  for (const capture of [first, second]) {
    if (comparable(capture.logs, oldBlock) !== JSON.stringify(original.logs))
      throw new Error('Capture changes the previously approved event sequence.');
  }
  const overlap = firstBlock < secondBlock ? firstBlock : secondBlock;
  if (comparable(first.logs, overlap) !== comparable(second.logs, overlap))
    throw new Error('Captures disagree on the complete overlapping event sequence.');
  if (firstBlock === secondBlock && first.parsed.anchor.blockHash !== second.parsed.anchor.blockHash)
    throw new Error('Captures disagree on the anchor hash.');
  // Only the older capture has complete cross-capture event agreement. Never
  // recommend the newer uncorroborated tail for promotion.
  const chosen = firstBlock <= secondBlock ? first : second;
  const bytes = firstBlock <= secondBlock ? firstBytes : secondBytes;
  for (const capture of [first, second]) {
    for (const log of capture.logs.filter(log => BigInt(log.blockNumber) === overlap)) {
      if (log.blockHash !== chosen.parsed.anchor.blockHash) throw new Error('Overlap anchor conflicts with event block hash.');
    }
  }
  return { kind: 'UnapprovedShadowHistoryRenewalComparison', approved: false,
    comparisonPassed: true, previousDigest: approvedDigest,
    candidate: { sha256: hashBytes(bytes), anchor: chosen.parsed.anchor, logCount: chosen.logs.length },
    previousLogCount: original.logs.length, comparedThrough: String(overlap),
    requiresMaintainerReview: true, transactionsSent: 0,
    limitations: 'Offline agreement only. Verify independent complete capture provenance and finalized canonical anchor before approval. No baseline or hold is changed.' };
}

function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    approved: { type: 'string' }, digest: { type: 'string' }, manifest: { type: 'string' },
    first: { type: 'string' }, second: { type: 'string' } } });
  for (const key of ['approved', 'digest', 'manifest', 'first', 'second'])
    if (!values[key]) throw new Error(`--${key} is required`);
  const manifestBytes = readFileSync(values.manifest);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.ok !== true) throw new Error('Verified deployment manifest required.');
  const identity = { chainId: String(manifest.chainId), address: manifest.contract?.address,
    runtimeCodeHash: manifest.bytecode?.onchainRuntimeKeccak256,
    deployBlock: String(manifest.deployment?.blockNumber), manifestHash: `0x${hashBytes(manifestBytes)}` };
  console.log(JSON.stringify(compareHistoryRenewal({ approvedBytes: readFileSync(values.approved),
    approvedDigest: values.digest, identity, firstBytes: readFileSync(values.first), secondBytes: readFileSync(values.second) }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`History renewal comparison failed: ${error.message}`); process.exitCode = 1; }
}
