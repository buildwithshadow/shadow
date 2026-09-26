import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createPublicClient, createTestClient, createWalletClient, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, http, keccak256, stringToHex, toHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem'
// @ts-expect-error Existing shared JavaScript Anvil helpers have no declaration file.
import { account, startAnvil, e2eSkip } from './float-mainnet-e2e.mjs'
import {
  CANDIDATE_FUNDING, candidateFundingAbi, candidateFundingChain, createCandidateJournal, executeCandidateCall, prepareCandidateOpen, prepareCandidateReclaim, prepareCandidateRepay,
  readCandidateLine, readCandidateSnapshot, reconcileCandidatePending, verifyCandidate,
  type CandidateReadClient, type CandidateWalletClient, type CandidateOpenInput, type CandidatePrepared, type CandidatePending,
} from '../src/candidateFunding.ts'

const manifest = JSON.parse(readFileSync(new URL('../../contracts/deployments/float-mainnet-candidate/arc-testnet.manifest.json', import.meta.url), 'utf8'))
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json', import.meta.url), 'utf8'))
let runtime = artifact.deployedBytecode.object.slice(2)
for (const immutable of manifest.bytecode.immutables) for (const offset of immutable.offsets) runtime = runtime.slice(0, offset * 2) + immutable.value.slice(2) + runtime.slice((offset + 32) * 2)
const deployedCode = `0x${runtime}` as Hex
const sponsor = getAddress('0x1111111111111111111111111111111111111111')
const agent = getAddress('0x2222222222222222222222222222222222222222')
const provider = getAddress('0x3333333333333333333333333333333333333333')
const other = getAddress('0x4444444444444444444444444444444444444444')
const lineId = `0x${'aa'.repeat(32)}` as Hex
const txHash = `0x${'bb'.repeat(32)}` as Hex
const blockHash = `0x${'cc'.repeat(32)}` as Hex
const otherHash = `0x${'dd'.repeat(32)}` as Hex
const input: CandidateOpenInput = { agent, provider, endpoint: 'https://provider.example/result?format=json', reserve: '0.10', lineSpendCap: '0.15', dailySpendCap: '0.10', providerPerSpendCap: '0.05', providerDailyCap: '0.10', expiryDays: '7', repaymentHours: '24' }
const typeString = 'SpendIntent(address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor)'

function eventLog(eventName: string, args: Record<string, unknown>, token = false): any {
  const abi: any = token ? [{ type: 'event', name: 'Approval', inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'spender', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }] : candidateFundingAbi
  const event = abi.find((item: any) => item.type === 'event' && item.name === eventName)
  const plain = event.inputs.filter((item: any) => !item.indexed)
  return { address: token ? CANDIDATE_FUNDING.usdc : CANDIDATE_FUNDING.address, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(plain, plain.map((item: any) => args[item.name])) }
}

