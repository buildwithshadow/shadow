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
shadow_runtime="$HOME/.local/share/shadow/circle-runtime"
mkdir -p "$shadow_runtime"
cp tooling/circle-cli-runtime/package.json tooling/circle-cli-runtime/package-lock.json "$shadow_runtime/"
npm ci --prefix "$shadow_runtime" --ignore-scripts
```

For an existing runtime or unresolved operation, preserve the old installation and journal. Prepare a new directory and pass its path with `--runtime`; do not run `npm ci` inside an active installation.

Check the saved session first with `node app/scripts/circle-cli-verified.mjs wallet status --type agent --output json`. Reuse a valid session; do not request another OTP unnecessarily.

If Circle reports that terms acceptance is required, show the current vendor response:

```sh
node app/scripts/circle-cli-verified.mjs terms show --init --output json
```

Review the live `termsOfUseUrl`, `privacyPolicyUrl` and `termsNotice` returned by that command. Only if you accept them, run this yourself:

```sh
node app/scripts/circle-cli-verified.mjs terms accept --confirm-terms --output json
```

The launcher requires your explicit confirmation flag. It does not accept automatically, forward `CIRCLE_ACCEPT_TERMS`, or reset prior acceptance. An assistant must obtain your explicit consent before recording acceptance. See [Circle's terms gate](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-agent-wallet/references/terms-of-use.md).

Log in using the verified launcher in your own terminal. Review Circle's first-use terms and enter the newest OTP yourself. Never paste it into a chat, Shadow, or a log:

```sh
node app/scripts/circle-cli-verified.mjs wallet login you@example.com --testnet
node app/scripts/circle-cli-verified.mjs wallet list --type agent --chain ARC-TESTNET --output json
```

If you already have a valid testnet Circle session, skip login. Do not repeatedly request OTPs. Testnet and mainnet sessions are separate.

Check the selected wallet with one read-only command:

```sh
node app/scripts/shadow-circle-agent.mjs setup --agent YOUR_AGENT_ADDRESS
```

If already deployed, it returns `ready` and a sponsor link without sending anything.
If it needs gas, fund that exact address using the [Circle faucet](https://faucet.circle.com)
on **Arc testnet**, then run `setup` again. It never creates a wallet, requests an OTP,
or funds it automatically.

For a funded, undeployed wallet, `setup` estimates a **zero-value self-transfer**
and displays the source, destination, network and fee. Review that output, then explicitly authorize:

```sh
node app/scripts/shadow-circle-agent.mjs setup --agent YOUR_AGENT_ADDRESS --confirm
```

The transfer uses the original Circle CLI and may activate the smart account. Gas
still costs test USDC. Estimates above 0.1 test USDC are refused; this is an estimate
threshold, not a guaranteed final fee cap. `ready` requires wallet code at a finalized
block. If the response is uncertain, run `setup` again: it checks deployment without
resending the recorded attempt. Keep the same state directory. An unresolved attempt
may require checking Circle transaction history; never clear the journal to bypass it.
A definite session-validation failure before submission permits a fresh explicit attempt.

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

Circle CLI 1.2.0 does not expose the raw-calldata option needed for Shadow's tuple call. Shadow checks the SHA-256 of the tested release and writes a separate, narrowly scoped compatibility copy inside the dedicated runtime. The original CLI file is unchanged. Authentication, Circle policies and version checks are preserved. This is **Shadow compatibility code, not an official Circle browser integration**.

The launcher validates the vendor entrypoint and the complete dependency closure before authentication. The committed approval contains separate reference digests for macOS ARM64 and Linux x64, produced from the exact lockfile with install scripts disabled. Installation paths do not affect the digest. Changed dependency bytes or metadata are refused before a new executable cache is created. Inspection does not approve an installation; a different platform or supplier update needs a maintainer review and a new committed approval.

Authentication and inspection run from the frozen directory with a restricted environment. Remove `NODE_OPTIONS`, `NODE_PATH` and `CIRCLE_PROXY_URL` before use. Native keyring variables and an absolute `CIRCLE_CLI_HOME` remain supported. The verified launcher accepts explicit terms consent, login and inspection only; use the bounded Shadow runner for signatures and transactions. The byte approval is not a vulnerability audit. A fresh stock 1.2.0 audit still reports dependency advisory matches; updating the CLI does not clear those advisories.

An unknown CLI source/version is refused. Do not bypass the hash check or a required Circle update. A supported-version change needs a new compatibility review. A failed command does not imply a transaction failed; use recovery.

For custom locations, `--runtime` chooses the dedicated npm prefix and `--state` chooses the private journal directory. Reuse the same state for a wallet's ongoing operations.

Circle references: [Agent Wallet quickstart](https://developers.circle.com/agent-stack/agent-wallets/quickstart), [contract execution](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/execute-contract).
