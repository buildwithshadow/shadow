# Durable monitor runtime

This package embeds the existing mainnet observation and alert kernels in an isolated Durable Object. It is a migration foundation, not a completed production cutover. The recovery-only provider runtime still needs its active signer and prepared service composition. The read guard adapter and separate private alert sink are supplied here; they are not a completed production activation.

## Identity and collection

The operator supplies exact manifest and baseline bytes with independently approved SHA256 fingerprints, plus complete history matching the baseline's approved history digest. Initialization separately approves the normalized release binding and imported record inventory. Missing or mismatched inputs hold admission. These checks do not approve a new baseline or historical checkpoint.

The collector uses the existing snapshot implementation, including the schema 2 public execution audit, baseline warning and index thresholds, executor history scope, and complete approved history. Reads use the bounded readonly TLS WebSocket transport. Each generation has the baseline's wall time limit; sockets, request slots and timers are closed afterward. Usage diagnostics contain counts and timing, not endpoint credentials.

## Durable state and recovery

Heartbeat, snapshot, publication, hold, events and runner lock records use synchronous SQLite state so publication ordering matches the filesystem runner. The alarm reserves its next slot before collection and never catches up missed slots. An interrupted or stale generation cannot authorize payment. Schedule and notification suppression survive eviction. Alert delivery has an independent five second deadline. A stalled sink cannot retain the generation lock or stop future scans, and failed delivery is not marked sent. A timed out remote send may still complete at the destination; this is not an exactly once notification guarantee.

`MonitorRead` exposes only status and admission records. `MonitorAdmin` is an operator service binding, never a public HTTP proxy. It supports initialization, scheduling, usage, stopped exports, hold acknowledgement and interrupted lock recovery. The default HTTP handler always returns 404. No provider signer or transaction capability belongs in this Worker.

Interrupted lock recovery requires a stopped, drained monitor, the exact retained lock fingerprint and an elapsed run timeout. It atomically preserves the interrupted lock as operator evidence, latches an incident and releases the lock. It does not clear an existing hold or create a healthy heartbeat. Resume requires a complete new scan, followed by explicit acknowledgement of the matching incident. Corrupt records require investigation rather than automatic replacement. Stopped operator exports include a separately fingerprinted notification packet. Initialization can import that packet only for the same locally approved release, baseline and destination, preserving suppression. The provider read surface never returns notification metadata. A changed policy binding requires deliberate review rather than silently adopting the old notification state.

## Configuration and validation

The checked in configuration has no approved identity, read credential, alert destination, alert service or public route. It cannot become healthy without explicit operator setup. `RPC_WSS_URL` must be supplied as a secret binding. `wrangler.alerts.jsonc` defines that separate private `AlertSink` entrypoint. Only that script receives `ALERT_BOT_TOKEN` and its fixed `ALERT_DESTINATION_ID`. The monitor receives the destination identifier and private service binding, never the token. It accepts bounded monitor text, preserves the existing Telegram acknowledgement checks and bounds response size. Absence or failure leaves delivery unsent. Notification delivery is independent of healthy admission.

Run `npm ci`, install the existing app dependencies with `pnpm --dir ../../app install --frozen-lockfile --ignore-scripts`, then `npm run check`. Tests run in local workerd using synthetic observations. They cover durable scheduling, latching, notification suppression, stopped exports, exact input fingerprints, interrupted run recovery and separate administrative capabilities. They do not establish production readiness, alert delivery, domain compatibility or completion of provider composition.

## Provider admission adapter

`createWorkerProviderMonitorGuard` first validates locally approved immutable manifest, baseline and history bytes. It passes only the monitor read binding into `createProviderMonitorReadGuard`, which owns the returned bounded records and reruns the existing heartbeat and public policy evaluation locally. A remote `ok` boolean is necessary for schedule status but insufficient for admission. Both observed canonical block reads, runtime code hash verification and final generation equality checks are shared with the existing filesystem guard. Missing, duplicate, malformed, oversized, stale or substituted data remains held. This adapter does not install a signer or enable new acceptance in the recovery-only provider coordinator.
