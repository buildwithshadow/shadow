# Public testnet enrollment and wallet purchases

This is implementation work, not an announcement of a deployed public service.
The current immutable candidate uses owner-approved sponsor admission. Its existing
single-enrollment API must not be described as permissionless onboarding.

`ShadowFloatPublicTestnet` provides self-registration on chain 5042002 only.
A sponsor calls `registerSponsor()` from its wallet, then approves an exact token
amount and opens its own funding line naming its agent and provider limits.
No operator collects an address or sends an enrollment token. Registering conveys
no right to another wallet's tokens or lines. The owner may revoke admission or
pause openings; a revoked sponsor cannot self-register again until restored.
The mainnet contract retains owner-managed admission. This testnet derivative
cannot be deployed on mainnet.

`app/src/selfServicePurchase.mjs` is a browser integration module for the agent
wallet. The caller supplies a reviewed deployment/runtime pin and fixed service
catalog configuration, plus a connected viem wallet/public client and persistent
browser storage. Never populate deployment or provider configuration from an
untrusted URL or a participant-supplied catalog.

The module prepares an intent from the agent's funded onchain line, obtains its
wallet signature, checks the provider's signed acceptance, simulates the purchase,
persists an attempt, and asks that wallet to submit the transaction. The agent
pays testnet gas. A backend executor and enrollment bearer token are unnecessary.
The provider still needs a reachable candidate-compatible HTTP service.

Retain one stable request ID across failures. `recover()` only checks the original
payment and retrieves/verifies its result. It never requests a transaction.
A lost wallet response leaves the attempt unresolved, including after refresh.
Browser Web Locks coordinate requests across tabs; unavailable persistence or
locking blocks a new transaction. A different browser/device can still submit a
transaction independently, but the onchain nonce and intent digest prevent a
second payment of that authorization. Do not describe browser storage as a global
transaction lock or an independent custody system.

## Remaining release work

- Review and deploy the testnet derivative; publish a pinned manifest and verify
  runtime/ABI identity. Do not change the production pin to an undeployed address.
- Integrate sponsor self-registration, connected agent invitations, provider
  selection, amount review, wallet changes and pending/recovery UI in the normal
  product flow. The module alone is not a usable public onboarding surface.
- Finish provider HTTP authentication/privacy as appropriate, CORS and resource
  limits. The report service accepts distinct `report:<random job ID>:<payment hash>`
  requests; retries must retain the original job ID.
- Exercise EOA and supported smart-wallet signing/execution separately against
  the deployed contract. Unit tests are not Circle wallet execution evidence.
- Verify funded purchase, duplicate/refusal, response loss, repayment and reclaim
  from an ordinary browser with a newly connected participant.
- Complete maintained HTTPS ingress, including unattended certificate renewal.
