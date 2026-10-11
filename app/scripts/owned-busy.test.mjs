import assert from 'node:assert/strict';
import test from 'node:test';
import {createBusyOwner,withOwnedBusy} from '../src/ownedBusy.mjs';
test('view invalidation during a pending read still releases that read busy state',async()=>{
  let message='',current=true,settle;const owner=createBusyOwner(value=>{message=value;});
  const work=withOwnedBusy(owner,'Reading original line',async()=>{await new Promise(resolve=>{settle=resolve;});return current;});
  current=false;settle();assert.equal(await work,false);assert.equal(message,'');
});
test('an older read cannot clear a later ordinary wallet operation message',async()=>{
  let message='',settle;const owner=createBusyOwner(value=>{message=value;});
  const work=withOwnedBusy(owner,'Old read',()=>new Promise(resolve=>{settle=resolve;}));
  owner.set('Preparing a different wallet action');settle();await work;assert.equal(message,'Preparing a different wallet action');
});
test('older owned work cannot clear newer owned work and rejection releases its own message',async()=>{
  let message='',first,second;const owner=createBusyOwner(value=>{message=value;});
  const old=withOwnedBusy(owner,'Old',()=>new Promise(resolve=>{first=resolve;}));
  const next=withOwnedBusy(owner,'Next',()=>new Promise(resolve=>{second=resolve;}));
  first();await old;assert.equal(message,'Next');second();await next;assert.equal(message,'');
  await assert.rejects(withOwnedBusy(owner,'Failing read',async()=>{throw Error('RPC unavailable');}),/RPC unavailable/);assert.equal(message,'');
});
