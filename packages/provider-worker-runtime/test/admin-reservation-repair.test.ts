import {exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {sha256Hex} from '../../provider-durable-store/src/bytes.ts';
import {reconcileFingerprint} from '../../provider-durable-store/src/identity.ts';
import {configuredIdentity,coordinator,digestOf,fileOf,canonical,recordStoreFor,importThroughCoordinator} from './helpers.ts';
it('forwards operator approved reservations and request attribution through the full admin entrypoint',async()=>{
 await importThroughCoordinator();await (await coordinator()).quiesce();
 const id=configuredIdentity(),store=await recordStoreFor(id),digest=digestOf(91),admission=fileOf(91,'admission'),alias=`request-${digestOf(91)}.json`,bytes=canonical({reconcile:true});
 await store.reserveBudget(id,digest,8,800);await store.putOnce(id,admission,bytes);await store.putOnce(id,alias,bytes,{budgetDigest:digest});
 await runInDurableObject(store,(_instance,state)=>{state.storage.sql.exec('DROP TRIGGER records_no_delete');state.storage.sql.exec('DELETE FROM records WHERE name IN (?,?)',admission,alias);state.storage.sql.exec('DELETE FROM budgets WHERE digest=?',digest);});
 const admin=exports.ProviderAdmin;
 await admin.completeFromWitness(admission,bytes,await reconcileFingerprint(id,admission,await sha256Hex(bytes)),{perDigest:{records:8,bytes:800}});
 await admin.completeFromWitness(alias,bytes,await reconcileFingerprint(id,alias,await sha256Hex(bytes)),{budgetDigest:digest});
 expect((await store.budgetUsage(id)).reserved.records).toBe(6);expect((await store.assertConsistent(id,{deep:true})).records).toBe(2);
});
