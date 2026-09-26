import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, isAddress, isAddressEqual, keccak256, parseUnits, stringToHex, zeroAddress, zeroHash, defineChain, type Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem'
import candidateAbiJson from '../scripts/float-mainnet-abi.json' with { type: 'json' }

export const CANDIDATE_FUNDING = {
  chainId: 5042002,
  address: '0xFeDb5c8c29792d49947492F357f21dc8405F08fc' as Address,
  usdc: '0x3600000000000000000000000000000000000000' as Address,
  runtimeHash: '0x5d56518ac900ce9d973912c891fd278d9ead5861d934eaa0df5dc5558774a249' as Hash,
  signatureTtl: 900n,
  // Initial deployment ceilings also bound this first browser release. Owner
  // increases never silently enlarge what this interface can fund.
  maxReserve: 5_000_000n,
  maxLineSpend: 5_000_000n,
  maxDailySpend: 2_000_000n,
  maxPerSpend: 1_000_000n,
} as const
export const candidateFundingAbi = candidateAbiJson as Abi
export const candidateFundingChain = defineChain({ id: CANDIDATE_FUNDING.chainId, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } }, blockExplorers: { default: { name: 'Arc testnet explorer', url: 'https://testnet.arcscan.app' } }, testnet: true })
export type CandidateReadClient = Pick<PublicClient, 'getChainId' | 'getCode' | 'readContract' | 'getBlock' | 'simulateContract' | 'getTransaction' | 'getTransactionReceipt'>
export type CandidateWalletClient = Pick<WalletClient, 'getAddresses' | 'getChainId' | 'sendTransaction' | 'request'>
export interface CandidateOpenInput {
  agent: string; provider: string; endpoint: string
  reserve: string; lineSpendCap: string; dailySpendCap: string
  providerPerSpendCap: string; providerDailyCap: string
  expiryDays: string; repaymentHours: string
}
export interface CandidateLimits { protocolReserve: bigint; lineReserve: bigint; lineSpend: bigint; perSpend: bigint; dailySpend: bigint }
export interface CandidateLine {
  lineId: Hash; sponsor: Address; agent: Address; epoch: bigint; expiry: bigint; maximumRepaymentWindow: bigint; day: bigint; termsVersion: bigint
  state: number; stateName: 'NONE' | 'OPEN' | 'DRAWN' | 'DEFAULTED' | 'CLOSED'
  reserveCap: bigint; availableReserve: bigint; principalOutstanding: bigint; recoveryAvailable: bigint
  lineSpendCap: bigint; dailySpendCap: bigint; cumulativePrincipalPaid: bigint; spentToday: bigint; dueAt: bigint
  observedBlock: bigint; observedTimestamp: bigint; sponsorAllowed: boolean; spendsPaused: boolean
}
export interface CandidateSnapshot {
  sponsor: Address; observedBlock: bigint; observedTimestamp: bigint
  sponsorAllowed: boolean; openingsPaused: boolean; spendsPaused: boolean
  limits: CandidateLimits; totalCommittedCapital: bigint; minimumRepaymentWindow: bigint; maximumRepaymentWindow: bigint
  balance: bigint; allowance: bigint; activeLineId: Hash; nextEpoch: bigint; activeLine: CandidateLine | null
}
export type CandidateAction = 'approve' | 'open' | 'repay' | 'close' | 'claim-defaulted'
export interface CandidatePrepared {
  kind: CandidateAction; account: Address; to: Address; data: Hex; value: '0'; amount: bigint
  lineId: Hash | null; agent: Address | null; expectedEpoch: bigint | null
  observedBlock: bigint; summary: string; nextAction?: 'open' | 'repay'; lineFingerprint?: string
}
export interface CandidatePending {
  version: 1; chainId: number; candidate: Address; account: Address; kind: CandidateAction
  to: Address; data: Hex; value: '0'; amount: string; lineId: Hash | null; agent: Address | null
  expectedEpoch: string | null; fromBlock: string; nonce: number; createdAt: string
  status: 'wallet' | 'pending' | 'unknown'; txHash: Hash | null
}
export interface CandidateStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface CandidateJournal { key: string; load(): CandidatePending | null; save(pending: CandidatePending): void; clear(): void }
export interface CandidateSession { publicClient: CandidateReadClient; walletClient: CandidateWalletClient; account: Address; journal: CandidateJournal; onStage?: (pending: CandidatePending) => void }
export type CandidateResolution = { status: 'confirmed' | 'reverted' | 'replaced' | 'unknown'; txHash: Hash | null; message: string; lineId?: Hash }

