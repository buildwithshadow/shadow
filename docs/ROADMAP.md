> Current plan of record. It replaces the earlier roadmaps, which are archived unchanged in [`archive/ROADMAP-2026-09-02.md`](archive/ROADMAP-2026-09-02.md) and [`archive/ROADMAP-2026-07-04.md`](archive/ROADMAP-2026-07-04.md).

# Shadow accelerator roadmap

**18 September 2026 — final team roadmap, version 3**

Prepared for Iyanda Abdulqodir Adedolapo, Ridwan Nurudeen and Apata Isiaq. Incorporates the team’s research, Ridwan’s critique and Isiaq’s three-document review. This is the consolidated roadmap for team execution; earlier drafts remain historical records. Deployment, funding and release remain subject to the conditions below.

**Evidence baseline:** source and research reviewed September 17–18, including public commit `2ebae7f63f6bdeed7ec9ad522f680af7b91b62ec`. Inventory newer local or unpublished work before estimating implementation. “Final” identifies this planning version; it does not certify completed milestones or prevent evidence-led changes.

## Direction

**Prove a repayable USDC funding relationship between a sponsor and an independently operated agent, with onchain obligations and sponsor exit rights.**

Shadow lets approved sponsors—individuals or organizations—reserve USDC for an independently operated agent’s purchases. The agent authorizes each purchase; the contract pays approved providers and records debt, repayment, qualifying policy refusals and declared defaults onchain. Sponsors can reclaim eligible funds and bear the explicitly agreed credit risk.

The initial product supports **purchase → full repayment → next purchase**, with one outstanding draw per line. It does not support several purchases before repayment. Full repayment of a non-defaulted line permits a new purchase only within its remaining cumulative, daily, expiry and policy limits. Repayment does not reset cumulative principal paid. After a declared default, repayment supports sponsor recovery and does not reopen the line. Establish whether this sequence fits an actual customer before expanding implementation; do not disguise a mismatch by opening artificial extra lines.

Circle already supplies agent wallets, spending policies, service discovery and payment infrastructure. Shadow's opportunity is to serve customers who need a funding and repayment relationship beyond those wallet features. We will test compatibility with Circle Agent Wallets and prove the incremental customer value before expanding the product.

**Path A remains the accelerator priority. Path B remains the subsequent expansion, earned through customer evidence.**

## What success looks like

By the end of eight core working weeks, we want three outcomes:

1. **A working independent pilot on the mainnet-candidate contract generation:** one external sponsor and agent complete three service-purchase-and-repayment cycles on separate occasions, one policy refusal, and final reserve reclaim without Shadow operating their transactions.
2. **A commercial reason to exist:** a named buyer demonstrates a requirement or operational improvement beyond its current wallet setup and agrees to a recurring product subscription or a conditional paid pilot with price, scope and activation conditions. One-off integration work is tracked separately.
3. **An evidence-backed release decision:** an independently reviewed, operationally prepared mainnet candidate, or a precise remaining-blocker list with owners. Mainnet launch depends on readiness; it is not promised for a calendar date.

The organizer's onboarding email describes nine weeks, while the application asks for eight-week goals. Use eight weeks for these core outcomes and reserve a ninth week, if scheduled, for demonstration, handover and follow-up. Align exact session dates with Encode's final timetable.

## Starting position

| Area | Current evidence and boundary |
| --- | --- |
| Float V2 | Historical Arc testnet integration evidence, including an Argus Alpha-authorized CitePay purchase and returned query. Preserve these records, but repeat the complete path on the mainnet candidate. Historical activity is not recurring demand; invited integration testers are not automatically customers. |
| Mainnet candidate | Implemented `ShadowFloatMainnet` and tests. It starts with approved sponsors, allows one outstanding draw per line, excludes automatic scoring and keeps protocol fees at zero. It is not an audited production deployment. |
| Circle compatibility | Contract-side ERC-1271 support is implemented and tested. Actual Circle wallet signing, contract-account validation and provider acceptance remain to be demonstrated together. Circle spending policies apply to mainnet wallets, not testnet. |
| Provider compatibility | A transfer to a provider address does not establish that its API accepts the payment proof. Direct Float payments and Gateway batching have different settlement requirements. |
| Public verification | The default verifier checks one canonical lifecycle and some aggregate conditions; it does not independently reconstruct all external participant histories. Activity API/checkpoint totals are a separate evidence source. Reproduce the reported historical-evidence failure and inspect existing local fallback changes before claiming they fix this specific path. Qualify unavailable evidence. |
| Participant tools | The reviewed public API still constructs V2 `FloatSpendIntent` payloads. Candidate `SpendIntent`, line operations and events require an explicit tooling migration. Check newer unpublished work before estimating the gap. |
| Commercial validation | The initial customer, repayment source, willingness to pay and advantage over native Circle policies still need evidence. |

