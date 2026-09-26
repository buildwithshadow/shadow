# Candidate purchase API (Arc testnet)

This service connects a participant interface to the candidate `SpendIntent`
workflow. It does not use the older V2 `FloatSpendIntent` API. It prepares an
intent, verifies the agent's signature, obtains the provider's signed acceptance,
executes through a durable monitored session, and retrieves the provider's result.

The service is **testnet only** (`5042002`). These instructions describe a
self-hosted service; they do not announce an available public endpoint. It is a
single enrollment: one sponsor, agent, executor, provider, endpoint and fixed
price. It requires an already-funded line and an approved execution session.
Funding, repayment and reclaim remain separate wallet actions.

## Participant interface contract

All requests except CORS preflight require
`Authorization: Bearer <enrollment-token>`. POST requests use
`Content-Type: application/json`. Obtain an enrollment-specific random token
privately; never bundle one in frontend assets, put it in a URL, log it, or store
it in browser local storage. Keep it in memory for the session. The token grants
access to this enrollment's records, not permission to sign for its agent.

| Request | Body | Result |
| --- | --- | --- |
| `GET /v1/catalog` | — | Fixed chain, candidate, participants, provider, endpoint hash, price and session cap |
| `POST /v1/purchases` | `{"requestId":"provider-job-123"}` | Stable purchase ID and unsigned candidate intent |
| `POST /v1/purchases/{id}/submit` | `{"signature":"0x…"}` | Original payment status; submission attempted at most once by this service |
| `GET /v1/purchases/{id}` | — | Fresh reconciliation of an attempted payment; no transaction |
| `POST /v1/purchases/{id}/recover` | `{}` | Same paid provider result and signed delivery receipt; no transaction |

`requestId` must be the stable job identifier agreed with the provider (1–128
letters, numbers, `.`, `_`, `:`, `-`, starting with a letter or number). Retain it
across page refreshes and network retries. Never generate a new identifier merely
because confirmation was interrupted. Repeating it returns the same purchase and
nonce, including after process restart. Different job IDs are different purchases;
the service cannot infer that differently named jobs are semantically identical.
The provider must follow the candidate acceptance/delivery protocol.

Successful responses have `ok: true`. Purchase responses include:

```json
{
  "ok": true,
  "id": "32-lowercase-hex-characters",
  "requestId": "provider-job-123",
  "digest": "0x…",
  "intent": {
    "kind": "ShadowFloatMainnet.SpendIntent",
    "chainId": "5042002",
    "verifyingContract": "0x…",
    "typedData": {},
    "externalSignerTypedData": "JSON string of the exact signing payload"
  },
  "payment": "not_submitted",
  "delivery": "not_requested",
  "attempted": false
}
```

The actual `intent` contains the full candidate schema and digest. Sign its exact
`externalSignerTypedData` with the configured agent (EOA or ERC-1271 wallet),
using the existing wallet's signing adapter. Show network, sponsor, provider,
principal, maximum debt, due time and executor before requesting the signature.
The payload uses decimal strings; do not round or rebuild it from displayed
amounts. The server verifies it onchain and binds the result to the stored intent.
A passkey signature is a wallet authorization; the server subsequently sends the
payment transaction. The returned intent never includes the submitted signature.

Payment states are `not_submitted`, `unknown`, `paid`, `blocked`, or `reverted`.
`transactionHash` and `observedAt` appear when available. A `paid` response is not
yet a delivered service: call `recover` to retrieve it. Delivery states are
`not_requested`, `pending`, and `available`.

Pending transaction hashes remain visible during reconciliation; their presence
does not mean payment is confirmed or authorize a resend. Once recovery succeeds,
the verified result and signed delivery receipt are persisted before availability
is reported. Later recovery serves that saved copy after fresh payment checks,
including after a service restart or provider outage.