const states = ['NONE', 'OPEN', 'DRAWN', 'DEFAULTED', 'CLOSED'] as const
const typeString = 'SpendIntent(address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor)'
const memoryLocks = new Set<string>()
const uintKeys = ['epoch', 'expiry', 'maximumRepaymentWindow', 'day', 'termsVersion', 'reserveCap', 'availableReserve', 'principalOutstanding', 'recoveryAvailable', 'lineSpendCap', 'dailySpendCap', 'cumulativePrincipalPaid', 'spentToday', 'dueAt'] as const

function address(raw: string, label = 'Wallet'): Address {
  if (!isAddress(raw) || isAddressEqual(raw, zeroAddress)) throw new Error(`${label} must be a nonzero wallet address.`)
  return getAddress(raw)
}
function hash(raw: string, label = 'Line ID'): Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw) || raw.toLowerCase() === zeroHash) throw new Error(`${label} must be a nonzero 32-byte hash.`)
  return raw.toLowerCase() as Hash
}
function same(a: string, b: string) { return a.toLowerCase() === b.toLowerCase() }
function amount(raw: string, label: string, ceiling: bigint): bigint {
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(raw)) throw new Error(`${label} must be a positive USDC amount with up to six decimal places.`)
  const parsed = parseUnits(raw, 6)
  if (parsed <= 0n || parsed > ceiling) throw new Error(`${label} is outside the current testnet limit.`)
  return parsed
}
function duration(raw: string, multiplier: bigint, label: string): bigint {
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`${label} must be a whole number.`)
  return BigInt(raw) * multiplier
}
function min(a: bigint, b: bigint) { return a < b ? a : b }
function read(client: CandidateReadClient, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<any> {
  return client.readContract({ address: CANDIDATE_FUNDING.address, abi: candidateFundingAbi, functionName, args, blockNumber })
}
function tokenRead(client: CandidateReadClient, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<any> {
  return client.readContract({ address: CANDIDATE_FUNDING.usdc, abi: erc20Abi, functionName: functionName as any, args: args as any, blockNumber })
}
export function candidateErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0]
  return 'The request could not be completed. Check the connection and try refreshing.'
}

export async function verifyCandidate(client: CandidateReadClient): Promise<void> {
  if (await client.getChainId() !== CANDIDATE_FUNDING.chainId) throw new Error('This workflow only supports Arc testnet.')
  const code = await client.getCode({ address: CANDIDATE_FUNDING.address })
  if (!code || keccak256(code) !== CANDIDATE_FUNDING.runtimeHash) throw new Error('The deployed contract does not match the verified Shadow testnet candidate.')
  // The browser transport serializes requests. Start each read only after the
  // preceding one succeeds, so an RPC failure leaves no stale batch queued.
  const name = await read(client, 'NAME_HASH')
  const version = await read(client, 'VERSION_HASH')
  const type = await read(client, 'SPEND_INTENT_TYPEHASH')
  const chainId = await read(client, 'deploymentChainId')
  const usdc = await read(client, 'usdc')
  const decimals = await tokenRead(client, 'decimals')
  if (name !== keccak256(stringToHex('ShadowFloatMainnet')) || version !== keccak256(stringToHex('1')) || type !== keccak256(stringToHex(typeString)) || BigInt(chainId) !== BigInt(CANDIDATE_FUNDING.chainId) || !same(usdc, CANDIDATE_FUNDING.usdc) || Number(decimals) !== 6) throw new Error('Candidate identity or USDC configuration is inconsistent. Writes are disabled.')
}

