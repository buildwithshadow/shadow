# Candidate monitor runner

The runner performs bounded, read-only checks against an explicitly approved local baseline. It persists a heartbeat, the latest complete snapshot, a latched operational hold and a bounded local event journal. A successful process exit from the older `check` command is insufficient: warnings, sponsor membership and policy drift are evaluated independently.

This tool does not install a scheduler, send notifications, sign transactions, stop another process, or pause the contract. A local hold must be consumed by the executor and incident operator. Repayment and other permitted exits remain separate from permission to create new risk. An external notification destination and delivery adapter require separate configuration; none is enabled here.

## One-block observation

`float-mainnet-monitor.mjs snapshot` performs canonical log discovery covering the original deployment through the pinned head, role and line reads, token accounting, and direct-call executor observation at one pinned block. It checks that the block remains canonical after the reads. The paced read-only transport is used; failed scans and timeouts do not produce partial healthy state.

Sponsor discovery includes `SponsorAllowed` events for addresses that never opened a line. Historical operators and providers are also discovered. Accounting checks the token balance against obligations, line sums against both aggregate totals, and each line's state against its reserve identity. The runner recalculates the accounting rather than trusting an `ok` flag.

`ProviderPaid` and `SpendBlocked` transactions in the approved executor window are retained in the snapshot. For payments, both the direct transaction sender and the signed nonzero executor must match the baseline. A `SpendBlocked` event records successful refusal with no payment or debt; a different executor on that refused attempt does not itself latch a global hold. Other accounting, role and policy checks still apply. Routed smart-account calldata has no presumed executor: unsupported routes result in a hold. This observes transactions that already happened; it does not enforce an exclusive global executor or prevent an agent from signing an unbound intent. The submitting executor must enforce its own pre-send policy.

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
| `executor` | Nonzero `address`, and decimal-string `fromBlock` at or after deployment. This is a fixed approved audit window, not a moving lookback. Historical unauthorized sponsor/operator enable-event checks always start at deployment, independently of this window. Advancing the payment window cannot hide transient privilege grants. |
| `policy` | Timing and index requirements below. |

Each `lines` entry contains exactly:

- `lineId`: lowercase bytes32.
- `sponsor`, `agent`: nonzero addresses.
- `epoch`, `reserveCap`, `lineSpendCap`, `dailySpendCap`, `maximumRepaymentWindow`, `termsVersion`, `expiry`: unsigned decimal strings. Amounts use the token's atomic units; times use seconds.
- `allowedStates`: a nonempty unique subset of `OPEN`, `DRAWN`, `CLOSED`, `DEFAULTED`. Approve a defaulted state only when that is actually intended.
- `providers`: all discovered provider policies, including inactive historical entries. Each contains exactly `provider` (nonzero address), `active` (boolean), `endpointHash` (lowercase bytes32), `expiry`, `perSpendCap`, and `dailySpendCap` (unsigned decimal strings).

`policy` contains exactly these positive safe integer numbers and one boolean:

- `intervalMs`: target period between scan starts, measured with a monotonic clock. Collection and result publication consume this period; only its unused time is spent waiting. Cycles never overlap or accumulate a backlog. If a scan exceeds the period, its successor starts after it finishes.
- `runTimeoutMs`: hard subprocess wall-time bound. Choose a bound supported by measured full-scan duration. A growing history that exceeds it holds; it is never silently truncated.
- `maxHeartbeatAgeMs`: maximum age of both the start and completion timestamps; must cover at least `runTimeoutMs + intervalMs`.
- `maxBlockAgeSeconds`: maximum block timestamp age, including time spent scanning. Timestamps over 30 seconds in the future hold.
- `maxIndexLagSeconds`: maximum age of an optional supplied index checkpoint. Noncanonical checkpoints always hold.
- `warnBeforeSeconds`: monitor warning horizon for maturity and expiry.
- `requireIndex`: boolean. When true, omission of index diagnostics holds; the index never substitutes for canonical discovery.

Address case and array order for role/line/provider membership are normalized. `baselineHash` is SHA-256 of the normalized, recursively key-sorted JSON (`digestJson(validateBaseline(baseline))`). `manifestHash` is SHA-256 of the exact manifest file bytes. A baseline or release-file change latches a hold; it does not reset an earlier incident automatically.

## Running and consuming health

Set only the public/read-only RPC connection needed by the monitor. No signing key is required or passed into the monitor subprocess.

If the RPC rate limits historical scans, set `SHADOW_RPC_READ_SPACING_MS` to an integer between `350` and `5000`. The runner forwards this setting to its read subprocess while excluding other parent environment variables, including wallet credentials and Node preload options. The default remains unchanged when omitted. Measure a complete scan before approving the schedule and freshness bounds; slower pacing does not waive incomplete scans, stale observations or an existing hold.

A verified RPC that supports larger log ranges may use `SHADOW_RPC_LOG_CHUNK_BLOCKS` between `5000` and `10000`. The default remains `5000`. Scans still cover every block and shrink only for explicit range or result limits. Quota errors fail the scan instead of creating more requests. This setting changes neither the freshness policy nor transaction retries.

```sh
export ARC_RPC_URL='https://your-approved-read-only-rpc.example'
node app/scripts/float-mainnet-monitor-runner.mjs once \
  --baseline /private/approved-monitor-baseline.json \
  --manifest /private/release.manifest.json \
  --state-dir /private/shadow-monitor-state
```

