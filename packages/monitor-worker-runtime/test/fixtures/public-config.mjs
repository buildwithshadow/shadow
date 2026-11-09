import {createHash} from 'node:crypto';
import {buildNormalizedContent,hashBytes} from '../../../../app/scripts/float-mainnet-history-validation.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const hex=n=>'0x'+n.toString(16).padStart(64,'0');
export function approved(runtime=hex(1)){
 const manifest=JSON.stringify({ok:true,chainId:'5042',publicRegistration:true,repaymentBindingVersion:2,contract:{address:addr(1)},bytecode:{onchainRuntimeKeccak256:runtime},deployment:{blockNumber:'10'}});
 const content=buildNormalizedContent([],{chainId:'5042',address:addr(1),runtimeCodeHash:runtime,deployBlock:'10',manifestHash:'0x'+hash(manifest)},{blockNumber:'10',blockHash:hex(10)});
 const baseline={schemaVersion:2,identity:{chainId:'5042',address:addr(1),runtimeCodeHash:runtime,usdc:addr(8),deployBlock:'10'},owner:addr(2),operators:[],sponsors:[],effectiveLimits:{protocolReserve:'1000000',lineReserve:'100000',lineSpend:'5000',perSpend:'5000',dailySpend:'5000'},pauses:{openingsPaused:false,spendsPaused:false},lines:[],executor:{address:addr(9),fromBlock:'10'},policy:{intervalMs:1000,runTimeoutMs:5000,maxHeartbeatAgeMs:10000,maxBlockAgeSeconds:120,maxIndexLagSeconds:120,warnBeforeSeconds:3600,requireIndex:false},publicAdmission:{minimumRepaymentWindow:'3600',maximumRepaymentWindow:'86400'},approvedHistory:{file:'/approved/original-history.json',sha256:hashBytes(content.bytes),anchorBlock:'10',anchorHash:hex(10)}};
 const baselineJson=JSON.stringify(baseline);
 return {MANIFEST_JSON:manifest,MANIFEST_APPROVED_SHA256:hash(manifest),BASELINE_JSON:baselineJson,BASELINE_APPROVED_SHA256:hash(baselineJson),HISTORY_JSON:Buffer.from(content.bytes).toString('utf8')};
}
