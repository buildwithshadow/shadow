# Shadow Float Mainnet Pilot Lifecycle Test Plan

Status: proposed. The pinned values below await owner approval. Arc testnet deployment of `ShadowFloatMainnet` is not authorized, and nothing in this plan has been executed onchain. All results come from Foundry's local test EVM with a mock six-decimal USDC.

Scope: the lifecycle test plan assigned in the 18 September 2026 accelerator roadmap (version 3, "First 48 hours", item 2). It covers the roadmap's "First technical experiment" and the pilot completion rule in [`MAINNET_PATH.md`](MAINNET_PATH.md) Phase 1: three spend-and-repay cycles on separate occasions, one genuine policy block with no provider transfer, and a final sponsor reserve reclaim. Contract source: `contracts/src/ShadowFloatMainnet.sol` at `2ebae7f`.

```sh
forge test --root contracts --match-path 'test/ShadowFloatMainnet*.t.sol' -vv
node contracts/test/mainnet-scope.test.mjs
```

Result on 2026-09-18: 54 passed, 0 failed across the 4 suites the glob matches (36 candidate + 5 token-safety + 12 pilot lifecycle + 1 deployment-script scenario test). The scope gate passed at 14,674 runtime bytes.

## 1. Pinned values (proposed)

### Deployment constructor

| Parameter | Immutable maximum | Initial effective |
| --- | --- | --- |
| `protocolReserve` | 50 USDC | 25 USDC |
| `lineReserve` | 10 USDC | 5 USDC |
| `lineSpend` (cumulative per line) | 10 USDC | 5 USDC |
| `perSpend` | 2 USDC | 1 USDC |
| `dailySpend` (per line) | 4 USDC | 2 USDC |
| `minimumRepaymentWindow` | 1 hour | — |
| `maximumRepaymentWindow` | 7 days | — |
| `governanceDelay` | 2 days | — |
| `expectedChainId` | `5042002` (Arc testnet). The tests use `block.chainid` | — |
| `usdc` | Arc testnet USDC `0x3600000000000000000000000000000000000000` per [`ARC_LIVE.md`](ARC_LIVE.md). Before deploying, preflight must confirm its code, `decimals() == 6` and the chain ID. This is a testnet value and must never become a mainnet default (spec §8) | — |

The initial effective values match the founder-canary recommendation in spec §7 (25 / 5 / 1 / 2 USDC), plus a 5 USDC cumulative line-spend cap. Each maximum is twice its initial value. Raising a cap requires `proposeCapIncrease`, the 2-day delay and then `activateCapIncrease`, and it can never exceed the maximum.

### Pilot line (sponsor's `openLine`)

| Field | Value |
| --- | --- |
| `reserve` | 1 USDC |
| `lineSpendCap` | 3 USDC |
| `dailySpendCap` | 1 USDC |
| `lineExpiry` | open + 60 days |
| `maximumRepaymentWindow` | 7 days |
| `providerPerSpendCap` | 1 USDC |
| `providerDailyCap` | 1 USDC |
| `providerExpiry` | open + 60 days |
| Principal per purchase | 1 USDC, a pilot price convention. The contract enforces only the 1 USDC maximum |

The sponsor and agent use distinct addresses. The owner allowlists the sponsor with `setSponsorAllowed`.

### What these limits bound

The caps bound principal, not purchase count: 3 USDC cumulative principal per line; three purchases at the pilot's 1-USDC price convention.

