# Shadow Float Mainnet Candidate: Pilot Operations

Status, 2026-09-19: the `ShadowFloatMainnet` candidate is **not deployed** on any network. The monitor and reconciliation tool below are tested end to end on a local chain only, and none of the procedures in this runbook has been rehearsed by the team. Nothing here authorizes a deployment, a funded line, a governance transaction or a public claim.

This runbook covers the monitoring and operating-procedure parts of the roadmap's mainnet release conditions for the candidate. [`PILOT_OPERATIONS.md`](PILOT_OPERATIONS.md) is the runbook for the deployed V2 `ShadowFloat` and does not apply to the candidate. Participant commands are described in [`SHADOW_FLOAT_MAINNET_PARTICIPANT_TOOLS.md`](SHADOW_FLOAT_MAINNET_PARTICIPANT_TOOLS.md); the contract is `contracts/src/ShadowFloatMainnet.sol`.

## Operating rules

- **Contract state is authoritative.** The monitor, the index and any RPC can be stale or wrong (threat model, trust assumptions). Decide from reads pinned to a block, and record that block.
- **Look up before retrying.** A timeout does not prove a transaction failed. Look up the transaction hash, and for a purchase the digest's `receiptStatus`, before anything is sent again.
- **Never hold or ask for a participant's key.** The monitor needs no key. Sponsors, agents, executors and the owner Safe sign their own transactions.

## Who can do what

From the contract's access checks:

| Actor | May | May not |
| --- | --- | --- |
| Owner (the Safe) | `setOperator`, `setSponsorAllowed`, set either pause to true or false, `reduceCap` (immediate), `proposeCapIncrease`, `activateCapIncrease` (from `activateAt`), `cancelCapIncrease`, `proposeOwner` | Move, withdraw or redirect a line's reserve; default, close or claim a sponsor's line |
| Operator | Set `openingsPaused` or `spendsPaused` to **true**; `cancelCapIncrease`; submit intents like any executor | Unpause, change caps, allowlists, operators or ownership |
| Sponsor | Open, `set-provider-policy`, `update-terms`, `close` a debt-free `OPEN` line, `declare-default` from `dueAt`, `claim-defaulted` | Act on another sponsor's line; default before `dueAt` |
| Agent | Sign intents; `cancel-nonce` | Move reserve or change terms |
| Anyone | `repay` a `DRAWN` or `DEFAULTED` line; submit a signed intent (unless it names an executor) | |

The committed tools cover the owner's allowlist and pause actions (`float-mainnet-owner.mjs`). No committed tool sends `setOperator`, `reduceCap`, `proposeCapIncrease`, `activateCapIncrease` or `cancelCapIncrease`: those are transactions the Safe (or, for cancel, an operator) builds itself, calling the function on the Float with the `CapKind` number (`0` `PROTOCOL_RESERVE`, `1` `LINE_RESERVE`, `2` `LINE_SPEND`, `3` `PER_SPEND`, `4` `DAILY_SPEND`).

## Running the monitor

```bash
export ARC_RPC_URL=...  FLOAT_MAINNET_EXPECTED_CHAIN_ID=...
M=<the reviewed release manifest>
node app/scripts/float-mainnet-indexer.mjs index --out index.json --resume --manifest $M
node app/scripts/float-mainnet-monitor.mjs check --index index.json --manifest $M > check.json
node app/scripts/float-mainnet-monitor.mjs reconcile --index index.json --manifest $M > reconcile.json
```

The first indexer run omits `--resume`. `--manifest` is required by both monitor commands: it names the Float, its runtime code hash (checked against the chain) and the deployment block every scan starts from.

