import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcifyAvailability, sourcifyContract, sourcifyInput, validateSourcify } from './float-mainnet-sourcify.mjs';
import { contractsRoot, loadArtifact } from './float-mainnet-preflight.mjs';

const expectedInput = sourcifyInput(loadArtifact(), contractsRoot);
const identity = { chainId: 5042n, address: `0x${'12'.repeat(20)}`, txHash: `0x${'34'.repeat(32)}`, input: '0x5678', runtime: '0xabcd', expectedInput };
function record() {
  return { chainId: '5042', address: identity.address, creationMatch: 'match', runtimeMatch: 'exact_match', verifiedAt: '2026-10-02T09:00:00Z',
    deployment: { transactionHash: identity.txHash }, stdJsonInput: structuredClone(expectedInput.stdJsonInput),
    compilation: { language: 'Solidity', compiler: 'solc', compilerVersion: expectedInput.compilerVersion, fullyQualifiedName: expectedInput.contractIdentifier },
    creationBytecode: { onchainBytecode: identity.input }, runtimeBytecode: { onchainBytecode: identity.runtime } };
}
test('only completed matching source, creation and resolved runtime clears verification', () => {
  assert.equal(validateSourcify(record(), identity).ok, true);
  for (const mutate of [r => r.chainId = '5042002', r => r.address = `0x${'99'.repeat(20)}`, r => r.creationMatch = null,
    r => r.runtimeMatch = 'similarity', r => r.verifiedAt = 'invalid', r => r.deployment.transactionHash = `0x${'00'.repeat(32)}`,
    r => r.compilation.compilerVersion = '0.8.25', r => r.compilation.fullyQualifiedName = 'src/Other.sol:Other',
    r => r.stdJsonInput.settings.optimizer.runs++, r => r.stdJsonInput.sources[Object.keys(r.stdJsonInput.sources)[0]].content += '\n// changed',
    r => r.creationBytecode.onchainBytecode = '0x00', r => r.runtimeBytecode.onchainBytecode = '0x00']) {
    const r = record(); mutate(r); assert.equal(validateSourcify(r, identity).ok, false);
  }
  assert.equal(validateSourcify(null, identity).ok, false);
});
test('compiler output selection is ignored, meaningful compiler settings are preserved', () => {
  const r = record(); r.stdJsonInput.settings.outputSelection = { '*': { '*': ['*'] } };
  assert.equal(validateSourcify(r, identity).ok, true);
  r.stdJsonInput.settings.metadata.appendCBOR = true;
  assert.equal(validateSourcify(r, identity).ok, false);
});
test('preflight availability fails closed on unsupported chain, HTTP challenge or invalid registry', async () => {
  const response = data => async () => ({ ok: true, json: async () => data });
  assert.equal((await sourcifyAvailability(5042n, response([{ chainId: 5042, supported: true }]))).supported, true);
  await assert.rejects(sourcifyAvailability(5042n, response([{ chainId: 5042, supported: false }])));
  await assert.rejects(sourcifyAvailability(1n, response([])));
  await assert.rejects(sourcifyAvailability(5042n, async () => ({ ok: false, status: 403 })));
  await assert.rejects(sourcifyAvailability(5042n, response({ ok: true })));
});
test('lookup uses fixed production endpoint, restricted fields and refuses redirects', async () => {
  let called = false;
  await sourcifyContract(5042n, identity.address, async (url, options) => {
    called = true; assert.ok(url.startsWith(`https://sourcify.dev/server/v2/contract/5042/${identity.address}?fields=`));
    assert.equal(options.redirect, 'error'); assert.match(options.headers['User-Agent'], /Shadow/);
    assert.ok(!url.includes('fields=all')); return { ok: true, json: async () => record() };
  });
  assert.equal(called, true);
  await assert.rejects(sourcifyContract(5042n, 'bad', async () => assert.fail()));
});
