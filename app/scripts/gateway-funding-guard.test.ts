import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertCandidateFundingResolved,gatewayWalletLockKey} from '../src/gatewayFundingGuard.ts';
const wallet='0x1111111111111111111111111111111111111111';
test('unresolved mainnet funding blocks its own chain and any deployment, without blocking another chain',()=>{
 const keys=[`shadow:candidate-funding:v1:5042:0xabc:${wallet}`];
 const storage={length:1,key:(i:number)=>keys[i],getItem:()=>'{corrupt'} as unknown as Storage;
 assert.throws(()=>assertCandidateFundingResolved(wallet,storage,5042),/Resolve/);
 assert.doesNotThrow(()=>assertCandidateFundingResolved(wallet,storage,5042002));
 assert.notEqual(gatewayWalletLockKey(wallet,5042),gatewayWalletLockKey(wallet));
});
