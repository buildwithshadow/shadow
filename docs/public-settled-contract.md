# Settled funding line candidate

`ShadowFloatMainnetPublicSettled` is a separate contract candidate. Adding its source does not upgrade, deploy or activate it. Existing contract addresses and settlement routes remain unchanged.

## Accounting

`totalCommittedCapital` measures unused funded reserves plus principal on live `DRAWN` lines. Default retires unpaid principal from this counter once. The counter continues to include unused reserve until that reserve is returned.

`totalSponsorObligations` measures escrow owed to sponsors: unused reserves plus received recovery funds. For the supported exact transfer token, the contract must hold enough tokens to cover these obligations.

`totalDefaultedPrincipal` measures unpaid principal on defaulted lines, including lines settled after expiry. This debt remains recoverable but does not consume admission capacity for new funding lines.

A late recovery increases escrow obligations and reduces defaulted principal. It does not increase spending capacity commitments. The recovered funds cannot finance new purchases on the old line. This prevents a late recovery from pushing shared active commitments above the cap and blocking unrelated purchases.

## Expiry settlement

Anyone may call `settleExpiredLine(lineId)` after the line expiry. An unpaid drawn line must also have reached its agreed repayment maturity. A sponsor cannot shorten a drawn line's expiry below its existing due time.

An expired open line closes and returns its reserve to its sponsor. An expired drawn line becomes defaulted, its unpaid principal retires from active capacity, and unused reserve goes to its sponsor. A defaulted line can return unused reserve and any received recovery. An unpaid line stays `DEFAULTED`, retaining its original debt and draw digest. It becomes `CLOSED` only when debt is zero and its remaining escrow is returned.

`ExpiredLineSettled` identifies the original line, caller, sponsor, amount returned and unpaid principal. Settlement never pays the caller. Pauses and admission revocation do not prevent settlement, repayment or eligible claims.

The older `closeExpiredLine` method still requires zero debt. It must not be presented as the method that retires an unpaid expired line.

## Repayment

`repayForDraw(lineId, expectedDraw, amount)` remains bound to the exact original draw. Its amount is the maximum the payer authorizes for that draw. The contract collects only the lesser of this maximum and the remaining principal. Events report the actual transferred amount.

If the draw has already been fully paid, or the supplied draw is stale, the call reverts without transferring tokens. It cannot pay a later draw or a new line for the same agent. Clients must explain the maximum amount and reconcile actual repayment events rather than assuming every submitted maximum was collected.

## Validation and activation

The candidate includes regression, authorization, token safety, capacity and randomized lifecycle tests. Its scope check is:

```sh
forge test --root contracts --match-path 'test/ShadowFloatMainnetPublicSettled*.t.sol'
node contracts/test/mainnet-scope.test.mjs --public-settled
```

No deployment address is provided by this change. Before use, independently verify the final source and runtime, financial accounting, authority, caps, monitoring, provider admission, browser and Circle client behaviour. Deployment and any existing contract pause changes require authorized wallet signatures. Existing reserves and debts are never moved automatically.

## Monitor selection

A release manifest for this candidate must set `contract.accountingModel` to `"settled-v1"` alongside its verified address, deployment block and runtime hash. Omission preserves legacy accounting for older contracts. An unsupported value is rejected. The settled model cannot be selected without a runtime hash, and a failed read of its defaulted principal ledger never falls back to legacy accounting.

The monitor independently reconciles active committed capacity, sponsor escrow and defaulted unpaid principal. A missing fully drawn defaulted line must still produce a discovery failure even when active committed capacity and escrow are both zero. `ExpiredLineSettled` is an additional attribution event, not a second transfer to count alongside the underlying reserve return.

## Repayment client preparation

With the settled manifest selected, the repayment CLI labels `amountMode` as `maximum`, reports the current `expectedTransfer`, and prepares an allowance for that expected transfer. The calldata remains bound to the original reviewed draw and maximum. Legacy profiles retain their exact amount validation.

`createCircleSettledTestnetRepayer` is an opt-in testnet integration boundary for rehearsal. It pins the runtime, line, draw, amount limit and wallet journal. It verifies the actual clamped repayment against the same draw event, companion repayment event, token transfer and successful user operation. It cannot activate a mainnet deployment. A maximum repayment journal cannot be resumed through the old exact amount adapter.