Use `loop` instead of `once` only when intentionally running the foreground scheduler. Optional `--index /private/index.json` adds checkpoint diagnostics. A 40-second scan with `intervalMs: 60000` waits approximately 20 seconds before its successor; a scan longer than 60 seconds starts its successor immediately after completion. Runtime and scheduler delays can extend the target period. `SIGINT`/`SIGTERM` cancels the wait and prevents another cycle; an in-flight child finishes within `runTimeoutMs`. An operator may integrate `once` with an existing scheduler separately. No installation occurs through this tool.

**Upgrade note:** older runners interpreted `intervalMs` as an additional delay after completion. Keeping the same value increases scan frequency (the example above changes from approximately 100 seconds between starts to 60). Check RPC capacity and measured collection duration before upgrading. If an operator chooses a longer interval to preserve the former request volume, review the existing heartbeat and block-age bounds too: the retained observation must stay fresh through the next collection. This release does not relax those bounds, acknowledge holds, or silently rewrite baselines.

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

## Optional Arc mainnet notifications

`float-mainnet-monitor-alerts.mjs` sends failure and recovery notices to an explicitly configured Telegram destination. It is separate from the testnet notifier, which still refuses mainnet manifests. Configure it only after the deployed candidate has a passing release manifest and an approved monitor baseline. It refuses a different chain, candidate address, runtime hash or deployment block between those files.

```sh
node app/scripts/float-mainnet-monitor-alerts.mjs \
  --baseline /private/approved-monitor-baseline.json \
  --manifest /private/release.manifest.json \
  --observer-dir /private/shadow-monitor-state \
  --state-dir /private/shadow-notification-state \
  --config /private/telegram.json
```

The protected configuration contains `token` and `chatId`. Never commit it or pass the bot token on the command line. Keep notification state separate from monitor state and provide the notifier read access to the baseline, manifest, heartbeat, snapshot and hold files. The runner creates private `0600` files: a different service account cannot read them merely by joining a group. Verify actual file access before enabling a scheduler; a permissions/configuration failure exits nonzero with redacted diagnostics and cannot claim successful alert delivery.

The notifier reuses `heartbeatStatus` to validate the complete snapshot, accounting, freshness and incident hold. A fresh, correctly bound scan in progress stays quiet within its approved timeout, unless an incident is already latched. A stuck scan, missing/corrupt state or a different release alerts. A later healthy scan does not send `RECOVERED` until the latched incident has been explicitly acknowledged through the runner. The notification never clears a hold, authorizes a payment or changes contract pauses.

Successful delivery is recorded atomically and deduplicated by destination, baseline, manifest, failure codes and latched incident ID. New incidents or failure codes notify immediately, even if the timer missed an intervening recovery; unchanged failures repeat after six hours. Failed delivery leaves the state unacknowledged for retry. A notification lock prevents overlapping sends; after a crash, inspect the recorded process before removing only `notification.lock`.

Run the notifier through a separately configured scheduler at a cadence suitable for the selected heartbeat bounds. No scheduler is installed by this command. A notifier on the same machine cannot report a total host or network outage; use an independent availability check for that failure class. Telegram delivery and monitor health remain separate observations.

Upgrade consideration: this policy examines all role-enable history from deployment. An older baseline that used a later execution start to omit a historical role incident may now hold again. Review that history explicitly; do not delete monitor state or automatically acknowledge an existing incident during rollout.


## Optional approved immutable history

Default discovery remains a complete RPC replay from the deployment block. An external index remains diagnostic and cannot replace that replay.

For a growing chain, a maintainer may explicitly approve an immutable historical prefix. The service cannot approve, regenerate or advance its own prefix. The exact bytes are bound to the separately protected baseline and the original deployment identity, manifest hash and finalized canonical anchor. Every cycle verifies that anchor and replays the complete suffix from its next block through the current pinned head. All earlier events remain in role, line and payment discovery. Coverage still begins at the original deployment block.

Capture a candidate prefix using read only RPC operations:

```sh
node app/scripts/float-mainnet-history-capture.mjs \
  --manifest /private/release.manifest.json \
  --out /private/unapproved-history.json
```

Capture performs a complete original range scan, verifies every recorded event block and the anchor, and creates a new file without overwriting an existing one. Its output is explicitly unapproved. Review its provenance and complete event history before adding an optional `approvedHistory` object to the protected baseline:

```json
{
  "file": "/private/immutable-approved-history.json",
  "sha256": "EXACT_SHA256_OF_APPROVED_BYTES",
  "anchorBlock": "FINALIZED_CANONICAL_BLOCK_NUMBER",
  "anchorHash": "0xCANONICAL_BLOCK_HASH"
}
```

Those placeholders must be replaced with the verified record. Keep the file and baseline outside public repositories, with the baseline protected from service writes. A checksum inside an editable file is not approval. A matching canonical block hash alone does not prove that the file includes every event.

The runner validates the file when loading context and again before collection. Status and spend consumers therefore reject missing, altered or mismatched history. The snapshot must report the exact prefix binding selected by the baseline; supplying a different prefix directly to the snapshot CLI cannot authorize spending. Corruption, reorgs, incomplete suffix reads and unexpected identity changes fail closed. Existing incidents remain latched and historical evidence is retained.

Replacing a prefix requires a declared maintainer transition and another complete canonical capture from the original deployment, with old records preserved and common historical events compared. It is not an automatic cache update or a budget reset. A root administrator who can rewrite the protected baseline and executable code remains trusted under the existing host control model; this mechanism does not defend against malicious root access.

No timing, block freshness, role, spending or onchain controls are relaxed by this option. Measure the resulting complete snapshot before using it. Independent provider checks and qualified human security review remain separate requirements.
