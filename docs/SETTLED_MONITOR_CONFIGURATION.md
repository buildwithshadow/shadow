# Settled testnet provider monitoring

The settled contract separates active committed capital from unpaid defaulted principal and recovery escrow. A monitor policy for this generation must explicitly set `accountingModel` to `settled-v1` in its protected baseline and in the release manifest's `contract` object. The runner rejects a mismatch at startup. Baselines without this field retain the legacy accounting model and their existing hashes.

Policy evaluation independently recomputes the settled balances from every discovered line. It requires the `defaultedPrincipalEqualsLines` check and a valid `totalDefaultedPrincipal` value, in addition to the existing escrow and reserve identities. A snapshot cannot switch models or omit the unpaid debt ledger while claiming to be healthy.

For the isolated Arc testnet provider, select `PROVIDER_ADMISSION_MODE=settled-testnet-monitor`. The manifest must identify `shadow-public-settled-testnet-release`, contract name `ShadowFloatMainnetPublicSettled`, public registration, repayment binding version 2, and maximum line lifetime 604800 seconds. Its chain must be 5042002 and its protected fixed participant baseline must use schema version 1 and settled accounting.

This mode retains canonical block, exact runtime, unchanged policy and manifest, completed heartbeat, freshness and latched hold checks. Spending must be enabled in the approved phase before the provider accepts a new purchase. It does not weaken the existing bounded testnet or public mainnet modes.

Use separate manifest, baseline, observer state, provider store and witness directories for the settled deployment. An old heartbeat or historical store must not be copied into the new identity. Repayment, debt recovery and reserve closure remain separate contract operations and are not gated by a provider signing new acceptances.
