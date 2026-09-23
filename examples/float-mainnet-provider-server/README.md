# Float Mainnet Candidate: Reference Provider Server

A small HTTP server that shows how a provider takes part in a `ShadowFloatMainnet` purchase, and how it recovers a paid request whose answer was interrupted. It is a **reference, not production hosting**: it has no TLS, authentication, rate limiting or monitoring, and it runs as a single process. It is tested end to end on a local anvil chain only. The candidate is not deployed on any network.

The protocol is **Shadow's own convention** for this candidate. It is not x402 or any other payment standard, and no existing seller supports it: a provider has to adopt it. The server uses the provider kit's exported functions (`acceptIntent`, `checkPayment`, `deliverResult`, `validateReceiptFile`, `storeOnce`) from `app/scripts/float-mainnet-provider.mjs`. Every protocol check is the kit's own, including the fresh payment check that gates every `/serve`, even when its result and delivery are already stored. The server adds the HTTP layer and the store's layout, and on `/accept` it repeats the kit's checks that need no chain read (provider, endpoint, price, a signature present) before calling `acceptIntent`, so an intent refused on its face costs no RPC calls. The receipt formats are described in `docs/SHADOW_FLOAT_MAINNET_PARTICIPANT_TOOLS.md` §6. The agent's side is `app/scripts/float-mainnet-request.mjs`.

## How a purchase runs

1. The agent builds and signs an intent (`float-mainnet-intent.mjs`), then sends it to the provider **before payment**, over TLS and to the provider only: `float-mainnet-request.mjs accept`. The provider checks it and signs a `ServiceAcceptance` that binds the request id to the intent's digest.
2. The executor submits the intent (`float-mainnet-submit.mjs submit --execute`). The contract pays the provider and records `receiptStatus[digest] = 2` (paid).
3. The agent runs `float-mainnet-request.mjs fetch` with its acceptance (or its request id). It pays nothing. It reads `receiptStatus` from the contract first, and asks the provider to serve only once the digest is paid. The provider runs its service once for the digest and returns the result with a signed `DeliveryReceipt`.
4. If the answer is lost, `fetch` checks `GET /status/<digest>` and asks again for **the same digest**. A failed status poll does not prevent the serve retry. Once the result is stored, the provider answers with the same result and receipt, with no new work or payment. If work started but no result was stored, the provider stops automatic service retries for operator reconciliation.

## Run it

The server loads the kit and the app's `viem` by relative path, so run it from a repository checkout with the app installed (`cd app && pnpm install --frozen-lockfile --ignore-workspace`). The Node versions match the participant tools: Node 20.12 or later. On Windows, use Node 22, or 24.20.0 or later.

```bash
export ARC_RPC_URL=https://rpc.testnet.arc.io
export FLOAT_MAINNET_EXPECTED_CHAIN_ID=5042002
export FLOAT_PROVIDER_PRIVATE_KEY=...                     # read at start, never printed
export PROVIDER_ENDPOINT="https://provider.example/api/ask"
export PROVIDER_PRICE=1000000                             # atomic USDC: 1 USDC
export PROVIDER_STORE_DIR=/var/lib/shadow-provider
export PORT=8080
node examples/float-mainnet-provider-server/server.mjs --manifest $M
```

| Variable | Meaning |
| --- | --- |
| `ARC_RPC_URL`, `FLOAT_MAINNET_EXPECTED_CHAIN_ID` | The chain, as for every participant tool. |
| `--manifest <path>` or `FLOAT_MAINNET_ADDRESS` | The Float. A manifest is used only if it passed and its runtime code hash matches the chain. It also gives payment lookups a lower bound. |
| `FLOAT_PROVIDER_PRIVATE_KEY` | The provider's EOA key. It is removed from the environment as soon as the wallet is created, before `service.mjs` is loaded, so the service and any process it starts do not inherit it. The server refuses a key whose address has code: see "ERC-1271 providers" below. |
| `PROVIDER_ENDPOINT` | The exact endpoint string the sponsor approved for this provider. It is hashed as UTF-8 and compared with the intent's `endpointHash`. |
| `PROVIDER_PRICE` | The lowest principal accepted, in atomic USDC. |
| `PROVIDER_STORE_DIR` | Where request bindings, service starts, acceptances, results and deliveries are kept. It needs a filesystem with hard links. |
| `PORT`, `HOST` | Where to listen. The defaults are `8080` and `127.0.0.1`. Put a TLS reverse proxy in front before exposing it. |

On start, the server prints one JSON line on stdout: `listening`, `provider`, `float`, `chainId`, `endpoint`, `endpointHash`, `price` and `store`. If a variable is missing or malformed, the chain or the Float does not check out, the key is invalid or has code, or the port cannot be listened on (in use, for example), it prints one line `{"ok":false,"error":...}` on stderr and exits 1. Error messages redact URLs, so an RPC API key in `ARC_RPC_URL` does not appear in them.

While it runs, the server logs every `500` answer as one JSON line on stderr, `{ request, digest, status, error }`, where `error` is the full error with URLs redacted. The log can hold store paths; the `500` answer names only the digest.

