# Guarded participant candidate

The default public funding route stays on Arc testnet. Building with `VITE_SHADOW_GUARDED_MAINNET_CANDIDATE=true` adds `/mainnet` for the draw-bound guarded deployment. This build flag does not authorize funded participation, admit a sponsor or change either pause.

The pinned release is Arc mainnet chain 5042, contract `0x708c8c987eb4Cd14445Ac2c65ea712b2084888eB`, runtime hash `0x845c0c3e47bbcf75004e5d47a6788585d57026ce70c08593d112966a6245b4ef`, repayment binding version 2. The browser limits are 0.10 USDC reserve and 0.005 USDC total, daily and per-purchase spending per line. Only admitted sponsors and ordinary EOA providers are supported. Registration, the testnet faucet, testnet Gateway and the testnet-only Circle CLI handoff are not offered on this route.

Funding/repayment/reclaim use browser wallet confirmations. Repayment encodes the current purchase digest in `repayForDraw`; it cannot fall back to the legacy generic repayment function. The sample service binds its wallet-balance report request to the connected agent address. The browser agent signs and submits its own purchase; this page does not implement Circle Agent Wallet login or autonomous mainnet purchase submission. Circle-funded repayment has a separate bounded adapter.

Journal and wallet locks are partitioned by network and account; a saved action on any deployment of the same chain must be reconciled before another action. Recovery checks the original nonce, sender, calldata, canonical receipt and action event. If explorer lookup is unavailable, keep the hold and use the original transaction hash from the wallet. A missing hash is not permission to resend. Clearing browser site data loses these local protections, and locks do not coordinate another device or application.

Local Anvil fixtures cover separate wallets, draw-bound repayment with lost confirmation, purchase confirmation loss and delivery loss, one provider payout, one debt and final reclaimed reserve. These fixtures are engineering evidence, not independent adoption or funded participant clearance. A real participant wallet walkthrough, supported credential recovery and independent security findings remain release requirements. Both deployed mainnet instances must stay paused until those requirements are resolved.

## Execution and stop policy

The browser route uses agent self-execution. A reviewed monitor baseline must explicitly set `executorPolicy: "agent-self"` on each approved participant line. For a ProviderPaid event on that exact line, both the canonical transaction sender and decoded signed executor must equal the line's approved agent. Unknown lines, mismatched senders, zero or undecodable executors are not approved by this mode. Omitted policy (or `"dedicated"`) preserves the existing dedicated-executor behavior. Current baselines are not changed automatically.

A local monitor hold gates the dedicated execution tools; it does **not** prevent a browser agent from submitting directly to the contract. The onchain `spendsPaused` flag is the browser route's enforcement mechanism. An operator must handle critical incidents by pausing the contract, and the owner must separately authorize resumption. No automatic pause signer or browser-to-private-monitor bridge is provided by this change. Never describe observation alerts as prevention of onchain execution.

Before funded participant activation, review and approve this execution model, the incident-to-pause operating procedure and its response-time risk; demonstrate the pause/refusal and recovery path; and keep the current deployed pauses in place until that review is complete. Configuring a line's execution policy is not pilot clearance.
