# Shadow Float Mainnet Candidate: Arc Testnet Deployment Runbook

This runbook rehearses the `ShadowFloatMainnet` release path on Arc testnet. It authorizes nothing: every broadcast, verification submission, ownership transfer, and funding step below needs explicit approval (spec §11). The order is fixed:

1. local gates
2. read-only preflight
3. authorization gate
4. deploy with the Foundry script
5. deterministic release manifest
6. Arcscan source verification
7. two-step ownership transfer
8. first funding, only after all of the above

## 0. Inputs

Every value comes from env. The scripts have no defaults and refuse to run when a value is missing. Testnet values are never copied into mainnet config.

Copy `contracts/deployments/float-mainnet-candidate/arc-testnet.params.example` to a path **outside the repository**, for example `~/.shadow/float-mainnet-arc-testnet.env`, and fill it. `.gitignore` covers `.env` and `.env.*` but not `*.env`, so a filled copy inside the repo would not be ignored. Never put `PRIVATE_KEY` in that file.

```bash
export FLOAT_ENV=~/.shadow/float-mainnet-arc-testnet.env
```

| Variable | Arc testnet value (verified 2026-09-18) |
| --- | --- |
| `FLOAT_MAINNET_EXPECTED_CHAIN_ID` | `5042002` |
| `FLOAT_MAINNET_USDC` | `0x3600000000000000000000000000000000000000` (FiatTokenProxy to `NativeFiatTokenV2_2`, 6 decimals) |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.io` (docs primary; `https://rpc.testnet.arc.network` also answers) |
| `ARC_RPC_URL_2` | a different operator: `https://rpc.blockdaemon.testnet.arc.io`, `https://rpc.drpc.testnet.arc.io` or `https://rpc.quicknode.testnet.arc.io` |
| `ARC_EXPLORER_URL` | `https://testnet.arcscan.app` (301 to `https://explorer.testnet.arc.io`) |
| `FLOAT_MAINNET_PROPOSED_OWNER` | optional; the owner Safe. Blank or zero means none |
| `FLOAT_MAINNET_EXPECTED_DEPLOYER` | the approved deployer's public address, never a key. Optional for the preflight and the deploy script, required by the manifest. Blank or zero means not named |

Source for the network values: <https://docs.arc.io/arc/references/connect-to-arc> and <https://docs.arc.io/arc/references/contract-addresses>. Mainnet uses different values (docs list chain ID `5042`), so re-derive them from the docs at mainnet time.

Proposed guarded-launch values, in atomic USDC and seconds:

| Cap | `FLOAT_MAINNET_MAX_*` (immutable) | `FLOAT_MAINNET_INIT_*` (effective) |
| --- | --- | --- |
| `PROTOCOL_RESERVE` | `50000000` | `25000000` |
| `LINE_RESERVE` | `10000000` | `5000000` |
| `LINE_SPEND` | `10000000` | `5000000` |
| `PER_SPEND` | `2000000` | `1000000` |
| `DAILY_SPEND` | `4000000` | `2000000` |

`FLOAT_MAINNET_MIN_REPAYMENT_WINDOW=3600`, `FLOAT_MAINNET_MAX_REPAYMENT_WINDOW=604800`, `FLOAT_MAINNET_GOVERNANCE_DELAY=172800`.

## 1. Local gates

```bash
export PATH="$HOME/.foundry/bin:$PATH"
forge build --root contracts
npm run contracts:mainnet:test
npm run float:mainnet:tooling:test
```

