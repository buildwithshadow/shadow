# Circle guarded purchases on Arc testnet

The guarded purchase library provides an explicit integration path for one
reviewed funding line on chain `5042002`. It does not change the public
`shadow-circle-agent.mjs` runner, enable a mainnet purchase, activate a wallet,
or authorize sponsor funding.

| Layer | Entry point | Module |
| --- | --- | --- |
| Execution and receipt verification | `createCircleGuardedTestnetPurchaser` | `app/scripts/circle-agent-execution.mjs` |
| Verified Circle CLI transport | `createCircleGuardedTestnetPurchaseTransport` | `app/scripts/circle-agent-cli-transport.mjs` |

## Pin the purchase

The transport is restricted to guarded testnet contract
`0xd39d55Cc0C84408DCC409baDB776459641Dfd4be`. Supply the same contract to the
executor with its independently verified deployed runtime hash. Both layers
require the exact agent, provider, endpoint hash, nonzero `expectedLineId`, and
`maxAmount`. The principal and maximum debt must both equal that amount, which
cannot exceed `5000` six decimal units, or 0.005 test USDC.

The executor also requires `config.chainId: 5042002` and `maxNetworkFee` in
18 decimal native gas units, capped at `50000000000000000`, or 0.05 test USDC.
Lower configured limits still apply. This checks an estimate and does not guarantee
the actual network fee. Guarded repayment uses its own separate limit.
It checks the deployment, repayment binding version 2, line owner, open state,
zero debt and simulated purchase policy before submission. It repeats the
policy checks after estimating the fee. The agent must already be activated.

Supply the approved Circle CLI entry point and the original durable wallet
journal to the verified transport factory. The transport verifies and freezes
the reviewed CLI source and dependency closure. Its narrowly scoped
compatibility copy supports raw `executeSpend` tuple calldata on this testnet
contract only. It preserves Circle authentication and policy enforcement.
Exported driver functions are injection boundaries for tests, not a substitute
for the verified factory.

## Recover before another operation

Use stable logical operation IDs and the wallet's original registered journal.
The purchase, legacy testnet executor, and guarded repayment adapter share the
same wallet and chain namespace. An uncertain operation blocks a different
operation, even on another deployment. Do not clear the barrier, replace the
journal, or change adapters to escape it.

`reconcile` only reads saved Circle identities and chain evidence. It verifies
the canonical finalized transaction, the exact EntryPoint user operation, and
the payment or refusal event inside that operation's log boundaries. A missing
remote transaction identity remains unknown; this library never retries an
uncertain submission. Recover each record through its original adapter.

Allowances and repayments are rejected by the purchase adapter. Repayment uses
the separate [guarded repayment adapter](CIRCLE_GUARDED_TESTNET_REPAYMENT.md),
with the line, purchase digest and amount reviewed and saved before submission.
Never reconstruct an old repayment against a newer current draw.

## Validation and integration status

Run the Circle regression suite from the repository root:

```sh
node --test app/scripts/circle-agent-*.test.mjs
```

Tests cover exact purchase scope, changed debt, session separation, altered
receipts, lost confirmation and shared uncertainty holds. They also boot the
frozen compatibility copy without credentials. These tests do not establish a
completed live guarded participant lifecycle. The provider deployment, sponsor
admission, participant runner, funding interface and live lifecycle require
their own integration and validation.
