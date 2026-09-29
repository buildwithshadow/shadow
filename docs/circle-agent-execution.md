# Circle Agent Wallet execution boundary

`app/scripts/circle-agent-execution.mjs` is an **Arc testnet operator library** for an authenticated Circle transport. It is not a browser login flow, a mainnet release, or a replacement for sponsor funding authorization. No Circle credential handling is included. Keep operator journals outside the repository.

The adapter supports three actions: an exact USDC allowance to Shadow, a bounded `executeSpend`, and repayment of a line owned by the configured agent. Pin the contract runtime hash, agent, provider, endpoint hash, maximum amount (USDC base units, at most 1 USDC), and maximum estimated network fee (native Arc units, at most 0.1 test USDC). The fee limit is an estimate check, not a guaranteed actual-fee cap. Native value transfers and other contract calls are rejected.

## Transport contract

Instantiate `createCircleAgentExecutor({ client, circle, journal, config })` with a viem public client and a transport exposing:

- `estimate(request)`: returns `{ networkFee: "0.01" }` in native USDC units.
- `execute(request)`: submits once and returns the Circle transaction metadata described below.
- `lookup({ idempotencyKey, transactionId })`: a **read-only** lookup; returns matching metadata or `null`. It must never retry execution. If Circle's API cannot locate a request without a transaction ID, return `null` and leave it unresolved.

The request is `{ blockchain: "ARC-TESTNET", sourceAddress, contractAddress, callData, amount: "0", idempotencyKey }`. Use Circle's raw `callData` contract execution API rather than serializing a nested Solidity tuple as a positional CLI string. Preserve Circle's existing authentication and approval requirements; this library does not waive them.

Normalize returned metadata to `{ idempotencyKey, id, blockchain, sourceAddress, contractAddress, state, txHash? }`. Bind this metadata to the actual original request, never stamp an arbitrary history transaction with its key. A missing ID/hash remains unresolved. A successful outer smart-account transaction alone is insufficient: the adapter checks the exact Shadow `ProviderPaid`/`Repaid` or USDC `Approval` event, its amount, identity, and block range.

Receipt verification supports EntryPoint v0.7 `handleOps` with the account's single-call `execute(address,uint256,bytes)` envelope. It decodes the bundle, requires exactly one operation matching the agent, destination, value and complete calldata, computes that operation's hash through EntryPoint, and checks its successful `UserOperationEvent`. Only logs between that operation's boundaries may prove the action. Duplicate matching operations, batch envelopes, aggregated bundles, and other EntryPoint versions fail closed until explicitly supported.

The receipt must be in a canonical block at or below the RPC's `finalized` head. Cached completion is revalidated on subsequent execute/reconcile calls. RPC providers that do not support finalized blocks cannot finalize this adapter's journal.

Circle CLI 1.1.4's stock tuple execution command is not sufficient for this path. The library intentionally does not patch installed CLI files or import private authentication internals. Supply an authenticated raw-calldata transport. This remains an integration prerequisite before customer rollout.

## Durable operation lifecycle

Use `createCircleAgentJournal(privateDirectory)` from `circle-agent-journal.mjs`. It writes 0600 JSON files with fsync and rename, and uses exclusive lock files across processes. The parent directory should be private. Calldata can contain signed authorizations; do not commit or share the journal. This is a local single-host journal, not distributed coordination across machines.

Call `execute({ operationId, to, data, value: 0n })` with a stable ID for one logical operation. Retrying that operation must reuse the ID. A genuinely new allowance/repayment in a later cycle requires a new ID. Reusing an ID for changed calldata is refused.

Before sending, the adapter checks chain identity, deployed code, bounded action, line ownership, simulation, estimated fee and refreshed policy. It persists a wallet-wide barrier and the request's idempotency key **before** submitting. Unknown outcomes block new operations for that wallet; no timeout automatically submits again.

After an unknown outcome, call `reconcile(result.key)`. It checks a saved transaction hash directly or performs the transport's read-only lookup. Once the exact receipt is verified it releases the barrier. An API failure, reverted transaction or missing expected event remains unresolved; inspect the original Circle request before any operator-led abandonment. There is deliberately no automatic abandonment/retry button.

A process crash can leave a lock file. Confirm the process has stopped and reconcile the stored request before removing a stale lock. A crash between writing the barrier and request fails closed and needs operator inspection. Never delete the entire journal to get past an unresolved payment.

## Verification

Run `node --test app/scripts/circle-agent-execution.test.mjs`. Tests cover lost responses and restart, read-only recovery, mismatched receipts, chain and scope restrictions, spending limits, journal failure, and cross-instance locking. Browser usability, independent participants, distributed execution, and mainnet safety require separate validation.