- **One pinned block.** Each run reads the latest block once and makes every state read at that block number. It discovers lines, provider policies, operator changes and claims from canonical logs, scanning from the deployment block to the pinned block in chunks of 5,000 blocks. `--index` supplies checkpoint lag and reorg diagnostics only: a canonical checkpoint does not prove the file contains every event, so its cached events never determine alerts or reconciliation. This requires a full log scan on every run; account for the RPC cost when scheduling long-lived deployments. A reorganized checkpoint or one ahead of the RPC head is described in `discovery.index.note`. After its reads, the monitor re-reads the pinned block's hash and fails if the block was reorganized during the run.
- **Output.** One JSON object. `check` has `observedAt`, `warnBefore`, `maxIndexLag`, `alerts`, `contract` (owner, pending owner, pauses, effective limits, both totals, pending cap increases, and every operator address from `OperatorSet` events with its current `enabled` value) and `lines`. Each line has its state, sponsor, agent, `availableReserve` (reserve), `principalOutstanding` (debt), `recoveryAvailable`, `cumulativePrincipalPaid`, `dueAt`, `secondsToMaturity`, `expiry`, `secondsToExpiry`, whether its sponsor is still allowlisted, and for each provider from its `ProviderPolicySet` events the policy's expiry and the next-spend capacity (`nextSpendMax`, `limitedBy`, `binding`), computed as `float-mainnet-line.mjs status` computes it. `--line-id <bytes32>` (repeatable) limits the lines checked.
- **Exit codes.** `check` exits 0 when no alert is critical and 1 otherwise (`DEFAULT_ELIGIBLE`, `DISCOVERY_INCOMPLETE`); `reconcile` exits 1 on any failed check. Both also exit 1 with `{ok: false, error}` when they cannot run (an RPC failure, say), and 2 on a usage error. A scheduler must therefore treat exit 1 as an alert and page on it either way, and must read `alerts` to surface warnings, which do not change the exit code. A scheduled `check` must not pass `--line-id`: a line outside the filter raises no alert, and the `DISCOVERY_INCOMPLETE` guard is skipped.
- **Horizon and index lag.** `--warn-before <seconds>` (default 86,400) is how far ahead maturities, expiries and the end of a line's purchases warn. `--max-index-lag <seconds>` (default 3,600) is how far the index checkpoint may trail the head before `INDEX_LAG`.
- **Two RPCs.** A monitor run reads one RPC. Run `reconcile` once with each of the two RPCs the release uses. Each run pins its own head, so values can differ by the activity between the heads, but both must pass. An RPC whose head is behind the index checkpoint does not fail a run: it scans from the deployment block and notes it (`INDEX_LAG` in `check`).

## Alerts

