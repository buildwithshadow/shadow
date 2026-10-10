import { isAddress, zeroAddress } from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { validateBaseline as validateFixedBaseline, evaluateSnapshot as evaluateFixedSnapshot, digestJson } from './float-mainnet-monitor-policy.mjs';

const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const address = value => typeof value === 'string' && isAddress(value) && !same(value,zeroAddress);
const must = (ok,message) => { if(!ok) throw Error(message); };
const positive = (value,ceiling) => uint(value) && BigInt(value)>0n && BigInt(value)<=BigInt(ceiling);

// Public admission is an explicit protected policy, never inferred from a snapshot.
// Fixed rehearsal baselines keep their existing exact membership and line checks.
export function validateBaseline(raw) {
  if(raw?.schemaVersion !== 2) return validateFixedBaseline(raw);
  const {publicAdmission,...fixed}=raw;
  must(publicAdmission && Object.keys(publicAdmission).sort().join(',') === 'maximumRepaymentWindow,minimumRepaymentWindow', 'Invalid public admission policy');
  must(publicAdmission.minimumRepaymentWindow==='3600' && publicAdmission.maximumRepaymentWindow==='86400', 'Invalid public repayment bounds');
  const b=validateFixedBaseline({...fixed,schemaVersion:1});
  must(b.identity.chainId==='5042' && b.sponsors.length===0 && b.lines.length===0, 'Public policy requires mainnet and predicate admission, not a fixed participant roster');
  must(BigInt(b.effectiveLimits.lineReserve)<=100000n && BigInt(b.effectiveLimits.lineSpend)<=5000n && BigInt(b.effectiveLimits.perSpend)<=5000n && BigInt(b.effectiveLimits.dailySpend)<=5000n, 'Public pilot limits exceed the approved release bounds');
  return {...b,schemaVersion:2,publicAdmission:structuredClone(publicAdmission)};
}

