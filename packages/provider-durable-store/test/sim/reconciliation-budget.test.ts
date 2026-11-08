import assert from 'node:assert/strict';
import {test} from 'node:test';
import {World,hex64,requestName,utf8} from './harness.ts';
import {assertFull,assertHold} from './helpers.ts';
import {reconcileFingerprint} from '../../src/identity.ts';
import {sha256Hex} from '../../src/bytes.ts';
const digest=(n:number)=>`0x${hex64(n)}`;
const value=utf8('{"fixture":true}\n');
const approval=(w:World,name:string)=>sha256Hex(value).then(sha=>reconcileFingerprint(w.identity,name,sha));
test('rollback cannot restore accepted work as healthy without restoring its missing reservation',async()=>{
 const w=await World.ready([],{maxRecords:10,maxTotalBytes:1000});const snapshot=w.recordsStorage.snapshot();
 const names=['admission','acceptance'].map(slot=>`${digest(1)}.${slot}.json`);
 w.records.reserveBudget(w.identity,digest(1),8,800);for(const name of names)await w.records.putOnce(w.identity,name,value);
 w.recordsStorage.restore(snapshot);w.restartRecords();
 await assertHold(w.records.completeFromWitness(w.identity,names[0],value,await approval(w,names[0])),/reservation/);
 for(const name of names)await w.records.completeFromWitness(w.identity,name,value,await approval(w,name),{perDigest:{records:8,bytes:800}});
 await w.records.assertConsistent(w.identity);assert.equal(w.records.budgetUsage(w.identity).budgets,1);
 assert.throws(()=>w.records.reserveBudget(w.identity,digest(2),8,800),/capacity/);
 await w.records.putOnce(w.identity,`${digest(1)}.result.json`,value);
});
test('reconciliation charges a restored request binding to its preserved explicit reservation',async()=>{
 const w=await World.ready([],{maxRecords:8,maxTotalBytes:800});w.records.reserveBudget(w.identity,digest(1),8,800);
 const snapshot=w.recordsStorage.snapshot(),name=requestName(1);await w.records.putOnce(w.identity,name,value,{budgetDigest:digest(1)});
 w.recordsStorage.restore(snapshot);w.restartRecords();
 await assertFull(w.records.completeFromWitness(w.identity,name,value,await approval(w,name)));
 await w.records.completeFromWitness(w.identity,name,value,await approval(w,name),{budgetDigest:digest(1)});
 await w.records.assertConsistent(w.identity);assert.deepEqual(w.records.budgetUsage(w.identity).reserved,{records:7,bytes:800-value.length});
});
