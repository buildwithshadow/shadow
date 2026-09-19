# Float Mainnet Candidate: Reference Provider Server

A small HTTP server that shows how a provider takes part in a `ShadowFloatMainnet` purchase, and how it recovers a paid request whose answer was interrupted. It is a **reference, not production hosting**: it has no TLS, authentication, rate limiting or monitoring, and it runs as a single process. It is tested end to end on a local anvil chain only. The candidate is not deployed on any network.

The protocol is **Shadow's own convention** for this candidate. It is not x402 or any other payment standard, and no existing seller supports it: a provider has to adopt it. The server uses the provider kit's exported functions (`acceptIntent`, `checkPayment`, `deliverResult`, `validateReceiptFile`) from `app/scripts/float-mainnet-provider.mjs`. Every protocol check is the kit's own. The server adds the store and the HTTP layer, and on `/accept` it repeats the kit's checks that need no chain read (provider, endpoint, price, a signature present) before calling `acceptIntent`, so an intent refused on its face costs no RPC calls. The receipt formats are described in `docs/SHADOW_FLOAT_MAINNET_PARTICIPANT_TOOLS.md` §6. The agent's side is `app/scripts/float-mainnet-request.mjs`.

## How a purchase runs

1. The agent builds and signs an intent (`float-mainnet-intent.mjs`), then sends it to the provider **before payment**, over TLS and to the provider only: `float-mainnet-request.mjs accept`. The provider checks it and signs a `ServiceAcceptance` that binds the request id to the intent's digest.
2. The executor submits the intent (`float-mainnet-submit.mjs submit --execute`). The contract pays the provider and records `receiptStatus[digest] = 2` (paid).
3. The agent runs `float-mainnet-request.mjs fetch` with its acceptance (or its request id). It pays nothing. It reads `receiptStatus` from the contract first, and asks the provider to serve only once the digest is paid. The provider runs its service once for the digest and returns the result with a signed `DeliveryReceipt`.
4. If the answer is lost or fails, `fetch` checks `GET /status/<digest>` and asks again for **the same digest**. The provider answers from its store: the same result and the same receipt, with no new work and no new payment.

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
| `PROVIDER_STORE_DIR` | Where acceptances, results and deliveries are kept, by digest. It needs a filesystem with hard links. |
| `PORT`, `HOST` | Where to listen. The defaults are `8080` and `127.0.0.1`. Put a TLS reverse proxy in front before exposing it. |

On start, the server prints one JSON line on stdout: `listening`, `provider`, `float`, `chainId`, `endpoint`, `endpointHash`, `price` and `store`. If a variable is missing or malformed, the chain or the Float does not check out, the key is invalid or has code, or the port cannot be listened on (in use, for example), it prints one line `{"ok":false,"error":...}` on stderr and exits 1. Error messages redact URLs, so an RPC API key in `ARC_RPC_URL` does not appear in them.

While it runs, the server logs every `500` answer as one JSON line on stderr, `{ request, digest, status, error }`, where `error` is the full error with URLs redacted. The log can hold store paths; the `500` answer names only the digest.

## Endpoints

| Request | Answer |
| --- | --- |
| `POST /accept` with `{ "intent": <signed intent file>, "requestId": "<id>" }` | `200` with the `ServiceAcceptance` file. The same request id always gets the stored acceptance back, even after payment. `409` if the digest is already accepted under another request id. `422` only when the intent is refused: it pays another provider or endpoint, is below the price or is unsigned (checked before any chain read), or `acceptIntent` refuses it (stale, would not pay now, or not signed by the agent). `400` for a malformed request, or an intent file that is malformed or bound to another chain or Float (`413` for a body over 64 KiB). `500` when the provider fails (an RPC, signer or store error): nothing is paid before acceptance, so retry with the same request id. |
| `POST /serve` with `{ "digest": "0x…" }` | `200` with `{ "result": <base64 of the result bytes>, "delivery": <DeliveryReceipt file> }`. `402` with `receiptStatus` while the digest is unpaid or blocked: the service does not run and nothing is signed. `404` if the digest has no acceptance. `500` if the service, the signer, the chain or the store failed, or the stored result is missing or no longer matches its signed delivery; nothing is delivered then, and a later request tries again. |
| `GET /status/<digest>` | `200` with `{ digest, accepted, requestId, paid, receiptStatus, delivered }`. `paid` and `receiptStatus` are the contract's `receiptStatus`; a status request never scans for the `ProviderPaid` log. |

`resultHash` in the receipt is keccak256 of the exact result bytes. `resultRef` is signed as a hash of its UTF-8 bytes. The store holds three files per digest:

- `<digest>.acceptance.json` and `<digest>.delivery.json`, in the same format as the kit CLI's `--store`;
- `<digest>.result.json`, the service's output.

Each file is written to a temporary file and flushed to disk (`fsync`) before it is hard-linked into place, so a stored file is never partial and never replaced. The directory is flushed after the link, so a stored file also survives a power loss, except on Windows: Node cannot open a directory there to flush it, so a file stored just before a power loss may be missing afterwards. Until a delivery is stored, a missing result makes the service run again and a missing delivery is signed again; once a delivery is stored, `/serve` answers `500` until its result is restored. A stored result is signed over only if it is the digest's, for its accepted request; otherwise `/serve` answers `500` before reading the chain. A missing acceptance is signed again only before payment, for whichever request id is sent first; after payment, `/serve` answers `404` for the digest.

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

`accept` keeps the acceptance only if the provider the intent pays signed it, only if it is for the intent's digest, endpoint and principal and for the request id that was sent, and only if its `acceptedAt` is not after the latest block. A `5xx` answer is retryable: nothing is paid before acceptance, so run `accept` again with the same `--request-id`. A `409` means another request id was accepted first for this digest: if that request id is not yours, do not submit the intent, and cancel its nonce (`float-mainnet-cancel-nonce.mjs`).

`fetch` needs no key, and it needs `--acceptance` or `--request-id`: it keeps a delivery only for the agent's own request. It writes the result only after checking the receipt:

- the paid provider signed it;
- it is for this digest and for the agent's request: the acceptance's, or `--request-id` (with both, they must name the same request);
- its `resultHash` is keccak256 of the returned bytes, and its `resultRef` matches the signed hash;
- when the digest's `ProviderPaid` event is found, its `deliveredAt` is not before the payment block, and the acceptance's `acceptedAt` is not after it. The evidence verifier refuses either.

An answer over 16 MiB is refused without being read to its end. `--out` is written to a temporary file beside it and renamed into place, so it holds either its old content or the whole result.

`fetch` prints `{ok, digest, delivery, resultHash, attempts, out}`. Save its `delivery` as the receipt file the evidence exporter takes with `--delivery`. With `--digest` instead of `--intent`, it identifies the paid provider from the acceptance, or else from the digest's `ProviderPaid` event.

## Guarantees

- **Serves only paid digests.** The contract's `receiptStatus` is authoritative. `deliverResult` also compares the `ProviderPaid` event, when it is found, with the acceptance's provider and principal.
- **One acceptance per digest, for the first request id.** The first request id accepted for a digest is the only one ever answered for it; another is refused with `409`. The first is whoever sent the signed intent first: anyone holding the intent file can send it under a request id of their own. Send the intent only to the provider, over TLS, and treat an unexpected `409` as described above.
- **One result and one receipt per digest.** The service's output is stored before a receipt is signed over it. Every later `/serve` for the digest returns that stored result and receipt: after a lost answer, a retry, concurrent requests or a restart. If signing fails, the stored result is signed on the next request and the service does not run again.
- **No payment from recovery.** `fetch` never signs or sends a transaction. A retry asks for the same digest, which is already paid.

## Limits

- **Debt stays even if delivery fails.** The payment happens when the executor submits the intent, so the agent's line owes the principal whether or not the service is delivered. Nothing here refunds, escrows or cancels debt, and a payment with unresolved delivery does not count as a completed service cycle. Explain this to participants before purchase.
- **A receipt is the provider's statement.** It says that this provider served this request with this result. It proves nothing about the result's quality.
- **Results are readable by anyone who knows the digest.** `/serve` and `/status` take only a digest, and a paid digest is public in its `ProviderPaid` event. Anyone can read a paid digest's result and receipt, and `/status` reports the accepted request id. Do not serve results that must stay private this way. The fix would be a request signed by the agent on `/serve`, which this reference does not implement.
- **A paid digest that was never accepted cannot be served.** `/serve` answers `404`: the provider holds no request for it. Take the digest and its payment to the provider.
- **Exactly once holds per stored result.** If the process stops after the service finished but before its result was stored, or storing it fails (a full disk, for example), the next `/serve` runs the service again. A service with side effects should itself de-duplicate by digest.
- **One server process per store directory.** Concurrent requests are de-duplicated within one process. Two processes sharing a store never store two results or receipts for a digest, but both may run the service.
- **Retention is yours.** Results and receipts are kept indefinitely. Removing them breaks recovery for their digests.
- **Sizes.** Request bodies are limited to 64 KiB. `fetch` reads answers of up to 16 MiB, so a result is limited to about 12 MiB (base64).