The recovered `result` contains `encoding: "base64"`, exact `bytes`, `resultHash`
and a verified signed `delivery` receipt. Treat result content as untrusted data;
do not inject it as HTML. The reference provider serves results by digest, so use
non-confidential jobs until the provider adds access controls.

## Failure and retry behavior

Errors have `ok: false` and an `error` code. Raw RPC errors, paths, signatures and
credentials are withheld.

| HTTP/code | Interface action |
| --- | --- |
| 400 `invalid_request`, `invalid_request_id`, `invalid_signature`, `invalid_json` | Correct input without creating a replacement job |
| 401 `unauthorized` / 403 `origin_not_allowed` | Check enrollment access and allowed origin |
| 409 `original_payment_unresolved` | Poll the original purchase; no replacement purchase or new signature |
| 409 `payment_not_confirmed` | Reconcile before asking for delivery |
| 409 `enrollment_capacity_reached` | Ask the operator to inspect the enrollment; do not reset stores |
| 429 `busy_retry_later` | Back off using the same ID; do not poll faster than every few seconds |
| 503 `operation_unavailable` | Preserve the ID; check its status and have the operator inspect the failing stage |
| 503 `reconciliation_required` | Hold; operator must reconcile the original chain/session outcome |

A lost HTTP response can follow a successful payment. Resume with `GET` or repeat
`submit` for **the same purchase**: after the permanent attempt marker the latter
only reconciles. The marker is written before invoking the executor, so a crash
before broadcast may also hold an unsent purchase. This deliberately requires
operator investigation; it never guesses that a timeout means “unpaid.”

Provider acceptance is verified before any send. Signature, acceptance or known
monitor failures before the attempt marker can be retried for the same purchase.
Expired intents are not automatically renewed. Uncertain submissions hold other
purchases, including already-prepared ones. Paid-but-undelivered purchases retain
their debt; result recovery does not automatically refund or repay it.

## Operator setup

Use a persistent Node process, private durable volume, TLS reverse proxy and
single writer. Do not put the store on ephemeral serverless storage or start
multiple replicas. Back up the purchase store, execution ledger and provider
store together. Never log Authorization headers or request bodies at the proxy.
The standalone service defaults to loopback; the managed-host entrypoint below explicitly opts into managed ingress.

1. Verify the testnet deployment manifest, owner-approved baseline, named
   executor and sponsor/agent/provider policy. Fund the bounded line separately.
2. Initialize its execution ledger explicitly with `float-mainnet-submit.mjs
   init-session`. Run the monitor continuously against the approved baseline.
   Missing, stale, mismatched or held monitoring blocks payment.
3. Create a private config (paths resolve relative to it):

```json
{
  "schemaVersion": 1,
  "session": "session.json",
  "manifest": "manifest.json",
  "monitorBaseline": "baseline.json",
  "monitorStateDir": "monitor-state",
  "storeDir": "purchase-store",
  "providerUrl": "https://provider.example",
  "serviceName": "Provider answer",
  "principal": "50000",
  "origins": ["https://your-participant-app.example"]
}
```

4. Initialize once, then run with private environment variables `ARC_RPC_URL`,
   `FLOAT_EXECUTOR_PRIVATE_KEY` and `SHADOW_PURCHASE_TOKEN`. The executor key must
   match the policy. Generate at least 32 random bytes for the token and encode
   as base64url. Pass secrets through the runtime secret facility, not CLI flags.

```sh
node app/scripts/float-mainnet-purchase-server.mjs init --config /private/purchase.json
node app/scripts/float-mainnet-purchase-server.mjs serve --config /private/purchase.json --port 8788
```

The service pins config, session, manifest and baseline contents. Changing them
stops operations and prevents reopening the same store under different settings.
Monitor heartbeat/state can advance normally. The store caps enrollments at 64
job records, with a global burst of 30 requests refilling at one request per two
seconds and at most eight in flight. Restrict access further at the reverse proxy.