export function evaluateSnapshot(raw,snapshot,nowMs=Date.now()) {
  const b=validateBaseline(raw);
  if(b.schemaVersion!==2) return evaluateFixedSnapshot(b,snapshot,nowMs);
  const {publicAdmission,...fixed}=b;
  const fixedResult=evaluateFixedSnapshot({...fixed,schemaVersion:1},snapshot,nowMs);
  const alerts=[];
  const failure=detail=>alerts.push({code:'PUBLIC_POLICY_FAILED',severity:'critical',detail});
  const notices=[];
  let valid=false;
  try {
    must(snapshot && Array.isArray(snapshot.lines) && Array.isArray(snapshot.sponsors) && Array.isArray(snapshot.executionAudit?.executions), 'Incomplete public observation');
    const sponsors=new Map();
    for(const entry of snapshot.sponsors) {
      must(address(entry.sponsor) && !sponsors.has(entry.sponsor.toLowerCase()) && typeof entry.allowed==='boolean' && Array.isArray(entry.set), 'Invalid or duplicate sponsor');
      must(entry.set.length>0 && entry.set.every((e,i)=>typeof e.allowed==='boolean' && uint(e.blockNumber) && BigInt(e.blockNumber)>=BigInt(b.identity.deployBlock) && BigInt(e.blockNumber)<=BigInt(snapshot.observedAt.blockNumber) && hash(e.transactionHash) && (!i || BigInt(e.blockNumber)>=BigInt(entry.set[i-1].blockNumber))) && entry.set.at(-1).allowed===entry.allowed, 'Invalid or incomplete sponsor history');
      sponsors.set(entry.sponsor.toLowerCase(),entry.allowed);
    }
    const lines=new Map();
    for(const line of snapshot.lines) {
      must(hash(line.lineId) && !lines.has(line.lineId.toLowerCase()) && address(line.sponsor) && address(line.agent), 'Invalid or duplicate line parties');
      must(sponsors.has(line.sponsor.toLowerCase()) && typeof line.sponsorAllowed==='boolean' && line.sponsorAllowed===sponsors.get(line.sponsor.toLowerCase()), 'Line sponsor observation is inconsistent');
      must(['OPEN','DRAWN','CLOSED','DEFAULTED'].includes(line.state), 'Unknown line state');
      must(['epoch','termsVersion','expiry'].every(k=>uint(line[k]) && BigInt(line[k])>0n), 'Invalid line identity or terms');
      for(const [field,cap] of [['reserveCap','lineReserve'],['lineSpendCap','lineSpend'],['dailySpendCap','dailySpend']]) must(positive(line[field],b.effectiveLimits[cap]), 'Line exceeds public caps');
      must(positive(line.maximumRepaymentWindow,publicAdmission.maximumRepaymentWindow) && BigInt(line.maximumRepaymentWindow)>=BigInt(publicAdmission.minimumRepaymentWindow), 'Invalid repayment window');
      must(uint(line.cumulativePrincipalPaid) && BigInt(line.cumulativePrincipalPaid)<=BigInt(line.lineSpendCap), 'Cumulative purchases exceed the line cap');
      must(uint(line.dueAt) && Array.isArray(line.providers), 'Missing debt or provider observations');
      const providers=new Set();
      for(const p of line.providers) {
        must(address(p.provider) && !providers.has(p.provider.toLowerCase()) && typeof p.active==='boolean' && hash(p.endpointHash) && uint(p.expiry), 'Invalid provider policy');
        providers.add(p.provider.toLowerCase());
        for(const [field,cap] of [['perSpendCap','perSpend'],['dailySpendCap','dailySpend']]) must(uint(p[field]) && BigInt(p[field])<=BigInt(b.effectiveLimits[cap]) && (!p.active||BigInt(p[field])>0n), 'Provider exceeds public caps');
      }
      lines.set(line.lineId.toLowerCase(),line);
    }
    must(uint(snapshot.contract.totalCommittedCapital) && BigInt(snapshot.contract.totalCommittedCapital)<=BigInt(b.effectiveLimits.protocolReserve), 'Protocol reserve cap exceeded');
    for(const event of snapshot.executionAudit.executions) {
      const line=lines.get(event.lineId?.toLowerCase());
      must(line && ['ProviderPaid','SpendBlocked'].includes(event.event) && hash(event.digest), 'Execution has no known line or digest');
      if(event.route==='direct-intent') {
        must(event.intentVerified===true && same(event.agent,line.agent) && same(event.sponsor,line.sponsor) && event.lineEpoch===line.epoch && address(event.executor) && same(event.sender,event.executor), 'Direct execution lacks exact signed intent attribution');
      } else if(event.route==='circle-agent-v07') {
        must(same(event.agent,line.agent) && same(event.executor,line.agent) && same(event.entryPoint,entryPoint07Address) && hash(event.userOpHash) && address(event.sender), 'Circle execution lacks exact successful user operation attribution');
      } else throw Error('Execution route is not verified');
    }
    for(const entry of snapshot.alerts) {
      const line=lines.get(entry.lineId?.toLowerCase());
      const now=BigInt(snapshot.observedAt.timestamp), warn=BigInt(b.policy.warnBeforeSeconds);
      const live=line && ['OPEN','DRAWN'].includes(line.state);
      let scoped=false;
      if(entry.code==='DEFAULT_ELIGIBLE') scoped=entry.severity==='critical' && line?.state==='DRAWN' && BigInt(line.principalOutstanding)>0n && BigInt(line.dueAt)<=now;
      if(entry.code==='MATURITY_SOON') scoped=entry.severity==='warning' && line?.state==='DRAWN' && BigInt(line.dueAt)>now && BigInt(line.dueAt)-now<=warn;
      if(entry.code==='LINE_EXPIRY_SOON') scoped=entry.severity==='warning' && live && BigInt(line.expiry)-BigInt(publicAdmission.minimumRepaymentWindow)-now<=warn;
      if(entry.code==='POLICY_EXPIRY_SOON') scoped=entry.severity==='warning' && live && line.providers.some(p=>same(p.provider,entry.provider) && p.active && BigInt(p.expiry)-now<=warn);
      if(entry.code==='SPONSOR_REMOVED') scoped=entry.severity==='warning' && live && line.sponsorAllowed===false;
      if(scoped) notices.push({...entry,scope:'line',lineId:line.lineId});
    }
    valid=true;
  } catch(error) { failure(error.message); }
  // Only the membership and fixed executor assumptions are replaced. Identity,
  // canonical history, owner/operator, accounting, freshness and unknown alerts stay global.
  const replaced=new Set(['SPONSOR_DRIFT','LINE_DRIFT','EXECUTOR_DRIFT']);
  const scopedCodes=new Set(notices.map(n=>`${n.code}:${n.lineId}`));
  const retained=fixedResult.alerts.filter(a=>!(valid && replaced.has(a.code)));
  // The fixed evaluator drops line IDs from alerts; subtract only the exact
  // validated source notices, one occurrence each. An extra/unbound alert stays a hold.
  for(const notice of notices) {
    if(!valid || !scopedCodes.has(`${notice.code}:${notice.lineId}`)) continue;
    const index=retained.findIndex(a=>a.code===notice.code && a.detail==='monitor raised an operational alert');
    if(index>=0) retained.splice(index,1);
  }
  const criticalSources=snapshot?.alerts?.filter(a=>a.severity==='critical') ?? [];
  const onlyScopedFailure=valid && snapshot.ok===false && snapshot.accounting?.ok===true && criticalSources.length>0 && criticalSources.every(a=>notices.some(n=>n.code===a.code && n.lineId===a.lineId && n.severity===a.severity));
  if(onlyScopedFailure){const i=retained.findIndex(a=>a.code==='MONITOR_FAILED');if(i>=0)retained.splice(i,1);}
  alerts.push(...retained);
  return {ok:alerts.length===0,hold:alerts.length!==0,alerts,...(notices.length?{notices}:{}),baselineHash:digestJson(b)};
}

export { canonicalJson, digestJson } from "./float-mainnet-monitor-policy.mjs";