- **Exposure is capped at the reserve.** Each line allows one outstanding draw (`executeSpend` reverts `InvalidState` while the line is `DRAWN`), and the reserve is 1 USDC. The sponsor therefore never has more than 1 USDC outstanding.
- **No purchase exceeds 1 USDC.** Both the provider policy and the global effective per-spend limit are 1 USDC.
- **At most 1 USDC of principal per UTC day.** The line and provider daily caps are both 1 USDC. Two 0.5 USDC purchase-and-repay cycles fit in one UTC day, and a third 0.5 USDC purchase that day is a recorded `DAILY_SPEND_CAP` block (`testPinnedDailyCapBoundsAmountNotPurchaseCount`). At the 1-USDC convention that is one purchase per day. The contract's day is `block.timestamp / 86400` (a UTC calendar day, not a rolling 24 hours), so purchases at 23:59:59 and 00:00:00 count as different days. A day boundary does not prove "separate occasions"; the evidence log has to show that independently.
- **3 USDC cumulative principal per line epoch.** Repayment never reduces `cumulativePrincipalPaid`, so the 3 USDC `lineSpendCap` caps total principal per line epoch: three 1 USDC purchases, or six 0.5 USDC ones. At the 1-USDC convention a fourth attempt is a recorded `LINE_SPEND_CAP` block, even for 1 atomic unit. `_blockReason` checks cumulative spend before the daily cap, so once 3 USDC has been spent the reason is `LINE_SPEND_CAP` on any day. Before that, a 1 USDC purchase on a day that already had one is refused with `DAILY_SPEND_CAP`.
- **Purchases stop 1 hour before expiry.** The 60-day terms bound the pilot window. A signed `dueAt` must be at least submission time + 1 hour and no later than `lineExpiry`, so purchases stop one minimum repayment window before expiry. A late purchase also gets a shorter repayment window.
- **The 3 USDC cap is a sponsor term, not an immutable limit.** Only the sponsor can call `updateLineTerms`, which works while the line is `OPEN` or `DRAWN`. It can raise `lineSpendCap` up to the effective `lineSpend`: 5 USDC now, or at most 10 USDC after a delayed governance increase. Each such change increments `termsVersion` and invalidates every earlier signature. A governance increase never raises a line's own cap. Without a sponsor terms change, further purchases need a new line epoch (close, then open).

## 2. Contract tests

| File | Tests |
| --- | --- |
| `contracts/test/ShadowFloatMainnetPilotLifecycle.t.sol` | 12: lifecycle with the pinned values |
| `contracts/test/ShadowFloatMainnet.t.sol` | 36: candidate suite |
| `contracts/test/ShadowFloatMainnetTokenSafety.t.sol` | 5: token behaviour |
| `contracts/test/ShadowFloatMainnetDeployScript.t.sol` | 1: deployment-script env scenarios, run in sequence in one function because env is process-global |

**How the lifecycle tests are built:**

- **Paid purchases.** The agent signs each purchase with `executor` bound to a separate address, and that executor submits it.
- **Reverts.** Assertions check the exact custom-error selector.
- **Recorded refusals.** Assertions check:
  - the `SpendBlocked(digest, lineId, nonce, reason)` event;
  - `receiptStatus == 1` and a consumed nonce;
  - no USDC `Transfer` or `ProviderPaid` log;
  - unchanged line accounting and daily usage;
  - that resubmitting the same intent reverts `NonceUnavailable`.

Mutation checks against altered copies of the contract were informal, are not reproducible from the repository, and no result is claimed for them.

## 3. Roadmap path mapping

These are steps 1–7 of the roadmap's "complete useful path" (lines 100–108 of the 18 September version). The evidence column uses the rows of the roadmap's evidence table (lines 122–130).

