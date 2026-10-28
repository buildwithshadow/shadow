import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, keccak256, stringToHex } from 'viem';
import { circleGuardedRepaymentAbi as abi } from './circle-agent-execution.mjs';
import { createSettledMainnetCircleOperations } from './circle-agent-guarded-operations.mjs';
import { SETTLED_MAINNET_CANDIDATE } from '../settledMainnetCandidate.mjs';
const deployment = {...SETTLED_MAINNET_CANDIDATE,usdc:'0x3600000000000000000000000000000000000000'};
const service = {principal:'10000',provider:'0xFAF237F98f35A86149E901e18EB4BAd67bC0D347',endpoint:'https://provider.example/settled-mainnet'};

const agent = `0x${'11'.repeat(20)}`, line = `0x${'22'.repeat(32)}`, draw = `0x${'33'.repeat(32)}`, nextDraw = `0x${'44'.repeat(32)}`;
const intent = { agent, executor: agent, sponsor: service.provider, lineId: line, lineEpoch: 1n, termsHash: draw,
  provider: service.provider, endpointHash: keccak256(stringToHex(service.endpoint)), principal: 10000n,
  maximumTotalDebt: 10000n, dueAt: 2000n, nonce: 0n, signatureExpiry: 1000n };
const purchase = encodeFunctionData({ abi, functionName: 'executeSpend', args: [intent, '0x1234'] });
function setup() {
  const state = { chainId: deployment.chainId, agent, line, contract: deployment.address, requests: {} };
  const events = [], remote = new Map();
  const control = { failSave: false, lose: false, debt: 10000n, draw, allowance: 0n, repaymentPlans: [], saved: null, sends: 0 };
  const executor = kind => ({
    operationKey: r => keccak256(stringToHex(r.operationId)),
    execute: async request => {
      const key = keccak256(stringToHex(request.operationId));
      assert(control.saved && Object.values(control.saved.requests).some(r => r.key === key), 'persist before any remote send');
      if (kind !== 'purchase') assert.equal(control.saved.guardedRepayment.draw, draw, 'persist original draw before allowance');
      events.push({ type: 'execute', kind, request });
      if (!remote.has(key)) { control.sends++; remote.set(key, { status: control.lose ? 'unknown' : 'confirmed', txHash: nextDraw, key }); }
      if (kind === 'approve') control.allowance = 10000n;
      if (kind === 'repay' && !control.lose) { control.debt = 0n; control.allowance = 0n; }
      return remote.get(key);
    },
    reconcile: async key => { events.push({ type: 'recover', kind, key }); return remote.get(key) ?? { status: 'not-submitted', key }; },
  });
  const repayer = {
    operationKey: executor('repay').operationKey,
    execute: request => executor(request.to === deployment.usdc ? 'approve' : 'repay').execute(request),
    reconcile: key => executor('repayment').reconcile(key),
  };
  const options = { agent, line, state, purchaseExecutor: executor('purchase'),
    save: async () => { events.push({ type: 'save' }); if (control.failSave) throw Error('disk failure'); control.saved = structuredClone(state); },
    makeRepayer: async plan => { control.repaymentPlans.push(structuredClone(plan)); return repayer; },
    readLine: async () => ({ agent, principalOutstanding: control.debt, state: control.debt ? 2 : 1, drawDigest: control.draw }),
    readAllowance: async () => control.allowance,
  };
  return { state, events, remote, control, options, operations: createSettledMainnetCircleOperations(options,service) };
}
test('purchase is persisted before send and restart recovery never executes again', async () => {
  const x = setup(); x.control.lose = true;
  await assert.rejects(() => x.operations.executePurchase(purchase), /unresolved/);
  const key = x.state.requests.purchase.key;
  const restarted = createSettledMainnetCircleOperations({ ...x.options, state: structuredClone(x.control.saved) },service);
  assert.equal((await restarted.reconcile(key)).status, 'unknown');
  assert.equal(x.control.sends, 1);
  x.remote.set(key, { status: 'confirmed', txHash: nextDraw });
  assert.equal((await restarted.reconcile(key)).status, 'confirmed');
  assert.equal(x.events.filter(e => e.type === 'execute').length, 1);
});
test('repayment saves the original draw before allowance and exact repayment, then stops at zero debt', async () => {
  const x = setup(); const result = await x.operations.repay();
  assert.equal(result.reviewedDraw, draw); assert.equal(x.control.sends, 2);
  const calls = x.events.filter(e => e.type === 'execute');
  assert.deepEqual(calls.map(e => e.kind), ['approve', 'repay']);
  const decoded = decodeFunctionData({ abi, data: calls[1].request.data });
  assert.equal(decoded.functionName, 'repayForDraw'); assert.deepEqual(decoded.args, [line, draw, 10000n]);
  assert.equal((await x.operations.repay()).status, 'no-debt'); assert.equal(x.control.sends, 2);
});
test('unknown allowance blocks repayment and recovery retains its saved draw after chain debt changes', async () => {
  const x = setup(); x.control.lose = true;
  await assert.rejects(() => x.operations.repay(), /unresolved/);
  assert.equal(x.control.sends, 1); assert(!x.state.requests.repay);
  x.control.draw = nextDraw;
  const restored = createSettledMainnetCircleOperations({ ...x.options, state: structuredClone(x.control.saved) },service);
  await assert.rejects(() => restored.repay(), /earlier Circle operation/);
  const key = x.state.requests['approve-repay'].key;
  x.remote.set(key, { status: 'confirmed', txHash: nextDraw });
  assert.equal((await restored.reconcile(key)).status, 'confirmed');
  assert(x.control.repaymentPlans.every(p => p.draw === draw));
  await assert.rejects(() => restored.repay(), /differs from the original repayment review/);
  assert.equal(x.control.sends, 1);
});
test('an uncertain purchase blocks repayment before creating a new authorization', async () => {
  const x = setup(); x.control.lose = true;
  await assert.rejects(() => x.operations.executePurchase(purchase));
  await assert.rejects(() => x.operations.repay(), /earlier Circle operation/);
  assert.equal(x.state.guardedRepayment, undefined); assert.equal(x.control.sends, 1);
});
test('persistence failure prevents purchase and repayment side effects', async () => {
  for (const method of ['purchase', 'repay']) {
    const x = setup(); x.control.failSave = true;
    await assert.rejects(() => method === 'purchase' ? x.operations.executePurchase(purchase) : x.operations.repay(), /disk failure/);
    assert.equal(x.control.sends, 0); assert.equal(x.events.filter(e => e.type === 'execute').length, 0);
  }
});
test('changed draw, wrong contract, legacy records or altered request keys cannot be recovered as new operations', async () => {
  const x = setup(); await x.operations.repay();
  for (const patch of [s => { s.contract = agent; }, s => { s.guardedRepayment.draw = nextDraw; },
    s => { s.requests.repay = { key: 'legacy' }; }, s => { s.requests.repay.request.data += '00'; }]) {
    const state = structuredClone(x.control.saved); patch(state);
    assert.throws(() => createSettledMainnetCircleOperations({ ...x.options, state },service));
  }
  const state = structuredClone(x.control.saved); state.requests.repay.key = nextDraw;
  const changed = createSettledMainnetCircleOperations({ ...x.options, state },service);
  const before = x.events.length;
  await assert.rejects(() => changed.reconcile(nextDraw), /key changed/);
  assert.equal(x.events.length, before);
});
test('wrong purchase fields and oversized existing allowance cause no execution', async () => {
  const x = setup();
  for (const patch of [{ lineId: nextDraw }, { provider: agent }, { principal: 100000n }, { executor: service.provider }]) {
    const data = encodeFunctionData({ abi, functionName: 'executeSpend', args: [{ ...intent, ...patch }, '0x1234'] });
    await assert.rejects(() => x.operations.executePurchase(data), /scope changed/);
  }
  assert.equal(Object.keys(x.state.requests).length, 0);
  x.control.allowance = 10001n;
  await assert.rejects(() => x.operations.repay(), /Unexpected allowance/);
  assert.equal(x.control.sends, 0);
});

test('settled runner preserves its maximum after partial repayment and rejects excess debt', async () => {
  const x = setup(); x.control.debt = 9999n;
  await x.operations.repay();
  assert.equal(x.control.repaymentPlans.at(-1).amount, '10000');
  const calls = x.events.filter(e => e.type === 'execute');
  assert.equal(decodeFunctionData({abi, data:calls.at(-1).request.data}).args[2], 10000n);
  const y = setup(); y.control.debt = 10001n;
  await assert.rejects(() => y.operations.repay(), /repayment limit/);
  assert.equal(y.control.sends, 0);
});

test('mainnet operation configuration refuses an oversized or mutable service scope',()=>{
 const x=setup();
 for(const patch of [{principal:'50001'},{principal:'0'},{principal:'010000'},{endpoint:'http://provider.example/x'},{endpoint:'https://u:p@provider.example/x'},{provider:'0x0000000000000000000000000000000000000000'}])
  assert.throws(()=>createSettledMainnetCircleOperations(x.options,{...service,...patch}));
 const wrong=structuredClone(x.state);wrong.chainId=5042002;
 assert.throws(()=>createSettledMainnetCircleOperations({...x.options,state:wrong},service),/identity changed/);
});