function fixture() {
  const storageMap = new Map<string, string>()
  const storage = { getItem: (key: string) => storageMap.get(key) ?? null, setItem: (key: string, value: string) => { storageMap.set(key, value) }, removeItem: (key: string) => { storageMap.delete(key) } }
  const journal = createCandidateJournal(storage, sponsor)
  const state: any = {
    chainId: CANDIDATE_FUNDING.chainId, code: deployedCode, accountCode: '0x', selected: sponsor, walletChain: CANDIDATE_FUNDING.chainId,
    sponsorAllowed: true, openingsPaused: false, spendsPaused: false, allowance: 1_000_000n, balance: 10_000_000n, activeLineId: zeroHash,
    limits: [25_000_000n, 5_000_000n, 5_000_000n, 1_000_000n, 2_000_000n], totalCommittedCapital: 0n, epoch: 0n,
    block: { number: 100n, timestamp: 1_800_000_000n, hash: blockHash }, nonce: 7, walletNonce: 7, walletNonceReads: 0, publicNonceReads: 0, sends: 0, simulation: 0, transactions: new Map(), receipts: new Map(), readCalls: [],
    line: { sponsor, agent, epoch: 1n, expiry: 1_800_604_800n, maximumRepaymentWindow: 86_400n, day: 0n, termsVersion: 1n, state: 1, reserveCap: 100_000n, availableReserve: 100_000n, principalOutstanding: 0n, recoveryAvailable: 0n, lineSpendCap: 150_000n, dailySpendCap: 100_000n, cumulativePrincipalPaid: 0n, spentToday: 0n, dueAt: 0n },
  }
  const client = {
    async getChainId() { return state.chainId },
    async getCode({ address }: any) { return address.toLowerCase() === CANDIDATE_FUNDING.address.toLowerCase() ? state.code : state.accountCode },
    async getBlock() { return state.block },
    async getTransactionCount() { state.publicNonceReads++; return state.nonce },
    async readContract({ functionName }: any) {
      state.readCalls.push(functionName)
      if (state.failRead === functionName) throw new Error(`RPC unavailable during ${functionName}`)
      switch (functionName) {
        case 'NAME_HASH': return keccak256(stringToHex('ShadowFloatMainnet'))
        case 'VERSION_HASH': return keccak256(stringToHex('1'))
        case 'SPEND_INTENT_TYPEHASH': return keccak256(stringToHex(typeString))
        case 'deploymentChainId': return BigInt(CANDIDATE_FUNDING.chainId)
        case 'usdc': return CANDIDATE_FUNDING.usdc
        case 'decimals': return 6
        case 'minimumRepaymentWindow': return 3_600n
        case 'maximumRepaymentWindow': return 604_800n
        case 'nextLineEpoch': return state.epoch
        case 'effectiveLimits': return state.limits
        case 'balanceOf': return state.balance
        case 'allowance': return state.allowance
        case 'getLine': return { ...state.line }
        default: if (functionName in state) return state[functionName]; throw new Error(`Unmocked ${functionName}`)
      }
    },
    async simulateContract() { state.simulation++; if (state.simulationError) throw state.simulationError; return { result: undefined } },
    async getTransaction({ hash }: any) { const tx = state.transactions.get(hash); if (!tx) throw new Error('transaction not found'); return tx },
    async getTransactionReceipt({ hash }: any) { const receipt = state.receipts.get(hash); if (!receipt) throw new Error('receipt not found'); return receipt },
  } as unknown as CandidateReadClient
  const wallet = {
    async getChainId() { return state.walletChain },
    async getAddresses() { return [state.selected] },
    async request({ method, params }: any) {
      assert.equal(method, 'eth_getTransactionCount'); assert.deepEqual(params, [sponsor, 'pending'])
      state.walletNonceReads++
      if (state.onWalletNonce) return state.onWalletNonce(state.walletNonceReads)
      return toHex(state.walletNonce)
    },
    async sendTransaction(request: any) { state.sends++; state.request = request; assert.ok(journal.load(), 'journal must exist before wallet prompt'); if (state.onSend) return state.onSend(request); return txHash },
  } as unknown as CandidateWalletClient
  const session = { publicClient: client, walletClient: wallet, account: sponsor, journal }
  function mined(prepared: CandidatePrepared, overrides: any = {}) {
    const transaction = { hash: txHash, from: sponsor, to: prepared.to, input: prepared.data, value: 0n, nonce: state.walletNonce, chainId: CANDIDATE_FUNDING.chainId, blockHash, blockNumber: state.block.number, ...overrides }
    const kind = prepared.kind
    const logs = kind === 'approve' ? [eventLog('Approval', { owner: sponsor, spender: CANDIDATE_FUNDING.address, value: prepared.amount }, true)]
      : kind === 'open' ? [eventLog('LineOpened', { lineId: prepared.lineId, sponsor, agent: prepared.agent, epoch: prepared.expectedEpoch, reserve: prepared.amount, termsVersion: 1n })]
      : kind === 'repay' ? [eventLog('Repaid', { lineId: prepared.lineId, payer: sponsor, amount: prepared.amount, principalRemaining: 0n })]
      : [eventLog(kind === 'close' ? 'LineClosed' : 'SponsorClaimed', { lineId: prepared.lineId, sponsor, amount: prepared.amount })]
    const receipt = { status: 'success', transactionHash: transaction.hash, blockNumber: state.block.number, blockHash, logs }
    state.transactions.set(transaction.hash, transaction)
    state.receipts.set(transaction.hash, receipt)
    return { transaction, receipt }
  }
  return { state, client, wallet, journal, session, storage, storageMap, mined }
}

