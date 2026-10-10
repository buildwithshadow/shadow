import { parseAbiItem, type Address, type Hash, type PublicClient } from "viem";

export const AGENT_LINE_DISCOVERY_CHUNK_BLOCKS = 5_000n;
export const MAX_AGENT_LINE_DISCOVERY_REQUESTS = 16;
export const MAX_AGENT_LINE_DISCOVERY_RESULTS = 10;

const lineOpenedEvent = parseAbiItem(
  "event LineOpened(bytes32 indexed lineId,address indexed sponsor,address indexed agent,uint64 epoch,uint256 reserve,uint64 termsVersion)",
);

export type AgentLineOpenedLog = {
  args: { agent?: Address; lineId?: Hash };
  blockNumber: bigint | null;
  logIndex: number | null;
};

export type AgentLineDiscoveryClient = Pick<PublicClient, "getBlockNumber" | "getLogs">;

export type AgentLineDiscoveryProgress = { searchedBlocks: bigint; totalBlocks: bigint };

export type AgentLineDiscoveryCursor = {
  nextBlock: bigint;
  span: bigint;
  startBlock: bigint;
  headBlock: bigint;
  searchedBlocks: bigint;
  totalBlocks: bigint;
  pendingLineIds: Hash[];
};

export type AgentLineDiscoveryResult = {
  lineIds: Hash[];
  headBlock: bigint | null;
  cursor: AgentLineDiscoveryCursor | null;
  searchedBlocks: bigint;
  totalBlocks: bigint;
};

export type AgentLineDiscoveryOptions = {
  isActive: () => boolean;
  onProgress?: (progress: AgentLineDiscoveryProgress) => void;
  cursor?: AgentLineDiscoveryCursor;
  fromBlock?: bigint;
};

// Mirrors isLogRangeLimit in app/scripts/float-mainnet-cli.mjs; this adds "ranges over N blocks". Keep both in sync.
function isLogRangeLimit(error: unknown): boolean {
  const seen = new Set<object>();
  let rangeLimit = false;
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 8 && !seen.has(current); current = (current as { cause?: unknown }).cause, depth++) {
    seen.add(current);
    const value = current as { shortMessage?: unknown; details?: unknown; message?: unknown };
    const detail = [value.shortMessage, value.details, value.message].filter((item): item is string => typeof item === "string").join(" ");
    if (/rate limit|quota|too many requests|requests? per|\b429\b/i.test(detail)) return false;
    if (/block ranges?.{0,80}(?:too (?:large|wide)|over|above|exceed|limit|maximum)|ranges? over \d+ blocks|requested range too large|(?:maximum|max|limited to).{0,40}block range|query returned more than.{0,40}(?:results|logs)|(?:log )?response size.{0,40}(?:exceed|limit|too large)|too many (?:logs|results)/i.test(detail)) rangeLimit = true;
  }
  return rangeLimit;
}

export function parseAgentLineLogs(logs: readonly AgentLineOpenedLog[], agent: Address): Hash[] {
  const matching = logs
    .filter((log) => log.blockNumber !== null
      && typeof log.args.agent === "string"
      && log.args.agent.toLowerCase() === agent.toLowerCase()
      && typeof log.args.lineId === "string"
      && /^0x[0-9a-fA-F]{64}$/.test(log.args.lineId))
    .sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) return left.blockNumber! > right.blockNumber! ? -1 : 1;
      return (right.logIndex ?? -1) - (left.logIndex ?? -1);
    });
  const seen = new Set<string>();
  const lineIds: Hash[] = [];
  for (const log of matching) {
    const lineId = log.args.lineId!.toLowerCase() as Hash;
    if (seen.has(lineId)) continue;
    seen.add(lineId);
    lineIds.push(lineId);
  }
  return lineIds;
}

