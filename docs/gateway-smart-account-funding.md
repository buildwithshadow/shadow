# Atomic Gateway reserve funding experiment

`app/scripts/gateway-reserve-smart-account.mjs` prepares a bounded Arc testnet
call list. It is not enabled in the public interface and does not sign, send,
deploy an account, request an attestation or verify account ownership.

## Accounts and control

The source Gateway balance and burn signature belong to the controller EOA.
The destination recipient and permitted mint caller are both the sponsor's
deployed smart account. That account opens the line, owns its sponsor controls
and receives its eligible reclaimed reserve. The controller EOA is not recorded
as the sponsor and cannot call `closeLine` directly for that account's line.

This distinction is necessary because Shadow records `msg.sender` as sponsor.
A shared router must not be labelled as preserving an EOA's sponsor identity.
Transferring tokens directly to Shadow also does not create a funding line.

## Prepared operation

After reviewing the source authorization and obtaining its matching Circle
attestation, an account with verified atomic batching support performs:

1. Mint the exact reserve into the account through the pinned Gateway Minter.
2. Clear any previous allowance to Shadow.
3. Approve exactly the reserve amount.
4. Open the account's line with the reviewed agent, provider and spending limits.
5. Clear the allowance again.

The planner pins chain 5042002, Gateway domain 26 and the guarded testnet
deployment `0xd39d55Cc0C84408DCC409baDB776459641Dfd4be`. The reserve is at most
0.10 test USDC, the Gateway fee is at most 0.01 test USDC and expiry/windows are
bounded to 24 hours. Gas and any account deployment cost are separate.

These calls must be one atomic account operation. Sending them as separate
transactions does not establish this experiment's guarantee. The initial
Gateway deposit, source burn authorization and any account setup remain separate.
Reduced destination transaction count does not yet establish fewer total user
prompts or lower fees.

## Failure and recovery

A failed inner call must roll back the entire inner operation, including the
mint, its used transfer identity, approvals and Shadow line opening. An account
may catch that failure and produce a successful outer receipt. Therefore outer
receipt success alone never proves reserve funding.

`verifySmartAccountReserveEvents` requires the original Gateway mint, exact
token transfer, matching line opening and provider policy, and final zero
allowance event in the same account receipt. It checks event attribution; it
does not independently establish finality, reviewed calldata or current state.
The caller must first bind the original enclosing transaction to the reviewed
account batch and verify its canonical finalized receipt on two independent
clients. Check historical allowance and line state at that receipt block too.

Save the complete original intent, attestation, account batch, account operation
identity and available transaction identifiers before execution. Reconcile a lost
response read only. A missing identifier, missing effect, reverted/cancelled
operation or disagreement stays held. Do not create a new burn authorization,
salt or account batch to escape an uncertain result. Existing Gateway journals
can preserve the request through `runGatewayStep`; their reconciliation callback
must provide exact evidence, not an aggregate balance.

The event verifier currently expects a transaction addressed directly to the
sponsor account. ERC 4337 EntryPoint receipts and wallet specific operation IDs
need their own reviewed adapter. This code does not certify any wallet as capable
of batching, nor does it implement Safe or ERC 4337.

## Before a signed testnet rehearsal

1. Verify the account implementation, controller authorization, modules and
   atomic execution semantics using the actual wallet adapter.
2. Verify live Gateway/USDC/Shadow code, domain, token, repayment binding,
   limits, sponsor admission, pause state and next line epoch on two clients.
3. Simulate the exact wallet operation with a real matching Circle attestation.
4. Persist the original operation and exercise a lost response without resending.
5. Confirm one mint and one line opening, then complete purchase, draw bound
   repayment and account controlled reclaim through the ordinary wallet.

Local tests use the actual guarded Shadow source with test only account and
Gateway models. They establish Shadow caller attribution and EVM rollback
behavior. They do not establish a Circle attestation, a Safe implementation,
bundler compatibility, a completed live test or independent customer usage.

Tests:

```sh
node --test app/scripts/gateway-reserve*.test.mjs
forge test --root contracts --match-path 'test/ShadowFloatGuardedGatewayFunding.t.sol'
```

Official references:

1. [Circle Gateway interfaces and events](https://developers.circle.com/gateway/references/contract-interfaces-and-events)
2. [Circle Gateway contract addresses](https://developers.circle.com/gateway/references/contract-addresses)
3. [Circle Gateway destination caller and replay checks](https://github.com/circlefin/evm-gateway-contracts/blob/master/src/modules/minter/Mints.sol)