test('browser pin matches committed deployment and reconstructed immutable runtime', () => {
  assert.equal(CANDIDATE_FUNDING.address, manifest.contract.address)
  assert.equal(String(CANDIDATE_FUNDING.chainId), manifest.chainId)
  assert.equal(CANDIDATE_FUNDING.runtimeHash, manifest.bytecode.onchainRuntimeKeccak256)
  assert.equal(keccak256(deployedCode), CANDIDATE_FUNDING.runtimeHash)
  assert.equal(CANDIDATE_FUNDING.maxReserve, BigInt(manifest.config.initial.lineReserve))
})

test('wrong RPC chain and mismatched deployed generation fail before wallet access', async () => {
  const f = fixture(); f.state.chainId = 1
  await assert.rejects(() => readCandidateSnapshot(f.client, { sponsor }), /Arc testnet/)
  f.state.chainId = CANDIDATE_FUNDING.chainId; f.state.code = '0x6000'
  await assert.rejects(() => verifyCandidate(f.client), /verified Shadow/)
  assert.equal(f.state.sends, 0)
})

test('identity read failure queues no later reads and a fresh retry succeeds', async () => {
  const f = fixture()
  f.state.failRead = 'VERSION_HASH'
  await assert.rejects(() => verifyCandidate(f.client), /RPC unavailable during VERSION_HASH/)
  assert.deepEqual(f.state.readCalls, ['NAME_HASH', 'VERSION_HASH'])
  f.state.failRead = null
  f.state.readCalls = []
  await verifyCandidate(f.client)
  assert.deepEqual(f.state.readCalls, ['NAME_HASH', 'VERSION_HASH', 'SPEND_INTENT_TYPEHASH', 'deploymentChainId', 'usdc', 'decimals'])
})

test('snapshot read failure stops before later state reads and a fresh retry starts cleanly', async () => {
  const f = fixture()
  f.state.failRead = 'openingsPaused'
  await assert.rejects(() => readCandidateSnapshot(f.client, { sponsor, agent }), /RPC unavailable during openingsPaused/)
  assert.deepEqual(f.state.readCalls, ['NAME_HASH', 'VERSION_HASH', 'SPEND_INTENT_TYPEHASH', 'deploymentChainId', 'usdc', 'decimals', 'sponsorAllowed', 'openingsPaused'])
  f.state.failRead = null
  f.state.readCalls = []
  const snapshot = await readCandidateSnapshot(f.client, { sponsor, agent })
  assert.equal(snapshot.sponsorAllowed, true)
  assert.equal(snapshot.balance, 10_000_000n)
  assert.deepEqual(f.state.readCalls, ['NAME_HASH', 'VERSION_HASH', 'SPEND_INTENT_TYPEHASH', 'deploymentChainId', 'usdc', 'decimals', 'sponsorAllowed', 'openingsPaused', 'spendsPaused', 'effectiveLimits', 'totalCommittedCapital', 'minimumRepaymentWindow', 'maximumRepaymentWindow', 'balanceOf', 'allowance', 'activeLineId', 'nextLineEpoch'])
})

