import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertCandidateFundingResolved,assertPurchaseResolved,gatewayWalletLockKey} from '../src/gatewayFundingGuard.ts';
const wallet='0x1111111111111111111111111111111111111111';
test('unresolved mainnet funding blocks its own chain and any deployment, without blocking another chain',()=>{
 const keys=[`shadow:candidate-funding:v1:5042:0xabc:${wallet}`];
 const storage={length:1,key:(i:number)=>keys[i],getItem:()=>'{corrupt'} as unknown as Storage;
 assert.throws(()=>assertCandidateFundingResolved(wallet,storage,5042),/Resolve/);
 assert.doesNotThrow(()=>assertCandidateFundingResolved(wallet,storage,5042002));
 assert.notEqual(gatewayWalletLockKey(wallet,5042),gatewayWalletLockKey(wallet));
});

test('purchase holds cover legacy routes on the same chain without blocking another wallet or chain',()=>{
 const key=`shadow.public-purchase.v1:5042:0xABC:${wallet}`;
 const values=new Map([[key,JSON.stringify({stage:'submitted'})]]);
 const storage={get length(){return values.size;},key:(i:number)=>[...values.keys()][i],getItem:(key:string)=>values.get(key)??null} as unknown as Storage;
 assert.throws(()=>assertPurchaseResolved(wallet,storage,5042),/earlier purchase/);
 assert.doesNotThrow(()=>assertPurchaseResolved(wallet,storage,5042002));
 assert.doesNotThrow(()=>assertPurchaseResolved('0x'+'22'.repeat(20),storage,5042));
 values.set(key,'{broken');assert.throws(()=>assertPurchaseResolved(wallet,storage,5042),/earlier purchase/);
 values.set(key,JSON.stringify({stage:'delivered'}));assert.doesNotThrow(()=>assertPurchaseResolved(wallet,storage,5042));
 values.delete(key);values.set(`${key}:0xarchived`,JSON.stringify({stage:'submitted'}));
 assert.doesNotThrow(()=>assertPurchaseResolved(wallet,storage,5042));
});
