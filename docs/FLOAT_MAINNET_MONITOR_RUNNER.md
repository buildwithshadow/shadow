# Candidate monitor runner

The runner performs bounded, read-only checks against an explicitly approved local baseline. It persists a heartbeat, the latest complete snapshot, a latched operational hold and a bounded local event journal. A successful process exit from the older `check` command is insufficient: warnings, sponsor membership and policy drift are evaluated independently.

This tool does not install a scheduler, send notifications, sign transactions, stop another process, or pause the contract. A local hold must be consumed by the executor and incident operator. Repayment and other permitted exits remain separate from permission to create new risk. An external notification destination and delivery adapter require separate configuration; none is enabled here.

## One-block observation

`float-mainnet-monitor.mjs snapshot` performs full deployment-to-head canonical log discovery, role and line reads, token accounting, and direct-call executor observation at one pinned block. It checks that the block remains canonical after the reads. The paced read-only transport is used; failed scans and timeouts do not produce partial healthy state.

Sponsor discovery includes `SponsorAllowed` events for addresses that never opened a line. Historical operators and providers are also discovered. Accounting checks the token balance against obligations, line sums against both aggregate totals, and each line's state against its reserve identity. The runner recalculates the accounting rather than trusting an `ok` flag.

`ProviderPaid` and `SpendBlocked` transactions in the approved executor window are inspected. Both the direct transaction sender and the signed nonzero executor must match the baseline. Routed smart-account calldata has no presumed executor: unsupported routes result in a hold. This observes transactions that already happened; it does not enforce an exclusive global executor or prevent an agent from signing an unbound intent. The submitting executor must enforce its own pre-send policy.

A complete RPC scan is not independent proof that the provider has returned every historical event. Use an independent provider for release and incident reconciliation. This runner observes one configured RPC per run; it does not claim two-provider consensus or automatic pause execution.

## Baseline

Keep the baseline and runner state outside the public repository. The runner never learns an approved baseline from live state. Review the release identity, exact roles, policy and intended phase before supplying the JSON file. Schema version 1 rejects missing/unknown fields and ambiguous numbers.

| Field | Required content |
| --- | --- |
| `schemaVersion` | Number `1`. |
| `identity` | `chainId` and `deployBlock` as unsigned decimal strings; nonzero `address` and `usdc`; lowercase bytes32 `runtimeCodeHash`. |
| `owner` | Approved nonzero address. Pending ownership must be zero. |
| `operators`, `sponsors` | Arrays of exact currently enabled nonzero addresses; unique membership, including an explicitly empty set where intended. |
| `effectiveLimits` | Positive atomic-unit decimal strings for `protocolReserve`, `lineReserve`, `lineSpend`, `perSpend`, `dailySpend`. No pending cap increase is accepted. |
| `pauses` | Explicit `openingsPaused` and `spendsPaused` booleans for the approved phase. A planned pause is healthy; healthy monitoring does not itself permit spending. |
| `lines` | Exact discovered line set, including closed history. Every entry has the fields below. An empty array approves no discovered lines. |
| `executor` | Nonzero `address`, and decimal-string `fromBlock` at or after deployment. This is a fixed approved audit window, not a moving lookback. It also bounds historical unauthorized sponsor/operator enable-event checks. |
| `policy` | Timing and index requirements below. |

Each `lines` entry contains exactly:

- `lineId`: lowercase bytes32.
- `sponsor`, `agent`: nonzero addresses.
- `epoch`, `reserveCap`, `lineSpendCap`, `dailySpendCap`, `maximumRepaymentWindow`, `termsVersion`, `expiry`: unsigned decimal strings. Amounts use the token's atomic units; times use seconds.
- `allowedStates`: a nonempty unique subset of `OPEN`, `DRAWN`, `CLOSED`, `DEFAULTED`. Approve a defaulted state only when that is actually intended.
- `providers`: all discovered provider policies, including inactive historical entries. Each contains exactly `provider` (nonzero address), `active` (boolean), `endpointHash` (lowercase bytes32), `expiry`, `perSpendCap`, and `dailySpendCap` (unsigned decimal strings).

`policy` contains exactly these positive safe integer numbers and one boolean:

- `intervalMs`: delay after a completed cycle before starting the next; cycles do not overlap or accumulate a backlog.
- `runTimeoutMs`: hard subprocess wall-time bound. Choose a bound supported by measured full-scan duration. A growing history that exceeds it holds; it is never silently truncated.
- `maxHeartbeatAgeMs`: maximum age of both the start and completion timestamps; must cover at least `runTimeoutMs + intervalMs`.
- `maxBlockAgeSeconds`: maximum block timestamp age, including time spent scanning. Timestamps over 30 seconds in the future hold.
- `maxIndexLagSeconds`: maximum age of an optional supplied index checkpoint. Noncanonical checkpoints always hold.
- `warnBeforeSeconds`: monitor warning horizon for maturity and expiry.
- `requireIndex`: boolean. When true, omission of index diagnostics holds; the index never substitutes for canonical discovery.

