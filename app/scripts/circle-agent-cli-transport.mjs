import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getAddress } from 'viem';
import abi from './float-mainnet-abi.json' with { type: 'json' };

const runFile = promisify(execFile);
export const CIRCLE_CLI_SHA256 = '89f8610b586ca929c3419779405b59618c60be10836bc4428d21c75a7c18f6a4';
const USDC = '0x3600000000000000000000000000000000000000';
const CONTRACT = '0xb31d9e17410b10a619b66df0c31f59acbb33b553';
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };

// A reproducible compatibility copy of the unmodified Apache-2.0 Circle CLI.
// Authentication, policy enforcement and version checks are unchanged.
// Install this pinned runtime separately; never point it at a shared/global install.
export function rawCalldataCompatibility(source) {
  requireThat(createHash('sha256').update(source).digest('hex') === CIRCLE_CLI_SHA256, 'Circle CLI source differs from the tested 1.1.4 release. Do not patch an unknown version.');
  const start = source.indexOf('async function handleAgentExecute(');
  const end = source.indexOf('async function handleLocalExecuteEstimate', start);
  requireThat(start >= 0 && end > start, 'Circle CLI execution boundary not found.');
  let section = source.slice(start, end);
  section = section.replace('  const proxyUrl', `  const rawData = readFlagValue(args2, '--shadow-call-data');
  const expectedAgent = readFlagValue(args2, '--shadow-agent');
  if (!rawData || !/^0x[0-9a-fA-F]+$/.test(rawData) || blockchain !== 'ARC-TESTNET' || !['${CONTRACT}','${USDC}'].includes(contractAddress.toLowerCase()) || !expectedAgent || wallet.address.toLowerCase() !== expectedAgent.toLowerCase() || value !== '0') throw new Error('Shadow testnet compatibility scope mismatch');
  const proxyUrl`);
  const pattern = /abiFunctionSignature,\s*abiParameters: abiParameters.length > 0 \? abiParameters : void 0,/g;
  requireThat([...section.matchAll(pattern)].length === 2, 'Unexpected Circle CLI request shape.');
  section = section.replace(pattern, 'callData: rawData,');
  return source.slice(0, start) + section + source.slice(end);
}

export function unwrapCircle(value) { return value?.data ?? value; }

export async function createCircleCliTransport({ entrypoint, agent, journal, run = runFile }) {
  const address = getAddress(agent);
  const source = await readFile(entrypoint, 'utf8');
  const patched = rawCalldataCompatibility(source);
  const compatibility = join(dirname(entrypoint), 'shadow-testnet-compatibility.js');
  const temp = `${compatibility}.${process.pid}.tmp`;
  await writeFile(temp, patched, { mode: 0o600 });
  await rename(temp, compatibility);
  return createCircleCliDriver({ entrypoint, compatibility, agent: address, journal, run });
}

// Split from preparation so transport behavior can be tested without authentication or npm downloads.
export function createCircleCliDriver({ entrypoint, compatibility, agent, journal, run = runFile }) {
  const address = getAddress(agent);
  async function command(args, raw = false) {
    try {
      const { stdout } = await run(process.execPath, [raw ? compatibility : entrypoint, ...args, '--output', 'json'], { encoding: 'utf8', timeout: 150_000, maxBuffer: 2_000_000 });
      return unwrapCircle(JSON.parse(stdout));
    } catch {
      // Child-process errors can contain signatures or session details; never echo them.
      throw new Error('Circle command did not return a reliable result. Check Circle status in your own terminal; do not resend an unresolved transaction.');
    }
  }
  function args(request) {
    requireThat(request.blockchain === 'ARC-TESTNET' && getAddress(request.sourceAddress) === address && request.amount === '0', 'Circle transport identity mismatch.');
    requireThat([CONTRACT, USDC].includes(request.contractAddress.toLowerCase()), 'Unsupported Circle destination.');
    requireThat(/^0x[0-9a-fA-F]+$/.test(request.callData), 'Invalid calldata.');
    return ['wallet', 'execute', 'shadowRawCall()', '--contract', request.contractAddress, '--address', address, '--chain', 'ARC-TESTNET', '--shadow-agent', address, '--shadow-call-data', request.callData];
  }
  async function session() {
    const status = await command(['wallet', 'status', '--type', 'agent']);
    requireThat(status?.testnet?.tokenStatus === 'VALID', 'No valid Circle testnet session. Run Circle wallet login with --testnet privately.');
    const listing = await command(['wallet', 'list', '--type', 'agent', '--chain', 'ARC-TESTNET']);
    const wallets = Array.isArray(listing) ? listing : listing?.wallets;
    requireThat(Array.isArray(wallets) && wallets.some(w => w.address?.toLowerCase() === address.toLowerCase()), 'This address is not in the logged-in Circle Agent Wallet account.');
    return { agent: address, chainId: 5042002, authenticated: true };
  }
  return {
    session,
    command,
    async estimate(request) { await session(); const r = await command([...args(request), '--estimate'], true); return { networkFee: r?.medium?.networkFee }; },
    async execute(request) {
      await session();
      const key = `circle-response:${request.idempotencyKey}`;
      const response = await command([...args(request), '--idempotency-key', request.idempotencyKey], true);
      // Keep a second durable copy before handing the response to the execution adapter.
      await journal.put(key, response);
      return response;
    },
    async lookup({ idempotencyKey, transactionId }) {
      const saved = await journal.get(`circle-response:${idempotencyKey}`);
      if (!saved || saved.idempotencyKey !== idempotencyKey || (transactionId && saved.id !== transactionId)) return null;
      if (saved.txHash) return saved;
      // History is read-only; bind using the already-persisted Circle ID, never only amount/address.
      const history = await command(['transaction', 'list', '--address', address, '--chain', 'ARC-TESTNET', '--limit', '50']);
      const found = history?.transactions?.find(t => t.id === saved.id);
      if (!found) return saved;
      const result = { ...found, idempotencyKey };
      await journal.put(`circle-response:${idempotencyKey}`, result);
      return result;
    },
    async signPurchase(payload, { contract, provider, endpointHash }) {
      await session();
      const typed = JSON.parse(payload), m = typed.message;
      const expectedTypes = abi.find(f => f.name === 'executeSpend').inputs[0].components.map(({ name, type }) => ({ name, type }));
      requireThat(JSON.stringify(typed.types?.SpendIntent) === JSON.stringify(expectedTypes), 'Unexpected SpendIntent schema.');
      requireThat(typed.primaryType === 'SpendIntent' && typed.domain?.name === 'ShadowFloatMainnet' && typed.domain?.version === '1' && Number(typed.domain.chainId) === 5042002 && getAddress(typed.domain.verifyingContract) === getAddress(contract), 'Unexpected signing domain.');
      requireThat(getAddress(m.agent) === address && getAddress(m.executor) === address && getAddress(m.provider) === getAddress(provider) && m.endpointHash.toLowerCase() === endpointHash.toLowerCase() && BigInt(m.principal) === 50000n && BigInt(m.maximumTotalDebt) === 50000n, 'Signing request exceeds the bounded test service.');
      const result = await command(['wallet', 'sign', 'typed-data', payload, '--address', address, '--chain', 'ARC-TESTNET']);
      requireThat(typeof result?.signature === 'string' && /^0x[0-9a-fA-F]+$/.test(result.signature), 'Circle returned no valid signature.');
      return result.signature;
    },
  };
}