Node 20.12 or later is required (`--env-file` and `util.parseEnv`); the tools fall back to an argv entrypoint check below Node 24.2. On Windows, use Node 22, or 24.20.0 or later: Node 23.0–24.19 can abort with exit code `0xC0000409` after HTTP requests, often with no output (nodejs/node#56645, fixed in 24.20.0 by #61999). Params files are LF-only (`.gitattributes`), so sourcing them in Git Bash leaves no trailing `
` in values.

`contracts/foundry.toml` pins solc `0.8.24`, optimizer on with `runs = 1`, `via_ir`, `bytecode_hash = "none"` and `cbor_metadata = false`. The runtime therefore carries no metadata tail. The only difference between the artifact and on-chain code is the ten immutable slots.

## 2. Preflight (read-only)

```bash
node --env-file="$FLOAT_ENV" app/scripts/float-mainnet-preflight.mjs > preflight.json
```

`npm run float:mainnet:preflight` runs the same script, but only after the env is exported (`set -a; . "$FLOAT_ENV"; set +a`). The script exits non-zero on any `FAIL`. RPC URLs are printed as `scheme://host` only; paths, query strings and credentials are redacted.

Checks:

- Env config is complete and satisfies the constructor rules: `_validateLimits(maxima, maxima)`, `_validateLimits(initial, maxima)`, nonzero windows and delay, `min <= max`, uint64 bounds, and two RPC URLs on distinct hosts. Two keys on one provider (`https://host/keyA` and `https://host/keyB`) are rejected. `127.0.0.1` and `localhost` count as distinct, for local rehearsal only.
- On each RPC: chain ID equals the expected ID. USDC has code, `decimals() == 6` and `symbol() == "USDC"`.
- Across RPCs: heads are within 64 blocks, the block hash at `min(head) - 10` is identical, and the USDC code hash and FiatTokenProxy implementation slot are identical.
- Restricted transfers: `paused() == false` on both RPCs, and `isBlacklisted(account) == false` for `FLOAT_MAINNET_EXPECTED_DEPLOYER` and `FLOAT_MAINNET_PROPOSED_OWNER`, each only when set. The blacklister and pauser addresses are recorded. A token without these functions reports `MANUAL`, not `PASS`.
- Explorer: reachable after redirects, and its `/api/v2/blocks/<h>` hash equals the RPC hash, so it indexes the same chain. Its verifier lists `v0.8.24+commit.e11b9ed9`.
- Artifact: compiler version and settings match the release profile, runtime is at most 18,432 bytes, and the metadata source keccak matches the LF-normalized working tree.
- Git: HEAD commit recorded. Each compiled source is unmodified against HEAD, with its sha256 and git blob id recorded.
- Source lineage: the compiled sources are exactly the reviewed ones. `PINNED_SOURCE_BLOBS` in `app/scripts/float-mainnet-preflight.mjs` pins the git blob of `src/ShadowFloatMainnet.sol` and `src/interfaces/IERC20.sol` at `2ebae7f` (`PINNED_SOURCE_COMMIT`). A committed change to either file, or a new compiled source, fails here and in the manifest (`source.matchesPinnedLineage`), even though it is "unmodified vs HEAD".

Changing the contract therefore requires consciously moving that pin. A material change needs review and pilot revalidation before the pin moves; update both constants in the same change as the reviewed source.

Items that stay `MANUAL` and need a human sign-off:

- **Arc runtime blocklist.** On Arc, a native value transfer to or from a blocklisted address reverts and still consumes gas (<https://docs.arc.io/arc/references/evm-differences>). This cannot be exercised read-only: it needs a blocklisted account, which only Circle's blacklister can create. The contract's atomicity under a reverting token is covered by the `TOK-01B` mocks. Before funding, confirm that the Float address, the owner Safe, the sponsors and the providers are not blocklisted.
- **Official values.** The preflight proves the chain ID, USDC, two RPC hosts and explorer agree with each other, and that the two RPC hosts differ. Comparing the values against the Arc docs above, and confirming that the two hosts are run by independent operators, stays a human check.
- **Deployer address not yet named.** Reported only while `FLOAT_MAINNET_EXPECTED_DEPLOYER` is blank; the deployer's blocklist status is then unchecked. Name it before the authorization gate.

Result on 2026-09-18 with the params example as committed (deployer and owner blank): `ok: true`, 25 `PASS`, 3 `MANUAL`, 0 `FAIL`. Two setups gave this result:

- `rpc.testnet.arc.network` + `rpc.blockdaemon.testnet.arc.io`, with `testnet.arcscan.app`;
- `rpc.testnet.arc.io` + `rpc.drpc.testnet.arc.io`, with `explorer.testnet.arc.io`.

Both RPCs reported USDC implementation `0xC6AD664ac6679F4Ce74e10E91449C93Ec1ae3cA6`, `paused() == false`, blacklister `0x9338f53291715F1126291E28BBd3B9989e966572` and pauser `0xbc639a0A060E5831a7c437b491B8d3C1f58F554e`.

## 3. Authorization gate

Stop here. Proceed only with explicit approval recorded against:

- the preflight report, rerun with `FLOAT_MAINNET_EXPECTED_DEPLOYER` set;
- the pinned source lineage (`2ebae7f` and its two git blob ids) and the source sha256 values;
- the deployer address (`FLOAT_MAINNET_EXPECTED_DEPLOYER`) and the proposed owner Safe.

## 4. Deploy

`contracts/script/DeployShadowFloatMainnet.s.sol` reads the same env plus `PRIVATE_KEY`. It asserts chain, USDC code, decimals, getters, effective caps, owner, pauses and totals in simulation before forge broadcasts. When `FLOAT_MAINNET_EXPECTED_DEPLOYER` is set, it refuses a `PRIVATE_KEY` for any other address (`FLOAT_MAINNET_UNEXPECTED_DEPLOYER`) before it starts broadcasting; set it for the real deployment. Supply the key in the shell only, and never in a file:

```bash
set -a; . "$FLOAT_ENV"; set +a
read -rs PRIVATE_KEY && export PRIVATE_KEY

# Simulation only (also: npm run contracts:deploy:float-mainnet).
(cd contracts && forge script script/DeployShadowFloatMainnet.s.sol:DeployShadowFloatMainnet \
  --rpc-url "$ARC_RPC_URL")

# Only after the authorization gate: the same command plus --broadcast.
(cd contracts && forge script script/DeployShadowFloatMainnet.s.sol:DeployShadowFloatMainnet \
  --rpc-url "$ARC_RPC_URL" --broadcast)
unset PRIVATE_KEY
```

The npm alias deliberately omits `--broadcast`. `npm run contracts:deploy:float-mainnet -- --broadcast` appends it, but npm on Windows runs scripts through `cmd.exe`, which does not expand `$ARC_RPC_URL`. Use the direct command from Git Bash there.

The deployment must be a plain `CREATE` from the deployer EOA, with no CREATE2 factory or salt. Under a factory, `owner` would be the factory, and the manifest rejects it.

## 5. Release manifest

`$FLOAT_ENV` must now name `FLOAT_MAINNET_EXPECTED_DEPLOYER`; the manifest refuses to run without it. Produce the release record with `--block` pinned to a block after the deploy and before any later write:

```bash
FLOAT_STATE_BLOCK=<block number after the deploy>
node --env-file="$FLOAT_ENV" app/scripts/float-mainnet-manifest.mjs \
  --broadcast contracts/broadcast/DeployShadowFloatMainnet.s.sol/5042002/run-latest.json \
  --block "$FLOAT_STATE_BLOCK" --out float-mainnet-arc-testnet.manifest.json
```

Instead of a broadcast file, you can pass `--address <float> --tx <deploy tx hash>`. `--block <n>` pins the state block; without it the slower RPC's head is used. The script reads both RPCs at the same block. It writes the manifest even when assertions fail, and then exits non-zero. An RPC or input error aborts before anything is written.

The deploy transaction hash is taken from the broadcast `receipts[]` entry whose `contractAddress` is the Float. In a rehearsal with forge 1.7.1, `transactions[].hash` of the CREATE and of the same-block `proposeOwner` CALL were swapped; the receipts were correct.

The manifest is deterministic for a given `--block`. Keys are sorted recursively, integers are decimal strings, and there are no wall-clock timestamps and no RPC identifiers. The observation block is written as `observedAt` (number and hash). Each RPC reads that block's hash, and `rpc.observationsIdenticalAcrossRpcs` fails if they differ. The RPC hosts are logged to stderr only. Two runs from the same checkout with the same `--block` are byte-identical (the manifest embeds the HEAD commit), even from different RPC providers, and whether they start from `--broadcast` or `--address/--tx`. Without `--block`, `observedAt` follows the chain head and the file changes with every block, which is why the release record pins it. It records:

- source commit, and the pinned lineage (`PINNED_SOURCE_COMMIT` and the pinned blob ids);
- sha256 and git blob id of each compiled source, LF-normalized;
- the observation block number and hash;
- compiler version and settings;
- runtime size;
- the artifact runtime keccak with immutable ranges masked;
- the on-chain runtime keccak, full and masked;
- the decoded immutable words per slot;
- ABI-encoded constructor args;
- deploy tx, block, timestamp, deployer and nonce;
- observed state and every contract event since deploy;
- USDC restriction probes;
- every assertion with `PASS`, `FAIL` or `MANUAL`.

| Assertion | Meaning |
| --- | --- |
| `rpc.observationsIdenticalAcrossRpcs` | Both RPCs return byte-identical observations |
| `chain.idMatchesConfig` | Chain ID on both RPCs equals the config |
| `deploy.receiptSucceeded`, `deploy.plainCreateTransaction`, `deploy.receiptContractAddressMatches`, `deploy.addressDerivesFromDeployerNonce` | Successful plain CREATE whose address derives from deployer and nonce |
| `deploy.senderIsExpectedDeployer` | The deploy transaction was sent by `FLOAT_MAINNET_EXPECTED_DEPLOYER`. An identical deployment by anyone else fails |
| `deploy.inputIsArtifactCreationCodePlusConstructorArgs` | Deploy calldata equals the artifact creation code followed by the config's constructor encoding |
| `code.runtimeLengthMatchesArtifact`, `code.maskedRuntimeMatchesArtifact` | On-chain runtime equals the artifact outside the immutable ranges |
| `code.immutableSlotsInternallyConsistent`, `code.immutableValuesMatchConfig` | Every reference of an immutable holds one word, and the ten words equal the config. Names come from the getters, because AST ids differ between compilation units |
| `immutable.*` | Each of the ten immutable getters equals the config |
| `state.effectiveLimitsEqualInitialConfig` | Effective caps equal `FLOAT_MAINNET_INIT_*` |
| `state.ownerIsDeployer`, `state.pendingOwnerMatchesConfig` | Owner is `FLOAT_MAINNET_EXPECTED_DEPLOYER`, and the pending owner is exactly `FLOAT_MAINNET_PROPOSED_OWNER` (zero when none is configured) |
| `state.openingsNotPaused`, `state.spendsNotPaused`, `state.totalsZero`, `state.floatUsdcBalanceZero` | Guarded start with no capital: both totals and the Float's own USDC balance are zero at the observation block |
| `events.onlyExpectedEventsSinceDeploy` | From the deploy block to the observation block, the only contract event is exactly one `OwnershipProposed(expected deployer, proposed owner)`, and only when a proposed owner is configured. Any operator, sponsor, cap, pause or other event fails |
| `usdc.notPaused`, `usdc.floatNotBlacklisted` | Token not paused, and the Float address not blocklisted |
| `scope.zeroFeeAbiGate` | `contracts/test/mainnet-scope.test.mjs` passes on the built artifact |
| `source.artifactBuiltFromWorkingTree`, `source.unmodifiedVsHead`, `source.matchesPinnedLineage`, `artifact.*` | Artifact built from the committed source, whose git blobs equal the pinned lineage at `2ebae7f`, with the release compiler settings, and within 18,432 bytes |

Rehearsal on local anvil on 2026-09-18 (chain ID `5042002`, 6-decimal `MockAsset`, pinned values, expected deployer and proposed owner set): 38 assertions, 36 `PASS`, 2 `MANUAL` (MockAsset has no pause or blocklist), 0 `FAIL`. Reruns with the same `--block`, from the broadcast file and from `--address/--tx`, were byte-identical. Each of these tampers exited non-zero:

- `FLOAT_MAINNET_EXPECTED_DEPLOYER` set to another address: `deploy.senderIsExpectedDeployer`, `state.ownerIsDeployer`, `events.onlyExpectedEventsSinceDeploy`;
- `FLOAT_MAINNET_PROPOSED_OWNER` set to a different address: `state.pendingOwnerMatchesConfig`, `events.onlyExpectedEventsSinceDeploy`;
- `FLOAT_MAINNET_EXPECTED_DEPLOYER` blank: aborted before writing a file;
- `FLOAT_MAINNET_INIT_PER_SPEND=999999`: `deploy.inputIsArtifactCreationCodePlusConstructorArgs`, `state.effectiveLimitsEqualInitialConfig`;
- expected chain `5042`: `chain.idMatchesConfig` and the chain-ID immutable and calldata checks;
- an operator enabled after deploy, read at the head: `events.onlyExpectedEventsSinceDeploy`;
- ownership accepted by the proposed owner, read at the head: `state.ownerIsDeployer`, `state.pendingOwnerMatchesConfig`, `events.onlyExpectedEventsSinceDeploy`.

After both post-deploy writes, `--block` at the deploy state still reproduced the original manifest byte for byte.

## 6. Arcscan source verification

What the explorer is (probed read-only on 2026-09-18):

- `testnet.arcscan.app` answers every path, including `/api`, with `301` to `https://explorer.testnet.arc.io`. That host is Blockscout `v11.3.1` with the Rust verifier microservice enabled, and `v0.8.24+commit.e11b9ed9` is in its compiler list. Submit to `explorer.testnet.arc.io` directly, because a redirected POST is not preserved.
- `forge verify-contract --verifier blockscout` issues `GET <url>/api?module=contract&action=getabi&address=...`. It then POSTs `module=contract&action=verifysourcecode&codeformat=solidity-standard-json-input&compilerversion=v0.8.24+commit.e11b9ed9` with the constructor args to `<url>/api`. This was captured against a local stub, and nothing was submitted to the explorer.
- Precedents:
  - ShadowFloat V2 `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` was verified on 2026-06-26 with these exact settings. Blockscout reports `is_verified: true`, `is_partially_verified: true`, `is_fully_verified: false`. **A partial match is the expected final state**: with no metadata hash there is nothing for a full match to compare.
  - Forum's `FeeRouterV1` `0xeff9bc359e8f2a5eabce55af3f1bb24f98eabf59` was verified on 2026-07-17. Forum's `foundry.toml` declares an Etherscan-style `https://testnet.arcscan.app/api` endpoint with an empty key; the exact command is not recorded there.
- No API key is needed for Blockscout.

Take the address from the manifest:

```bash
FLOAT_ADDRESS=$(node -e 'process.stdout.write(require("./float-mainnet-arc-testnet.manifest.json").contract.address)')
```

1. Generate the standard-JSON input offline and prove it reproduces the artifact:

   ```bash
   forge verify-contract --root contracts --chain 5042002 \
     --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
     --show-standard-json-input \
     "$FLOAT_ADDRESS" src/ShadowFloatMainnet.sol:ShadowFloatMainnet > float-standard-input.json

   SOLC=$(ls ~/.svm/0.8.24/solc-0.8.24* "$APPDATA"/svm/0.8.24/solc-0.8.24* 2>/dev/null | head -1)
   "$SOLC" --standard-json < float-standard-input.json > float-standard-output.json
   node -e '
   const out = require("./float-standard-output.json").contracts["src/ShadowFloatMainnet.sol"].ShadowFloatMainnet.evm;
   const art = require("./contracts/out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json");
   const same = "0x" + out.bytecode.object === art.bytecode.object && "0x" + out.deployedBytecode.object === art.deployedBytecode.object;
   console.log(same ? "standard JSON reproduces the artifact" : "MISMATCH"); process.exit(same ? 0 : 1);'
   ```

   `--show-standard-json-input` only prints and exits. It produced identical output with an unreachable verifier URL. The input contains `src/ShadowFloatMainnet.sol` and `src/interfaces/IERC20.sol`, normalized to LF.

2. Take the constructor args from the manifest and cross-check them independently:

   ```bash
   FLOAT_CONSTRUCTOR_ARGS=$(node -e 'process.stdout.write(require("./float-mainnet-arc-testnet.manifest.json").constructorArgs)')
   cast abi-encode "constructor(address,uint256,(uint256,uint256,uint256,uint256,uint256),(uint256,uint256,uint256,uint256,uint256),uint64,uint64,uint64)" \
     "$FLOAT_MAINNET_USDC" "$FLOAT_MAINNET_EXPECTED_CHAIN_ID" \
     "($FLOAT_MAINNET_MAX_PROTOCOL_RESERVE,$FLOAT_MAINNET_MAX_LINE_RESERVE,$FLOAT_MAINNET_MAX_LINE_SPEND,$FLOAT_MAINNET_MAX_PER_SPEND,$FLOAT_MAINNET_MAX_DAILY_SPEND)" \
     "($FLOAT_MAINNET_INIT_PROTOCOL_RESERVE,$FLOAT_MAINNET_INIT_LINE_RESERVE,$FLOAT_MAINNET_INIT_LINE_SPEND,$FLOAT_MAINNET_INIT_PER_SPEND,$FLOAT_MAINNET_INIT_DAILY_SPEND)" \
     "$FLOAT_MAINNET_MIN_REPAYMENT_WINDOW" "$FLOAT_MAINNET_MAX_REPAYMENT_WINDOW" "$FLOAT_MAINNET_GOVERNANCE_DELAY"
   # must print exactly $FLOAT_CONSTRUCTOR_ARGS
   ```

3. Submit. This is an authorized, public step:

   ```bash
   forge verify-contract --root contracts --chain 5042002 \
     --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
     --constructor-args "$FLOAT_CONSTRUCTOR_ARGS" --watch \
     "$FLOAT_ADDRESS" src/ShadowFloatMainnet.sol:ShadowFloatMainnet
   ```

4. Read the result back:

   ```bash
   curl -s "https://explorer.testnet.arc.io/api/v2/smart-contracts/$FLOAT_ADDRESS" | node -e '
   let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
     const c = JSON.parse(s);
     console.log(JSON.stringify({ name: c.name, is_verified: c.is_verified, is_partially_verified: c.is_partially_verified,
       compiler_version: c.compiler_version, compiler_settings: c.compiler_settings,
       decoded_constructor_args: c.decoded_constructor_args?.map(([value]) => value) }, null, 2));
   });'
   ```

   Expected:
   - `name: "ShadowFloatMainnet"`, `is_verified: true`, `is_partially_verified: true`;
   - compiler `v0.8.24+commit.e11b9ed9`;
   - `optimizer.runs: 1`, `viaIR: true`, `appendCBOR: false`, `bytecodeHash: "none"`, `evmVersion: "cancun"`;
   - decoded constructor args equal to the manifest config.

Optional second source match: Sourcify lists Arc Testnet `5042002` as supported, and V2 shows `match` there. That is Sourcify's term for the former "partial" match; `exact_match` cannot be reached without a metadata hash. Repeat step 3 with `--verifier sourcify` and no `--verifier-url`.

## 7. Ownership transfer

If `FLOAT_MAINNET_PROPOSED_OWNER` was set, the deploy script already called `proposeOwner` in the same broadcast. Otherwise the deployer proposes the Safe, which is an authorized transaction:

```bash
cast send "$FLOAT_ADDRESS" "proposeOwner(address)" "$FLOAT_MAINNET_PROPOSED_OWNER" --rpc-url "$ARC_RPC_URL" --interactive
```

The Safe then executes `acceptOwnership()` on the Float. Verify on both RPCs:

```bash
for rpc in "$ARC_RPC_URL" "$ARC_RPC_URL_2"; do
  cast call "$FLOAT_ADDRESS" "owner()(address)" --rpc-url "$rpc"
  cast call "$FLOAT_ADDRESS" "pendingOwner()(address)" --rpc-url "$rpc"
done
```

Expected: `owner` is the Safe and `pendingOwner` is zero on both. The release manifest stays the deployment-state record. Rerun without `--block` after the transfer and it fails `state.ownerIsDeployer`, `state.pendingOwnerMatchesConfig` and `events.onlyExpectedEventsSinceDeploy` by design. `--block <deploy-state block>` reproduces the original byte-identical manifest. Keep the deployer out of every role: `events.onlyExpectedEventsSinceDeploy` proves that no operator was enabled up to the manifest block.

## 8. First funding

Funding is a separate, explicitly authorized transaction. It happens only after all of the following:

- the manifest is `ok: true`, with its `MANUAL` items signed off;
- source verification shows the expected partial match;
- the Safe has accepted ownership;
- the Float address, Safe, sponsor and provider are confirmed not blocklisted (`isBlacklisted` read on both RPCs).

Sponsor allowlisting (`setSponsorAllowed`) by the Safe and the sponsor's `openLine` are outside this runbook.
