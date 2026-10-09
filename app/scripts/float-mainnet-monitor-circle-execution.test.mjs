import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, hashTypedData, keccak256, parseAbi } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import { floatAbi, floatEventAbi } from './float-mainnet-config.mjs';
import { readCircleExecutionAttribution } from './float-mainnet-monitor-circle-execution.mjs';

const address = n => `0x${String(n).padStart(40, '0')}`;
const hash = n => `0x${String(n).padStart(64, '0')}`;
const shadow = address(1), agent = address(2), provider = address(3), bundler = address(4);
const lineId = hash(1), txHash = hash(2), blockHash = hash(3);
const accountAbi = parseAbi(['function execute(address target,uint256 value,bytes data)']);
const intent = { agent, sponsor: address(5), lineId, lineEpoch: 1n, termsHash: hash(6), provider,
  endpointHash: hash(7), principal: 5000n, maximumTotalDebt: 5000n, dueAt: 1000n, nonce: 1n, signatureExpiry: 900n, executor: agent };
const types = { SpendIntent: floatAbi.find(f => f.name === 'executeSpend').inputs[0].components.map(({ name, type }) => ({ name, type })) };
const digestFor = message => hashTypedData({ domain: { name: 'ShadowFloatMainnet', version: '1', chainId: 5042002, verifyingContract: shadow }, types, primaryType: 'SpendIntent', message });
const digest = digestFor(intent);
const callData = (message = intent, target = shadow, value = 0n) => encodeFunctionData({ abi: accountAbi, functionName: 'execute',
  args: [target, value, encodeFunctionData({ abi: floatAbi, functionName: 'executeSpend', args: [message, '0x1234'] })] });
const opHash = op => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [op.nonce, op.callData]));
function log(eventAbi, eventName, args, address, logIndex) {
  const event = eventAbi.find(e => e.name === eventName);
  return { address, logIndex, topics: encodeEventTopics({ abi: eventAbi, eventName, args }),
    data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => args[i.name])) };
}
function fixture() {
  const op = { sender: agent, nonce: 1n, initCode: '0x', callData: callData(), accountGasLimits: hash(0),
    preVerificationGas: 1n, gasFees: hash(0), paymasterAndData: '0x', signature: '0x1234' };
  const ops = [op];
  const paymentArgs = { digest, lineId, provider, principal: 5000n, dueAt: 1000n };
  const event = { event: 'ProviderPaid', args: paymentArgs, blockNumber: 100n, blockHash,
    transactionHash: txHash, transactionIndex: 0, logIndex: 11 };
  const boundary = (operation = op, success = true, index = 12) => log(entryPoint07Abi, 'UserOperationEvent',
    { userOpHash: opHash(operation), sender: operation.sender, paymaster: address(0), nonce: operation.nonce,
      success, actualGasCost: 1n, actualGasUsed: 1n }, entryPoint07Address, index);
  const receipt = { status: 'success', transactionHash: txHash, blockHash, blockNumber: 100n, transactionIndex: 0,
    logs: [log(entryPoint07Abi, 'BeforeExecution', {}, entryPoint07Address, 10),
      log(floatEventAbi, 'ProviderPaid', paymentArgs, shadow, 11), boundary()] };
  const tx = { hash: txHash, blockHash, blockNumber: 100n, transactionIndex: 0, to: entryPoint07Address, from: bundler };
  const state = { finalized: 101n, canonicalHash: blockHash, status: 2n, failReceipt: false };
  const client = {
    getTransactionReceipt: async () => { if (state.failReceipt) throw Error('receipt outage'); return receipt; },
    getBlock: async args => args.blockTag ? { number: state.finalized } : { number: 100n, hash: state.canonicalHash },
    readContract: async args => {
      assert.equal(args.blockNumber, 100n);
      if (args.functionName === 'getUserOpHash') { assert.equal(args.address, entryPoint07Address); return opHash(args.args[0]); }
      if (args.functionName === 'hashSpendIntent') { assert.equal(args.address, shadow); return digestFor(args.args[0]); }
      assert.equal(args.functionName, 'receiptStatus'); return state.status;
    },
  };
  const run = () => readCircleExecutionAttribution(client, event,
    { ...tx, input: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [ops, bundler] }) }, shadow);
  return { op, ops, event, receipt, tx, state, client, boundary, run };
}
test('exact successful Circle user operation is attributed without relabeling the bundler', async () => {
  const x = fixture(); const proof = await x.run();
  assert.deepEqual(proof, { route: 'circle-agent-v07', sender: bundler, executor: agent, agent,
    userOpHash: opHash(x.op), entryPoint: entryPoint07Address });
});
test('neighboring successful operations cannot lend their payment or success to a failed request', async () => {
  const x = fixture(); const other = { ...x.op, nonce: 2n, callData: callData({ ...intent, nonce: 2n }) };
  x.ops.push(other); x.receipt.logs = [x.receipt.logs[0], x.receipt.logs[1], x.boundary(other, true), x.boundary(x.op, false, 13)];
  await assert.rejects(x.run, /payment digest/);
  x.receipt.logs = [x.receipt.logs[0], x.receipt.logs[1], x.boundary(x.op, false), x.boundary(other, true, 13)];
  await assert.rejects(x.run, /successful user operation/);
});
for (const [name, change] of [
  ['wrong transaction', x => x.receipt.transactionHash = hash(9)],
  ['wrong block', x => x.receipt.blockHash = hash(9)],
  ['wrong transaction slot', x => x.receipt.transactionIndex = 1],
  ['reverted receipt', x => x.receipt.status = 'reverted'],
  ['unfinalized block', x => x.state.finalized = 99n],
  ['reorg', x => x.state.canonicalHash = hash(9)],
  ['missing receipt', x => x.state.failReceipt = true],
  ['wrong log address', x => x.receipt.logs[1].address = provider],
  ['missing boundary', x => x.receipt.logs.shift()],
  ['wrong log index', x => x.event.logIndex = 99],
  ['unordered logs', x => x.receipt.logs[2].logIndex = 10],
  ['wrong discovered digest', x => x.event.args = { ...x.event.args, digest: hash(9) }],
  ['duplicated user operation', x => x.ops.push(x.op)],
  ['duplicated operation result', x => x.receipt.logs.push(x.boundary(x.op, true, 13))],
  ['inconsistent receipt status', x => x.state.status = 0n],
]) test(`Circle monitoring refuses ${name}`, async () => {
  const x = fixture(); change(x); await assert.rejects(x.run);
});
test('canonical account target, native value, agent, executor and signed payment fields are required', async () => {
  for (const data of [callData(intent, provider), callData(intent, shadow, 1n),
    callData({ ...intent, agent: provider }), callData({ ...intent, executor: provider }),
    callData({ ...intent, provider: agent }), callData({ ...intent, principal: 4000n }),
    callData({ ...intent, lineId: hash(9) }), callData() + '00']) {
    const x = fixture(); x.op.callData = data; x.receipt.logs[2] = x.boundary(); await assert.rejects(x.run);
  }
});
test('terminal Circle refusal is attributed with no paid claim', async () => {
  const x = fixture(); x.event.event = 'SpendBlocked'; x.event.args = { digest, lineId, nonce: 1n, reason: 1 };
  x.receipt.logs[1] = log(floatEventAbi, 'SpendBlocked', x.event.args, shadow, 11); x.state.status = 1n;
  assert.equal((await x.run()).agent, agent);
  x.state.status = 2n; await assert.rejects(x.run, /status is inconsistent/);
});