| Step | Contract tests | Expected events and state | Evidence to capture |
| --- | --- | --- | --- |
| 1. Sponsor funds a line and approves its provider policy | `testPilotPathThreeCyclesOneRefusalAndSponsorReclaim`, `testPinnedDeploymentAndPilotLineConfiguration`, `testImmutableMaximaAndOpeningCapsAreEnforced`, `testInboundFalseMalformedRevertAndNonExactAreAtomic` | An unlisted sponsor's `openLine` reverts `Unauthorized`. After allowlisting: `LineOpened(lineId, sponsor, agent, 1, 1e6, 1)` and `ProviderPolicySet(lineId, provider, endpointHash, 1e6, 1e6, expiry, true, 1)`. State `OPEN`, `availableReserve = 1e6`, `totalCommittedCapital` up by 1e6, contract USDC balance equal to `totalSponsorObligations` | Technical binding: deployment address and verified source, chain ID, line ID, `termsVersion`, `currentTermsHash(lineId, provider)`, allowlist and open transaction hashes. Independent control: who controls the sponsor wallet and who initiated the open. Assistance: who supplied test USDC |
| 2. A Circle Agent Wallet signs the exact authorization | Contract side only: `testDeployedSmartAccountAgentCompletesCycle`, `testUndeployedSmartAccountAgentIsRejectedUntilDeployed`, `testERC1271RejectsBadResponsesAndAllowsCaughtReentryOnce`, `testAllSignedFieldsBindAndExecutorIsEnforced`, `testContractDomainChangesDigest`, `test_RED_02_oldSignatureCannotExecuteAfterCloseAndReopen`, `test_RED_04_feeOrTermsChangeInvalidatesPriorSignature` | Agent with code: `isValidSignature(hashSpendIntent(intent), signature)` must return `0x1626ba7e`. Agent without code: only a 65-byte, low-s ECDSA signature that recovers to the agent address is accepted. A smart-account signature for an account not yet deployed reverts `InvalidSignature`, with no nonce or receipt used. Once the account's code exists at that address, the unchanged intent and signature pay | Technical binding: agent address, account deployment transaction, and the signed EIP-712 payload (domain `ShadowFloatMainnet`, version `1`, chain `5042002`, candidate address). Independent control: who holds the wallet's signing credential. Live validation required (section 5) |
| 3. A permitted executor submits; the contract validates signature and terms | `testPilotPathThreeCyclesOneRefusalAndSponsorReclaim`, `testAllSignedFieldsBindAndExecutorIsEnforced`, `testCrossProviderTermsCannotBeSubstituted`, `testCanonicalEOASignatureRules`, `testSignatureExpiryIsInclusiveAndExpiredIntentFails`, `testDebtAndDueAtBoundsAreEnforcedWithoutConsumingNonce` | Success returns `(true, NONE)`. Stale terms revert `StaleTerms`. A wrong executor, expired signature, out-of-window `dueAt` or debt above the signed bound reverts `InvalidIntent`. A bad signature reverts `InvalidSignature`. None of these consumes the nonce | Technical binding: submit transaction hash, executor address, digest. Independent control: who operates the executor |
| 4. The provider accepts a request-bound payment proof and returns the service | None; this is not a contract property. The contract supplies `ProviderPaid(digest, lineId, provider, principal, dueAt)` and `receiptStatus(digest) == 2` | Provider-side | Useful result: provider request identifier, payment acceptance, delivered result reference. Customer purpose. Live validation required (section 5) |
| 5. Debt and reserve accounting match the payment | Every paid purchase in the lifecycle file, plus `testAggregateAccountingTracksSponsorObligations`, `testFuzz_AccountingRemainsExactAfterPartialRepayment`, `testFuzz_ConcurrentSequenceMaintainsIsolation`, `testOutgoingFailuresLeaveNonceDebtAndFundsUnchanged` | `ProviderPaid(digest, lineId, provider, 1e6, dueAt)`. Provider balance up by exactly 1e6. State `DRAWN`, `principalOutstanding = 1e6`, `availableReserve = 0`, `cumulativePrincipalPaid` up by 1e6, `spentToday = 1e6`, `dueAt` equal to the signed value, `receiptStatus = 2`, nonce used. Contract balance equal to `totalSponsorObligations` | Obligations and exit: debt opened and `dueAt`. Technical binding: transaction hash, block, and post-state reads of `getLine` |
| 6. Full repayment clears the debt; the next purchase is subject to the remaining limits | `testPilotPathThreeCyclesOneRefusalAndSponsorReclaim`, `testPinnedLimitsCapCumulativePrincipalAtThreeUsdc`, `testPinnedDailyCapBoundsAmountNotPurchaseCount`, `testSecondDrawWhileDrawnRevertsWithoutConsumingNonce`, `testPurchasesStopOneRepaymentWindowBeforeLineExpiry`, `testCumulativeLineSpendDoesNotReplenishAfterRepayment`, `testPerSpendAndDailyBoundaries`, `testProviderPolicyEditCannotResetSameDayUsage`, `testPolicyBlockConsumesNonceAndCannotPayAfterUnpause`, `testAllowlistEndpointProviderAndCapBlocksAreTerminal` | `Repaid(lineId, payer, 1e6, 0)`. State `OPEN`, `dueAt = 0`, `availableReserve = 1e6`, `cumulativePrincipalPaid` unchanged. At the 1-USDC convention, the next purchase is a recorded `DAILY_SPEND_CAP` block on the same UTC day, and a recorded `LINE_SPEND_CAP` block once 3 USDC cumulative principal has been spent. After `lineExpiry − 1 hour` it reverts `InvalidIntent` | Obligations and exit: repayment source and transaction, debt clearance, remaining limits read from `getLine` |
| 7. The sponsor reclaims the reserve after the debt clears | `testPilotPathThreeCyclesOneRefusalAndSponsorReclaim`, `testDeployedSmartAccountAgentCompletesCycle`, `testPurchasesStopOneRepaymentWindowBeforeLineExpiry`, `test_RED_01_legacyOwnerCreditCannotConsumeSponsoredReserve`, `test_RED_05_pauseCannotBlockRepaymentOrReclaim` | `closeLine` reverts `InvalidState` while the line is `DRAWN`. After full repayment: `LineClosed(lineId, sponsor, 1e6)`, state `CLOSED`, sponsor balance restored exactly, `totalCommittedCapital` and `totalSponsorObligations` each down by 1e6. Close still works after line expiry and under both pauses | Obligations and exit: final reclaim transaction and amount. Independent control: the sponsor initiated it |

