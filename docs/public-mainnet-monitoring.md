# Monitoring public sponsor access

Public access uses an explicit version 2 baseline and a verified deployment
manifest with public registration and draw repayment enabled. Existing version 1
rehearsal baselines retain their exact participant and line admission rules.

A public baseline approves bounded behavior rather than collecting participant
addresses. Registration history must agree with current sponsor status. Every
line must have valid parties, terms and repayment windows, and stay within the
approved reserve and purchase ceilings. The baseline is never rewritten from a
snapshot.

Canonical history, runtime, owner, operator, cap, accounting and freshness checks
remain global. Direct purchases require the exact canonical receipt and signed
intent digest, line, payout and executor. Supported Circle operations retain the
existing successful user operation attribution checks. Unsupported or unbound
execution observations remain a hold.

A valid maturity, default eligibility, expiry or sponsor removal incident belongs
to its funding line. It remains visible as a scoped notice in the persisted
heartbeat rather than stopping unrelated sponsors. Unknown or unbound alerts
remain global failures. The notification worker uses the same evaluator as the
observer so public registrations cannot produce alternating false outage and
recovery notifications. Telegram delivery continues to report global operational
failures and recovery; scoped credit notices are available in the heartbeat.

The public browser flow executes from the participant wallet. The earlier
founder Circle execution adapter and its fixed roster spend guard are separate;
they do not acquire public spending authorization from a healthy heartbeat.

If an RPC has pruned its transaction receipt hash index, the observer can read
the exact receipt from its canonical block with `eth_getBlockReceipts`. This
fallback applies only to a receipt not found response. It verifies the mined
block and transaction slot, unique receipt, successful status, every receipt
log's block binding, and the canonical block again after retrieval. The normal
signed intent, exact payment log and historical contract status checks still
apply. RPC outages, missing or ambiguous block receipts and reorgs remain holds.
No payment outcome is inferred from an absent receipt and no transaction is sent.

## Separate provider and observer Unix accounts

Monitor status is private to its writer by default. If a separately isolated
provider must read the observation, explicitly pass `--group-readable-status`
to every writer command (`once`, `loop` and `acknowledge`). This publishes only
`heartbeat.json`, `snapshot.json` and `hold.json` with mode `0640`, atomically,
including under a restrictive `0077` umask. Locks, the event journal and
interrupted-publication records remain `0600`. The flag does not alter healthy
status, latch clearing, freshness, canonical checks or provider admission.

Before opting in, create the state directory with mode `0750`, owned by the
observer and a dedicated service group. Run the observer with that primary
group and add only the intended provider as a reader. The provider must have
no group write permission on the directory or files. Directory traversal,
baseline and manifest read permissions must also be configured explicitly;
the flag does not change ownership, group membership or directory permissions.
Keep signing keys and wallet journals outside this group and monitor directory.