Keep testnet V2, the mainnet candidate and future features separately labeled throughout the product, repository and presentation.

## Initial customer hypothesis

Start with an agent platform, service business or individual sponsor advancing purchase capital to an independently operated agent that earns revenue from a real job. The sponsor needs approved-provider spending, a defined repayment obligation and a record of outstanding exposure.

This is a hypothesis to test, not an established market. A different sponsor and operator make the relationship easier to explain, but do not establish repayment ability or demand. For this initial pilot, the sponsor and operator must be distinct parties. Self-sponsored usage is a later customer segment. Individuals remain eligible on either side, subject to sponsor approval. A separate sponsor alone is not a defensible advantage: customers may already manage advances with transfers, agreements and accounting.

Select the first pilot only when we can name:

- the sponsor and person responsible for the capital;
- the agent operator and party responsible for repayment;
- the recurring service purchased and provider willing to deliver it;
- the repayment source, expected timing and party bearing losses;
- the problem with the customer's existing wallet and accounting setup;
- whether the purchase sequence fits one outstanding draw per line.

Sponsors still prefund dedicated reserves. Avoid claiming lower capital requirements until measured. Default accounting records an unpaid obligation; it does not force repayment or guarantee recovery of money already paid to a provider.

## Eight-week work plan

The calendar below is a proposed team schedule anchored to the announced kickoff week of September 21. Confirm workshop dates and programme duration against Encode’s final timetable. The weeks are working targets. Progress depends on the evidence in the final column, and unmet conditions change scope rather than being silently marked complete.

| Period | Main work | Lead | Required result |
| --- | --- | --- | --- |
| Before kickoff: Sep 18–20 | Pin `ShadowFloatMainnet` source and build configuration; prepare a non-funding Arc testnet deployment and manifest; reconcile public claims; recruit reviewer and pilot participants. Deploy only within explicit deployment authorization. | Adedolapo + Ridwan; Isiaq recruits | Candidate deployment, verified source and configuration before the pilot begins; if delayed, make it a Week 1 blocker. Preserve V2 as historical proof. |
| Weeks 1–2: Sep 21–Oct 4 | Agree reviewer scope, budget and capacity in Week 1 and hand over pinned artifacts. Inventory and adapt candidate participant tools and verification. Conduct five qualified conversations; run the two-day compatibility experiment; select one purchase–repayment workflow. | Adedolapo owns review; Ridwan compatibility; Isiaq discovery | Reviewer budget, availability, artifacts, remediation and re-review time agreed, or named blocker; documented candidate tools usable without engineer-built transactions; one willing sponsor/operator/provider combination, repayment source, loss owner and feasible payment path. |
| Weeks 3–4: Oct 5–18 | Complete the first customer lifecycle on the candidate deployed to testnet; fix onboarding, authorization, provider acceptance and recovery blockers. | Ridwan + Adedolapo | Provider delivers the paid service; debt, repayment, refusal, retry and eligible reclaim are demonstrated. Label any assisted rehearsal. |
| Weeks 5–6: Oct 19–Nov 1 | Reach three independent cycles on separate occasions; measure operational value; test a recurring product price; continue review remediation. | Isiaq + Adedolapo; Ridwan reliability | Three qualifying cycles, one policy refusal, debt clearance and sponsor reclaim, without Shadow operating participant transactions; priced commitment or documented rejection. |
| Weeks 7–8: Nov 2–15 | Resolve review findings, validate the final candidate, rehearse operations, decide release readiness and prepare the demonstration. | Adedolapo + Ridwan; Isiaq customer evidence | Launch or hold decision with evidence; final-release demonstration and focused 90-day plan. No forced mainnet deadline. |
| Optional Week 9: Nov 16–22 | Demonstration, handover and follow-up if this matches the final organizer schedule. | Whole team | Accurate evidence and next steps. |