async function lineAt(client: CandidateReadClient, lineId: Hash, block: { number: bigint; timestamp: bigint }): Promise<CandidateLine> {
  const raw = await read(client, 'getLine', [lineId], block.number)
  const spendsPaused = await read(client, 'spendsPaused', [], block.number)
  const state = Number(raw.state)
  if (!Number.isInteger(state) || state <= 0 || state >= states.length) throw new Error('No candidate funding line exists with this ID.')
  const sponsor = address(raw.sponsor)
  const sponsorAllowed = await read(client, 'sponsorAllowed', [sponsor], block.number)
  const fields = Object.fromEntries(uintKeys.map(key => [key, BigInt(raw[key])]))
  return { ...fields, lineId, sponsor, agent: address(raw.agent), state, stateName: states[state], observedBlock: block.number, observedTimestamp: block.timestamp, sponsorAllowed: Boolean(sponsorAllowed), spendsPaused: Boolean(spendsPaused) } as CandidateLine
}

export async function readCandidateLine(client: CandidateReadClient, rawLineId: string): Promise<CandidateLine> {
  const lineId = hash(rawLineId)
  await verifyCandidate(client)
  const block = await client.getBlock()
  return lineAt(client, lineId, block)
}

export async function readCandidateSnapshot(client: CandidateReadClient, input: { sponsor: string; agent?: string }): Promise<CandidateSnapshot> {
  const sponsor = address(input.sponsor)
  const agent = input.agent ? address(input.agent, 'Agent') : null
  await verifyCandidate(client)
  const block = await client.getBlock()
  const at = (name: string, args: readonly unknown[] = []) => read(client, name, args, block.number)
  const allowed = await at('sponsorAllowed', [sponsor])
  const openingsPaused = await at('openingsPaused')
  const spendsPaused = await at('spendsPaused')
  const limits = await at('effectiveLimits')
  const committed = await at('totalCommittedCapital')
  const minimum = await at('minimumRepaymentWindow')
  const maximum = await at('maximumRepaymentWindow')
  const balance = await tokenRead(client, 'balanceOf', [sponsor], block.number)
  const allowance = await tokenRead(client, 'allowance', [sponsor, CANDIDATE_FUNDING.address], block.number)
  const activeLineId = agent ? await at('activeLineId', [sponsor, agent]) : zeroHash
  const epoch = agent ? await at('nextLineEpoch', [sponsor, agent]) : 0n
  return {
    sponsor, observedBlock: block.number, observedTimestamp: block.timestamp, sponsorAllowed: Boolean(allowed), openingsPaused: Boolean(openingsPaused), spendsPaused: Boolean(spendsPaused),
    limits: { protocolReserve: BigInt(limits[0]), lineReserve: BigInt(limits[1]), lineSpend: BigInt(limits[2]), perSpend: BigInt(limits[3]), dailySpend: BigInt(limits[4]) },
    totalCommittedCapital: BigInt(committed), minimumRepaymentWindow: BigInt(minimum), maximumRepaymentWindow: BigInt(maximum), balance: BigInt(balance), allowance: BigInt(allowance),
    activeLineId, nextEpoch: BigInt(epoch) + 1n, activeLine: activeLineId === zeroHash ? null : await lineAt(client, activeLineId, block),
  }
}

function predictedLine(sponsor: Address, agent: Address, epoch: bigint): Hash {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint64' }], [BigInt(CANDIDATE_FUNDING.chainId), CANDIDATE_FUNDING.address, sponsor, agent, epoch]))
}
function approval(account: Address, value: bigint, observedBlock: bigint, nextAction: 'open' | 'repay'): CandidatePrepared {
  return { kind: 'approve', account, to: CANDIDATE_FUNDING.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CANDIDATE_FUNDING.address, value] }), value: '0', amount: value, lineId: null, agent: null, expectedEpoch: null, observedBlock, summary: 'Approve exactly this testnet USDC amount for Shadow. Funding requires a separate confirmation.', nextAction }
}
function fingerprint(line: CandidateLine): string {
  return [line.state, line.principalOutstanding, line.cumulativePrincipalPaid, line.dueAt, line.availableReserve, line.recoveryAvailable].join(':')
}

