import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, status, observe, collect } from './public-testnet-observer.mjs';
import { readDeployment } from './float-mainnet-config.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../contracts/deployments/public-testnet/arc-testnet.manifest.json', import.meta.url)));
function snapshot() {
  return { ok: true, identity: { chainId: '5042002', address: manifest.contract.address,
    runtimeCodeHash: manifest.bytecode.onchainRuntimeKeccak256, usdc: manifest.config.usdc },
    observedAt: { timestamp: String(Math.floor(Date.now()/1000)), blockNumber: '65000000' },
    discovery: { scanned: { fromBlock: manifest.deployment.blockNumber, toBlock: '65000000' }, lines: 0 },
    lines: [], accounting: { ok: true }, alerts: [] };
}
test('incomplete, stale, wrong-code and warning observations cannot look healthy', () => {
  assert.deepEqual(assess(snapshot(), manifest), []);
  for (const mutate of [s => {s.discovery.scanned.fromBlock = '64999999';},
    s => {s.identity.runtimeCodeHash = '0xwrong';}, s => {s.observedAt.timestamp = '1';},
    s => {s.accounting.ok = false;}, s => {s.alerts = [{code:'DEFAULT_ELIGIBLE'}];}]) {
    const s = snapshot(); mutate(s); assert.ok(assess(s, manifest).length);
  }
  assert.ok(assess(null, manifest).length);
});
test('outage replaces healthy state; restart keeps failure until a new complete scan', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'shadow-observer-'));
  const args = {manifest, manifestHash:'hash', stateDir};
  try {
    assert.equal((await observe({...args, collectSnapshot:async()=>snapshot()})).ok, true);
    const failed = await observe({...args, collectSnapshot:async()=>{throw Error('rpc unavailable');}});
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.issues,['RPC_SCAN_FAILED']);
    const disk = JSON.parse(readFileSync(join(stateDir,'status.json')));
    assert.equal(status(disk,'hash').ok,false);
    const recovered = await observe({...args, collectSnapshot:async()=>{
      const checking = JSON.parse(readFileSync(join(stateDir,'status.json')));
      assert.equal(status(checking,'hash').ok,false);
      return snapshot();
    }});
    assert.equal(status(recovered,'hash').ok,true);
    assert.equal(recovered.spendingEnforced,false);
    assert.equal(status(recovered,'other-release').ok,false);
    assert.equal(status(recovered,'hash',Date.now()+3600001).ok,false);
    const completed = Date.parse(recovered.completedAt);
    assert.equal(status(recovered,'hash',completed+690001).ok,false);
    assert.equal(status({...recovered,startedAt:new Date(completed-1260001).toISOString()},'hash',completed).ok,false);
  } finally {rmSync(stateDir,{recursive:true,force:true});}
});
test('collector has a hard subprocess timeout', async () => {
  await assert.rejects(collect('/nonexistent.json','http://127.0.0.1:1',{timeoutMs:1}),/RPC_SCAN_FAILED/);
});
test('operator pacing only slows reads and rejects invalid configuration', () => {
  const env = {ARC_RPC_URL:'http://localhost:8545',FLOAT_MAINNET_EXPECTED_CHAIN_ID:'5042002'};
  const options = {manifest:fileURL()};
  assert.equal(readDeployment({...env,SHADOW_RPC_READ_SPACING_MS:'1000'},options).readSpacingMs,1000);
  assert.equal(readDeployment(env,options).readSpacingMs,undefined);
  for (const value of ['0','349','5001','NaN','']) assert.throws(()=>readDeployment({...env,SHADOW_RPC_READ_SPACING_MS:value},options));
});
function fileURL(){return new URL('../../contracts/deployments/public-testnet/arc-testnet.manifest.json',import.meta.url);}
