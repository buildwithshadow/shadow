import type { Hash } from "viem";
import { MAX_AGENT_LINE_DISCOVERY_RESULTS, type AgentLineDiscoveryCursor } from "./agentLineDiscovery.ts";
import type { CandidateLine } from "./candidateFunding";

export type AgentLineDiscoveryCache = {
  lineIds: Hash[];
  pendingPageIds?: Hash[];
  forwardWindowCount: number;
  lines: CandidateLine[];
  headBlock: bigint;
  historyCursor: AgentLineDiscoveryCursor | null;
  forwardCursor: AgentLineDiscoveryCursor | null;
};

// A stopped scan is worth keeping only if it searched some blocks and can resume or finished its range.
export function hasResumableDiscoveryProgress(result: { cursor: AgentLineDiscoveryCursor | null; searchedBlocks: bigint; totalBlocks: bigint }) {
  return result.searchedBlocks > 0n && (result.cursor !== null || result.searchedBlocks === result.totalBlocks);
}

export function getAgentLineDiscoveryContinuationCursor(cached: AgentLineDiscoveryCache | undefined) {
  return cached?.forwardCursor ?? cached?.historyCursor ?? null;
}

export function mergeAgentLineDiscoveryCache(
  action: "initial" | "continue" | "again",
  cached: AgentLineDiscoveryCache | undefined,
  result: { lineIds: Hash[]; headBlock: bigint; cursor: AgentLineDiscoveryCursor | null },
): AgentLineDiscoveryCache {
  const continuingHistory = action === "continue" && !cached?.forwardCursor && Boolean(cached?.historyCursor);
  const existingIds = cached?.lineIds ?? [];
  let lineIds: Hash[];
  let forwardWindowCount: number;
  if (action === "initial") {
    lineIds = [...new Set(result.lineIds)];
    forwardWindowCount = 0;
  } else if (continuingHistory) {
    lineIds = [...new Set([...existingIds, ...result.lineIds])];
    forwardWindowCount = cached?.forwardWindowCount ?? 0;
  } else {
    // The leading IDs of an unfinished forward window are newer than everything after them.
    const openWindow = cached?.forwardCursor ? existingIds.slice(0, cached.forwardWindowCount) : [];
    const windowIds = [...new Set(action === "again" ? [...result.lineIds, ...openWindow] : [...openWindow, ...result.lineIds])];
    lineIds = [...new Set([...windowIds, ...existingIds.slice(openWindow.length)])];
    forwardWindowCount = windowIds.length;
  }
  const advancesHead = result.cursor === null
    && (action === "again" || action === "continue" && !continuingHistory);

  return {
    lineIds,
    forwardWindowCount,
    lines: cached?.lines ?? [],
    headBlock: action === "initial" || advancesHead ? result.headBlock : cached?.headBlock ?? result.headBlock,
    historyCursor: action === "initial" ? result.cursor
      : action === "continue" && continuingHistory ? result.cursor : cached?.historyCursor ?? null,
    forwardCursor: action === "again" ? result.cursor
      : action === "continue" && !continuingHistory ? result.cursor : cached?.forwardCursor ?? null,
  };
}

// Keep each visible page fresh without rereading the accumulated history.
export async function refreshAgentLineDiscoveryPage(
  ids: readonly Hash[],
  agent: string,
  readLine: (id: Hash) => Promise<CandidateLine>,
  isActive: () => boolean,
): Promise<CandidateLine[] | null> {
  const lines: CandidateLine[] = [];
  const pageIds = [...new Set(ids)].slice(0, MAX_AGENT_LINE_DISCOVERY_RESULTS);
  for (const id of pageIds) {
    if (!isActive()) return null;
    const line = await readLine(id);
    if (!isActive()) return null;
    if (line.agent.toLowerCase() === agent.toLowerCase()) lines.push(line);
  }
  return lines;
}

// Return a candidate cache only after the page is fully refreshed. A failure or
// cancellation must leave the caller's previously committed cursor available.
export async function refreshAgentLineDiscoveryCachePage(
  proposed: AgentLineDiscoveryCache,
  pageIds: readonly Hash[],
  agent: string,
  readLine: (id: Hash) => Promise<CandidateLine>,
  isActive: () => boolean,
): Promise<AgentLineDiscoveryCache | null> {
  const lines = await refreshAgentLineDiscoveryPage(pageIds, agent, readLine, isActive);
  return lines === null ? null : { ...proposed, lines, pendingPageIds: [] };
}