## Endpoints

| Request | Answer |
| --- | --- |
| `POST /accept` with `{ "intent": <signed intent file>, "requestId": "<id>" }` | `200` with the `ServiceAcceptance` file. The same digest and request id gets its stored acceptance back, even after payment. `409` if the digest is already accepted under another request id, or that request id is bound to another digest. `422` only when the intent is refused: it pays another provider or endpoint, is below the price or is unsigned (checked before any chain read), or `acceptIntent` refuses it (stale, would not pay now, or not signed by the agent). A request answered from the store, or joined to a concurrent one, is refused with `422` unless its own intent file carries the agent's valid signature. `400` for a malformed request, or an intent file that is malformed or bound to another chain or Float (`413` for a body over 64 KiB). `500` when the provider fails (an RPC, signer or store error): nothing is paid before acceptance, so retry with the same digest and request id. |
| `POST /serve` with `{ "digest": "0x…" }` | `200` with `{ "result": <base64 of the result bytes>, "delivery": <DeliveryReceipt file> }`. `402` with `receiptStatus` while the digest is unpaid or blocked: the service does not run and nothing is signed. `404` if the digest has no acceptance. `409` if service work started but no result was stored: the provider must reconcile the outcome before any new work. `500` if the service, signer, chain or store failed, or stored records disagree; no result is delivered then. |
| `GET /status/<digest>` | `200` with `{ digest, accepted, requestId, paid, receiptStatus, delivered }`. `paid` and `receiptStatus` are the contract's `receiptStatus`; a status request never scans for the `ProviderPaid` log. `500` if the stored acceptance is not this provider's for the digest. |

`resultHash` in the receipt is keccak256 of the exact result bytes. `resultRef` is signed as a hash of its UTF-8 bytes. The store holds a durable request-id binding and four files per served digest:

- `request-<keccak256 of requestId>.json` binds a provider job id to the first accepted digest;
- `<digest>.acceptance.json` and `<digest>.delivery.json`, in the same format as the kit CLI's `--store`;
- `<digest>.started.json` records that service work may have begun;
- `<digest>.result.json`, the service's output.

Each file is written to a temporary file and flushed to disk (`fsync`) before it is hard-linked into place, so a stored file is never partial and never replaced. The directory is flushed after the link, so a stored file also survives a power loss, except on Windows: Node cannot open a directory there to flush it, so a file stored just before a power loss may be missing afterwards. The request binding is installed before acceptance is stored. If the server stops between those writes, retry the **same signed intent and request id**; a new digest for that id remains refused until the provider reconciles the reservation. Concurrent intents for the same request id cannot both be accepted by this server. The start marker is installed before calling the service. A service or result-store failure after that point returns `500` with an explicit unknown-outcome message; later `/serve` calls return `409` until the provider reconciles it, without invoking the service again. The provider must inspect its external job and restore a verified result or deliberately authorize a retry. A missing delivery is signed again from a stored result. Once a delivery is stored, `/serve` answers `500` until its result is restored. A stored marker or result that disagrees with the acceptance is refused before any new work. A missing acceptance is signed again only before payment, for whichever request id is sent first; after payment, `/serve` answers `404` for the digest.

On `/accept`, an ERC-1271 account that returns a non-magic result or actually reverts rejects the signature (`422`). A failed account-code lookup or unavailable signature-check RPC is retryable (`500`), including when the acceptance is already stored. Retry with the same signed intent and request id.

A stored receipt is checked for shape, provider and digest when it is read. Its signature was verified when it was signed and is not checked again, so a provider whose ERC-1271 account rotates its signer still serves what it stored. Whether that receipt still verifies is decided by `fetch` and the evidence verifier, which check signatures at the block they read.

## Plugging in your service

Replace `service.mjs`. The server calls its default export once per paid digest, after the contract records the payment:

```js
export default async function service({ digest, requestId, acceptance }) {
  // look up the request by requestId, do the work, keep the result
  return { result: "<string or Uint8Array>", resultRef: "<where you keep it, optional>" };
}
```

The protocol identifies a request by its **request id**, and the acceptance binds that id to the digest. Request content is not part of the protocol. A provider that already has a job API, CitePay for example, can use its own job id:

1. The agent submits its query through the provider's existing API, unpaid, and receives job id `J`.
2. The agent sends its signed intent with `requestId: J` to `/accept`.
3. After payment, the provider's `service` runs job `J` and returns its answer.

Agree on this with the provider before the first pilot purchase, together with who investigates a delivery that stays unresolved and what remedy the provider actually offers (roadmap, "Independent pilot evidence and provider recovery").

Do not put secrets in `resultRef`: it goes into the signed receipt and into the evidence bundle.

**ERC-1271 providers.** A provider address with code has its receipts checked with ERC-1271. Import `createProviderServer` from `server.mjs` and pass a custom account `{ address, signTypedData }` that signs with the account's signer. The kit's checks still run. After the account rotates its signer, a digest accepted before the rotation and not yet delivered cannot be delivered: `deliverResult` checks the acceptance's signature at the latest block.

## The agent's side

