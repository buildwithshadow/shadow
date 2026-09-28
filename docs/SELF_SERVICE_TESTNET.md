# Public testnet enrollment and wallet purchases

The live browser entry is [Shadow Start](https://www.shadowbuild.xyz/start).
This is the self-service Arc testnet path, separate from the earlier
owner-admitted candidate and the V2 integration tools.

## Deployment and service

| Item | Current public testnet configuration |
| --- | --- |
| Chain | Arc testnet, `5042002` |
| Contract | `0xB31d9e17410B10a619B66dF0c31f59acbb33B553` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Provider | `0xFAF237F98f35A86149E901e18EB4BAd67bC0D347` |
| Service | Shadow payment cycle report, `50000` micro-USDC (0.05 test USDC) |
| Provider HTTP base | `https://api.shadowbuild.xyz:8443/provider` |
| Signed endpoint identifier | `https://api.shadowbuild.xyz:8443/provider/shadow-v2-cycle` |

The endpoint identifier is bound into the signed terms; it is not a GET route
for buying or retrieving a report. The browser module uses the provider HTTP
base for acceptance and delivery. Configuration and runtime identity come from
[`publicTestnet.ts`](../app/src/publicTestnet.ts) and the
[deployment manifest](../contracts/deployments/public-testnet/arc-testnet.manifest.json).
Do not obtain contract/provider configuration from an invitation URL.

The report checks an older V2 payment cycle. Its historical transaction hashes
are report content, distinct from the new transaction paying for that report.
Current browser use supports injected EOA wallets such as Rabby. The Circle
passkey diagnostic is separate; it is not a second connector for this flow.

## Funding and signing

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
The configured provider HTTP service is hosted. No backend executor or private
enrollment token is required for this public browser flow.

Retain one stable request ID across failures. `recover()` only checks the original
payment and retrieves/verifies its result. It never requests a transaction.
A lost wallet response leaves the attempt unresolved, including after refresh.
A confirmed refusal or an expired, unpaid authorization can be archived after
checking receipt status and expiry against the same finalized block. Paid results
are recovered before archival; unexpired unknown attempts cannot be discarded.
Browser Web Locks coordinate requests across tabs; unavailable persistence or
locking blocks a new transaction. A different browser/device can still submit a
transaction independently, but the onchain nonce and intent digest prevent a
second payment of that authorization. Do not describe browser storage as a global
transaction lock or an independent custody system.

## Browser integration contract

Use `createSelfServicePurchase` from `app/src/selfServicePurchase.mjs`; its
TypeScript interface is `app/src/selfServicePurchase.d.mts`.

| Method | Effect | UI responsibility |
| --- | --- | --- |
| `load()` | Reads the saved record, or null | Show unresolved work before offering a new purchase |
| `prepare(lineId, requestId)` | Checks the connected agent and line; saves a prepared intent | Show exact price, provider, sponsor, agent and due time |
| `submit()` | Requests a signature, verifies provider acceptance, simulates, then requests the wallet transaction | A returned hash is not confirmation; retain the original record |
| `recover()` | Reconciles receipt status and verifies the original provider result | Handle `unconfirmed`, `blocked`, or `delivered`; delivery failures may throw after a successful payment |
| `archive()` | Checks whether the original record can be resolved and archived | Never clear storage to escape an uncertain payment |

Stored stages are `prepared`, `accepted`, `submitted`, and `delivered`. They are
not a complete payment-status enum: `submitted` can persist before a wallet
response is known, and a paid purchase can still await delivery. An error does
not imply that no payment occurred. Provider status alone is not chain proof.
The original digest/request ID, onchain receipt and verified provider receipt
remain bound by the module. Treat result bytes as untrusted text, not HTML.

After submission, the funding desk waits for a receipt before reloading the
line. Recovery also reloads its balance, including when delivery fails. If the
page was reloaded without a selected line, the saved purchase supplies it;
an explicitly selected different line is not replaced. Confirmation/read timeouts
preserve the purchase and direct the participant to recovery, never resubmission.
Repayment and reclaim use their own funding journal and wallet confirmations.

The provider protocol exposes `POST /accept`, `POST /serve`, and
`GET /status/<digest>` under the HTTP base above. Prefer the module over direct
frontend calls; it verifies the acceptance and delivery signatures. Exact wire
handling lives in `examples/float-mainnet-provider-server/server.mjs`.

## Invitations and line selection

An agent can share `/start?agent=<public-address>` before funding. The sponsor
checks that address and chooses the budget. After funding, a sponsor can share
`/start?line=<line-id>` to preselect the line. Loading its onchain state is still
required; the link itself neither grants spending rights nor signs a purchase.

The contract exposes `activeLineId(sponsor, agent)` for a known pair. It does not
provide a list of every sponsor's lines for an agent. Agent-only discovery is
specified in [the proposed discovery interface](AGENT_LINE_DISCOVERY.md), and
is not a live endpoint. Link-based selection works without that service.

## Other generations

- `/funding`: earlier owner-admitted candidate management.
- `/float` and the V2 APIs: earlier integration generation and its tools.
- [Candidate purchase API](CANDIDATE_PURCHASE_API.md): separate single-enrollment
  backend-executor design; not the public `/start` transport.

Do not mix their contract addresses, typed-data schemas, enrollment assumptions,
recovery records or UI status enums.