export async function discoverAgentLineIds(
  client: AgentLineDiscoveryClient,
  deployment: { address: Address; agent: Address; deployBlock: bigint },
  { isActive, onProgress, cursor: continuation, fromBlock }: AgentLineDiscoveryOptions,
): Promise<AgentLineDiscoveryResult> {
  if (deployment.deployBlock < 0n) throw new RangeError("The deployment block cannot be negative.");
  if (continuation && fromBlock !== undefined) throw new TypeError("A continuation cursor cannot be combined with a new search start block.");
  if (fromBlock !== undefined && fromBlock < deployment.deployBlock) throw new RangeError("The search start block cannot be before deployment.");
  if (!isActive()) return { lineIds: [], headBlock: null, cursor: null, searchedBlocks: 0n, totalBlocks: 0n };

  let headBlock: bigint;
  let nextBlock: bigint;
  let span: bigint;
  let startBlock: bigint;
  let searchedBlocks: bigint;
  let totalBlocks: bigint;
  let requests = 0;
  const pendingLineIds = continuation ? [...continuation.pendingLineIds] : [];
  if (continuation) {
    ({ headBlock, nextBlock, span, startBlock, searchedBlocks, totalBlocks } = continuation);
  } else {
    requests++;
    headBlock = await client.getBlockNumber();
    if (!isActive()) return { lineIds: [], headBlock, cursor: null, searchedBlocks: 0n, totalBlocks: 0n };
    if (headBlock < deployment.deployBlock) throw new Error("The current block is before the funding contract deployment block.");
    startBlock = fromBlock ?? deployment.deployBlock;
    nextBlock = headBlock;
    span = AGENT_LINE_DISCOVERY_CHUNK_BLOCKS;
    searchedBlocks = 0n;
    totalBlocks = headBlock >= startBlock ? headBlock - startBlock + 1n : 0n;
  }

  const currentCursor = (): AgentLineDiscoveryCursor | null => nextBlock >= startBlock || pendingLineIds.length > 0
    ? { nextBlock, span, startBlock, headBlock, searchedBlocks, totalBlocks, pendingLineIds }
    : null;
  const seen = new Set<string>();
  const lineIds = pendingLineIds.splice(0, MAX_AGENT_LINE_DISCOVERY_RESULTS);
  onProgress?.({ searchedBlocks, totalBlocks });
  while (nextBlock >= startBlock && lineIds.length < MAX_AGENT_LINE_DISCOVERY_RESULTS) {
    if (!isActive()) return { lineIds, headBlock, cursor: currentCursor(), searchedBlocks, totalBlocks };
    if (requests >= MAX_AGENT_LINE_DISCOVERY_REQUESTS) {
      return { lineIds, headBlock, cursor: currentCursor(), searchedBlocks, totalBlocks };
    }
    const from = nextBlock - span + 1n > startBlock ? nextBlock - span + 1n : startBlock;
    let logs: readonly AgentLineOpenedLog[];
    requests++;
    try {
      logs = await client.getLogs({
        address: deployment.address,
        event: lineOpenedEvent,
        args: { agent: deployment.agent },
        fromBlock: from,
        toBlock: nextBlock,
      }) as unknown as readonly AgentLineOpenedLog[];
    } catch (error) {
      if (from < nextBlock && isLogRangeLimit(error)) {
        span = (nextBlock - from + 2n) / 2n;
        continue;
      }
      throw error;
    }
    if (!isActive()) return { lineIds, headBlock, cursor: currentCursor(), searchedBlocks, totalBlocks };
    for (const lineId of parseAgentLineLogs(logs, deployment.agent)) {
      if (seen.has(lineId)) continue;
      seen.add(lineId);
      if (lineIds.length < MAX_AGENT_LINE_DISCOVERY_RESULTS) lineIds.push(lineId);
      else pendingLineIds.push(lineId);
    }
    searchedBlocks += nextBlock - from + 1n;
    nextBlock = from - 1n;
    onProgress?.({ searchedBlocks, totalBlocks });
  }
  return { lineIds, headBlock, cursor: currentCursor(), searchedBlocks, totalBlocks };
}
