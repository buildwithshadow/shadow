# Bounded public funding lines

`ShadowFloatMainnetPublicBounded` is a separate, undeployed contract version. It does not change the existing public mainnet deployment, its source, manifests or participant balances.

## Capacity policy

A funding line and active provider policy must expire within seven days of line creation. The original maximum is recorded in `maximumLineExpiry`; later term or policy changes cannot move it forward. Repayment still does not reset the cumulative purchase limit.

After the line expires, anyone may call `closeExpiredLine` only for an OPEN or DEFAULTED line with zero outstanding principal. Unused reserve and any recovered repayment return exclusively to the recorded sponsor. The caller receives nothing. This remains possible when purchases and openings are paused, or the sponsor's admission has been revoked. Both `LineClosed` and `ExpiredLineClosed` are emitted; the latter identifies the actual caller.

This bounds passive abandonment. It does not stop an active participant from repeatedly registering wallets or opening new lines when capacity becomes available. Nor does it guarantee repayment or delivery. Debt bearing lines cannot be emptied through expiry closure.

## Integration requirements

Deployment must start empty with both pauses active. Source review, runtime identity, admission policy and caps must be verified before activation. A new verified manifest is required; clients must never substitute the new address into an old manifest.

Clients need to enforce the original expiry ceiling and explain permissionless closure after expiry. Monitoring must bind the new runtime and recognize the original LineClosed event as release of reserve while retaining ExpiredLineClosed caller attribution. Provider acceptance and payment receipts must bind the new contract address. Existing deployed lines remain at their original address with their existing repayment and reclaim routes; there is no automatic fund migration.

The bounded contract tests include opening and extension boundaries, exact expiry behavior, reserve return with pauses and revocation, capacity reuse, draw bound repayment, EOA and ERC-1271 signatures, defaults, and adversarial token transfer rollback. These tests do not constitute an independent human audit or deployment authorization.
