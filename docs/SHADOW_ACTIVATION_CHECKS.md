# Read-only staged activation checks

`app/scripts/float-mainnet-activation.mjs` compares a deployment with a separately
reviewed private plan at a fresh block shared by two RPC endpoints. It reads
configuration and balances; it never signs, sends, creates a Safe, grants an
allowance or advances a release stage. An `ok: true` result means the requested
phase matched at that block. `releaseReady` remains false: signer control,
security review, participant arrangements and release authorization are separate.

## Phase meanings

| Phase | Required state |
| --- | --- |
| `deployed` | Deployer still owns the contract; initial pauses are false; no sponsors, operators, lines, funds, obligations or allowance. |
| `contained` | Same empty state, with both pauses explicitly true. |
| `owned` | Accepted owner Safe and exact pause operator; pending ownership cleared; both pauses true and no sponsor admission or funding. |
| `funded` | Exactly the first unused line, exact reserve and provider terms, one sponsor, zero residual allowance, both pauses true and healthy approved monitoring. |
| `enabled` | Same first-line state, with openings paused and spends explicitly unpaused; monitoring must match this phase. |

These checks intentionally reject a previously used deployment, unexpected token
surplus, extra historical lines and active provider policies. After the first
purchase use the monitor/reconciliation tools instead of pretending the unused
activation state still exists. The check is a snapshot, not a transaction lock;
revalidate and simulate immediately before any later action.

## Private plan and trusted inputs

Keep operational addresses, budgets and approvals in a local plan, outside the
repository. The operator must obtain the plan and manifest SHA-256 digests from
the reviewed release packet, independently of the files being checked. Do not
silently recompute approved hashes after a file changes. The checker validates
and compares a trusted plan; it cannot establish that its author or a selected
Safe implementation is trustworthy.

The `shadow-activation-plan/v1` shape contains:

- `chainId`, `deploymentBlock`, `minimumRepaymentWindow`,
  `maximumRepaymentWindow`, `governanceDelay`: unsigned decimal strings.
- `address`, `usdc`, `deployer`, `sponsor`, `agent`, `executor`, `provider`,
  `operator`: nonzero public addresses. The deployer, owner Safe and pause
  operator are distinct. No private key or seed is accepted.
- `runtimeHash`, `tokenCodeHash`, `agentCodeHash`, `endpointHash`: bytes32.
  `tokenImplementation` and `tokenImplementationHash` pin the USDC proxy logic,
  not only its unchanged proxy code. Arc mainnet requires the canonical token
  and a nonzero implementation; explicit null is allowed only off mainnet.
- `effectiveLimits` and `maximumLimits`: exact positive six-decimal atomic USDC
  strings for `protocolReserve`, `lineReserve`, `lineSpend`, `perSpend`,
  `dailySpend`. They are compared to current and immutable contract limits.
- `safe`: `address`, `version` (`1.4.1` or `1.5.0`), `proxyCodeHash`,
  `singleton`, `singletonCodeHash`, explicit `owners`, decimal `threshold`,
  `fallbackHandler` and `fallbackCodeHash` (null only for a zero handler).
  Pin hashes from independently reviewed official deployment artifacts.
  Modules and transaction guards must be absent; version 1.5.0 also requires
  an empty module guard. A Safe-shaped interface alone is insufficient.
- `line`: positive decimal `reserve`, `lineSpendCap`, `dailySpendCap`,
  `expiry`, `maximumRepaymentWindow`, `providerExpiry`, `providerPerSpendCap`,
  `providerDailySpendCap`. Times are absolute chain seconds, not reusable TTLs.
- `maxAgeSeconds`: integer 1–300; `monitorBaselineHash`: SHA-256 of the
  normalized approved monitor baseline. Each phase needs its correct baseline.

The plan must match a passing release manifest and its named deployer. Both RPC
origins must differ; the operator must additionally verify they are independently
operated. Distinct URLs alone do not prove independence. State and log discovery
are read from deployment through the current common head and checked for reorgs.
Token pause/blocklist failure, unreadable state, incomplete inputs and changed
files fail closed.

```sh
node app/scripts/float-mainnet-activation.mjs check \
  --plan /private/release/activation.json --plan-sha256 "$APPROVED_PLAN_HASH" \
  --manifest /private/release/manifest.json --manifest-sha256 "$APPROVED_MANIFEST_HASH" \
  --phase owned
```

Set `ARC_RPC_URL` and `ARC_RPC_URL_2` for the two read providers. The
`funded` and `enabled` phases additionally require `--monitor-baseline` and
`--monitor-state-dir`. The runner rechecks the stored snapshot and latched hold;
a copied healthy flag cannot replace those files. The activation checker still
reads current state independently of the earlier heartbeat block.

Safe adapter references: official [v1.5.0 contracts](https://github.com/safe-global/safe-smart-account/tree/v1.5.0/contracts),
[v1.4.1 contracts](https://github.com/safe-global/safe-smart-account/tree/v1.4.1/contracts),
and [deployment registry](https://github.com/safe-global/safe-deployments).
This tool checks a supplied Safe configuration, not institutional or independent governance.
