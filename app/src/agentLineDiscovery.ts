import { parseAbiItem, type Address, type Hash, type PublicClient } from "viem";

export const AGENT_LINE_DISCOVERY_CHUNK_BLOCKS = 5_000n;
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
    if (lineIds.length === MAX_AGENT_LINE_DISCOVERY_RESULTS) break;
  }
  return lineIds;
}

export async function discoverAgentLineIds(
  client: AgentLineDiscoveryClient,
  deployment: { address: Address; agent: Address; deployBlock: bigint },
): Promise<Hash[]> {
  if (deployment.deployBlock < 0n) throw new RangeError("The deployment block cannot be negative.");
  const head = await client.getBlockNumber();
  if (head < deployment.deployBlock) throw new Error("The current block is before the funding contract deployment block.");

  let cursor = head;
  let span = AGENT_LINE_DISCOVERY_CHUNK_BLOCKS;
  let requests = 0n;
  const maxRequests = ((head - deployment.deployBlock) / AGENT_LINE_DISCOVERY_CHUNK_BLOCKS + 1n) * 16n + 16n;
  const seen = new Set<string>();
  const lineIds: Hash[] = [];
  while (cursor >= deployment.deployBlock && lineIds.length < MAX_AGENT_LINE_DISCOVERY_RESULTS) {
    const fromBlock = cursor - span + 1n > deployment.deployBlock
      ? cursor - span + 1n
      : deployment.deployBlock;
    if (++requests > maxRequests) throw new Error("Agent line discovery is incomplete because its bounded RPC request budget was exhausted.");
    let logs: readonly AgentLineOpenedLog[];
    try {
      logs = await client.getLogs({
        address: deployment.address,
        event: lineOpenedEvent,
        args: { agent: deployment.agent },
        fromBlock,
        toBlock: cursor,
      }) as unknown as readonly AgentLineOpenedLog[];
    } catch (error) {
      if (fromBlock < cursor && isLogRangeLimit(error)) {
        span = (cursor - fromBlock + 2n) / 2n;
        continue;
      }
      throw error;
    }
    for (const lineId of parseAgentLineLogs(logs, deployment.agent)) {
      if (seen.has(lineId)) continue;
      seen.add(lineId);
      lineIds.push(lineId);
      if (lineIds.length === MAX_AGENT_LINE_DISCOVERY_RESULTS) break;
    }
    cursor = fromBlock - 1n;
  }
  return lineIds;
}
