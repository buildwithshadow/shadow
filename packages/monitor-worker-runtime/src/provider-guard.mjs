import {pinnedContext} from './pinned-context.mjs';
import {createProviderMonitorReadGuard} from '../../../app/scripts/float-mainnet-provider-monitor-guard.mjs';
/** Locally approved policy plus the separate monitor's read capability only. */
export function createWorkerProviderMonitorGuard(vars,connection,monitorRead){
 if(!monitorRead||typeof monitorRead.admissionState!=='function')throw Error('monitor read binding unavailable');
 const context=pinnedContext(vars,undefined);
 return createProviderMonitorReadGuard({connection,manifestPath:context.manifestPath,baselinePath:context.baselinePath,
  approvedHistoryRuntimeFile:context.approvedHistoryRuntimeFile,expectedManifestHash:context.manifestHash,
  expectedBaselineHash:context.baselineHash,readAdmissionState:()=>monitorRead.admissionState()});
}
