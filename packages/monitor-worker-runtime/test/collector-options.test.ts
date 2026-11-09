import {expect,it} from 'vitest';
import {collectorOptions} from '../src/collector-options.mjs';
it('retains the public execution audit and baseline thresholds on every collection',()=>{
 const context={manifestPath:'/pinned/release.json',indexPath:'/pinned/index.json',approvedHistoryRuntimeFile:'/pinned/history.json',baseline:{schemaVersion:2,policy:{warnBeforeSeconds:123,maxIndexLagSeconds:456},executor:{fromBlock:'100'},approvedHistory:{file:'/operator/history.json',sha256:'a'.repeat(64)}}};
 expect(collectorOptions(context)).toEqual({manifest:'/pinned/release.json',index:'/pinned/index.json','public-admission-audit':true,'warn-before':'123','max-index-lag':'456','executor-from-block':'100','approved-history':'/pinned/history.json','approved-history-digest':'a'.repeat(64)});
});
it('keeps the original schema scope and does not invent optional history or index',()=>{
 expect(collectorOptions({manifestPath:'/release.json',baseline:{schemaVersion:1,policy:{warnBeforeSeconds:1,maxIndexLagSeconds:2},executor:{fromBlock:'3'}}})).toEqual({manifest:'/release.json','warn-before':'1','max-index-lag':'2','executor-from-block':'3'});
});
