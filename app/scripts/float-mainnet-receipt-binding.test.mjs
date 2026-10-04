import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, keccak256, stringToHex, getAddress } from 'viem';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const mod = name => import(pathToFileURL(`${ROOT}/app/scripts/${name}.mjs`));
const { startAnvil, account, runTool } = await mod('float-mainnet-e2e');
const { floatAbi, eip712Domain, SPEND_INTENT_TYPES } = await mod('float-mainnet-config');
const { signReceipt, deliverResult, ACCEPTANCE_KIND, requestIdHashOf } = await mod('float-mainnet-provider');

test('receipt identity must remain bound when payment-log access fails', { timeout: 90000 }, async t => {
  const node = await startAnvil(19780);
  const dir = mkdtempSync(join(tmpdir(), 'shadow-review-receipts-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    node.stop(); rmSync(dir, { recursive: true, force: true });
  });
  const chain = defineChain({ id: 5042002, name: 'isolated local review', nativeCurrency: { name: 'test', symbol: 'test', decimals: 18 }, rpcUrls: { default: { http: [node.rpc] } } });
  const client = createPublicClient({ chain, transport: http(node.rpc, { retryCount: 0 }) });
  const [owner, sponsor, agent, executor, paidProvider, otherProvider] = [0,1,2,3,4,5].map(account);
  const wallet = a => createWalletClient({ account: a, chain, transport: http(node.rpc, { retryCount: 0 }) });
  const artifact = name => JSON.parse(readFileSync(`${ROOT}/contracts/out/${name}.sol/${name}.json`, 'utf8'));
  async function deploy(name, args) {
    const a = artifact(name);
    const hash = await wallet(owner).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    return getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress);
  }
  async function write(a, address, abi, functionName, args) {
    const hash = await wallet(a).writeContract({ address, abi, functionName, args });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
  }
  const usdc = await deploy('MockAsset', ['local USDC', 'USDC', 6]);
  const limits = { protocolReserve: 5000000n, lineReserve: 1000000n, lineSpend: 2000000n, perSpend: 500000n, dailySpend: 1000000n };
  const candidate = await deploy('ShadowFloatMainnet', [usdc, 5042002n, limits, limits, 3600n, 86400n, 172800n]);
  const read = (functionName, args = []) => client.readContract({ address: candidate, abi: floatAbi, functionName, args });
  await write(owner, usdc, artifact('MockAsset').abi, 'mint', [sponsor.address, 100000n]);
  await write(owner, candidate, floatAbi, 'setSponsorAllowed', [sponsor.address, true]);
  await write(sponsor, usdc, erc20Abi, 'approve', [candidate, 100000n]);
  const endpointHash = keccak256(stringToHex('https://local-review.example/report'));
  const now = (await client.getBlock()).timestamp;
  await write(sponsor, candidate, floatAbi, 'openLine', [{ agent: agent.address, reserve: 100000n, lineSpendCap: 100000n, dailySpendCap: 100000n, lineExpiry: now+604800n, maximumRepaymentWindow: 86400n, provider: paidProvider.address, endpointHash, providerPerSpendCap: 50000n, providerDailyCap: 100000n, providerExpiry: now+604800n }]);
  const lineId = await read('activeLineId', [sponsor.address, agent.address]);
  const message = { agent: agent.address, sponsor: sponsor.address, lineId, lineEpoch: 1n, termsHash: await read('currentTermsHash', [lineId, paidProvider.address]), provider: paidProvider.address, endpointHash, principal: 50000n, maximumTotalDebt: 50000n, dueAt: now+7200n, nonce: 1n, signatureExpiry: now+900n, executor: executor.address };
  const signature = await agent.signTypedData({ domain: eip712Domain(5042002n,candidate), types: SPEND_INTENT_TYPES, primaryType: 'SpendIntent', message });
  const paidTx = await wallet(executor).writeContract({address:candidate,abi:floatAbi,functionName:'executeSpend',args:[message,signature]});
  await client.waitForTransactionReceipt({hash:paidTx});
  const digest = await read('hashSpendIntent', [message]);
  const requestId = 'internal-binding-regression';
  const acceptance = await signReceipt(otherProvider, { kind: ACCEPTANCE_KIND, chainId: 5042002n, verifyingContract: candidate, requestId, message: { digest, provider: otherProvider.address, endpointHash, principal: 50000n, requestIdHash: requestIdHashOf(requestId), acceptedAt: now } });
  const result = Buffer.from('local regression fixture');
  const connection = { chainId: 5042002n, address: candidate, client, deployBlock: 0n };
  // With the real payment event available the same fixture is rejected.
  await assert.rejects(deliverResult(connection, { acceptance, account: otherProvider, resultHash: keccak256(result) }), /not this acceptance/);
  // One changed dependency: the log RPC is unavailable, all state reads remain real.
  const degraded = { ...connection, client: { getBlock: p => client.getBlock(p), readContract: p => client.readContract(p), getCode: p => client.getCode(p), getLogs: async () => { throw new Error('isolated log outage'); } } };
  await assert.rejects(deliverResult(degraded, { acceptance, account: otherProvider, resultHash: keccak256(result) }), /binding is unavailable/);
  const realAcceptance = await signReceipt(paidProvider, { kind: ACCEPTANCE_KIND, chainId: 5042002n, verifyingContract: candidate, requestId, message: { digest, provider: paidProvider.address, endpointHash, principal: 50000n, requestIdHash: requestIdHashOf(requestId), acceptedAt: now } });
  const withReceipts = { ...degraded, client: { ...degraded.client, getTransactionReceipt: p => client.getTransactionReceipt(p) } };
  const outcome = await deliverResult(withReceipts, { acceptance: realAcceptance, account: paidProvider, resultHash: keccak256(result), transactionHash: paidTx });
  await assert.rejects(deliverResult(withReceipts, { acceptance, account: otherProvider, resultHash: keccak256(result), transactionHash: paidTx }), /not this acceptance/);
  for (const logs of [[], await client.getLogs({address:usdc,fromBlock:0n,toBlock:'latest'})]) {
    await assert.rejects(deliverResult({...degraded, client:{...degraded.client,getLogs:async()=>logs}}, { acceptance, account: otherProvider, resultHash: keccak256(result) }), /binding is unavailable/);
  }
  const listen = async server => { servers.push(server); await new Promise(r => server.listen(0,'127.0.0.1',r)); return `http://127.0.0.1:${server.address().port}`; };
  const providerUrl = await listen(createServer((req,res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ result: result.toString('base64'), delivery: outcome.delivery })); }));
  const rpc = await listen(createServer(async (req,res) => {
    const chunks=[]; for await (const c of req) chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks));
    const proxy = async item => item.method === 'eth_getLogs'
      ? { jsonrpc:'2.0', id:item.id, error:{code:-32000,message:'isolated log outage'} }
      : await (await fetch(node.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(item)})).json();
    res.setHeader('content-type','application/json'); res.end(JSON.stringify(Array.isArray(body) ? await Promise.all(body.map(proxy)) : await proxy(body)));
  }));
  const acceptancePath=join(dir,'acceptance.json'), out=join(dir,'result.txt');
  writeFileSync(acceptancePath,JSON.stringify(acceptance));
  const fetched=await runTool('request',['fetch','--provider-url',providerUrl,'--digest',digest,'--acceptance',acceptancePath,'--out',out],{ARC_RPC_URL:rpc,FLOAT_MAINNET_EXPECTED_CHAIN_ID:'5042002',FLOAT_MAINNET_ADDRESS:candidate});
  assert.notEqual(fetched.status,0);
  assert.match(JSON.stringify(fetched.json), /binding is unavailable/);
  assert.equal((await import('node:fs')).existsSync(out), false);
  writeFileSync(acceptancePath,JSON.stringify(realAcceptance));
  const recovered=await runTool('request',['fetch','--provider-url',providerUrl,'--digest',digest,'--acceptance',acceptancePath,'--payment-tx',paidTx,'--out',out],{ARC_RPC_URL:rpc,FLOAT_MAINNET_EXPECTED_CHAIN_ID:'5042002',FLOAT_MAINNET_ADDRESS:candidate});
  assert.equal(recovered.status,0,JSON.stringify(recovered.json));
  assert.deepEqual(readFileSync(out),result);
  assert.equal(await client.readContract({address:usdc,abi:erc20Abi,functionName:'balanceOf',args:[otherProvider.address]}),0n);
  assert.equal(await client.readContract({address:usdc,abi:erc20Abi,functionName:'balanceOf',args:[paidProvider.address]}),50000n);
});
