# Agent line discovery — proposed read-only interface

Status: specification only. No discovery endpoint or indexer is deployed by
this document. The existing `/start?line=<line-id>` route remains usable.

## Goal and current contract surface

Given an agent address, discover candidate funding lines across sponsors without
requiring private enrollment or collecting wallet addresses through chat. The
current contract has `activeLineId(sponsor, agent)` and `lines(lineId)` reads.
`LineOpened` indexes `lineId`, `sponsor`, and `agent`. A known sponsor/agent pair
can therefore be read directly; discovery across unknown sponsors needs a
bounded event index. The deployment block is recorded in the deployment manifest.

## Proposed service contract

Proposed route: `GET /v1/agent-lines?agent=<address>&cursor=<opaque>&limit=20`.
This is a public read-only lookup, NOT the authenticated candidate purchase API
with a similar `/v1` prefix. Its hostname/hosting and implementation are pending.
No wallet connection, token, signature, executor or funding authority is required.

The service uses a fixed chain, contract, runtime pin and deployment start block.
Clients cannot select an RPC URL, contract or arbitrary history range. Validate
and normalize addresses; reject malformed cursors/limits. Cap pages at 50 rows.
Cursors bind the agent, deployment, index snapshot and stable ordering, so pages
cannot silently mix snapshots. Expired/reorganized snapshots require a restart,
not an apparently complete partial list.

Response fields to implement:

| Field | Meaning |
| --- | --- |
| `chainId`, `contract` | Fixed deployment identity |
| `agent` | Normalized query address |
| `indexedThrough: {number, hash}` | Last continuously indexed finalized block |
| `observedAt: {number, hash}` | Block used for line-state revalidation |
| `coverage: {fromBlock, throughBlock, caughtUp}` | Contiguous index coverage; caughtUp refers to the service's sampled finalized tip |
| `lines[]` | Revalidated records with lineId, sponsor, agent, epoch, state, activeForPair, availableReserve, principalOutstanding, expiry and dueAt |
| `nextCursor` | Null only when this snapshot has no more rows |

Encode all amounts, epochs, block numbers and timestamps as decimal strings.
Return balances in contract units (USDC has six decimals). Include historical
and closed lines with explicit state; activeForPair does not mean spendable.
Do not expose a ready-to-spend flag inferred only from reserve: pauses, admission,
provider policy, debt, expiry and signed terms still need current checks.

## Indexing and failure semantics

- Scan only this deployment's LineOpened logs, starting at its manifest block.
- Persist block hashes and a contiguous checkpoint atomically with log-derived
  identities. Resume after restart without duplicates. Reconcile reorgs before
  serving a snapshot as current; rewind invalid blocks and invalidate cursors.
- Bound RPC ranges and work per cycle. Split explicit range/result-size failures;
  apply backoff to rate limits. Never advance coverage past an unscanned gap.
- Revalidate line records and activeLineId for each sponsor/agent at a common
  pinned block before returning them. Ignore logs from another contract/chain.
- For a lagging index, return explicit coverage and caughtUp=false. No matches
  means no matches in that coverage, not proof that the agent has no funding.
- If safe revalidation is unavailable, fail with a retryable service error rather
  than presenting cached balances as fresh. Limit callers, response size and
  page work. Return sanitized errors; never log secrets or add signing ability.

## Frontend integration boundary

Show a loading state, discovered choices and coverage/freshness. Multiple sponsors
must remain separate choices; do not silently pick a line with spending authority.
Keep direct line-link/manual lookup as a fallback for lagging or unavailable
indexing. Query cancellation/revision guards must discard results for an old
account, network or selection. Unresolved purchase/repayment recovery takes
priority over discovery and cannot be cleared by changing the selected line.

Discovery only suggests identifiers. The existing funding/purchase modules must
verify chain/runtime, connected agent, live line state and current terms before
any signature or transaction. Unknown remote data cannot replace the fixed
provider, price, endpoint or verifying contract.

## Acceptance before implementation is called live

Demonstrate multiple sponsors, repeated epochs, closed/defaulted lines, no results,
page boundaries, restart, reorg, index lag, RPC range limits and rate-limit failures.
Prove no gaps/duplicates across a stable snapshot, and that old-wallet responses
cannot replace the current selection. Compare discovered identities and balances
against direct onchain reads. Keep an empty but incomplete index visibly distinct
from a complete empty result. The service must expose no transaction method.
