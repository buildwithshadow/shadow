import assert from 'node:assert/strict';
import test from 'node:test';
import {recoverySession,resetRecoverySession,recoveryWalletBusy,beginRecoveryWalletWork,finishRecoveryWalletWork,subscribeRecoverySettlement} from '../src/purchaseRecoverySession.mjs';
test('a replacement component sees the same exhausted budget and explicit reset creates a new budget',()=>{
  const key='remount-stop';const first=recoverySession(key);first.attempts=6;first.stopped=true;
  const remounted=recoverySession(key);assert.equal(remounted,first);assert.equal(remounted.stopped,true);
  resetRecoverySession(key);assert.equal(recoverySession(key).attempts,0);assert.equal(recoverySession(key).stopped,false);
});
test('terminal completion from an unmounted view wakes a replacement and shares its verified response',()=>{
  const wallet='remount-wallet',key='remount-terminal';let notified=0;
  beginRecoveryWalletWork(wallet);assert.equal(recoveryWalletBusy(wallet),true);
  const unsubscribe=subscribeRecoverySettlement(()=>{notified++;});
  const terminal={status:'delivered',record:{intent:{digest:'original'}}};recoverySession(key).deferred=terminal;
  finishRecoveryWalletWork(wallet);assert.equal(notified,1);assert.equal(recoveryWalletBusy(wallet),false);assert.equal(recoverySession(key).deferred,terminal);
  unsubscribe();
});
test('history completion also wakes current recovery, but ordinary current reads do not restart their own loop',()=>{
  let notified=0;const unsubscribe=subscribeRecoverySettlement(()=>{notified++;});
  beginRecoveryWalletWork('history');finishRecoveryWalletWork('history',false);assert.equal(notified,0);
  beginRecoveryWalletWork('history');finishRecoveryWalletWork('history');assert.equal(notified,1);unsubscribe();
});
test('completion isolates listener exceptions and independent wallets stay separate',()=>{
  beginRecoveryWalletWork('wallet-a');assert.equal(recoveryWalletBusy('wallet-b'),false);
  const unsubscribe=subscribeRecoverySettlement(()=>{throw Error('render failed');});
  assert.doesNotThrow(()=>finishRecoveryWalletWork('wallet-a'));assert.equal(recoveryWalletBusy('wallet-a'),false);unsubscribe();
});
