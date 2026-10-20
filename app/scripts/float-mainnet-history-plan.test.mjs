import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHistoryRenewal } from './float-mainnet-history-plan.mjs';
import { buildNormalizedContent, hashBytes } from './float-mainnet-history-validation.mjs';
const addr = n => `0x${n.toString(16).padStart(40,'0')}`;
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const identity = {chainId:'5042002',address:addr(1),runtimeCodeHash:hash(1),deployBlock:'10',manifestHash:hash(9)};
const capture = n => buildNormalizedContent([],identity,{blockNumber:String(n),blockHash:hash(n)}).bytes;
function input() {
  const approvedBytes = capture(20);
  return {identity,approvedBytes,firstBytes:capture(30),secondBytes:capture(40),destination:'/protected/new.json',
    baseline:{schemaVersion:1,identity:{chainId:'5042002',address:addr(1),runtimeCodeHash:hash(1),deployBlock:'10',usdc:addr(8)},
      owner:addr(2),operators:[addr(3)],sponsors:[addr(4)],lines:[],
      effectiveLimits:{protocolReserve:'100',lineReserve:'10',lineSpend:'5',perSpend:'5',dailySpend:'5'},
      pauses:{openingsPaused:true,spendsPaused:true},executor:{address:addr(5),fromBlock:'10'},
      policy:{intervalMs:60000,runTimeoutMs:45000,maxHeartbeatAgeMs:120000,maxBlockAgeSeconds:120,
        maxIndexLagSeconds:120,warnBeforeSeconds:3600,requireIndex:false},
      approvedHistory:{file:'/protected/old.json',sha256:hashBytes(approvedBytes),anchorBlock:'20',anchorHash:hash(20)}}};
}
test('draft preserves every nonhistory field without mutating inputs or granting approval',()=>{
  const a=input(), before=structuredClone(a.baseline), r=planHistoryRenewal(a);
  const {approvedHistory,...rest}=r.candidateBaseline;
  const {approvedHistory:old,...expected}=before;
  assert.deepEqual(rest,expected); assert.deepEqual(a.baseline,before);
  assert.equal(approvedHistory.anchorBlock,'30'); assert.equal(r.selectedCapture,'first');
  assert.equal(r.approved,false); assert.equal(r.configurationChanged,false);
  assert.equal(r.requiresMaintainerReview,true);
});
test('reversed capture order selects the older file, not the newer tail',()=>{
  const a=input(); [a.firstBytes,a.secondBytes]=[a.secondBytes,a.firstBytes];
  assert.equal(planHistoryRenewal(a).selectedCapture,'second');
});
test('rejects invalid, reused or noncanonical destination paths',()=>{
  for(const destination of ['/protected/old.json','/protected/../protected/old.json','relative','/','/new\n.json','/new\0.json']) {
    assert.throws(()=>planHistoryRenewal({...input(),destination}),/path/);
  }
});
test('rejects baseline identity and anchor drift',()=>{
  for(const mutate of [a=>a.baseline.identity.chainId='5042',a=>a.baseline.approvedHistory.anchorBlock='21',
    a=>a.baseline.approvedHistory.anchorHash=hash(99),a=>a.baseline.approvedHistory.sha256='0'.repeat(64)]) {
    const a=input(); mutate(a); assert.throws(()=>planHistoryRenewal(a));
  }
});
test('rejects missing history, stale captures and malformed policy',()=>{
  for(const mutate of [a=>delete a.baseline.approvedHistory,a=>a.firstBytes=a.approvedBytes,
    a=>a.baseline.policy.runTimeoutMs=0]) {const a=input();mutate(a);assert.throws(()=>planHistoryRenewal(a));}
});
test('supports public baseline without rewriting public admission',()=>{
  const a=input();a.identity={...identity,chainId:'5042'};
  const c=n=>buildNormalizedContent([],a.identity,{blockNumber:String(n),blockHash:hash(n)}).bytes;
  a.approvedBytes=c(20);a.firstBytes=c(30);a.secondBytes=c(40);
  a.baseline.schemaVersion=2;a.baseline.identity.chainId='5042';a.baseline.sponsors=[];
  a.baseline.publicAdmission={minimumRepaymentWindow:'3600',maximumRepaymentWindow:'86400'};
  a.baseline.approvedHistory.sha256=hashBytes(a.approvedBytes);
  assert.deepEqual(planHistoryRenewal(a).candidateBaseline.publicAdmission,a.baseline.publicAdmission);
});