Only fixed tool arguments are executed; client requests cannot select a provider
URL, RPC, shell command, price, party or destination. The executor key reaches only
the submit subprocess. Direct testnet submissions from this service use
`--require-monitor` to recheck monitoring immediately before broadcast.

An unclean process death leaves `.service-lock` (and possibly execution `.lock`).
Stop all writers, preserve all files, and reconcile the recorded digest/hash and
canonical chain history before removing a stale lock. Never delete ledgers,
clear attempt markers, restore an older budget snapshot, or create a replacement
session to escape an uncertain outcome. If an original attempt never broadcast,
manual evidence and an explicit operator decision are needed before any new job.

This is local operational protection, not a global onchain budget: another
executor/session or direct contract caller can bypass the service. The onchain
intent nonce/digest and policy checks still apply. It is not an independent
security audit, production hosting or a mainnet launch.

## Validation

```sh
forge build --root contracts
node --test --test-concurrency=1 app/scripts/float-mainnet-purchase*.test.mjs
npm run float:mainnet:all-tools:test
```

The HTTP/Anvil test executes real signatures, provider acceptance, a USDC payment,
debt accounting and result delivery. It loses the payment acknowledgement,
restarts the service, retries, and checks one provider credit, one ledger entry,
one service job and no second executor transaction. It also checks invalid
signatures, stale monitoring, gross-budget exhaustion and configuration changes.
Pending-ledger observations preserve their transaction hash without passing the
submission-eligibility check. Saved results and delivery receipts remain usable
with the provider offline, and corrupt cached bytes are refused.
All test keys are public deterministic Anvil fixtures; no live funds are used.

## Managed Node hosting

`deploy/candidate-api/render.yaml` is an optional, unprovisioned paid-service
blueprint. Confirm the account, current compute/disk price and persistent mount
before creating it. Deploy a reviewed commit manually; auto-deploys and replicas
are disabled. No private configuration, signer or token belongs in the blueprint.

Provision the enrollment files and explicitly initialized stores under
`/var/data/shadow` using the operator steps above. Preserve stable paths across
releases because configuration bindings include resolved paths. Do not move a
previously used enrollment to a new path or recreate its store: stop and reconcile
before planning a state migration. The first hosted enrollment should be initialized
at its final paths. Do not import an older backup to reset spent capacity.

The hosting entrypoint refuses absent paths or symlinks escaping the declared
persistent root. This validates path containment, not the host's disk durability;
verify the actual mount in the provider before use. It launches the API and monitor
in one instance, strips executor credentials from the monitor environment, and
stops both if either exits. It never initializes state or clears a hold/lock at boot.
A crash can require manual reconciliation before the platform's restart succeeds.

```sh
node app/scripts/float-mainnet-purchase-host.mjs \
  --config /var/data/shadow/purchase.json \
  --persistent-root /var/data/shadow --port 8788
```

The hosting entrypoint explicitly binds the API to `0.0.0.0` for managed TLS
ingress. The standalone server still defaults to loopback; `--host 0.0.0.0` is
an explicit opt-in. All purchase routes retain bearer authentication and origin
checks. Use TCP platform health checks (no anonymous HTTP health route), then
verify authenticated catalog/status separately. A listening port proves process
liveness, not a healthy monitor or readiness to spend. Never embed the shared
enrollment token in a public JavaScript bundle.

The host allows 240 seconds for child shutdown, then kills remaining process
groups. Configure the platform termination window to at least 300 seconds. Stop
new jobs and allow active work to finish before planned deployments. An interrupted
send still requires canonical reconciliation; a forced shutdown never authorizes
resending. Test restart and provider-outage recovery before admitting participants.
Attach the chosen API domain only after provider-URL, TLS and authenticated-route
checks pass. Preserve the existing frontend hostname and other DNS records.

Candidate public clients now use the paced read-only RPC transport even in tools
that also submit transactions. Wallet broadcasts use a separate transport with
retries disabled. Log scans still split only explicit range/result-size errors;
quota exhaustion fails the scan instead of reporting partial history as complete.
