# Controlled mainnet Circle runner

This runner uses the existing guarded Shadow deployment on Arc mainnet, chain 5042. Installing it does not admit sponsors, fund lines, activate wallets, change Circle policies, grant independent participant access or unpause the contract.

Its service costs exactly 0.005 USDC. The browser funding configuration limits each line to a 0.10 USDC reserve and 0.005 USDC cumulative purchases. Each Circle execution estimate must remain within 0.02 USDC. This is an estimate ceiling, not a guarantee of the final gas charge. Repayment requires the agent's own USDC plus gas; the line reserve cannot repay itself.

Use the reviewed isolated Circle runtime and the original mainnet journal for this wallet. Authenticate privately with Circle's mainnet login. Never create a new journal to escape an unresolved operation. The runner requires an explicit state path and cannot log in, activate a wallet, reset a journal or modify policies.

```sh
node app/scripts/shadow-circle-guarded-mainnet.mjs help
node app/scripts/shadow-circle-guarded-mainnet.mjs inspect \
  --agent YOUR_CIRCLE_ADDRESS --line EXACT_LINE_ID \
  --state ORIGINAL_MAINNET_JOURNAL --runtime ISOLATED_CIRCLE_RUNTIME
```

`doctor` checks the mainnet Circle session and deployed wallet. `inspect`, and `purchase` or `repay` without `--confirm`, do not sign or submit. `recover` requires the original `--session-policy` path, reconciles original recorded requests and the execution session ledger, and retrieves the original result. It does not need a spend enabled monitor. Recovery does not resubmit a payment.

A confirmed purchase additionally requires these reviewed operator paths:

```sh
node app/scripts/shadow-circle-guarded-mainnet.mjs purchase \
  --agent YOUR_CIRCLE_ADDRESS --line EXACT_LINE_ID \
  --state ORIGINAL_MAINNET_JOURNAL --runtime ISOLATED_CIRCLE_RUNTIME \
  --monitor-baseline APPROVED_BASELINE_JSON \
  --monitor-manifest VERIFIED_MANIFEST_JSON \
  --monitor-state CURRENT_OBSERVER_STATE \
  --session-policy APPROVED_SESSION_JSON --confirm
```

The policy and monitor baseline must identify this exact chain, deployment, sponsor, line epoch, agent, provider, endpoint and Circle wallet as the named purchase executor. An older baseline naming an EOA executor cannot authorize this flow. Prepare the correct observer phase through the existing reviewed operating procedure. Do not edit snapshots, remove incident holds or weaken freshness checks to make a purchase pass.

The fresh monitor check runs after the remote session probes immediately before signing, during execution preparation, after estimation and immediately before invoking Circle's execution command. The existing execution session ledger is reconciled and checked before signing or spending, then durably reserves the exact digest before Circle submission. Unknown attempts hold the session. Paid, blocked and reverted reservations conservatively consume its cumulative gross budget; repayment never refunds that capacity. Recovery attaches only the original transaction identity and reconciles this same ledger. The adapter verifies the pinned runtime and current line, bounds the fee estimate and preserves a durable uncertainty barrier before calling Circle. A failed monitor check before submission is definitely unsent. A lost execution response remains unknown; keep the original journal and transaction identity. No unsupported lookup by idempotency key or automatic retry is assumed.

Repayment saves the original reviewed draw before approving the exact 0.005 USDC allowance and calling `repayForDraw`. A newer draw is refused. Recovery and repayment do not require an unpaused purchase phase. Sponsor reclaim remains a separate browser wallet action.

This release supplies operator tooling. The feature gated mainnet browser handoff provides command templates; it cannot authenticate or operate the Circle wallet. Live mainnet rehearsal, qualified independent review and credential containment procedures remain separate release requirements.

## Local operator paths

The mainnet browser handoff uses these environment variables. Configure them privately in the agent's own terminal once. Use the original mainnet wallet journal, isolated reviewed runtime, original approved session policy and current verified observer state. Paths are local configuration, not wallet keys. Do not copy another operator's journal or credentials.

```sh
export SHADOW_CIRCLE_MAINNET_STATE="/path/to/original/mainnet/journal"
export SHADOW_CIRCLE_RUNTIME="/path/to/isolated/circle/runtime"
export SHADOW_CIRCLE_MAINNET_SESSION="/path/to/approved/session.json"
export SHADOW_CIRCLE_MAINNET_BASELINE="/path/to/approved/baseline.json"
export SHADOW_CIRCLE_MAINNET_MANIFEST="/path/to/verified/manifest.json"
export SHADOW_CIRCLE_MAINNET_MONITOR_STATE="/path/to/current/observer/state"
```

These are examples to replace with the reviewed local paths. The website never reads the variables. Unset variables expand to empty arguments, which the runner refuses before signing or sending. Inspect requires the journal and runtime; recovery also requires the original session policy; purchase requires all six paths. Repayment retains the original journal and runtime and does not need an unpaused spend monitor.