export async function prepareCandidateOpen(client: CandidateReadClient, rawAccount: string, input: CandidateOpenInput): Promise<CandidatePrepared> {
  const account = address(rawAccount)
  const agent = address(input.agent, 'Agent')
  const provider = address(input.provider, 'Provider')
  if (same(provider, CANDIDATE_FUNDING.address)) throw new Error('The provider cannot be the funding contract.')
  let endpoint: URL
  try { endpoint = new URL(input.endpoint) } catch { throw new Error('Enter the exact HTTPS endpoint agreed with your provider.') }
  if (input.endpoint !== input.endpoint.trim() || endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Use the exact HTTPS provider endpoint without credentials, fragments, or surrounding spaces.')
  const snapshot = await readCandidateSnapshot(client, { sponsor: account, agent })
  if (!snapshot.sponsorAllowed) throw new Error('This sponsor has not been enabled for the testnet pilot. Request access before funding.')
  if (snapshot.openingsPaused) throw new Error('Opening new funding lines is currently paused.')
  if (snapshot.activeLine && !['CLOSED', 'DEFAULTED'].includes(snapshot.activeLine.stateName)) throw new Error('This sponsor and agent already have an active funding line. Manage that line first.')
  const reserve = amount(input.reserve, 'Reserve', min(snapshot.limits.lineReserve, CANDIDATE_FUNDING.maxReserve))
  const lineSpendCap = amount(input.lineSpendCap, 'Total purchase limit', min(snapshot.limits.lineSpend, CANDIDATE_FUNDING.maxLineSpend))
  const dailySpendCap = amount(input.dailySpendCap, 'Daily purchase limit', min(snapshot.limits.dailySpend, CANDIDATE_FUNDING.maxDailySpend))
  const providerPerSpendCap = amount(input.providerPerSpendCap, 'Per-purchase limit', min(snapshot.limits.perSpend, CANDIDATE_FUNDING.maxPerSpend))
  const providerDailyCap = amount(input.providerDailyCap, 'Provider daily limit', min(snapshot.limits.dailySpend, CANDIDATE_FUNDING.maxDailySpend))
  const lifetime = duration(input.expiryDays, 86_400n, 'Line lifetime in days')
  const maximumRepaymentWindow = duration(input.repaymentHours, 3_600n, 'Repayment window in hours')
  const floor = snapshot.minimumRepaymentWindow + CANDIDATE_FUNDING.signatureTtl
  if (lifetime < floor || lifetime > 7n * 86_400n) throw new Error('Use a funding-line lifetime of one to seven days.')
  if (maximumRepaymentWindow < floor || maximumRepaymentWindow > snapshot.maximumRepaymentWindow) throw new Error('The repayment window must allow the minimum repayment period plus 15 minutes for signing, within the contract maximum.')
  if (snapshot.totalCommittedCapital + reserve > snapshot.limits.protocolReserve) throw new Error('The pilot has insufficient remaining reserve capacity.')
  if (snapshot.balance < reserve) throw new Error('This wallet does not have enough testnet USDC for the reserve.')
  const lineId = predictedLine(account, agent, snapshot.nextEpoch)
  if (snapshot.allowance < reserve) return approval(account, reserve, snapshot.observedBlock, 'open')
  const params = { agent, reserve, lineSpendCap, dailySpendCap, lineExpiry: snapshot.observedTimestamp + lifetime, maximumRepaymentWindow, provider, endpointHash: keccak256(stringToHex(input.endpoint)), providerPerSpendCap, providerDailyCap, providerExpiry: snapshot.observedTimestamp + lifetime }
  return { kind: 'open', account, to: CANDIDATE_FUNDING.address, data: encodeFunctionData({ abi: candidateFundingAbi, functionName: 'openLine', args: [params] }), value: '0', amount: reserve, lineId, agent, expectedEpoch: snapshot.nextEpoch, observedBlock: snapshot.observedBlock, summary: 'Fund this line with testnet USDC. The provider can only be paid under the limits shown.' }
}

export async function prepareCandidateRepay(client: CandidateReadClient, rawAccount: string, rawLineId: string): Promise<CandidatePrepared> {
  const account = address(rawAccount)
  const line = await readCandidateLine(client, rawLineId)
  if (!['DRAWN', 'DEFAULTED'].includes(line.stateName) || line.principalOutstanding <= 0n) throw new Error('This line has no outstanding debt to repay.')
  if (line.principalOutstanding > CANDIDATE_FUNDING.maxReserve) throw new Error('This repayment exceeds the browser testnet limit.')
  const balance = await tokenRead(client, 'balanceOf', [account], line.observedBlock)
  const allowance = await tokenRead(client, 'allowance', [account, CANDIDATE_FUNDING.address], line.observedBlock)
  if (BigInt(balance) < line.principalOutstanding) throw new Error('This wallet does not have enough testnet USDC to repay the debt.')
  if (BigInt(allowance) < line.principalOutstanding) return approval(account, line.principalOutstanding, line.observedBlock, 'repay')
  return { kind: 'repay', account, to: CANDIDATE_FUNDING.address, data: encodeFunctionData({ abi: candidateFundingAbi, functionName: 'repay', args: [line.lineId, line.principalOutstanding] }), value: '0', amount: line.principalOutstanding, lineId: line.lineId, agent: line.agent, expectedEpoch: line.epoch, observedBlock: line.observedBlock, lineFingerprint: fingerprint(line), summary: line.stateName === 'DEFAULTED' ? 'Repay this debt into sponsor recovery. The defaulted line stays closed to new purchases.' : 'Repay the displayed debt in full. Repayment restores reserve but does not reset the total purchase limit.' }
}

export async function prepareCandidateReclaim(client: CandidateReadClient, rawAccount: string, rawLineId: string): Promise<CandidatePrepared> {
  const account = address(rawAccount)
  const line = await readCandidateLine(client, rawLineId)
  if (!same(account, line.sponsor)) throw new Error('Only this line’s sponsor can reclaim its funds.')
  const close = line.stateName === 'OPEN' && line.principalOutstanding === 0n
  if (!close && line.stateName !== 'DEFAULTED') throw new Error('Reclaim requires a debt-free open line, or recoverable funds on a defaulted line.')
  const value = close ? line.availableReserve : line.availableReserve + line.recoveryAvailable
  if (value <= 0n) throw new Error('There are no funds available to reclaim.')
  return { kind: close ? 'close' : 'claim-defaulted', account, to: CANDIDATE_FUNDING.address, data: encodeFunctionData({ abi: candidateFundingAbi, functionName: close ? 'closeLine' : 'claimDefaulted', args: [line.lineId] }), value: '0', amount: value, lineId: line.lineId, agent: line.agent, expectedEpoch: line.epoch, observedBlock: line.observedBlock, lineFingerprint: fingerprint(line), summary: close ? 'Close the funding line and return its available testnet USDC to the sponsor.' : 'Return available reserve and recovered repayments to the sponsor. Outstanding unpaid debt is not recovered by this action.' }
}

function checkPending(value: unknown, expectedAccount?: Address): CandidatePending {
  const p = value as CandidatePending
  const actions: string[] = ['approve', 'open', 'repay', 'close', 'claim-defaulted']
  if (!p || p.version !== 1 || p.chainId !== CANDIDATE_FUNDING.chainId || !same(p.candidate ?? '', CANDIDATE_FUNDING.address) || !isAddress(p.account) || (expectedAccount && !same(expectedAccount, p.account)) || !actions.includes(p.kind) || !isAddress(p.to) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(p.data) || p.data.length > 4096 || p.value !== '0' || !/^\d+$/.test(p.amount) || !/^\d+$/.test(p.fromBlock) || !Number.isSafeInteger(p.nonce) || p.nonce < 0 || !['wallet', 'pending', 'unknown'].includes(p.status) || (p.txHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(p.txHash))) throw new Error('The saved transaction record is invalid. Keep it for investigation; no new transaction was sent.')
  // Decode the saved call, so reconciliation cannot accidentally certify an
  // unrelated or wrong-contract record as a completed product action.
  checkedCall(p)
  return p
}

export function createCandidateJournal(storage: CandidateStorage, rawAccount: string): CandidateJournal {
  const account = address(rawAccount)
  const key = `shadow:candidate-funding:v1:${CANDIDATE_FUNDING.chainId}:${CANDIDATE_FUNDING.address.toLowerCase()}:${account.toLowerCase()}`
  return {
    key,
    load() {
      const raw = storage.getItem(key)
      if (raw === null) return null
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new Error('The saved transaction record is unreadable. No new transaction was sent.') }
      return checkPending(parsed, account)
    },
    save(pending) {
      checkPending(pending, account)
      const raw = JSON.stringify(pending)
      storage.setItem(key, raw)
      if (storage.getItem(key) !== raw) throw new Error('Transaction recovery storage is unavailable. Stop and check wallet activity before another action.')
    },
    clear() { storage.removeItem(key) },
  }
}