The first independent qualifying cycle counts toward the three; an assisted rehearsal does not. Complete reclaim as part of validation rather than delaying it for presentation. A later demonstration can use a newly authorized testnet line or a clearly identified recording of the completed lifecycle.

**Pilot, review and release must follow one candidate source lineage.** Record source commit, compiler settings, build artifacts, deployed addresses, chain-specific configuration and review scope. Testnet and mainnet addresses, signature domains and immutables may differ. Track every fix after reviewer handoff; material changes require relevant review and pilot revalidation. V2 evidence cannot substitute for candidate validation.

## Candidate participant tools — Weeks 1–2

**Owner: Ridwan, with Adedolapo reviewing scope.** Inventory existing branches, scripts, API handlers and deployment artifacts first. Reuse working candidate-specific components where verified; do not assume the V2 interface becomes compatible when its contract address changes.

Deliver one documented path covering:

- approved sponsor line creation and provider policy configuration;
- candidate `SpendIntent` generation bound to the correct chain, contract, sponsor, line ID, epoch, current terms and other required fields;
- participant-controlled signing, permitted submission and outcome lookup;
- balances that distinguish reserve, outstanding debt, cumulative spending and remaining limits;
- repayment, eligible reclaim and default recovery;
- evidence export with transaction references, service request/result references and an explicit verifier scope.

**Acceptance:** participants complete the lifecycle through documented tools without Shadow engineers constructing or signing their transactions. Reject wrong-generation or stale signing payloads; verify that observations match candidate events and state. Keep keys under participant control.

A minimal CLI can establish integration readiness for technical participants. Separately test the ordinary product journey with an unrelated intended customer, using its normal onboarding and no private setup, founder-operated transaction or live coaching. A CLI rehearsal alone does not establish public-product usability. Fix the smallest journey blockers before adding a new dashboard.

## First technical experiment

Timebox the initial compatibility assessment to **two engineering days** before choosing the next implementation slice. Use `ShadowFloatMainnet` deployed to Arc testnet, its direct-payment design and one cooperating provider. CitePay is an existing integration lead, not a presumed customer commitment. Do not fall back to V2 and call it candidate validation. This timebox is a discovery checkpoint, not a promise that all integration work takes two days.

The complete useful path is:

1. Sponsor funds a line and approves its provider policy.
2. A Circle Agent Wallet signs the exact Float authorization for the pinned mainnet candidate on testnet.
3. A permitted executor submits it; the contract validates the signature and terms.
4. The provider accepts a request-bound payment proof and returns the purchased service.
5. Debt and reserve accounting match the payment.
6. Full repayment clears non-defaulted debt; another purchase remains subject to all remaining limits.
7. The sponsor independently reclaims eligible reserve after debt clearance.

Also check a refused purchase with no provider transfer, duplicate submission, and an ambiguous or interrupted request. A retry must not create a second payment; provider delivery must be tied to the intended purchase. Distinguish recorded policy blocks from state, nonce and signature errors that revert. A reverted transaction may be visible onchain but does not persist a `SpendBlocked` event. Verify that a second draw while debt remains is rejected. Partial repayment restores reserve accounting but does not permit another draw. Full repayment of a non-defaulted line removes the outstanding-debt restriction, while cumulative spend, daily caps, expiry, policy, pause and sponsor-eligibility checks still apply. Repayment never resets cumulative principal paid. For defaulted lines, repayments become recoverable by the sponsor without reopening the line. Include maturity/default and recovery cases in contract validation; do not create a real customer default for the demonstration.

ERC-1271 support is a compatibility starting point. Test actual wallet signatures, deployed-account behavior, chain support and provider requirements before asserting that integration needs no changes. A successful signature alone is not a completed purchase.

A September 17 Circle Discovery resource snapshot advertises Arc mainnet payment options, including `eip155:5042` with `GatewayWalletBatched`. This is dated discovery evidence; it does not establish direct Float payment acceptance, testnet availability or the number of independent providers. Recruit a provider that explicitly agrees to the chosen payment flow.

If Circle compatibility is blocked, identify the exact dependency and assess whether an already-supported wallet can validate the customer's workflow. Keep the Circle integration labeled pending. If provider acceptance requires new settlement architecture, evaluate that cost explicitly before building it. Gateway support is a separate design decision, not an assumed consequence of supporting ERC-1271.

## Independent pilot evidence and provider recovery

