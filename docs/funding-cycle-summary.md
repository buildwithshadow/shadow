# Funding cycle summary

Load a funding line in the participant interface to see its funding, purchases,
delivery checks, repayment and closure together. Reading the line and downloading
the summary do not connect a wallet, request a signature or submit a transaction.

The summary uses the same observed line state as the balance panel. Principal
repaid is cumulative principal paid minus principal outstanding. This does not
identify the payer or the repayment transaction. An unused closed line has no
purchase or repayment to demonstrate. A defaulted line remains distinct from a
closed line, even after recovery claims.

Delivery is separate. A report appears as rechecked only after the purchase engine
successfully verifies its original payment and signed result during the current
visit, through recovery, reopening saved history or importing a report receipt.
Records from another network, contract, runtime, line, sponsor or agent are
excluded. Repeated checks of the same digest count once. The tracker does not compare checked amounts with the line snapshot or claim
complete delivery coverage: a report check may be newer than that snapshot.

**Download cycle summary** saves an allowlisted JSON state summary. It contains
the deployment identity, observation block and timestamp, line amounts, visit
report checks and evidence limitations. It contains no spending signatures,
provider acceptance credentials, report content or wallet secrets. The summary
is not accepted as an import or as authority for a financial action.
The local wallet request hash is also omitted: a replacement transaction may
have made the payment, and that hash has not been independently verified here.

The export is not a full transaction receipt bundle. It does not establish the
funding, repayment or reclaim transaction hashes, the amount actually reclaimed,
participant independence or customer demand. Use the original downloadable report
receipt for its payment and delivery evidence and chain history for money movement.
An unavailable report check stays unknown rather than becoming a successful stage.

The tracker adds no chain reads or indexer requests beyond the existing line and
report flows. It does not alter limits, repayment rules, recovery locks or wallet
approvals. Report checks are visit-local and clear on wallet or deployment changes.