function checkedCall(record: Pick<CandidatePrepared, 'kind' | 'to' | 'data' | 'value' | 'lineId'> & { amount: bigint | string }) {
  const isApproval = record.kind === 'approve'
  if (!same(record.to, isApproval ? CANDIDATE_FUNDING.usdc : CANDIDATE_FUNDING.address) || record.value !== '0') throw new Error('The transaction does not target the expected testnet contract.')
  const abi: Abi = isApproval ? erc20Abi : candidateFundingAbi
  const decoded = decodeFunctionData({ abi, data: record.data })
  const expectedName = { approve: 'approve', open: 'openLine', repay: 'repay', close: 'closeLine', 'claim-defaulted': 'claimDefaulted' }[record.kind]
  if (decoded.functionName !== expectedName) throw new Error('The transaction action does not match its calldata.')
  const args = decoded.args as readonly any[]
  const value = BigInt(record.amount)
  if (value <= 0n) throw new Error('The transaction amount must be positive.')
  if (isApproval && (!same(args[0], CANDIDATE_FUNDING.address) || BigInt(args[1]) !== value || value > CANDIDATE_FUNDING.maxReserve)) throw new Error('Only an exact bounded approval to the testnet candidate is supported.')
  if (record.kind === 'open') {
    const p = args[0]
    if (BigInt(p.reserve) !== value || value > CANDIDATE_FUNDING.maxReserve || BigInt(p.lineSpendCap) <= 0n || BigInt(p.lineSpendCap) > CANDIDATE_FUNDING.maxLineSpend || BigInt(p.dailySpendCap) <= 0n || BigInt(p.dailySpendCap) > CANDIDATE_FUNDING.maxDailySpend || BigInt(p.providerPerSpendCap) <= 0n || BigInt(p.providerPerSpendCap) > CANDIDATE_FUNDING.maxPerSpend || BigInt(p.providerDailyCap) <= 0n || BigInt(p.providerDailyCap) > CANDIDATE_FUNDING.maxDailySpend) throw new Error('The funding line exceeds this browser release’s testnet limits.')
  } else if (!isApproval) {
    if (!record.lineId || !same(args[0], record.lineId)) throw new Error('The transaction line does not match its calldata.')
    if (record.kind === 'repay' && (BigInt(args[1]) !== value || value > CANDIDATE_FUNDING.maxReserve)) throw new Error('The repayment must equal the displayed bounded amount.')
  }
  return { abi, functionName: decoded.functionName, args }
}

