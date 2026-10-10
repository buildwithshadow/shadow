import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak256 } from 'viem';
import { findLogs } from './float-mainnet-cli.mjs';
import { MAX_BYTES, buildNormalizedContent, hashBytes, validateApprovedBytes, verifyAndMerge } from './float-mainnet-history-validation.mjs';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const must = (ok, message) => { if (!ok) throw new Error(message); };

export function approvedHistoryIdentity(manifestPath, connection) {
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes);
  must(manifest.ok === true, 'Approved history requires a verified deployment manifest.');
  const identity = { chainId: String(manifest.chainId), address: manifest.contract?.address,
    runtimeCodeHash: manifest.bytecode?.onchainRuntimeKeccak256,
    deployBlock: String(manifest.deployment?.blockNumber),
    manifestHash: `0x${createHash('sha256').update(bytes).digest('hex')}` };
  if (connection) must(same(identity.chainId, connection.chainId) && same(identity.address, connection.address)
    && identity.deployBlock === String(connection.deployBlock), 'History manifest differs from the connected deployment.');
  return identity;
}

// Immutable bytes are approved separately in the protected baseline. Neither
// the monitor nor an external index can approve or regenerate its own prefix.
export function readApprovedHistoryFile(file, digest, identity) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    must(before.isFile() && before.size > 0 && before.size <= MAX_BYTES, 'Approved history is not a bounded regular file.');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    must(before.size === after.size && before.mtimeMs === after.mtimeMs
      && bytes.length === before.size, 'Approved history changed during reading.');
    return { bytes, ...validateApprovedBytes(bytes, digest, identity) };
  } finally { closeSync(fd); }
}

export function validateConfiguredHistory(baseline, manifestPath) {
  if (!baseline.approvedHistory) return null;
  const identity = approvedHistoryIdentity(manifestPath);
  for (const key of ['chainId', 'address', 'runtimeCodeHash', 'deployBlock'])
    must(same(identity[key], baseline.identity[key]), 'Approved history baseline differs from the verified manifest.');
  const policy = baseline.approvedHistory;
  const history = readApprovedHistoryFile(policy.file, policy.sha256, identity);
  must(history.parsed.anchor.blockNumber === policy.anchorBlock
    && same(history.parsed.anchor.blockHash, policy.anchorHash), 'History anchor differs from the approved baseline.');
  return history;
}

export async function discoverApprovedHistory(connection, pinned, values = {}) {
  const file = values['approved-history'];
  const digest = values['approved-history-digest'];
  must((file === undefined) === (digest === undefined), 'Approved history requires both a file and its externally approved digest.');
  const scanned = { fromBlock: connection.deployBlock, toBlock: pinned.number };
  if (file === undefined) return { logs: await findLogs(connection, undefined, undefined, connection.deployBlock, pinned.number), scanned };
  const identity = approvedHistoryIdentity(values.manifest, connection);
  const { bytes, parsed } = readApprovedHistoryFile(file, digest, identity);
  const finalized = await connection.client.getBlock({ blockTag: 'finalized' });
  const merged = await verifyAndMerge({ prefixBytes: bytes, approvedDigest: digest, expectedIdentity: identity,
    pinnedBlock: { blockNumber: pinned.number, blockHash: pinned.hash },
    finalizedBlock: { blockNumber: finalized.number },
    verifyAnchorHash: async number => (await connection.client.getBlock({ blockNumber: number })).hash,
    fetchSuffix: (from, to) => findLogs(connection, undefined, undefined, from, to) });
  // A canonical anchor and head do not make logs from an inconsistent RPC
  // backend canonical. Bind every intervening log block before discovery.
  for (const [number, hash] of new Map(merged.suffixLogs.map(log => [log.blockNumber, log.blockHash]))) {
    const block = await connection.client.getBlock({ blockNumber: BigInt(number) });
    must(block.number === BigInt(number) && same(block.hash, hash), 'Suffix event block is not canonical.');
  }
  return { logs: merged.mergedLogs, scanned, approvedHistory: { sha256: digest,
    anchorBlock: String(merged.anchorBlock), anchorHash: parsed.anchor.blockHash,
    prefixLogCount: merged.prefixLogs.length, suffixLogCount: merged.suffixLogs.length } };
}

// Capture is read only and creates no approval. The complete original range,
// every log block and the finalized anchor are verified before returning bytes.
export async function captureApprovedHistory(connection, manifestPath) {
  const identity = approvedHistoryIdentity(manifestPath, connection);
  const anchor = await connection.client.getBlock({ blockTag: 'finalized' });
  must(anchor.number >= connection.deployBlock, 'Finalized head predates deployment.');
  const code = await connection.client.getCode({ address: connection.address, blockNumber: anchor.number });
  must(code && same(keccak256(code), identity.runtimeCodeHash), 'Runtime differs at the history anchor.');
  const logs = await findLogs(connection, undefined, undefined, connection.deployBlock, anchor.number);
  const built = buildNormalizedContent(logs, identity, { blockNumber: anchor.number, blockHash: anchor.hash });
  for (const [number, hash] of new Map(built.parsed.logs.map(log => [log.blockNumber, log.blockHash]))) {
    const block = await connection.client.getBlock({ blockNumber: BigInt(number) });
    must(block.number === BigInt(number) && same(block.hash, hash), 'Captured event block is not canonical.');
  }
  const current = await connection.client.getBlock({ blockNumber: anchor.number });
  must(same(current.hash, anchor.hash), 'History anchor changed during complete capture.');
  return { ...built, sha256: hashBytes(built.bytes) };
}
