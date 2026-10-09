import { decodeEventLog, decodeFunctionData, encodeFunctionData, parseAbi } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import { floatAbi, floatEventAbi } from './float-mainnet-config.mjs';

const accountAbi = parseAbi(['function execute(address target,uint256 value,bytes data)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const must = (ok, message) => { if (!ok) throw new Error(message); };
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const canonicalDecode = (abi, data) => {
  const call = decodeFunctionData({ abi, data });
  must(same(encodeFunctionData({ abi, ...call }), data), 'Noncanonical Circle execution calldata.');
  return call;
};

/** A routed payment is attributable only to its exact successful user operation.
 * Keep the outer sender as the bundler; never relabel it as the agent.
 * Caller first verifies the mined transaction with readExecutionTransaction.
 */
export async function readCircleExecutionAttribution(client, event, tx, shadow) {
  must(same(tx.to, entryPoint07Address) && same(tx.hash, event.transactionHash)
    && same(tx.blockHash, event.blockHash) && tx.blockNumber === event.blockNumber
    && tx.transactionIndex === event.transactionIndex, 'Circle transaction differs from the mined event.');
  must(['ProviderPaid', 'SpendBlocked'].includes(event.event) && hash(event.args?.digest)
    && hash(event.args?.lineId) && Number.isSafeInteger(event.logIndex) && event.logIndex >= 0, 'Circle payment event has no exact log binding.');
  const bundle = canonicalDecode(entryPoint07Abi, tx.input);
  must(bundle.functionName === 'handleOps', 'Unsupported Circle EntryPoint call.');
  const receipt = await client.getTransactionReceipt({ hash: tx.hash });
  must(receipt.status === 'success' && same(receipt.transactionHash, tx.hash)
    && same(receipt.blockHash, event.blockHash) && receipt.blockNumber === event.blockNumber
    && receipt.transactionIndex === event.transactionIndex, 'Circle receipt is not bound to the payment event.');
  const [finalized, block] = await Promise.all([
    client.getBlock({ blockTag: 'finalized' }), client.getBlock({ blockNumber: event.blockNumber }),
  ]);
  must(finalized.number >= event.blockNumber && same(block.hash, event.blockHash), 'Circle execution is not canonical and finalized.');
  const logs = receipt.logs;
  must(Array.isArray(logs) && logs.every((log, i) => Number.isSafeInteger(log.logIndex) && log.logIndex >= 0
    && (!i || log.logIndex > logs[i - 1].logIndex)), 'Circle receipt log ordering is invalid.');
  const index = logs.findIndex(log => log.logIndex === event.logIndex);
  must(index >= 0 && same(logs[index].address, shadow), 'Payment log is missing from its receipt.');
  const payment = decodeEventLog({ abi: floatEventAbi, data: logs[index].data, topics: logs[index].topics });
  must(payment.eventName === event.event && Object.entries(event.args).every(([key, value]) =>
    typeof value === 'string' ? same(payment.args[key], value) : payment.args[key] === value), 'Receipt payment differs from the discovered event.');
  const boundaries = logs.flatMap((log, index) => {
    if (!same(log.address, entryPoint07Address)) return [];
    try {
      const decoded = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
      return ['BeforeExecution', 'UserOperationEvent'].includes(decoded.eventName) ? [{ ...decoded, index }] : [];
    } catch { return []; }
  });
  const before = boundaries.filter(boundary => boundary.index < index).at(-1);
  const after = boundaries.find(boundary => boundary.index > index);
  must(before && after?.eventName === 'UserOperationEvent' && after.args.success === true,
    'Payment is not inside a successful user operation.');
  const matches = [];
  for (const operation of bundle.args[0]) {
    if (!same(operation.sender, after.args.sender)) continue;
    const userOpHash = await client.readContract({ address: entryPoint07Address, abi: entryPoint07Abi,
      functionName: 'getUserOpHash', args: [operation], blockNumber: event.blockNumber });
    if (same(userOpHash, after.args.userOpHash)) matches.push({ operation, userOpHash });
  }
  must(matches.length === 1, 'Circle payment has no unique matching user operation.');
  const { operation, userOpHash } = matches[0];
  must(boundaries.filter(boundary => boundary.eventName === 'UserOperationEvent'
    && same(boundary.args.userOpHash, userOpHash)).length === 1, 'Duplicate Circle user operation receipt.');
  const accountCall = canonicalDecode(accountAbi, operation.callData);
  must(accountCall.functionName === 'execute' && same(accountCall.args[0], shadow)
    && accountCall.args[1] === 0n, 'Circle account called a different target or sent native value.');
  const spend = canonicalDecode(floatAbi, accountCall.args[2]);
  must(spend.functionName === 'executeSpend', 'Circle operation is not a Shadow purchase.');
  const intent = spend.args[0];
  must(same(intent.agent, operation.sender) && same(intent.executor, operation.sender)
    && same(intent.lineId, payment.args.lineId), 'Circle signer, executor or line differs.');
  const digest = await client.readContract({ address: shadow, abi: floatAbi,
    functionName: 'hashSpendIntent', args: [intent], blockNumber: event.blockNumber });
  must(same(digest, payment.args.digest), 'Circle intent does not match the payment digest.');
  if (payment.eventName === 'ProviderPaid') must(same(intent.provider, payment.args.provider)
    && intent.principal === payment.args.principal && intent.dueAt === payment.args.dueAt, 'Circle provider payout differs from the signed purchase.');
  else must(intent.nonce === payment.args.nonce, 'Circle refusal nonce differs from the signed purchase.');
  const status = await client.readContract({ address: shadow, abi: floatAbi,
    functionName: 'receiptStatus', args: [digest], blockNumber: event.blockNumber });
  must(Number(status) === (payment.eventName === 'ProviderPaid' ? 2 : 1), 'Circle payment status is inconsistent.');
  return { route: 'circle-agent-v07', sender: tx.from, executor: intent.executor,
    agent: operation.sender, userOpHash, entryPoint: entryPoint07Address };
}