**Owners: Isiaq for participant and customer evidence; Ridwan for transaction and service evidence.** Record each of the three qualifying cycles in one shared evidence log:

| Evidence | Required record |
| --- | --- |
| Independent control | Sponsor and operator identities/roles, who controls each wallet and who initiated each action. Different addresses alone are insufficient. |
| Customer purpose | The job requiring the service, why this purchase was needed and why it recurred. Different transaction dates alone do not prove demand. |
| Technical binding | Candidate source/deployment, chain, line ID, policy/terms version, transaction references and final state. |
| Useful result | Provider request identifier, payment acceptance and delivered service/result reference. A token transfer alone is incomplete. |
| Obligations and exit | Debt opened, repayment source, debt clearance, remaining limits, qualifying refusal and final sponsor reclaim. |
| Assistance | Setup help, live intervention, subsidies and who supplied test tokens or real funds. Mark rehearsals separately from qualifying independent cycles. |
| Commercial evidence | Buyer, recurring scope and price, active or conditional commitment, activation conditions and permission for any public reference. |

Testnet cycles establish mechanics and operational independence. They do not establish repayment under real capital risk. A paid software commitment is separate evidence of demand, not proven credit performance.

Before the first pilot purchase, agree with the provider how a paid request is identified and recovered if its response is interrupted. On an ambiguous outcome, first look up transaction and service status; retrieve or retry the same request without issuing a second payment. Record who investigates unresolved delivery, the escalation route and the remedy the provider actually agrees to offer.

An immediate payment may leave debt outstanding even when service delivery fails. Explain that obligation to participants before purchase. Do not promise automatic refunds, escrow, guaranteed quality or debt cancellation that the current system does not implement. A payment with unresolved delivery does not count as a completed service cycle.

## Customer comparison and decision

Use the same recurring purchase with the customer's actual alternative: a funded Circle wallet with appropriate policies and its normal accounting process. Include ordinary transfers, agreements and accounting where these are the real alternative. Do not compare Shadow only against an unrestricted wallet.

**Comparison limit:** Circle spending policies are mainnet-only. During testnet validation compare authority, steps, obligations, reconciliation and eligible exits. Observe existing customer mainnet operations where available, but do not claim a matched live comparison, gas savings or payment-speed advantage against testnet. A matched mainnet comparison requires Shadow release readiness, an agreed measurement protocol and separately authorized funding. Document untested baseline assumptions.

Record initial setup separately from repeated use, including:

- human funding, approval and repayment interventions;
- reconciliation effort and visibility into outstanding obligations;
- committed capital and purchase completion time;
- false refusals, failed payments and recovery effort;
- whether required sponsor rights can be represented in the alternative;
- the total price the buyer will accept for the resulting benefit.

Treat capital, time and cost figures as observations with their network and test conditions, not comparative performance claims where conditions differ. Before testing, agree a meaningful success measure with the customer: either a quantified improvement in its actual workload, or an indispensable funding/accounting requirement its current setup cannot meet economically. Record both systems' costs, including work Shadow shifts into repayment or onboarding.

**Continue** when an independent customer wants the repeat workflow and the comparison supports its value. **Narrow or reconsider** when wallet policies already solve the problem, repayment only adds internal transfers, or integration cost overwhelms the benefit. Use the first five qualified conversations as a diagnostic checkpoint. If none produces a willing pilot, record whether the cause is absent need, unclear value, provider availability, purchase sequence, price, trust or timing. Adjust the customer hypothesis or run a bounded follow-up based on those reasons before expanding engineering. Five rejections do not establish that the entire market is absent.

## Revenue hypothesis

The mainnet candidate is zero-fee. Activity does not automatically create protocol revenue.

Test willingness to pay for recurring use of Shadow’s funding and accounting workflow: for example, a flat monthly price per active line or a sponsor-account subscription. Select one hypothesis through interviews. Offchain billing is a commercial experiment; it is not an existing protocol fee or proof that a future fee-bearing contract will succeed.

Separate one-off integration revenue from recurring product value. Record why the buyer pays, what it would replace Shadow with, repeat-use expectations and what would make it leave. A useful commitment names the buyer, scope, recurring price and activation conditions; a conditional commitment is not collected revenue.

Track revenue, support effort, infrastructure cost and resulting margin separately from capital provision and credit losses. Identify who funds reserves, why that party participates, and who absorbs losses. A principal-percentage charge needs separate economic and terms assessment; do not assume an offchain invoice settles those questions. Any later onchain fee, interest or pooled-capital model requires a fresh specification, review and authorization.