```bash
node app/scripts/float-mainnet-request.mjs accept --provider-url https://provider.example \
  --intent intent.json --request-id J --out acceptance.json --manifest $M
FLOAT_EXECUTOR_PRIVATE_KEY=... node app/scripts/float-mainnet-submit.mjs submit --intent intent.json --execute --manifest $M
node app/scripts/float-mainnet-request.mjs fetch --provider-url https://provider.example \
  --intent intent.json --acceptance acceptance.json --out result.bin --manifest $M
```

The client refuses HTTP redirects, so a signed intent cannot be forwarded to another origin. Configure the final provider URL directly.

`accept` keeps the acceptance only if the provider the intent pays signed it, only if it is for the intent's digest, endpoint and principal and for the request id that was sent, and only if its `acceptedAt` is not after the latest block. A `5xx` answer is retryable: nothing is paid before acceptance, so run `accept` again with the same intent and `--request-id`. A `409` means this digest already has another request id, or this request id already has another digest. Do not submit the refused intent; inspect the earlier acceptance and payment, then cancel its unused nonce (`float-mainnet-cancel-nonce.mjs`) if appropriate.

`fetch` needs no key, and it needs `--acceptance` or `--request-id`: it keeps a delivery only for the agent's own request. It writes the result only after checking the receipt:

- the paid provider signed it;
- it is for this digest and for the agent's request: the acceptance's, or `--request-id` (with both, they must name the same request);
- its `resultHash` is keccak256 of the returned bytes, and its `resultRef` matches the signed hash;
- when the digest's `ProviderPaid` event is found, its `deliveredAt` is not before the payment block, and the acceptance's `acceptedAt` is not after it. The evidence verifier refuses either.

An answer over 16 MiB is refused without being read to its end. `--out` is written to a temporary file beside it and renamed into place, so it holds either its old content or the whole result.

`fetch` prints `{ok, digest, delivery, resultHash, attempts, out}`. Save its `delivery` as the receipt file the evidence exporter takes with `--delivery`. With `--digest` instead of `--intent`, it identifies the paid provider from the acceptance, or else from the digest's `ProviderPaid` event.

## Guarantees

- **Serves only paid digests.** The contract's `receiptStatus` is authoritative and is rechecked before returning a stored result, so a payment removed by a reorg cannot be bypassed through the cache. `deliverResult` also compares the `ProviderPaid` event, when it is found, with the acceptance's provider and principal.
- **One reserved digest per provider request id.** The first valid intent to reserve a request id durably binds its digest; a fresh signed intent for the same id is refused with `409`, including after a restart. The first request id accepted for a digest is also the only one answered for it. The first is whoever sent the signed intent first: anyone holding the intent file can send it under a request id of their own. Send the intent only to the provider, over TLS, and treat an unexpected `409` as described above.
- **Stored work is not replayed automatically.** The service's start marker is durable before invocation, and its output is stored before a receipt is signed over it. When a result and delivery are stored, later `/serve` calls return them after a lost answer, concurrent requests or a restart. If the marker exists without a result, the first failed call reports the uncertain outcome and later requests stop for reconciliation. If only signing fails, the stored result is signed on the next request and the service does not run again.
- **No payment from recovery.** `fetch` never signs or sends a transaction. A retry asks for the same digest, which is already paid.

## Limits

- **Debt stays even if delivery fails.** The payment happens when the executor submits the intent, so the agent's line owes the principal whether or not the service is delivered. Nothing here refunds, escrows or cancels debt, and a payment with unresolved delivery does not count as a completed service cycle. Explain this to participants before purchase.
- **A receipt is the provider's statement.** It says that this provider served this request with this result. It proves nothing about the result's quality.
- **Results are readable by anyone who knows the digest.** `/serve` and `/status` take only a digest, and a paid digest is public in its `ProviderPaid` event. Anyone can read a paid digest's result and receipt, and `/status` reports the accepted request id. Do not serve results that must stay private this way. The fix would be a request signed by the agent on `/serve`, which this reference does not implement.
- **A paid digest that was never accepted cannot be served.** `/serve` answers `404`: the provider holds no request for it. Take the digest and its payment to the provider.
- **The server cannot guarantee exactly once external work.** A marker with no result may mean the service never started, is still running elsewhere, or finished an external side effect before a crash. It stops automatic replay and requires provider reconciliation. The actual service should also de-duplicate by its own job id and record its result durably.
- **The acceptance gate is provider-side.** A caller can submit a fresh signed intent directly to the contract without asking `/accept`, so the request-id binding does not prevent every duplicate charge. A different request id for the same underlying job is not detected. Use stable provider-issued job ids and do not execute an intent without the matching acceptance.
- **Store ownership and retention.** Run one server process per store directory and keep its files indefinitely. The atomic binding and start marker prevent simultaneous service starts for the same digest across processes, but one process per store remains the supported operation. Removing a marker or result breaks recovery. Before reusing a store written by an older server, reconcile its acceptance files and request ids; older acceptances have no request binding.
- **Sizes.** Request bodies are limited to 64 KiB. `fetch` reads answers of up to 16 MiB, so a result is limited to about 12 MiB (base64).
