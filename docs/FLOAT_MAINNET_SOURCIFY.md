# Sourcify source verification

The default preflight uses the configured explorer. Set
`FLOAT_MAINNET_VERIFICATION_ROUTE=sourcify` explicitly to use the production
Sourcify service on Arc mainnet (5042) or Arc testnet (5042002).
No failed explorer request automatically selects this route.

Preflight checks current chain support plus all existing RPC, compiler, source
lineage, token, constructor and cap checks. It reports post-deployment source
verification as pending. Availability alone does not authorize line funding.

After an empty deployment, submit the exact Solidity Standard JSON input,
compiler version, fully qualified contract name and actual creation transaction
hash through the [Sourcify v2 API](https://docs.sourcify.dev/docs/api/).
`sourcifyInput(artifact, contractsRoot)` builds the input from the compiled
artifact metadata and hash-checked local source files. Supply the real creation
hash as `creationTransactionHash` to avoid explorer-dependent discovery.
Source submission publicly archives the contract sources; keep private notes,
environment files and credentials out of the request.

Then run the normal manifest command with the same verification-route setting.
The manifest retrieves the record directly from the fixed production endpoint.
It requires completed creation and runtime matches, the exact chain and address,
deployment transaction, compiler, contract name, source content and settings.
The recorded creation input and resolved runtime must equal the independent RPC
observations. Existing checks of constructor arguments, immutable slots, source
lineage and both RPCs still apply. Missing records, queued verification jobs,
runtime-only matches, different sources or settings and API errors fail closed.

Generate the deployment manifest at the deployment block (or the script's
ownership-proposal block), before later control changes invalidate its initial
state assertions. Contain the deployment immediately and verify the subsequent
Safe ownership, roles, pauses and empty-capital state with the normal monitor
baseline. Keep line funding and purchase services inactive until the manifest
passes and the contained-state checks complete. Source verification does not
replace a security review or verify Safe configuration.