## Mainnet release conditions

A limited real-value pilot can proceed only after:

- the independent testnet pilot has completed three qualifying cycles on separate occasions, one recorded policy refusal, debt clearance and sponsor reclaim on the reviewed candidate lineage, with assistance and control documented;
- the customer comparison supports incremental value, and a named buyer has an active recurring commitment or a conditional paid commitment with price, scope and activation conditions; record exactly which condition the mainnet pilot will satisfy;
- the intended customer can complete the ordinary product journey independently; participant tooling, recovery instructions and verifier scope are documented;

- the final `ShadowFloatMainnet` candidate source lineage and complete wallet/provider path have been validated, with any post-review changes covered;
- independent security review is completed and actionable findings resolved;
- chain, USDC, contract addresses and release artifacts are verified together;
- sponsor and agent onboarding, key control, repayment and reclaim are usable independently;
- reserve, debt, maturity, default and indexing health are monitored;
- incident, pause, uncertain-payment and reconciliation procedures are rehearsed;
- the capital source, exposure cap, repayment responsibility and loss owner are explicit;
- appropriate terms and legal review cover the intended pilot;
- the specific deployment and funding scope are authorized.

Collected mainnet revenue is not a prerequisite when the capped pilot is intended to activate a conditional paid commitment. Technical tests alone cannot satisfy the customer or commercial conditions.

Use a capped, approved-sponsor rollout consistent with the candidate. A live Arc network removes an infrastructure dependency; it does not make Shadow production-ready. If review or operations remain incomplete, continue validation on testnet and state the blocker clearly.

## Path B — customer-backed protocol capital operations

Path B remains part of Shadow's direction after Path A proves independent repeat use, economic value and operational readiness. Isiaq may spend up to one hour per week on adjacent customer discovery; allocate no engineering to Path B until Path A passes its evidence gate.

The first Path B customer must supply one repeated operation, a named capital owner, a technical contact, exact policy requirements, a safe liquidity plan and a pilot commitment.

An example to validate is a bounded vault deposit with a specified asset, contract, function, maximum amount, minimum received shares and withdrawal destination. The partner must explain why native wallet policies and existing tools are insufficient.

Implement one real protocol adapter only after that evidence exists. Demonstrate the allowed action, an excessive or altered request refused before funds move, and the customer's required withdrawal or recovery path. Earlier Morpho-style and V4-style adapters remain simulations until replaced and tested against the actual protocol.

Path B is not promised within these eight weeks. A committed design partner and a well-specified workflow are a useful next-quarter outcome; a rushed adapter without a customer is not.

## Parked work

Keep delivery-quality verification and refunds as separate customer-led possibilities. Provider acknowledgement does not prove service quality, and a finalized provider payment cannot simply be reversed. Escrow, refund funding and dispute handling each need an explicit design.

Also defer a generic agent wallet, provider marketplace, broad execution engine, insurance product, pooled liquidity, transferable debt, token and multiple DeFi integrations. Expand only when a validated customer requirement justifies the additional work.

## Team responsibilities

| Person | Primary responsibility | Weekly output |
| --- | --- | --- |
| Iyanda Abdulqodir Adedolapo — Founder; Engineering & Product Direction | Product decisions, pilot scope, economics, accelerator relationships, independent-review sourcing and release responsibility; engineering alongside Ridwan. | A clear continue/narrow/hold decision grounded in customer and technical evidence. |
| Ridwan Nurudeen — Co-founder; Engineering | Wallet/provider compatibility, contract and service integration, reliability and operating readiness. | One verified lifecycle improvement or a precise dependency with a bounded next experiment. |
| Apata Isiaq — Product & Growth Lead | Customer discovery, provider recruitment, onboarding feedback, positioning and commercial validation. | Interview findings, observed friction and progress toward a named pilot or paid commitment. |

Keep one shared weekly record: customer evidence, completed product actions, measured benefit, blockers, next action and owner. Use it to make decisions; avoid turning reporting or test volume into a substitute for use.

## First 48 hours from this revision: September 18–20

