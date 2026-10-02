import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, stringToBytes } from 'viem';

// Fixed production service: the alternate gate cannot be redirected to an
// arbitrary server that merely claims to have verified the contract.
export const SOURCIFY_SERVER = 'https://sourcify.dev/server';
const HEADERS = { 'User-Agent': 'Shadow-release-check/1.0 (+https://www.shadowbuild.xyz)' };
const CONTRACT_NAME = 'ShadowFloatMainnet';
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function settings(value) {
  const result = structuredClone(value ?? {});
  delete result.outputSelection;
  delete result.compilationTarget; // metadata-only, not a compiler input setting
  // Solidity defaults, observed in Sourcify's stored Standard JSON: omission
  // of empty remappings and explicit useLiteralContent=false are equivalent.
  if (!Object.hasOwn(result, 'remappings')) result.remappings = [];
  if (result.metadata && !Object.hasOwn(result.metadata, 'useLiteralContent')) result.metadata.useLiteralContent = false;
  return result;
}
async function get(path, fetchImpl) {
  const response = await fetchImpl(`${SOURCIFY_SERVER}${path}`, {
    headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Sourcify HTTP ${response.status}`);
  return response.json();
}
export async function sourcifyAvailability(chainId, fetchImpl = fetch) {
  if (![5042n, 5042002n].includes(BigInt(chainId))) throw new Error('Sourcify route is restricted to Arc');
  const chains = await get('/chains', fetchImpl);
  if (!Array.isArray(chains) || !chains.some(c => String(c.chainId) === String(chainId) && c.supported === true)) {
    throw new Error('Sourcify does not currently support the configured chain');
  }
  return { server: SOURCIFY_SERVER, chainId: String(chainId), supported: true, checkedAt: new Date().toISOString() };
}
export function sourcifyInput(artifact, contractsRoot) {
  const sources = {};
  for (const [path, meta] of Object.entries(artifact.metadata.sources)) {
    const absolute = resolve(contractsRoot, path);
    if (!absolute.startsWith(`${resolve(contractsRoot)}/`)) throw new Error('Source outside contracts root');
    const content = readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n');
    if (keccak256(stringToBytes(content)) !== meta.keccak256) throw new Error(`Source hash mismatch: ${path}`);
    sources[path] = { content };
  }
  const targets = Object.entries(artifact.metadata.settings.compilationTarget ?? {});
  if (targets.length !== 1 || targets[0][1] !== CONTRACT_NAME) throw new Error('Unexpected compilation target');
  return {
    stdJsonInput: { language: 'Solidity', sources, settings: settings(artifact.metadata.settings) },
    compilerVersion: artifact.metadata.compiler.version,
    contractIdentifier: `${targets[0][0]}:${CONTRACT_NAME}`,
  };
}
export async function sourcifyContract(chainId, address, fetchImpl = fetch) {
  if (![5042n, 5042002n].includes(BigInt(chainId)) || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid Arc contract identity');
  const fields = 'stdJsonInput,compilation,deployment,runtimeBytecode.onchainBytecode,creationBytecode.onchainBytecode';
  return get(`/v2/contract/${chainId}/${address}?fields=${fields}`, fetchImpl);
}
// Recompute from the retrieved record, never trust a caller-provided "ok".
// The ordinary manifest independently verifies both RPCs and all immutables.
export function validateSourcify(record, { chainId, address, txHash, input, runtime, expectedInput }) {
  const checks = [];
  const check = (id, ok) => checks.push({ id: `verification.sourcify.${id}`, status: ok ? 'PASS' : 'FAIL', detail: id });
  const match = value => ['match', 'exact_match'].includes(value);
  check('identity', String(record?.chainId) === String(chainId) && record?.address?.toLowerCase() === address.toLowerCase());
  check('completedCreationAndRuntimeMatch', match(record?.creationMatch) && match(record?.runtimeMatch) && Number.isFinite(Date.parse(record?.verifiedAt)));
  check('deploymentTransaction', record?.deployment?.transactionHash?.toLowerCase() === txHash.toLowerCase());
  check('compilerAndTarget', record?.compilation?.language === 'Solidity' && record?.compilation?.compiler === 'solc'
    && record?.compilation?.compilerVersion === expectedInput.compilerVersion
    && record?.compilation?.fullyQualifiedName === expectedInput.contractIdentifier);
  check('exactSourcesAndSettings', record?.stdJsonInput?.language === 'Solidity'
    && equal(record?.stdJsonInput?.sources, expectedInput.stdJsonInput.sources)
    && equal(settings(record?.stdJsonInput?.settings), settings(expectedInput.stdJsonInput.settings)));
  check('creationInput', typeof input === 'string' && record?.creationBytecode?.onchainBytecode?.toLowerCase() === input.toLowerCase());
  check('resolvedRuntime', typeof runtime === 'string' && record?.runtimeBytecode?.onchainBytecode?.toLowerCase() === runtime.toLowerCase());
  return { server: SOURCIFY_SERVER, ok: checks.every(c => c.status === 'PASS'), checks, verifiedAt: record?.verifiedAt ?? null };
}
