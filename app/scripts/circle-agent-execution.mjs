import { readFailedCircleSessionAttempt } from './circle-agent-mainnet-failure.mjs';
import { randomUUID } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, decodeEventLog, erc20Abi, formatUnits, getAddress, keccak256, parseAbi, parseUnits, stringToHex } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import legacyAbi from './float-mainnet-abi.json' with { type: 'json' };

const TESTNET = 5042002;
export const GUARDED_TESTNET_PURCHASE_FEE_CAP = '50000000000000000'; // 0.05 test USDC, purchase execution only.
export const GUARDED_TESTNET_REPAYMENT_FEE_CAP = '30000000000000000'; // 0.03 test USDC, guarded testnet repayment actions only.
export const circleGuardedRepaymentAbi = [...legacyAbi.filter(x => !(x.type === 'function' && x.name === 'repay')), ...parseAbi([
  'function repayForDraw(bytes32 lineId,bytes32 expectedDraw,uint256 amount)',
  'function currentDrawDigest(bytes32 lineId) view returns (bytes32)',
  'function repaymentBindingVersion() pure returns (uint256)',
  'event DrawRepaid(bytes32 indexed lineId,bytes32 indexed drawDigest,address indexed payer,uint256 amount,uint256 principalRemaining)',
])];
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
export function createCircleAgentExecutor(options) {
  requireThat(options.config.chainId === TESTNET, 'Only Arc testnet is enabled.');
  return createExecutor(options, false);
}

/** Explicit bounded guarded repayment only; does not enable purchases or public onboarding.
 * The same wallet-wide namespace preserves earlier activation/uncertainty barriers.
 */
export function createCircleGuardedRepayer(options) {
  requireThat(options.config.chainId === 5042, 'Only Arc mainnet guarded repayment is enabled.');
  return createExecutor(options, true);
}

/** Separate testnet entry point; shares the original testnet wallet journal and holds.
 * Keeps guarded amount, fee, exact-draw and receipt checks; cannot purchase or activate.
 */
export function createCircleGuardedTestnetRepayer(options) {
  requireThat(options.config.chainId === TESTNET, 'Only Arc testnet guarded repayment is enabled.');
  return createExecutor(options, true, TESTNET);
}

/** One pinned guarded testnet line. Repayment stays in its separate draw-bound adapter. */
export function createCircleGuardedTestnetPurchaser(options) {
  requireThat(options.config.chainId === TESTNET, 'Only Arc testnet guarded purchases are enabled.');
  return createExecutor(options, false, TESTNET, true);
}

/** Separate mainnet purchase boundary. The operator supplies the reviewed monitor guard.
 * Recovery of a saved transaction does not require an unpaused purchase phase.
 */
export function createCircleGuardedMainnetPurchaser(options) {
  requireThat(options.config.chainId === 5042, 'Only Arc mainnet guarded purchases are enabled.');
  requireThat(same(options.config.contract, '0x708c8c987eb4Cd14445Ac2c65ea712b2084888eB')
    && same(options.config.runtimeHash, '0x845c0c3e47bbcf75004e5d47a6788585d57026ce70c08593d112966a6245b4ef'), 'Pin the reviewed guarded mainnet deployment.');
  requireThat(typeof options.authorizePurchase === 'function', 'A mainnet monitor authorization guard is required.');
  return createExecutor(options, false, 5042, true, options.authorizePurchase);
}

