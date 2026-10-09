import type { Hash } from "viem";
import type { AgentLineDiscoveryCursor } from "./agentLineDiscovery";
import type { CandidateLine } from "./candidateFunding";

export type AgentLineDiscoveryCache = {
  lineIds: Hash[];
  lines: CandidateLine[];
  headBlock: bigint;
  historyCursor: AgentLineDiscoveryCursor | null;
  forwardCursor: AgentLineDiscoveryCursor | null;
};

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
  const orderedIds = action === "continue" ? [...existingIds, ...result.lineIds]
    : action === "again" ? [...result.lineIds, ...existingIds] : result.lineIds;
  const advancesHead = result.cursor === null
    && (action === "again" || action === "continue" && !continuingHistory);

  return {
    lineIds: [...new Set(orderedIds)],
    lines: cached?.lines ?? [],
    headBlock: action === "initial" || advancesHead ? result.headBlock : cached?.headBlock ?? result.headBlock,
    historyCursor: action === "initial" ? result.cursor
      : action === "continue" && continuingHistory ? result.cursor : cached?.historyCursor ?? null,
    forwardCursor: action === "again" ? result.cursor
      : action === "continue" && !continuingHistory ? result.cursor : cached?.forwardCursor ?? null,
  };
}
