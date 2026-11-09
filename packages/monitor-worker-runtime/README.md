# Durable monitor runtime

This package embeds the existing mainnet observation and alert kernels in an isolated Durable Object. It is a migration foundation, not a completed production cutover. The provider runtime still needs an independently verified integration with this read surface, and deployment needs a separate private alert sink.

## Identity and collection

The operator supplies exact manifest and baseline bytes with independently approved SHA256 fingerprints, plus complete history matching the baseline's approved history digest. Initialization separately approves the normalized release binding and imported record inventory. Missing or mismatched inputs hold admission. These checks do not approve a new baseline or historical checkpoint.

The collector uses the existing snapshot implementation, including the schema 2 public execution audit, baseline warning and index thresholds, executor history scope, and complete approved history. Reads use the bounded readonly TLS WebSocket transport. Each generation has the baseline's wall time limit; sockets, request slots and timers are closed afterward. Usage diagnostics contain counts and timing, not endpoint credentials.

## Durable state and recovery

Heartbeat, snapshot, publication, hold, events and runner lock records use synchronous SQLite state so publication ordering matches the filesystem runner. The alarm reserves its next slot before collection and never catches up missed slots. An interrupted or stale generation cannot authorize payment. Schedule and notification suppression survive eviction. Failed alert delivery is not marked sent.

`MonitorRead` exposes only status and admission records. `MonitorAdmin` is an operator service binding, never a public HTTP proxy. It supports initialization, scheduling, usage, stopped exports, hold acknowledgement and interrupted lock recovery. The default HTTP handler always returns 404. No provider signer or transaction capability belongs in this Worker.

Interrupted lock recovery requires a stopped, drained monitor, the exact retained lock fingerprint and an elapsed run timeout. It atomically preserves the interrupted lock as operator evidence, latches an incident and releases the lock. It does not clear an existing hold or create a healthy heartbeat. Resume requires a complete new scan, followed by explicit acknowledgement of the matching incident. Corrupt records require investigation rather than automatic replacement. Export does not include private notification metadata; preserve that separately before a migration to avoid resetting suppression.

## Configuration and validation

The checked in configuration has no approved identity, read credential, alert destination, alert service or public route. It cannot become healthy without explicit operator setup. `RPC_WSS_URL` must be supplied as a secret binding. A separately configured private `ALERT_SINK` service provides `sendMonitorMessage`; absence or failure leaves delivery unsent. Notification delivery is independent of healthy admission.

Run `npm ci`, install the existing app dependencies with `pnpm --dir ../../app install --frozen-lockfile --ignore-scripts`, then `npm run check`. Tests run in local workerd using synthetic observations. They cover durable scheduling, latching, notification suppression, stopped exports, exact input fingerprints, interrupted run recovery and separate administrative capabilities. They do not establish production readiness, alert delivery, domain compatibility or completion of provider composition.
