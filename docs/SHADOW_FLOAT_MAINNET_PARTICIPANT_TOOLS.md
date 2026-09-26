# Shadow Float Mainnet Candidate: Participant Tools

Status, 2026-09-25: the `ShadowFloatMainnet` candidate is deployed on **Arc testnet only** at `0xFeDb5c8c29792d49947492F357f21dc8405F08fc`. Its [deployment manifest](../contracts/deployments/float-mainnet-candidate/arc-testnet.manifest.json) records the contract, chain, USDC, source and deployment block; it is a pinned deployment snapshot, so read current line and owner state from the chain. Founder-operated testnet purchases, repayment, refusal and reclaim have succeeded, including one purchase signed by a Circle Modular Wallet. The candidate has no independent pilot or independent security review and is not deployed on Arc mainnet. The examples below do not authorize another person's funds or imply that an external provider has agreed to a pilot.

These command-line tools let each pilot participant run their own part of the lifecycle with their own key. No Shadow engineer builds or signs a participant's transaction. They target the candidate contract only. They reject a V2 address, a V2 intent file, the wrong chain, and any contract that does not report the candidate's own EIP-712 name, version and `SpendIntent` typehash.

## Browser funding and repayment

The [funding page](https://www.shadowbuild.xyz/funding) manages the deployed Arc testnet candidate. An approved sponsor can enter an agent, an agreed provider endpoint and spending limits, approve the exact USDC reserve, then separately confirm opening the line. Any browser EOA wallet can repay a loaded line; only its sponsor can close it and reclaim eligible reserve or claim available default recovery. The page pins the candidate address, runtime code, chain and token before preparing transactions. It does not expose a mainnet mode or accept private keys.

The form uses decimal USDC amounts. Its default reserve is 0.10 test USDC, maximum purchase 0.05, daily limit 0.10 and cumulative purchase limit 0.15. Current onchain limits are checked as well as fixed browser ceilings. Repayment restores reserve but does not reset cumulative principal paid. The agent may be a deployed Circle Modular Wallet; the funding wallet must be an EOA. Agent signing, purchase submission and provider delivery still use the candidate tools below. This page does not replace those steps with a founder relay.

Each transaction has a review screen and a separate wallet confirmation. The browser stores its exact destination, calldata, sender and nonce before opening the wallet, then blocks another operation from that account until the prior result is resolved. Keep the browser's site data while a request is pending. This guard applies to this browser profile, not other devices, sites or tools.

The nonce is read from the connected wallet provider's pending state and rechecked immediately before sending; a change stops the request before the signing prompt. The public read RPC never chooses this nonce. This is not an atomic reservation while a wallet prompt is open. Finish other transactions from the account first, and cancel this prompt and review again if you submit from another app or device. A dedicated account avoids sharing this nonce stream with unrelated activity.

On an uncertain response, select **Check confirmation**. If the wallet broadcast without returning a hash, copy the original transaction hash from wallet activity. Recovery checks the sender, nonce, exact call, canonical receipt and expected event; a matching balance change alone is insufficient. A confirmed transaction that used the same nonce but different calldata resolves as a replacement, not as a successful Shadow action.

If a request never broadcast, it may have no hash. Do not clear site data to retry. Use the wallet's cancellation/replacement controls with the saved account and nonce; a confirmed replacement consumes that nonce and can be checked on the funding page. If the wallet cannot do this, ask the operator for help. Pending or unreadable receipts remain unresolved, and no automatic resend is performed. A known reverted transaction allows a new, freshly reviewed action.

Repayment uses a fixed displayed amount, not a draw-specific repayment identifier. The page rechecks the debt before the wallet prompt, but an already-open prompt can become stale if another participant repays and the agent draws again. Close stale prompts, coordinate repayment with the operator, and always check confirmation before preparing another payment. Browser recovery does not make the contract's repayment function idempotent.

## Roles

| Role | Tool | Key (env, read only by commands that sign, never printed) |
| --- | --- | --- |
| Owner (a Safe in production) | `float-mainnet-owner.mjs` | `FLOAT_OWNER_PRIVATE_KEY`, or none with `--calldata --from <safe>` |
| Emergency operator (pause and cancel cap increase only) | `float-mainnet-owner.mjs` | Its own key in `FLOAT_OWNER_PRIVATE_KEY`, or none with `--calldata --from <operator>` |
| Sponsor | `float-mainnet-sponsor.mjs` | `FLOAT_SPONSOR_PRIVATE_KEY` |
| Agent | `float-mainnet-intent.mjs`, `float-mainnet-cancel-nonce.mjs` | `FLOAT_AGENT_PRIVATE_KEY` (EOA agents), or an external signer for smart-account agents |
| Executor (relayer) | `float-mainnet-submit.mjs` | `FLOAT_EXECUTOR_PRIVATE_KEY`, or none with `--calldata --from <executor>` |
| Repayer (anyone) | `float-mainnet-repay.mjs` | `FLOAT_REPAYER_PRIVATE_KEY`, falling back to `FLOAT_AGENT_PRIVATE_KEY` |
| Provider | `float-mainnet-provider.mjs` | `FLOAT_PROVIDER_PRIVATE_KEY` (EOA providers), or an external signer for a provider address with code |
| Anyone, read only | `float-mainnet-line.mjs`, `float-mainnet-indexer.mjs`, `float-mainnet-evidence.mjs`, `float-mainnet-verify.mjs` | none |

## Setup

Node 20.12 or later. On Windows, use Node 22, or 24.20.0 or later: Node 23.0–24.19 can abort with exit code `0xC0000409` after HTTP requests, often with no output (nodejs/node#56645, fixed in 24.20.0 by #61999). The tools live in `app/scripts/` and use the app's `viem`:

```bash
cd app && pnpm install --frozen-lockfile --ignore-workspace && cd ..
export ARC_RPC_URL=https://rpc.testnet.arc.io
export FLOAT_MAINNET_EXPECTED_CHAIN_ID=5042002
```

From the repository root, set `M=contracts/deployments/float-mainnet-candidate/arc-testnet.manifest.json` and pass `--manifest "$M"` on every command below. The manifest is used only if it passed (`ok: true`), is for the expected chain, and its recorded runtime code hash equals the code at the address. It also gives log lookups a lower bound. `FLOAT_MAINNET_ADDRESS=<address>` works without a manifest, with the generation checks only. The manifest's owner and balance fields describe its deployment block, not current state; check live state before any action. See the [deployment runbook](SHADOW_FLOAT_MAINNET_TESTNET_DEPLOYMENT.md) for how this record was produced.

## Conventions

- **Durable execution policy.** Arc mainnet intent build/sign/verify and submit/preflight require `--session <policy.json>` with an initialized persistent ledger and exact nonzero executor. Testnet can opt in. The [execution session guide](SHADOW_EXECUTION_SESSION.md) explains policy fields, initialization and recovery. Gross reservations survive new line epochs and never recycle; unresolved attempts hold new submissions. This is a local executor restriction, not a Solidity global limit.
- **Dry run by default.** A write command simulates from the signer's address and prints the calls. `--execute` sends them, waits for each receipt, and prints the transaction hashes and decoded Float events. `--calldata --from <address>` needs no key and prints `{to, value, data}` for a Safe or an external wallet.
- **One JSON object** on stdout per run. Exit 0 on success, 1 on failure (`{ok:false, error:{message, revert}}`, where `revert` is the contract's custom error name), and 2 on a usage error, with the tool's full usage.
- **Amounts** are atomic USDC (6 decimals): `1000000` is 1 USDC. **Times** (`<t>`) are unix seconds or `+<seconds>` after the latest block, never wall-clock time. **Durations** are bare seconds.
- **Endpoints.** The contract compares endpoint hashes for equality only. Convention for the candidate: `--endpoint "<exact string>"` is hashed as keccak256 of its UTF-8 bytes. `--endpoint-hash` takes the raw bytes32. Sponsor and provider must agree on the exact string.
- **Unclear sends.** Every tool signs before broadcasting, so it knows the transaction hash in advance. It never resends. If a send or wait fails without a clear outcome, the tool reports `status: "unknown"` with the hash. For `submit`, it also reports the digest's `receiptStatus`, or `"unreadable"` if the RPC is down. If a transaction was mined but a follow-up read failed, the tool reports `status: "sent"` with every hash. In either case, check the hashes, or run `float-mainnet-line.mjs receipt --digest`, before running again.

## The lifecycle

The shell variables below (`$SPONSOR`, `$AGENT`, `$PROVIDER`, `$EXECUTOR`, `$LINE`, `$M`) stand for your own addresses, your line ID and your manifest path.

### 1. Owner allowlists the sponsor

On the current Arc testnet deployment the owner is the founder-controlled EOA `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8`, not a Safe. A new sponsor cannot independently open a line until this owner has explicitly allowed that address and the transaction is confirmed. Ask the pilot coordinator for that action before funding or signing anything. `$OWNER` below is the current owner address read from the contract; a later Safe owner would submit the same calldata through the Safe.

```bash
node app/scripts/float-mainnet-owner.mjs allow-sponsor --sponsor $SPONSOR --calldata --from $OWNER --manifest $M
```

The printed call is for the owner wallet to review and submit. With `FLOAT_OWNER_PRIVATE_KEY` set, `--execute` sends it directly. `pause --what openings|spends` can also be sent by an operator; `unpause` is owner-only. Do not treat printed calldata as an executed allowlist change.

#### Owner and emergency controls

Use named caps, in atomic USDC: `protocol-reserve`, `line-reserve`, `line-spend`, `per-spend`, or `daily-spend`. The owner can lower an effective cap immediately. A reduction also cancels any queued increase of that cap; a zero value is invalid, so use the pause commands to stop new risk. Lowering caps does not withdraw funds, cancel existing debt or disable repayment and eligible exits.

```bash
node app/scripts/float-mainnet-owner.mjs allow-operator --operator $OPERATOR --calldata --from $OWNER --manifest $M
node app/scripts/float-mainnet-owner.mjs reduce-cap --cap per-spend --value 500000 --calldata --from $OWNER --manifest $M
node app/scripts/float-mainnet-owner.mjs cancel-cap-increase --cap per-spend --calldata --from $OPERATOR --manifest $M
node app/scripts/float-mainnet-owner.mjs disallow-operator --operator $OPERATOR --calldata --from $OWNER --manifest $M
```

These are separate call examples, not a batch to submit blindly. `500000` means 0.50 USDC; choose the intended limit before preparing a call. Every command checks the caller's current onchain role and simulates the call. `cancel-cap-increase` requires an existing proposal and permits either the owner or a currently enabled operator, even after its activation time if it has not been activated. Operators cannot lower caps, grant roles or unpause. The owner can revoke an operator immediately.

Ownership changes use two separate confirmations:

```bash
node app/scripts/float-mainnet-owner.mjs propose-owner --owner $NEXT_OWNER --calldata --from $OWNER --manifest $M
# Submit the proposal and confirm pendingOwner() before preparing acceptance.
node app/scripts/float-mainnet-owner.mjs accept-owner --calldata --from $NEXT_OWNER --manifest $M
```

The proposal leaves the current owner in control. Only the exact nonzero `pendingOwner()` can accept; once acceptance is confirmed, the former owner loses owner powers. Ownership transfer does not remove any independently granted operator role: explicitly revoke unused operators and verify current state. These tools accept the contract's address-based roles; they do not prove that a proposed address is a Safe or that its signers, threshold and recovery configuration are suitable. Verify those separately before transferring ownership.

All commands retain default dry-run and explicit `--execute` behavior. Dry runs and prepared calldata are observations at preparation time, not executed changes. Verify transaction receipts and current state afterward. Scheduling and activating cap increases are not exposed by this CLI; those existing contract calls remain separately reviewed governor operations. There is no command that bypasses their governance delay or immutable ceilings.

### 2. Sponsor opens and funds the line

```bash
FLOAT_SPONSOR_PRIVATE_KEY=... node app/scripts/float-mainnet-sponsor.mjs open \
  --agent $AGENT --provider $PROVIDER --endpoint "https://provider.example/api/ask" \
  --reserve 1000000 --line-spend-cap 3000000 --daily-cap 1000000 \
  --line-expiry +5184000 --max-repayment-window 604800 \
  --provider-per-spend 1000000 --provider-daily 1000000 --provider-expiry +5184000 \
  --manifest $M --execute
```

Before sending, `open` checks the allowlist, any earlier line, the sponsor's USDC balance and every contract bound, and reports every problem at once. It approves exactly the reserve, and only when the allowance is short. It prints the `lineId`. The pilot values above are proposals ([test plan](SHADOW_FLOAT_MAINNET_PILOT_TEST_PLAN.md)). They cap the line at 3 USDC of cumulative principal: three purchases at the pilot's 1 USDC price.

`--max-repayment-window` must be at least the contract's `minimumRepaymentWindow` + 900 s. `--line-expiry` and `--provider-expiry` (on `open`, `update-terms` and an active `set-provider-policy`) must be at least that far past the latest block. Below these floors the contract would still accept the line, but no intent with the default 900 s signature validity could reliably be executed on it.

`set-provider-policy` and `update-terms` change the line's terms version. **This voids every signed intent outstanding on the line**, and the output says so.

### 3. Check the line

```bash
node app/scripts/float-mainnet-line.mjs status --line-id $LINE --provider $PROVIDER --manifest $M
```

It shows state, reserve, outstanding debt, recovery, cumulative principal, today's spend (which resets at the UTC day boundary), due date and expiry. `remaining.nextSpendMax` is the largest purchase the contract would pay, and `limitedBy` names the binding limit. The figure is exact at the block in `remainingExactAt`, not at a later block. Pass `--provider`: without it, `status` scans policy logs from the manifest's deploy block.

### 4. Agent builds and signs a purchase

```bash
node app/scripts/float-mainnet-intent.mjs build --agent $AGENT --sponsor $SPONSOR --provider $PROVIDER \
  --endpoint "https://provider.example/api/ask" --principal 1000000 --executor $EXECUTOR \
  --out intent.json --manifest $M
FLOAT_AGENT_PRIVATE_KEY=... node app/scripts/float-mainnet-intent.mjs sign --intent intent.json --manifest $M
node app/scripts/float-mainnet-intent.mjs verify --intent intent.json --manifest $M
```

`build` reads the live line: epoch, current terms hash, the provider's endpoint hash and the repayment window. It refuses if:

- the line owes money (one outstanding draw per line; repay in full first);
- it is not open, or has expired;
- the purchase would be recorded as a refusal instead of paid, unless `--allow-block` is passed;
- the provider's policy expires before the intent's signature does, because a late execution would then be recorded as `PROVIDER_NOT_ALLOWED`. Shorten `--signature-ttl`, ask the sponsor to extend the policy, or pass `--allow-block`.

The local digest must equal the contract's `hashSpendIntent`. `dueAt` defaults to the latest value that keeps the intent executable until its signature expires (`--signature-ttl`, 900 s by default). Before any signature is accepted, `sign` and `verify` check again that the intent is still fresh: same epoch, same terms hash, line open, nonce unused, signature not expired.

**Smart-account agents.** The contract checks an ERC-1271 signature only when the agent address already has code. An undeployed smart account always fails, so deploy it before submitting. Sign the file's `externalSignerTypedData` (eth_signTypedData_v4 JSON) with the wallet, then attach the signature:

```bash
node app/scripts/float-mainnet-intent.mjs verify --intent intent.json --signature <hex> --out intent.json --manifest $M
```

An existing Circle **Modular Wallet** signed an exact payable candidate intent with a passkey on Arc testnet; the contract validated its ERC-1271 signature and paid the provider [once](https://explorer.testnet.arc.io/tx/0x97168b40dd9fd66f83c815637fb75bfe2952ee46bdec8661351a626d39ea4bc3) in a founder-operated rehearsal. This is not verification that the wallet is registered as a Circle Agent Wallet, or that another participant's wallet and signing method work. Check the actual account type and deployed code before relying on this path.

### 5. Executor submits

```bash
FLOAT_EXECUTOR_PRIVATE_KEY=... node app/scripts/float-mainnet-submit.mjs preflight --intent intent.json --manifest $M
FLOAT_EXECUTOR_PRIVATE_KEY=... node app/scripts/float-mainnet-submit.mjs submit --intent intent.json --execute --manifest $M
```

`preflight` reads the receipt status and simulates `executeSpend` from the executor. The result is `pay`, `block` (with the reason the contract would record), `revert` (with the error, for example `InvalidState` while the line owes money, or `StaleTerms`), `already-paid` or `already-blocked`.

Dry runs and `--calldata` output include `simulatedAt`, the block the simulation was taken at: a Safe executing later should simulate again. `submit` never sends an intent whose digest is already recorded. It never sends a simulated revert, and sends a simulated block only with `--allow-block`. The result is `paid` (with the provider payment) or `blocked` (with the reason). If an intent names an executor, only that address can submit it.

### 6. Provider accepts, checks the payment, and delivers

The provider protocol is Shadow's own convention for this candidate. It is not x402 or any other payment standard, and no seller in an existing catalog supports it: a provider has to adopt it. The kit signs with `FLOAT_PROVIDER_PRIVATE_KEY`, an EOA key. A provider address with code has its receipts checked with ERC-1271: it calls the kit's `acceptIntent` and `deliverResult` with a custom account `{ address, signTypedData }` that signs with its own signer, so every acceptance and delivery check still runs. Receipts are EIP-712 (`ShadowFloatMainnetProvider` version `1`), bound to the chain and the Float address.

**Receipt format.** A receipt file holds `kind`, `chainId`, `verifyingContract`, `typedData` (domain, types, primary type and message), `signature`, `signer` and the plaintext `requestId`; a delivery may also hold the plaintext `resultRef`. The signed messages are:

- `ServiceAcceptance(bytes32 digest,address provider,bytes32 endpointHash,uint256 principal,bytes32 requestIdHash,uint256 acceptedAt)`
- `DeliveryReceipt(bytes32 digest,address provider,bytes32 requestIdHash,bytes32 resultHash,bytes32 resultRefHash,uint256 deliveredAt)`

`requestIdHash` is keccak256 of the request id's UTF-8 bytes. `resultRefHash` is keccak256 of `resultRef`'s UTF-8 bytes, or zero when the delivery names no result location; its file then has no `resultRef`, or `null`. A string that looks like hex, such as `0x61`, is hashed as text and never decoded, so it shares no hash with `a`. The kit, the exporter and the verifier recompute both hashes from the file's plaintext and refuse a receipt where either differs: neither the request id nor the result location can be rewritten without breaking the signature.

**1. Accept before payment.** The agent sends its signed intent file to the provider between steps 4 and 5, before the executor submits it. The provider checks the file and signs a `ServiceAcceptance`:

```bash
FLOAT_PROVIDER_PRIVATE_KEY=... node app/scripts/float-mainnet-provider.mjs accept --intent intent.json \
  --endpoint "https://provider.example/api/ask" --price 1000000 --request-id <the provider's request id> \
  --store provider-store --out acceptance.json --manifest $M
```

`accept` refuses an intent that:

- does not pay this key's address, at this endpoint, at least `--price`;
- is unsigned, or not signed by the agent;
- would not pay now: stale, or predicted to be recorded as a refusal.

The acceptance binds the request id (as `requestIdHash`) to the intent's digest, provider, endpoint hash and principal. `acceptedAt` is the timestamp of the block the checks were read at; in the signed receipt it is the provider's own assertion, not a time the chain records. The digest commits to the provider, the endpoint and the principal, so a paid status for it proves that this exact intent paid this provider.

**2. Serve only a paid digest.** After the executor submits:

```bash
node app/scripts/float-mainnet-provider.mjs check-payment --intent intent.json --acceptance acceptance.json --manifest $M
```

`receiptStatus[digest]` is read from the contract and is authoritative. The provider serves the request only when it is `2` (paid). `blocked` means the contract recorded a refusal and paid nothing; `none` means nothing is paid yet. The `ProviderPaid` event is looked up for reference only: if the lookup fails, for example because an RPC rejects the log range, the command still reports the status, with a hint. `float-mainnet-line.mjs receipt --digest <digest>` reads the same status. With `--acceptance`, the command also checks the acceptance's signature at the block the status was read at, and fails when it does not verify.

**3. Sign the delivery.**

```bash
FLOAT_PROVIDER_PRIVATE_KEY=... node app/scripts/float-mainnet-provider.mjs deliver --acceptance acceptance.json \
  --result-file result.bin --result-ref <where the result is kept> --store provider-store --out delivery.json --manifest $M
```

`deliver` refuses unless the contract records the accepted digest as paid, and only the provider named in the acceptance can sign. When it finds the digest's `ProviderPaid` event, it also refuses unless that payment went to the acceptance's provider for the acceptance's principal. Its output's `crossCheck` says `passed: ...`, or `skipped: <reason>` when the event lookup found nothing or failed; the paid status alone is then all that was checked. The `DeliveryReceipt` carries keccak256 of the result, the accepted request id and, with `--result-ref`, the hash of that location (zero without it). Its `deliveredAt` is the timestamp of the block the payment was read at, again the provider's own assertion in the signed receipt.

**4. Serve each paid digest once.** Providers MUST de-duplicate by digest, not by request id: an agent can retry, or ask again under a new request id, for the same paid digest. The provider's server stores each acceptance, and each result with its receipt, by digest, and a retried or concurrent request for that digest gets the stored ones back: no new work, and no new payment. `--store <dir>` does this for the CLI's receipts (the result itself stays with the provider), with one file per digest for each receipt kind. Each file is written to a temporary file and flushed to disk (`fsync`) before it is hard-linked into place, and the directory is flushed after the link, so a stored receipt is never partial and never replaced. On Windows, where Node cannot flush a directory, a receipt stored just before a power loss may be missing afterwards, never partial. `--store` needs a directory on a filesystem with hard links. `accept` returns the stored acceptance for the same `--request-id`, but only for an intent its agent signed, and refuses any other request id for that digest. `deliver` returns the stored delivery for the same request id, but only for an acceptance that names this provider and carries its valid signature, and refuses a different request id. A stored file naming another provider (a store shared by two keys), digest or request id is refused; a stored file whose signature does not verify is refused. Two concurrent first runs for a digest may both sign, but only one receipt is stored, and that is the one returned. Without `--store`, the output says `deduplication: "none: pass --store, or de-duplicate by digest in your server"`.

**5. A reference server and client.** `examples/float-mainnet-provider-server/server.mjs` (`npm run float:mainnet:provider-server`) serves `POST /accept`, `POST /serve` and `GET /status/<digest>` on the kit's functions, and stores each acceptance, the service's result and each delivery by digest, flushed as above. It answers `422` only for a refused intent (the kit's checks, some repeated before any chain read, and the agent's signature on a retry answered from the store), and a `500` that names only the digest for its own failures. The agent's side is `float-mainnet-request.mjs` (`npm run float:mainnet:request`): `accept --request-id <id>` sends the signed intent before payment; `fetch (--acceptance <file> | --request-id <id>)` never pays, asks only once `receiptStatus` is paid, retries the same digest, and keeps only a delivery bound to the agent's own request. The first request id sent for a digest is the one accepted, whoever sends it: send the intent only to the provider, over TLS, and on an unexpected `409` do not submit the intent; cancel its nonce. Anyone who knows a paid digest can read its result. The server's README lists its limits.

`verify-receipt --file <receipt.json>` checks a receipt's binding and its signature at the latest block.

### 7. Repay, then reclaim

```bash
FLOAT_REPAYER_PRIVATE_KEY=... node app/scripts/float-mainnet-repay.mjs --line-id $LINE --full --execute --manifest $M
FLOAT_SPONSOR_PRIVATE_KEY=... node app/scripts/float-mainnet-sponsor.mjs close --line-id $LINE --execute --manifest $M
```

A partial repayment restores reserve but keeps the line locked. A full repayment reopens it for the next purchase, within the remaining limits; cumulative principal never goes down. `close` returns the whole remaining reserve to the sponsor and ends the line.

## Refusals, defaults and cancellations

- **A qualifying recorded refusal.** The contract records a `SpendBlocked` refusal only for policy checks that run after signature validation. Produce one on purpose while the line is open: a request to an endpoint outside the provider's policy (`ENDPOINT_NOT_ALLOWED`), or a purchase above a limit (for example principal above the remaining reserve or the per-spend cap). Pass `--allow-block` to `build`, `sign` and `submit`. Without it, all three refuse a purchase they predict would be recorded as blocked. The nonce is consumed and the provider is not paid. An expired line can never produce a recorded refusal: `LINE_EXPIRED` is unreachable because the contract reverts first.
- **Default.** After the due date, the sponsor runs `declare-default`. Before then it is refused with the seconds remaining; `--calldata` can prepare it early and reports `executableAt`. Repayment after default goes to the sponsor's recovery balance and never reopens the line. `claim-defaulted` pays out the reserve plus recovery, and explains when there is nothing yet to claim.
- **Cancelling a signed intent.** Run `cancel-nonce --line-id $LINE --nonce <n>`. Smart-account agents use `--calldata --from $AGENT`. An intent signed while the line owed money is not consumed by the resulting revert; it becomes executable again after full repayment, so cancel intents you no longer want.

## Evidence and verification

Three tools, in order: the indexer, the exporter, and an independent verifier. None of them signs anything.

```bash
node app/scripts/float-mainnet-indexer.mjs index --out index.json --manifest $M
node app/scripts/float-mainnet-evidence.mjs export --line-id $LINE --index index.json \
  --intent c1.json --intent c2.json --intent c3.json --intent refusal.json \
  --acceptance a1.json --delivery d1.json --request-id <digest>=<request id> \
  --declared declared.json --out bundle.json --manifest $M
node app/scripts/float-mainnet-verify.mjs verify --bundle bundle.json --manifest <the reviewed release manifest> --out report.json
```

Pass every `--acceptance`, `--delivery` and `--request-id` for each cycle, not only the first.

- **Indexer.** Records every Float event from the manifest's deployment block to a pinned head, with each event's block hash, timestamp, transaction index and transaction sender. `--resume` extends an index from its checkpoint, and rebuilds it if the checkpoint was reorganized away. It keeps the existing events, so it first refuses an index file whose events are not in the indexer's shape, the block hash (lowercase bytes32), timestamp (a decimal string) and transaction index (a number) included.
- **Exporter.** Writes one line's evidence bundle (`ShadowFloatMainnet.EvidenceBundle`, schema 1) and a Markdown summary at `<out>.md` that keeps on-chain records, signed files and declarations apart. It attaches the agent's signed intents and the provider's receipts to the cycles and refusals they belong to, and checks the line's state on-chain against the indexed events. With `--index`, it first checks that each event has the indexer's shape (its block hash, timestamp and transaction index included), a position (block and log index) of its own and a block within the index's range, and orders the events by block and log index. It then reads the line's own events from the chain up to the index's checkpoint and refuses the index unless it holds exactly those, so an edited or truncated index cannot drop or add a record, not even a `SpendBlocked`, which leaves the line's state unchanged. It checks provider receipts with the provider kit's own rules. It refuses a file for another deployment or line, a file that contradicts the line's records, and a signature that does not verify. It also refuses a line with more than one `SponsorClaimed`: schema 1 records a single exit. It checks each signature where the verifier does: an intent at the block before the transaction that recorded it, a receipt at the observed block. A smart account that later rotates its signer therefore cannot fail the export of a genuine bundle. Each intent file must also be exactly the intent and signature in the `executeSpend` calldata of the transaction that recorded it: the exporter refuses one whose message or signature differs (a second valid signature for the same digest included), in the words of the verifier's `intent.matchesCalldata`. As in the verifier, only a transaction sent directly to the Float is decoded, so an intent file for a relayed spend or refusal is not compared. A missing file is recorded as `null` and counted. `--declared` takes a JSON file with any of `independentControl`, `customerPurpose`, `assistance` and `commercial`, copied verbatim.
- **Verifier.** Does not import the indexer or the exporter. It reads only `ARC_RPC_URL`, the bundle and the release manifest, which is required, and re-derives every claim from the chain. Each check is `PASS`, `FAIL`, `MANUAL` (what it cannot check, for example a cycle without its provider receipts, a refusal relayed through a contract, or a rehearsal manifest's provenance) or `DECLARED`. Any `FAIL` exits 1; `MANUAL` and `DECLARED` never pass or fail the report. `ok` means no `FAIL`. `qualifying` means `ok` with nothing `MANUAL` (`DECLARED` does not count): only a qualifying report has checked everything the verifier can check, and only a report against a manifest committed in the verifying checkout can qualify. Even then, the reviewer must confirm where that commit comes from (see "Which manifest").

**Which manifest.** Take `--manifest` from the repository's reviewed release record: a manifest committed at a reviewed commit. Never take it from the bundle's author. `deployment.manifestProvenance` passes only when the bytes the verifier read from `--manifest` are that file as committed at HEAD in this checkout, and it reports the commit that last changed it. The verifier reads the manifest once, hashes those bytes with `git hash-object` through the path's git filters and compares the result with HEAD's blob. An edit hidden from `git status` by `--assume-unchanged` or `--skip-worktree` therefore still fails, and a checkout whose line endings git converted (`core.autocrlf`, `.gitattributes`) still matches. The check also fails if the file changes while the verifier runs. A pass proves only that the manifest is committed in this checkout's history. It does not identify the reviewed deployment: an author can commit a manifest of their own on a local branch, and a reviewer can be on the author's branch. The reviewer must still confirm that the reported commit is on the reviewed upstream branch and that the checkout is that branch; the checkout also supplies the source pins and the verifier itself. Any other manifest is a rehearsal. The check is then `MANUAL` ("rehearsal manifest: not a committed release record"), so the report can be `ok` but never `qualifying`. The anchor checks catch a manifest that is inconsistent with the chain or with the reviewed code. `deployment.manifest` requires a passing manifest and compares its chain, address, runtime code hash, deploy block and source commit with the bundle's. `deployment.artifact` requires the code at the address, with its immutables masked, to equal the local artifact compiled from the pinned reviewed source with the release compiler profile (`contracts/out`, from `forge build`, which the verifier therefore needs). `deployment.config` requires the immutables in that code, `usdc()` among them, to equal the manifest's config. They do not establish which deployment was reviewed. Anyone can write a consistent manifest for a deployment of their own, for example a genuine-bytecode Float with their own token recorded as `config.usdc`, and pass all three. Only its provenance tells such a manifest from the reviewed release, and only once the reviewer has confirmed the reported commit as above.

**Shared building blocks.** The verifier does not use the exporter's or the indexer's code, but it shares building blocks with them and with the manifest tool:

- `validateIntentFile` (intent file rules), `intentDigest` and `messageFromStruct` (the intent tool's digest and message encoding, also applied to the intent decoded from a transaction's calldata), `signatureAt` (the signature rule) and `connectCandidate` (the connection and generation check);
- `readDeployment`, which parses the manifest for `deployment.manifest`;
- the provider kit's `validateReceiptFile` (receipt rules);
- `findLogs`, the same chunked log scan that feeds the indexer and the verifier's completeness checks;
- `floatAbi` (event and calldata decoding), and `read` and `readPolicy` (contract reads);
- the CLI's parse helpers `parseAddress`, `parseBytes32` and `parseUint`, which parse the bundle's fields and the manifest's config;
- the manifest tool's `maskImmutables`, `decodeImmutables`, `immutableWord` (used by `deployment.config` and by the manifest tool) and `IMMUTABLE_GETTERS`, and the `loadArtifact`, `readSourceState`, `pinnedLineageMismatches` and `compilerSettings` it uses;
- the pinned constants `EXPECTED_COMPILER` and `PINNED_SOURCE_COMMIT`/`PINNED_SOURCE_BLOBS`, the same pins the manifest tool records;
- its own `calldataMismatches`, which the exporter also uses to compare each intent file with its transaction's calldata.

So `deployment.artifact` and `deployment.config` re-run the code that produced the manifest rather than checking it independently. A bug in any of these building blocks would affect the other tools and the verifier alike, so the verifier's agreement with them is not independent evidence about them.

What the verifier establishes:

- **On-chain.** The deployment's chain, address and runtime code hash, that they and the deploy block match the release manifest, that the code is the build of the pinned reviewed source with the release compiler profile, and that its immutables and `usdc()` are the manifest's config. The observed block's hash, read before the other checks and again after every other chain read: state reads are pinned by block number, so a reorg of that block during the run fails `observedAt.blockHash` ("the observation block was reorganized during verification"). The line's opening, id, sponsor, agent and epoch. Every `ProviderPaid`, `SpendBlocked`, `Repaid` and exit event for the line up to the observed block is in the bundle, and the bundle lists no other; the cycles are listed in the order the chain paid them, so cycle 1 is the line's first payment. Each payment's USDC transfer to the provider and the transaction's sender. Each spend's and refusal's transaction is an `executeSpend` call sent directly to the Float whose intent, decoded from its calldata, recomputes to the recorded digest for this chain and Float (`cycle[i].spend.calldata`, `refusal[j].calldata`; a relayed refusal leaves the latter `MANUAL`). Each repayment's payer, amount and USDC transfer. For each refusal, that no USDC left the Float for it: its transaction may also carry other Float calls (a batch that closes a line, say), so every USDC transfer out of the Float in it must be the payment of another Float event there (a `ProviderPaid` principal to its provider, a `LineClosed` or `SponsorClaimed` amount to its sponsor, each event explaining one earlier transfer), and no `ProviderPaid` in it may carry the refused digest. The line's state before each spend and at the observed block. The exporter's summary, recomputed rather than trusted; an intent file without a signature counts as missing, so stripping a signature fails the summary instead of only leaving a check `MANUAL`.
- **Against the bundle's signatures only.** Each intent file, for a paid cycle or a refusal, recomputes to the recorded digest and carries a valid agent signature (ECDSA, or ERC-1271 for a smart account). Each signature is checked at the block before its spend or refusal. Each provider acceptance and delivery receipt is an EIP-712 signature by the paid provider that binds its request id to the digest, and each delivery also its result hash and result location. The acceptance names the paid principal and the endpoint the intent names (in its file or, without the file, in the spend's calldata) or, when neither gives an intent, the endpoint the provider's policy approved at the block before the spend. `acceptedAt` and `deliveredAt` are the provider's own assertions: the provider asserts it accepted before payment and delivered after it, and the verifier only compares those times with the payment block's timestamp. The chain records no request id or result, so a missing provider receipt cannot be recovered from it; a missing intent file can be, from the transaction's calldata (below). A delivery receipt is the provider's own statement that it served the request, not proof of the result's content or quality.
- **From the transaction calldata.** The Float pays, and records a refusal, only in `executeSpend(intent, signature)`, so a spend or refusal sent directly to the Float carries the intent it executed and the agent's signature in its calldata. With the bundle's intent file, the verifier requires the file's message and signature to equal the calldata's exactly (`cycle[i].intent.matchesCalldata`, `refusal[j].intent.matchesCalldata`): a file with any field or its signature different fails, and so do a file without a signature and a second valid signature for the same digest. Without the file, the intent checks (`intent.digest`, `intent.fields`, `spend.executor`, `intent.signature` and `state.termsHash` for a cycle; `intent.digest` and `intent.signature` for a refusal) run on the decoded intent and signature instead of being `MANUAL`. These calldata-path intent checks mostly re-confirm conditions the contract already enforced when it emitted the event, since it recomputed the digest from that intent and validated that signature; the new evidence is `spend.calldata`, `refusal.calldata` and `intent.matchesCalldata`. Each such detail says the intent came from the transaction calldata, and the report lists those checks under `scope.verifiedOnChain` and again under `scope.intentFromCalldata`. The exporter's `missingIntentFiles` still counts the file as missing from the bundle, and the verifier still recomputes it, but a bundle with missing intent files can now be `qualifying`. The limit: only a transaction sent directly to the Float is decoded. A spend relayed through a Safe, a 4337 account or another contract fails the direct-call rule (`spend.receipt`, `spend.calldata`), so its report is not `ok`, even though its `intent.matchesCalldata` shows only `MANUAL`: there is no direct call to compare the file with. A relayed refusal leaves `refusal[j].calldata` and its `intent.matchesCalldata` `MANUAL`, and without its file its intent checks stay `MANUAL`.
- **Declared only.** Independent control, customer purpose, assistance and commercial terms are copied from the operator's declaration and reported as `DECLARED`. They are neither verified nor verifiable on-chain. The declaration's label must be the exporter's fixed label.

The bundle's shape is strict: an unknown key in any of its own objects, its declaration included, another `declared.label`, or a cycle `index` other than its place in the bundle (the JSON numbers 1, 2, ... in order, as the exporter writes them) fails `bundle.shape`. The report's `afterObservedAt` counts the line's events after the observed block, up to `scannedTo`: the `head` it names, or 1,000,000 blocks past the observed block when the head is further, with `truncated: true`. It is informational: a bundle pinned at an older block still verifies, and this shows what it leaves out.

Requirements and known limits:

- **Archive RPC.** Code, state and signatures are read at historical blocks, so the RPC must serve archive state.
- **A repository checkout with a build.** The verifier compares the deployed code with `contracts/out` and checks that the build was compiled from the pinned reviewed source files; it reads them, and runs `git`, in the checkout. A qualifying report also needs the release manifest committed in that checkout.
- **One exit per bundle.** The exporter refuses a line with more than one `SponsorClaimed`, and the verifier fails a bundle whose line has more than one exit event.
- **Same-block activity.** Pre-spend state and signatures are read at the end of the block before the spend, so the verifier cannot tell apart two transactions on the line in one block.
- **Contract executors.** The spend checks require the executor to send `executeSpend` directly to the Float. A spend relayed through a Safe or another contract fails them. Only a direct call's calldata is decoded, so a relayed refusal's intent is neither compared with nor recovered from its calldata.

## What is checked, and what is not yet

Tested end to end on anvil through these CLIs, unless noted (`npm run float:mainnet:tools:test`):

- allowlisting, opening, status, build, sign, verify, preflight, paid submission;
- a duplicate submission sends nothing;
- a build while the line owes money is refused;
- repayment, receipt lookup, a deliberate over-cap refusal, close and reclaim;
- the default path;
- stale-terms and wrong-generation rejection;
- a deployed ERC-1271 agent;
- keyless calldata modes;
- a receipt lookup through an RPC that rejects log ranges over 10,000 blocks;
- a send whose outcome is unknown, a follow-up read that fails after a mined transaction, and a race lost to another executor, each reporting the transaction hashes;
- the new expiry floors, and the refusal of an intent that outlives its provider policy;
- provider acceptance before payment, and its refusal of an intent for another provider or endpoint, below the price, unsigned, or predicted to be refused;
- no delivery receipt for an unpaid or refused digest, or for an acceptance whose provider or principal the digest's `ProviderPaid` contradicts; an ERC-1271 provider's receipts; a receipt whose plaintext request id or result location is rewritten (to a hex-looking form such as `0x61` for `a` included) or whose location is dropped is rejected, and a delivery without `--result-ref` verifies;
- a retried request answered with the stored result and receipt and no new work, through a local stub provider server built on the kit's exported functions; concurrent first requests for one digest get one acceptance (other request ids refused) and one piece of work;
- `accept --store` and `deliver --store` returning the stored acceptance and delivery for a digest, and refusing a second request id for it, a stored receipt naming another provider (in a store shared with another key), a stored file under another digest's name, and a stored acceptance that another key signed; a leftover temporary file is ignored;
- indexing, resuming from a checkpoint, and rebuilding after a reorg; an export from an index with its events out of order, and the refusal of a malformed one (unit-tested: two events at one position, an event outside the index's blocks, a block number with a leading zero, or a missing or malformed block hash, timestamp or transaction index, which `index --resume` also refuses);
- the evidence round trip. A pilot line with three purchases on separate UTC days (one repaid in two parts), a recorded refusal and a close, with a release manifest from `float-mainnet-manifest.mjs`, is indexed, exported and verified. The report is `ok`, and every check passes except `deployment.manifestProvenance`, which is `MANUAL`: the test's manifest is a temporary rehearsal file, not a committed release record, so the report is not qualifying. A dropped cycle, an altered repayment, swapped delivery receipts, a rewritten result location, a replaced intent signature (on a cycle or a refusal, which also fails `intent.matchesCalldata`), a refusal's intent file with a field changed and an edited exporter summary each fail at their own check; an edited declaration does not. A cycle and the refusal exported without their intent files verify from their transactions' calldata: their intent checks pass, and only the manifest's provenance keeps the report from qualifying;
- verifier tampers, each failing at its own check: the observed block's hash, a missing exit, the spend's executor, an acceptance's principal, endpoint (with and without the intent file) or time, a delivery's time, a refusal's reason, a fabricated repayment, a stripped intent signature (which also fails `intent.matchesCalldata`), an intent file whose field differs from its transaction's calldata, or whose signature does (a second valid ERC-1271 signature for the same digest included, which fails `intent.matchesCalldata` alone), a cycle pointed at another cycle's `executeSpend` transaction (`spend.calldata`, and `intent.digest` without its file), a rewritten result location (a delivery that names none verifies), an unknown key (the declaration's included), another declaration label, and a cycle index that is changed, duplicated or not a number; a reorg of the observation block during the run fails `observedAt.blockHash` alone; an RPC failing mid-run fails the checks that needed it, and each log scan stops at its first failed call; a bundle observed before a later repayment still verifies and reports it; a cycle and a refusal without their intent files, and a smart-account cycle without its file (through `isValidSignature`), verify from their calldata; a spend or a refusal pointed at a `repay` transaction fails its calldata check ("calls repay on the Float, not executeSpend"), and a refusal pointed at a transaction to another contract (a USDC mint) leaves `refusal[0].calldata` and `intent.matchesCalldata` `MANUAL`, and, without its file, its intent checks; a genuine refusal relayed through a minimal forwarder contract verifies `ok` but not qualifying, with its calldata `MANUAL`, and a spend relayed through the same forwarder fails `spend.receipt` and `spend.calldata`;
- the manifest anchors: a manifest naming a genuine-bytecode Float deployed with its own token, but carrying the reviewed config, fails `deployment.config`; a Float whose runtime differs from the artifact by one byte outside its immutables fails `deployment.artifact`; a manifest that records that Float's own token as its config passes every anchor check, and its provenance alone (`MANUAL`, since it is not committed) keeps the report from qualifying; a manifest file that changes while the verifier runs fails `deployment.manifestProvenance`. Repayment-to-log matching, a refusal's USDC accounting (a refusal alone or batched with a close, another paid spend and a claim passes; an unexplained, reused, wrong-amount, wrong-payee or later transfer, or a `ProviderPaid` for the refused digest, fails), the comparison of an intent file with its calldata (each SpendIntent field, the signature, a missing signature) and the provenance check are also unit-tested: a file outside the checkout, a gitignored build file inside it, and other bytes for a tracked file are not passed; in a scratch repository, a committed file passes, and an edit fails it, even one hidden from `git status` by `--skip-worktree`;
- the export of a smart-account agent's cycle after the account rotated its signer (simulated by replacing the account's code), and the refusal of that cycle's intent file re-signed with the high-s twin of the account's signature, which the account accepted but the spend's calldata does not carry.

The end-to-end suites need Foundry's `anvil` and fail without it; set `FLOAT_E2E_OPTIONAL=1` to skip them instead.

Not yet validated, and required before pilot claims:

- signing with a real Circle Agent Wallet on Arc testnet;
- a real provider adopting the acceptance and delivery protocol, including storing results by digest so that an interrupted request can be retried (tested only against the local stub and `--store`);
- any run by an independent participant.