| Code | Severity | Raised when (at the pinned block) | Response |
| --- | --- | --- | --- |
| `DEFAULT_ELIGIBLE` | critical | A `DRAWN` line's timestamp has reached `dueAt` (the contract's `isMatured`; `declareDefault` succeeds from `dueAt` itself) | Tell the agent and the sponsor. Repayment stays open until a default executes, and a full repayment reopens the line. Only the sponsor decides whether to run `float-mainnet-sponsor.mjs declare-default`; after it, repayments become the sponsor's recovery and `claim-defaulted` pays out reserve plus recovery. The test plan's rule stands: never default the pilot line |
| `DISCOVERY_INCOMPLETE` | critical | Without `--line-id`: the lines found hold, in `availableReserve + principalOutstanding + recoveryAvailable`, other than `totalCommittedCapital`. A line is missing from the canonical RPC log scan, so none of its alerts (`DEFAULT_ELIGIBLE` included) can be raised, or the totals and the lines have diverged | Run `check` and `reconcile` with an independent RPC. If only one RPC omits logs, stop relying on it. If the discrepancy persists, follow the accounting-divergence step of the incident procedure |
| `MATURITY_SOON` | warning | A `DRAWN` line is due within the horizon | Remind the agent; `float-mainnet-repay.mjs --line-id <line> --full` clears the debt |
| `LINE_EXPIRY_SOON` | warning | An `OPEN` or `DRAWN` line's purchases stop within the horizon, or have stopped: at `expiry - minimumRepaymentWindow`, since a spend's `dueAt` must be at least `minimumRepaymentWindow` ahead and no later than the expiry | After that time no purchase can pay (`limitedBy: NO_DUE_DATE_BEFORE_EXPIRY`), and after the expiry itself the line is expired. Repayment stays open after expiry. The sponsor either extends it with `update-terms` (voids every outstanding signed intent) or closes the line once it is debt-free |
| `POLICY_EXPIRY_SOON` | warning | An active provider policy on an `OPEN` or `DRAWN` line expires within the horizon, or has expired | After the expiry a spend to that provider is recorded as `SpendBlocked(PROVIDER_NOT_ALLOWED)`, which uses up the intent's nonce. The sponsor renews it with `set-provider-policy` (voids outstanding signed intents) or lets it lapse |
| `SPENDS_PAUSED` | warning | `spendsPaused` is set | Follow the incident procedure. An intent that passes `executeSpend`'s revert checks is now recorded as `SpendBlocked(SPENDS_PAUSED)` and uses up its nonce (on a `DRAWN` line a spend reverts `InvalidState` instead and records nothing); tell executors to hold submissions (`submit` refuses a simulated block without `--allow-block`) |
| `OPENINGS_PAUSED` | warning | `openingsPaused` is set | Follow the incident procedure. `openLine` reverts; existing lines are unaffected |
| `CAP_INCREASE_PENDING` | warning | `pendingCaps` holds a queued increase (reported with current value, new value and `activateAt`) | Confirm it is an approved governance change. If not, treat it as a possible owner-key compromise: the owner or an operator calls `cancelCapIncrease(kind)`, which works at any time until the owner activates the increase, after `activateAt` too. Operators are no check on a compromised owner (see the incident procedure) |
| `OWNERSHIP_PENDING` | warning | `pendingOwner` is not the zero address | Confirm it is the approved new owner from the release record; if not, treat the owner key as compromised. The pending address becomes the owner as soon as it calls `acceptOwnership`. `proposeOwner` refuses the zero address, so the owner clears an unwanted proposal by proposing itself and accepting (`proposeOwner(Safe)`, then `acceptOwnership` from the Safe) |
| `OPERATOR_CHANGED` | warning | An address has an `OperatorSet` event since deployment; one alert per address, with the event count, the last value and whether it is enabled now. It stays raised for the life of the deployment | Confirm every change against the release record: the manifest proves only that no operator was enabled up to its block. Only the owner can send `setOperator`, so an unexpected change means the owner key signed it: treat it as compromised |
| `PROTOCOL_CAP_EXCEEDED` | warning | `totalCommittedCapital` is above `effectiveLimits.protocolReserve` (after a `reduceCap`, say) | Confirm the reduction was intended. No spend can pay: an intent that passes the revert checks is recorded as `SpendBlocked` (`PROTOCOL_CAP` unless an earlier reason applies; a line's `limitedBy` shows the same) and uses up its nonce, and `openLine` reverts, so tell agents to hold submissions. It clears when closes and claims bring the capital down to the cap, or when the Safe raises the cap (`proposeCapIncrease`, then `activateCapIncrease` after the governance delay) |
| `SPONSOR_REMOVED` | warning | An `OPEN` or `DRAWN` line's sponsor is no longer allowlisted | Confirm the removal was intended. Spends on the line are recorded as `SpendBlocked(SPONSOR_NOT_ALLOWED)`, so tell the agent to stop submitting. Repayment, default, close and claim stay open |
| `INDEX_LAG` | warning | With `--index`: the checkpoint is more than `--max-index-lag` (default 3,600 s) behind the head, was reorganized away, or is ahead of this RPC's head | Behind or reorganized: run `float-mainnet-indexer.mjs index --out index.json --resume --manifest $M`; it extends the index, or rebuilds it after a reorg. Ahead: this RPC lags the one the index was built from; the index needs no action, and an RPC that stays behind is stale. The monitor always scans canonical logs independently; the evidence exporter still reads and verifies the index |

`DEFAULTED` and `CLOSED` lines are reported without an alert. A defaulted line's unrepaid principal stays in `totalCommittedCapital` (see the identities below), so it counts against the protocol cap until it is repaid and claimed.

## Incident and pause procedure

The two pauses stop new risk only. In the contract, `openingsPaused` is read only by `openLine` and `spendsPaused` only by the spend policy check, so under either pause repayment, `declareDefault`, `closeLine`, `claimDefaulted`, `cancelNonce` and every read stay available (spec `EXIT-01`). The contract has no owner withdrawal, sweep, debt forgiveness or early default, so no incident step needs or can use one.

1. **Stop new risk.** An operator or the owner pauses:

   ```bash
   FLOAT_OWNER_PRIVATE_KEY=<operator key> node app/scripts/float-mainnet-owner.mjs pause --what spends --execute --manifest $M
   node app/scripts/float-mainnet-owner.mjs pause --what openings --calldata --from $SAFE --manifest $M
   ```

   The owner tool accepts an operator's key for `pause` only. Pause openings as well when the cause is not understood. `--execute` sends the transaction; `--calldata` only prepares it. Submit the prepared opening-pause call through the owner Safe, wait for a successful receipt and confirm both requested pause flags with `monitor check` before treating the pause as active.
2. **Preserve.** Run `check` and `reconcile` (with each RPC) and the indexer, and keep their JSON with `observedAt`. Keep every transaction hash involved.
3. **Contain, by cause** (threat model, incident boundaries):
   - suspected agent-key compromise: keep spends paused. `cancel-nonce` cannot contain it: it needs the agent's own key, and whoever holds that key can sign intents with fresh nonces, against the current terms too. Before any unpause, the sponsor contains each of the agent's lines:
     - an `OPEN` (debt-free) line: close it (`node app/scripts/float-mainnet-sponsor.mjs close --line-id <line> --execute --manifest $M`). Every intent on a `CLOSED` line reverts, and the reserve returns to the sponsor, who can open a new line for a new agent key;
     - a `DRAWN` line: deactivate every provider policy on it (`node app/scripts/float-mainnet-sponsor.mjs set-provider-policy --line-id <line> --provider <addr> --inactive --execute --manifest $M`, once per provider from its canonical `ProviderPolicySet` events). No spend executes while the line is `DRAWN` (`InvalidState`), but a repayment reopens it; afterwards an intent to an inactive provider pays nothing (`SpendBlocked(PROVIDER_NOT_ALLOWED)`), even one signed afresh. Close the line once it is repaid, using the executed close command above;
   - suspected relayer or executor compromise, with the agent key safe (signed intents may have leaked): keep spends paused; the sponsor runs `update-terms` on the line or `set-provider-policy` (deactivating the provider, say). Either bumps the line's `termsVersion`, so every intent signed before it reverts `StaleTerms`. The agent can also `cancel-nonce` each known unused nonce. The owner removes a compromised operator with `setOperator(operator, false)`;
   - accounting divergence (a failed `reconcile`, or a `DISCOVERY_INCOMPLETE` that a full scan does not clear): pause both, reconcile through both RPCs, and make no further writes until it is explained;
   - an unexpected `CAP_INCREASE_PENDING`, `OWNERSHIP_PENDING`, pause or `OPERATOR_CHANGED`: cancel the increase, and treat the owner or operator key as compromised. Operators are no check on a compromised owner: the owner can remove every operator at once (`setOperator(op, false)` takes effect immediately) and then propose a cap increase, and an operator's cancel only restarts the governance delay, since the owner can propose again at once; it can also unpause immediately. What the delay buys is time for sponsors to contain their lines as above; no owner function can move a line's reserve;
   - restricted USDC transfers: a failed token transfer reverts the whole call and changes no state; retry only once the restriction is resolved.

   Every containment write must be sent and confirmed. The sponsor commands above use its configured signing key. For a sponsor Safe, replace `--execute` with `--calldata --from <sponsor-Safe>`, submit every generated call through that Safe and wait for successful receipts; printing calldata or a dry run is not containment. For each affected line run `node app/scripts/float-mainnet-line.mjs status --line-id <line> --provider <addr> --manifest $M` for every discovered provider and verify `CLOSED`, or every provider's `active: false` while debt remains. Record transaction hashes and the observed block. Do not unpause if any affected line or policy is unverified.
4. **Resume.** Only the owner unpauses (`float-mainnet-owner.mjs unpause --what spends|openings`, from the Safe with `--calldata --from $SAFE`), and only after `reconcile` passes, the cause is resolved and, after a key compromise, the sponsor has contained and verified the affected lines as above. Submit the prepared unpause call through the owner Safe, wait for its successful receipt and confirm the resulting pause flags with `monitor check`. Intents submitted during the pause were recorded as refusals and cannot pay later; the agent signs new ones.
5. **Close out.** The incident is closed when contract state, token transfers, the monitor and any public wording agree. Record the cause, the affected lines and digests, and the remediation.

## Uncertain-payment procedure

A payment is uncertain when an executor's send or wait failed, or a provider has not seen a payment it expects.

1. **Read the digest's status first.** Nothing is signed, built or sent before this.

   ```bash
   node app/scripts/float-mainnet-line.mjs receipt --digest <digest> --manifest $M
   node app/scripts/float-mainnet-submit.mjs preflight --intent <signed.json> --manifest $M
   ```

   `receiptStatus` is authoritative; its event is looked up for reference only, and a failed lookup still reports the status with a hint.
2. **Act on it.**
   - `paid`: the provider was paid exactly once. The provider serves by digest (`float-mainnet-provider.mjs check-payment` reads the same status) and de-duplicates by digest, so a retried request gets the stored result, not new work or a new payment. The agent never signs again for this purchase: a new intent has a new nonce and digest, and is a new purchase.
   - `blocked`: a refusal was recorded, the nonce is used and nothing was paid. The reason is in the `SpendBlocked` event the receipt returns.
   - `none`: not executed. `preflight` shows whether the nonce is used or cancelled and what the contract would do now. Either resubmit the **same** signed file, or have the agent cancel its nonce.
3. **Re-running `submit` is safe.** `submit` reads `receiptStatus` before sending and never sends a recorded digest. If an earlier transaction is still pending and lands after a re-run, only one of them can record the digest: a duplicate `executeSpend` reverts on the used nonce and receipt (spec `SIG-03`), so the provider is paid at most once; the losing transaction only costs gas.
4. **Tool statuses.** `status: "unknown"` means the transaction was signed and handed to the RPC but its outcome is not known: the output has its hash and the `receiptStatus` it could read, or `"unreadable"`. `status: "sent"` means the transaction was mined but a read after it failed: every hash is reported. In both cases look the hashes up before running the tool again.
5. **Repayments are not idempotent.** A second `repay --amount` repays again. After an unclear repayment, read the line (`line status`) or the `Repaid` event before retrying. `repay --full` reads the outstanding amount when it runs and refuses a line that is no longer `DRAWN` or `DEFAULTED`.

## Reconciliation procedure

`reconcile` reads, at one pinned block, the Float's USDC balance, both totals and every line, and checks four identities. They follow from every write to the totals and to a line's state and amounts in the contract:

| Function | `totalCommittedCapital` | `totalSponsorObligations` | Line state and fields |
| --- | --- | --- | --- |
| `openLine` | `+ reserve` | `+ reserve` | new line, `OPEN`: `reserveCap = availableReserve = reserve` (the only write to `reserveCap`) |
| `executeSpend` (paid) | — | `- principal` | `OPEN` to `DRAWN` (it reverts on any other state): `availableReserve -= principal`, `principalOutstanding = principal` (it was 0 while `OPEN`; `principal > 0`) |
| `repay` on `DRAWN` | — | `+ amount` | `principalOutstanding -= amount`, `availableReserve += amount`; back to `OPEN` when the principal reaches 0 |
| `declareDefault` | — | — | `DRAWN` to `DEFAULTED`; no amount changes |
| `repay` on `DEFAULTED` | — | `+ amount` | `principalOutstanding -= amount`, `recoveryAvailable += amount` |
| `closeLine` | `- availableReserve` | `- availableReserve` | `OPEN` with no principal to `CLOSED`: `availableReserve = 0` (principal and recovery are already 0) |
| `claimDefaulted` | `- (availableReserve + recoveryAvailable)` | the same | stays `DEFAULTED`: both set to 0, their sum emitted as `SponsorClaimed.amount`; `principalOutstanding` is kept |

A line id hashes a fresh epoch, so `openLine` always starts from zeroed storage, and `DEFAULTED` and `CLOSED` are final. So, summed over every line ever opened, and for each line by its state (`sum(SponsorClaimed)` is the line's `SponsorClaimed` amounts from the index and the scan):

```text
balanceCoversObligations     usdc.balanceOf(Float) >= totalSponsorObligations                                  (CAP-02)
obligationsEqualLines        totalSponsorObligations == sum(availableReserve + recoveryAvailable)
committedCapitalEqualsLines  totalCommittedCapital   == sum(availableReserve + principalOutstanding + recoveryAvailable)
linesMatchReserveCap         OPEN       availableReserve == reserveCap, principalOutstanding == 0, recoveryAvailable == 0
                             DRAWN      availableReserve + principalOutstanding == reserveCap, principalOutstanding > 0,
                                        recoveryAvailable == 0
                             CLOSED     availableReserve == principalOutstanding == recoveryAvailable == 0
                             DEFAULTED  availableReserve + principalOutstanding + recoveryAvailable + sum(SponsorClaimed) == reserveCap
```

A defaulted line's unrepaid principal therefore stays in `totalCommittedCapital` after `claimDefaulted`; it leaves only when it is repaid and claimed. Every USDC movement in those functions is an exact transfer of the amount the obligations change by, so the balance equals `totalSponsorObligations` plus any USDC sent to the Float directly. `reconcile` reports that difference as `surplus`. The sums catch a missing line; only the per-line identities catch equal and opposite errors on two lines (reserve moved from one line to another, a `CAP-01` breach), which leave every total intact. Each entry of the output's `lines` has its `state`, `reserveCap`, the three amounts and `sponsorClaimed`.

What a result means:

- **All PASS, `surplus` 0.** The normal state.
- **`surplus` above 0.** Someone transferred USDC to the Float outside its functions. It is not a mismatch, and no function can move it out: it stays in the contract permanently. The Float's events do not show the sender; the token's `Transfer` logs do. Record it.
- **`balanceCoversObligations` FAIL.** CAP-02 is broken: the Float holds less USDC than sponsors are owed. The contract moves USDC out only in exact transfers matched by an obligations decrease, so this means a contract defect or a token behaving outside spec §8's assumptions. It is critical: run the incident procedure with both pauses.
- **`obligationsEqualLines` or `committedCapitalEqualsLines` FAIL.** Either a line is missing from the list (compare `discovery.lines` with a scan from an independent RPC), or the totals and the lines have diverged (spec `STATE-01`). If the independent scan still fails, run the incident procedure with both pauses. The output's `lines` table gives each line's fields for tracing.
- **`linesMatchReserveCap` FAIL.** Its detail names each line and the identity it breaks. A line's amounts no longer add up to what its sponsor committed: reserve moved between lines or out of one (`CAP-01`, spec `STATE-01`), or, on a `DEFAULTED` line, a `SponsorClaimed` event is missing from the RPC response (compare with an independent RPC). If the independent scan still fails, run the incident procedure with both pauses.

## Rehearsal checklist

For the team to run on Arc testnet once a candidate deployment and its rehearsal lines are authorized (never on the pilot line). Record who ran each step, the block and the JSON output.

- [ ] The indexer, `check` and `reconcile` run on the same schedule with `--index`; exit 1 from either monitor command reaches a person, including a run that fails with `error`; warnings are surfaced from `alerts`.
- [ ] Baseline: `check` has no alert; `reconcile` passes with `surplus` 0 against both RPCs.
- [ ] Maturity: on a rehearsal line, a purchase built with a short `--due-in` (at least the signature validity plus `minimumRepaymentWindow`) shows `MATURITY_SOON`, then `DEFAULT_ELIGIBLE` and exit 1 once due. A full repayment after `dueAt` clears it without a default.
- [ ] Pause: an operator pauses spends; `SPENDS_PAUSED` appears; `submit preflight` reports the block and `submit` refuses to send it; the agent repays and the sponsor closes a debt-free line while paused; the operator's `unpause` is refused; the Safe unpauses with `--calldata`; the alert clears.
- [ ] Key-compromise containment: with spends paused, the sponsor deactivates a drawn rehearsal line's provider policy with `set-provider-policy --inactive --execute --manifest $M`; after the agent repays and the Safe unpauses, a freshly built and signed intent to that provider (every step with `--allow-block`) is recorded as `SpendBlocked(PROVIDER_NOT_ALLOWED)`; the sponsor closes the line.
- [ ] Cap governance: the Safe proposes an increase; `CAP_INCREASE_PENDING` shows `activateAt`; an operator cancels it; the alert clears.
- [ ] Allowlist: removing a rehearsal sponsor shows `SPONSOR_REMOVED` on its live lines; the sponsor still closes them.
- [ ] Uncertain payment: an executor's `submit --execute` is interrupted after broadcast; the team follows the uncertain-payment procedure; `line receipt --digest` and the provider's `check-payment` agree; a re-run of `submit` sends nothing.
- [ ] Reconciliation: after purchases, partial repayments and a close, `reconcile` passes against both RPCs.
- [ ] Index: stopping the indexer for longer than `--max-index-lag` shows `INDEX_LAG`; `index --out index.json --resume --manifest $M` clears it.
- [ ] Incident closeout written for one drill.

## What is tested, and what is not yet rehearsed

`app/scripts/float-mainnet-monitor.test.mjs` runs on anvil through the committed CLIs:

- two lines found from canonical logs regardless of an index checkpoint; every line, a single `--line-id`, a 60-day horizon raising `LINE_EXPIRY_SOON` and `POLICY_EXPIRY_SOON`;
- `LINE_EXPIRY_SOON` raised by a horizon that reaches exactly `expiry - minimumRepaymentWindow` (the line's expiry itself is outside it), and not by a horizon one second shorter;
- an index whose checkpoint is ahead of the RPC's head (a lagging RPC) and one whose checkpoint hash no longer matches the chain (a reorganized checkpoint, simulated by editing the hash): each raises only `INDEX_LAG` with its note and lists every line from a full scan, and `reconcile` passes with the first;
- a purchase raising `MATURITY_SOON` inside the horizon but not with `--warn-before 60`; at `dueAt - 1` still only `MATURITY_SOON`, and at `dueAt` exactly `DEFAULT_ELIGIBLE` with exit 1 (block timestamps set exactly); `INDEX_LAG` for the stale index under the default `--max-index-lag`, not with `--max-index-lag` equal to the lag (and `--warn-before 60`), and again one second below it;
- an index that lost the due line's `LineOpened`: `check` still raises `DEFAULT_ELIGIBLE` (exit 1), `reconcile` still passes, and `--line-id` checks only the selected line;
- a canonical index with operator changes, provider-policy events, or both removed: `OPERATOR_CHANGED` and `POLICY_EXPIRY_SOON` still match a run with no index;
- `reconcile`, per-line identities included, passing after purchases, partial repayments, a default, repayment into recovery, two `claim-defaulted` calls (with the unrepaid principal still committed) and a close; the defaulted line's `reserveCap` equal to its unrepaid principal plus both `SponsorClaimed` amounts, from a scan and from a resumed index;
- an operator's pause through the owner tool, its refused unpause, `SPENDS_PAUSED` and `OPENINGS_PAUSED`, and `OPERATOR_CHANGED` while the operator is enabled and after the owner removes it;
- a proposed `PER_SPEND` increase reported with its `activateAt`, and cancelled by the owner after `activateAt`;
- a removed sponsor flagged on its live line only, and closing it afterwards;
- a direct USDC transfer reported as `surplus` with every check passing;
- a pending owner (`OWNERSHIP_PENDING`); the protocol cap reduced to `totalCommittedCapital` (no alert) and one below it (`PROTOCOL_CAP_EXCEEDED`);
- unit tests of the four identities with synthetic lines: each total failing on its own mismatch, each per-line identity failing on each field of each state, and equal and opposite errors on two lines failing only `linesMatchReserveCap`; and of the `CapKind` order against the contract source.

Not yet rehearsed or tested:

- anything on Arc testnet or another public network, and every step of the checklist above;
- a Safe sending pause, unpause, `setOperator` or cap-governance calls; there is no committed tool for the last two;
- real Arc USDC (restricted transfers, blocklisting) under the monitor;
- a real reorg: the reorganized index checkpoint is simulated by an edited hash, and a pinned block reorganized during a run is handled in code but not exercised by a test;
- two-RPC reconciliation, alert routing and a scheduler;
- scan time on a long chain.
