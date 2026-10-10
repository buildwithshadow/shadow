import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSnapshot,validateBaseline} from './float-mainnet-monitor-public-policy.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const NOW=1800000000000;
function fixture(){
 const limits={protocolReserve:'1000000',lineReserve:'100000',lineSpend:'5000',perSpend:'5000',dailySpend:'5000'};
 const provider={provider:addr(5),active:true,endpointHash:hash(8),expiry:'1800600000',perSpendCap:'5000',dailySpendCap:'5000'};
 const baseline=validateBaseline({schemaVersion:2,identity:{chainId:'5042',address:addr(1),runtimeCodeHash:hash(1),usdc:addr(8),deployBlock:'10'},owner:addr(2),operators:[],sponsors:[],effectiveLimits:limits,pauses:{openingsPaused:false,spendsPaused:false},lines:[],executor:{address:addr(9),fromBlock:'10'},policy:{intervalMs:1000,runTimeoutMs:5000,maxHeartbeatAgeMs:10000,maxBlockAgeSeconds:120,maxIndexLagSeconds:120,warnBeforeSeconds:3600,requireIndex:false},publicAdmission:{minimumRepaymentWindow:'3600',maximumRepaymentWindow:'86400'}});
 const line={lineId:hash(2),sponsor:addr(3),agent:addr(4),epoch:'1',reserveCap:'100000',lineSpendCap:'5000',dailySpendCap:'5000',maximumRepaymentWindow:'86400',termsVersion:'1',expiry:'1800600000',providers:[provider],sponsorAllowed:true,state:'OPEN',availableReserve:'100000',principalOutstanding:'0',recoveryAvailable:'0',sponsorClaimed:'0',cumulativePrincipalPaid:'0',dueAt:'0'};
 const snapshot={ok:true,identity:{chainId:'5042',address:addr(1),runtimeCodeHash:hash(1),usdc:addr(8)},observedAt:{blockNumber:'100',blockHash:hash(100),timestamp:'1800000000'},contract:{address:addr(1),owner:addr(2),pendingOwner:addr(0),openingsPaused:false,spendsPaused:false,effectiveLimits:limits,pendingCapIncreases:[],operators:[],totalSponsorObligations:'100000',totalCommittedCapital:'100000'},sponsors:[{sponsor:addr(3),allowed:true,set:[{allowed:true,blockNumber:'11',transactionHash:hash(11)}]}],discovery:{lines:1,scanned:{fromBlock:'10',toBlock:'100'},index:null},lines:[line],alerts:[],accounting:{ok:true,balance:'100000',checks:['balanceCoversObligations','obligationsEqualLines','committedCapitalEqualsLines','linesMatchReserveCap'].map(id=>({id,status:'PASS'}))},executionAudit:{fromBlock:'10',toBlock:'100',executions:[]}};
 return {baseline,snapshot};
}
test('public registration and a bounded line need no manually approved participant roster',()=>{
 const {baseline,snapshot}=fixture();const saved=structuredClone(baseline);
 assert.equal(evaluateSnapshot(baseline,snapshot,NOW).ok,true);assert.deepEqual(baseline,saved);
 snapshot.lines=[];snapshot.discovery.lines=0;snapshot.contract.totalSponsorObligations='0';snapshot.contract.totalCommittedCapital='0';snapshot.accounting.balance='0';
 assert.equal(evaluateSnapshot(baseline,snapshot,NOW).ok,true);
});
test('a verified direct executor authorized by the agent is not a privileged global role',()=>{
 const {baseline,snapshot}=fixture();snapshot.executionAudit.executions=[{event:'ProviderPaid',digest:hash(12),lineId:hash(2),route:'direct-intent',intentVerified:true,agent:addr(4),sponsor:addr(3),lineEpoch:'1',executor:addr(6),sender:addr(6)}];
 assert.equal(evaluateSnapshot(baseline,snapshot,NOW).ok,true);
});
for(const [name,change] of [
 ['runtime drift',s=>s.identity.runtimeCodeHash=hash(99)],
 ['owner change',s=>s.contract.owner=addr(99)],
 ['new operator',s=>s.contract.operators.push({operator:addr(99),enabled:true,set:[{allowed:true,blockNumber:'12'}]})],
 ['cap drift',s=>s.contract.effectiveLimits={...s.contract.effectiveLimits,lineSpend:'5001'}],
 ['unexpected pause',s=>s.contract.spendsPaused=true],
 ['missing history',s=>s.discovery.scanned.fromBlock='11'],
 ['stale read',s=>s.observedAt.timestamp='1799990000'],
 ['accounting shortfall',s=>s.accounting.balance='99999'],
 ['protocol overflow',s=>s.contract.totalCommittedCapital='1000001'],
 ['line cap overflow',s=>s.lines[0].reserveCap='100001'],
 ['cumulative cap overflow',s=>s.lines[0].cumulativePrincipalPaid='5001'],
 ['provider overflow',s=>s.lines[0].providers[0].perSpendCap='5001'],
 ['unknown sponsor',s=>s.sponsors=[]],
 ['incomplete registration history',s=>s.sponsors[0].set=[]],
 ['role history disagreement',s=>s.sponsors[0].set[0].allowed=false],
 ['duplicate sponsors',s=>s.sponsors.push(structuredClone(s.sponsors[0]))],
 ['unverified payment',s=>s.executionAudit.executions=[{event:'ProviderPaid',digest:hash(12),lineId:hash(2),sender:addr(6),executor:addr(6)}]],
 ['unbound alert',s=>s.alerts=[{code:'DEFAULT_ELIGIBLE',severity:'critical',lineId:hash(99)}]],
 ['unknown error',s=>s.alerts=[{code:'NEW_ERROR',severity:'critical'}]],
 ['unexplained failure status',s=>s.ok=false],
])test(`public admission still holds on ${name}`,()=>{const {baseline,snapshot}=fixture();change(snapshot);assert.equal(evaluateSnapshot(baseline,snapshot,NOW).hold,true);});
test('unpaid debt is a visible line incident, not a global outage for other sponsors',()=>{
 const {baseline,snapshot}=fixture();Object.assign(snapshot.lines[0],{state:'DRAWN',availableReserve:'95000',principalOutstanding:'5000',cumulativePrincipalPaid:'5000',dueAt:'1799999999'});snapshot.accounting.balance='95000';snapshot.contract.totalSponsorObligations='95000';snapshot.ok=false;snapshot.alerts=[{code:'DEFAULT_ELIGIBLE',severity:'critical',lineId:hash(2)}];
 const result=evaluateSnapshot(baseline,snapshot,NOW);assert.equal(result.ok,true);assert.equal(result.notices[0].scope,'line');assert.equal(result.notices[0].severity,'critical');
 snapshot.alerts.push({code:'DEFAULT_ELIGIBLE',severity:'critical',lineId:hash(99)});assert.equal(evaluateSnapshot(baseline,snapshot,NOW).hold,true);
});
test('a revoked sponsor is scoped to its line and cannot be relabeled allowed',()=>{
 const {baseline,snapshot}=fixture();snapshot.sponsors[0].allowed=false;snapshot.sponsors[0].set.push({allowed:false,blockNumber:'90',transactionHash:hash(90)});snapshot.lines[0].sponsorAllowed=false;snapshot.alerts=[{code:'SPONSOR_REMOVED',severity:'warning',lineId:hash(2)}];
 assert.equal(evaluateSnapshot(baseline,snapshot,NOW).ok,true);
 snapshot.lines[0].sponsorAllowed=true;assert.equal(evaluateSnapshot(baseline,snapshot,NOW).hold,true);
});
test('public mode must be declared and cannot exceed pilot ceilings',()=>{
 const {baseline}=fixture();for(const patch of [{sponsors:[addr(3)]},{identity:{...baseline.identity,chainId:'5042002'}},{publicAdmission:{minimumRepaymentWindow:'1',maximumRepaymentWindow:'86400'}},{effectiveLimits:{...baseline.effectiveLimits,lineReserve:'100001'}}])assert.throws(()=>validateBaseline({...baseline,...patch}));
});
