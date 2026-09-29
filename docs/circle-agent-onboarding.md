# Run a funded Shadow purchase with a Circle Agent Wallet

This flow is **Arc testnet only**. A sponsor uses [Shadow](https://www.shadowbuild.xyz/start) to authorize a funding line. The agent operates its own Circle wallet locally, purchases the 0.05 test-USDC report, and repays the line. Shadow does not receive the Circle session or OTP. This is a CLI handoff, not a browser wallet connector.

## Setup

Use Node 22.18+ and pnpm. Clone this repository and install the app dependencies:

```sh
git clone https://github.com/buildwithshadow/shadow.git
cd shadow
pnpm --dir app install --frozen-lockfile
```

Install the tested Circle runtime in a dedicated directory, separate from any global CLI:

```sh
npm install --prefix "$HOME/.local/share/shadow/circle-runtime" --ignore-scripts @circle-fin/cli@1.1.4
```

Log in using Circle's command in your own terminal. Review Circle's first-use terms and enter the newest OTP yourself. Never paste it into a chat, Shadow, or a log:

```sh
node "$HOME/.local/share/shadow/circle-runtime/node_modules/@circle-fin/cli/dist/index.js" wallet login you@example.com --testnet
node "$HOME/.local/share/shadow/circle-runtime/node_modules/@circle-fin/cli/dist/index.js" wallet list --type agent --chain ARC-TESTNET --output json
```

If you already have a valid testnet Circle session, skip login. Do not repeatedly request OTPs. Testnet and mainnet sessions are separate.

For a new wallet, use Circle's testnet faucet funding command. The first transaction deploys the smart account; a zero-value self-transfer can activate it. Review those operations in your own environment. The runner does not automatically create, fund, or deploy wallets.

```sh
node "$HOME/.local/share/shadow/circle-runtime/node_modules/@circle-fin/cli/dist/index.js" wallet fund --address YOUR_AGENT_ADDRESS --chain ARC-TESTNET
node "$HOME/.local/share/shadow/circle-runtime/node_modules/@circle-fin/cli/dist/index.js" wallet transfer YOUR_AGENT_ADDRESS --amount 0 --address YOUR_AGENT_ADDRESS --chain ARC-TESTNET --estimate
# After reviewing the estimate, repeat the transfer command without --estimate.
```

## Ask a sponsor to fund the agent

```sh
node app/scripts/shadow-circle-agent.mjs doctor --agent YOUR_AGENT_ADDRESS
```

The result verifies the local testnet session, lists deployment status, and gives a sponsor link containing only the public wallet address. Share that link with the sponsor. They connect their own browser wallet, review the agent address, choose limits, and authorize the line. The sponsor must understand repayment risk: provider payment creates debt even if delivery later fails.

After the line opens, its page exposes **Use a Circle Agent Wallet**, including commands with the exact line and agent already filled in. No Shadow team member needs to register the wallet manually.

## Inspect, purchase, recover and repay

```sh
node app/scripts/shadow-circle-agent.mjs inspect --agent YOUR_AGENT_ADDRESS --line LINE_ID
node app/scripts/shadow-circle-agent.mjs purchase --agent YOUR_AGENT_ADDRESS --line LINE_ID --confirm
node app/scripts/shadow-circle-agent.mjs recover --agent YOUR_AGENT_ADDRESS --line LINE_ID
node app/scripts/shadow-circle-agent.mjs repay --agent YOUR_AGENT_ADDRESS --line LINE_ID --confirm
```

Without `--confirm`, purchase and repayment only show the current line. The confirmed purchase costs 0.05 test USDC from the sponsor's reserve and creates the agent's repayment obligation. Repayment uses 0.05 from the Agent Wallet, including an exact allowance if needed. Network fees are separate; the adapter permits estimates up to 0.1 test USDC per operation, not a guaranteed actual-fee cap.

This first runner supports one purchase per line. Running purchase again on a recorded purchase does not create another purchase. Use recovery to retrieve the original result. Once debt is zero, the sponsor can close the line and reclaim eligible funds through its browser wallet.

## Recovery and storage

State defaults to `~/.local/share/shadow/agent-testnet`. Keep it private: purchase records include signed authorizations. The runner uses file locks and durable writes, and the execution adapter stores Circle idempotency keys before requesting transactions. Do not delete state or run from another machine/state directory to get past an unresolved request.

`recover` does not execute or sign a transaction. If preflight or fee estimation failed before the execution journal was created, recovery reports that nothing was submitted. Because the provider already received the signed authorization, retain it until expiry; recovery then verifies it is unpaid at a finalized block and archives it so a new purchase can be prepared. A partial journal barrier remains blocked for inspection. It reconciles saved Circle IDs/hashes and retrieves an already-paid result. If the Circle response was lost before any transaction identity was saved, automatic recovery may remain unresolved. Check the original request in Circle; do not submit a replacement. See [execution recovery](circle-agent-execution.md) for lock and finality requirements.

## Circle CLI compatibility

Circle CLI 1.1.4 does not expose the raw-calldata option needed for Shadow's tuple call. Shadow checks the SHA-256 of the tested release and writes a separate, narrowly scoped compatibility copy inside the dedicated runtime. The original CLI file is unchanged. Authentication, Circle policies and version checks are preserved. This is **Shadow compatibility code, not an official Circle browser integration**.

An unknown CLI source/version is refused. Do not bypass the hash check or a required Circle update. A supported-version change needs a new compatibility review. A failed command does not imply a transaction failed; use recovery.

For custom locations, `--runtime` chooses the dedicated npm prefix and `--state` chooses the private journal directory. Reuse the same state for a wallet's ongoing operations.

Circle references: [Agent Wallet quickstart](https://developers.circle.com/agent-stack/agent-wallets/quickstart), [contract execution](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/execute-contract).