## 4. Additional checks

These are the checks the roadmap adds in lines 110–112.

| Check | Contract tests | Expected result |
| --- | --- | --- |
| Refused purchase, no provider transfer | `testPolicyRefusalWhileOpenIsRecordedAndCostsNoCapacity`, `testPilotPathThreeCyclesOneRefusalAndSponsorReclaim`, `testPinnedLimitsCapCumulativePrincipalAtThreeUsdc`, `testAllowlistEndpointProviderAndCapBlocksAreTerminal`, `testPolicyBlockConsumesNonceAndCannotPayAfterUnpause`, `testSpendAboveFundedReserveBlocksTerminally` | Returns `(false, reason)` and emits `SpendBlocked(digest, lineId, nonce, reason)`. `receiptStatus = 1` and the nonce is consumed. No transfer; line accounting and daily usage are unchanged. Resubmitting reverts `NonceUnavailable`, and approving that endpoint later makes a resubmission revert `StaleTerms`. The refusal does not use up a purchase: a fresh intent pays the same day |
| Duplicate submission | `testPaidIntentCannotPayTwiceEvenAfterRepayment`, `testCancelledNonceAndDuplicateSubmissionCannotPay`, `testTokenCallbackCannotReenterButOuterPaymentCompletesOnce` | Resubmitting a paid intent reverts `NonceUnavailable` while `DRAWN`, after full repayment and on a later day. The provider is paid once and `receiptStatus` stays 2 |
| Ambiguous or interrupted request (contract part) | `testPaidIntentCannotPayTwiceEvenAfterRepayment`, `testOutgoingFailuresLeaveNonceDebtAndFundsUnchanged` | Before any retry, read `receiptStatus(hashSpendIntent(intent))` and `nonceUsed(lineId, nonce)`. 2 means paid: recover the service from the provider and do not sign again. 1 means refused. 0 with the nonce unused means not executed: resubmit the same signed intent, or have the agent call `cancelNonce`. A failed token transfer consumes nothing. The contract does not link payments to provider requests, so a new intent for the same request is a new purchase |
| Recorded blocks versus reverts | `testSecondDrawWhileDrawnRevertsWithoutConsumingNonce`, `testUndeployedSmartAccountAgentIsRejectedUntilDeployed`, `testDefaultPathOnSeparateLineRoutesRecoveryToSponsor`, `testPurchasesStopOneRepaymentWindowBeforeLineExpiry`, `testCanonicalEOASignatureRules`, `testDebtAndDueAtBoundsAreEnforcedWithoutConsumingNonce` | See the outcome list after this table |
| Second draw while debt remains | `testSecondDrawWhileDrawnRevertsWithoutConsumingNonce`, `testSecondDrawRevertsWithoutConsumingQueuedAuthorization` | Reverts `InvalidState`; the nonce and receipt are untouched. The same signed intent pays after full repayment on the next UTC day. On the same UTC day it would instead be a recorded `DAILY_SPEND_CAP` block that uses up the intent |
| Partial repayment restores reserve accounting but allows no new draw | `testPartialRepaymentRestoresReserveButKeepsLineDrawn`, `testFuzz_AccountingRemainsExactAfterPartialRepayment` | After repaying 0.4 USDC: reserve 0.4, debt 0.6, state `DRAWN`, `dueAt` unchanged. A 0.4 USDC purchase that fits the restored reserve still reverts `InvalidState` the next day |
| Remaining limits after full repayment (cumulative, daily, expiry, policy, pause, sponsor eligibility) | `testPinnedLimitsCapCumulativePrincipalAtThreeUsdc`, `testPinnedDailyCapBoundsAmountNotPurchaseCount`, `testPurchasesStopOneRepaymentWindowBeforeLineExpiry`, `testPerSpendAndDailyBoundaries`, `testAllowlistEndpointProviderAndCapBlocksAreTerminal`, `testPolicyBlockConsumesNonceAndCannotPayAfterUnpause`, `testCumulativeLineSpendDoesNotReplenishAfterRepayment` | Every limit still applies after the debt clears. Repayment never resets cumulative principal |
| Maturity, default and recovery (tested on a separate line in the tests; the pilot line is never defaulted) | `testDefaultPathOnSeparateLineRoutesRecoveryToSponsor`, `testDefaultSucceedsExactlyAtMaturityAndOnlyOnce`, `testPostDefaultRepaymentBecomesSponsorRecovery`, `test_RED_03_defaultCannotExecuteBeforeMaturity`, `testRepaymentImmediatelyBeforeMaturity`, `testPartialAndFullRepaymentExactlyAtMaturity`, `testPartialAndFullRepaymentAfterMaturityBeforeExpiry`, `testPartialAndFullRepaymentAfterLineExpiryBeforeDefault` | `declareDefault` reverts `TooEarly` at `dueAt − 1`. At `dueAt` it emits `LineDefaulted(lineId, 1e6, dueAt)` and the state becomes `DEFAULTED`. Because the pinned line is fully drawn, `claimDefaulted` reverts `InvalidAmount` until the agent repays something. Repayments after default accrue to `recoveryAvailable` and never reopen the line: a purchase still reverts `InvalidIntent` after full repayment. `claimDefaulted` pays exactly `availableReserve + recoveryAvailable` and emits `SponsorClaimed` |
| Wallet signatures, deployed-account behaviour, chain binding | `testDeployedSmartAccountAgentCompletesCycle`, `testUndeployedSmartAccountAgentIsRejectedUntilDeployed`, `testContractDomainChangesDigest`, `testConstructorRejectsWrongTokenDecimalsAndChain` | Contract side only; see section 5 |

