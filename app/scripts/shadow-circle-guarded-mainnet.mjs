#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPublicClient, erc20Abi, getAddress, keccak256, stringToHex } from 'viem';
import { GUARDED_MAINNET as deployment, GUARDED_MAINNET_SERVICE as service } from '../src/guardedMainnet.ts';
import { createGuardedMainnetFundingKit, guardedMainnetChain } from '../src/candidateFunding.ts';
import { createGuardedMainnetPurchase } from '../src/selfServicePurchase.mjs';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';
import { createCircleRunnerState } from './circle-agent-runner-state.mjs';
import { createCircleGuardedMainnetPurchaser, createCircleGuardedRepayer } from './circle-agent-execution.mjs';
import { createCircleGuardedMainnetPurchaseTransport } from './circle-agent-cli-transport.mjs';
import { createCircleGuardedCliTransport } from './circle-agent-guarded-cli.mjs';
import { createGuardedMainnetCircleOperations } from './circle-agent-guarded-operations.mjs';
import { createRpcReadTransport } from './rpc-read-transport.mjs';
import { assertHealthySpendMonitor } from './float-mainnet-monitor-spend-guard.mjs';
import { reconcileOriginalMainnetCirclePurchase } from './circle-agent-mainnet-recovery.mjs';
import { createMainnetCircleSessionGuard, mainnetCircleSessionIntent } from './circle-agent-mainnet-session.mjs';
import { decodeFunctionData } from 'viem';
import { circleGuardedRepaymentAbi } from './circle-agent-execution.mjs';
import { parseAgentArgs, recoverAgentPurchase } from './shadow-circle-agent.mjs';

