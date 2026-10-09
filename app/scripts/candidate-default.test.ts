import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { TransactionReceiptNotFoundError, createPublicClient, createTestClient, createWalletClient, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, http, keccak256, stringToHex, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hash, type Hex } from 'viem'
// @ts-expect-error Existing shared JavaScript Anvil helpers have no declaration file.
import { account, startAnvil, e2eSkip } from './float-mainnet-e2e.mjs'
import { CANDIDATE_FUNDING, candidateFundingAbi, candidateFundingChain, createCandidateFundingKit, createGuardedMainnetFundingKit, type CandidateOpenInput, type CandidatePending, type CandidateReadClient, type CandidateStorage, type CandidateWalletClient } from '../src/candidateFunding.ts'

const fakeCode = '0x6000' as Hex
const publicManifest = JSON.parse(readFileSync(new URL('../../contracts/deployments/public-testnet/arc-testnet.manifest.json', import.meta.url), 'utf8')) as {
  contract: { address: Address }
  bytecode: { onchainRuntimeKeccak256: Hash }
}
const publicDeployment = { ...CANDIDATE_FUNDING, address: getAddress(publicManifest.contract.address), runtimeHash: publicManifest.bytecode.onchainRuntimeKeccak256, selfRegistration: true }
const sponsor = getAddress('0x1111111111111111111111111111111111111111')
const agent = getAddress('0x2222222222222222222222222222222222222222')
const provider = getAddress('0x3333333333333333333333333333333333333333')
const other = getAddress('0x4444444444444444444444444444444444444444')
const mainnetContract = getAddress('0x5555555555555555555555555555555555555555')
const drawDigest = ('0x' + 'ee'.repeat(32)) as Hash
const lineId = ('0x' + 'aa'.repeat(32)) as Hash
const otherLineId = ('0x' + 'bb'.repeat(32)) as Hash
const txHash = ('0x' + 'cc'.repeat(32)) as Hash
const blockHash = ('0x' + 'dd'.repeat(32)) as Hash
const typeString = 'SpendIntent(address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor)'
const input: CandidateOpenInput = { agent, provider, endpoint: 'https://provider.example/result', reserve: '0.10', lineSpendCap: '0.15', dailySpendCap: '0.10', providerPerSpendCap: '0.05', providerDailyCap: '0.10', expiryDays: '7', repaymentHours: '24' }

type MockLog = { address: Address; data: Hex; topics: readonly Hex[] }
type MockTransaction = { hash: Hash; from: Address; to: Address; input: Hex; value: bigint; nonce: number; chainId: number; blockHash: Hash; blockNumber: bigint }
type MockReceipt = { status: 'success'; transactionHash: Hash; blockNumber: bigint; blockHash: Hash; logs: readonly MockLog[] }
type RawLine = {
  sponsor: Address; agent: Address; epoch: bigint; expiry: bigint; maximumRepaymentWindow: bigint; day: bigint; termsVersion: bigint
  state: number; reserveCap: bigint; availableReserve: bigint; principalOutstanding: bigint; recoveryAvailable: bigint
  lineSpendCap: bigint; dailySpendCap: bigint; cumulativePrincipalPaid: bigint; spentToday: bigint; dueAt: bigint
}

