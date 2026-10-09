import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, keccak256, stringToHex } from 'viem';
import { circleGuardedRepaymentAbi as abi } from './circle-agent-execution.mjs';
import { createGuardedCircleOperations } from './circle-agent-guarded-operations.mjs';
import { GUARDED_TESTNET as deployment, GUARDED_TESTNET_SERVICE as service } from '../guardedTestnetDeployment.mjs';
import { parseGuardedAgentArgs, runGuardedAgent } from './shadow-circle-guarded-testnet.mjs';

const agent = `0x${'11'.repeat(20)}`, line = `0x${'22'.repeat(32)}`, draw = `0x${'33'.repeat(32)}`, nextDraw = `0x${'44'.repeat(32)}`;
const intent = { agent, executor: agent, sponsor: service.provider, lineId: line, lineEpoch: 1n, termsHash: draw,
  provider: service.provider, endpointHash: keccak256(stringToHex(service.endpoint)), principal: 5000n,
  maximumTotalDebt: 5000n, dueAt: 2000n, nonce: 0n, signatureExpiry: 1000n };
const purchase = encodeFunctionData({ abi, functionName: 'executeSpend', args: [intent, '0x1234'] });
function setup() {
  const state = { chainId: deployment.chainId, agent, line, contract: deployment.address, requests: {} };
  const events = [], remote = new Map();
  const control = { failSave: false, lose: false, debt: 5000n, draw, allowance: 0n, repaymentPlans: [], saved: null, sends: 0 };
  const executor = kind => ({
    operationKey: r => keccak256(stringToHex(r.operationId)),
    execute: async request => {
      const key = keccak256(stringToHex(request.operationId));
      assert(control.saved && Object.values(control.saved.requests).some(r => r.key === key), 'persist before any remote send');
      if (kind !== 'purchase') assert.equal(control.saved.guardedRepayment.draw, draw, 'persist original draw before allowance');
      events.push({ type: 'execute', kind, request });
      if (!remote.has(key)) { control.sends++; remote.set(key, { status: control.lose ? 'unknown' : 'confirmed', txHash: nextDraw, key }); }
      if (kind === 'approve') control.allowance = 5000n;
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
  return { state, events, remote, control, options, operations: createGuardedCircleOperations(options) };
}
test('guarded runner shares original path parsing, rejects setup and keeps preview commands unsigned', async () => {
  const old = parseGuardedAgentArgs(['inspect', '--agent', agent, '--line', line, '--state', '/tmp/original-shadow-journal']);
  assert.equal(old.state, '/tmp/original-shadow-journal'); assert.equal(old.confirm, false);
  assert.throws(() => parseGuardedAgentArgs(['recover', '--agent', agent, '--line', line, '--confirm']), /read-only/);
  assert.throws(() => parseGuardedAgentArgs(['setup', '--agent', agent]), /Activate through/);
  assert.match((await runGuardedAgent({ command: 'help' })).help, /0.005/);
});
test('purchase is persisted before send and restart recovery never executes again', async () => {
  const x = setup(); x.control.lose = true;
  await assert.rejects(() => x.operations.executePurchase(purchase), /unresolved/);
  const key = x.state.requests.purchase.key;
  const restarted = createGuardedCircleOperations({ ...x.options, state: structuredClone(x.control.saved) });
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
  assert.equal(decoded.functionName, 'repayForDraw'); assert.deepEqual(decoded.args, [line, draw, 5000n]);
  assert.equal((await x.operations.repay()).status, 'no-debt'); assert.equal(x.control.sends, 2);
});
test('unknown allowance blocks repayment and recovery retains its saved draw after chain debt changes', async () => {
  const x = setup(); x.control.lose = true;
  await assert.rejects(() => x.operations.repay(), /unresolved/);
  assert.equal(x.control.sends, 1); assert(!x.state.requests.repay);
  x.control.draw = nextDraw;
  const restored = createGuardedCircleOperations({ ...x.options, state: structuredClone(x.control.saved) });
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
    assert.throws(() => createGuardedCircleOperations({ ...x.options, state }));
  }
  const state = structuredClone(x.control.saved); state.requests.repay.key = nextDraw;
  const changed = createGuardedCircleOperations({ ...x.options, state });
  const before = x.events.length;
  await assert.rejects(() => changed.reconcile(nextDraw), /key changed/);
  assert.equal(x.events.length, before);
});
test('wrong purchase fields and oversized existing allowance cause no execution', async () => {
  const x = setup();
  for (const patch of [{ lineId: nextDraw }, { provider: agent }, { principal: 50000n }, { executor: service.provider }]) {
    const data = encodeFunctionData({ abi, functionName: 'executeSpend', args: [{ ...intent, ...patch }, '0x1234'] });
    await assert.rejects(() => x.operations.executePurchase(data), /scope changed/);
  }
  assert.equal(Object.keys(x.state.requests).length, 0);
  x.control.allowance = 5001n;
  await assert.rejects(() => x.operations.repay(), /Unexpected allowance/);
  assert.equal(x.control.sends, 0);
});
