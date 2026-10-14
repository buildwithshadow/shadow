# Bounded public funding lines

`ShadowFloatMainnetPublicBounded` is a separate contract version. Each deployment needs its own verified manifest. It does not change the existing public mainnet deployment, its source, manifests or participant balances.

## Capacity policy

A funding line and active provider policy must expire within seven days of line creation. The original maximum is recorded in `maximumLineExpiry`; later term or policy changes cannot move it forward. Repayment still does not reset the cumulative purchase limit.

After the line expires, anyone may call `closeExpiredLine` only for an OPEN or DEFAULTED line with zero outstanding principal. Unused reserve and any recovered repayment return exclusively to the recorded sponsor. The caller receives nothing. This remains possible when purchases and openings are paused, or the sponsor's admission has been revoked. Both `LineClosed` and `ExpiredLineClosed` are emitted; the latter identifies the actual caller.

This bounds passive abandonment. It does not stop an active participant from repeatedly registering wallets or opening new lines when capacity becomes available. Nor does it guarantee repayment or delivery. Debt bearing lines cannot be emptied through expiry closure.

## Integration requirements

Deployment must start empty with both pauses active. Source review, runtime identity, admission policy and caps must be verified before activation. A new verified manifest is required; clients must never substitute the new address into an old manifest.

Clients need to enforce the original expiry ceiling and explain permissionless closure after expiry. Monitoring must bind the new runtime and recognize the original LineClosed event as release of reserve while retaining ExpiredLineClosed caller attribution. Provider acceptance and payment receipts must bind the new contract address. Existing deployed lines remain at their original address with their existing repayment and reclaim routes; there is no automatic fund migration.

The bounded contract tests include opening and extension boundaries, exact expiry behavior, reserve return with pauses and revocation, capacity reuse, draw bound repayment, EOA and ERC-1271 signatures, defaults, and adversarial token transfer rollback. These tests do not constitute an independent human audit or deployment authorization.

Expiry closure evidence records `expiryCaller` separately from the sponsor recipient. The verifier requires a matching canonical `ExpiredLineClosed` companion in the same transaction and block after `LineClosed`, with the same amount and sponsor. Ordinary sponsor close exports retain their prior shape. The existing legacy artifact certification is not a certification of the bounded candidate; a bounded release needs its own verified compiler/source and runtime record.

## Monitored testnet rehearsal

The provider can explicitly select `PROVIDER_ADMISSION_MODE=testnet-monitor` for a bounded deployment on Arc testnet (5042002). This requires a fixed schema 1 monitor baseline, a version-specific manifest with kind `shadow-public-bounded-testnet-release`, contract name `ShadowFloatMainnetPublicBounded`, public registration, repayment binding version 2 and the original seven-day lifetime bound. Pin the exact participants, lines, limits and pause state in that baseline before enabling acceptance.

The provider still requires a fresh healthy heartbeat, no unresolved hold, a canonical observation block and the exact deployed runtime. Changed files or monitor observations fail closed. Existing paid-result recovery is independent of new-payment admission. This mode cannot satisfy the public mainnet monitor policy or select unmonitored signing by fallback.
