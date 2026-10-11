import assert from 'node:assert/strict';
import test from 'node:test';
import { observeFundingRoute, prepareFundingContinuation } from '../src/fundingContinuation.ts';
import type { CandidateOpenInput, CandidatePrepared, CandidateResolution } from '../src/candidateFunding.ts';

const sponsor = '0x1111111111111111111111111111111111111111';
const agent = '0x2222222222222222222222222222222222222222';
const input: CandidateOpenInput = { agent, provider: '0x3333333333333333333333333333333333333333', endpoint: 'https://provider.example/report', reserve: '0.10', lineSpendCap: '0.005', dailySpendCap: '0.005', providerPerSpendCap: '0.005', providerDailyCap: '0.005', expiryDays: '7', repaymentHours: '24' };
const approval: CandidatePrepared = { kind: 'approve', account: sponsor, to: sponsor, data: '0x', value: '0', amount: 100000n, lineId: null, agent: null, expectedEpoch: null, observedBlock: 1n, summary: '', nextAction: 'open' };
const next: CandidatePrepared = { ...approval, kind: 'open', agent, nextAction: undefined };
const confirmed: CandidateResolution = { status: 'confirmed', txHash: null, message: '' };
const route = { originRoute: 0, currentRoute: () => 0 };

test('confirmed allowance prepares the reviewed funding input without sending another transaction', async () => {
  let calls = 0;
  const result = await prepareFundingContinuation({ ...route, approval, resolution: confirmed, input, isCurrent: () => true,
    prepareOpen: async (account, captured) => { calls++; assert.equal(account,sponsor); assert.deepEqual(captured,input); assert.notEqual(captured,input); return next; } });
  assert.equal(result,next);
  assert.equal(calls,1);
});

test('uncertain, reverted and replaced approvals never prepare funding', async () => {
  for (const status of ['unknown','reverted','replaced'] as const) {
    assert.equal(await prepareFundingContinuation({ ...route, approval, resolution: { ...confirmed,status }, input, isCurrent: () => true,
      prepareOpen: async () => { throw new Error('must not prepare'); } }),null);
  }
});

test('a changed wallet or form during the new chain check discards the continuation', async () => {
  let current = true;
  let release!: (value: CandidatePrepared) => void;
  const waiting = new Promise<CandidatePrepared>(resolve => { release = resolve; });
  const result = prepareFundingContinuation({ ...route, approval, resolution: confirmed, input, isCurrent: () => current, prepareOpen: async () => waiting });
  current = false; release(next);
  assert.equal(await result,null);
});

test('insufficient updated allowance, changed amount, account or agent requires fresh review', async () => {
  const changes: CandidatePrepared[] = [approval,{...next,amount:1n},{...next,account:agent},{...next,agent:sponsor}];
  for (const changed of changes) {
    await assert.rejects(prepareFundingContinuation({ ...route, approval,resolution:confirmed,input,isCurrent:()=>true,prepareOpen:async()=>changed }),/funding conditions changed/);
  }
});

test('RPC failure preserves the completed allowance and does not fabricate a funding review', async () => {
  await assert.rejects(prepareFundingContinuation({...route,approval,resolution:confirmed,input,isCurrent:()=>true,prepareOpen:async()=>{throw new Error('RPC unavailable');}}),/RPC unavailable/);
});

test('leaving the funding route before allowance confirmation does not prepare another review', async () => {
  assert.equal(await prepareFundingContinuation({...route,currentRoute:()=> 1,approval,resolution:confirmed,input,isCurrent:()=>true,
    prepareOpen:async()=>{throw new Error('must not prepare');}}),null);
});

test('navigation away and back during preparation cannot revive the original review', async () => {
  let routeState = { key: 'fund-review', generation: 0 };
  let release!: (value: CandidatePrepared) => void;
  const waiting = new Promise<CandidatePrepared>(resolve => {release=resolve;});
  const result = prepareFundingContinuation({...route,currentRoute:()=>routeState.generation,approval,resolution:confirmed,input,isCurrent:()=>true,prepareOpen:async()=>waiting});
  routeState = observeFundingRoute(routeState,'budget');
  routeState = observeFundingRoute(routeState,'fund-review');
  assert.equal(routeState.key,'fund-review','browser Back restores the original history key');
  assert.equal(routeState.generation,2);
  release(next);
  assert.equal(await result,null);
});

test('renders without navigation preserve the generation and do not cancel continuation', () => {
  const current = {key:'fund-review',generation:3};
  assert.equal(observeFundingRoute(current,'fund-review'),current);
});
