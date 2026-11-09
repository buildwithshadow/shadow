# Provider Worker runtime

This package runs the repository's provider HTTP server inside an identity bound Durable Object, using the immutable record store and a separately deployed publication witness. It currently supports recovery of retained records only. New acceptance is deliberately unavailable until the prepared report, signer and monitor are composed and verified.

The public edge validates the platform supplied client address, strips forwarding headers, bounds request targets and headers, and preserves the existing HTTP server body and concurrency limits. CORS permits the existing Shadow website. No maintenance action is reachable through the public HTTP handler. Operator tooling must bind `ProviderAdmin` separately, never through a public proxy.

## Verification and retained records

Operator configuration supplies `DEPLOYMENT`, `PROVIDER`, `CHAIN_ID`, `CONTRACT`, `ENDPOINT_HASH`, `PRICE`, `MANIFEST_JSON` and its independently approved `MANIFEST_APPROVED_SHA256`. Missing configuration holds the provider. `RPC_WSS_URL` is a secret binding, never part of the manifest or an HTTP response. Only TLS WebSocket endpoints are accepted. Manifest bytes and configured contract must match before external I/O. The existing `connectCandidate` verifies the chain, contract runtime hash and domain constants using the bounded readonly transport. Failure closes the transport and leaves the provider held.

The approved manifest scratch file is immutable and request local. It does not store receipts or monitoring state. All provider records remain in the maintained durable store, and original signed bytes are returned without generating replacement signatures. Import and repair require an operator supplied inventory fingerprint and a quiesced, drained coordinator. Maintenance state and bounded per-route caller quotas survive coordinator eviction and idle connection retirement. Caller keys are salted hashes; the existing per-route window, quota bound and overflow eviction policy remain in the provider server. Missing identity or witness state never triggers automatic empty initialization.

`wrangler.jsonc` has no identity, credentials, approved manifest or public route. It holds by default. It binds the witness from the separate script configured in `wrangler.witness.jsonc`; same script witness bindings exist only in local test configuration. Deploying these configurations is not clearance to switch live traffic.

## Local checks

Install the existing app dependencies with `pnpm --dir ../../app install --frozen-lockfile --ignore-scripts`, then run `npm ci` and `npm run check` in this package. Tests use local workerd, synthetic chain responses and placeholder signatures. They verify refusal, unchanged retained bytes, witness holds, caller identity, CORS, bounded requests, maintenance across eviction, and manifest approval. They send no live transactions and do not establish a completed production migration.

## Optional guarded mainnet staging entrypoint

`active-worker.ts` and `wrangler.active.jsonc` are a separate opt-in mainnet staging composition. The default recovery entrypoint does not install a signing source, even if active mode or provider key variables are supplied. The checked in active configuration has no identity, approved policy, signing secret or public route and cannot accept a purchase.

The active entrypoint requires the existing verified deployment connection and durable store, `PROVIDER_MODE=guarded-active`, a provider signing secret matching the configured provider, locally approved monitor manifest/baseline/history bytes, a private `MONITOR_READ` service binding and two distinct configured wallet report RPC sources. Only the address and typed data signing function reach the existing provider server. There is no wallet client or transaction sender. The server retains its original prepared report, signature, payment receipt and duplicate recovery semantics.

Missing signing configuration or a failed signing-source setup selects recovery mode. An installed monitor guard is mandatory for new acceptance and still refuses unhealthy or changed observations. It does not gate recovery of an already paid stored result. No public request can install a signer, change the service, toggle recovery mode or supply a monitor approval. Store maintenance, witness checks, caller quotas and idle resource cleanup remain in the shared coordinator.

This configuration is not cutover clearance. Its positive staging purchase, lost confirmation recovery, restart, prepared report expiry, resource measurements and live hostname checks still need completion. It composes only the current mainnet report service; earlier identities and testnet services require their own explicitly verified migration configuration.
