import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, keccak256, stringToHex, zeroHash } from 'viem';
import { circleGuardedRepaymentAbi as abi } from './circle-agent-execution.mjs';
import { GUARDED_TESTNET as deployment, GUARDED_TESTNET_SERVICE as service } from '../guardedTestnetDeployment.mjs';

const must = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const amount = BigInt(service.principal);
const endpointHash = keccak256(stringToHex(service.endpoint));
const kinds = ['purchase', 'approve-repay', 'repay'];

/** Orchestration only. Call inside the original journal's runner lock.
 * Inject the verified purchase and exact-draw repayment executors. Records retain
 * their adapter and reviewed draw; recovery never substitutes the current draw.
 */
export function createGuardedCircleOperations({ agent, line, state, save, purchaseExecutor, makeRepayer, readLine, readAllowance }) {
  agent = getAddress(agent);
  must(/^0x[0-9a-fA-F]{64}$/.test(line) && !same(line, zeroHash), 'Exact nonzero line required.');
  must(state.chainId === deployment.chainId && same(state.contract, deployment.address)
    && same(state.agent, agent) && same(state.line, line), 'Guarded runner identity changed.');

  function validatePlan(plan) {
    must(plan?.version === 1 && same(plan.line, line) && /^0x[0-9a-fA-F]{64}$/.test(plan.draw)
      && !same(plan.draw, zeroHash) && plan.amount === service.principal, 'Saved repayment review changed.');
    return plan;
  }
  function requestFor(kind, data) {
    return { operationId: kind === 'purchase' ? `guarded-purchase:${keccak256(data)}` : `${line}:${kind}`,
      to: kind === 'approve-repay' ? deployment.usdc : deployment.address, data, value: '0' };
  }
  function validateRecord(kind, record) {
    must(kinds.includes(kind) && record?.version === 1 && record.kind === kind, 'Unknown guarded operation record.');
    const request = record.request;
    must(request && request.value === '0', 'Saved operation has unexpected native value.');
    const callAbi = kind === 'approve-repay' ? erc20Abi : abi;
    const call = decodeFunctionData({ abi: callAbi, data: request.data });
    const expected = requestFor(kind, request.data);
    must(same(encodeFunctionData({ abi: callAbi, ...call }), request.data)
      && same(request.to, expected.to) && request.operationId === expected.operationId, 'Saved guarded calldata changed.');
    if (kind === 'purchase') {
      must(call.functionName === 'executeSpend' && record.draw === null, 'Wrong purchase operation.');
      const intent = call.args[0];
      must(same(intent.agent, agent) && same(intent.executor, agent) && same(intent.lineId, line)
        && same(intent.provider, service.provider) && same(intent.endpointHash, endpointHash)
        && intent.principal === amount && intent.maximumTotalDebt === amount, 'Purchase scope changed.');
    } else {
      const plan = validatePlan(state.guardedRepayment);
      must(same(record.draw, plan.draw), 'Saved repayment does not match its original reviewed draw.');
      if (kind === 'approve-repay') must(call.functionName === 'approve' && same(call.args[0], deployment.address)
        && call.args[1] === amount, 'Repayment approval changed.');
      else must(call.functionName === 'repayForDraw' && same(call.args[0], line) && same(call.args[1], plan.draw)
        && call.args[2] === amount, 'Repayment calldata changed.');
    }
    return record;
  }
  if (state.guardedRepayment) validatePlan(state.guardedRepayment);
  for (const [kind, record] of Object.entries(state.requests)) validateRecord(kind, record);

  async function executorFor(kind) {
    return kind === 'purchase' ? purchaseExecutor : makeRepayer(validatePlan(state.guardedRepayment));
  }
  async function execute(kind, data) {
    const executor = await executorFor(kind);
    const request = requestFor(kind, data);
    const record = { version: 1, kind, request, draw: kind === 'purchase' ? null : state.guardedRepayment.draw,
      key: executor.operationKey(request) };
    validateRecord(kind, record);
    const previous = state.requests[kind];
    if (previous) must(JSON.stringify(previous) === JSON.stringify(record), 'Recover the original operation before changing its request.');
    else { state.requests[kind] = record; await save(); }
    const result = await executor.execute(request);
    must(result.status === 'confirmed', 'Operation remains unresolved. Run recover; no replacement will be sent.');
    return result;
  }
  async function reconcile(key) {
    const entries = Object.entries(state.requests).filter(([, record]) => record.key === key);
    must(entries.length === 1, 'Recovery needs one original guarded operation.');
    const [kind, record] = entries[0];
    validateRecord(kind, record);
    const executor = await executorFor(kind);
    must(executor.operationKey(record.request) === key, 'Saved operation key changed.');
    return executor.reconcile(key);
  }
  async function repay() {
    // Resolve old execution records before reading or authorizing fresh debt.
    for (const record of Object.values(state.requests)) {
      const result = await reconcile(record.key);
      must(['confirmed', 'blocked', 'not-submitted'].includes(result.status), 'An earlier Circle operation is still unresolved. Run recover.');
    }
    const current = await readLine();
    must(same(current.agent, agent), 'Repayment line belongs to another agent.');
    if (current.principalOutstanding === 0n) return { status: 'no-debt' };
    must([2, 3].includes(Number(current.state)) && current.principalOutstanding === amount,
      'This runner repays exactly 0.005 test USDC of reviewed agent debt.');
    const plan = { version: 1, line, draw: current.drawDigest, amount: service.principal };
    validatePlan(plan);
    if (state.guardedRepayment) must(same(state.guardedRepayment.draw, plan.draw), 'Current debt differs from the original repayment review. Do not rebind it.');
    else { state.guardedRepayment = plan; await save(); }
    const allowance = await readAllowance();
    must(allowance === 0n || allowance === amount, 'Unexpected allowance. Inspect it before repayment.');
    if (allowance === 0n) await execute('approve-repay', encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [deployment.address, amount] }));
    const result = await execute('repay', encodeFunctionData({ abi, functionName: 'repayForDraw', args: [line, state.guardedRepayment.draw, amount] }));
    return { ...result, reviewedDraw: state.guardedRepayment.draw };
  }
  return { executePurchase: data => execute('purchase', data), repay, reconcile };
}