function rejected(error: unknown): boolean {
  let current: any = error
  const visited = new Set<unknown>()
  while (current && !visited.has(current)) {
    if (current.code === 4001) return true
    visited.add(current)
    current = current.cause
  }
  return false
}
function stage(session: CandidateSession, pending: CandidatePending) {
  // Presentation callbacks must never hide a send result or clear its journal.
  try { session.onStage?.(pending) } catch { /* recovery remains authoritative */ }
}
async function walletMatches(session: CandidateSession) {
  const chainId = await session.walletClient.getChainId()
  if (chainId !== CANDIDATE_FUNDING.chainId) throw new Error('Switch the connected wallet to Arc testnet before confirming.')
  const accounts = await session.walletClient.getAddresses()
  if (!accounts[0] || !same(accounts[0], session.account)) throw new Error('The selected wallet account changed. Refresh the action before signing.')
}

async function walletPendingNonce(session: CandidateSession): Promise<number> {
  // The wallet's provider may see pending transactions absent from the public
  // read RPC. Never use that public RPC to choose an explicit signing nonce.
  const raw = await session.walletClient.request<{ Parameters: [Address, 'pending']; ReturnType: Hex }>({ method: 'eth_getTransactionCount', params: [session.account, 'pending'] })
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('The connected wallet did not return a valid pending transaction nonce. No wallet transaction was requested.')
  const nonce = BigInt(raw)
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The wallet transaction nonce is outside the supported range. No wallet transaction was requested.')
  return Number(nonce)
}

