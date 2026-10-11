import { BaseError } from 'viem';
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
test('a returning view waits for the canceled read to settle before recovery',async()=>{
  let oldRead=true,calls=0;
  const h=harness({isBusy:()=>oldRead,wait:async()=>{oldRead=false;},recover:async()=>{calls++;return {status:'delivered'};}});
  await recoverOriginalPurchase(h.options);assert.equal(calls,1);assert.deepEqual(h.results,['delivered']);assert.deepEqual(h.stops,[]);
});
test('a canceled slow read does not consume replacement attempts or permanently stop recovery',async()=>{
  const budget={attempts:0,waited:0};const h=harness({isBusy:()=>true,budget});await recoverOriginalPurchase(h.options);assert.equal(h.calls(),0);assert.deepEqual(h.stops,[]);assert.equal(budget.attempts,0);
  await recoverOriginalPurchase({...h.options,isBusy:()=>false,recover:async()=>({status:'delivered'})});assert.deepEqual(h.results,['delivered']);
});
test('interrupted view batches share a finite attempt budget',async()=>{
  const budget={attempts:0,waited:0};let current=true,calls=0;
  const h=harness({budget,isCurrent:()=>current,recover:async()=>{calls++;return {status:'unconfirmed'};},wait:async()=>{current=false;}});
  for(let i=0;i<8;i++){current=true;await recoverOriginalPurchase(h.options);}
  assert.equal(calls,6);assert.equal(budget.attempts,6);assert.ok(h.stops.length>0);
});
test('invalid evidence remains stopped until an explicit new recovery budget is supplied',async()=>{
  const budget={attempts:0,waited:0};let calls=0;
  const h=harness({budget,recover:async()=>{calls++;throw new Error('Invalid signed delivery.');}});
  await recoverOriginalPurchase(h.options);await recoverOriginalPurchase(h.options);assert.equal(calls,1);assert.equal(budget.stopped,true);
  await recoverOriginalPurchase({...h.options,budget:{attempts:0,waited:0}});assert.equal(calls,2);
});
for (const message of ['Another Shadow tab is using this wallet.', 'Another tab is using this purchase.']) test(`temporary lock contention recovers after ${message}`,async()=>{
  let calls=0;const h=harness({recover:async()=>{if(++calls===1)throw Error(message);return {status:'delivered'};}});
  await recoverOriginalPurchase(h.options);assert.equal(calls,2);assert.deepEqual(h.results,['delivered']);assert.deepEqual(h.stops,[]);
});

for (const details of ['HTTP request failed. Status: 503', 'The request took too long to respond. Request timed out.']) test(`wrapped RPC outage resumes: ${details}`, async()=>{
  const rpc = new BaseError(`RPC read eth_call failed: ${details}`, {cause: new BaseError(details, {details})});
  const wrapped = new BaseError('Contract function execution failed.', {cause:rpc});
  let calls=0;const h=harness({recover:async()=>{if(++calls===1)throw wrapped;return {status:'delivered'};}});
  await recoverOriginalPurchase(h.options);assert.equal(calls,2);assert.deepEqual(h.results,['delivered']);assert.deepEqual(h.stops,[]);
});
for (const details of ['HTTP request failed. Status: 403', 'execution reverted: 503', 'RPC returned an unexpected chain ID']) test(`deterministic wrapped RPC failure stops: ${details}`, async()=>{
  const error=new BaseError(`RPC read eth_call failed: ${details}`, {cause:new BaseError(details,{details})});
  let calls=0;const h=harness({recover:async()=>{calls++;throw error;}});await recoverOriginalPurchase(h.options);
  assert.equal(calls,1);assert.deepEqual(h.stops,[error]);
});