const must = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function parseGuardedMainnetArgs(args) {
  const filtered = [], monitor = {};
  const names = { '--monitor-baseline': 'baselinePath', '--monitor-manifest': 'manifestPath', '--monitor-state': 'stateDir', '--session-policy': 'sessionPath' };
  for (let i=0; i<args.length; i++) {
    const key = names[args[i]];
    if (!key) { filtered.push(args[i]); continue; }
    must(!monitor[key] && args[i+1] && !args[i+1].startsWith('--'), 'Missing or repeated monitor option.');
    monitor[key] = resolve(args[++i]);
  }
  const options = parseAgentArgs(filtered);
  if (options.command === 'help') return options;
  must(options.command !== 'setup', 'Activate and authenticate mainnet separately; this runner cannot activate or change policies.');
  must(filtered.includes('--state'), 'Specify the original mainnet wallet --state directory. Do not create another journal to bypass a hold.');
  must(options.line && !/^0x0{64}$/.test(options.line), 'Pin the exact nonzero mainnet line, including for doctor.');
  if (options.command === 'recover') must(monitor.sessionPath, 'Recovery requires the original --session-policy path; it does not require a spend-enabled monitor.');
  if (options.command === 'purchase' && options.confirm) must(Object.values(names).every(key => monitor[key]), 'Confirmed mainnet purchase requires all four reviewed monitor and session paths.');
  return { ...options, monitor };
}
export const createMainnetRunnerPurchase = createGuardedMainnetPurchase;
export async function runGuardedMainnetAgent(options) {
  if (options.command === 'help') return { help: 'Controlled Arc MAINNET only, chain 5042. doctor|inspect|purchase|recover|repay --agent ADDRESS --line LINE --state ORIGINAL_JOURNAL --runtime ISOLATED_RUNTIME. Only purchase or repay with --confirm can sign or send. Purchase requires --monitor-baseline, --monitor-manifest, --monitor-state and --session-policy. Price 0.005 USDC, reserve 0.10 USDC, fee estimate cap 0.02 USDC per operation. No activation, policy setters, admission, funding, unpause or journal reset. No new mainnet access is granted by installing this runner.' };
  const { agent, line, command } = options;
  const client = createPublicClient({ chain: guardedMainnetChain, transport: createRpcReadTransport(guardedMainnetChain.rpcUrls.default.http[0],
    { expectedChainId: deployment.chainId, fallbackUrls: guardedMainnetChain.rpcUrls.default.http.slice(1), timeout: 15000,
      queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3000 } }) });
  const kit = createGuardedMainnetFundingKit(deployment);
  await kit.verifyCandidate(client);
  must((await client.getCode({ address: service.provider }) ?? '0x') === '0x', 'Only the pinned ordinary provider wallet is supported.');
  const connection = { client, address: deployment.address, chainId: 5042n };
  const sessionGuard = options.monitor?.sessionPath ? createMainnetCircleSessionGuard({
    sessionPath: options.monitor.sessionPath, connection,
    monitor: (struct, sessionPolicy) => assertHealthySpendMonitor({ ...options.monitor, sessionPolicy, connection, struct }),
  }) : null;
  const authorizePurchase = struct => {
    must(sessionGuard, 'Reviewed mainnet execution session configuration is required before spending.');
    return sessionGuard.check(struct);
  };
  const journal = await createCircleAgentJournal(options.state);
  const entrypoint = join(options.runtime, 'node_modules/@circle-fin/cli/dist/index.js');
  if (command === 'doctor') {
    const transport = await createCircleGuardedMainnetPurchaseTransport({ entrypoint, agent, journal, expectedLineId: line, provider: service.provider, endpointHash: keccak256(stringToHex(service.endpoint)), maxAmount: service.principal, beforeExecute: async () => { throw new Error('Doctor cannot submit.'); }, beforeSign: async () => { throw new Error('Doctor cannot sign.'); } });
    const session = await transport.session();
    const code = await client.getCode({ address: agent, blockTag: 'finalized' });
    return { ...session, contract: deployment.address, deployed: Boolean(code && code !== '0x'), purchasePrice: '0.005 USDC',
      next: 'This guarded contract requires an admitted sponsor and a separately authorized funding line. No transaction was sent.' };
  }
  const readLine = () => kit.readCandidateLine(client, line);
  const current = await readLine();
  must(same(current.agent, agent), 'The funding line belongs to another agent.');
  const summary = snapshot => ({ chainId: deployment.chainId, contract: deployment.address, agent, lineId: line,
    state: snapshot.stateName, debt: snapshot.principalOutstanding.toString(), reserve: snapshot.availableReserve.toString(),
    drawDigest: snapshot.drawDigest, purchasePrice: '0.005 USDC', provider: service.provider });
  if (command === 'inspect' || !options.confirm && ['purchase', 'repay'].includes(command)) return { ...summary(current),
    next: 'Nothing signed or sent. Review the exact line and use --confirm only for the intended purchase or repayment.' };
  return journal.withLock(`agent-runner:${agent.toLowerCase()}:${line.toLowerCase()}`, async () => {
    must(!await journal.hasLegacyRunnerState(agent, line), 'Preserve and reconcile legacy runner state before migration.');
    const { state, storage, save, flush } = await createCircleRunnerState({ journal, agent, line, contract: deployment.address, chainId: 5042 });
    try {
      const common = { entrypoint, agent, journal, expectedLineId: line, maxAmount: service.principal };
      const scope = { contract: deployment.address, provider: service.provider, endpointHash: keccak256(stringToHex(service.endpoint)) };
      const config = { chainId: deployment.chainId, agent, ...scope, runtimeHash: deployment.runtimeHash,
        expectedLineId: line, maxAmount: service.principal, maxNetworkFee: '20000000000000000' };
      const transport = await createCircleGuardedMainnetPurchaseTransport({ ...common, ...scope, beforeSign: typed => authorizePurchase(typed.message), beforeExecute: request => sessionGuard.reserve(decodeFunctionData({ abi: circleGuardedRepaymentAbi, data: request.callData }).args[0]) });
      const purchaseExecutor = createCircleGuardedMainnetPurchaser({ client, circle: transport, journal, config, authorizePurchase });
      const operations = createGuardedMainnetCircleOperations({ agent, line, state, save, purchaseExecutor, readLine,
        readAllowance: () => client.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'allowance', args: [agent, deployment.address] }),
        makeRepayer: async plan => createCircleGuardedRepayer({ client, journal, config: { ...config, expectedDraw: plan.draw },
          circle: await createCircleGuardedCliTransport({ ...common, contract: deployment.address, expectedDraw: plan.draw }) }),
      });
      const wallet = { chain: guardedMainnetChain, getChainId: async () => deployment.chainId, getAddresses: async () => [agent],
        request: async ({ method, params }) => { await flush(); must(method === 'eth_signTypedData_v4' && same(params[0], agent), 'Unsupported signing request.'); return transport.signPurchase(params[1], scope); },
        sendTransaction: async request => { await flush(); must(same(request.account, agent) && same(request.to, deployment.address) && BigInt(request.value) === 0n, 'Unexpected guarded purchase transaction.'); const result = await operations.executePurchase(request.data);
          const { digest } = mainnetCircleSessionIntent(decodeFunctionData({ abi: circleGuardedRepaymentAbi, data: request.data }).args[0], connection);
          await sessionGuard.recordOutcome(digest, result.txHash);
          return result.txHash; },
      };
      const engine = createMainnetRunnerPurchase({ client, wallet, storage, withLock: async (_key, work) => work(),
        fetchImpl: async (...args) => { await flush(); return fetch(...args); },
        config: { chainId: deployment.chainId, account: agent, contract: deployment.address, runtimeHash: deployment.runtimeHash, ...service } });
      if (command === 'recover') {
        const record=engine.load(), originalRequest=state.requests.purchase;
        const sync=()=>reconcileOriginalMainnetCirclePurchase({journal,requestRecord:originalRequest,purchaseRecord:record,agent,sessionGuard});
        await sync();
        let recovered;
        try { recovered=await recoverAgentPurchase({ executor: operations, state, engine, client, save }); }
        finally { await sync(); }
        return { ...summary(await readLine()), ...recovered };
      }
      if (command === 'repay') { const repayment = await operations.repay(); return { ...summary(await readLine()), repayment }; }
      must(command === 'purchase' && options.confirm, 'Explicit purchase confirmation is required.');
      await transport.session();
      if (!engine.load()) await engine.prepare(line, `arc-wallet:${randomUUID().replaceAll('-', '')}:${getAddress(agent)}`);
      await flush();
      if (['submitted', 'delivered'].includes(engine.load().stage)) return { ...summary(await readLine()), next: 'A purchase is already recorded. Run recover; no second payment was sent.' };
      await engine.submit();
      const delivery = await engine.recover();
      return { ...summary(await readLine()), paymentStatus: delivery.status, transaction: delivery.record.txHash,
        report: delivery.bytes ? new TextDecoder().decode(delivery.bytes) : undefined };
    } finally { await flush(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => runGuardedMainnetAgent(parseGuardedMainnetArgs(process.argv.slice(2))))
    .then(value => console.log(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)))
    .catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