export async function executeCandidateCall(session: CandidateSession, prepared: CandidatePrepared): Promise<CandidateResolution> {
  if (!same(session.account, prepared.account)) throw new Error('This action was prepared for a different wallet.')
  if (memoryLocks.has(session.journal.key)) throw new Error('A transaction for this account is already being prepared.')
  memoryLocks.add(session.journal.key)
  try {
    if (session.journal.load()) throw new Error('Resolve the saved transaction before starting another wallet action.')
    const { publicClient: client } = session
    await verifyCandidate(client)
    await walletMatches(session)
    const accountCode = await client.getCode({ address: session.account })
    if (accountCode && accountCode !== '0x') throw new Error('This funding interface currently supports browser EOA accounts only. Use the separate Circle signing flow for a Modular Wallet.')
    const call = checkedCall(prepared)
    if (prepared.kind === 'open') {
      const p = call.args[0]
      const current = await readCandidateSnapshot(client, { sponsor: session.account, agent: p.agent })
      if (prepared.expectedEpoch !== current.nextEpoch || !prepared.lineId || !same(predictedLine(session.account, p.agent, current.nextEpoch), prepared.lineId)) throw new Error('The funding-line epoch changed. Refresh before opening a line.')
      if (BigInt(p.lineExpiry) < current.observedTimestamp + current.minimumRepaymentWindow + CANDIDATE_FUNDING.signatureTtl || BigInt(p.providerExpiry) < current.observedTimestamp + current.minimumRepaymentWindow + CANDIDATE_FUNDING.signatureTtl) throw new Error('This prepared line expires too soon. Refresh before funding.')
    } else if (prepared.kind !== 'approve') {
      const current = await readCandidateLine(client, prepared.lineId!)
      if (!prepared.lineFingerprint || fingerprint(current) !== prepared.lineFingerprint) throw new Error('The line or debt changed. Refresh and review the current amount before confirming.')
    }
    await client.simulateContract({ address: prepared.to, abi: call.abi, functionName: call.functionName, args: call.args, account: session.account })
    const block = await client.getBlock()
    await walletMatches(session)
    const nonce = await walletPendingNonce(session)
    // Persist before opening the wallet: a provider can broadcast successfully
    // and lose its response without ever returning a transaction hash.
    let pending: CandidatePending = {
      version: 1, chainId: CANDIDATE_FUNDING.chainId, candidate: CANDIDATE_FUNDING.address, account: session.account, kind: prepared.kind,
      to: prepared.to, data: prepared.data, value: '0', amount: prepared.amount.toString(), lineId: prepared.lineId, agent: prepared.agent,
      expectedEpoch: prepared.expectedEpoch?.toString() ?? null, fromBlock: block.number.toString(), nonce, createdAt: new Date().toISOString(), status: 'wallet', txHash: null,
    }
    session.journal.save(pending)
    stage(session, pending)
    try {
      // Recheck the same provider immediately before requesting a send. This
      // is not an atomic reservation: another app/device can still submit
      // while the wallet prompt is open. Keep prompts brief and stop if another
      // transaction is submitted; profile tab locks do not protect other apps.
      await walletMatches(session)
      if (await walletPendingNonce(session) !== nonce) throw new Error('Your wallet has another pending transaction. No wallet transaction was requested here. Finish it, then review this action again.')
      await walletMatches(session)
    } catch (error) {
      // No send request has occurred, so this journal belongs to a definitely
      // unsubmitted preparation, not an uncertain broadcast.
      session.journal.clear()
      throw error
    }
    let txHash: Hash
    try {
      txHash = await session.walletClient.sendTransaction({ account: session.account, chain: candidateFundingChain, to: prepared.to, data: prepared.data, value: 0n, nonce })
    } catch (error) {
      if (rejected(error)) { session.journal.clear(); throw new Error('The wallet request was declined. No transaction was submitted by this request.') }
      pending = { ...pending, status: 'unknown' }
      session.journal.save(pending)
      stage(session, pending)
      return { status: 'unknown', txHash: null, message: 'The wallet did not return a reliable transaction result. Check its activity and reconcile the transaction hash before trying again.' }
    }
    pending = { ...pending, status: 'pending', txHash }
    session.journal.save(pending)
    stage(session, pending)
    const outcome = await reconcileCandidatePending(client, pending)
    if (outcome.status !== 'unknown') session.journal.clear()
    else { pending = { ...pending, status: 'unknown' }; session.journal.save(pending); stage(session, pending) }
    return outcome
  } finally { memoryLocks.delete(session.journal.key) }
}

