# Guarded Arc testnet monitor notifications

The dedicated notifier reads the guarded observer's saved heartbeat, snapshot and
incident state. It sends failure and recovery notifications without signing,
moving tokens, changing pauses or acknowledging holds.

This entrypoint accepts only Arc testnet chain `5042002` and the deployment pinned
in `app/guardedTestnetDeployment.mjs`. The manifest and approved baseline must
agree on the contract, runtime hash, USDC address and deployment block. The
mainnet entrypoint continues to reject testnet state.

```sh
node app/scripts/guarded-testnet-monitor-alerts.mjs \
  --manifest /etc/shadow-observer-guarded-testnet/manifest.json \
  --baseline /etc/shadow-observer-guarded-testnet/phase-03-paused.baseline.json \
  --observer-dir /var/lib/shadow-observer-guarded-testnet/phase-00-paused \
  --state-dir /var/lib/shadow-alerts-guarded-testnet \
  --config /etc/shadow-alerts-guarded-testnet/telegram.json
```

Use a dedicated notification account and state directory. Give that account read
access to the observer state and only the intended Telegram configuration. Keep
the observer's state writable only by the observer account. Notification state
must be separate from observer state and from mainnet notification state.
Credentials remain in the local protected configuration file, never in source.

Node with `process.execve` support and Python 3 are required for the existing
descriptor lock. A stopped or killed notifier releases that lock through process
exit; operators must inspect legacy lock files rather than remove them blindly.

Normal bounded scans are quiet. A held incident remains a failure until the
observer's supported acknowledgement completes against a fresh healthy sample.
Repeated unchanged failures have a six hour reminder interval. A changed failure
or incident can notify immediately. Failed Telegram delivery does not advance the
delivery record, so it can be retried.

Before scheduling notifications, verify the observer's full fresh scan, file
ownership, service account and approved baseline. Exercise failure, duplicate
suppression and recovery without weakening the observer's hold requirements.
Notification delivery itself never authorizes a purchase.
