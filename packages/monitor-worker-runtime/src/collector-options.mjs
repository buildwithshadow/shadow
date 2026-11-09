/** Match the production runner's observation scope and policy thresholds. */
export function collectorOptions(context) {
 const {baseline:b}=context;
 const options={manifest:context.manifestPath,
  'warn-before':String(b.policy.warnBeforeSeconds),
  'max-index-lag':String(b.policy.maxIndexLagSeconds),
  'executor-from-block':b.executor.fromBlock};
 if(b.schemaVersion===2)options['public-admission-audit']=true;
 if(context.indexPath)options.index=context.indexPath;
 if(b.approvedHistory){
  options['approved-history']=context.approvedHistoryRuntimeFile??b.approvedHistory.file;
  options['approved-history-digest']=b.approvedHistory.sha256;
 }
 return options;
}