test('opening uses exact endpoint bytes and a reserve approval only when allowance is short', async () => {
  const f = fixture(); f.state.allowance = 0n
  const approval = await prepareCandidateOpen(f.client, sponsor, input)
  assert.equal(approval.kind, 'approve'); assert.equal(approval.amount, 100_000n)
  f.state.allowance = 100_000n
  const open = await prepareCandidateOpen(f.client, sponsor, input)
  const decoded: any = decodeFunctionData({ abi: candidateFundingAbi, data: open.data })
  assert.equal(decoded.functionName, 'openLine')
  assert.equal(decoded.args[0].endpointHash, keccak256(stringToHex(input.endpoint)))
  assert.equal(decoded.args[0].reserve, 100_000n)
  assert.equal(decoded.args[0].maximumRepaymentWindow, 86_400n)
  assert.equal(decoded.args[0].lineExpiry, f.state.block.timestamp + 604_800n)
})

test('opening refuses missing access, active line, exhausted cap, imprecise amounts, short windows and unsafe endpoint text', async () => {
  for (const [mutate, message] of [
    [(f: any) => { f.state.sponsorAllowed = false }, /not been enabled/],
    [(f: any) => { f.state.activeLineId = lineId }, /already have an active/],
    [(f: any) => { f.state.totalCommittedCapital = 25_000_000n }, /reserve capacity/],
    [(f: any) => { f.state.limits[1] = 50_000n }, /current testnet limit/],
  ] as const) { const f = fixture(); mutate(f); await assert.rejects(() => prepareCandidateOpen(f.client, sponsor, input), message) }
  const f = fixture()
  for (const patch of [{ reserve: '0.0000001' }, { reserve: '5.1' }, { repaymentHours: '1' }, { expiryDays: '8' }, { endpoint: `${input.endpoint} ` }, { endpoint: 'https://user:password@provider.example/api' }, { endpoint: 'http://provider.example/api' }]) await assert.rejects(() => prepareCandidateOpen(f.client, sponsor, { ...input, ...patch }))
  assert.equal(f.state.sends, 0)
})

test('approval and opening are separate confirmations; rejection leaves confirmed approval reusable', async () => {
  const f = fixture(); f.state.allowance = 0n
  const approve = await prepareCandidateOpen(f.client, sponsor, input)
  f.mined(approve)
  assert.equal((await executeCandidateCall(f.session, approve)).status, 'confirmed')
  assert.equal(f.journal.load(), null)
  f.state.allowance = 100_000n; f.state.nonce++; f.state.walletNonce++
  const open = await prepareCandidateOpen(f.client, sponsor, input)
  f.state.onSend = () => { throw { code: 4001 } }
  await assert.rejects(() => executeCandidateCall(f.session, open), /declined/)
  assert.equal(f.journal.load(), null)
  assert.equal(f.state.allowance, 100_000n)
  assert.equal(f.state.sends, 2)
})

test('wallet account or network changes and non-EOA senders are rejected without a transaction', async () => {
  for (const [key, value] of [['selected', other], ['walletChain', 1], ['accountCode', '0xef0100']] as const) {
    const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
    f.state[key] = value
    await assert.rejects(() => executeCandidateCall(f.session, prepared))
    assert.equal(f.state.sends, 0); assert.equal(f.journal.load(), null)
  }
})

test('the connected provider pending nonce overrides a stale public RPC nonce', async () => {
  const f = fixture(); f.state.nonce = 7; f.state.walletNonce = 11
  const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  f.state.onSend = () => { f.mined(prepared); return txHash }
  assert.equal((await executeCandidateCall(f.session, prepared)).status, 'confirmed')
  assert.equal(f.state.request.nonce, 11)
  assert.equal(f.state.walletNonceReads, 2)
  assert.equal(f.state.publicNonceReads, 0)
})

test('a provider nonce change after journaling prevents the send and allows a fresh review', async () => {
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  f.state.onWalletNonce = (count: number) => {
    if (count === 1) return '0x7'
    assert.equal(f.journal.load()?.nonce, 7, 'the recheck must happen after journaling')
    return '0x8'
  }
  await assert.rejects(() => executeCandidateCall(f.session, prepared), /another pending transaction/)
  assert.equal(f.state.sends, 0); assert.equal(f.journal.load(), null)
  f.state.onWalletNonce = null; f.state.walletNonce = 8
  const fresh = await prepareCandidateOpen(f.client, sponsor, input)
  f.state.onSend = () => { f.mined(fresh); return txHash }
  assert.equal((await executeCandidateCall(f.session, fresh)).status, 'confirmed')
  assert.equal(f.state.request.nonce, 8)
})