function createExecutor({ client, circle, journal, config: suppliedConfig }, guarded, chainId = guarded ? 5042 : TESTNET, purchaseOnly = false, authorizePurchase = null) {
  const config = Object.freeze({ ...suppliedConfig });
  const CHAIN = chainId;
  const network = CHAIN === TESTNET ? 'ARC-TESTNET' : 'ARC';
  const abi = guarded || purchaseOnly ? circleGuardedRepaymentAbi : legacyAbi;
  const agent = getAddress(config.agent), contract = getAddress(config.contract);
  const cap = BigInt(config.maxAmount), feeCap = BigInt(config.maxNetworkFee);
  const maximumFee = CHAIN === TESTNET && purchaseOnly ? BigInt(GUARDED_TESTNET_PURCHASE_FEE_CAP)
    : CHAIN === TESTNET && guarded ? BigInt(GUARDED_TESTNET_REPAYMENT_FEE_CAP)
    : parseUnits(guarded || purchaseOnly ? '0.02' : '0.1', 18);
  requireThat(cap > 0n && cap <= (purchaseOnly ? 5_000n : guarded ? 50_000n : 1_000_000n) && feeCap > 0n && feeCap <= maximumFee, 'Invalid bounded execution limits.');
  if (guarded) requireThat(/^0x[0-9a-fA-F]{64}$/.test(config.expectedLineId) && /^0x[0-9a-fA-F]{64}$/.test(config.expectedDraw) && !/^0x0{64}$/.test(config.expectedDraw), 'Pin the exact line and nonzero reviewed draw.');
  if (purchaseOnly) requireThat(/^0x[0-9a-fA-F]{64}$/.test(config.expectedLineId) && !/^0x0{64}$/.test(config.expectedLineId), 'Pin the exact nonzero purchase line.');
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
    if (purchaseOnly) requireThat(same(to, contract), 'Only a guarded purchase is supported.');
    requireThat(same(to, contract) || same(to, USDC), 'Destination is outside this adapter.');
    const callAbi = same(to, USDC) ? erc20Abi : abi;
    const call = decodeFunctionData({ abi: callAbi, data: request.data });
    requireThat(same(encodeFunctionData({ abi: callAbi, ...call }), request.data), 'Noncanonical calldata.');
    let amount, lineId, digest;
    if (same(to, USDC)) {
      requireThat(call.functionName === 'approve' && same(call.args[0], contract), 'Only exact Shadow allowance is supported.');
      amount = call.args[1];
    } else if (guarded && call.functionName === 'repayForDraw') {
      [lineId, digest, amount] = call.args;
      requireThat(same(lineId, config.expectedLineId) && same(digest, config.expectedDraw), 'Line or reviewed draw changed.');
    } else if (!guarded && call.functionName === 'executeSpend') {
      const intent = call.args[0];
      requireThat(same(intent.agent, agent) && same(intent.executor, agent), 'Purchase belongs to another agent or executor.');
      amount = intent.principal; lineId = intent.lineId;
      if (purchaseOnly) requireThat(same(lineId, config.expectedLineId) && amount === cap && intent.maximumTotalDebt === cap, 'Purchase line or exact amount changed.');
      requireThat(intent.maximumTotalDebt <= cap, 'Debt exceeds adapter limit.');
      requireThat(same(intent.provider, config.provider) && same(intent.endpointHash, config.endpointHash), 'Provider or endpoint is not approved.');
    } else if (!guarded && !purchaseOnly && call.functionName === 'repay') {
      [lineId, amount] = call.args;
    } else throw new Error('Unsupported Shadow operation.');
    requireThat(amount > 0n && (guarded ? amount === cap : amount <= cap), 'Amount exceeds adapter limit.');
    return { to, callAbi, ...call, amount, lineId, digest };
  }
  async function prepare(request) {
    await identity();
    const decoded = decode(request);
    if (guarded) {
      const read = (functionName, args = []) => client.readContract({ address: contract, abi, functionName, args });
      requireThat(await read('repaymentBindingVersion') === 2n && same(await read('currentDrawDigest', [config.expectedLineId]), config.expectedDraw), 'Reviewed draw is stale.');
      const line = await read('getLine', [config.expectedLineId]);
      requireThat(same(line.agent, agent) && [2, 3].includes(Number(line.state)) && line.principalOutstanding >= cap, 'Exact reviewed agent debt required.');
    } else if (purchaseOnly) {
      const read = (functionName, args = []) => client.readContract({ address: contract, abi, functionName, args });
      requireThat(await read('repaymentBindingVersion') === 2n, 'Guarded repayment binding version required.');
      const line = await read('getLine', [config.expectedLineId]);
      requireThat(same(line.agent, agent) && Number(line.state) === 1 && line.principalOutstanding === 0n, 'Exact open agent line with no debt required.');
    } else if (decoded.lineId) {
      const line = await client.readContract({ address: contract, abi, functionName: 'lines', args: [decoded.lineId] });
      const owner = Array.isArray(line) ? line[abi.find(x => x.name === 'lines').outputs.findIndex(x => x.name === 'agent')] : line.agent;
      requireThat(same(owner, agent), 'Funding line belongs to another agent.');
    }
    if (decoded.functionName === 'executeSpend') {
      decoded.digest = await client.readContract({ address: contract, abi, functionName: 'hashSpendIntent', args: [decoded.args[0]] });
      const status = await client.readContract({ address: contract, abi, functionName: 'receiptStatus', args: [decoded.digest] });
      requireThat(Number(status) === 0, 'Purchase already has an onchain receipt; recover it.');
    }
    if (authorizePurchase) await authorizePurchase(decoded.args[0]);
    const simulation = await client.simulateContract({ address: decoded.to, abi: decoded.callAbi, functionName: decoded.functionName, args: decoded.args, account: agent });
    if (decoded.functionName === 'executeSpend') requireThat(simulation.result?.[0] === true, 'Shadow policy refused the purchase.');
    const block = await client.getBlock();
    return { operation: decoded.functionName, amount: decoded.amount.toString(), lineId: decoded.lineId ?? null, digest: decoded.digest ?? (guarded ? config.expectedDraw : null), fromBlock: block.number.toString() };
  }
  function envelope(request, idempotencyKey) {
    return { blockchain: network, sourceAddress: agent, contractAddress: getAddress(request.to), callData: request.data, amount: '0', idempotencyKey };
  }
  function bound(record, response) {
    requireThat(response && response.idempotencyKey === record.request.idempotencyKey, 'Unbound Circle response.');
    requireThat(response.blockchain === network && same(response.sourceAddress, agent) && same(response.contractAddress, record.request.contractAddress), 'Circle response identity mismatch.');
    requireThat(typeof response.id === 'string' && response.id.length > 0, 'Missing Circle transaction ID.');
    requireThat(!record.transactionId || record.transactionId === response.id, 'Circle transaction ID changed.');
    requireThat(!record.txHash || !response.txHash || same(record.txHash, response.txHash), 'Circle transaction hash changed.');
  }
  function validateGuardedRecord(record) {
    if (!guarded && !purchaseOnly) return;
    requireThat(record.request.blockchain === network && same(record.request.sourceAddress, agent), 'Journal network or wallet changed.');
    const decoded = decode({ to: record.request.contractAddress, data: record.request.callData, value: record.request.amount });
    if (purchaseOnly) {
      requireThat(record.expected.operation === 'executeSpend' && record.expected.amount === decoded.amount.toString() && same(record.expected.lineId, config.expectedLineId), 'Journal purchase attribution changed.');
      return;
    }
    requireThat(record.expected.operation === decoded.functionName && record.expected.amount === decoded.amount.toString() && same(record.expected.digest, config.expectedDraw) && (decoded.lineId ? same(record.expected.lineId, decoded.lineId) : record.expected.lineId === null), 'Journal repayment attribution changed.');
  }
  async function verifyReceipt(record, txHash) {
    validateGuardedRecord(record);
    if (purchaseOnly) {
      const decoded = decode({ to: record.request.contractAddress, data: record.request.callData, value: record.request.amount });
      const digest = await client.readContract({ address: contract, abi, functionName: 'hashSpendIntent', args: [decoded.args[0]] });
      requireThat(same(digest, record.expected.digest), 'Journal purchase digest changed.');
    }
    requireThat(/^0x[0-9a-fA-F]{64}$/.test(txHash), 'Invalid transaction hash.');
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    requireThat(receipt.blockNumber >= BigInt(record.expected.fromBlock), 'Receipt predates the request.');
    if (purchaseOnly && CHAIN === 5042) {
      const hasFailure = receipt.status === 'reverted' || receipt.logs.some(log => {
        if (!same(log.address, entryPoint07Address)) return false;
        try { const e=decodeEventLog({abi:entryPoint07Abi,data:log.data,topics:log.topics}); return e.eventName==='UserOperationEvent' && e.args.success===false; } catch { return false; }
      });
      if (hasFailure) {
        const decoded=decode({to:record.request.contractAddress,data:record.request.callData,value:record.request.amount});
        const failed=await readFailedCircleSessionAttempt({client,chainId:5042n,address:contract},
          {message:decoded.args[0],digest:record.expected.digest,txHash},receipt);
        if(failed)return {status:failed,txHash,blockHash:receipt.blockHash,blockNumber:receipt.blockNumber.toString()};
      }
    }
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
    const events = receipt.logs.slice(start + 1, end).flatMap(log => {
      const tokenLog = guarded && same(log.address, USDC);
      if (!same(log.address, record.request.contractAddress) && !(record.expected.operation === 'repayForDraw' && tokenLog)) return [];
      try { return [decodeEventLog({ abi: record.expected.operation === 'approve' || tokenLog ? erc20Abi : abi, data: log.data, topics: log.topics })]; } catch { return []; }
    });
    const matches = events.filter(event => {
      const a = event.args, amount = BigInt(record.expected.amount);
      if (record.expected.operation === 'approve') return event.eventName === 'Approval' && same(a.owner, agent) && same(a.spender, contract) && a.value === amount;
      if (record.expected.operation === 'repayForDraw') return event.eventName === 'DrawRepaid' && same(a.lineId, record.expected.lineId) && same(a.drawDigest, record.expected.digest) && same(a.payer, agent) && a.amount === amount;
      if (record.expected.operation === 'repay') return event.eventName === 'Repaid' && same(a.lineId, record.expected.lineId) && same(a.payer, agent) && a.amount === amount;
      return event.eventName === 'ProviderPaid' && same(a.digest, record.expected.digest) && same(a.lineId, record.expected.lineId) && same(a.provider, config.provider) && a.principal === amount;
    });
    const blocked = record.expected.operation === 'executeSpend' ? events.filter(event => event.eventName === 'SpendBlocked' && same(event.args.digest, record.expected.digest) && same(event.args.lineId, record.expected.lineId)) : [];
    if (blocked.length === 1 && matches.length === 0) {
      requireThat(Number(await client.readContract({ address: contract, abi, functionName: 'receiptStatus', args: [record.expected.digest], blockNumber: receipt.blockNumber })) === 1, 'Blocked receipt is not terminal on chain.');
      return { status: 'blocked', txHash, userOpHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString() };
    }
    if (record.expected.operation === 'repayForDraw') {
      const repayment = matches[0];
      requireThat(events.filter(e => e.eventName === 'Repaid' && same(e.args.lineId, record.expected.lineId) && same(e.args.payer, agent) && e.args.amount === BigInt(record.expected.amount) && e.args.principalRemaining === repayment?.args.principalRemaining).length === 1, 'Missing exact companion repayment event.');
      requireThat(events.filter(e => e.eventName === 'Transfer' && same(e.args.from, agent) && same(e.args.to, contract) && e.args.value === BigInt(record.expected.amount)).length === 1, 'Missing exact agent-to-Shadow token transfer.');
    }
    requireThat(matches.length === 1 && blocked.length === 0, 'Receipt does not prove the exact requested operation.');
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
        validateGuardedRecord(existing);
        requireThat(existing.namespace === namespace && hash(existing.request) === existing.requestHash, 'Execution journal was altered.');
        requireThat(same(existing.request.contractAddress, request.to) && same(existing.request.callData, request.data), 'Operation ID was reused for different calldata.');
        if (existing.notSubmitted !== true) {
          const result = existing.result ? await verifyReceipt(existing, existing.txHash) : { status: 'unknown' };
          return { ...result, key, transactionId: existing.transactionId ?? null };
        }
        requireThat(!existing.transactionId && !existing.txHash && !existing.result, 'Contradictory pre-send journal.');
        // A durable definite pre-send failure permits a fresh explicit attempt.
        // Re-run all policy and fee checks, and create a new Circle idempotency key.
      }
      const active = await journal.get(activeKey);
      requireThat(!active || active === key, 'Reconcile the previous Circle operation first.');
      requireThat(!active || existing, 'Execution barrier exists without its record. Inspect the journal; do not resend.');
      const activation = await journal.get(`${namespace}:activation`);
      if (activation) {
        requireThat(activation.version === 1 && activation.chainId === CHAIN && activation.agent === agent
          && ['unknown', 'not-submitted'].includes(activation.status), 'Activation journal identity or status mismatch.');
        if (activation.status === 'unknown') {
          const walletCode = await client.getCode({ address: agent, blockTag: 'finalized' });
          requireThat(walletCode && walletCode !== '0x', 'Wait for the previous Circle activation to finalize before another wallet operation.');
        }
      }
      const expected = await prepare(request);
      const payload = envelope(request, randomUUID());
      const record = { version: 1, namespace, operationId: request.operationId, request: payload, requestHash: hash(payload), expected, createdAt: new Date().toISOString() };
      try {
        // Estimate is read only. Preserve definite pre-send failures with the
        // exact original request so runner recovery never relies on absence.
        const estimate = await circle.estimate(payload);
        requireThat(typeof estimate.networkFee === 'string' && /^\d+(\.\d{1,18})?$/.test(estimate.networkFee), 'Invalid Circle fee estimate.');
        requireThat(parseUnits(estimate.networkFee, 18) <= feeCap, `Estimated fee exceeds execution budget. Quote: ${estimate.networkFee} USDC; cap: ${formatUnits(feeCap, 18)} USDC.`);
        // Refresh policy after the remote estimate. No spend request if conditions changed.
        await prepare(request);
      } catch (error) {
        record.notSubmitted = true;
        await journal.put(key, record);
        throw error;
      }
      // Save the barrier first. A crash between these two writes fails closed.
      await journal.put(activeKey, key);
      await journal.put(key, record); // A crash/timeout from here never permits automatic resubmission.
      let response;
      try { response = await circle.execute(payload); }
      catch (error) {
        if (error?.beforeSubmission === true) {
          record.notSubmitted = true;
          await journal.put(key, record);
          if (await journal.get(activeKey) === key) await journal.put(activeKey, null);
          return { status: 'not-submitted', key };
        }
        return { status: 'unknown', key, transactionId: null };
      }
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
      validateGuardedRecord(record);
      requireThat(record.namespace === namespace && hash(record.request) === record.requestHash, 'Unknown or altered execution journal.');
      requireThat(requestKey({ operationId: record.operationId }) === key, 'Journal request key mismatch.');
      if (record.notSubmitted === true) {
        requireThat(!record.transactionId && !record.txHash && !record.result, 'Contradictory pre-send journal.');
        if (await journal.get(activeKey) === key) await journal.put(activeKey, null);
        return { status: 'not-submitted', key };
      }
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
