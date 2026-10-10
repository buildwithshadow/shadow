# Draw-bound repayment contract

`ShadowFloatMainnetGuarded` is a separate immutable contract. The guarded Arc
mainnet deployment, chain 5042, is
`0x708c8c987eb4Cd14445Ac2c65ea712b2084888eB`. It does not modify the older
`ShadowFloatMainnet` deployment. It starts with both openings
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

The repayment CLI requires `--expected-draw <digest>` for the guarded contract.
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

## Deployed source and review status

The deployed instance has a separate guarded source and compilation review packet. Its public [deployment identity](../contracts/deployments/float-mainnet-guarded/arc-mainnet.identity.json) records the actual creation transaction, block, runtime hash, compiler version and source blob. The runtime hash is `0x845c0c3e47bbcf75004e5d47a6788585d57026ce70c08593d112966a6245b4ef`; the source merged at `f908cf3622611281695692972d5d3ee24491b097` remains unchanged in the repository. This identity record is informational and cannot replace an execution manifest or current live checks.

The founder mainnet lifecycle has completed. As checked on 10 October 2026, both pauses are active, the completed line is closed, and debt, committed capital and contract USDC balance are zero. Qualified independent human security review remains pending. Automated reviews, local tests and founder rehearsals do not establish an independent security audit or clearance for funded participants.

For future instances, prepare a version specific guarded source and compilation packet before deployment, then verify the new onchain identity, roles and credential recovery, participant terms and isolated lifecycle. The older pinned review package builder targets legacy V1 sources and suites; never relabel that package as a review of the guarded version. The full repository contract gate runs both versions separately.