test('failed or invalid nonce revalidation clears only the never-sent preparation', async () => {
  for (const fail of [() => { throw new Error('wallet provider unavailable') }, () => 'invalid']) {
    const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
    f.state.onWalletNonce = (count: number) => count === 1 ? '0x7' : fail()
    await assert.rejects(() => executeCandidateCall(f.session, prepared))
    assert.equal(f.state.sends, 0); assert.equal(f.journal.load(), null)
  }
})

test('unsupported, malformed and unsafe provider nonces stop before journaling or signing', async () => {
  for (const result of ['invalid', '0x20000000000000', -1, undefined]) {
    const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
    f.state.onWalletNonce = () => result
    await assert.rejects(() => executeCandidateCall(f.session, prepared), /nonce/)
    assert.equal(f.state.sends, 0); assert.equal(f.journal.load(), null); assert.equal(f.state.publicNonceReads, 0)
  }
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  f.state.onWalletNonce = () => { throw { code: -32601, message: 'method not supported' } }
  await assert.rejects(() => executeCandidateCall(f.session, prepared))
  assert.equal(f.state.sends, 0); assert.equal(f.journal.load(), null); assert.equal(f.state.publicNonceReads, 0)
})

test('an account change during the last nonce read cannot open a signing prompt', async () => {
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  f.state.onWalletNonce = (count: number) => { if (count === 2) f.state.selected = other; return '0x7' }
  await assert.rejects(() => executeCandidateCall(f.session, prepared), /account changed/)
  assert.equal(f.state.sends, 0); assert.equal(f.journal.load(), null)
})

test('hashless successful send retains exact nonce and calldata; reload blocks resend and exact receipt recovers it', async () => {
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  f.state.onSend = () => { f.mined(prepared); throw new Error('response lost after broadcast') }
  const result = await executeCandidateCall(f.session, prepared)
  assert.equal(result.status, 'unknown'); assert.equal(result.txHash, null)
  const reloaded = createCandidateJournal(f.storage, sponsor)
  const pending = reloaded.load()!
  assert.equal(pending.nonce, 7); assert.equal(pending.data, prepared.data)
  await assert.rejects(() => executeCandidateCall({ ...f.session, journal: reloaded }, prepared), /Resolve the saved transaction/)
  assert.equal(f.state.sends, 1)
  assert.equal((await reconcileCandidatePending(f.client, pending, txHash)).status, 'confirmed')
  assert.ok(reloaded.load(), 'read-only reconciliation must not clear a record itself')
})

test('pending receipt and subsequent RPC failure never clear journal or resend', async () => {
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  assert.equal((await executeCandidateCall(f.session, prepared)).status, 'unknown')
  assert.equal(f.journal.load()?.txHash, txHash)
  f.state.chainId = 1
  assert.equal((await reconcileCandidatePending(f.client, f.journal.load()!)).status, 'unknown')
  assert.equal(f.state.sends, 1)
})

test('equal-amount repayment from a different nonce cannot resolve the saved payment', async () => {
  const f = fixture(); f.state.line.state = 2; f.state.line.principalOutstanding = 50_000n; f.state.line.availableReserve = 50_000n; f.state.line.dueAt = f.state.block.timestamp + 4_000n; f.state.line.cumulativePrincipalPaid = 50_000n
  const prepared = await prepareCandidateRepay(f.client, sponsor, lineId)
  await executeCandidateCall(f.session, prepared)
  f.mined(prepared, { hash: otherHash, nonce: 8 })
  assert.equal((await reconcileCandidatePending(f.client, f.journal.load()!, otherHash)).status, 'unknown')
  assert.ok(f.journal.load()); assert.equal(f.state.sends, 1)
})