**Recorded blocks versus reverts.** A recorded block emits `SpendBlocked`, sets receipt 1 and consumes the nonce. The reasons are `SPENDS_PAUSED`, `SPONSOR_NOT_ALLOWED`, `PROVIDER_NOT_ALLOWED` (an inactive or expired provider policy), `ENDPOINT_NOT_ALLOWED`, `PROTOCOL_CAP`, `LINE_RESERVE_CAP`, `LINE_SPEND_CAP`, `PER_SPEND_CAP` and `DAILY_SPEND_CAP`.

Everything else reverts with no event, no receipt and the nonce untouched:

- a wrong line, epoch, sponsor or agent, or a line that is not `OPEN` or `DRAWN` (including `DEFAULTED` and `CLOSED`): `InvalidIntent`;
- stale terms: `StaleTerms`;
- the principal or debt bound, signature expiry, executor, the `dueAt` window, or `dueAt > lineExpiry`: `InvalidIntent`;
- a used or cancelled nonce, or an existing receipt: `NonceUnavailable`;
- a `DRAWN` line: `InvalidState`;
- a bad signature: `InvalidSignature`;
- a token failure: `TransferFailed` or `NonExactTransfer`.

**`LINE_EXPIRED` can never be recorded.** Once `block.timestamp > lineExpiry`, every valid `dueAt` (at least now + 1 hour) exceeds `lineExpiry`, so the intent reverts `InvalidIntent` first. Line expiry is a revert and cannot serve as the qualifying refusal.

## 5. Not covered by contract tests

These items need live validation on Arc testnet.

- **Circle Agent Wallet signing on Arc testnet.** The contract tests use a mock account that validates an owner ECDSA key over the digest. They prove the contract path, not Circle's implementation. Confirm the following:
  - The account can be deployed on Arc testnet.
  - The Circle SDK's typed-data signature over the exact `SpendIntent` validates through the account's `isValidSignature(digest, signature)`, where `digest` is `hashSpendIntent(intent)`.
  - Which signature format the SDK produces for an account that is not yet deployed. The contract does not unwrap counterfactual (ERC-6492-style) signatures. If the SDK wraps them, deploy the account first and sign again.
  - How the account executes `repay` and `cancelNonce`, both of which act on `msg.sender`.
  - Circle spending policies apply to mainnet wallets, not testnet.
