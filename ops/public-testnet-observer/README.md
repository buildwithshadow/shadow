# Public testnet observer

This is an isolated, read-only scheduled observation of the public testnet
contract. It consumes no signing credentials and does not change wallet,
provider, executor or contract state. It is **not a spending guard**: participant
wallets submit directly and this observer cannot stop their transactions.

Each run verifies the release identity, scans complete canonical history and
reconciles accounting using the existing monitor. Reads are paced at one second;
the scan has a 20-minute subprocess deadline and bounded output. Missing history,
RPC failures and warnings yield unhealthy status. The previous healthy status is
invalidated before a scan, so a killed process cannot leave a fresh healthy flag.
These bounds support periodic diagnostics, not low-latency incident protection.

Install only a reviewed release at `/opt/shadow-observer/current`, with its pinned
app dependencies and manifests. The pre-existing `shadow-api` Unix account must
exist; the observer receives no API or provider environment file. Install these
two units, run `systemd-analyze verify`, then enable the timer. No public ports or
provider restart are required. Systemd prevents overlapping timer activations.
Do not run concurrent manual writers against the same state directory.

Operator checks:

```sh
systemctl status shadow-observer-testnet.timer shadow-observer-testnet.service
journalctl -u shadow-observer-testnet.service --since '1 hour ago'
sudo -u shadow-api node /opt/shadow-observer/current/app/scripts/public-testnet-observer.mjs \
  --manifest /opt/shadow-observer/current/contracts/deployments/public-testnet/arc-testnet.manifest.json \
  --state-dir /var/lib/shadow-observer --status
```

Always use `--status`, which verifies manifest binding and a one-hour heartbeat
age. Reading `status.json`'s `ok` alone cannot detect an expired heartbeat. An
unhealthy result remains until another complete scan succeeds. Journal entries
preserve prior failures; the latest snapshot is not proof of continuous uptime.

For a network-outage drill, run a separate one-shot instance with an unreachable
RPC and a **different state directory**. Confirm failure, then run the genuine
RPC against that drill directory and confirm recovery. Never change the provider
or disrupt the shared host network for this test. Retain the drill evidence.

Notifications currently consist of durable status, service failure and systemd
journal records. No email, Telegram, webhook or paging is configured. An attended
alert destination and a separately reviewed mainnet spending guard are required
before treating this as mainnet incident response. A healthy observer does not
prove owner/operator policy approval, independent security review or mainnet readiness.

Rollback: disable/stop only `shadow-observer-testnet.timer` and its service.
Retain `/var/lib/shadow-observer` and release files for investigation. Never
restore an older healthy status file to clear an incident.
