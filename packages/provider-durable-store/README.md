# Provider durable storage

Immutable provider records on SQLite Durable Objects, with a separate digest witness, bounded capacity reservations and explicit operator reconciliation.

The provider JSON adapter must retain its original serialized bytes. Publication records a witness before committing a record. Missing identity, changed bytes, interrupted publication and rollback discrepancies hold the store until an operator reconciles them against an approved inventory. A delivered or released purchase cannot reserve capacity again.

`src/index.ts` exports the runtime neutral ledger and client APIs. `src/worker.ts` exports storage and operator service entrypoints; its public HTTP handler always returns 404. Only trusted service bindings may receive these capabilities. Never bind the operator entrypoint into a public request handler. Bootstrap needs an inventory fingerprint approved outside the provider and requires the real provider to be quiesced and drained. Reconciliation of outstanding work also requires its remaining capacity reservation. Pass an operator approved `perDigest` envelope if the reservation was lost, and the original `budgetDigest` attribution when restoring a request alias. Without that policy the missing outstanding record stays held. Existing records are counted separately, so an operator must size the remaining envelope conservatively; an envelope that does not fit is refused.

Production must put the witness in a separate Worker script with independent migrations and restore operations. The test configuration deliberately keeps both namespaces local. It is not a production deployment configuration. No production identity, credential, route or signer is included.

The admission coordinator under `test/` is a model using counters instead of signing or paying. It is not exported by the production module. The tests establish storage behavior, not payment service readiness, platform quotas or an independent security audit.

## Verify

Use Node 24 or later.

```sh
npm ci
npm run check
```

The check generates Cloudflare bindings from the local fixture configuration, typechecks, runs Node SQLite simulations and runs the Durable Object tests in local workerd. Nothing is deployed and no network or wallet is needed.

Built with assistance from Arc Studio, then independently tested and integrated into Shadow.
