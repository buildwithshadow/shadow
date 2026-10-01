# Gateway reserve-funding primitives

`app/scripts/gateway-reserve.mjs` is an experimental operator library for a bounded
Arc testnet, same-chain Gateway withdrawal into a sponsor's own wallet. It is not
wired into the browser, a cross-chain integration, or a mainnet release.

The route is Gateway deposit → attestation → mint to sponsor → existing Shadow
approval/open-line flow. Shadow's contract remains unchanged. Sending USDC directly
to Shadow does not credit a funding line. Calling `openLine` through an intermediary
would make that intermediary the sponsor; this route deliberately avoids that.

The library pins Arc testnet chain ID 5042002 and Gateway domain 26 separately,
limits principal to 0.10 test USDC and the signed Gateway fee to 0.01 test USDC,
requires the same sponsor as depositor, signer, recipient and destination caller,
and excludes hooks and multiple attestations. Gas is separate from the Gateway fee.
Operators must verify live contract code/domain, current fee/expiry estimates,
signatures and transaction calldata before execution. This library is not a wallet
or a transaction broadcaster.

The transfer identity is the keccak256 hash of Circle's packed TransferSpec bytes,
including its magic prefix and hook-data length. It is not the EIP-712 struct hash.
Attestations must contain that exact identity and must not be expired. Deposit and
mint proof uses the original transaction, exact contract event and two agreeing
RPCs with canonical finalized receipts; aggregate balances cannot prove completion.

`runGatewayStep` stores the request before calling its side-effect callback. A
retry with a different request is rejected. If the remote response is lost, it
calls only the supplied read-only reconciler. If the original request cannot be
proved complete it remains unknown. Persist signed transaction bytes/hash before
using this helper, and retain the journal outside the repository. Do not delete
state, change operation IDs, or regenerate salts to retry an unresolved transfer.
The helper's reconciler is trusted operator code: it must return evidence only
after checking the exact intended effect, not a balance or an unrelated active line.
A stale process lock needs operator investigation; it is never stolen automatically.

Circle documents `GET /v1/transferSpec/{hash}` for the specification and
`GET /v1/transfer/{id}` for the transfer record. The former is not a missing
attestation retrieval endpoint. This implementation does not assume POST retries
are idempotent and does not automatically authorize a replacement after ten minutes.

Tests: `node --test app/scripts/gateway-reserve*.test.mjs`.

Sources:
- https://developers.circle.com/gateway/references/technical-guide
- https://developers.circle.com/gateway/references/contract-addresses
- https://developers.circle.com/api-reference/gateway/all/get-transfer-spec
- https://github.com/circlefin/evm-gateway-contracts/blob/master/src/lib/TransferSpec.sol
- https://github.com/circlefin/evm-gateway-contracts/blob/master/src/lib/Attestations.sol
## Browser recovery foundation

`app/scripts/gateway-reserve.mjs` can also be bundled for a browser. Its
protocol checks use Web Crypto and byte arrays, with no Node polyfills. The
operator and future browser controller therefore share the same intent,
attestation, receipt and amount checks.

`gateway-reserve-browser-journal.mjs` adds a browser-profile journal for one
sponsor-owned operation. Call `begin(intent)` once, then pass the returned
operation hash and this journal to `runGatewayStep`. Each attempt is saved
before its side effect. An unknown outcome is reconciled without sending again.
Web Locks prevent two tabs from entering funding actions concurrently; browsers
without that facility refuse to execute. Corrupt or unavailable storage also
blocks execution. Keep site data while an operation is unresolved.

This is a recovery primitive, not a released browser funding flow. It does not
coordinate another device, another origin or other wallet applications. There
is no archive/reset operation yet. The browser controller still needs to verify
phase ordering, fresh wallet identity, exact transaction nonces and canonical
receipts, and to coordinate with Shadow's existing funding journal. It must not
offer a new operation merely because an HTTP request or attestation timed out.

Tests cover lost responses, reloads, concurrent tabs, storage failures and browser
bundling. The purchase end-to-end suite additionally drops a wallet response
after mining and a provider response after producing the paid result. Both
recover the same purchase, with one provider payout and one execution of the
service, then repay and reclaim.