function defaultedLog(id: Hash, principalOutstanding: bigint, dueAt: bigint): MockLog {
  return {
    address: CANDIDATE_FUNDING.address,
    topics: encodeEventTopics({ abi: candidateFundingAbi, eventName: 'LineDefaulted', args: { lineId: id } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [principalOutstanding, dueAt]),
  }
}

function fixture(guardedMainnet = false) {
  const deployment = {
    ...CANDIDATE_FUNDING,
    ...(guardedMainnet ? { chainId: 5042, address: mainnetContract, maxReserve: 100_000n, maxLineSpend: 5_000n, maxDailySpend: 5_000n, maxPerSpend: 5_000n, drawBoundRepayment: true } : {}),
    runtimeHash: keccak256(fakeCode),
  }
  const kit = guardedMainnet ? createGuardedMainnetFundingKit(deployment) : createCandidateFundingKit(deployment)
  const storageMap = new Map<string, string>()
  const storage: CandidateStorage = {
    getItem: key => storageMap.get(key) ?? null,
    setItem: (key, value) => { storageMap.set(key, value) },
    removeItem: key => { storageMap.delete(key) },
  }
  const journal = kit.createCandidateJournal(storage, sponsor)
  const state = {
    chainId: deployment.chainId,
    block: { number: 100n, timestamp: 1_800_000_000n, hash: blockHash },
    line: {
      sponsor, agent, epoch: 1n, expiry: 1_800_604_800n, maximumRepaymentWindow: 86_400n, day: 0n, termsVersion: 1n,
      state: 2, reserveCap: 100_000n, availableReserve: 50_000n, principalOutstanding: 50_000n, recoveryAvailable: 0n,
      lineSpendCap: 150_000n, dailySpendCap: 100_000n, cumulativePrincipalPaid: 0n, spentToday: 50_000n, dueAt: 1_799_999_999n,
    } satisfies RawLine,
    balance: 1_000_000n,
    allowance: 1_000_000n,
    walletNonce: 7,
    sends: 0,
    simulations: [] as string[],
    transactions: new Map<Hash, MockTransaction>(),
    receipts: new Map<Hash, MockReceipt>(),
    sendError: null as Error | null,
  }
  const client = {
    async getChainId() { return state.chainId },
    async getCode({ address }: { address: Address }) { return address.toLowerCase() === deployment.address.toLowerCase() ? fakeCode : '0x' },
    async getBlock() { return state.block },
    async readContract({ functionName }: { functionName: string }) {
      switch (functionName) {
        case 'NAME_HASH': return keccak256(stringToHex('ShadowFloatMainnet'))
        case 'VERSION_HASH': return keccak256(stringToHex('1'))
        case 'SPEND_INTENT_TYPEHASH': return keccak256(stringToHex(typeString))
        case 'deploymentChainId': return BigInt(deployment.chainId)
        case 'usdc': return deployment.usdc
        case 'decimals': return 6
        case 'repaymentBindingVersion': return 2n
        case 'currentDrawDigest': return drawDigest
        case 'getLine': return { ...state.line }
        case 'spendsPaused': return false
        case 'sponsorAllowed': return true
        case 'balanceOf': return state.balance
        case 'allowance': return state.allowance
        default: throw new Error('Unmocked contract read: ' + functionName)
      }
    },
    async simulateContract({ functionName }: { functionName: string }) { state.simulations.push(functionName) },
    async getTransaction({ hash }: { hash: Hash }) {
      const transaction = state.transactions.get(hash)
      if (!transaction) throw new Error('transaction not found')
      return transaction
    },
    async getTransactionReceipt({ hash }: { hash: Hash }) {
      const receipt = state.receipts.get(hash)
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash })
      return receipt
    },
  } as unknown as CandidateReadClient
  const wallet = {
    async getChainId() { return deployment.chainId },
    async getAddresses() { return [sponsor] },
    async request({ method, params }: { method: string; params?: readonly unknown[] }) {
      assert.equal(method, 'eth_getTransactionCount')
      assert.deepEqual(params, [sponsor, 'pending'])
      return toHex(state.walletNonce)
    },
    async sendTransaction(request: { account: Address; to: Address; data: Hex; value: bigint; nonce: number }) {
      state.sends++
      if (state.sendError) throw state.sendError
      const transaction: MockTransaction = { hash: txHash, from: request.account, to: request.to, input: request.data, value: request.value, nonce: request.nonce, chainId: deployment.chainId, blockHash, blockNumber: state.block.number + 1n }
      state.transactions.set(txHash, transaction)
      state.receipts.set(txHash, { status: 'success', transactionHash: txHash, blockNumber: transaction.blockNumber, blockHash, logs: [defaultedLog(lineId, state.line.principalOutstanding, state.line.dueAt)] })
      return txHash
    },
  } as unknown as CandidateWalletClient
  return { kit, state, client, storage, journal, session: { publicClient: client, walletClient: wallet, account: sponsor, journal } }
}