Address case and array order for role/line/provider membership are normalized. `baselineHash` is SHA-256 of the normalized, recursively key-sorted JSON (`digestJson(validateBaseline(baseline))`). `manifestHash` is SHA-256 of the exact manifest file bytes. A baseline or release-file change latches a hold; it does not reset an earlier incident automatically.

## Running and consuming health

Set only the public/read-only RPC connection needed by the monitor. No signing key is required or passed into the monitor subprocess.

```sh
export ARC_RPC_URL='https://your-approved-read-only-rpc.example'
node app/scripts/float-mainnet-monitor-runner.mjs once \
  --baseline /private/approved-monitor-baseline.json \
  --manifest /private/release.manifest.json \
  --state-dir /private/shadow-monitor-state
```

Use `loop` instead of `once` only when intentionally running the foreground scheduler. Optional `--index /private/index.json` adds checkpoint diagnostics. The loop waits after each completed cycle; it does not claim a fixed start-to-start cadence. `SIGINT`/`SIGTERM` stops the loop; any in-flight child remains bounded by `runTimeoutMs`. An operator may integrate `once` with an existing scheduler separately. No installation occurs through this tool.

Before acting on health, use the same arguments with `status`. Consumers must not simply read a persisted `ok:true`: that bit cannot update itself when a process or machine stops. `status` rereads state, checks the approved hashes, revalidates the snapshot, freshness and hold latch, and exits nonzero unless healthy. The exported `heartbeatStatus(context, nowMs)` provides the same gate to local consumers. `loadContext` loads and validates the baseline and manifest bindings.

Each heartbeat has:

```text
schemaVersion, kind: "shadow-monitor-heartbeat",
chainId, address, runtimeCodeHash, baselineHash, manifestHash,
runId, startedAt, completedAt,
observedAt: { blockNumber, blockHash, timestamp }, snapshotHash,
ok, hold, status, checks: { snapshotHealthy }, incidentId, alerts
```

Identity quantities and observed block quantities are decimal/hex strings. Times ending in `At` outside `observedAt` are ISO timestamps. Before network work, the previous heartbeat is atomically replaced with `status:"checking", ok:false, hold:true`; consumers wait for a complete sample. A completed healthy result means the exact baseline matched at the stated block. It is not permission to deploy, fund, unpause, or spend and does not attest to signer control or an independent security review.

Files are created with mode `0600`, the state directory with `0700`, and replacement JSON writes are synced and renamed atomically. `runner.lock` prevents overlapping cycles. The latest snapshot is retained, while `events.json` keeps the latest 200 cycle/acknowledgement entries; preserve incident evidence separately before that bounded journal rotates. Existing directory permissions are not changed. Put the directory on a reliable local filesystem with restricted access, not a shared untrusted directory.

## Holds and recovery

The runner holds for RPC errors, incomplete or malformed snapshots, stale/missing heartbeat or blocks, scan gaps, unexpected role membership/history, owner/pending-owner drift, changed or pending caps, pause-phase changes, changed line/provider/endpoint/terms, unsupported executor evidence, index lag/reorg and accounting failures. All unrecognized monitor alerts also hold. Approved historical operator events and planned pauses are checked against their baseline instead of becoming unconditional alerts. A backward head or changed hash at the same observed height also latches a hold.

An incident stays latched across process restarts and later healthy checks. Investigate and reconcile it, obtain a fresh complete sample under the intended baseline, then acknowledge the exact incident locally:

```sh
node app/scripts/float-mainnet-monitor-runner.mjs acknowledge \
  --baseline /private/approved-monitor-baseline.json \
  --manifest /private/release.manifest.json \
  --state-dir /private/shadow-monitor-state \
  --incident-id '<incidentId from the held heartbeat>'
```

Acknowledgement refuses stale samples, changed snapshot hashes, wrong incidents, or continuing policy failures. It records the acknowledgement without advancing the original observation time. It does not unpause a contract or resume another process. Baseline changes need their own review; acknowledgement is not a way to approve unknown drift.

A crash may leave `runner.lock`. Confirm that the recorded process is no longer running before removing only that lock. Do not delete heartbeat, snapshot, or hold files to recover: the next complete check and explicit incident acknowledgement preserve the failure record. A stale or interrupted heartbeat is latched when the next cycle begins. `status` already holds during the outage even when the stopped process cannot write another file.