test('a mined different same-nonce transaction proves replacement, while orphaned receipts do not', async () => {
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  await executeCandidateCall(f.session, prepared)
  const { receipt } = f.mined(prepared, { hash: otherHash, to: sponsor, input: '0x' })
  assert.equal((await reconcileCandidatePending(f.client, f.journal.load()!, otherHash)).status, 'replaced')
  receipt.blockHash = otherHash
  assert.equal((await reconcileCandidatePending(f.client, f.journal.load()!, otherHash)).status, 'unknown')
})

test('transaction success without expected event remains unresolved; an exact reverted transaction is terminal', async () => {
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  const { receipt } = f.mined(prepared); receipt.logs = []
  assert.equal((await executeCandidateCall(f.session, prepared)).status, 'unknown')
  receipt.status = 'reverted'
  assert.equal((await reconcileCandidatePending(f.client, f.journal.load()!)).status, 'reverted')
})

test('the synchronous lock prevents overlapping wallet requests before either prompt returns', async () => {
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  let release!: () => void
  f.state.onSend = async () => { await new Promise<void>(resolve => { release = resolve }); return txHash }
  const first = executeCandidateCall(f.session, prepared)
  await assert.rejects(() => executeCandidateCall(f.session, prepared), /already being prepared/)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  release(); await first
  assert.equal(f.state.sends, 1)
})

test('full repayment is fixed to reviewed debt and invalidated by another purchase cycle', async () => {
  const f = fixture(); f.state.line.state = 2; f.state.line.principalOutstanding = 50_000n; f.state.line.availableReserve = 50_000n; f.state.line.cumulativePrincipalPaid = 50_000n; f.state.line.dueAt = f.state.block.timestamp + 4_000n
  const prepared = await prepareCandidateRepay(f.client, sponsor, lineId)
  assert.equal(prepared.amount, 50_000n)
  f.state.line.cumulativePrincipalPaid += 50_000n
  await assert.rejects(() => executeCandidateCall(f.session, prepared), /line or debt changed/)
  assert.equal(f.state.sends, 0)
  f.state.line.state = 1; f.state.line.principalOutstanding = 0n
  await assert.rejects(() => prepareCandidateRepay(f.client, sponsor, lineId), /no outstanding debt/)
})

test('partial and defaulted balances are read faithfully; defaulted recovery never appears reopened', async () => {
  const f = fixture(); f.state.line.state = 2; f.state.line.principalOutstanding = 20_000n; f.state.line.availableReserve = 80_000n; f.state.line.cumulativePrincipalPaid = 50_000n
  let line = await readCandidateLine(f.client, lineId)
  assert.equal(line.stateName, 'DRAWN'); assert.equal(line.cumulativePrincipalPaid, 50_000n)
  await assert.rejects(() => prepareCandidateReclaim(f.client, sponsor, lineId), /debt-free/)
  f.state.line.state = 3; f.state.line.recoveryAvailable = 30_000n; f.state.line.availableReserve = 50_000n
  line = await readCandidateLine(f.client, lineId)
  assert.equal(line.stateName, 'DEFAULTED')
  const reclaim = await prepareCandidateReclaim(f.client, sponsor, lineId)
  assert.equal(reclaim.kind, 'claim-defaulted'); assert.equal(reclaim.amount, 80_000n)
  await assert.rejects(() => prepareCandidateReclaim(f.client, other, lineId), /Only this line/)
})

test('storage failure and malformed persisted records fail before opening the wallet', async () => {
  const f = fixture(); const prepared = await prepareCandidateOpen(f.client, sponsor, input)
  const broken = createCandidateJournal({ getItem: () => null, setItem() {}, removeItem() {} }, sponsor)
  await assert.rejects(() => executeCandidateCall({ ...f.session, journal: broken }, prepared), /storage is unavailable/)
  assert.equal(f.state.sends, 0)
  f.storageMap.set(f.journal.key, '{bad json')
  await assert.rejects(() => executeCandidateCall(f.session, prepared), /unreadable/)
  assert.equal(f.state.sends, 0)
})