1. **Adedolapo + Isiaq:** agree the distinct-sponsor/operator hypothesis, identify ten relevant contacts, and request the first five qualified conversations. Ask how many purchases happen before revenue arrives.
2. **Ridwan:** inventory the candidate tooling and unpublished work; prepare the pinned testnet deployment package, chain/token configuration, verification procedure and lifecycle test plan. Set cumulative and daily limits to support the intended three cycles without implying unlimited reuse. Surface deployment authorization and technical dependencies before execution; this roadmap does not itself deploy anything.
3. **Ridwan + Isiaq:** confirm a provider’s acceptance requirements and the Circle wallet path; define the two-day experiment and its stop conditions.
4. **Adedolapo:** send or prepare the Week 1 reviewer brief, scope and candidate artifacts; agree budget, reviewer availability, target artifacts and time for remediation and re-review, or record the blocker. Outbound contact still follows the team’s normal authorization.
5. **Adedolapo + Ridwan:** reconcile the public README, roadmap and product claims. Prepare the new roadmap as the current plan and archive the September 2 version. Remove stale implications that Gateway settlement or underwriting/scoring are mainnet commitments. Scope the default verifier honestly and investigate the reported retrieval failure. Publish through the repository’s normal review process.

These are assigned next actions, not a claim they have been completed. Keep current evidence, review notes and participant permission together. No institutional-adoption claim without a qualifying commitment and permission; use “integration tester,” “prospective pilot participant” or “customer” according to the evidence.

## Accelerator narrative

> Shadow gives an independently operated agent repayable USDC purchasing capacity from an approved sponsor. Its contract pays approved providers and records debt, repayment, qualifying policy refusals and defaults onchain; the sponsor retains defined rights to reclaim eligible capital. We are testing this funding relationship behind Circle Agent Wallets. During the accelerator, we will validate three independent purchase-and-repayment cycles on the mainnet-candidate contract generation, test a recurring product price, and make an independently reviewed mainnet release decision. Expansion into protocol capital operations follows demonstrated customer need.

Circle integration remains a target until the complete wallet-to-provider flow works. The candidate records obligations and recovery; it does not guarantee repayment or insure sponsor losses.

## Research basis

This plan incorporates Nurudeen's `SHADOW-VS-ARC-PORTAL-for-qdee.md`, Apata's two September 17 feedback documents, Ridwan's `SHADOW-ROADMAP-CRITIQUE-2026-09-17.md`, Isiaq’s `SHADOW_THREE_DOCUMENT_REVIEW_2026-09-17.md`, and the earlier locked Shadow roadmap. Their conclusions are inputs to validate, not customer commitments.

- [Circle Agent Wallets](https://developers.circle.com/agent-stack/agent-wallets) and [spending policies](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies).
- [Arc network parameters](https://docs.arc.io/arc/references/connect-to-arc): mainnet 5042; testnet 5042002. Do not base opportunity claims on confusing these networks.
- [x402 payment requirements](https://docs.x402.org/schemes/exact) and [Gateway ERC-1271 limitations](https://developers.circle.com/gateway/references/erc-1271).
- [Implemented mainnet candidate](https://github.com/buildwithshadow/shadow/blob/2ebae7f63f6bdeed7ec9ad522f680af7b91b62ec/contracts/src/ShadowFloatMainnet.sol).
- [Arc Request for Builders](https://www.arc.io/blog/the-unfinished-business-of-finance-machine-commerce-and-global-money): ecosystem relevance, not evidence of demand or an endorsement of Shadow.

- [Mainnet specification at the candidate source commit](https://github.com/buildwithshadow/shadow/blob/2ebae7f63f6bdeed7ec9ad522f680af7b91b62ec/docs/SHADOW_FLOAT_MAINNET_SPEC.md): candidate lineage, approved sponsors, one outstanding draw, zero fees and deployment boundaries.
- [Circle Discovery API](https://api.circle.com/v2/x402/discovery/resources?limit=50&offset=0): September 17 snapshot includes an Arc mainnet Gateway payment option. Listings are discovery evidence, not a verified purchase or provider commitment.

## Document history

This final version incorporates Ridwan’s candidate-lineage correction and Isiaq’s tooling, repayment-limit, release-gate and pilot-evidence refinements. It retains the initial focus, recurring commercial test and subsequent Path B expansion.

Earlier documents remain unchanged: the September 2 roadmap, September 17 proposal and revision 2, and both teammate reviews. Milestones remain open until supported by evidence. Changes to scope or dates should record the reason, owner and effect on the release conditions.
