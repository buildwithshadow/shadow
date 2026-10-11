# Public mainnet participant flow

Building with `VITE_SHADOW_GUARDED_MAINNET_CANDIDATE=true` exposes `/mainnet` for the public self registration deployment. The retained flag name is a configuration compatibility choice, not a reference to the earlier guarded contract. It does not unpause the contract. A disabled production build omits the route metadata and both sets of mainnet preview assets.

The deployment is Arc mainnet chain 5042, contract `0xcA819e8713b04a4Bd7e437c04BB97ac9274e2ce5`, runtime hash `0xa210397556c84e50f9f345168fc65fa0bc19d913d513a8b2daf8131330c3d52d`, with USDC at `0x3600000000000000000000000000000000000000` and repayment binding version 2. Its ceilings are 1 USDC of committed protocol reserve, 0.10 USDC reserve per line, and 0.005 USDC total, daily and per purchase spending per line. Repayment windows are between 3600 and 86400 seconds. Read the actual limits and pause flags before approving an action.

The browser flow requires ordinary EOA wallet accounts without smart contract code for funding actions. A sponsor registers its own wallet, approves the exact reserve allowance and opens a line for itself or another agent. No operator participant roster is needed. The connected browser agent signs and submits its purchase. Repayment binds the current draw digest through `repayForDraw`; closing a debt free line returns its eligible reserve. The current sample provider is an ordinary EOA and supplies the connected agent's Arc wallet balance report.

This deployment has no supported Circle CLI handoff in the public page. The older guarded commands and private Circle adapter target `0x708c8c987eb4Cd14445Ac2c65ea712b2084888eB`. Do not use them for the public deployment or direct rejected smart wallet users to them. Other execution integrations need their own verified deployment and repayment bindings.

## Monitoring and stop controls

Use an explicit schema 2 public admission baseline bound to this exact chain, contract, runtime, owner, operators, limits and intended pauses. The observer validates all discovered registrations and bounded lines from the deployment block. It verifies direct signed intent execution or exact routed Circle user operation attribution where applicable. The policy is operator selected; it is never learned from a new snapshot.

The public provider requires `PROVIDER_ADMISSION_MODE=public-monitor`, its exact release manifest, `PROVIDER_MONITOR_BASELINE` and `PROVIDER_MONITOR_STATE_DIR`. Fresh healthy monitoring and canonical runtime checks gate new acceptances and unpaid acceptance replays. Recheck after preparing the result and before signing. Paid acceptance, result and status recovery remain available during a monitor hold. Preserve separate persistent provider storage and its rollback witness. Policy or manifest changes require a deliberate provider restart.

A provider admission hold cannot revoke previously issued authorizations or prevent a client calling the contract directly. The onchain pause is the immediate execution stop control. The owner controls resumption; a pause only operator can stop openings and purchases. Repayment and eligible reclaim remain available during pauses. Keep the provider's recovery service independent from observer process availability. Do not describe monitoring alerts as an automatic onchain pause.

## Recovery and risk

Reconcile the original sender, nonce, exact calldata, canonical receipt and matching action event before any retry. An unavailable explorer or missing hash is not permission to resend. Retain wallet journals across refreshes and site data; browser locks do not coordinate a second device or another application.

Automated reviews and local tests do not constitute an independent human audit. The public page discloses that audit status. Repayment is unsecured: the sponsor bears unpaid spent principal risk, and the contract cannot guarantee delivery. Engineering rehearsals and cross project integration records do not establish independent customer adoption.