test('browser calls drive actual candidate open, paid draw, full repayment and reserve reclaim on local Anvil', { skip: e2eSkip, timeout: 60_000 }, async () => {
  const anvil = await startAnvil(18580)
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
    const deployedAddress = await deploy(artifact, [CANDIDATE_FUNDING.usdc, BigInt(CANDIDATE_FUNDING.chainId), maxima, initial, 3_600n, 604_800n, 172_800n])
    await copyDeployment(deployedAddress, CANDIDATE_FUNDING.address)
    await verifyCandidate(publicClient)
    async function write(who: any, request: any) {
      const hash = await localWallet(who).writeContract(request)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      assert.equal(receipt.status, 'success')
    }
    for (const who of [sponsorAccount, agentAccount]) await write(owner, { address: CANDIDATE_FUNDING.usdc, abi: tokenArtifact.abi, functionName: 'mint', args: [who.address, 1_000_000n] })
    await write(owner, { address: CANDIDATE_FUNDING.address, abi: candidateFundingAbi, functionName: 'setSponsorAllowed', args: [sponsorAccount.address, true] })
    function makeSession(who: Address) {
      const map = new Map<string, string>()
      const journal = createCandidateJournal({ getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value) }, removeItem: key => { map.delete(key) } }, who)
      return { publicClient, walletClient: injectedWallet(who), account: who, journal }
    }
    const sponsorSession = makeSession(sponsorAccount.address)
    const localInput = { ...input, agent: agentAccount.address, provider: providerAccount.address }
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
    const message = { agent: agentAccount.address, sponsor: sponsorAccount.address, lineId: id, lineEpoch: 1n, termsHash, provider: providerAccount.address, endpointHash: keccak256(stringToHex(localInput.endpoint)), principal: 50_000n, maximumTotalDebt: 50_000n, dueAt: block.timestamp + 7_200n, nonce: 0n, signatureExpiry: block.timestamp + 900n, executor: zeroAddress }
    const types = { SpendIntent: typeString.slice('SpendIntent('.length, -1).split(',').map(item => { const [type, name] = item.split(' '); return { type, name } }) }
    const signature = await agentAccount.signTypedData({ domain: { name: 'ShadowFloatMainnet', version: '1', chainId: CANDIDATE_FUNDING.chainId, verifyingContract: CANDIDATE_FUNDING.address }, types, primaryType: 'SpendIntent', message })
    await write(agentAccount, { address: CANDIDATE_FUNDING.address, abi: candidateFundingAbi, functionName: 'executeSpend', args: [message, signature] })
    assert.equal((await readCandidateLine(publicClient, id)).principalOutstanding, 50_000n)
    const repayerSession = makeSession(agentAccount.address)
    assert.equal((await executeCandidateCall(repayerSession, await prepareCandidateRepay(publicClient, agentAccount.address, id))).status, 'confirmed')
    const repayment = await prepareCandidateRepay(publicClient, agentAccount.address, id)
    assert.equal(repayment.kind, 'repay')
    assert.equal((await executeCandidateCall(repayerSession, repayment)).status, 'confirmed')
    const repaid = await readCandidateLine(publicClient, id)
    assert.equal(repaid.stateName, 'OPEN'); assert.equal(repaid.principalOutstanding, 0n); assert.equal(repaid.cumulativePrincipalPaid, 50_000n)
    const close = await prepareCandidateReclaim(publicClient, sponsorAccount.address, id)
    assert.equal(close.amount, 100_000n)
    assert.equal((await executeCandidateCall(sponsorSession, close)).status, 'confirmed')
    assert.equal((await readCandidateLine(publicClient, id)).stateName, 'CLOSED')
    const balance = (who: Address) => publicClient.readContract({ address: CANDIDATE_FUNDING.usdc, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [who] })
    assert.equal(await balance(sponsorAccount.address), 1_000_000n)
    assert.equal(await balance(providerAccount.address), 50_000n)
    assert.equal(await balance(CANDIDATE_FUNDING.address), 0n)
  } finally { anvil.stop() }
})
