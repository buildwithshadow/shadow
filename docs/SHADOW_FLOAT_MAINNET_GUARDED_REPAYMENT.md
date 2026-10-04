# Draw-bound repayment candidate

`ShadowFloatMainnetGuarded` is a separate, undeployed immutable candidate. It does
not modify a deployed `ShadowFloatMainnet` contract. It starts with both openings
and purchases paused. Its spending domain remains `ShadowFloatMainnet` version
`1`; the verifying contract address separates signatures from every earlier
instance. Addresses, code hashes, deployment manifests and signing intents must
be prepared for the new instance before using it. Do not reuse a legacy manifest.

Each successful purchase stores its EIP-712 digest in `currentDrawDigest(lineId)`.
`repayForDraw(lineId, expectedDraw, amount)` checks that nonzero digest atomically
before pulling tokens. Partial repayments keep that identity. Full repayment
opens the line but does not make an old transaction valid against a subsequent
purchase: that purchase replaces the digest. Defaulted recovery remains bound to
the original draw. `DrawRepaid` names the draw and payer; the existing `Repaid`
event is also emitted for accounting readers. The unguarded `repay` selector is
absent, so clients cannot bypass the binding.

The browser funding kit supports an explicit `drawBoundRepayment` deployment
configuration. It verifies the runtime and `repaymentBindingVersion == 2`, reads
the draw at the line observation block, embeds it in calldata and checks the
matching `DrawRepaid` event. No public deployment configuration is switched by
this change. Legacy testnet lines remain generic-current-debt repayments; their
review text explicitly warns that a delayed approval can pay a newer purchase.

The repayment CLI requires `--expected-draw <digest>` for the new candidate.
Legacy operation requires explicit `--allow-current-line-debt` consent, including
in simulation and calldata modes; these alternatives are mutually exclusive.
Neither browser freshness checks nor a brief wallet prompt fix legacy calldata.

## Payment and result recovery

A paid status alone is insufficient to identify the paid provider. Delivery and
result retrieval require a canonical `ProviderPaid` for the exact digest,
contract, provider and principal. Missing, partial or failed log access holds
recovery without making another payment. `--payment-tx <original hash>` uses the
original confirmed transaction receipt instead of ranged log scans. Its event
and canonical block are revalidated. The reference server stores that transaction
identity durably before service work and rechecks it on stored-result recovery.
A stored delivery alone is never payment evidence. Existing stored bytes may be
returned after provider signer rotation; this does not authorize new signing or
new work with a revoked key. Agent-side signatures must still verify.

## Remaining trust and financial boundaries

Sponsor funds spent on a provider are unsecured credit exposure. Shadow does not
collect automatically, seize agent assets, guarantee repayment, guarantee service
quality or create a refund. Default/reclaim returns only eligible unspent reserve
and money actually repaid. Other sponsors can fund the same agent independently;
a defaulted older epoch is not an agent-wide credit ban.

Acceptance, gross execution budgets and monitor checks are host controls. Direct
authorized contract calls remain subject to onchain signature, nonce, provider,
endpoint, reserve and spending caps, but do not prove offchain service acceptance.
A server administrator can compromise local journals; checksums detect corruption,
not a malicious administrator. Unknown payment or external-work outcomes remain
held for reconciliation rather than blindly repeated.

An operational release needs its own reviewed deployment/verification, role and
credential recovery checks, participant terms, and isolated lifecycle rehearsal.
Tests and automated review do not establish an independent security audit.

The existing pinned review-package builder remains scoped to the legacy V1
sources and test suites. It does not audit or archive the guarded candidate.
The full repository contract gate runs both versions separately. Prepare a
version-specific source/compilation review package before deploying the guarded
candidate; never relabel the legacy package as its review.
