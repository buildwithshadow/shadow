import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, keccak256, stringToHex, getAddress } from 'viem';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const mod = name => import(pathToFileURL(`${ROOT}/app/scripts/${name}.mjs`));
const { startAnvil, account, runTool } = await mod('float-mainnet-e2e');
const { floatAbi, eip712Domain, SPEND_INTENT_TYPES } = await mod('float-mainnet-config');
const { createProviderServer } = await import('../../examples/float-mainnet-provider-server/server.mjs');
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
  // Older stores may contain completed work but no delivery/payment identity.
  // Both client and real provider lose getLogs; the original transaction must
  // cross HTTP, be independently verified, then survive a provider restart.
  const store = join(dir, 'legacy-provider-store'); mkdirSync(store);
  writeFileSync(join(store, `${digest}.acceptance.json`), JSON.stringify(realAcceptance));
  writeFileSync(join(store, `${digest}.result.json`), JSON.stringify({ digest, requestId, result: result.toString('base64'), resultRef: null }));
  let work = 0;
  const makeServer = () => createProviderServer({ connection: withReceipts, account: paidProvider, endpointHash, price: 50000n, storeDir: store, service: async () => { work++; return { result: 'must not repeat' }; } });
  const actualServer = makeServer(); const actualUrl = await listen(actualServer);
  const post = async (base, body) => fetch(`${base}/serve`, {method:'POST', headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(actualUrl, {digest, paymentTransactionHash:'invalid'})).status, 400);
  const wrongTx = `0x${'ab'.repeat(32)}`;
  assert.notEqual((await post(actualUrl, {digest, paymentTransactionHash:wrongTx})).status, 200);
  const fetchedFromServer = await runTool('request', ['fetch','--provider-url',actualUrl,'--digest',digest,'--acceptance',acceptancePath,'--payment-tx',paidTx,'--out',out], {ARC_RPC_URL:rpc,FLOAT_MAINNET_EXPECTED_CHAIN_ID:'5042002',FLOAT_MAINNET_ADDRESS:candidate});
  assert.equal(fetchedFromServer.status, 0, JSON.stringify(fetchedFromServer.json));
  assert.deepEqual(readFileSync(out), result);
  assert.equal(work, 0, 'stored unsigned work is not repeated');
  assert.deepEqual(JSON.parse(readFileSync(join(store, `${digest}.payment.json`), 'utf8')), {transactionHash:paidTx});
  // Also upgrade a legacy fully-delivered store, whose early return must save
  // payment identity before its next hash-free restart recovery.
  unlinkSync(join(store, `${digest}.payment.json`));
  assert.equal((await post(actualUrl, {digest, paymentTransactionHash:paidTx})).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(store, `${digest}.payment.json`), 'utf8')), {transactionHash:paidTx});
  actualServer.closeAllConnections(); await new Promise(r => actualServer.close(r)); servers.splice(servers.indexOf(actualServer),1);
  const restartedUrl = await listen(makeServer());
  const recoveredAfterRestart = await post(restartedUrl, {digest});
  assert.equal(recoveredAfterRestart.status, 200);
  assert.equal((await recoveredAfterRestart.json()).result, result.toString('base64'));
  assert.equal(work, 0);

  // The real production entrypoint starts without the retired signing key.
  // Its store must remain byte-for-byte unchanged, including legacy recovery.
  const { readdirSync } = await import('node:fs');
  const storedBytes = () => Object.fromEntries(readdirSync(store).sort().map(n => [n, readFileSync(join(store,n),'utf8')]));
  const beforeRecovery = storedBytes();
  const child = spawn(process.execPath, ['examples/float-mainnet-provider-server/server.mjs','--recovery-only','--provider',paidProvider.address], {
    cwd: ROOT, env: { PATH: process.env.PATH, ARC_RPC_URL: rpc, FLOAT_MAINNET_EXPECTED_CHAIN_ID:'5042002', FLOAT_MAINNET_ADDRESS:candidate, PROVIDER_ENDPOINT:'https://local-review.example/report', PROVIDER_PRICE:'50000', PROVIDER_STORE_DIR:store, PORT:'0', HOST:'127.0.0.1', PROVIDER_SERVICE:'must-not-load' }, stdio:['ignore','pipe','pipe'],
  });
  t.after(() => child.kill());
  const cliUrl = await new Promise((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error('Recovery CLI did not start')),15000);
    const lines = createInterface({input:child.stdout});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Recovery CLI exited ${code}`));});
    lines.on('line',line=>{try {const v=JSON.parse(line);if(v.listening){clearTimeout(timer);assert.equal(v.mode,'recovery-only');resolve(v.listening);}} catch(e){clearTimeout(timer);reject(e);}});
  });
  const recoveredCli = await post(cliUrl,{digest});
  assert.equal(recoveredCli.status,200,await recoveredCli.clone().text());
  const originalDelivery=JSON.parse(beforeRecovery[`${digest}.delivery.json`]);
  assert.deepEqual(await recoveredCli.json(),{result:result.toString('base64'),delivery:originalDelivery});
  assert.equal((await fetch(`${cliUrl}/accept`,{method:'POST',body:'{}'})).status,503);
  assert.deepEqual(storedBytes(),beforeRecovery,'recovery-only process does not rewrite the restored store');
  const deliveryFile=join(store,`${digest}.delivery.json`);
  unlinkSync(deliveryFile);
  assert.equal((await post(cliUrl,{digest})).status,409,'unsigned work cannot become a new delivery');
  writeFileSync(deliveryFile,beforeRecovery[`${digest}.delivery.json`]);
  const corrupted={...originalDelivery,signature:'0x'+'01'.repeat(65)};
  writeFileSync(deliveryFile,JSON.stringify(corrupted));
  assert.notEqual((await post(cliUrl,{digest})).status,200,'corrupt signature cannot recover output');
  writeFileSync(deliveryFile,beforeRecovery[`${digest}.delivery.json`]);
  const resultFile=join(store,`${digest}.result.json`);
  writeFileSync(resultFile,JSON.stringify({...JSON.parse(beforeRecovery[`${digest}.result.json`]),result:Buffer.from('tampered').toString('base64')}));
  assert.notEqual((await post(cliUrl,{digest})).status,200,'tampered bytes cannot recover');
  writeFileSync(resultFile,beforeRecovery[`${digest}.result.json`]);
  assert.equal((await post(cliUrl,{digest})).status,200);
  const paymentFile=join(store,`${digest}.payment.json`);
  unlinkSync(paymentFile);
  assert.notEqual((await post(cliUrl,{digest})).status,200,'log outage without original transaction stays blocked');
  assert.equal((await post(cliUrl,{digest,paymentTransactionHash:paidTx})).status,200);
  assert.equal((await import('node:fs')).existsSync(paymentFile),false,'read-only recovery does not upgrade legacy storage');
  writeFileSync(paymentFile,beforeRecovery[`${digest}.payment.json`]);
  const acceptanceFile=join(store,`${digest}.acceptance.json`);
  writeFileSync(acceptanceFile,JSON.stringify({...realAcceptance,signature:'0x'+'01'.repeat(65)}));
  assert.notEqual((await post(cliUrl,{digest})).status,200,'corrupt acceptance is rejected');
  writeFileSync(acceptanceFile,beforeRecovery[`${digest}.acceptance.json`]);
  assert.deepEqual(storedBytes(),beforeRecovery);
  assert.equal(work,0);
  const recoveryOptions={connection:withReceipts,account:{address:paidProvider.address},endpointHash,price:50000n,storeDir:store,recoveryOnly:true};
  assert.throws(()=>createProviderServer({...recoveryOptions,account:paidProvider}),/never a signer/);
  const smartUrl=await listen(createProviderServer({...recoveryOptions,connection:{...withReceipts,client:{...withReceipts.client,getCode:async()=> '0x1234'}}}));
  assert.equal((await post(smartUrl,{digest})).status,409,'smart provider recovery remains excluded');
  const unpaidUrl=await listen(createProviderServer({...recoveryOptions,connection:{...withReceipts,client:{...withReceipts.client,readContract:async p=>p.functionName==='receiptStatus'?0:client.readContract(p)}}}));
  assert.equal((await post(unpaidUrl,{digest})).status,402,'saved delivery alone does not prove payment');
  child.kill();

  assert.equal(await client.readContract({address:usdc,abi:erc20Abi,functionName:'balanceOf',args:[otherProvider.address]}),0n);
  assert.equal(await client.readContract({address:usdc,abi:erc20Abi,functionName:'balanceOf',args:[paidProvider.address]}),50000n);
});