test('default calldata names only the reviewed line and records its outstanding principal', async () => {
  const f = fixture()
  const prepared = await f.kit.prepareCandidateDefault(f.client, sponsor, lineId)
  const decoded = decodeFunctionData({ abi: candidateFundingAbi, data: prepared.data })
  assert.equal(prepared.kind, 'default')
  assert.equal(prepared.amount, 50_000n)
  assert.equal(decoded.functionName, 'declareDefault')
  assert.deepEqual(decoded.args, [lineId])
})

test('default bounds reject a different line, a non-drawn line, and a line before dueAt', async () => {
  const f = fixture()
  const prepared = await f.kit.prepareCandidateDefault(f.client, sponsor, lineId)
  await assert.rejects(() => f.kit.executeCandidateCall(f.session, { ...prepared, lineId: otherLineId }), /line does not match its calldata/)
  assert.equal(f.state.sends, 0)
  await assert.rejects(() => f.kit.prepareCandidateDefault(f.client, other, lineId), /Only this line’s sponsor/)
  f.state.line.state = 1
  await assert.rejects(() => f.kit.prepareCandidateDefault(f.client, sponsor, lineId), /DRAWN/)
  f.state.line.state = 2
  f.state.line.dueAt = f.state.block.timestamp + 1n
  await assert.rejects(() => f.kit.prepareCandidateDefault(f.client, sponsor, lineId), /due/)
  assert.equal(f.state.sends, 0)
})

test('guarded mainnet prepares the same sponsor default selector', async () => {
  const f = fixture(true)
  const prepared = await f.kit.prepareCandidateDefault(f.client, sponsor, lineId)
  const decoded = decodeFunctionData({ abi: candidateFundingAbi, data: prepared.data })
  assert.equal(decoded.functionName, 'declareDefault')
  assert.deepEqual(decoded.args, [lineId])
})

test('a default journal survives an ambiguous wallet response and reload', async () => {
  const f = fixture()
  const prepared = await f.kit.prepareCandidateDefault(f.client, sponsor, lineId)
  f.state.sendError = new Error('wallet response lost')
  assert.equal((await f.kit.executeCandidateCall(f.session, prepared)).status, 'unknown')
  const pending = f.kit.createCandidateJournal(f.storage, sponsor).load()
  assert.equal(pending?.kind, 'default')
  assert.equal(pending?.lineId, lineId)
  assert.equal(pending?.data, prepared.data)
  assert.equal(pending?.status, 'unknown')
  assert.equal(f.state.sends, 1)
})

test('a confirmed default reconciles its LineDefaulted event and clears the journal', async () => {
  const f = fixture()
  const prepared = await f.kit.prepareCandidateDefault(f.client, sponsor, lineId)
  const result = await f.kit.executeCandidateCall(f.session, prepared)
  assert.equal(result.status, 'confirmed')
  assert.match(result.message, /Default declaration/)
  assert.deepEqual(f.state.simulations, ['declareDefault'])
  assert.equal(f.journal.load(), null)
  assert.equal(f.state.sends, 1)
})

