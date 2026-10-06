# Explorer reads for browser recovery and historical APIs

The application server needs a private `BLOCKSCOUT_PRO_API_KEY` environment
variable. Do not prefix it with `VITE_`, commit it, or send it to the browser.

Browser saved nonce recovery calls the same origin `/api/explorer` endpoint.
A rewrite dispatches this route through the existing Float server function,
so it does not add a serverless function. The endpoint supports only outgoing address transaction pages on Arc mainnet
and testnet and returns only hash, nonce, sender and validated page cursors.
It is a transaction suggestion, not confirmation: the existing recovery code
still validates the sender, nonce, exact call and onchain result independently.
Unavailable indexing leaves the original operation pending.

The Float and Treasury historical fallbacks use the same server only adapter
for their existing read endpoints. The adapter validates chain and explorer
host, forwards no incoming credentials, sends the Pro key only to the fixed
Blockscout Pro API, refuses redirects and limits the entire read to eight
seconds and three MB. Server errors have bounded retries inside that same
deadline; client errors fail without retry. Prior deadline and completeness
checks remain in place.

The public recovery endpoint has a small bounded process local cache and a
process local request budget. These reduce repeated lookups but are not a
distributed abuse prevention guarantee. The vendor plan quota remains the
global limit. This integration does not enable paid overages or x402 payments.

The assistant MCP service truncates log data, so it cannot supply exact ABI
evidence. Application reads use the raw authenticated Pro API instead. Native
page parameters remain intact; Treasury follows log pages to completion within
its deadline and refuses capped or unavailable histories.
