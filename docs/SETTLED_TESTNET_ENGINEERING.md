# Settled Arc testnet Circle runner

The isolated engineering runner targets `ShadowFloatMainnetPublicSettled` on Arc testnet, chain 5042002, at `0x7EF717d7F7f47D48ba5330047B32353567331dfA`. It does not change the deployment used by public onboarding. The source, creation transaction and resolved runtime are verified through Sourcify. The pinned runtime hash is in `app/settledTestnetDeployment.mjs`.

The deployment begins paused and empty. Sponsor admission, funding, pause controls and reserve closure are separate owner or sponsor operations. The provider route in the configuration must be deployed with its own settled manifest and healthy monitor before preparing a funded purchase. Defining the endpoint in this module does not make that route live.

Run `node app/scripts/shadow-circle-settled-testnet.mjs help` for the command interface. Provide the original Circle wallet journal with `--state` and the separately installed, approved Circle CLI runtime with `--runtime`. Preserve the original wallet journal across every deployment and restart; do not create a fresh state directory to escape an unresolved operation.

`doctor` checks testnet authentication, membership of the chosen agent wallet, deployed account code and the pinned contract identity. `inspect` and purchase or repayment without `--confirm` are read only. Purchase and repayment with `--confirm` are explicit operations capped at 0.005 test USDC. Purchase signing and execution use the original wallet lock and a durable request identity. Recovery reuses the saved operation and never creates a replacement payment automatically.

The new purchase transport accepts only this fixed testnet destination, the chosen nonzero line, provider, endpoint hash, exact principal and debt ceiling, and agent as executor. Existing guarded and bounded factories retain their original destinations. The vendor compatibility copy is derived only from the approved supplier hash, retains authentication and policy checks, and accepts only the executeSpend selector on the fixed settled contract.

Repayment remains bound to the reviewed original draw. The settled adapter treats 0.005 test USDC as a maximum, allowing a smaller remaining principal after a concurrent partial repayment. It verifies the actual transfer and repayment events. It never redirects repayment to a new draw or mainnet. An unknown operation must be reconciled before another purchase or repayment.

The service result and provider receipt remain subject to the configured provider and monitoring checks. Testnet execution is a separate validation step from the local regression suite.
