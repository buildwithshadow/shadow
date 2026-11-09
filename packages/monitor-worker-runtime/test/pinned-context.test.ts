import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {pinnedContext} from '../src/pinned-context.mjs';
import {buildNormalizedContent,hashBytes} from '../../../app/scripts/float-mainnet-history-validation.mjs';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const addr=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const hex=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
function approved(){
 const manifest=JSON.stringify({ok:true,chainId:'5042',publicRegistration:true,repaymentBindingVersion:2,contract:{address:addr(1)},bytecode:{onchainRuntimeKeccak256:hex(1)},deployment:{blockNumber:'10'}});
 const content=buildNormalizedContent([],{chainId:'5042',address:addr(1),runtimeCodeHash:hex(1),deployBlock:'10',manifestHash:'0x'+hash(manifest)},{blockNumber:'10',blockHash:hex(10)});
 const baseline={schemaVersion:2,identity:{chainId:'5042',address:addr(1),runtimeCodeHash:hex(1),usdc:addr(8),deployBlock:'10'},owner:addr(2),operators:[],sponsors:[],effectiveLimits:{protocolReserve:'1000000',lineReserve:'100000',lineSpend:'5000',perSpend:'5000',dailySpend:'5000'},pauses:{openingsPaused:false,spendsPaused:false},lines:[],executor:{address:addr(9),fromBlock:'10'},policy:{intervalMs:1000,runTimeoutMs:5000,maxHeartbeatAgeMs:10000,maxBlockAgeSeconds:120,maxIndexLagSeconds:120,warnBeforeSeconds:3600,requireIndex:false},publicAdmission:{minimumRepaymentWindow:'3600',maximumRepaymentWindow:'86400'},approvedHistory:{file:'/approved/original-history.json',sha256:hashBytes(content.bytes),anchorBlock:'10',anchorHash:hex(10)}};
 const baselineJson=JSON.stringify(baseline);
 return {MANIFEST_JSON:manifest,MANIFEST_APPROVED_SHA256:hash(manifest),BASELINE_JSON:baselineJson,BASELINE_APPROVED_SHA256:hash(baselineJson),HISTORY_JSON:Buffer.from(content.bytes).toString('utf8')};
}
it('uses immutable runtime history bytes while preserving the original protected history binding',()=>{const vars=approved(),context=pinnedContext(vars,{});expect(context.manifestHash).toBe(vars.MANIFEST_APPROVED_SHA256);expect(context.baseline.approvedHistory.file).toBe('/approved/original-history.json');expect(context.approvedHistoryRuntimeFile).toMatch(/^\/tmp\//);});
it('refuses changed history or policy bytes without deriving a new approval',()=>{const vars=approved();expect(()=>pinnedContext({...vars,HISTORY_JSON:'{}'},{})).toThrow('not approved');expect(()=>pinnedContext({...vars,BASELINE_JSON:vars.BASELINE_JSON+' '},{})).toThrow('not approved');expect(()=>pinnedContext({...vars,MANIFEST_JSON:vars.MANIFEST_JSON+' '},{})).toThrow('not approved');});
it('requires the complete approved history input',()=>{const vars=approved();expect(()=>pinnedContext({...vars,HISTORY_JSON:undefined},{})).toThrow('not approved');});
