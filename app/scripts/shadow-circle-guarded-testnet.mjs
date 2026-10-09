#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPublicClient, erc20Abi, getAddress, keccak256, stringToHex } from 'viem';
import { ARC_TESTNET_RPC_URL } from '../arcTestnetNetwork.mjs';
import { GUARDED_TESTNET as deployment, GUARDED_TESTNET_SERVICE as service } from '../guardedTestnetDeployment.mjs';
import { createCandidateFundingKit, candidateFundingChain } from '../src/candidateFunding.ts';
import { createSelfServicePurchase } from '../src/selfServicePurchase.mjs';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';
import { createCircleRunnerState } from './circle-agent-runner-state.mjs';
import { createCircleGuardedTestnetPurchaser, createCircleGuardedTestnetRepayer, GUARDED_TESTNET_PURCHASE_FEE_CAP } from './circle-agent-execution.mjs';
import { createCircleCliTransport, createCircleGuardedTestnetPurchaseTransport } from './circle-agent-cli-transport.mjs';
import { createCircleGuardedTestnetCliTransport } from './circle-agent-guarded-cli.mjs';
import { createGuardedCircleOperations } from './circle-agent-guarded-operations.mjs';
import { createRpcReadTransport } from './rpc-read-transport.mjs';
import { parseAgentArgs, recoverAgentPurchase } from './shadow-circle-agent.mjs';

const must = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function parseGuardedAgentArgs(args) {
  const options = parseAgentArgs(args);
  must(options.command !== 'setup', 'Activate through the existing testnet setup with the same wallet journal, then return here.');
  return options;
}
export async function runGuardedAgent(options) {
  if (options.command === 'help') return { help: 'Guarded Arc testnet only. doctor --agent ADDRESS; inspect|purchase|recover|repay --agent ADDRESS --line LINE. Preserve the original --state directory and isolated --runtime. Only purchase and repay with --confirm can sign or send. Price and repayment are exactly 0.005 test USDC. Network fee estimate ceilings are 0.05 test USDC for purchase and 0.02 per repayment operation; these do not guarantee actual fees. Sponsor admission and funding are separate. This is an engineering runner, not a public mainnet release.' };
  const { agent, line, command } = options;
  const client = createPublicClient({ chain: candidateFundingChain, transport: createRpcReadTransport(ARC_TESTNET_RPC_URL,
    { expectedChainId: deployment.chainId, fallbackUrls: ['https://rpc.blockdaemon.testnet.arc.io', 'https://rpc.drpc.testnet.arc.io'], timeout: 15000,
      queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3000 } }) });
  const kit = createCandidateFundingKit(deployment);
  await kit.verifyCandidate(client);
  must((await client.getCode({ address: service.provider }) ?? '0x') === '0x', 'Only the pinned ordinary provider wallet is supported.');
  const journal = await createCircleAgentJournal(options.state);
  const entrypoint = join(options.runtime, 'node_modules/@circle-fin/cli/dist/index.js');
  if (command === 'doctor') {
    const transport = await createCircleCliTransport({ entrypoint, agent, journal });
    const session = await transport.session();
    const code = await client.getCode({ address: agent, blockTag: 'finalized' });
    return { ...session, contract: deployment.address, deployed: Boolean(code && code !== '0x'), purchasePrice: '0.005 test USDC',
      next: 'This guarded contract requires an admitted sponsor and a separately authorized funding line. No transaction was sent.' };
  }
  const readLine = () => kit.readCandidateLine(client, line);
  const current = await readLine();
  must(same(current.agent, agent), 'The funding line belongs to another agent.');
  const summary = snapshot => ({ chainId: deployment.chainId, contract: deployment.address, agent, lineId: line,
    state: snapshot.stateName, debt: snapshot.principalOutstanding.toString(), reserve: snapshot.availableReserve.toString(),
    drawDigest: snapshot.drawDigest, purchasePrice: '0.005 test USDC', provider: service.provider });
  if (command === 'inspect' || !options.confirm && ['purchase', 'repay'].includes(command)) return { ...summary(current),
    next: 'Nothing signed or sent. Review the exact line and use --confirm only for the intended purchase or repayment.' };
  return journal.withLock(`agent-runner:${agent.toLowerCase()}:${line.toLowerCase()}`, async () => {
    must(!await journal.hasLegacyRunnerState(agent, line), 'Preserve and reconcile legacy runner state before migration.');
    const { state, storage, save, flush } = await createCircleRunnerState({ journal, agent, line, contract: deployment.address });
    try {
      const common = { entrypoint, agent, journal, expectedLineId: line, maxAmount: service.principal };
      const scope = { contract: deployment.address, provider: service.provider, endpointHash: keccak256(stringToHex(service.endpoint)) };
      const config = { chainId: deployment.chainId, agent, ...scope, runtimeHash: deployment.runtimeHash,
        expectedLineId: line, maxAmount: service.principal, maxNetworkFee: '20000000000000000' };
      const transport = await createCircleGuardedTestnetPurchaseTransport({ ...common, ...scope });
      const purchaseExecutor = createCircleGuardedTestnetPurchaser({ client, circle: transport, journal,
        config: { ...config, maxNetworkFee: GUARDED_TESTNET_PURCHASE_FEE_CAP } });
      const operations = createGuardedCircleOperations({ agent, line, state, save, purchaseExecutor, readLine,
        readAllowance: () => client.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'allowance', args: [agent, deployment.address] }),
        makeRepayer: async plan => createCircleGuardedTestnetRepayer({ client, journal, config: { ...config, expectedDraw: plan.draw },
          circle: await createCircleGuardedTestnetCliTransport({ ...common, contract: deployment.address, expectedDraw: plan.draw }) }),
      });
      const wallet = { chain: candidateFundingChain, getChainId: async () => deployment.chainId, getAddresses: async () => [agent],
        request: async ({ method, params }) => { await flush(); must(method === 'eth_signTypedData_v4' && same(params[0], agent), 'Unsupported signing request.'); return transport.signPurchase(params[1], scope); },
        sendTransaction: async request => { await flush(); must(same(request.account, agent) && same(request.to, deployment.address) && BigInt(request.value) === 0n, 'Unexpected guarded purchase transaction.'); return (await operations.executePurchase(request.data)).txHash; },
      };
      const engine = createSelfServicePurchase({ client, wallet, storage, withLock: async (_key, work) => work(),
        fetchImpl: async (...args) => { await flush(); return fetch(...args); },
        config: { chainId: deployment.chainId, account: agent, contract: deployment.address, runtimeHash: deployment.runtimeHash, ...service } });
      if (command === 'recover') return { ...summary(await readLine()), ...await recoverAgentPurchase({ executor: operations, state, engine, client, save }) };
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
  Promise.resolve().then(() => runGuardedAgent(parseGuardedAgentArgs(process.argv.slice(2))))
    .then(value => console.log(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)))
    .catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
