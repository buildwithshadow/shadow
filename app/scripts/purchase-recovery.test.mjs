import assert from 'node:assert/strict';
import test from 'node:test';
import {recoverOriginalPurchase} from '../src/purchaseRecovery.mjs';
function harness(overrides={}) {
  let time=0, calls=0;const results=[], stops=[];
  const options={recover:async()=>{calls++;return {status:'unconfirmed'};},isCurrent:()=>true,
    onResult:r=>results.push(r.status),onStop:e=>stops.push(e),now:()=>time,wait:async ms=>{time+=ms;},...overrides};
  return {options,results,stops,calls:()=>calls};
}
test('uncertain payment has a finite read-only check budget',async()=>{
  const h=harness();await recoverOriginalPurchase(h.options);assert.equal(h.calls(),6);assert.deepEqual(h.stops,[null]);
});
test('original result is retrieved after a temporary delivery outage',async()=>{
  let calls=0;const h=harness({recover:async()=>{if(++calls===1)throw new Error('Provider unavailable (503). Keep the original purchase and retry recovery.');return {status:'delivered'};}});
  await recoverOriginalPurchase(h.options);assert.equal(calls,2);assert.deepEqual(h.results,['delivered']);assert.deepEqual(h.stops,[]);
});
test('refusal stops all background recovery',async()=>{
  const h=harness({recover:async()=>({status:'blocked'})});await recoverOriginalPurchase(h.options);assert.deepEqual(h.results,['blocked']);assert.deepEqual(h.stops,[]);
});
test('invalid signature never retries',async()=>{
  let calls=0;const error=new Error('Provider signature is invalid.');const h=harness({recover:async()=>{calls++;throw error;}});
  await recoverOriginalPurchase(h.options);assert.equal(calls,1);assert.deepEqual(h.stops,[error]);
});
test('navigation while waiting cancels further reads',async()=>{
  let current=true;const h=harness({isCurrent:()=>current,wait:async()=>{current=false;}});await recoverOriginalPurchase(h.options);assert.equal(h.calls(),1);assert.deepEqual(h.stops,[]);
});
test('wallet change while a response is in flight suppresses its result',async()=>{
  let current=true;const h=harness({isCurrent:()=>current,recover:async()=>{current=false;return {status:'delivered'};}});await recoverOriginalPurchase(h.options);assert.deepEqual(h.results,[]);assert.deepEqual(h.stops,[]);
});
test('slow calls consume the wall clock budget',async()=>{
  let time=0,calls=0;const h=harness({now:()=>time,recover:async()=>{calls++;time+=60001;return {status:'unconfirmed'};}});
  await recoverOriginalPurchase(h.options);assert.equal(calls,1);assert.deepEqual(h.stops,[null]);
});
