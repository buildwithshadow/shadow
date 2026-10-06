# Explorer reads for browser recovery and historical APIs

The application server needs a private `BLOCKSCOUT_PRO_API_KEY` environment
variable. Do not prefix it with `VITE_`, commit it, or send it to the browser.

Browser saved nonce recovery calls the same origin `/api/explorer` endpoint.
The endpoint supports only outgoing address transaction pages on Arc mainnet
and testnet and returns only hash, nonce, sender and validated page cursors.
It is a transaction suggestion, not confirmation: the existing recovery code
still validates the sender, nonce, exact call and onchain result independently.
Unavailable indexing leaves the original operation pending.

The Float and Treasury historical fallbacks use the same server only adapter
for their existing read endpoints. The adapter validates chain and explorer
host, forwards no incoming credentials, sends the Pro key only to the fixed
Blockscout MCP service, refuses redirects and limits the entire read to eight
seconds and three MB. Server errors have bounded retries inside that same
deadline; client errors fail without retry. Prior deadline and completeness
checks remain in place.

The public recovery endpoint has a small bounded process local cache and a
process local request budget. These reduce repeated lookups but are not a
distributed abuse prevention guarantee. The vendor plan quota remains the
global limit. This integration does not enable paid overages or x402 payments.