- **Provider acceptance of a request-bound payment proof.** Establish:
  - how the provider maps a request to the digest or transaction hash;
  - which confirmation it waits for;
  - that it returns the result.

  Direct Float payment and Gateway batched settlement are different settlement paths. Do not assume Gateway.
- **Interrupted-request recovery.** Agree with the provider on:
  - how status is looked up (transaction, `receiptStatus`, provider request status);
  - how to retrieve or retry without a second payment;
  - who owns escalation;
  - the remedy the provider actually offers.

  A paid purchase whose delivery is unresolved is not a completed cycle.
- **Independent participant control.** Participants hold the sponsor, agent-operator and executor credentials. Shadow constructs or signs none of their transactions. Participant tooling must emit candidate `SpendIntent` payloads, not V2 `FloatSpendIntent`.
- **Chain environment.**
  - Real Arc USDC at `0x3600000000000000000000000000000000000000`: exact balance deltas and transfer restrictions. The tests use `MockAsset`.
  - Arc block timestamps against UTC day boundaries.
  - Agreement between RPC and indexer on events and state.
- **Deployment.** This change adds the deployment script (`contracts/script/DeployShadowFloatMainnet.s.sol`), a read-only preflight and a release manifest (`app/scripts/float-mainnet-preflight.mjs`, `app/scripts/float-mainnet-manifest.mjs`). They are rehearsed on local anvil only; see [`SHADOW_FLOAT_MAINNET_TESTNET_DEPLOYMENT.md`](SHADOW_FLOAT_MAINNET_TESTNET_DEPLOYMENT.md). The ownership handoff and deployer/operator removal (spec §9) follow that runbook and are outside these contract tests.

## 6. Pilot operating rules drawn from the tests

- **Qualifying refusal.** Pre-agree an `ENDPOINT_NOT_ALLOWED` refusal: a real request to a provider endpoint outside the sponsor's policy. Record its digest, reason and the zero transfer. `ENDPOINT_NOT_ALLOWED` is preferred over `DAILY_SPEND_CAP` because a same-day retry can trigger a daily-cap block by accident, and that block uses up a signed intent. Log any unplanned block, but do not count it as the qualifying refusal.
- **One 1-USDC purchase per UTC day.** The daily caps allow 1 USDC of principal per UTC day. At the 1-USDC convention, never submit a queued intent on the same UTC day as the repayment that preceded it: it would be a recorded `DAILY_SPEND_CAP` block that uses up the intent.
- **Finish before the final hour.** Complete all three cycles by `lineExpiry − 1 hour`. Later purchases must have `dueAt <= lineExpiry`, so leave time to repay.
- **Reconcile before retrying.** Read `receiptStatus` and `nonceUsed` before any retry (section 4).
- **Close only a clear line.** The sponsor closes only after reading `state == OPEN` and `principalOutstanding == 0`.
- **Never default the pilot line.** Default behaviour is validated in contract tests only.

## 7. Two-day compatibility experiment

**Preconditions.** All of these must hold before starting:

- the owner approves the pinned values;
- deployment is explicitly authorized;
- chain ID `5042002` and the USDC code and decimals are verified from two RPCs;
- a provider has agreed to the direct-payment flow;
- participant roles and key custody are recorded.

**Stop conditions.** Stop, and record the exact dependency, when any of these occurs:

1. **The Circle wallet cannot produce an accepted signature** for the pinned candidate on Arc testnet. Causes include an account that cannot be deployed there, a signature that does not validate against `hashSpendIntent`, or only a counterfactual-wrapped format being available. Keep the Circle integration labelled pending and assess whether an already-supported wallet can validate the workflow.
2. **The provider needs a different settlement path.** This applies if it requires Gateway batching, or a payment proof that a direct transfer plus `ProviderPaid` cannot satisfy. Do not build settlement architecture inside the timebox; cost it separately.
3. **An observation disagrees with the expectations in sections 3–4.** Examples: the provider received an amount other than the principal, `receiptStatus` differs from the expected value, or the balance differs from `totalSponsorObligations`. Stop all writes and preserve the evidence.
4. **A retry creates a second payment,** or delivery cannot be tied to the intended purchase.
5. **Shadow would have to construct or sign a participant transaction,** or tooling emits V2 `FloatSpendIntent` payloads. Record the run as a rehearsal, not a qualifying cycle. Do not fall back to V2 and call it candidate validation.
6. **Two engineering days have elapsed.** Record the results and the blocker list before choosing the next implementation slice.
