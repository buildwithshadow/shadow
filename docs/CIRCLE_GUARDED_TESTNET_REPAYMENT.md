# Circle guarded repayment on Arc testnet

The guarded repayment modules expose separate entry points for Arc testnet. They
support a bounded USDC allowance and `repayForDraw` for one pinned line and draw.
This is a developer integration boundary. The public `shadow-circle-agent.mjs`
runner still uses the public testnet deployment and its legacy repayment flow.

| Layer | Testnet entry point | Module |
| --- | --- | --- |
| Execution and receipt verification | `createCircleGuardedTestnetRepayer` | `app/scripts/circle-agent-execution.mjs` |
| Verified Circle CLI transport | `createCircleGuardedTestnetCliTransport` | `app/scripts/circle-agent-guarded-cli.mjs` |

The testnet executor requires `config.chainId: 5042002`. The transport uses
`ARC-TESTNET` for wallet membership, estimates, execution, and transaction history,
and checks the testnet session. The existing guarded mainnet factories retain
chain `5042` and `ARC`; network selection is fixed by the chosen factory.

## Required configuration

Supply the exact agent, guarded contract, reviewed deployed runtime hash,
`expectedLineId`, nonzero `expectedDraw`, `maxAmount`, and `maxNetworkFee` to the
executor. Supply the same agent, contract, line, draw, and amount to the transport,
together with the approved CLI entry point and durable journal. Use the verified
transport factory; the exported driver functions are test injection boundaries.

`maxAmount` is in six-decimal USDC atomic units and is capped at `50000` (0.05 USDC).
Each allowance or repayment must equal that pinned amount. `maxNetworkFee` is in
18-decimal native gas units and is capped at `20000000000000000` (0.02 USDC).
The executor verifies the current draw and agent debt before and after estimating
fees, then verifies the exact finalized user operation and repayment events.

## Preserve wallet recovery state

Use the wallet's original registered journal, operation IDs, and identity store.
Legacy and guarded testnet execution deliberately share the same chain-and-wallet
namespace. An unresolved operation in either path blocks a different operation in
the other path, including across deployments. A legacy record must be reconciled
through its original adapter; changing repayment semantics is not a recovery.

`reconcile` performs lookup and receipt checks without resending. A missing remote
identity remains unknown. Never replace the journal, clear its active barrier, or
generate a fresh operation ID to escape an uncertain result. Mainnet has a separate
chain namespace and remains accessible only through its explicit factories.

These repayment entry points support repayment only. A separate
[guarded purchase library](CIRCLE_GUARDED_TESTNET_PURCHASE.md) provides bounded
testnet signing and execution. Guarded provider setup, participant admission,
the public runner, and the complete ordinary participant lifecycle still
require integration and live validation.

## Validation

Run the Circle regression suite from `app`:

```sh
node --test scripts/circle*.test.mjs
```

The tests cover testnet command routing, session separation, stale draws, amount
and fee limits, saved remote IDs, exact receipt attribution, and uncertainty holds
shared with the legacy testnet executor. Fixture tests do not establish a live
funded testnet or mainnet lifecycle.
