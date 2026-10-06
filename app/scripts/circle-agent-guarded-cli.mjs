import { circleCliEnvironment } from './circle-agent-cli-environment.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { freezeCircleCliSource } from './circle-agent-cli-runtime.mjs';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { CIRCLE_CLI_SHA256, unwrapCircle } from './circle-agent-cli-transport.mjs';
import { circleGuardedRepaymentAbi } from './circle-agent-execution.mjs';

const USDC = '0x3600000000000000000000000000000000000000';
const runFile = promisify(execFile);
const must = (v, m) => { if (!v) throw new Error(m); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Uses ordinary scalar CLI arguments, without patching its raw calldata handling. */
export async function createCircleGuardedCliTransport(options) {
  const original = resolve(options.entrypoint);
  const source = await readFile(original);
  must(createHash('sha256').update(source).digest('hex') === CIRCLE_CLI_SHA256,
    'Circle CLI differs from the reviewed runtime; review the new version before use.');
  const entrypoint = await freezeCircleCliSource(source, original, options.runtimeDirectory ?? options.journal?.runtimeDirectory);
  return createCircleGuardedCliDriver({ ...options, entrypoint });
}

/** Injection boundary for tests. CLI authentication and policies remain external. */
export function createCircleGuardedCliDriver({ entrypoint, agent, contract, maxAmount, expectedLineId, expectedDraw, journal, run = runFile }) {
  const address = getAddress(agent), shadow = getAddress(contract);
  const cap = BigInt(maxAmount);
  must(cap > 0n && cap <= 50_000n && /^0x[0-9a-fA-F]{64}$/.test(expectedLineId)
    && /^0x[0-9a-fA-F]{64}$/.test(expectedDraw) && !/^0x0{64}$/.test(expectedDraw), 'Pin the bounded amount, line and nonzero reviewed draw.');
  must(typeof entrypoint === 'string' && entrypoint.length > 0, 'Circle runtime is required.');
  must(journal && typeof journal.get === 'function' && typeof journal.put === 'function', 'Durable response journal is required.');
  async function command(args) {
    const environment = circleCliEnvironment();
    try {
      const { stdout } = await run(process.execPath, [entrypoint, ...args, '--output', 'json'], {
        env: environment, cwd: dirname(entrypoint), encoding: 'utf8', timeout: 150_000, maxBuffer: 2_000_000,
      });
      return unwrapCircle(JSON.parse(stdout));
    } catch {
      throw new Error('Circle did not return a reliable result. Keep the original request; do not resend an unresolved repayment.');
    }
  }
  function argumentsFor(request) {
    must(request.blockchain === 'ARC' && same(request.sourceAddress, address) && request.amount === '0', 'Circle mainnet transport identity mismatch.');
    const token = same(request.contractAddress, USDC);
    must(token || same(request.contractAddress, shadow), 'Unsupported Circle destination.');
    const abi = token ? erc20Abi : circleGuardedRepaymentAbi;
    const call = decodeFunctionData({ abi, data: request.callData });
    must(same(encodeFunctionData({ abi, ...call }), request.callData), 'Noncanonical repayment calldata.');
    if (token) must(call.functionName === 'approve' && same(call.args[0], shadow), 'Only exact Shadow approval is supported.');
    else must(call.functionName === 'repayForDraw', 'Only draw-bound repayment is supported.');
    must((token ? call.args[1] : call.args[2]) === cap, 'Repayment or allowance amount changed.');
    if (!token) must(same(call.args[0], expectedLineId) && same(call.args[1], expectedDraw), 'Reviewed repayment line or draw changed.');
    const signature = token ? 'approve(address,uint256)' : 'repayForDraw(bytes32,bytes32,uint256)';
    return ['wallet', 'execute', signature, ...call.args.map(String), '--contract', request.contractAddress,
      '--address', address, '--chain', 'ARC', '--amount', '0'];
  }
  async function session() {
    const status = await command(['wallet', 'status', '--type', 'agent']);
    must(status?.mainnet?.tokenStatus === 'VALID', 'No valid Circle mainnet session. Authenticate privately in Terminal.');
    const listing = await command(['wallet', 'list', '--type', 'agent', '--chain', 'ARC']);
    const wallets = Array.isArray(listing) ? listing : listing?.wallets;
    must(Array.isArray(wallets) && wallets.some(w => same(w.address, address)), 'Wallet is not in this Circle account.');
    return { authenticated: true, chainId: 5042, agent: address };
  }
  return {
    session,
    async estimate(request) {
      const args = argumentsFor(request);
      await session();
      const result = await command([...args, '--estimate']);
      must(result?.blockchain === 'ARC', 'Circle fee estimate network mismatch.');
      return { networkFee: result?.medium?.networkFee };
    },
    async execute(request) {
      const args = argumentsFor(request);
      must(/^[0-9a-f-]{36}$/i.test(request.idempotencyKey), 'Invalid original request identity.');
      try { await session(); }
      catch {
        const error = new Error('Circle mainnet authentication failed before submission. Restore access privately.');
        error.beforeSubmission = true; throw error;
      }
      const result = await command([...args, '--idempotency-key', request.idempotencyKey]);
      // A write failure here is uncertain: the execution adapter retains its barrier.
      await journal.put(`circle-response:${request.idempotencyKey}`, result);
      return result;
    },
    async lookup({ idempotencyKey, transactionId }) {
      const saved = await journal.get(`circle-response:${idempotencyKey}`);
      if (!saved) return null; // No supported remote lookup by key is assumed.
      must(saved.idempotencyKey === idempotencyKey && (!transactionId || saved.id === transactionId), 'Saved Circle response identity mismatch.');
      if (saved.txHash) return saved;
      const history = await command(['transaction', 'list', '--address', address, '--chain', 'ARC', '--limit', '50']);
      const found = history?.transactions?.find(t => t.id === saved.id);
      if (!found) return saved;
      const result = { ...found, idempotencyKey };
      await journal.put(`circle-response:${idempotencyKey}`, result);
      return result;
    },
  };
}
