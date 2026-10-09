# Guarded Circle runner on Arc testnet

`app/scripts/shadow-circle-guarded-testnet.mjs` connects bounded purchase,
report recovery and repayment to one guarded testnet funding line. It is an
explicit engineering route. The ordinary public `/start` flow and its existing
Circle runner continue using their original deployment.

The configuration in `app/guardedTestnetDeployment.mjs` pins chain `5042002`,
contract `0xd39d55Cc0C84408DCC409baDB776459641Dfd4be`, its runtime hash, the
ordinary EOA provider and the report endpoint. The service costs exactly
0.005 test USDC. Its report describes the agent wallet's USDC balance at a
confirmed block, checked against two RPCs. It is not a solvency assessment.

## Prepare

Use Node 22.18 or later and the separately installed, approved Circle runtime
described in [Circle onboarding](circle-agent-onboarding.md). Authenticate
privately on testnet and activate the wallet through the existing setup flow
if necessary. This runner does not log in, activate, admit sponsors, open lines
or change pauses.

Keep the same agent, `--state` journal directory and `--runtime` directory
used for previous Circle operations. A different journal is not a recovery
mechanism. Do not copy signatures or credentials into a command or issue.

```sh
node app/scripts/shadow-circle-guarded-testnet.mjs doctor --agent YOUR_AGENT_ADDRESS --state ORIGINAL_JOURNAL --runtime APPROVED_RUNTIME
node app/scripts/shadow-circle-guarded-testnet.mjs inspect --agent YOUR_AGENT_ADDRESS --line LINE_ID --state ORIGINAL_JOURNAL --runtime APPROVED_RUNTIME
```

The sponsor must independently review and authorize funding for this guarded
contract and the exact provider endpoint. Its reserve ceiling is 0.10 test USDC,
and its line spending ceiling is 0.005. The old public funding page creates
lines on another contract and cannot supply this runner's line. A successful
`doctor` result is an identity and session check, not lifecycle clearance.

The opt-in browser route `/guarded-testnet` is built with
`VITE_SHADOW_GUARDED_TESTNET_CANDIDATE=true`. It shares the pinned deployment
and service above, starts with the bounded limits and requires sponsor
admission. Its Circle handoff selects this runner. Browser repayments use
`repayForDraw`, bound to the purchase shown at review. Gateway funding is not
enabled on this route. Keep `/start` for the existing self-service deployment.

## Purchase, recover and repay

Without `--confirm`, purchase and repayment only show the line. With it,
purchase signs and executes one bounded intent, while repayment may perform
the exact 0.005 allowance followed by a separate repayment transaction. The
purchase permits a fee estimate up to 0.05 test USDC; the allowance and repayment
each permit estimates up to 0.03 test USDC. These checks do not guarantee actual fees.

```sh
node app/scripts/shadow-circle-guarded-testnet.mjs purchase --agent YOUR_AGENT_ADDRESS --line LINE_ID --state ORIGINAL_JOURNAL --runtime APPROVED_RUNTIME --confirm
node app/scripts/shadow-circle-guarded-testnet.mjs recover --agent YOUR_AGENT_ADDRESS --line LINE_ID --state ORIGINAL_JOURNAL --runtime APPROVED_RUNTIME
node app/scripts/shadow-circle-guarded-testnet.mjs repay --agent YOUR_AGENT_ADDRESS --line LINE_ID --state ORIGINAL_JOURNAL --runtime APPROVED_RUNTIME --confirm
```

Recovery never signs or sends a replacement. Saved execution records retain
their original adapter, calldata and operation identity. Before the repayment
allowance, the runner saves the reviewed purchase digest and exact amount.
A restart uses that original digest. If the current debt belongs to a different
purchase, repayment stops instead of silently changing its target.

An unknown outcome remains held. Recover the original request, even if a newer
line or debt appears on chain. A missing remote identity may need manual
investigation. Never delete the state, change operation IDs or reset a wallet
barrier to continue. The sponsor can reclaim eligible reserve only after
checking the completed repayment and current line state separately.

## Validation limits

The orchestration tests exercise persistence failure, lost confirmation,
restart recovery, adapter selection and a changed current draw. The underlying
purchase and repayment suites verify chain identity, fee limits, finalized
user operation attribution and shared wallet holds. Run them with:

```sh
node --test app/scripts/circle-agent-*.test.mjs
```

The monitor supports an explicit `executorPolicy: "circle-agent-v07"` on each
approved Circle line. It verifies the exact canonical and finalized EntryPoint
v0.7 user operation, its account call, signed intent digest and payment log
boundaries. The outer transaction sender remains recorded as the bundler.
Existing `dedicated` and `agent-self` policies do not authorize this route.

This release does not establish a complete live participant lifecycle or
independent adoption. Before a funded guarded rehearsal, verify the running
provider and monitor versions, approve the exact line baseline, and validate
sponsor admission, funding controls and the participant wallet flow. Mainnet
is outside this runner's scope.
