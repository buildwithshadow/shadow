# Draw-bound Circle repayment

`createCircleGuardedRepayer` supports a separately selected Arc mainnet repayment
path. It does not enable mainnet purchases, change public browser configuration,
unpause a contract, or remove the existing executor's Arc testnet restriction.
Use it with a reviewed guarded deployment and an already authenticated Circle
Agent Wallet.

Pin the chain (5042), contract runtime hash, agent, funding line, nonzero purchase
digest, exact repayment amount and network-fee cap. Amounts use six-decimal USDC
units; fee caps use 18-decimal native USDC units. These are two representations of
the same asset, not additive balances. The repayment amount must be positive and
at most 50,000 atomic USDC (0.05); the configured fee cap must not exceed 0.02 USDC.
These are adapter ceilings, not estimates or guaranteed costs.

The adapter permits only exact approval to that Shadow contract and
`repayForDraw(lineId, expectedDraw, amount)`. It checks binding version 2, the
current draw, agent and debt before estimating, then checks again before sending.
The onchain expected-draw check remains authoritative at inclusion. Repayment of
the same purchase may be partial or after default; it remains available while
funding or purchases are paused. The adapter cannot collect from an unwilling
agent.

`createCircleGuardedCliTransport` accepts the same pinned line/draw/amount and
uses ordinary scalar arguments in the reviewed Circle CLI runtime. It never
changes a spending policy, logs in, reads an OTP, patches the CLI or accepts an
unlimited allowance. Authentication remains in the user's private Terminal.
The execution adapter and transport must both be configured with the same scope.

## Confirmation and uncertainty

Provide a stable logical operation ID and a durable owner-controlled journal.
The wallet-wide namespace is shared with existing activation/uncertainty records
on that chain. Changing a contract or opening another line must not erase a
pending operation.

The original idempotency key and response are persisted. Completion requires
canonical finalized EntryPoint v0.7 evidence for the unique matching operation,
the exact agent-to-contract token transfer, and agreeing `DrawRepaid` and `Repaid`
events. An outer successful bundle or another operation's event is insufficient.

After a timeout, response-write failure, lookup outage or ambiguous receipt, use
`reconcile(originalKey)`. It only reads the original operation; it does not send
another one. If the remote response was lost before its ID/hash could be saved,
the transport returns unknown. A remote lookup by idempotency key is not assumed
to exist. Resolve that original identity through the supported Circle procedure;
do not manufacture a replacement request. A definite authentication failure
before submission may be retried explicitly after access is restored.

## Journal recovery

Journal roots must be directories owned by the running operator with mode 0700;
records must be private owner-controlled files. Symlinked roots/records and
insecure restored permissions are refused. A crashed process's lock is not
automatically stolen or deleted. Resolve the prior operator and uncertain request
before any deliberate unlock.

Use one active host per wallet journal. A copied directory is not a distributed
lock. Stop or revoke the previous host before restoring elsewhere; preserve the
original request identities, consumed gross-spend ledger, result store and
incident history. Restore access and permissions without resetting budgets.

CLI logout clears local authentication. It is not evidence that a copied remote
credential has been revoked. Provider-side session revocation, signer compromise
response and the Safe owner's private recovery method need their own supported
procedures and exercises.


The journal requires a canonical owner-only root under an owner-controlled parent that other users cannot write. An identity marker in that parent pins the root across adapter creation. Keep the marker with the state backup; a replaced root is refused rather than silently initialized. A worker holds the original directory as its kernel cwd for relative record and lock operations. The verified CLI runs from private writable journal/runtime state, not the vendor installation. Read-only vendor packages are supported; dependencies still come from the isolated installation and require their own supply-chain review.
