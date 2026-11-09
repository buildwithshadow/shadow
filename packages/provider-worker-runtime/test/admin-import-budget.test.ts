import {exports} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {configuredIdentity,coordinator,operatorApproval,canonical,fileOf,syntheticAcceptance,recordStoreFor} from './helpers.ts';
it('preserves an operator approved remaining budget when importing outstanding work',async()=>{
 const records=[{name:fileOf(92,'acceptance'),bytes:canonical(syntheticAcceptance(92))}];
 await (await coordinator()).quiesce();
 await exports.ProviderAdmin.bootstrap(records,await operatorApproval(configuredIdentity(),records),{perDigest:{records:9,bytes:65536}});
 const usage=await (await recordStoreFor(configuredIdentity())).budgetUsage(configuredIdentity());
 expect(usage.budgets).toBe(1);expect(usage.reserved.records).toBe(8);expect(usage.reserved.bytes).toBe(65536-records[0]!.bytes.length);
});
