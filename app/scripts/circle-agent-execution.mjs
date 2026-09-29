import { randomUUID } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, decodeEventLog, erc20Abi, getAddress, keccak256, parseAbi, parseUnits, stringToHex } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import abi from './float-mainnet-abi.json' with { type: 'json' };

const CHAIN = 5042002;
const USDC = '0x3600000000000000000000000000000000000000';
const accountAbi = parseAbi(['function execute(address target,uint256 value,bytes data)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const requireThat = (value, message) => { if (!value) throw new Error(message); };
const hash = (value) => keccak256(stringToHex(JSON.stringify(value)));

/** Testnet execution boundary. Circle authentication stays with the injected transport.
 * circle.estimate/execute take raw callData, never stringified tuple parameters.
 * circle.lookup is read-only and returns a response bound to the original idempotency key.
 * journal must durably persist get/put and serialize withLock across processes.
 */
export function createCircleAgentExecutor({ client, circle, journal, config }) {
  requireThat(config.chainId === CHAIN, 'Only Arc testnet is enabled.');
  const agent = getAddress(config.agent), contract = getAddress(config.contract);
  const cap = BigInt(config.maxAmount), feeCap = BigInt(config.maxNetworkFee);
  requireThat(cap > 0n && cap <= 1_000_000n && feeCap > 0n && feeCap <= parseUnits('0.1', 18), 'Invalid testnet limits.');
  requireThat(/^0x[0-9a-fA-F]{64}$/.test(config.runtimeHash), 'Pin the deployed runtime hash.');
  requireThat(['get', 'put', 'withLock'].every(k => typeof journal[k] === 'function'), 'A durable locked journal is required.');
  const namespace = hash({ chainId: CHAIN, agent });
  const activeKey = `${namespace}:active`;

  async function identity() {
    requireThat(await client.getChainId() === CHAIN, 'Wrong chain.');
    const code = await client.getCode({ address: contract });
    requireThat(code && code !== '0x' && same(keccak256(code), config.runtimeHash), 'Unexpected Shadow deployment.');
  }
  function decode(request) {
    requireThat(BigInt(request.value ?? 0) === 0n, 'Native value is not permitted.');
    const to = getAddress(request.to);
    requireThat(same(to, contract) || same(to, USDC), 'Destination is outside this adapter.');
    const callAbi = same(to, USDC) ? erc20Abi : abi;
    const call = decodeFunctionData({ abi: callAbi, data: request.data });
    requireThat(same(encodeFunctionData({ abi: callAbi, ...call }), request.data), 'Noncanonical calldata.');
    let amount, lineId, digest;
    if (same(to, USDC)) {
      requireThat(call.functionName === 'approve' && same(call.args[0], contract), 'Only exact Shadow allowance is supported.');
      amount = call.args[1];
    } else if (call.functionName === 'executeSpend') {
      const intent = call.args[0];
      requireThat(same(intent.agent, agent) && same(intent.executor, agent), 'Purchase belongs to another agent or executor.');
      amount = intent.principal; lineId = intent.lineId;
      requireThat(intent.maximumTotalDebt <= cap, 'Debt exceeds adapter limit.');
      requireThat(same(intent.provider, config.provider) && same(intent.endpointHash, config.endpointHash), 'Provider or endpoint is not approved.');
    } else if (call.functionName === 'repay') {
      [lineId, amount] = call.args;
    } else throw new Error('Unsupported Shadow operation.');
    requireThat(amount > 0n && amount <= cap, 'Amount exceeds adapter limit.');
    return { to, callAbi, ...call, amount, lineId, digest };
  }
  async function prepare(request) {
    await identity();
    const decoded = decode(request);
    if (decoded.lineId) {
      const line = await client.readContract({ address: contract, abi, functionName: 'lines', args: [decoded.lineId] });
      const owner = Array.isArray(line) ? line[abi.find(x => x.name === 'lines').outputs.findIndex(x => x.name === 'agent')] : line.agent;
      requireThat(same(owner, agent), 'Funding line belongs to another agent.');
    }
    if (decoded.functionName === 'executeSpend') {
      decoded.digest = await client.readContract({ address: contract, abi, functionName: 'hashSpendIntent', args: [decoded.args[0]] });
      const status = await client.readContract({ address: contract, abi, functionName: 'receiptStatus', args: [decoded.digest] });
      requireThat(Number(status) === 0, 'Purchase already has an onchain receipt; recover it.');
    }
    const simulation = await client.simulateContract({ address: decoded.to, abi: decoded.callAbi, functionName: decoded.functionName, args: decoded.args, account: agent });
    if (decoded.functionName === 'executeSpend') requireThat(simulation.result?.[0] === true, 'Shadow policy refused the purchase.');
    const block = await client.getBlock();
    return { operation: decoded.functionName, amount: decoded.amount.toString(), lineId: decoded.lineId ?? null, digest: decoded.digest ?? null, fromBlock: block.number.toString() };
  }
  function envelope(request, idempotencyKey) {
    return { blockchain: 'ARC-TESTNET', sourceAddress: agent, contractAddress: getAddress(request.to), callData: request.data, amount: '0', idempotencyKey };
  }
  function bound(record, response) {
    requireThat(response && response.idempotencyKey === record.request.idempotencyKey, 'Unbound Circle response.');
    requireThat(response.blockchain === 'ARC-TESTNET' && same(response.sourceAddress, agent) && same(response.contractAddress, record.request.contractAddress), 'Circle response identity mismatch.');
    requireThat(typeof response.id === 'string' && response.id.length > 0, 'Missing Circle transaction ID.');
    requireThat(!record.transactionId || record.transactionId === response.id, 'Circle transaction ID changed.');
    requireThat(!record.txHash || !response.txHash || same(record.txHash, response.txHash), 'Circle transaction hash changed.');
  }
  async function verifyReceipt(record, txHash) {
    requireThat(/^0x[0-9a-fA-F]{64}$/.test(txHash), 'Invalid transaction hash.');
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    requireThat(receipt.blockNumber >= BigInt(record.expected.fromBlock), 'Receipt predates the request.');
    requireThat(receipt.status === 'success', 'Transaction reverted.');
    const [finalized, canonical, transaction] = await Promise.all([
      client.getBlock({ blockTag: 'finalized' }),
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.getTransaction({ hash: txHash }),
    ]);
    requireThat(finalized.number >= receipt.blockNumber && same(canonical.hash, receipt.blockHash), 'Receipt is not canonical and finalized.');
    requireThat(same(transaction.to, entryPoint07Address) && same(transaction.blockHash, receipt.blockHash), 'Unsupported or reorganized account-abstraction transaction.');
    const bundle = decodeFunctionData({ abi: entryPoint07Abi, data: transaction.input });
    requireThat(bundle.functionName === 'handleOps', 'Only EntryPoint v0.7 handleOps bundles are supported.');
    const operations = bundle.args[0].filter(op => {
      if (!same(op.sender, agent)) return false;
      try {
        const call = decodeFunctionData({ abi: accountAbi, data: op.callData });
        return same(encodeFunctionData({ abi: accountAbi, ...call }), op.callData) && same(call.args[0], record.request.contractAddress) && call.args[1] === 0n && same(call.args[2], record.request.callData);
      } catch { return false; }
    });
    requireThat(operations.length === 1, 'Circle transaction does not identify a unique matching user operation.');
    const userOpHash = await client.readContract({ address: entryPoint07Address, abi: entryPoint07Abi, functionName: 'getUserOpHash', args: [operations[0]], blockNumber: receipt.blockNumber });
    const boundaries = receipt.logs.flatMap((log, index) => {
      if (!same(log.address, entryPoint07Address)) return [];
      try {
        const event = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
        return ['UserOperationEvent', 'BeforeExecution'].includes(event.eventName) ? [{ ...event, index }] : [];
      } catch { return []; }
    });
    const ends = boundaries.filter(x => x.eventName === 'UserOperationEvent' && same(x.args.userOpHash, userOpHash));
    requireThat(ends.length === 1 && same(ends[0].args.sender, agent) && ends[0].args.success === true, 'The requested user operation did not succeed.');
    const end = ends[0].index, start = boundaries.filter(x => x.index < end).at(-1)?.index;
    requireThat(start !== undefined, 'Missing user-operation log boundary.');
    const matches = receipt.logs.slice(start + 1, end).flatMap(log => {
      if (!same(log.address, record.request.contractAddress)) return [];
      try { return [decodeEventLog({ abi: record.expected.operation === 'approve' ? erc20Abi : abi, data: log.data, topics: log.topics })]; } catch { return []; }
    }).filter(event => {
      const a = event.args, amount = BigInt(record.expected.amount);
      if (record.expected.operation === 'approve') return event.eventName === 'Approval' && same(a.owner, agent) && same(a.spender, contract) && a.value === amount;
      if (record.expected.operation === 'repay') return event.eventName === 'Repaid' && same(a.lineId, record.expected.lineId) && same(a.payer, agent) && a.amount === amount;
      return event.eventName === 'ProviderPaid' && same(a.digest, record.expected.digest) && same(a.lineId, record.expected.lineId) && same(a.provider, config.provider) && a.principal === amount;
    });
    requireThat(matches.length === 1, 'Receipt does not prove the exact requested operation.');
    return { status: 'confirmed', txHash, userOpHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString() };
  }
  async function observe(key, record, response) {
    if (!response) return { status: 'unknown', key, transactionId: record.transactionId ?? null };
    bound(record, response);
    record.transactionId = response.id;
    record.circleState = response.state;
    record.txHash = response.txHash ?? record.txHash ?? null;
    await journal.put(key, record); // Persist transaction identity before any RPC read.
    if (!record.txHash) return { status: 'unknown', key, transactionId: record.transactionId };
    const result = await verifyReceipt(record, record.txHash);
    record.result = result;
    await journal.put(key, record);
    if (await journal.get(activeKey) === key) await journal.put(activeKey, null);
    return { ...result, key, transactionId: record.transactionId };
  }
  const requestKey = request => {
    requireThat(typeof request.operationId === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(request.operationId), 'A stable logical operation ID is required.');
    return hash({ namespace, operationId: request.operationId });
  };
  async function execute(request) {
    decode(request);
    const key = requestKey(request);
    return journal.withLock(namespace, async () => {
      await identity();
      const existing = await journal.get(key);
      if (existing) {
        requireThat(existing.namespace === namespace && hash(existing.request) === existing.requestHash, 'Execution journal was altered.');
        requireThat(same(existing.request.contractAddress, request.to) && same(existing.request.callData, request.data), 'Operation ID was reused for different calldata.');
        const result = existing.result ? await verifyReceipt(existing, existing.txHash) : { status: 'unknown' };
        return { ...result, key, transactionId: existing.transactionId ?? null };
      }
      const active = await journal.get(activeKey);
      requireThat(!active || active === key, 'Reconcile the previous Circle operation first.');
      const expected = await prepare(request);
      const payload = envelope(request, randomUUID());
      const estimate = await circle.estimate(payload);
      requireThat(typeof estimate.networkFee === 'string' && /^\d+(\.\d{1,18})?$/.test(estimate.networkFee), 'Invalid Circle fee estimate.');
      requireThat(parseUnits(estimate.networkFee, 18) <= feeCap, 'Estimated fee exceeds testnet budget.');
      // Refresh policy after the remote estimate. No spend request if conditions changed.
      await prepare(request);
      const record = { version: 1, namespace, operationId: request.operationId, request: payload, requestHash: hash(payload), expected, createdAt: new Date().toISOString() };
      // Save the barrier first. A crash between these two writes fails closed.
      await journal.put(activeKey, key);
      await journal.put(key, record); // A crash/timeout from here never permits automatic resubmission.
      let response;
      try { response = await circle.execute(payload); }
      catch { return { status: 'unknown', key, transactionId: null }; }
      return observe(key, record, response);
    });
  }
  async function reconcile(key) {
    return journal.withLock(namespace, async () => {
      await identity();
      const record = await journal.get(key);
      if (!record) {
        requireThat(await journal.get(activeKey) !== key, 'Execution barrier exists without its record. Inspect the journal; do not resend.');
        return { status: 'not-submitted', key };
      }
      requireThat(record.namespace === namespace && hash(record.request) === record.requestHash, 'Unknown or altered execution journal.');
      requireThat(requestKey({ operationId: record.operationId }) === key, 'Journal request key mismatch.');
      if (record.result) {
        const verified = await verifyReceipt(record, record.txHash);
        if (await journal.get(activeKey) === key) await journal.put(activeKey, null);
        return { ...verified, key, transactionId: record.transactionId };
      }
      if (record.txHash) {
        record.result = await verifyReceipt(record, record.txHash);
        await journal.put(key, record);
        if (await journal.get(activeKey) === key) await journal.put(activeKey, null);
        return { ...record.result, key, transactionId: record.transactionId };
      }
      // lookup must only query; absence or timeout never triggers execute again.
      const response = await circle.lookup({ idempotencyKey: record.request.idempotencyKey, transactionId: record.transactionId ?? null });
      return observe(key, record, response);
    });
  }
  return { execute, reconcile, operationKey: requestKey };
}
