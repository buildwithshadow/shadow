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
