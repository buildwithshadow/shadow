# Shadow Float Mainnet Candidate: Participant Tools

Status, 2026-09-18: the `ShadowFloatMainnet` candidate is **not deployed** on any network. These tools are tested end to end on a local chain only. The deployment values they were tested with are proposals pending owner approval. Nothing in this guide authorizes a deployment, a funded line or a public claim.

These command-line tools let each pilot participant run their own part of the lifecycle with their own key. No Shadow engineer builds or signs a participant's transaction (roadmap, "Candidate participant tools"). They target the candidate contract only. They reject a V2 address, a V2 intent file, the wrong chain, and any contract that does not report the candidate's own EIP-712 name, version and `SpendIntent` typehash.

## Roles

| Role | Tool | Key (env, read only by commands that sign, never printed) |
| --- | --- | --- |
| Owner (a Safe in production) | `float-mainnet-owner.mjs` | `FLOAT_OWNER_PRIVATE_KEY`, or none with `--calldata --from <safe>` |
| Sponsor | `float-mainnet-sponsor.mjs` | `FLOAT_SPONSOR_PRIVATE_KEY` |
| Agent | `float-mainnet-intent.mjs`, `float-mainnet-cancel-nonce.mjs` | `FLOAT_AGENT_PRIVATE_KEY` (EOA agents), or an external signer for smart-account agents |
| Executor (relayer) | `float-mainnet-submit.mjs` | `FLOAT_EXECUTOR_PRIVATE_KEY`, or none with `--calldata --from <executor>` |
| Repayer (anyone) | `float-mainnet-repay.mjs` | `FLOAT_REPAYER_PRIVATE_KEY`, falling back to `FLOAT_AGENT_PRIVATE_KEY` |
| Anyone, read only | `float-mainnet-line.mjs` | none |

## Setup

Node 20.12 or later. On Windows, use Node 22, or 24.20.0 or later: Node 23.0–24.19 can abort with exit code `0xC0000409` after HTTP requests, often with no output (nodejs/node#56645, fixed in 24.20.0 by #61999). The tools live in `app/scripts/` and use the app's `viem`:

```bash
cd app && pnpm install --frozen-lockfile --ignore-workspace && cd ..
export ARC_RPC_URL=https://rpc.testnet.arc.io
export FLOAT_MAINNET_EXPECTED_CHAIN_ID=5042002
```

Name the deployment with the release manifest from `docs/SHADOW_FLOAT_MAINNET_TESTNET_DEPLOYMENT.md` §5: `--manifest float-mainnet-arc-testnet.manifest.json` on every command. A manifest is used only if it passed (`ok: true`), is for the expected chain, and its recorded runtime code hash equals the code at the address. It also gives log lookups a lower bound. `FLOAT_MAINNET_ADDRESS=<address>` works without a manifest, with the generation checks only.

## Conventions

- **Dry run by default.** A write command simulates from the signer's address and prints the calls. `--execute` sends them, waits for each receipt, and prints the transaction hashes and decoded Float events. `--calldata --from <address>` needs no key and prints `{to, value, data}` for a Safe or an external wallet.
- **One JSON object** on stdout per run. Exit 0 on success, 1 on failure (`{ok:false, error:{message, revert}}`, where `revert` is the contract's custom error name), and 2 on a usage error, with the tool's full usage.
- **Amounts** are atomic USDC (6 decimals): `1000000` is 1 USDC. **Times** (`<t>`) are unix seconds or `+<seconds>` after the latest block, never wall-clock time. **Durations** are bare seconds.
- **Endpoints.** The contract compares endpoint hashes for equality only. Convention for the candidate: `--endpoint "<exact string>"` is hashed as keccak256 of its UTF-8 bytes. `--endpoint-hash` takes the raw bytes32. Sponsor and provider must agree on the exact string.
- **Unclear sends.** Every tool signs before broadcasting, so it knows the transaction hash in advance. It never resends. If a send or wait fails without a clear outcome, the tool reports `status: "unknown"` with the hash. For `submit`, it also reports the digest's `receiptStatus`, or `"unreadable"` if the RPC is down. If a transaction was mined but a follow-up read failed, the tool reports `status: "sent"` with every hash. In either case, check the hashes, or run `float-mainnet-line.mjs receipt --digest`, before running again.

## The lifecycle

The shell variables below (`$SPONSOR`, `$AGENT`, `$PROVIDER`, `$EXECUTOR`, `$LINE`, `$M`) stand for your own addresses, your line ID and your manifest path.

### 1. Owner allowlists the sponsor

```bash
node app/scripts/float-mainnet-owner.mjs allow-sponsor --sponsor $SPONSOR --calldata --from $SAFE --manifest $M
```

The printed call goes into the Safe. With `FLOAT_OWNER_PRIVATE_KEY` set, `--execute` sends it directly. `pause --what openings|spends` can also be sent by an operator; `unpause` is owner-only.

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

**Smart-account agents (for example a Circle Agent Wallet).** The contract checks an ERC-1271 signature only when the agent address already has code. An undeployed smart account always fails, so deploy it before submitting. Sign the file's `externalSignerTypedData` (eth_signTypedData_v4 JSON) with the wallet, then attach the signature:

```bash
node app/scripts/float-mainnet-intent.mjs verify --intent intent.json --signature <hex> --out intent.json --manifest $M
```

That Circle's `circle wallet sign typed-data` works on Arc testnet and returns a signature the account validates for this digest is **not yet demonstrated**. It is the roadmap's two-day compatibility experiment.

### 5. Executor submits

```bash
FLOAT_EXECUTOR_PRIVATE_KEY=... node app/scripts/float-mainnet-submit.mjs preflight --intent intent.json --manifest $M
FLOAT_EXECUTOR_PRIVATE_KEY=... node app/scripts/float-mainnet-submit.mjs submit --intent intent.json --execute --manifest $M
```

`preflight` reads the receipt status and simulates `executeSpend` from the executor. The result is `pay`, `block` (with the reason the contract would record), `revert` (with the error, for example `InvalidState` while the line owes money, or `StaleTerms`), `already-paid` or `already-blocked`.

Dry runs and `--calldata` output include `simulatedAt`, the block the simulation was taken at: a Safe executing later should simulate again. `submit` never sends an intent whose digest is already recorded. It never sends a simulated revert, and sends a simulated block only with `--allow-block`. The result is `paid` (with the provider payment) or `blocked` (with the reason). If an intent names an executor, only that address can submit it.

### 6. Provider checks the payment

```bash
node app/scripts/float-mainnet-line.mjs receipt --digest <digest from intent.json> --manifest $M
```

A `paid` receipt carries the `ProviderPaid` event: provider, principal and due date for that digest. `receiptStatus` is read from the contract and is authoritative. If the event lookup fails (for example because an RPC rejects the log range), the command still reports the status, with `event: null` and a hint. The provider serves the request tied to that digest; how a request is tied to a digest is agreed before the first purchase. No provider-side acceptance kit is included here.

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

## What is checked, and what is not yet

Tested end to end on anvil through these CLIs only (`npm run float:mainnet:tools:test`):

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
- the new expiry floors, and the refusal of an intent that outlives its provider policy.

The end-to-end suites need Foundry's `anvil` and fail without it; set `FLOAT_E2E_OPTIONAL=1` to skip them instead.

Not yet validated, and required by the roadmap before pilot claims:

- signing with a real Circle Agent Wallet on Arc testnet;
- a provider accepting a request-bound payment proof;
- recovery of an interrupted provider request;
- a per-cycle evidence export;
- any run by an independent participant.
