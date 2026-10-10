# Public sponsor candidate

`ShadowFloatMainnetPublic` is a separate, undeployed version of the guarded
contract. The existing deployment and its source remain unchanged.

A caller can register its own wallet without contacting Shadow. Registration
moves no tokens and grants no allowance. The registered sponsor approves its
own reserve, opens a line for itself or another agent, and controls eligible
reclaim. An agent must still sign its purchase. Repayment remains bound to the
current draw. Registration does not change any reserve or spending limit.

The owner retains pause controls, delayed cap governance and sponsor revocation.
A revoked sponsor cannot register again until the owner readmits it. Repayment
and eligible recovery remain available while new activity is paused. This is
self service access with administrative safety controls, not a fully
permissionless protocol. No human security audit has been completed.

This version starts with both pauses active. It must not replace the live address
until deployment, runtime identity, monitoring, provider receipt binding and the
fresh wallet browser cycle are verified together. Public onboarding requires the
frontend to use the new verified address and enable its registration flow.

Validation includes the guarded payment and exact draw repayment regressions,
plus fresh caller registration, idempotency, revoked admission, governance
isolation, spending caps, self funding and sponsor only reclaim.
