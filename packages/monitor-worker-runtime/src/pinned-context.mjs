import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {loadContext} from '../../../app/scripts/float-mainnet-monitor-runner.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function approved(text,digest,max) {
 if(typeof text!=='string'||typeof digest!=='string'||!/^[0-9a-f]{64}$/.test(digest)||text.length>max)throw Error('monitor input not approved');
 const bytes=new TextEncoder().encode(text);if(bytes.length>max||hash(bytes)!==digest)throw Error('monitor input not approved');return bytes;
}
function scratch(label,bytes){const path=`/tmp/shadow-monitor-${label}-${hash(bytes)}.json`;try{writeFileSync(path,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||!Buffer.from(readFileSync(path)).equals(Buffer.from(bytes)))throw Error('monitor scratch conflict');}return path;}
export function pinnedContext(vars,stateBackend) {
 const manifest=approved(vars.MANIFEST_JSON,vars.MANIFEST_APPROVED_SHA256,65536);
 const baseline=approved(vars.BASELINE_JSON,vars.BASELINE_APPROVED_SHA256,1024*1024);
 const b=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(baseline));
 if(!b.approvedHistory?.sha256)throw Error('complete approved history is required');
 const history=approved(vars.HISTORY_JSON,b.approvedHistory.sha256,16*1024*1024);
 const context=loadContext({manifestPath:scratch('manifest',manifest),baselinePath:scratch('baseline',baseline),stateDir:'/durable-monitor-state',approvedHistoryRuntimeFile:scratch('history',history)});
 if(context.baseline.identity.chainId!=='5042'||context.baseline.schemaVersion!==2)throw Error('public mainnet monitor configuration required');
 return {...context,stateBackend};
}
