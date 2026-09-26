# Durable execution sessions

Mainnet `submit --execute` and `submit --calldata` also require a passing
`--manifest`, an approved `--monitor-baseline`, and `--monitor-state-dir`.
The submitter checks fresh monitor health before reserving an attempt and again
immediately before direct broadcast. Missing, stale, corrupt or latched monitoring
holds fail closed. A previously recorded digest can still be reconciled while
monitoring is held; recovery never sends it again. See
[the monitor runner](FLOAT_MAINNET_MONITOR_RUNNER.md).

Calldata output checks monitoring when it is prepared, but cannot enforce what a
separate wallet does later. Recheck before that wallet executes. This client
policy does not prevent direct contract calls outside these tools.

The candidate submit tool requires a durable session policy on Arc mainnet
(chain 5042). Testnet tools can opt in with the same `--session` flag. This is
executor policy, **not a global contract limit**. It does not authorize a release,
prove signer control, or protect against a different executor bypassing these tools.

Create a private JSON policy with these fields; fill every value deliberately:

```json
{
  "kind": "ShadowFloatMainnet.ExecutionSession",
  "sessionId": "unique-operator-assigned-session",
  "chainId": "<decimal chain id>",
  "verifyingContract": "<candidate address>",
  "runtimeKeccak256": "<verified runtime hash>",
  "executor": "<nonzero executor address>",
  "sponsor": "<sponsor address>",
  "agent": "<agent address>",
  "provider": "<provider payment address>",
  "endpointHash": "<hash of the exact agreed endpoint>",
  "maxGrossPrincipal": "<positive atomic USDC integer>",
  "ledgerDirectory": "./unique-session-ledger"
}
```

The ledger directory is resolved relative to the policy file. Initialize it once
after the normal candidate connection/manifest checks. These commands are key-free:

```sh
node app/scripts/float-mainnet-submit.mjs init-session --session /private/session.json --manifest /private/release.json
node app/scripts/float-mainnet-submit.mjs reconcile-session --session /private/session.json --manifest /private/release.json
```

Use the existing connection environment. Prepare an intent with an explicit
nonzero `--executor` and pass `--session /private/session.json` to intent
`build`, `sign`, or `verify` as well as every preflight and submit. Preparation
checks the exact parties, runtime and remaining capacity but does not reserve it.
Use this **same initialized policy** throughout:

```sh
node app/scripts/float-mainnet-submit.mjs preflight --intent /private/signed.json --session /private/session.json --manifest /private/release.json
node app/scripts/float-mainnet-submit.mjs submit --intent /private/signed.json --session /private/session.json --manifest /private/release.json
# Only with the existing transaction authorization and executor signer:
node app/scripts/float-mainnet-submit.mjs submit --intent /private/signed.json --session /private/session.json --manifest /private/release.json --execute
```

A dry run does not reserve a new attempt. Before execution or `--calldata` output,
the tool durably reserves the intent's principal and binds its complete message
and digest. The signed transaction hash is persisted **before broadcasting**.
One digest is counted once. Closing/reopening lines, repayments, process restarts,
UTC rollover, and new line epochs never reset the session total.

`reservedGrossPrincipal` is a conservative bound: **blocked and reverted attempts
also retain their reservation**. `acceptedPrincipal` reports the subset observed
as paid. Remaining capacity can therefore be lower than the nominal cap minus
paid principal. The session never reissues a reserved digest. An unknown result,
including calldata handed to an external executor without a transaction hash,
holds all new submissions until canonical onchain evidence resolves it. An absent
receipt, expired signature, cancelled nonce or RPC error alone never clears it.

Reconciliation reads receipt status at one pinned block and rechecks that block's
hash before persisting. A previously recorded outcome disappearing or changing
halts the session. Capacity is never released even when a refusal or revert is
observed, so a reorganization cannot recycle the budget.

All executor processes must use the **same persistent local directory**. An
exclusive filesystem lock prevents concurrent sessions from racing within that
directory. A process crash can leave a lock: stop every executor and verify the
original ledger and chain history before manually removing only the stale lock.
There is no automatic stale-lock expiry, ledger recreation, budget reset, or
unknown-attempt override. Missing/corrupt ledgers and changed policies fail closed.
Back up the policy and ledger together; do not place them in a disposable checkout.

This is not a distributed lock, a tamper-proof database, or protection against
deleting/restoring stale copies of the whole directory, creating another session,
or using the executor key elsewhere. A new policy/directory constitutes a separate
operating decision; never use it to bypass an unresolved or exhausted session.
For multiple hosts use one coordinated execution service instead of copied ledgers.