function hasExpectedEvent(pending: CandidatePending, receipt: { logs: readonly any[] }): boolean {
  const expected = { approve: 'Approval', open: 'LineOpened', repay: 'Repaid', close: 'LineClosed', 'claim-defaulted': 'SponsorClaimed' }[pending.kind]
  for (const log of receipt.logs) {
    if (!same(log.address, pending.to)) continue
    try {
      const event = decodeEventLog({ abi: pending.kind === 'approve' ? erc20Abi : candidateFundingAbi, data: log.data, topics: log.topics })
      if (event.eventName !== expected) continue
      const args: any = event.args
      if (pending.kind === 'approve') return same(args.owner, pending.account) && same(args.spender, CANDIDATE_FUNDING.address) && BigInt(args.value) === BigInt(pending.amount)
      if (!pending.lineId || !same(args.lineId, pending.lineId)) continue
      if (pending.kind === 'open') return same(args.sponsor, pending.account) && !!pending.agent && same(args.agent, pending.agent) && BigInt(args.reserve) === BigInt(pending.amount) && String(args.epoch) === pending.expectedEpoch
      if (pending.kind === 'repay') return same(args.payer, pending.account) && BigInt(args.amount) === BigInt(pending.amount)
      // Closing and reclaiming can return a newer balance if a repayment raced
      // the wallet prompt; the exact call identity and sponsor are authoritative.
      return same(args.sponsor, pending.account)
    } catch { /* other logs cannot establish this action */ }
  }
  return false
}

export async function reconcileCandidatePending(client: CandidateReadClient, rawPending: CandidatePending, providedHash?: string): Promise<CandidateResolution> {
  const pending = checkPending(rawPending)
  const txHash = providedHash ? hash(providedHash, 'Transaction hash') : pending.txHash
  const unknown = (message: string): CandidateResolution => ({ status: 'unknown', txHash, message })
  if (!txHash) return unknown('Open your wallet activity, copy this action’s transaction hash, and check it here. Do not submit the action again while its outcome is unknown.')
  try {
    await verifyCandidate(client)
    const transaction = await client.getTransaction({ hash: txHash })
    const receipt = await client.getTransactionReceipt({ hash: txHash })
    if (!same(transaction.from, pending.account) || Number(transaction.nonce) !== pending.nonce || (transaction.chainId != null && Number(transaction.chainId) !== CANDIDATE_FUNDING.chainId)) return unknown('This transaction is not from the saved wallet and nonce. The original action is still unresolved.')
    if (!receipt.blockHash || receipt.blockNumber < BigInt(pending.fromBlock) || !same(receipt.transactionHash, txHash) || !same(transaction.hash, txHash)) return unknown('The transaction receipt does not match the saved action’s chain history.')
    // A receipt on an orphaned block must not unlock a replacement payment.
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber })
    if (!same(canonical.hash, receipt.blockHash) || (transaction.blockHash && !same(transaction.blockHash, receipt.blockHash))) return unknown('The transaction is not yet confirmed in the canonical chain. Check again.')
    const exact = transaction.to !== null && same(transaction.to, pending.to) && same(transaction.input, pending.data) && transaction.value === 0n
    if (!exact) return { status: 'replaced', txHash, message: 'A different transaction consumed this wallet nonce. The saved Shadow action was replaced; refresh current state before preparing any new action.' }
    if (receipt.status !== 'success') return { status: 'reverted', txHash, message: 'The transaction reverted onchain. Its intended action did not complete; refresh before preparing another request.' }
    if (!hasExpectedEvent(pending, receipt)) return unknown('The transaction succeeded, but its expected Shadow event could not be verified. Keep this record and investigate before retrying.')
    return { status: 'confirmed', txHash, message: 'The exact transaction and its onchain result are confirmed.', ...(pending.lineId ? { lineId: pending.lineId } : {}) }
  } catch {
    return unknown('Confirmation is pending or the chain could not be read reliably. Keep this transaction record and check again; nothing has been resent.')
  }
}