test('a pending default blocks both repayment and recovery claim sends', async () => {
  const f = fixture()
  const prepared = await f.kit.prepareCandidateDefault(f.client, sponsor, lineId)
  const pending: CandidatePending = {
    version: 1, chainId: CANDIDATE_FUNDING.chainId, candidate: CANDIDATE_FUNDING.address, account: sponsor,
    kind: 'default', to: prepared.to, data: prepared.data, value: '0', amount: prepared.amount.toString(),
    lineId: prepared.lineId, agent: prepared.agent, expectedEpoch: prepared.expectedEpoch?.toString() ?? null,
    fromBlock: f.state.block.number.toString(), nonce: f.state.walletNonce, createdAt: new Date().toISOString(),
    status: 'pending', txHash,
  }
  f.journal.save(pending)
  f.state.line.state = 3
  f.state.line.availableReserve = 25_000n
  f.state.line.recoveryAvailable = 25_000n
  const repayment = await f.kit.prepareCandidateRepay(f.client, sponsor, lineId)
  const claim = await f.kit.prepareCandidateReclaim(f.client, sponsor, lineId)
  await assert.rejects(() => f.kit.executeCandidateCall(f.session, repayment), /Resolve the saved transaction/)
  await assert.rejects(() => f.kit.executeCandidateCall(f.session, claim), /Resolve the saved transaction/)
  assert.equal(f.state.sends, 0)
  assert.equal(f.journal.load()?.kind, 'default')
})

