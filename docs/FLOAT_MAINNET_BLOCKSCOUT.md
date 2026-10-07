# Arc explorer data through Blockscout

Blockscout's per instance data APIs are deprecated. The release preflight can
explicitly use the authenticated Blockscout MCP data route while keeping source
verification separate:

```sh
export ARC_EXPLORER_DATA_ROUTE=blockscout
export BLOCKSCOUT_PRO_API_KEY_FILE=/absolute/private/path/to/key
export FLOAT_MAINNET_VERIFICATION_ROUTE=sourcify
```

Keep the key file outside the repository with mode 0600. Alternatively supply
`BLOCKSCOUT_PRO_API_KEY` in the private process environment, but never both.
The helper uses a fixed HTTPS service, sends the key only in its authentication
header, rejects redirects, and does not include credentials or session IDs in
reports. Browser bundles must not contain this key.

The data check compares the explorer's block hash with both independently
configured RPCs at their common observation height. Wrong blocks, unavailable
data, missing credentials and authentication errors fail the check. Server
errors have a bounded retry; client errors do not.

Read only connectivity check:

```sh
node app/scripts/float-mainnet-blockscout.mjs 5042 23761925
```

This does not deploy, transfer, fund or alter any wallet or contract.

`ARC_EXPLORER_URL` remains the human facing explorer URL. Its legacy data route
is retained for existing configurations. Neither an API key nor a passing block
lookup proves source verification. The old compiler configuration route is not
exposed by the Pro gateway. Choosing the Sourcify route is explicit and retains
the exact source, compiler, creation input, runtime and independent RPC checks
documented in [the source verification procedure](FLOAT_MAINNET_SOURCIFY.md).
If the explorer verification route is retained, its compiler configuration
check still must pass; there is no automatic fallback or waived check.
