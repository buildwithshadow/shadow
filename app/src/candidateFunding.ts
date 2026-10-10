import { ARC_TESTNET_RPC_URL, ARC_TESTNET_EXPLORER_URL, arcTestnetConnectionHelp } from "../arcTestnetNetwork.mjs";
import { TransactionReceiptNotFoundError, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, isAddress, isAddressEqual, keccak256, parseUnits, stringToHex, zeroAddress, zeroHash, defineChain, type Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem'
import candidateAbiJson from '../scripts/float-mainnet-abi.json' with { type: 'json' }
import { parseAbi } from 'viem'
const drawBindingAbi = parseAbi(['function currentDrawDigest(bytes32) view returns (bytes32)', 'function repaymentBindingVersion() view returns (uint256)', 'function repayForDraw(bytes32 lineId, bytes32 expectedDraw, uint256 amount)', 'event DrawRepaid(bytes32 indexed lineId, bytes32 indexed drawDigest, address indexed payer, uint256 amount, uint256 principalRemaining)'])

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
export const candidateFundingChain = defineChain({ id: CANDIDATE_FUNDING.chainId, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [ARC_TESTNET_RPC_URL] } }, blockExplorers: { default: { name: 'Arc testnet explorer', url: ARC_TESTNET_EXPLORER_URL } }, testnet: true })
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
  drawDigest?: Hash
}
export interface CandidateSnapshot {
  sponsor: Address; observedBlock: bigint; observedTimestamp: bigint
  sponsorAllowed: boolean; openingsPaused: boolean; spendsPaused: boolean
  limits: CandidateLimits; totalCommittedCapital: bigint; minimumRepaymentWindow: bigint; maximumRepaymentWindow: bigint
  balance: bigint; allowance: bigint; activeLineId: Hash; nextEpoch: bigint; activeLine: CandidateLine | null
}
export type CandidateAction = 'register' | 'approve' | 'open' | 'repay' | 'default' | 'close' | 'claim-defaulted'
export interface CandidatePrepared {
  kind: CandidateAction; account: Address; to: Address; data: Hex; value: '0'; amount: bigint
  lineId: Hash | null; agent: Address | null; expectedEpoch: bigint | null
  observedBlock: bigint; summary: string; nextAction?: 'open' | 'repay'; lineFingerprint?: string
}
export interface CandidatePending {
  version: 1; chainId: number; candidate: Address; account: Address; kind: CandidateAction
  to: Address; data: Hex; value: '0'; amount: string; lineId: Hash | null; agent: Address | null
  expectedEpoch: string | null; fromBlock: string; nonce: number; createdAt: string
  status: 'wallet' | 'pending' | 'unknown'; txHash: Hash | null; actualNonce?: number
}
export interface CandidateStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface CandidateJournal { key: string; load(): CandidatePending | null; save(pending: CandidatePending): void; clear(): void }
export interface CandidateSession { publicClient: CandidateReadClient; walletClient: CandidateWalletClient; account: Address; journal: CandidateJournal; onStage?: (pending: CandidatePending) => void }
export type CandidateResolution = { status: 'confirmed' | 'reverted' | 'replaced' | 'unknown'; txHash: Hash | null; message: string; lineId?: Hash }