test('public testnet default sends recovery repayment to the sponsor claim on local Anvil', { skip: e2eSkip, timeout: 60_000 }, async () => {
  const anvil = await startAnvil(18582, [], BigInt(publicDeployment.chainId))
  try {
    const owner = account(0), sponsorAccount = account(6), agentAccount = account(2), providerAccount = account(3)
    const publicClient = createPublicClient({ chain: candidateFundingChain, transport: http(anvil.rpc), cacheTime: 0, pollingInterval: 20 })
    const testClient = createTestClient({ chain: candidateFundingChain, mode: 'anvil', transport: http(anvil.rpc) })
    const localWallet = (who: unknown) => createWalletClient({ account: who as never, chain: candidateFundingChain, transport: http(anvil.rpc) })
    const injectedWallet = (who: Address) => ({
      getAddresses: async () => [who],
      getChainId: async () => publicDeployment.chainId,
      request: (request: never) => localWallet(who).request(request),
      sendTransaction: (request: never) => localWallet(who).sendTransaction(request),
    }) as CandidateWalletClient
    async function deploy(compiled: { abi: Abi; bytecode: { object: Hex } }, args: readonly unknown[]) {
      const hash = await localWallet(owner).deployContract({ account: owner as never, chain: candidateFundingChain, abi: compiled.abi, bytecode: compiled.bytecode.object, args: args as never })
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
    const tokenArtifact = JSON.parse(readFileSync(new URL('../../contracts/out/MockAsset.sol/MockAsset.json', import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
    const publicArtifact = JSON.parse(readFileSync(new URL('../../contracts/out/ShadowFloatPublicTestnet.sol/ShadowFloatPublicTestnet.json', import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
    const tokenAddress = await deploy(tokenArtifact, ['USD Coin', 'USDC', 6])
    await copyDeployment(tokenAddress, publicDeployment.usdc)
    const maxima = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n }
    const initial = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n }
    const deployedAddress = await deploy(publicArtifact, [publicDeployment.usdc, maxima, initial, 3_600n, 604_800n, 172_800n])
    await copyDeployment(deployedAddress, publicDeployment.address)
    const runtimeHash = keccak256((await publicClient.getCode({ address: publicDeployment.address }))!)
    const kit = createCandidateFundingKit({ ...publicDeployment, runtimeHash })
    await kit.verifyCandidate(publicClient)
    async function write(who: unknown, request: never) {
      const hash = await localWallet(who).writeContract(request)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      assert.equal(receipt.status, 'success')
    }
    for (const who of [sponsorAccount, agentAccount]) await write(owner, { address: publicDeployment.usdc, abi: tokenArtifact.abi, functionName: 'mint', args: [who.address, 1_000_000n] } as never)
    function makeSession(who: Address) {
      const map = new Map<string, string>()
      const journal = kit.createCandidateJournal({ getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value) }, removeItem: key => { map.delete(key) } }, who)
      return { publicClient, walletClient: injectedWallet(who), account: who, journal }
    }
    const sponsorSession = makeSession(sponsorAccount.address)
    const inputForLine = { ...input, agent: agentAccount.address, provider: providerAccount.address }
    const registration = await kit.prepareCandidateRegistration(publicClient, sponsorAccount.address)
    assert.equal((await kit.executeCandidateCall(sponsorSession, registration)).status, 'confirmed')
    const approval = await kit.prepareCandidateOpen(publicClient, sponsorAccount.address, inputForLine)
    assert.equal(approval.kind, 'approve')
    assert.equal((await kit.executeCandidateCall(sponsorSession, approval)).status, 'confirmed')
    const open = await kit.prepareCandidateOpen(publicClient, sponsorAccount.address, inputForLine)
    assert.equal(open.kind, 'open')
    assert.equal((await kit.executeCandidateCall(sponsorSession, open)).status, 'confirmed')
    const id = open.lineId!
    const block = await publicClient.getBlock()
    const termsHash = await publicClient.readContract({ address: publicDeployment.address, abi: candidateFundingAbi, functionName: 'currentTermsHash', args: [id, providerAccount.address] })
    const message = { agent: agentAccount.address, sponsor: sponsorAccount.address, lineId: id, lineEpoch: 1n, termsHash, provider: providerAccount.address, endpointHash: keccak256(stringToHex(inputForLine.endpoint)), principal: 50_000n, maximumTotalDebt: 50_000n, dueAt: block.timestamp + 7_200n, nonce: 0n, signatureExpiry: block.timestamp + 900n, executor: zeroAddress }
    const types = { SpendIntent: typeString.slice('SpendIntent('.length, -1).split(',').map(item => { const [type, name] = item.split(' '); return { type, name } }) }
    const signature = await agentAccount.signTypedData({ domain: { name: 'ShadowFloatMainnet', version: '1', chainId: publicDeployment.chainId, verifyingContract: publicDeployment.address }, types, primaryType: 'SpendIntent', message })
    await write(agentAccount, { address: publicDeployment.address, abi: candidateFundingAbi, functionName: 'executeSpend', args: [message, signature] } as never)
    const drawn = await kit.readCandidateLine(publicClient, id)
    assert.equal(drawn.principalOutstanding, 50_000n)
    const latest = await publicClient.getBlock()
    await testClient.increaseTime({ seconds: Number(drawn.dueAt - latest.timestamp + 1n) })
    await testClient.mine({ blocks: 1 })
    const defaulted = await kit.prepareCandidateDefault(publicClient, sponsorAccount.address, id)
    assert.equal(defaulted.amount, 50_000n)
    assert.equal((await kit.executeCandidateCall(sponsorSession, defaulted)).status, 'confirmed')
    assert.equal((await kit.readCandidateLine(publicClient, id)).stateName, 'DEFAULTED')
    const agentSession = makeSession(agentAccount.address)
    const repayApproval = await kit.prepareCandidateRepay(publicClient, agentAccount.address, id)
    assert.equal(repayApproval.kind, 'approve')
    assert.equal((await kit.executeCandidateCall(agentSession, repayApproval)).status, 'confirmed')
    const repayment = await kit.prepareCandidateRepay(publicClient, agentAccount.address, id)
    assert.equal((await kit.executeCandidateCall(agentSession, repayment)).status, 'confirmed')
    const repaid = await kit.readCandidateLine(publicClient, id)
    assert.equal(repaid.stateName, 'DEFAULTED')
    assert.equal(repaid.principalOutstanding, 0n)
    assert.equal(repaid.recoveryAvailable, 50_000n)
    const claim = await kit.prepareCandidateReclaim(publicClient, sponsorAccount.address, id)
    assert.equal(claim.kind, 'claim-defaulted')
    assert.equal(claim.amount, 100_000n)
    assert.equal((await kit.executeCandidateCall(sponsorSession, claim)).status, 'confirmed')
    const claimed = await kit.readCandidateLine(publicClient, id)
    assert.equal(claimed.stateName, 'DEFAULTED')
    assert.equal(claimed.availableReserve + claimed.recoveryAvailable, 0n)
  } finally { anvil.stop() }
})
