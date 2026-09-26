# Cloudflare Pages migration

Current live URL: `https://shadow-arc.vercel.app/`. The production hostname for
the migration is undecided. `shadow.dolepee.com` was an earlier proposal; a
dedicated Shadow domain is also being considered. Confirm the destination before
configuring origins, canonical URLs or DNS.

Pages serves the Vite build and runs the
existing APIs through `app/functions/api/[[path]].ts`. The adapter preserves
query arrays, JSON/raw bodies, response status, payment headers, and the `/api/desk`
rewrite. Unknown APIs return JSON 404. It reuses the existing API implementations.
Node compatibility populates `process.env` from deployed bindings; no
request mutates global environment settings.
State-cache refreshes use the Pages request context's `waitUntil` so they survive
the response. Runtimes without that hook await the same best-effort write, with a
two-second network timeout.

This is migration infrastructure, not a completed deployment. It does not deploy
contracts, fund accounts, provision Circle wallets, or establish mainnet readiness.

## Local validation

Use Node 24, pnpm 10 and Wrangler 4.136.1. The older globally installed Wrangler
may not support the configured compatibility date.

```sh
pnpm --dir app install --frozen-lockfile --ignore-workspace
node --test app/scripts/cloudflare-adapter.test.ts app/scripts/cloudflare-state-cache.test.ts
pnpm --dir app typecheck
pnpm --dir app build
cd app
npx --yes wrangler@4.136.1 pages functions build --outdir .wrangler/pages-build
node scripts/cloudflare-runtime.test.mjs
```

The runtime smoke test binds port 8795, uses no credentials, checks methods that
cannot perform payments, and stops only its own process group. Run it from a clean
checkout without `.env` or `.dev.vars` files. It does not prove production API data,
wallet, payment, or storage parity.

## Configuration and release gates

1. Confirm the destination hostname, exact reviewed source commit and a successful
   production build.
2. Inventory deployed variable **names**, Circle origin restrictions and required
   backend capabilities. Never print environment values. Frontend `VITE_*` settings
   are build-time inputs, not automatically supplied by Pages runtime bindings.
3. Configure approved public addresses/settings and required server secrets through
   the platform secret store. Never commit or bulk-export wallet keys as part of a
   general environment copy. Explicitly decide whether the legacy demo-funding,
   slippage-publication and private-key x402 facilitator are being migrated. Without
   these decisions, leave the current public deployment and DNS intact.
4. Build with the verified frontend configuration and deploy a Pages preview. Check
   all read-only APIs against the old deployment, including data provenance and
   degraded/empty-history labels. Test stateful requests only with specifically
   authorized test credentials and amounts. Unit tests are not live parity.
5. Test wallet onboarding on the actual hostname. Preserve old passkey origins;
   verify Circle's supported origin/RP configuration before changing it. The current
   WebAuthn document intentionally remains unchanged until that step is validated.
6. Update canonical, Open Graph, Twitter and JSON-LD URLs to the stable hostname
   as part of the verified cutover build, not as evidence that cutover has occurred.
7. Associate the confirmed custom domain in Pages **before** adding its required
   DNS record at the authoritative provider. Do not infer permission to migrate
   zone nameservers or modify unrelated records.
8. Confirm HTTPS, APIs, assets and the primary user workflow on desktop/mobile.
   Preserve the old deployment until retirement is separately authorized.

## Known cutover boundary (22 September 2026)

The existing `shadow-arc.vercel.app` deployment responds, including configured
storage/payment APIs. `shadow.dolepee.com` returns Vercel `DEPLOYMENT_NOT_FOUND`.
The Vercel DNS zone has no explicit `shadow` record; its default wildcard supplies
the failed destination. If that subdomain is selected, a dedicated CNAME must
affect only `shadow`, not the apex or wildcard. Restoring its prior DNS state would
mean removing only the newly created Shadow record. Retain its creation ID in the
private release record. A different domain needs its own ownership, DNS and
rollback checks before cutover.

No secrets, contract addresses, or paid capabilities are inferred from this
configuration. The committed Wrangler variables are public testnet defaults only.