export interface CandidateDeployment {
  chainId: number; address: Address; usdc: Address; runtimeHash: Hash; signatureTtl: bigint;
  maxReserve: bigint; maxLineSpend: bigint; maxDailySpend: bigint; maxPerSpend: bigint;
  selfRegistration?: boolean; drawBoundRepayment?: boolean;
}
// Both published endpoints were verified against older payment receipts.
// A recent-state RPC returning null for an old receipt cannot establish nonpayment.
// https://docs.arc.io/arc/references/connect-to-arc
export const guardedMainnetChain = defineChain({ id: 5042, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.quicknode.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io'] } }, blockExplorers: { default: { name: 'Arc explorer', url: 'https://explorer.arc.io' } } })
export function candidateChainFor(deployment: CandidateDeployment) {
  if (deployment.chainId === 5042002) return candidateFundingChain
  if (deployment.chainId === 5042 && deployment.drawBoundRepayment) return guardedMainnetChain
  throw new Error('Unsupported funding deployment.')
}
export function createGuardedMainnetFundingKit(deployment: CandidateDeployment) {
  if (deployment.chainId !== 5042 || !deployment.drawBoundRepayment || deployment.selfRegistration
      || deployment.maxReserve <= 0n || deployment.maxReserve > 100_000n
      || [deployment.maxLineSpend, deployment.maxDailySpend, deployment.maxPerSpend].some(cap => cap <= 0n || cap > 5_000n)) {
    throw new Error('Guarded mainnet requires draw-bound repayment, admitted sponsors and the bounded release limits.')
  }
  return createFundingKit(deployment)
}
export function createPublicMainnetFundingKit(deployment: CandidateDeployment) {
  if (deployment.chainId !== 5042 || !deployment.drawBoundRepayment || deployment.selfRegistration !== true
      || deployment.maxReserve <= 0n || deployment.maxReserve > 100_000n
      || [deployment.maxLineSpend, deployment.maxDailySpend, deployment.maxPerSpend].some(cap => cap <= 0n || cap > 5_000n)) {
    throw new Error('Public mainnet requires self registration, draw-bound repayment and the bounded release limits.')
  }
  return createFundingKit(deployment)
}
export function createCandidateFundingKit(deployment: CandidateDeployment) {
  if (deployment.chainId !== 5042002) throw new Error('Only Arc testnet is supported.')
  return createFundingKit(deployment)
}
function createFundingKit(inputDeployment: CandidateDeployment) {
  const deployment = Object.freeze({ ...inputDeployment })
  const CANDIDATE_FUNDING = deployment
  const candidateFundingChain = candidateChainFor(deployment)
  const mainnet = deployment.chainId === 5042
  const network = mainnet ? 'Arc mainnet' : 'Arc testnet'
  const currency = mainnet ? 'USDC' : 'testnet USDC'
  const baseAbi: Abi = deployment.selfRegistration ? [...candidateAbiJson,
    { type: 'function', name: 'registerSponsor', inputs: [], outputs: [], stateMutability: 'nonpayable' },
    { type: 'function', name: 'sponsorAdmissionRevoked', inputs: [{ name: 'sponsor', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  ] as Abi : candidateAbiJson as Abi
  const candidateFundingAbi: Abi = deployment.drawBoundRepayment ? [...baseAbi.filter(x => !(x.type === 'function' && x.name === 'repay')), ...drawBindingAbi] : baseAbi
const states = ['NONE', 'OPEN', 'DRAWN', 'DEFAULTED', 'CLOSED'] as const
const typeString = 'SpendIntent(address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor)'
const memoryLocks = new Set<string>()
const uintKeys = ['epoch', 'expiry', 'maximumRepaymentWindow', 'day', 'termsVersion', 'reserveCap', 'availableReserve', 'principalOutstanding', 'recoveryAvailable', 'lineSpendCap', 'dailySpendCap', 'cumulativePrincipalPaid', 'spentToday', 'dueAt'] as const

function address(raw: string, label = 'Wallet'): Address {
  raw = raw.trim()
  if (!isAddress(raw) || isAddressEqual(raw, zeroAddress)) throw new Error(`${label} must be a nonzero wallet address.`)
  return getAddress(raw)
}
function hash(raw: string, label = 'Line ID'): Hash {
  raw = raw.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw) || raw.toLowerCase() === zeroHash) throw new Error(`${label} must be a nonzero 32-byte hash.`)
  return raw.toLowerCase() as Hash
}
function same(a: string, b: string) { return a.toLowerCase() === b.toLowerCase() }
function amount(raw: string, label: string, ceiling: bigint): bigint {
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(raw)) throw new Error(`${label} must be a positive USDC amount with up to six decimal places.`)
  const parsed = parseUnits(raw, 6)
  if (parsed <= 0n || parsed > ceiling) throw new Error(`${label} is outside the current ${mainnet ? 'release' : 'testnet'} limit.`)
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
function candidateErrorMessage(error: unknown): string {
  const help = !mainnet && arcTestnetConnectionHelp(error)
  if (help) return help
  if (error instanceof Error) return error.message.split('\n')[0]
  return 'The request could not be completed. Check the connection and try refreshing.'
}

async function verifyCandidate(client: CandidateReadClient): Promise<void> {
  if (await client.getChainId() !== CANDIDATE_FUNDING.chainId) throw new Error(`This workflow only supports ${network}.`)
  const code = await client.getCode({ address: CANDIDATE_FUNDING.address })
  if (!code || keccak256(code) !== CANDIDATE_FUNDING.runtimeHash) throw new Error(`The deployed contract does not match the verified Shadow ${network} release.`)
  // The browser transport serializes requests. Start each read only after the
  // preceding one succeeds, so an RPC failure leaves no stale batch queued.
  const name = await read(client, 'NAME_HASH')
  const version = await read(client, 'VERSION_HASH')
  const type = await read(client, 'SPEND_INTENT_TYPEHASH')
  const chainId = await read(client, 'deploymentChainId')
  const usdc = await read(client, 'usdc')
  const decimals = await tokenRead(client, 'decimals')
  if (deployment.drawBoundRepayment && BigInt(await read(client, 'repaymentBindingVersion')) !== 2n) throw new Error('Draw-bound repayment identity is inconsistent. Writes are disabled.')
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
  const drawDigest = deployment.drawBoundRepayment ? await read(client, 'currentDrawDigest', [lineId], block.number) : undefined
  return { ...fields, lineId, sponsor, agent: address(raw.agent), state, stateName: states[state], observedBlock: block.number, observedTimestamp: block.timestamp, sponsorAllowed: Boolean(sponsorAllowed), spendsPaused: Boolean(spendsPaused), drawDigest } as CandidateLine
}

async function readCandidateLine(client: CandidateReadClient, rawLineId: string): Promise<CandidateLine> {
  const lineId = hash(rawLineId)
  await verifyCandidate(client)
  const block = await client.getBlock()
  return lineAt(client, lineId, block)
}

async function readCandidateSnapshot(client: CandidateReadClient, input: { sponsor: string; agent?: string }): Promise<CandidateSnapshot> {
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
  return { kind: 'approve', account, to: CANDIDATE_FUNDING.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CANDIDATE_FUNDING.address, value] }), value: '0', amount: value, lineId: null, agent: null, expectedEpoch: null, observedBlock, summary: `Approve exactly this ${currency} amount for Shadow. Funding requires a separate confirmation.`, nextAction }
}
function fingerprint(line: CandidateLine): string {
  return [line.state, line.principalOutstanding, line.cumulativePrincipalPaid, line.dueAt, line.availableReserve, line.recoveryAvailable, line.drawDigest ?? 'legacy'].join(':')
}

async function prepareCandidateOpen(client: CandidateReadClient, rawAccount: string, input: CandidateOpenInput): Promise<CandidatePrepared> {
  const account = address(rawAccount)
  const agent = address(input.agent, 'Agent')
  const provider = address(input.provider, 'Provider')
  if (same(provider, CANDIDATE_FUNDING.address)) throw new Error('The provider cannot be the funding contract.')
  let endpoint: URL
  try { endpoint = new URL(input.endpoint) } catch { throw new Error('Enter the exact HTTPS endpoint agreed with your provider.') }
  if (input.endpoint !== input.endpoint.trim() || endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Use the exact HTTPS provider endpoint without credentials, fragments, or surrounding spaces.')
  const snapshot = await readCandidateSnapshot(client, { sponsor: account, agent })
  if (mainnet && (await client.getCode({ address: provider, blockNumber: snapshot.observedBlock }) ?? '0x') !== '0x') throw new Error('This release supports providers with ordinary EOA wallets only.')
  if (!snapshot.sponsorAllowed) throw new Error(deployment.selfRegistration ? 'Register this wallet as a sponsor before funding.' : `This sponsor has not been enabled for this ${network} release. Request access before funding.`)
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
  if (snapshot.balance < reserve) throw new Error(`This wallet does not have enough ${currency} for the reserve.`)
  const lineId = predictedLine(account, agent, snapshot.nextEpoch)
  if (snapshot.allowance < reserve) return approval(account, reserve, snapshot.observedBlock, 'open')
  const params = { agent, reserve, lineSpendCap, dailySpendCap, lineExpiry: snapshot.observedTimestamp + lifetime, maximumRepaymentWindow, provider, endpointHash: keccak256(stringToHex(input.endpoint)), providerPerSpendCap, providerDailyCap, providerExpiry: snapshot.observedTimestamp + lifetime }
  return { kind: 'open', account, to: CANDIDATE_FUNDING.address, data: encodeFunctionData({ abi: candidateFundingAbi, functionName: 'openLine', args: [params] }), value: '0', amount: reserve, lineId, agent, expectedEpoch: snapshot.nextEpoch, observedBlock: snapshot.observedBlock, summary: `Fund this line with ${currency}. The provider can only be paid under the limits shown.` }
}

async function prepareCandidateRepay(client: CandidateReadClient, rawAccount: string, rawLineId: string): Promise<CandidatePrepared> {
  const account = address(rawAccount)
  const line = await readCandidateLine(client, rawLineId)
  if (!['DRAWN', 'DEFAULTED'].includes(line.stateName) || line.principalOutstanding <= 0n) throw new Error('This line has no outstanding debt to repay.')
  if (line.principalOutstanding > CANDIDATE_FUNDING.maxReserve) throw new Error('This repayment exceeds the browser release limit.')
  const balance = await tokenRead(client, 'balanceOf', [account], line.observedBlock)
  const allowance = await tokenRead(client, 'allowance', [account, CANDIDATE_FUNDING.address], line.observedBlock)
  if (BigInt(balance) < line.principalOutstanding) throw new Error(`This wallet does not have enough ${currency} to repay the debt.`)
  if (BigInt(allowance) < line.principalOutstanding) return approval(account, line.principalOutstanding, line.observedBlock, 'repay')
  if (deployment.drawBoundRepayment && (!line.drawDigest || line.drawDigest === zeroHash)) throw new Error('The current purchase identity is unavailable. No repayment was prepared.')
  return { kind: 'repay', account, to: CANDIDATE_FUNDING.address, data: encodeFunctionData({ abi: candidateFundingAbi, functionName: deployment.drawBoundRepayment ? 'repayForDraw' : 'repay', args: deployment.drawBoundRepayment ? [line.lineId, line.drawDigest!, line.principalOutstanding] : [line.lineId, line.principalOutstanding] }), value: '0', amount: line.principalOutstanding, lineId: line.lineId, agent: line.agent, expectedEpoch: line.epoch, observedBlock: line.observedBlock, lineFingerprint: fingerprint(line), summary: deployment.drawBoundRepayment ? `Repay purchase ${line.drawDigest}. The transaction reverts if another purchase replaces it.` : 'Pay this fixed amount toward whatever debt this line has when the transaction executes. A delayed approval can pay a newer purchase. This legacy contract does not bind repayment to the purchase shown now.' }
}

async function prepareCandidateDefault(client: CandidateReadClient, rawAccount: string, rawLineId: string): Promise<CandidatePrepared> {
  const account = address(rawAccount)
  const line = await readCandidateLine(client, rawLineId)
  if (!same(account, line.sponsor)) throw new Error('Only this line’s sponsor can declare a default.')
  if (line.stateName !== 'DRAWN') throw new Error('Default requires a DRAWN line.')
  if (line.principalOutstanding <= 0n) throw new Error('This line has no outstanding debt to default.')
  if (line.observedTimestamp < line.dueAt) throw new Error('This line is not due for default yet.')
  return { kind: 'default', account, to: CANDIDATE_FUNDING.address, data: encodeFunctionData({ abi: candidateFundingAbi, functionName: 'declareDefault', args: [line.lineId] }), value: '0', amount: line.principalOutstanding, lineId: line.lineId, agent: line.agent, expectedEpoch: line.epoch, observedBlock: line.observedBlock, lineFingerprint: fingerprint(line), summary: 'Declaring default marks this line as DEFAULTED. Anyone can still repay afterwards; those repayments go to sponsor recovery. This line will not reopen.' }
}

async function prepareCandidateReclaim(client: CandidateReadClient, rawAccount: string, rawLineId: string): Promise<CandidatePrepared> {
  const account = address(rawAccount)
  const line = await readCandidateLine(client, rawLineId)
  if (!same(account, line.sponsor)) throw new Error('Only this line’s sponsor can reclaim its funds.')
  const close = line.stateName === 'OPEN' && line.principalOutstanding === 0n
  if (!close && line.stateName !== 'DEFAULTED') throw new Error('Reclaim requires a debt-free open line, or recoverable funds on a defaulted line.')
  const value = close ? line.availableReserve : line.availableReserve + line.recoveryAvailable
  if (value <= 0n) throw new Error('There are no funds available to reclaim.')
  return { kind: close ? 'close' : 'claim-defaulted', account, to: CANDIDATE_FUNDING.address, data: encodeFunctionData({ abi: candidateFundingAbi, functionName: close ? 'closeLine' : 'claimDefaulted', args: [line.lineId] }), value: '0', amount: value, lineId: line.lineId, agent: line.agent, expectedEpoch: line.epoch, observedBlock: line.observedBlock, lineFingerprint: fingerprint(line), summary: close ? `Close the funding line and return its available ${currency} to the sponsor.` : 'Return available reserve and recovered repayments to the sponsor. Outstanding unpaid debt is not recovered by this action.' }
}

function checkPending(value: unknown, expectedAccount?: Address): CandidatePending {
  const p = value as CandidatePending
  const actions: string[] = ['register', 'approve', 'open', 'repay', 'default', 'close', 'claim-defaulted']
  if (!p || p.version !== 1 || p.chainId !== CANDIDATE_FUNDING.chainId || !same(p.candidate ?? '', CANDIDATE_FUNDING.address) || !isAddress(p.account) || (expectedAccount && !same(expectedAccount, p.account)) || !actions.includes(p.kind) || !isAddress(p.to) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(p.data) || p.data.length > 4096 || p.value !== '0' || !/^\d+$/.test(p.amount) || !/^\d+$/.test(p.fromBlock) || !Number.isSafeInteger(p.nonce) || p.nonce < 0 || !['wallet', 'pending', 'unknown'].includes(p.status) || (p.txHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(p.txHash))) throw new Error('The saved transaction record is invalid. Keep it for investigation; no new transaction was sent.')
  if (p.actualNonce !== undefined && (!p.txHash || !Number.isSafeInteger(p.actualNonce) || p.actualNonce < 0)) throw new Error('The saved actual transaction nonce is invalid.')
  // Decode the saved call, so reconciliation cannot accidentally certify an
  // unrelated or wrong-contract record as a completed product action.
  checkedCall(p)
  return p
}

function createCandidateJournal(storage: CandidateStorage, rawAccount: string): CandidateJournal {
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
  if (!same(record.to, isApproval ? CANDIDATE_FUNDING.usdc : CANDIDATE_FUNDING.address) || record.value !== '0') throw new Error('The transaction does not target the expected release contract.')
  const abi: Abi = isApproval ? erc20Abi : candidateFundingAbi
  const decoded = decodeFunctionData({ abi, data: record.data })
  const expectedName = { register: 'registerSponsor', approve: 'approve', open: 'openLine', repay: deployment.drawBoundRepayment ? 'repayForDraw' : 'repay', default: 'declareDefault', close: 'closeLine', 'claim-defaulted': 'claimDefaulted' }[record.kind]
  if (decoded.functionName !== expectedName) throw new Error('The transaction action does not match its calldata.')
  const args = decoded.args as readonly any[]
  const value = BigInt(record.amount)
  if (record.kind === 'register') {
    if (!deployment.selfRegistration || value !== 0n || record.lineId !== null) throw new Error('Invalid testnet registration.');
    return { abi, functionName: decoded.functionName, args };
  }
  if (value <= 0n) throw new Error('The transaction amount must be positive.')
  if (isApproval && (!same(args[0], CANDIDATE_FUNDING.address) || BigInt(args[1]) !== value || value > CANDIDATE_FUNDING.maxReserve)) throw new Error('Only an exact bounded approval to this release is supported.')
  if (record.kind === 'open') {
    const p = args[0]
    if (BigInt(p.reserve) !== value || value > CANDIDATE_FUNDING.maxReserve || BigInt(p.lineSpendCap) <= 0n || BigInt(p.lineSpendCap) > CANDIDATE_FUNDING.maxLineSpend || BigInt(p.dailySpendCap) <= 0n || BigInt(p.dailySpendCap) > CANDIDATE_FUNDING.maxDailySpend || BigInt(p.providerPerSpendCap) <= 0n || BigInt(p.providerPerSpendCap) > CANDIDATE_FUNDING.maxPerSpend || BigInt(p.providerDailyCap) <= 0n || BigInt(p.providerDailyCap) > CANDIDATE_FUNDING.maxDailySpend) throw new Error('The funding line exceeds this browser release’s limits.')
  } else if (!isApproval) {
    if (!record.lineId || !same(args[0], record.lineId)) throw new Error('The transaction line does not match its calldata.')
    if (record.kind === 'repay' && (BigInt(args[deployment.drawBoundRepayment ? 2 : 1]) !== value || value > CANDIDATE_FUNDING.maxReserve)) throw new Error('The repayment must equal the displayed bounded amount.')
    if (record.kind === 'repay' && deployment.drawBoundRepayment) hash(args[1], 'Purchase digest')
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
  if (chainId !== CANDIDATE_FUNDING.chainId) throw new Error(`Switch the connected wallet to ${network} before confirming.`)
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

async function executeCandidateCall(session: CandidateSession, prepared: CandidatePrepared): Promise<CandidateResolution> {
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
      if (mainnet && (await client.getCode({address:p.provider,blockNumber:current.observedBlock}) ?? '0x') !== '0x') throw new Error('Provider wallet is no longer an ordinary EOA. Review the provider again.')
      if (prepared.expectedEpoch !== current.nextEpoch || !prepared.lineId || !same(predictedLine(session.account, p.agent, current.nextEpoch), prepared.lineId)) throw new Error('The funding-line epoch changed. Refresh before opening a line.')
      if (BigInt(p.lineExpiry) < current.observedTimestamp + current.minimumRepaymentWindow + CANDIDATE_FUNDING.signatureTtl || BigInt(p.providerExpiry) < current.observedTimestamp + current.minimumRepaymentWindow + CANDIDATE_FUNDING.signatureTtl) throw new Error('This prepared line expires too soon. Refresh before funding.')
    } else if (prepared.kind !== 'approve' && prepared.kind !== 'register') {
      const current = await readCandidateLine(client, prepared.lineId!)
      if (!prepared.lineFingerprint || fingerprint(current) !== prepared.lineFingerprint) throw new Error('The line or debt changed. Refresh and review the current amount before confirming.')
      if (prepared.kind === 'repay' && deployment.drawBoundRepayment && !same(call.args[1], current.drawDigest!)) throw new Error('The repayment calldata names a different purchase. Review it again.')
      if (prepared.kind === 'default' && prepared.amount !== current.principalOutstanding) throw new Error('The outstanding debt changed. Refresh before declaring default.')
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
    const outcome = await reconcileCandidatePending(client, pending, undefined, session.journal)
    if (outcome.status !== 'unknown') session.journal.clear()
    else { pending = { ...(session.journal.load() ?? pending), status: 'unknown' }; session.journal.save(pending); stage(session, pending) }
    return outcome
  } finally { memoryLocks.delete(session.journal.key) }
}

function hasExpectedEvent(pending: CandidatePending, receipt: { logs: readonly any[] }): boolean {
  const expected = { register: 'SponsorAllowed', approve: 'Approval', open: 'LineOpened', repay: deployment.drawBoundRepayment ? 'DrawRepaid' : 'Repaid', default: 'LineDefaulted', close: 'LineClosed', 'claim-defaulted': 'SponsorClaimed' }[pending.kind]
  for (const log of receipt.logs) {
    if (!same(log.address, pending.to)) continue
    try {
      const event = decodeEventLog({ abi: pending.kind === 'approve' ? erc20Abi : candidateFundingAbi, data: log.data, topics: log.topics })
      if (event.eventName !== expected) continue
      const args: any = event.args
      if (pending.kind === 'register') return same(args.sponsor, pending.account) && args.allowed === true
      if (pending.kind === 'approve') return same(args.owner, pending.account) && same(args.spender, CANDIDATE_FUNDING.address) && BigInt(args.value) === BigInt(pending.amount)
      if (!pending.lineId || !same(args.lineId, pending.lineId)) continue
      if (pending.kind === 'open') return same(args.sponsor, pending.account) && !!pending.agent && same(args.agent, pending.agent) && BigInt(args.reserve) === BigInt(pending.amount) && String(args.epoch) === pending.expectedEpoch
      if (pending.kind === 'repay') return same(args.payer, pending.account) && BigInt(args.amount) === BigInt(pending.amount) && (!deployment.drawBoundRepayment || same(args.drawDigest, (decodeFunctionData({abi: candidateFundingAbi, data: pending.data}).args as readonly any[])[1]))
      // A partial repayment can land during the wallet prompt; the exact call identity and line are authoritative.
      if (pending.kind === 'default') return true
      // Closing and reclaiming can return a newer balance if a repayment raced
      // the wallet prompt; the exact call identity and sponsor are authoritative.
      return same(args.sponsor, pending.account)
    } catch { /* other logs cannot establish this action */ }
  }
  return false
}

async function reconcileCandidatePending(client: CandidateReadClient, rawPending: CandidatePending, providedHash?: string, journal?: CandidateJournal): Promise<CandidateResolution> {
  const pending = checkPending(rawPending)
  const txHash = providedHash ? hash(providedHash, 'Transaction hash') : pending.txHash
  const unknown = (message: string): CandidateResolution => ({ status: 'unknown', txHash, message })
  if (!txHash) return unknown('Open your wallet activity, copy this action’s transaction hash, and check it here. Do not submit the action again while its outcome is unknown.')
  try {
    await verifyCandidate(client)
    const transaction = await client.getTransaction({ hash: txHash })
    if (!same(transaction.hash, txHash)) return unknown('The chain returned a different transaction hash. Keep this record and check again.')
    const exactCall = (tx: typeof transaction) => same(tx.from, pending.account) && tx.to !== null &&
      same(tx.to, pending.to) && same(tx.input, pending.data) && tx.value === 0n &&
      (tx.chainId == null || Number(tx.chainId) === CANDIDATE_FUNDING.chainId)
    async function observedReceipt(tx: typeof transaction, requestedHash: Hash) {
      let receipt
      try { receipt = await client.getTransactionReceipt({ hash: requestedHash }) }
      catch (error) {
        // Only an explicit missing receipt can establish a pending observation.
        // A timeout or transport failure must not silently authorize persistence.
        if (error instanceof TransactionReceiptNotFoundError && tx.blockNumber == null && !tx.blockHash) return null
        throw error
      }
      if (!same(receipt.transactionHash, requestedHash) || !receipt.blockHash ||
        (tx.blockNumber != null && tx.blockNumber !== receipt.blockNumber) ||
        (tx.blockHash && !same(tx.blockHash, receipt.blockHash))) throw new Error('Inconsistent transaction history')
      const block = await client.getBlock({ blockNumber: receipt.blockNumber })
      if (!same(block.hash, receipt.blockHash)) throw new Error('Noncanonical transaction history')
      return receipt
    }
    let expectedNonce = pending.actualNonce ?? pending.nonce
    if (pending.txHash && (pending.actualNonce === undefined || same(txHash, pending.txHash))) {
      const original = same(txHash, pending.txHash) ? transaction : await client.getTransaction({ hash: pending.txHash })
      if (!same(original.hash, pending.txHash) || !exactCall(original) || !Number.isSafeInteger(Number(original.nonce)) || Number(original.nonce) < 0) return unknown('The original wallet transaction could not be bound to this action. Keep the record and check its original hash.')
      // Query receipts even when a backend labels the transaction pending.
      // Another backend may already know that this identical call is historical.
      const originalReceipt = await observedReceipt(original, pending.txHash)
      const originalIsOlder = originalReceipt !== null && originalReceipt.blockNumber <= BigInt(pending.fromBlock)
      if (originalIsOlder) {
        if (same(txHash, pending.txHash) || !exactCall(transaction) || pending.actualNonce !== undefined) return unknown('The wallet returned a transaction from before this action. Keep the record and check this action’s current transaction hash.')
        expectedNonce = Number(transaction.nonce)
        if (!Number.isSafeInteger(expectedNonce) || expectedNonce < 0) return unknown('This transaction nonce is invalid.')
        const currentReceipt = await observedReceipt(transaction, txHash)
        if (currentReceipt !== null && currentReceipt.blockNumber <= BigInt(pending.fromBlock)) return unknown('The supplied transaction is not newer than this saved action.')
        if (journal) journal.save({ ...pending, txHash, actualNonce: expectedNonce })
      } else {
        expectedNonce = Number(original.nonce)
        if (pending.actualNonce !== undefined && pending.actualNonce !== expectedNonce) return unknown('The original transaction nonce contradicts the saved record. Keep the record for investigation.')
        if (journal && pending.actualNonce === undefined) journal.save({ ...pending, actualNonce: expectedNonce })
      }
    }
    if (!same(transaction.from, pending.account) || Number(transaction.nonce) !== expectedNonce || (transaction.chainId != null && Number(transaction.chainId) !== CANDIDATE_FUNDING.chainId)) return unknown('This transaction does not match the original wallet transaction. The action is still unresolved.')
    const receipt = await client.getTransactionReceipt({ hash: txHash })
    if (!receipt.blockHash || receipt.blockNumber <= BigInt(pending.fromBlock) || !same(receipt.transactionHash, txHash) || !same(transaction.hash, txHash)) return unknown('The transaction receipt does not match the saved action’s chain history.')
    // A receipt on an orphaned block must not unlock a replacement payment.
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber })
    if (!same(canonical.hash, receipt.blockHash) || (transaction.blockHash && !same(transaction.blockHash, receipt.blockHash))) return unknown('The transaction is not yet confirmed in the canonical chain. Check again.')
    const exact = transaction.to !== null && same(transaction.to, pending.to) && same(transaction.input, pending.data) && transaction.value === 0n
    if (!exact && !pending.txHash) return unknown('The proposed nonce was used, but the wallet did not identify its original transaction. That cannot prove this request was cancelled. Keep the record and investigate the wallet activity.')
    if (!exact) return { status: 'replaced', txHash, message: 'A different transaction consumed this wallet nonce. The saved Shadow action was replaced; refresh current state before preparing any new action.' }
    if (receipt.status !== 'success') return { status: 'reverted', txHash, message: 'The transaction reverted onchain. Its intended action did not complete; refresh before preparing another request.' }
    const registered = pending.kind === 'register' && await read(client, 'sponsorAllowed', [pending.account], receipt.blockNumber) === true
    if (!registered && !hasExpectedEvent(pending, receipt)) return unknown('The transaction succeeded, but its expected Shadow event could not be verified. Keep this record and investigate before retrying.')
    const action: Record<CandidateAction, string> = {
      register: 'Sponsor registration', approve: 'USDC approval', open: 'Opening',
      repay: 'Repayment', default: 'Default declaration', close: 'Close', 'claim-defaulted': 'Recovery claim',
    }
    const lineLabel = pending.lineId ? ` for line ${pending.lineId.slice(0, 8)}…${pending.lineId.slice(-4)}` : ''
    return { status: 'confirmed', txHash, message: `${action[pending.kind]}${lineLabel} is confirmed onchain.`, ...(pending.lineId ? { lineId: pending.lineId } : {}) }
  } catch {
    return unknown('Confirmation is pending or the chain could not be read reliably. Keep this transaction record and check again; nothing has been resent.')
  }
}

async function prepareCandidateRegistration(client: CandidateReadClient, rawAccount: string): Promise<CandidatePrepared> {
  if (!deployment.selfRegistration) throw new Error('Self-registration is unavailable on this deployment.')
  const account = address(rawAccount)
  const snapshot = await readCandidateSnapshot(client, { sponsor: account })
  if (snapshot.sponsorAllowed) throw new Error('This wallet is already registered.')
  if (snapshot.openingsPaused) throw new Error('New sponsor registration is paused.')
  if (await read(client, 'sponsorAdmissionRevoked', [account], snapshot.observedBlock)) throw new Error('This wallet’s sponsor access was revoked.')
  return { kind: 'register', account, to: CANDIDATE_FUNDING.address,
    data: encodeFunctionData({ abi: candidateFundingAbi, functionName: 'registerSponsor' }), value: '0', amount: 0n,
    lineId: null, agent: null, expectedEpoch: null, observedBlock: snapshot.observedBlock,
    summary: `Register your wallet to fund your own agent lines. This does not transfer or approve tokens; ${network} gas applies.` }
}

return { verifyCandidate, readCandidateLine, readCandidateSnapshot, prepareCandidateOpen, prepareCandidateRepay, prepareCandidateDefault, prepareCandidateReclaim, createCandidateJournal, executeCandidateCall, reconcileCandidatePending, candidateErrorMessage, prepareCandidateRegistration }
}
export const { verifyCandidate, readCandidateLine, readCandidateSnapshot, prepareCandidateOpen, prepareCandidateRepay, prepareCandidateDefault, prepareCandidateReclaim, createCandidateJournal, executeCandidateCall, reconcileCandidatePending, candidateErrorMessage, prepareCandidateRegistration } = createCandidateFundingKit(CANDIDATE_FUNDING)
