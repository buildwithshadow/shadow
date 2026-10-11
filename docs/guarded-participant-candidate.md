# Earlier guarded participant deployment

This document records the earlier controlled deployment and its fixed participant operating model. It does not describe the current `/mainnet` browser route. The retained build flag `VITE_SHADOW_GUARDED_MAINNET_CANDIDATE=true` now exposes the public self registration deployment described in [Public mainnet participant flow](public-mainnet-participant.md). The flag name is retained for deployment configuration compatibility; it does not change any onchain pause.

The earlier pinned release is Arc mainnet chain 5042, contract `0x708c8c987eb4Cd14445Ac2c65ea712b2084888eB`, runtime hash `0x845c0c3e47bbcf75004e5d47a6788585d57026ce70c08593d112966a6245b4ef`, repayment binding version 2. The browser limits are 0.10 USDC reserve and 0.005 USDC total, daily and per-purchase spending per line. Only admitted sponsors and ordinary EOA providers are supported. Registration, the testnet faucet and testnet Gateway were not offered by that earlier browser profile. Its bounded Circle tools target this earlier contract and must not be used for the public deployment.

Funding/repayment/reclaim use browser wallet confirmations. Repayment encodes the current purchase digest in `repayForDraw`; it cannot fall back to the legacy generic repayment function. The sample service binds its wallet-balance report request to the connected agent address. The browser agent signs and submits its own purchase; this page does not implement Circle Agent Wallet login or autonomous mainnet purchase submission. Circle-funded repayment has a separate bounded adapter.

Journal and wallet locks are partitioned by network and account; a saved funding action on any deployment of the same chain must be reconciled before another wallet transaction. An unresolved purchase blocks new funding and Gateway actions, while repayment and its allowance remain available. Read only payment recovery and verified purchase archiving keep the wallet lock but do not require unrelated funding or Gateway holds to clear. Recovery checks the original nonce, sender, calldata, canonical receipt and action event. If explorer lookup is unavailable, keep the hold and use the original transaction hash from the wallet. A missing hash is not permission to resend. Clearing browser site data loses these local protections, and locks do not coordinate another device or application.

Local Anvil fixtures cover separate wallets, draw-bound repayment with lost confirmation, purchase confirmation loss and delivery loss, one provider payout, one debt and final reclaimed reserve. These fixtures are engineering evidence, not independent adoption or funded participant clearance. These were the conditions of the earlier controlled rehearsal. Current public admission, browser support and stop controls are documented separately in the public mainnet guide.

## Execution and stop policy

The browser route uses agent self-execution. A reviewed monitor baseline must explicitly set `executorPolicy: "agent-self"` on each approved participant line. For a ProviderPaid event on that exact line, both the canonical transaction sender and decoded signed executor must equal the line's approved agent. Unknown lines, mismatched senders, zero or undecodable executors are not approved by this mode. Omitted policy (or `"dedicated"`) preserves the existing dedicated-executor behavior. Current baselines are not changed automatically.

A local monitor hold gates the dedicated execution tools; it does **not** prevent a browser agent from submitting directly to the contract. The onchain `spendsPaused` flag is the browser route's enforcement mechanism. An operator must handle critical incidents by pausing the contract, and the owner must separately authorize resumption. No automatic pause signer or browser-to-private-monitor bridge is provided by this change. Never describe observation alerts as prevention of onchain execution.

Circle agent execution has a separate `executorPolicy: "circle-agent-v07"` choice
for an explicitly approved line. The collector verifies the canonical finalized
EntryPoint v0.7 transaction, the exact successful user operation, its account
call and signed intent, and the payment event within that operation's receipt
boundaries. The snapshot retains the outer sender as the bundler and records
the verified agent and user operation hash separately. This policy requires
the agent and signed executor to equal that line's approved agent. Default
dedicated execution and ordinary `agent-self` policies do not accept a routed
Circle proof. Existing baselines are not upgraded automatically.

The earlier controlled deployment required review of its execution model, incident response and pause/refusal recovery before activation. Its fixed line policy is not clearance for a different deployment. Use the public mainnet guide for the current route.

## Lifecycle notices

`MATURITY_SOON`, `LINE_EXPIRY_SOON` and `POLICY_EXPIRY_SOON` remain visible in the saved snapshot and heartbeat notices when tied to an approved line (and provider for policy expiry). They do not create a global incident. The dedicated spend guard refuses an intent on the affected line while allowing unrelated healthy lines. Critical defaults, unknown warnings, invalid line/provider bindings, and drift still hold the monitor globally. Direct browser transactions remain subject to the onchain limits and pause, not this local guard.
