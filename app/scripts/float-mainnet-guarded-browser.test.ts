import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {createPublicClient,createTestClient,createWalletClient,decodeFunctionData,getAddress,http,keccak256,stringToHex,toHex,zeroHash,zeroAddress,type Address} from 'viem'
// @ts-expect-error shared Anvil fixture is JavaScript
import {account,startAnvil,e2eSkip} from './float-mainnet-e2e.mjs'
import {CANDIDATE_FUNDING as TESTNET_FUNDING,candidateFundingAbi,candidateFundingChain as testnetFundingChain,guardedMainnetChain,createCandidateFundingKit,createGuardedMainnetFundingKit,type CandidateWalletClient,type CandidateOpenInput} from '../src/candidateFunding.ts'
import {GUARDED_MAINNET} from '../src/guardedMainnet.ts'
import {GUARDED_TESTNET} from '../src/guardedTestnet.ts'
const guardedArtifact=JSON.parse(readFileSync(new URL('../../contracts/out/ShadowFloatMainnetGuarded.sol/ShadowFloatMainnetGuarded.json',import.meta.url),'utf8'))
const input: CandidateOpenInput = { agent:account(2).address,provider:account(3).address,endpoint:'https://provider.example/result',reserve:'0.10',lineSpendCap:'0.15',dailySpendCap:'0.10',providerPerSpendCap:'0.05',providerDailyCap:'0.10',expiryDays:'7',repaymentHours:'24'}
const typeString='SpendIntent(address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor)'
for(const profile of ['legacy-testnet','guarded-testnet','guarded-mainnet']) test(`${profile} participant repayment binds the draw and recovers a lost wallet confirmation without resending`, { skip: e2eSkip, timeout: 60_000 }, async () => {
  const mainnet = profile === 'guarded-mainnet'
  const bounded = profile !== 'legacy-testnet'
  const CANDIDATE_FUNDING = mainnet ? GUARDED_MAINNET : bounded ? GUARDED_TESTNET : TESTNET_FUNDING
  const candidateFundingChain = mainnet ? guardedMainnetChain : testnetFundingChain
  const price = bounded ? 5_000n : 50_000n
  const anvil = await startAnvil(18581, [], BigInt(CANDIDATE_FUNDING.chainId))
  try {
    const owner = account(0), sponsorAccount = account(6), agentAccount = account(2), providerAccount = account(3)
    const publicClient = createPublicClient({ chain: candidateFundingChain, transport: http(anvil.rpc), cacheTime: 0, pollingInterval: 20 })
    const testClient = createTestClient({ chain: candidateFundingChain, mode: 'anvil', transport: http(anvil.rpc) })
    const localWallet = (who: any) => createWalletClient({ account: who, chain: candidateFundingChain, transport: http(anvil.rpc) })
    // Use unlocked JSON-RPC accounts to exercise the same sendTransaction shape
    // as an injected browser wallet. Local deterministic accounts never leave
    // this isolated Anvil; no funded user wallet or external RPC is involved.
    const injectedWallet = (who: Address) => ({
      getAddresses: async () => [who],
      getChainId: async () => CANDIDATE_FUNDING.chainId,
      request: (request: any) => createWalletClient({ account: who, chain: candidateFundingChain, transport: http(anvil.rpc) }).request(request),
      sendTransaction: (request: any) => createWalletClient({ account: who, chain: candidateFundingChain, transport: http(anvil.rpc) }).sendTransaction(request),
    }) as CandidateWalletClient
    async function deploy(compiled: any, args: any[]) {
      const hash = await localWallet(owner).deployContract({ account: owner, chain: candidateFundingChain, abi: compiled.abi, bytecode: compiled.bytecode.object, args })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      assert.equal(receipt.status, 'success')
      return receipt.contractAddress!
    }
    async function copyDeployment(from: Address, to: Address) {
      await testClient.setCode({ address: to, bytecode: (await publicClient.getCode({ address: from }))! })
      for (let index = 0; index < 30; index++) {
        const slot = toHex(index, { size: 32 })
        const value = (await publicClient.getStorageAt({ address: from, slot })) ?? zeroHash
        await testClient.setStorageAt({ address: to, index: slot, value })
      }
    }
    const tokenArtifact = JSON.parse(readFileSync(new URL('../../contracts/out/MockAsset.sol/MockAsset.json', import.meta.url), 'utf8'))
    const tokenAddress = await deploy(tokenArtifact, ['USD Coin', 'USDC', 6])
    await copyDeployment(tokenAddress, CANDIDATE_FUNDING.usdc)
    const maxima = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n }
    const initial = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n }
    const deployedAddress = await deploy(guardedArtifact, [CANDIDATE_FUNDING.usdc, BigInt(CANDIDATE_FUNDING.chainId), maxima, initial, 3_600n, 604_800n, 172_800n])
    await copyDeployment(deployedAddress, CANDIDATE_FUNDING.address)
    assert.equal(await publicClient.readContract({address:CANDIDATE_FUNDING.address,abi:guardedArtifact.abi,functionName:'openingsPaused'}),true);
    assert.equal(await publicClient.readContract({address:CANDIDATE_FUNDING.address,abi:guardedArtifact.abi,functionName:'spendsPaused'}),true);
    const deployment = {...CANDIDATE_FUNDING, runtimeHash:keccak256((await publicClient.getCode({address:CANDIDATE_FUNDING.address}))!), drawBoundRepayment:true};
    const {verifyCandidate, createCandidateJournal, executeCandidateCall, prepareCandidateOpen, prepareCandidateRepay, prepareCandidateReclaim, readCandidateLine, reconcileCandidatePending} = (mainnet ? createGuardedMainnetFundingKit : createCandidateFundingKit)(deployment);
    await verifyCandidate(publicClient)
    if(mainnet){
      assert.throws(()=>createCandidateFundingKit(deployment),/testnet/);
      for(const patch of [{drawBoundRepayment:false},{selfRegistration:true},{maxReserve:100001n},{maxPerSpend:5001n},{maxLineSpend:5001n}]){
        assert.throws(()=>createGuardedMainnetFundingKit({...deployment,...patch}));
      }
      await assert.rejects(()=>prepareCandidateOpen(publicClient,sponsorAccount.address,{...input,provider:providerAccount.address}),/enabled|paused/);
    }
    async function write(who: any, request: any) {
      const hash = await localWallet(who).writeContract(request)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      assert.equal(receipt.status, 'success')
    }
    await write(owner, {address:CANDIDATE_FUNDING.address,abi:guardedArtifact.abi,functionName:'setOpeningsPaused',args:[false]});
    await write(owner, {address:CANDIDATE_FUNDING.address,abi:guardedArtifact.abi,functionName:'setSpendsPaused',args:[false]});
    for (const who of [sponsorAccount, agentAccount]) await write(owner, { address: CANDIDATE_FUNDING.usdc, abi: tokenArtifact.abi, functionName: 'mint', args: [who.address, 1_000_000n] })
    await write(owner, { address: CANDIDATE_FUNDING.address, abi: candidateFundingAbi, functionName: 'setSponsorAllowed', args: [sponsorAccount.address, true] })
    function makeSession(who: Address) {
      const map = new Map<string, string>()
      const journal = createCandidateJournal({ getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value) }, removeItem: key => { map.delete(key) } }, who)
      return { publicClient, walletClient: injectedWallet(who), account: who, journal }
    }
    const sponsorSession = makeSession(sponsorAccount.address)
    const localInput = { ...input, ...(bounded?{lineSpendCap:'0.005',dailySpendCap:'0.005',providerPerSpendCap:'0.005',providerDailyCap:'0.005'}:{}), agent: agentAccount.address, provider: providerAccount.address }
    if(mainnet){
      await assert.rejects(()=>prepareCandidateOpen(publicClient,sponsorAccount.address,{...localInput,provider:CANDIDATE_FUNDING.usdc}),/EOA/);
      await assert.rejects(()=>prepareCandidateOpen(publicClient,sponsorAccount.address,{...localInput,lineSpendCap:'0.005001'}),/limit/);
    }
    const approve = await prepareCandidateOpen(publicClient, sponsorAccount.address, localInput)
    assert.equal(approve.kind, 'approve')
    assert.equal((await executeCandidateCall(sponsorSession, approve)).status, 'confirmed')
    const open = await prepareCandidateOpen(publicClient, sponsorAccount.address, localInput)
    assert.equal(open.kind, 'open')
    assert.equal((await executeCandidateCall(sponsorSession, open)).status, 'confirmed')
    const id = open.lineId!
    assert.equal((await readCandidateLine(publicClient, id)).availableReserve, 100_000n)
    const block = await publicClient.getBlock()
    const termsHash = await publicClient.readContract({ address: CANDIDATE_FUNDING.address, abi: candidateFundingAbi, functionName: 'currentTermsHash', args: [id, providerAccount.address] })
    const message = { agent: agentAccount.address, sponsor: sponsorAccount.address, lineId: id, lineEpoch: 1n, termsHash, provider: providerAccount.address, endpointHash: keccak256(stringToHex(localInput.endpoint)), principal: price, maximumTotalDebt: price, dueAt: block.timestamp + 7_200n, nonce: 0n, signatureExpiry: block.timestamp + 900n, executor: zeroAddress }
    const types = { SpendIntent: typeString.slice('SpendIntent('.length, -1).split(',').map(item => { const [type, name] = item.split(' '); return { type, name } }) }
    const signature = await agentAccount.signTypedData({ domain: { name: 'ShadowFloatMainnet', version: '1', chainId: CANDIDATE_FUNDING.chainId, verifyingContract: CANDIDATE_FUNDING.address }, types, primaryType: 'SpendIntent', message })
    await write(agentAccount, { address: CANDIDATE_FUNDING.address, abi: candidateFundingAbi, functionName: 'executeSpend', args: [message, signature] })
    assert.equal((await readCandidateLine(publicClient, id)).principalOutstanding, price)
    const repayerSession = makeSession(agentAccount.address)
    assert.equal((await executeCandidateCall(repayerSession, await prepareCandidateRepay(publicClient, agentAccount.address, id))).status, 'confirmed')
    const repayment = await prepareCandidateRepay(publicClient, agentAccount.address, id)
    assert.equal(repayment.kind, 'repay');
    const decoded=decodeFunctionData({abi:guardedArtifact.abi,data:repayment.data});
    assert.equal(decoded.functionName,'repayForDraw');
    assert.equal(decoded.args![1],await publicClient.readContract({address:CANDIDATE_FUNDING.address,abi:guardedArtifact.abi,functionName:'currentDrawDigest',args:[id]}));
    let originalHash: any;
    const originalSend = repayerSession.walletClient.sendTransaction;
    repayerSession.walletClient.sendTransaction = async request => {
      originalHash = await originalSend(request);
      await publicClient.waitForTransactionReceipt({hash: originalHash});
      throw new Error('deliberately lost repayment confirmation');
    };
    assert.equal((await executeCandidateCall(repayerSession, repayment)).status, 'unknown');
    const held = repayerSession.journal.load()!;
    assert.equal(held.kind, 'repay'); assert.equal(held.txHash, null);
    await assert.rejects(() => executeCandidateCall(repayerSession, repayment));
    const resolved = await reconcileCandidatePending(publicClient, held, originalHash);
    assert.equal(resolved.status, 'confirmed');
    repayerSession.journal.clear();
    const repayments = await publicClient.getContractEvents({address:CANDIDATE_FUNDING.address,abi:guardedArtifact.abi,eventName:'DrawRepaid',fromBlock:0n});
    assert.equal(repayments.length,1);
    const repaid = await readCandidateLine(publicClient, id)
    assert.equal(repaid.stateName, 'OPEN'); assert.equal(repaid.principalOutstanding, 0n); assert.equal(repaid.cumulativePrincipalPaid, price)
    const close = await prepareCandidateReclaim(publicClient, sponsorAccount.address, id)
    assert.equal(close.amount, 100_000n)
    assert.equal((await executeCandidateCall(sponsorSession, close)).status, 'confirmed')
    assert.equal((await readCandidateLine(publicClient, id)).stateName, 'CLOSED')
    const balance = (who: Address) => publicClient.readContract({ address: CANDIDATE_FUNDING.usdc, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [who] })
    assert.equal(await balance(sponsorAccount.address), 1_000_000n)
    assert.equal(await balance(providerAccount.address), price)
    assert.equal(await balance(CANDIDATE_FUNDING.address), 0n)
  } finally { anvil.stop() }
})
